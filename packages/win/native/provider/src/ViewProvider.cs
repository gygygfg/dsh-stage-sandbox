// dshnt ProjFS provider: one view = one virtualization instance.
//
// Responsibilities (and deliberately nothing else):
//   * present the lower layer (real workspace) as placeholders in the view;
//   * hydrate placeholder content on demand from the lower layer;
//   * let ProjFS do copy-up, tombstones, renames and directory merging.
//
// Writes never reach this class: ProjFS converts placeholders to full files in
// the view (copy-up) and writes there; the apply step is the only writer of the
// real workspace and it bypasses the view entirely.

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading;
using Microsoft.Windows.ProjFS;

namespace Dshnt.Provider
{
    internal sealed class EnumerationState
    {
        public IReadOnlyList<Entry> Entries;
        public int Position;
        public string Filter;
        public long StartedAtTicks;
    }

    internal sealed class ViewCounters
    {
        public long EnumStarts;
        public long EnumEntries;
        public long PlaceholderInfo;
        public long PlaceholderMiss;
        public long HydrateCalls;
        public long HydrateBytes;
        public long DirIndexBuilds;
        public long DirIndexHits;
        public long Notifications;
        public long Errors;

        public object ToJson()
        {
            return new
            {
                enumStarts = Interlocked.Read(ref EnumStarts),
                enumEntries = Interlocked.Read(ref EnumEntries),
                placeholderInfo = Interlocked.Read(ref PlaceholderInfo),
                placeholderMiss = Interlocked.Read(ref PlaceholderMiss),
                hydrateCalls = Interlocked.Read(ref HydrateCalls),
                hydrateBytes = Interlocked.Read(ref HydrateBytes),
                dirIndexBuilds = Interlocked.Read(ref DirIndexBuilds),
                dirIndexHits = Interlocked.Read(ref DirIndexHits),
                notifications = Interlocked.Read(ref Notifications),
                errors = Interlocked.Read(ref Errors),
            };
        }
    }

    public sealed class ViewProvider : IRequiredCallbacks, IDisposable
    {
        private readonly string _workspaceRoot;   // lower layer (real workspace)
        private readonly string _viewRoot;        // virtualization root (upper)
        private readonly string _domainId;
        private readonly Action<string> _log;

        private readonly ConcurrentDictionary<Guid, EnumerationState> _enumerations =
            new ConcurrentDictionary<Guid, EnumerationState>();

        // relDir ("" for root, lower-case, backslashes) -> cached index
        private readonly ConcurrentDictionary<string, DirIndex> _dirCache =
            new ConcurrentDictionary<string, DirIndex>(StringComparer.OrdinalIgnoreCase);

        private VirtualizationInstance _instance;
        private ViewCounters _counters = new ViewCounters();

        private const uint HydrateChunk = 64 * 1024;

        public ViewProvider(string domainId, string workspaceRoot, string viewRoot, Action<string> log)
        {
            _domainId = domainId;
            _workspaceRoot = Path.GetFullPath(workspaceRoot);
            _viewRoot = Path.GetFullPath(viewRoot);
            _log = log ?? (_ => { });
        }

        public string DomainId => _domainId;
        public string ViewRoot => _viewRoot;
        internal ViewCounters Counters => _counters;

        public HResult Start()
        {
            var notifications = new List<NotificationMapping>
            {
                new NotificationMapping(
                    NotificationType.FileOpened
                    | NotificationType.NewFileCreated
                    | NotificationType.FileOverwritten
                    | NotificationType.PreDelete
                    | NotificationType.PreRename
                    | NotificationType.FileRenamed
                    | NotificationType.FileHandleClosedNoModification
                    | NotificationType.FileHandleClosedFileModified
                    | NotificationType.FileHandleClosedFileDeleted
                    | NotificationType.FilePreConvertToFull,
                    string.Empty),
            };

            _instance = new VirtualizationInstance(
                _viewRoot,
                poolThreadCount: 0,
                concurrentThreadCount: 0,
                enableNegativePathCache: false,
                notificationMappings: notifications);

            WireNotifications();
            HResult hr = _instance.StartVirtualizing(this);
            if (hr != HResult.Ok)
            {
                _log($"start-virtualizing failed domain={_domainId} hr=0x{unchecked((uint)hr):X8}");
                _instance.Dispose();
                _instance = null;
                return hr;
            }
            _log($"view started domain={_domainId} lower={_workspaceRoot} view={_viewRoot}");
            return HResult.Ok;
        }

