// dshnt ProjFS provider: domain registry + lifecycle.
//
// One process can host several domains (one view each). The control plane opens
// the named pipe, asks for a view, and gets back the provider PID; the launcher
// registers that PID as trusted with the driver so the provider can read the
// lower layer and write the view directly.

using System;
using System.Collections.Generic;
using System.Linq;

namespace Dshnt.Provider
{
    /// <summary>
    /// Set to true once the driver is loaded and enforcing lower-layer write
    /// denial. The metadata cache is only coherent under that invariant; without
    /// the driver the provider invalidates on every view mutation instead.
    /// </summary>
    internal static class DriverGate
    {
        public static volatile bool LowerIsProtected;
    }

    internal sealed class DomainView
    {
        public string DomainId;
        public string Workspace;
        public string View;
        public ViewProvider Provider;
    }

    public sealed class ViewHost : IDisposable
    {
        private readonly object _gate = new object();
        private readonly Dictionary<string, DomainView> _domains = new Dictionary<string, DomainView>(StringComparer.Ordinal);
        private readonly Action<string> _log;

        public ViewHost(Action<string> log)
        {
            _log = log ?? (_ => { });
        }

        public IReadOnlyList<object> List()
        {
            lock (_gate)
            {
                return _domains.Values.Select(d => (object)new
                {
                    domain = d.DomainId,
                    workspace = d.Workspace,
                    view = d.View,
                    stats = d.Provider.Counters.ToJson(),
                }).ToList();
            }
        }

        public void Start(string domainId, string workspace, string view)
        {
            if (string.IsNullOrWhiteSpace(domainId)) throw new ArgumentException("domain is required");
            if (string.IsNullOrWhiteSpace(workspace)) throw new ArgumentException("workspace is required");
            if (string.IsNullOrWhiteSpace(view)) throw new ArgumentException("view is required");

            workspace = System.IO.Path.GetFullPath(workspace);
            view = System.IO.Path.GetFullPath(view);

            if (!System.IO.Directory.Exists(workspace))
                throw new ArgumentException("workspace does not exist: " + workspace);
            if (string.Equals(workspace, view, StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException("workspace and view must not be the same path");
            if (view.StartsWith(workspace + "\\", StringComparison.OrdinalIgnoreCase) ||
                workspace.StartsWith(view + "\\", StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException("workspace and view must not overlap");

            lock (_gate)
            {
                if (_domains.TryGetValue(domainId, out DomainView existing))
                {
                    if (string.Equals(existing.Workspace, workspace, StringComparison.OrdinalIgnoreCase) &&
                        string.Equals(existing.View, view, StringComparison.OrdinalIgnoreCase))
                    {
                        return; // idempotent
                    }
                    throw new ArgumentException("domain already has a different view: " + domainId);
                }

                var provider = new ViewProvider(domainId, workspace, view, _log);
                var hr = provider.Start();
                if (hr != Microsoft.Windows.ProjFS.HResult.Ok)
                {
                    throw new InvalidOperationException(
                        $"StartVirtualizing failed for {domainId}: 0x{unchecked((uint)hr):X8}");
                }

                _domains[domainId] = new DomainView
                {
                    DomainId = domainId,
                    Workspace = workspace,
                    View = view,
                    Provider = provider,
                };
                _log($"domain registered {domainId}");
            }
        }

        public bool Stop(string domainId)
        {
            lock (_gate)
            {
                if (!_domains.TryGetValue(domainId, out DomainView dv)) return false;
                _domains.Remove(domainId);
                dv.Provider.Dispose();
                _log($"domain stopped {domainId}");
                return true;
            }
        }

        public object Stats(string domainId)
        {
            lock (_gate)
            {
                if (domainId != null)
                {
                    if (!_domains.TryGetValue(domainId, out DomainView dv)) return null;
                    return new { domain = dv.DomainId, stats = dv.Provider.Counters.ToJson() };
                }
                return new
                {
                    domains = _domains.Count,
                    providerPid = Environment.ProcessId,
                    lowerProtected = DriverGate.LowerIsProtected,
                    views = List(),
                };
            }
        }

        public void Invalidate(string domainId, string relativePath)
        {
            lock (_gate)
            {
                if (domainId != null && _domains.TryGetValue(domainId, out DomainView dv))
                {
                    dv.Provider.Invalidate(relativePath);
                    return;
                }
                foreach (DomainView d in _domains.Values) d.Provider.Invalidate(relativePath);
            }
        }

        public void Dispose()
        {
            lock (_gate)
            {
                foreach (DomainView dv in _domains.Values)
                {
                    try { dv.Provider.Dispose(); } catch { }
                }
                _domains.Clear();
            }
        }
    }
}
