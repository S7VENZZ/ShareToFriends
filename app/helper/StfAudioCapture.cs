// ShareToFriends audio helper (Windows 10 2004+ / Windows 11).
//
//   StfAudioCapture.exe --list
//       Prints a JSON array of processes that currently own an audio session on the default
//       playback device: [{"pid":1234,"name":"Spotify","title":"...","active":true,"peak":0.12}, ...]
//
//   StfAudioCapture.exe --capture <pid>
//       Captures the audio rendered by that process (and its child processes) via the Windows
//       "process loopback" API and writes raw PCM to stdout: 48 kHz, 2 channels, signed 16-bit LE.
//       Ends when stdin is closed (parent exited) or on error.
//
// Built with the C# compiler that ships with Windows (.NET Framework 4.x, C# 5): see build-helper.cmd.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Stf
{
    // ---------------------------------------------------------------- COM interop

    [ComImport, Guid("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAgileObject { }

    [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IActivateAudioInterfaceAsyncOperation
    {
        [PreserveSig]
        int GetActivateResult(out int activateResult, [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
    }

    [ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IActivateAudioInterfaceCompletionHandler
    {
        void ActivateCompleted(IActivateAudioInterfaceAsyncOperation activateOperation);
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioClient
    {
        [PreserveSig] int Initialize(int shareMode, uint streamFlags, long hnsBufferDuration, long hnsPeriodicity, IntPtr pFormat, IntPtr audioSessionGuid);
        [PreserveSig] int GetBufferSize(out uint bufferFrames);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint padding);
        [PreserveSig] int IsFormatSupported(int shareMode, IntPtr pFormat, out IntPtr closestMatch);
        [PreserveSig] int GetMixFormat(out IntPtr format);
        [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr eventHandle);
        [PreserveSig] int GetService(ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
        [PreserveSig] int ReleaseBuffer(uint frames);
        [PreserveSig] int GetNextPacketSize(out uint frames);
    }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    }

    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceCollection
    {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int Item(uint index, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    }

    [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionManager2
    {
        [PreserveSig] int GetAudioSessionControl(IntPtr groupingId, int flags, out IntPtr control);
        [PreserveSig] int GetSimpleAudioVolume(IntPtr groupingId, int flags, out IntPtr volume);
        [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator enumerator);
    }

    [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionEnumerator
    {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int GetSession(int index, out IAudioSessionControl2 session);
    }

    [ComImport, Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionControl2
    {
        [PreserveSig] int GetState(out int state);
        [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, ref Guid context);
        [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
        [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid context);
        [PreserveSig] int GetGroupingParam(out Guid grouping);
        [PreserveSig] int SetGroupingParam(ref Guid grouping, ref Guid context);
        [PreserveSig] int RegisterAudioSessionNotification(IntPtr events);
        [PreserveSig] int UnregisterAudioSessionNotification(IntPtr events);
        [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetProcessId(out uint processId);
        [PreserveSig] int IsSystemSoundsSession();
        [PreserveSig] int SetDuckingPreference([MarshalAs(UnmanagedType.Bool)] bool optOut);
    }

    [ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioMeterInformation
    {
        [PreserveSig] int GetPeakValue(out float peak);
    }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumeratorClass { }

    // Free-threaded completion handler for ActivateAudioInterfaceAsync.
    [ComVisible(true)]
    class ActivationHandler : IActivateAudioInterfaceCompletionHandler, IAgileObject
    {
        public readonly ManualResetEvent Done = new ManualResetEvent(false);
        public int Result = unchecked((int)0x80004005);
        public object Interface;

        public void ActivateCompleted(IActivateAudioInterfaceAsyncOperation activateOperation)
        {
            int hr;
            object iface;
            activateOperation.GetActivateResult(out hr, out iface);
            Result = hr;
            Interface = iface;
            Done.Set();
        }
    }

    static class Native
    {
        [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = false)]
        public static extern void ActivateAudioInterfaceAsync(
            [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
            [MarshalAs(UnmanagedType.LPStruct)] Guid riid,
            IntPtr activationParams,
            IActivateAudioInterfaceCompletionHandler completionHandler,
            out IActivateAudioInterfaceAsyncOperation activationOperation);
    }

    // ---------------------------------------------------------------- program

    static class Program
    {
        const int E_FAIL = unchecked((int)0x80004005);

        [MTAThread]
        static int Main(string[] args)
        {
            try
            {
                if (args.Length >= 1 && args[0] == "--list") return List();
                if (args.Length >= 2 && args[0] == "--capture")
                {
                    uint pid;
                    if (!uint.TryParse(args[1], out pid) || pid == 0) return Fail("invalid pid");
                    return Capture(pid, args.Length >= 3 ? Convert.ToUInt32(args[2], 16) : 0x00060000u);
                }
                return Fail("usage: StfAudioCapture --list | --capture <pid>");
            }
            catch (Exception ex)
            {
                return Fail(ex.GetType().Name + ": " + ex.Message);
            }
        }

        static int Fail(string message)
        {
            Console.Error.WriteLine("ERR: " + message);
            return 1;
        }

        // ---- --list

        static string Json(string s)
        {
            if (s == null) return "\"\"";
            StringBuilder sb = new StringBuilder("\"");
            foreach (char c in s)
            {
                if (c == '"') sb.Append("\\\"");
                else if (c == '\\') sb.Append("\\\\");
                else if (c < 0x20) sb.Append("\\u" + ((int)c).ToString("x4"));
                else sb.Append(c);
            }
            return sb.Append('"').ToString();
        }

        class Entry
        {
            public uint Pid;
            public string Name;
            public string Title;
            public bool Active;
            public float Peak;
        }

        // Collects the audio sessions of one playback device into byPid (one entry per process).
        static void CollectSessions(IMMDevice device, Dictionary<uint, Entry> byPid, int self)
        {
            Guid iidManager = typeof(IAudioSessionManager2).GUID;
            object managerObj;
            if (device.Activate(ref iidManager, 23, IntPtr.Zero, out managerObj) != 0) return;
            IAudioSessionManager2 manager = (IAudioSessionManager2)managerObj;

            IAudioSessionEnumerator sessions;
            if (manager.GetSessionEnumerator(out sessions) != 0) return;
            int count;
            sessions.GetCount(out count);

            for (int i = 0; i < count; i++)
            {
                IAudioSessionControl2 control;
                if (sessions.GetSession(i, out control) != 0 || control == null) continue;
                if (control.IsSystemSoundsSession() == 0) continue; // S_OK means "this is the system sounds session"
                uint pid;
                if (control.GetProcessId(out pid) != 0 || pid == 0 || pid == (uint)self) continue;

                int state;
                control.GetState(out state); // 0 inactive, 1 active, 2 expired
                if (state == 2) continue;
                float peak = 0;
                IAudioMeterInformation meter = control as IAudioMeterInformation;
                if (meter != null) meter.GetPeakValue(out peak);

                Entry e;
                if (!byPid.TryGetValue(pid, out e))
                {
                    e = new Entry();
                    e.Pid = pid;
                    e.Name = "";
                    e.Title = "";
                    try
                    {
                        Process p = Process.GetProcessById((int)pid);
                        e.Name = p.ProcessName;
                        e.Title = p.MainWindowTitle;
                    }
                    catch (Exception) { }
                    byPid[pid] = e;
                }
                if (state == 1) e.Active = true;
                if (peak > e.Peak) e.Peak = peak;
            }
        }

        // Lists every process with an audio session on ANY active playback device
        // (an app may play on a headset, GoXLR, virtual mixer ... instead of the Windows default device).
        static int List()
        {
            IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorClass();
            Dictionary<uint, Entry> byPid = new Dictionary<uint, Entry>();
            int self = Process.GetCurrentProcess().Id;

            IMMDeviceCollection devices;
            if (enumerator.EnumAudioEndpoints(0, 1, out devices) == 0 && devices != null)
            {
                uint n;
                devices.GetCount(out n);
                for (uint d = 0; d < n; d++)
                {
                    IMMDevice dev;
                    if (devices.Item(d, out dev) != 0 || dev == null) continue;
                    try { CollectSessions(dev, byPid, self); } catch (Exception) { }
                }
            }
            if (byPid.Count == 0)
            {
                IMMDevice device;
                if (enumerator.GetDefaultAudioEndpoint(0, 1, out device) != 0) return Fail("no default playback device");
                CollectSessions(device, byPid, self);
            }

            StringBuilder sb = new StringBuilder("[");
            bool first = true;
            foreach (Entry e in byPid.Values)
            {
                if (!first) sb.Append(',');
                first = false;
                sb.Append("{\"pid\":").Append(e.Pid)
                  .Append(",\"name\":").Append(Json(e.Name))
                  .Append(",\"title\":").Append(Json(e.Title))
                  .Append(",\"active\":").Append(e.Active ? "true" : "false")
                  .Append(",\"peak\":").Append(e.Peak.ToString("0.####", System.Globalization.CultureInfo.InvariantCulture))
                  .Append('}');
            }
            sb.Append(']');
            Console.Out.WriteLine(sb.ToString());
            return 0;
        }

        // ---- --capture

        static int Capture(uint pid, uint streamFlags)
        {
            // AUDIOCLIENT_ACTIVATION_PARAMS { type = PROCESS_LOOPBACK(1), pid, mode = INCLUDE_TARGET_PROCESS_TREE(0) }
            IntPtr activation = Marshal.AllocHGlobal(12);
            Marshal.WriteInt32(activation, 0, 1);
            Marshal.WriteInt32(activation, 4, (int)pid);
            Marshal.WriteInt32(activation, 8, 0);

            // PROPVARIANT { vt = VT_BLOB (0x41), cbSize, pBlobData } – x64 layout, 24 bytes
            IntPtr propVariant = Marshal.AllocHGlobal(24);
            for (int i = 0; i < 24; i += 8) Marshal.WriteInt64(propVariant, i, 0);
            Marshal.WriteInt16(propVariant, 0, 0x41);
            Marshal.WriteInt32(propVariant, 8, 12);
            Marshal.WriteIntPtr(propVariant, 16, activation);

            ActivationHandler handler = new ActivationHandler();
            IActivateAudioInterfaceAsyncOperation op;
            Native.ActivateAudioInterfaceAsync("VAD\\Process_Loopback", typeof(IAudioClient).GUID, propVariant, handler, out op);
            if (!handler.Done.WaitOne(8000)) return Fail("activation timed out");
            if (handler.Result != 0) return Fail("activation failed: 0x" + handler.Result.ToString("x8"));
            IAudioClient client = (IAudioClient)handler.Interface;

            // WAVEFORMATEX: PCM, 2 ch, 48000 Hz, 16 bit
            IntPtr fmt = Marshal.AllocHGlobal(18);
            Marshal.WriteInt16(fmt, 0, 1);
            Marshal.WriteInt16(fmt, 2, 2);
            Marshal.WriteInt32(fmt, 4, 48000);
            Marshal.WriteInt32(fmt, 8, 48000 * 4);
            Marshal.WriteInt16(fmt, 12, 4);
            Marshal.WriteInt16(fmt, 14, 16);
            Marshal.WriteInt16(fmt, 16, 0);
            int hr = client.Initialize(0, streamFlags, 200000, 0, fmt, IntPtr.Zero);
            if (hr != 0) return Fail("initialize failed: 0x" + hr.ToString("x8"));

            AutoResetEvent audioEvent = new AutoResetEvent(false);
            hr = client.SetEventHandle(audioEvent.SafeWaitHandle.DangerousGetHandle());
            if (hr != 0) return Fail("set event failed: 0x" + hr.ToString("x8"));

            Guid iidCapture = typeof(IAudioCaptureClient).GUID;
            object captureObj;
            hr = client.GetService(ref iidCapture, out captureObj);
            if (hr != 0) return Fail("capture service failed: 0x" + hr.ToString("x8"));
            IAudioCaptureClient capture = (IAudioCaptureClient)captureObj;

            // End when the parent closes our stdin.
            ManualResetEvent stop = new ManualResetEvent(false);
            Thread watcher = new Thread(delegate ()
            {
                try
                {
                    Stream stdin = Console.OpenStandardInput();
                    byte[] sink = new byte[64];
                    while (stdin.Read(sink, 0, sink.Length) > 0) { }
                }
                catch (Exception) { }
                stop.Set();
            });
            watcher.IsBackground = true;
            watcher.Start();

            hr = client.Start();
            if (hr != 0) return Fail("start failed: 0x" + hr.ToString("x8"));

            Stream stdout = Console.OpenStandardOutput();
            byte[] buffer = new byte[64 * 1024];
            try
            {
                while (!stop.WaitOne(0))
                {
                    audioEvent.WaitOne(40);
                    uint packet;
                    while (capture.GetNextPacketSize(out packet) == 0 && packet > 0)
                    {
                        IntPtr data;
                        uint frames, flags;
                        ulong devicePosition, qpcPosition;
                        if (capture.GetBuffer(out data, out frames, out flags, out devicePosition, out qpcPosition) != 0) break;
                        int bytes = (int)frames * 4;
                        if (bytes > buffer.Length) buffer = new byte[bytes];
                        if ((flags & 2) != 0) Array.Clear(buffer, 0, bytes); // AUDCLNT_BUFFERFLAGS_SILENT
                        else Marshal.Copy(data, buffer, 0, bytes);
                        capture.ReleaseBuffer(frames);
                        stdout.Write(buffer, 0, bytes);
                    }
                    stdout.Flush();
                }
            }
            catch (IOException) { } // parent closed the pipe
            finally
            {
                client.Stop();
            }
            return 0;
        }
    }
}