        public void Dispose()
        {
            try { _instance?.StopVirtualizing(); } catch (Exception ex) { _log("stop-virtualizing: " + ex.Message); }
            try { _instance?.Dispose(); } catch { }
            _instance = null;
            _enumerations.Clear();
            _dirCache.Clear();
        }

        // ---------------------------------------------------------------- cache

        /// <summary>Drop the cached index of one directory (or everything when null).</summary>
        public void Invalidate(string relativeDir = null)
        {
            if (relativeDir == null) { _dirCache.Clear(); return; }
            _dirCache.TryRemove(NormalizeRel(relativeDir), out _);
        }

        private static string NormalizeRel(string rel)
        {
            if (string.IsNullOrEmpty(rel)) return string.Empty;
            return rel.Replace('/', '\\').Trim('\\');
        }

        private static (string dir, string name) SplitRel(string rel)
        {
            rel = NormalizeRel(rel);
            int i = rel.LastIndexOf('\\');
            if (i < 0) return (string.Empty, rel);
            return (rel.Substring(0, i), rel.Substring(i + 1));
        }

        private DirIndex GetIndex(string relDir)
        {
            relDir = NormalizeRel(relDir);
            if (_dirCache.TryGetValue(relDir, out DirIndex cached))
            {
                Interlocked.Increment(ref _counters.DirIndexHits);
                return cached;
            }

            string full = relDir.Length == 0 ? _workspaceRoot : Path.Combine(_workspaceRoot, relDir);
            DirIndex built = DirIndex.Build(full, out string error);
            if (error != null)
            {
                Interlocked.Increment(ref _counters.Errors);
                _log($"dir-index error path={relDir} {error}");
            }
            Interlocked.Increment(ref _counters.DirIndexBuilds);
            // Cache only successful builds; a transient error must not stick.
            if (error == null) _dirCache[relDir] = built;
            return built;
        }

        private bool TryResolve(string relPath, out Entry entry)
        {
            entry = null;
            string rel = NormalizeRel(relPath);
            if (rel.Length == 0)
            {
                var di = new DirectoryInfo(_workspaceRoot);
                if (!di.Exists) return false;
                entry = new Entry
                {
                    Name = string.Empty,
                    FullPath = _workspaceRoot,
                    IsDirectory = true,
                    Size = 0,
                    Attributes = di.Attributes,
                    CreationTimeUtc = di.CreationTimeUtc,
                    LastAccessTimeUtc = di.LastAccessTimeUtc,
                    LastWriteTimeUtc = di.LastWriteTimeUtc,
                    ChangeTimeUtc = di.LastWriteTimeUtc,
                };
                return true;
            }
            var (dir, name) = SplitRel(rel);
            return GetIndex(dir).TryGet(name, out entry);
        }

        // ----------------------------------------------------------- callbacks

        public HResult StartDirectoryEnumerationCallback(
            int commandId, Guid enumerationId, string relativePath, uint triggeringProcessId, string triggeringProcessImageFileName)
        {
            Interlocked.Increment(ref _counters.EnumStarts);
            DirIndex index = GetIndex(relativePath);
            var state = new EnumerationState
            {
                Entries = index.Sorted,
                Position = 0,
                Filter = "*",
                StartedAtTicks = Stopwatch.GetTimestamp(),
            };
            if (!_enumerations.TryAdd(enumerationId, state))
            {
                Interlocked.Increment(ref _counters.Errors);
                return HResult.InternalError;
            }
            return HResult.Ok;
        }

        public HResult EndDirectoryEnumerationCallback(Guid enumerationId)
        {
            return _enumerations.TryRemove(enumerationId, out _) ? HResult.Ok : HResult.InternalError;
        }

