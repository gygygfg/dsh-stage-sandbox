// dshnt ProjFS provider: entry point.
//
//   dshnt-provider.exe --pipe dshnt-provider-s1 [--log C:\path\provider.log]
//
// Prints one JSON line on stdout when the pipe is ready:
//   {"event":"ready","pid":1234,"pipe":"dshnt-provider-s1"}
//
// Exit codes: 0 = clean shutdown, 2 = bad arguments, 3 = startup failure.

using System;
using System.Globalization;
using System.IO;
using System.Threading;

namespace Dshnt.Provider
{
    internal static class Program
    {
        private static int Main(string[] args)
        {
            string pipe = "dshnt-provider";
            string logPath = null;

            for (int i = 0; i < args.Length; i++)
            {
                switch (args[i])
                {
                    case "--pipe":
                        if (++i >= args.Length) return Bad("--pipe needs a value");
                        pipe = args[i];
                        break;
                    case "--log":
                        if (++i >= args.Length) return Bad("--log needs a value");
                        logPath = args[i];
                        break;
                    case "--help":
                    case "-h":
                        Console.WriteLine("usage: dshnt-provider --pipe <name> [--log <file>]");
                        return 0;
                    default:
                        return Bad("unknown argument: " + args[i]);
                }
            }

            object logGate = new object();
            void Log(string message)
            {
                string line = DateTime.Now.ToString("HH:mm:ss.fff", CultureInfo.InvariantCulture) + " " + message;
                lock (logGate)
                {
                    Console.Error.WriteLine(line);
                    if (logPath != null)
                    {
                        try { File.AppendAllText(logPath, line + Environment.NewLine); } catch { }
                    }
                }
            }

            try
            {
                using (var host = new ViewHost(Log))
                using (var server = new ControlServer(pipe, host, Log))
                {
                    server.Start();
                    Console.WriteLine("{\"event\":\"ready\",\"pid\":" + Environment.ProcessId +
                                      ",\"pipe\":\"" + pipe.Replace("\\", "\\\\") + "\"}");
                    Console.Out.Flush();

                    while (!server.ShutdownRequested)
                    {
                        Thread.Sleep(50);
                    }
                    Log("shutdown requested");
                    return 0;
                }
            }
            catch (Exception ex)
            {
                Log("fatal: " + ex);
                return 3;
            }
        }

        private static int Bad(string message)
        {
            Console.Error.WriteLine("dshnt-provider: " + message);
            return 2;
        }
    }
}
