// dshnt ProjFS provider: named-pipe control protocol (JSON lines).
//
// Request : {"id":1,"op":"start","domain":"d1","workspace":"C:\\ws","view":"C:\\view"}
// Response: {"id":1,"ok":true,"pid":1234}
// Ops     : ping | start | stop | stats | list | invalidate | protect | shutdown
//
// "protect": {"value":true} tells the provider that the driver is loaded and
// denying lower-layer writes; only then may the metadata cache skip invalidating
// on view mutations. Absent the driver the provider stays conservative.

using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Text.Json;
using System.Threading;

namespace Dshnt.Provider
{
    internal sealed class ControlRequest
    {
        public int id { get; set; }
        public string op { get; set; }
        public string domain { get; set; }
        public string workspace { get; set; }
        public string view { get; set; }
        public string path { get; set; }
        public bool value { get; set; }
    }

    internal sealed class ControlServer : IDisposable
    {
        private readonly string _pipeName;
        private readonly ViewHost _host;
        private readonly Action<string> _log;
        private readonly CancellationTokenSource _cts = new CancellationTokenSource();
        private Thread _thread;
        private volatile bool _shutdownRequested;

        public ControlServer(string pipeName, ViewHost host, Action<string> log)
        {
            _pipeName = pipeName;
            _host = host;
            _log = log ?? (_ => { });
        }

        public bool ShutdownRequested => _shutdownRequested;

        public void Start()
        {
            _thread = new Thread(Loop) { IsBackground = true, Name = "dshnt-provider-ctrl" };
            _thread.Start();
        }

        private void Loop()
        {
            while (!_cts.IsCancellationRequested)
            {
                try
                {
                    using (var server = new NamedPipeServerStream(
                        _pipeName,
                        PipeDirection.InOut,
                        1,
                        PipeTransmissionMode.Byte,
                        PipeOptions.None))
                    {
                        server.WaitForConnection();
                        _log("control connected");
                        using (var reader = new StreamReader(server, System.Text.Encoding.UTF8, false, 4096, leaveOpen: true))
                        {
                            var writer = new StreamWriter(server, new System.Text.UTF8Encoding(false), 4096, leaveOpen: true);
                            try
                            {
                                writer.AutoFlush = true;
                                string line;
                                while ((line = reader.ReadLine()) != null)
                                {
                                    _log("control request: " + line);
                                    string response = Handle(line);
                                    _log("control reply: " + response);
                                    writer.WriteLine(response);
                                    if (_shutdownRequested) break;
                                }
                            }
                            catch (IOException)
                            {
                                // 客户端在我们写完之前断开（例如 PowerShell 只发一条请求）：
                                // 不是错误，等下一个连接即可。
                            }
                            finally
                            {
                                try { writer.Dispose(); } catch (IOException) { }
                            }
                        }
                    }
                }
                catch (Exception ex)
                {
                    if (!_cts.IsCancellationRequested)
                    {
                        _log("control loop: " + ex.GetType().FullName + ": " + ex.Message +
                             " | " + ex.StackTrace);
                    }
                    Thread.Sleep(50);
                }
            }
        }

        private string Handle(string line)
        {
            ControlRequest req;
            try
            {
                req = JsonSerializer.Deserialize<ControlRequest>(line, new JsonSerializerOptions
                {
                    PropertyNameCaseInsensitive = true,
                });
            }
            catch (Exception ex)
            {
                return JsonSerializer.Serialize(new { id = 0, ok = false, error = "bad json: " + ex.Message });
            }

            if (req == null) return JsonSerializer.Serialize(new { id = 0, ok = false, error = "empty request" });

            try
            {
                switch ((req.op ?? string.Empty).ToLowerInvariant())
                {
                    case "ping":
                        return JsonSerializer.Serialize(new
                        {
                            id = req.id,
                            ok = true,
                            pid = Environment.ProcessId,
                            pipe = _pipeName,
                            lowerProtected = DriverGate.LowerIsProtected,
                        });

                    case "protect":
                        DriverGate.LowerIsProtected = req.value;
                        return JsonSerializer.Serialize(new { id = req.id, ok = true, lowerProtected = DriverGate.LowerIsProtected });

                    case "start":
                        _host.Start(req.domain, req.workspace, req.view);
                        return JsonSerializer.Serialize(new { id = req.id, ok = true, pid = Environment.ProcessId });

                    case "stop":
                        return JsonSerializer.Serialize(new
                        {
                            id = req.id,
                            ok = true,
                            stopped = _host.Stop(req.domain),
                        });

                    case "stats":
                        return JsonSerializer.Serialize(new { id = req.id, ok = true, stats = _host.Stats(req.domain) });

                    case "list":
                        return JsonSerializer.Serialize(new { id = req.id, ok = true, domains = _host.List() });

                    case "invalidate":
                        _host.Invalidate(req.domain, req.path);
                        return JsonSerializer.Serialize(new { id = req.id, ok = true });

                    case "shutdown":
                        _shutdownRequested = true;
                        return JsonSerializer.Serialize(new { id = req.id, ok = true, shutdown = true });

                    default:
                        return JsonSerializer.Serialize(new { id = req.id, ok = false, error = "unknown op: " + req.op });
                }
            }
            catch (Exception ex)
            {
                _log($"op={req.op} failed: {ex.GetType().Name}: {ex.Message}");
                return JsonSerializer.Serialize(new { id = req.id, ok = false, error = ex.GetType().Name + ": " + ex.Message });
            }
        }

        public void Dispose()
        {
            _cts.Cancel();
            try { _thread?.Join(1000); } catch { }
        }
    }
}