        public HResult GetDirectoryEnumerationCallback(
            int commandId, Guid enumerationId, string filterFileName, bool restartScan, IDirectoryEnumerationResults result)
        {
            if (!_enumerations.TryGetValue(enumerationId, out EnumerationState state))
            {
                Interlocked.Increment(ref _counters.Errors);
                return HResult.InternalError;
            }

            string filter = string.IsNullOrWhiteSpace(filterFileName) ? "*" : filterFileName;
            if (restartScan || !string.Equals(filter, state.Filter, StringComparison.Ordinal))
            {
                state.Filter = filter;
                state.Position = 0;
            }

            int added = 0;
            while (state.Position < state.Entries.Count)
            {
                Entry e = state.Entries[state.Position];
                if (!NameMatches(e.Name, state.Filter))
                {
                    state.Position++;
                    continue;
                }

                bool ok = result.Add(
                    fileName: e.Name,
                    fileSize: e.Size,
                    isDirectory: e.IsDirectory,
                    fileAttributes: e.Attributes,
                    creationTime: e.CreationTimeUtc,
                    lastAccessTime: e.LastAccessTimeUtc,
                    lastWriteTime: e.LastWriteTimeUtc,
                    changeTime: e.ChangeTimeUtc);

                if (!ok)
                {
                    if (added == 0) return HResult.InsufficientBuffer;
                    break;
                }

                state.Position++;
                added++;
                Interlocked.Increment(ref _counters.EnumEntries);
            }

            return HResult.Ok;
        }

        public HResult GetPlaceholderInfoCallback(
            int commandId, string relativePath, uint triggeringProcessId, string triggeringProcessImageFileName)
        {
            Interlocked.Increment(ref _counters.PlaceholderInfo);
            if (!TryResolve(relativePath, out Entry e))
            {
                Interlocked.Increment(ref _counters.PlaceholderMiss);
                return HResult.FileNotFound;
            }

            // Names in WritePlaceholderInfo are relative to the virtualization
            // root; the last component must be the on-disk name (ProjFS is
            // case-insensitive but keeps the layer's casing for new entries).
            var (dir, _) = SplitRel(relativePath);
            string name = dir.Length == 0 ? e.Name : Path.Combine(dir, e.Name);

            HResult hr = _instance.WritePlaceholderInfo(
                relativePath: name,
                creationTime: e.CreationTimeUtc,
                lastAccessTime: e.LastAccessTimeUtc,
                lastWriteTime: e.LastWriteTimeUtc,
                changeTime: e.ChangeTimeUtc,
                fileAttributes: e.Attributes,
                endOfFile: e.IsDirectory ? 0 : e.Size,
                isDirectory: e.IsDirectory,
                contentId: new byte[] { 0 },
                providerId: new byte[] { 1 });

            if (hr != HResult.Ok)
            {
                Interlocked.Increment(ref _counters.Errors);
                _log($"write-placeholder failed path={relativePath} hr=0x{unchecked((uint)hr):X8}");
            }
            return hr;
        }

        public HResult GetFileDataCallback(
            int commandId, string relativePath, ulong byteOffset, uint length, Guid dataStreamId,
            byte[] contentId, byte[] providerId, uint triggeringProcessId, string triggeringProcessImageFileName)
        {
            Interlocked.Increment(ref _counters.HydrateCalls);
            if (!TryResolve(relativePath, out Entry e) || e.IsDirectory)
            {
                Interlocked.Increment(ref _counters.Errors);
                return HResult.FileNotFound;
            }

            // Seek to the requested offset: the sample re-reads the whole file for
            // every range, which makes large files quadratic under random reads.
            ulong remaining = length;
            ulong offset = byteOffset;
            try
            {
                using (var fs = new FileStream(e.FullPath, FileMode.Open, FileAccess.Read,
                    FileShare.ReadWrite | FileShare.Delete, 64 * 1024, FileOptions.SequentialScan))
                {
                    fs.Seek((long)offset, SeekOrigin.Begin);
                    var buffer = new byte[HydrateChunk];
                    while (remaining > 0)
                    {
                        uint want = (uint)Math.Min(remaining, HydrateChunk);
                        using (IWriteBuffer wb = _instance.CreateWriteBuffer(offset, want, out ulong alignedOffset, out uint alignedLength))
                        {
                            int toRead = (int)Math.Min(alignedLength, want);
                            int read = fs.Read(buffer, 0, toRead);
                            if (read <= 0) return HResult.InternalError;

                            wb.Stream.Seek(0, SeekOrigin.Begin);
                            wb.Stream.Write(buffer, 0, read);

                            HResult wr = _instance.WriteFileData(dataStreamId, wb, alignedOffset, (uint)read);
                            if (wr != HResult.Ok)
                            {
                                Interlocked.Increment(ref _counters.Errors);
                                return wr;
                            }
                            offset += (ulong)read;
                            remaining -= (ulong)read;
                            Interlocked.Add(ref _counters.HydrateBytes, read);
                        }
                    }
                }
                return HResult.Ok;
            }
            catch (Exception ex)
            {
                Interlocked.Increment(ref _counters.Errors);
                _log($"hydrate failed path={relativePath} {ex.GetType().Name}: {ex.Message}");
                return HResult.FileNotFound;
            }
        }

