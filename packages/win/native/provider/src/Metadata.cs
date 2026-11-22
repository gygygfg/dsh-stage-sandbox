// dshnt ProjFS provider: metadata model.
//
// The hot path is metadata: ProjFS asks for a placeholder's metadata once per
// file (first touch). The Microsoft sample re-enumerates the parent directory
// for every such request (O(n) per file => O(n^2) per directory), which is why
// an M0 measurement showed ~4 ms/file and a 20k-file directory never finished.
//
// This provider keeps a per-directory index of the *lower* layer. Building it is
// one FindFirstFile pass (cheap, same order as NTFS), and every later lookup is
// O(1). The index is only safe because the driver denies writes to the lower
// layer while a domain is active; that invariant is documented in
// docs/nt/THREAT-MODEL.md (invariant 1) and enforced by dshnt.sys.

using System;
using System.Collections.Generic;
using System.IO;

namespace Dshnt.Provider
{
    /// <summary>One entry of the lower layer, as ProjFS needs it.</summary>
    public sealed class Entry
    {
        public string Name;                 // name inside its parent directory
        public bool IsDirectory;
        public long Size;
        public FileAttributes Attributes;
        public DateTime CreationTimeUtc;
        public DateTime LastAccessTimeUtc;
        public DateTime LastWriteTimeUtc;
        public DateTime ChangeTimeUtc;
        public string FullPath;
    }

    /// <summary>
    /// ProjFS name ordering: case-insensitive ordinal, which matches NTFS
    /// collation closely enough that the shell lists names in the expected order.
    /// ProjFS requires entries sorted with this ordering within one enumeration.
    /// </summary>
    public sealed class ProjFsNameComparer : IComparer<string>
    {
        public static readonly ProjFsNameComparer Instance = new ProjFsNameComparer();

        public int Compare(string x, string y)
        {
            return string.Compare(x, y, StringComparison.OrdinalIgnoreCase);
        }
    }

    /// <summary>Case-insensitive name → entry map for one directory.</summary>
    internal sealed class DirIndex
    {
        private readonly Dictionary<string, Entry> byName;
        private readonly List<Entry> sorted;

        private DirIndex(Dictionary<string, Entry> byName, List<Entry> sorted)
        {
            this.byName = byName;
            this.sorted = sorted;
        }

        public IReadOnlyList<Entry> Sorted => sorted;
        public int Count => sorted.Count;

        public bool TryGet(string name, out Entry entry) => byName.TryGetValue(name, out entry);

        /// <summary>
        /// Build one index from a single directory enumeration. Symlinks and
        /// reparse points are reported as-is (ProjFS decides what to do next).
        /// </summary>
        public static DirIndex Build(string fullDir, out string error)
        {
            error = null;
            var map = new Dictionary<string, Entry>(StringComparer.OrdinalIgnoreCase);
            var list = new List<Entry>();
            try
            {
                var di = new DirectoryInfo(fullDir);
                if (!di.Exists)
                {
                    return new DirIndex(map, list);
                }

                foreach (FileSystemInfo fsi in di.EnumerateFileSystemInfos())
                {
                    var e = new Entry
                    {
                        Name = fsi.Name,
                        FullPath = fsi.FullName,
                        IsDirectory = (fsi.Attributes & FileAttributes.Directory) != 0,
                        Size = fsi is FileInfo fi ? fi.Length : 0,
                        Attributes = fsi.Attributes,
                        CreationTimeUtc = fsi.CreationTimeUtc,
                        LastAccessTimeUtc = fsi.LastAccessTimeUtc,
                        LastWriteTimeUtc = fsi.LastWriteTimeUtc,
                        ChangeTimeUtc = fsi.LastWriteTimeUtc,
                    };
                    // Last writer wins deterministically if the filesystem ever
                    // reports duplicates differing only by case.
                    map[e.Name] = e;
                    list.Add(e);
                }
            }
            catch (Exception ex)
            {
                error = ex.GetType().Name + ": " + ex.Message;
            }

            list.Sort((a, b) => ProjFsNameComparer.Instance.Compare(a.Name, b.Name));
            return new DirIndex(map, list);
        }
    }
}