        // -------------------------------------------------------- notifications

        private void WireNotifications()
        {
            _instance.OnNotifyFileOpened = (string path, bool isDir, uint pid, string image, out NotificationType mask) =>
            {
                Interlocked.Increment(ref _counters.Notifications);
                mask = NotificationType.UseExistingMask;
                return true;
            };
            _instance.OnNotifyNewFileCreated = (string path, bool isDir, uint pid, string image, out NotificationType mask) =>
            {
                NoteViewMutation(path);
                mask = NotificationType.UseExistingMask;
            };
            _instance.OnNotifyFileOverwritten = (string path, bool isDir, uint pid, string image, out NotificationType mask) =>
            {
                NoteViewMutation(path);
                mask = NotificationType.UseExistingMask;
            };
            _instance.OnNotifyPreDelete = (string path, bool isDir, uint pid, string image) =>
            {
                Interlocked.Increment(ref _counters.Notifications);
                return true;
            };
            _instance.OnNotifyPreRename = (string path, string dest, uint pid, string image) =>
            {
                Interlocked.Increment(ref _counters.Notifications);
                return true;
            };
            _instance.OnNotifyFileRenamed = (string path, string dest, bool isDir, uint pid, string image, out NotificationType mask) =>
            {
                NoteViewMutation(path);
                NoteViewMutation(dest);
                mask = NotificationType.UseExistingMask;
            };
            _instance.OnNotifyHardlinkCreated = (string path, string dest, uint pid, string image) =>
            {
                NoteViewMutation(path);
                NoteViewMutation(dest);
            };
            _instance.OnNotifyFileHandleClosedNoModification = (string path, bool isDir, uint pid, string image) =>
            {
                Interlocked.Increment(ref _counters.Notifications);
            };
            _instance.OnNotifyFileHandleClosedFileModifiedOrDeleted = (string path, bool isDir, bool modified, bool deleted, uint pid, string image) =>
            {
                NoteViewMutation(path);
            };
            _instance.OnNotifyFilePreConvertToFull = (string path, uint pid, string image) =>
            {
                Interlocked.Increment(ref _counters.Notifications);
                return true;
            };
        }

        /// <summary>
        /// The view changed. The lower layer is immutable during a domain's life,
        /// so the metadata cache stays valid; this only keeps counters honest and
        /// drops the parent index when the view is used without the driver (tests).
        /// </summary>
        private void NoteViewMutation(string relativePath)
        {
            Interlocked.Increment(ref _counters.Notifications);
            if (!DriverGate.LowerIsProtected)
            {
                var (dir, _) = SplitRel(relativePath);
                Invalidate(dir);
            }
        }

        // ------------------------------------------------------------ utilities

        /// <summary>DOS-style wildcard match for the filter ProjFS passes in.</summary>
        internal static bool NameMatches(string name, string pattern)
        {
            if (string.IsNullOrEmpty(pattern) || pattern == "*") return true;
            if (pattern.IndexOfAny(new[] { '*', '?' }) < 0)
                return string.Equals(name, pattern, StringComparison.OrdinalIgnoreCase);

            int n = 0, p = 0, star = -1, mark = 0;
            while (n < name.Length)
            {
                if (p < pattern.Length && (pattern[p] == '?' ||
                    char.ToUpperInvariant(pattern[p]) == char.ToUpperInvariant(name[n])))
                {
                    n++; p++;
                }
                else if (p < pattern.Length && pattern[p] == '*')
                {
                    star = p++;
                    mark = n;
                }
                else if (star >= 0)
                {
                    p = star + 1;
                    n = ++mark;
                }
                else
                {
                    return false;
                }
            }
            while (p < pattern.Length && pattern[p] == '*') p++;
            return p == pattern.Length;
        }
    }
}
