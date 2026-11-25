// Native helpers for scripts/release/run-hold.ps1 (from the app-update wave's spike 1 and 1b harness; lib.ps1
// adds this file with Add-Type). Read-only observation only, with two exceptions on the portable exe the
// harness itself placed in its scratch drive root: TryRename renames it and renames it back at once, and the
// start files' write-open probe opens it for append and writes nothing.
//  - process table (Toolhelp), image path, IsProcessInJob, kernel exit time, wait-for-exit
//  - a process's file handles (NtQueryInformationProcess ProcessHandleInformation + DuplicateHandle +
//    GetFinalPathNameByHandle on disk files only, each query in a worker thread with a timeout)
//  - Restart Manager: which processes use a file
//  - top-level window of a PID; timer resolution; a precise UTC clock
//  - RunCmd: a console program with captured output (the probe's cmd line)
//  - PollAfterClose: the 25 ms (configurable) poll of the events after WM_CLOSE
// C# 5 (the .NET Framework compiler that PowerShell 5.1's Add-Type uses). ASCII only.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class T11 {
  [DllImport("winmm.dll")] public static extern uint timeBeginPeriod(uint p);
  [DllImport("kernel32.dll")] static extern void GetSystemTimePreciseAsFileTime(out long ft);
  public static long UtcMsPrecise() { long ft; GetSystemTimePreciseAsFileTime(out ft); return (ft - 116444736000000000L) / 10000L; }
  public static double UtcMsPreciseF() { long ft; GetSystemTimePreciseAsFileTime(out ft); return (ft - 116444736000000000L) / 10000.0; }

  // ---------------- processes ----------------
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct PROCESSENTRY32W {
    public uint dwSize; public uint cntUsage; public uint th32ProcessID; public IntPtr th32DefaultHeapID; public uint th32ModuleID;
    public uint cntThreads; public uint th32ParentProcessID; public int pcPriClassBase; public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
  }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr h, ref PROCESSENTRY32W e);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr h, ref PROCESSENTRY32W e);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint a, bool inherit, int pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool QueryFullProcessImageNameW(IntPtr h, int flags, StringBuilder sb, ref int size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr h, IntPtr job, out bool r);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr h, out long create, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr h, out uint code);

  // "pid|ppid|name" for every process.
  public static List<string> ProcTable() {
    var r = new List<string>();
    IntPtr s = CreateToolhelp32Snapshot(2, 0);
    if (s == new IntPtr(-1)) return r;
    try {
      var e = new PROCESSENTRY32W(); e.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
      if (Process32FirstW(s, ref e)) { do { r.Add(e.th32ProcessID + "|" + e.th32ParentProcessID + "|" + e.szExeFile); } while (Process32NextW(s, ref e)); }
    } finally { CloseHandle(s); }
    return r;
  }
  // First child of ppid whose image name equals name (case-insensitive); 0 if none.
  public static int ChildOf(int ppid, string name) {
    foreach (var l in ProcTable()) { var p = l.Split('|'); if (int.Parse(p[1]) == ppid && string.Equals(p[2], name, StringComparison.OrdinalIgnoreCase)) return int.Parse(p[0]); }
    return 0;
  }
  // Every descendant of pid (one snapshot; PID reuse ignored).
  public static List<int> Descendants(int pid) {
    var tab = ProcTable(); var kids = new Dictionary<int, List<int>>();
    foreach (var l in tab) { var p = l.Split('|'); int c = int.Parse(p[0]), pp = int.Parse(p[1]); if (c == pp) continue; if (!kids.ContainsKey(pp)) kids[pp] = new List<int>(); kids[pp].Add(c); }
    var r = new List<int>(); var q = new Queue<int>(); q.Enqueue(pid);
    while (q.Count > 0) { int x = q.Dequeue(); if (!kids.ContainsKey(x)) continue; foreach (int c in kids[x]) { if (!r.Contains(c) && c != pid) { r.Add(c); q.Enqueue(c); } } }
    return r;
  }
  public static string ImagePath(int pid) {
    IntPtr h = OpenProcess(0x1000, false, pid); if (h == IntPtr.Zero) return "";
    try { var sb = new StringBuilder(1024); int n = 1024; return QueryFullProcessImageNameW(h, 0, sb, ref n) ? sb.ToString() : ""; } finally { CloseHandle(h); }
  }
  public static string InJob(int pid) {
    IntPtr h = OpenProcess(0x1000, false, pid); if (h == IntPtr.Zero) return "open-failed " + Marshal.GetLastWin32Error();
    bool r; bool ok = IsProcessInJob(h, IntPtr.Zero, out r); CloseHandle(h); return ok ? r.ToString() : "call-failed";
  }

  // A process handle kept open by the harness (SYNCHRONIZE | QUERY_LIMITED_INFORMATION), so the exit
  // moment, the kernel exit time and the exit code stay readable after the process is gone.
  public static IntPtr Hold(int pid) { return OpenProcess(0x00100000 | 0x1000, false, pid); }
  public static bool Exited(IntPtr h) { return h == IntPtr.Zero || WaitForSingleObject(h, 0) == 0; }
  // Kernel exit time as UTC epoch ms (double), NaN if still running.
  public static double ExitUtcMs(IntPtr h) {
    long c, e, k, u; if (h == IntPtr.Zero || !GetProcessTimes(h, out c, out e, out k, out u) || e == 0) return double.NaN;
    return (e - 116444736000000000L) / 10000.0;
  }
  public static double CreateUtcMs(IntPtr h) {
    long c, e, k, u; if (h == IntPtr.Zero || !GetProcessTimes(h, out c, out e, out k, out u)) return double.NaN;
    return (c - 116444736000000000L) / 10000.0;
  }
  public static long ExitCode(IntPtr h) { uint c; if (h == IntPtr.Zero || !GetExitCodeProcess(h, out c)) return -1; return c; }

  // ---------------- handles ----------------
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, IntPtr buf, int len, out int ret);
  [DllImport("ntdll.dll")] static extern int NtQueryObject(IntPtr h, int cls, IntPtr buf, int len, out int ret);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool DuplicateHandle(IntPtr sp, IntPtr sh, IntPtr dp, out IntPtr dh, uint access, bool inherit, uint opts);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint GetFileType(IntPtr h);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern uint GetFinalPathNameByHandleW(IntPtr h, StringBuilder sb, uint n, uint flags);

  struct HEntry { public long Value; public uint Access; public uint TypeIndex; }
  static List<HEntry> Snapshot(IntPtr hp) {
    var r = new List<HEntry>();
    int len = 1 << 16;
    for (int attempt = 0; attempt < 8; attempt++) {
      IntPtr buf = Marshal.AllocHGlobal(len);
      try {
        int ret; int st = NtQueryInformationProcess(hp, 51, buf, len, out ret);
        if (st == unchecked((int)0xC0000004)) { len = Math.Max(len * 2, ret + 4096); continue; }
        if (st != 0) return r;
        long n = Marshal.ReadInt64(buf);
        for (long i = 0; i < n; i++) {
          IntPtr e = new IntPtr(buf.ToInt64() + 16 + i * 40);
          var he = new HEntry(); he.Value = Marshal.ReadInt64(e); he.Access = (uint)Marshal.ReadInt32(e, 24); he.TypeIndex = (uint)Marshal.ReadInt32(e, 28);
          r.Add(he);
        }
        return r;
      } finally { Marshal.FreeHGlobal(buf); }
    }
    return r;
  }
  static string TypeName(IntPtr h) {
    int len = 1024; IntPtr buf = Marshal.AllocHGlobal(len);
    try {
      int ret; if (NtQueryObject(h, 2, buf, len, out ret) != 0) return "?";
      ushort l = (ushort)Marshal.ReadInt16(buf); IntPtr p = Marshal.ReadIntPtr(buf, 8);
      return Marshal.PtrToStringUni(p, l / 2);
    } finally { Marshal.FreeHGlobal(buf); }
  }
  // Path of a duplicated disk-file handle, in a worker thread with a timeout ("<timeout>" if it hangs).
  static string PathOf(IntPtr dup, int timeoutMs) {
    string result = null;
    var t = new Thread(() => {
      try {
        uint ft = GetFileType(dup);
        if (ft != 1) { result = "<type " + ft + ">"; return; }
        var sb = new StringBuilder(2048); uint n = GetFinalPathNameByHandleW(dup, sb, 2048, 0);
        result = n == 0 ? "<err " + Marshal.GetLastWin32Error() + ">" : sb.ToString();
      } catch (Exception ex) { result = "<ex " + ex.Message + ">"; }
    });
    t.IsBackground = true; t.Start();
    if (!t.Join(timeoutMs)) return "<timeout>";
    return result;
  }
  // Every File-type handle of pid as "0xVALUE|0xACCESS|path". Disk files get their path; others their file type.
  public static List<string> FileHandles(int pid, int timeoutMs) {
    var r = new List<string>();
    IntPtr hp = OpenProcess(0x0400 | 0x0040, false, pid);
    if (hp == IntPtr.Zero) { r.Add("open-failed " + Marshal.GetLastWin32Error()); return r; }
    try {
      foreach (var e in Snapshot(hp)) {
        IntPtr dup;
        if (!DuplicateHandle(hp, new IntPtr(e.Value), GetCurrentProcess(), out dup, 0, false, 2)) continue;
        try {
          if (TypeName(dup) != "File") continue;
          r.Add(string.Format("0x{0:X}|0x{1:X}|{2}", e.Value, e.Access, PathOf(dup, timeoutMs)));
        } finally { CloseHandle(dup); }
      }
    } finally { CloseHandle(hp); }
    return r;
  }
  // Is handle `value` of pid still a File handle whose path ends with `suffix` (case-insensitive)?
  // "open" / "closed" / "proc-gone".
  public static string HandleState(int pid, long value, string suffix) {
    IntPtr hp = OpenProcess(0x0400 | 0x0040, false, pid);
    if (hp == IntPtr.Zero) return "proc-gone";
    try {
      if (WaitForSingleObject(hp, 0) == 0) return "proc-gone";
      foreach (var e in Snapshot(hp)) {
        if (e.Value != value) continue;
        IntPtr dup;
        if (!DuplicateHandle(hp, new IntPtr(e.Value), GetCurrentProcess(), out dup, 0, false, 2)) return "closed";
        try { string p = PathOf(dup, 200); return p.EndsWith(suffix, StringComparison.OrdinalIgnoreCase) ? "open" : "closed"; } finally { CloseHandle(dup); }
      }
      return "closed";
    } finally { CloseHandle(hp); }
  }

  // ---------------- Restart Manager ----------------
  [StructLayout(LayoutKind.Sequential)] struct RM_UNIQUE_PROCESS { public int dwProcessId; public uint StartLow; public uint StartHigh; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
    public int ApplicationType; public uint AppStatus; public uint TSSessionId; [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmStartSession(out uint h, int flags, StringBuilder key);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint h);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint h, uint nFiles, string[] files, uint nApps, IntPtr apps, uint nSvc, string[] svcs);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint h, out uint needed, ref uint n, [In, Out] RM_PROCESS_INFO[] info, ref uint reasons);
  public static List<string> RmWho(string path) {
    var r = new List<string>(); uint h; var key = new StringBuilder(64);
    int st = RmStartSession(out h, 0, key); if (st != 0) { r.Add("RmStartSession " + st); return r; }
    try {
      st = RmRegisterResources(h, 1, new string[] { path }, 0, IntPtr.Zero, 0, null); if (st != 0) { r.Add("RmRegisterResources " + st); return r; }
      uint needed, n = 0, reasons = 0; st = RmGetList(h, out needed, ref n, null, ref reasons);
      if (st == 234 && needed > 0) {
        var info = new RM_PROCESS_INFO[needed]; n = needed; st = RmGetList(h, out needed, ref n, info, ref reasons);
        if (st == 0) for (int i = 0; i < n; i++) r.Add(info[i].Process.dwProcessId + "|" + info[i].strAppName + "|type" + info[i].ApplicationType);
        else r.Add("RmGetList " + st);
      } else if (st != 0) r.Add("RmGetList " + st);
      if (r.Count == 0) r.Add("none");
    } finally { RmEndSession(h); }
    return r;
  }

  // ---------------- files ----------------
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool MoveFileExW(string a, string b, uint flags);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFileW(string n, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr t);
  // 0 = renamed (and renamed back); else the Win32 error of the rename (32 = sharing violation).
  public static int TryRename(string path, string tmp) { double a, b; return TryRenameTimed(path, tmp, out a, out b); }
  // Same, with the duration of the rename and of the rename back (ms).
  public static int TryRenameTimed(string path, string tmp, out double msOut, out double msBack) {
    var s = Stopwatch.StartNew(); msBack = -1;
    if (!MoveFileExW(path, tmp, 0)) { msOut = s.Elapsed.TotalMilliseconds; return Marshal.GetLastWin32Error(); }
    msOut = s.Elapsed.TotalMilliseconds; s.Restart();
    if (!MoveFileExW(tmp, path, 0)) { int e = Marshal.GetLastWin32Error(); msBack = s.Elapsed.TotalMilliseconds; return -100000 - e; }
    msBack = s.Elapsed.TotalMilliseconds;
    return 0;
  }
  // The same rename, with the unpack dir checked right after the rename succeeded, before the rename back.
  public static int TryRenameCheck(string path, string tmp, string unpackDir, out double msOut, out double msBack, out bool unpackPresent) {
    var s = Stopwatch.StartNew(); msBack = -1; unpackPresent = false;
    if (!MoveFileExW(path, tmp, 0)) { msOut = s.Elapsed.TotalMilliseconds; return Marshal.GetLastWin32Error(); }
    msOut = s.Elapsed.TotalMilliseconds;
    unpackPresent = Directory.Exists(unpackDir);
    s.Restart();
    if (!MoveFileExW(tmp, path, 0)) { int e = Marshal.GetLastWin32Error(); msBack = s.Elapsed.TotalMilliseconds; return -100000 - e; }
    msBack = s.Elapsed.TotalMilliseconds;
    return 0;
  }
  // Error of an open for DELETE with full sharing (0 = it would allow a rename/delete).
  public static int TryOpenDelete(string path) {
    IntPtr h = CreateFileW(path, 0x00010000, 7, IntPtr.Zero, 3, 0, IntPtr.Zero);
    if (h == new IntPtr(-1)) return Marshal.GetLastWin32Error();
    CloseHandle(h); return 0;
  }

  // ---------------- windows ----------------
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static IntPtr FirstVisibleTopWindow(int pid, string cls) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == (uint)pid && IsWindowVisible(h)) { var c = new StringBuilder(256); GetClassName(h, c, 256); if (cls == null || c.ToString() == cls) { found = h; return false; } }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  // ---------------- console programs ----------------
  // Spawn file + raw argument string (no shell), no window, ELECTRON_RUN_AS_NODE and HILBERTRAUM_DRIVE_ROOT
  // removed; returns stdout (+ stderr in brackets), the exit code and the wall time.
  public static string RunCmd(string file, string args, out int exitCode, out double ms) {
    var psi = new ProcessStartInfo(file, args);
    psi.UseShellExecute = false; psi.RedirectStandardOutput = true; psi.RedirectStandardError = true; psi.CreateNoWindow = true;
    psi.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE"); psi.EnvironmentVariables.Remove("HILBERTRAUM_DRIVE_ROOT");
    var s = Stopwatch.StartNew();
    using (var p = Process.Start(psi)) {
      var errTask = p.StandardError.ReadToEndAsync();
      string o = p.StandardOutput.ReadToEnd();
      p.WaitForExit();
      string e = errTask.Result;
      exitCode = p.ExitCode; ms = s.Elapsed.TotalMilliseconds;
      string r = o.Replace("\r", "").Replace("\n", " ").Trim();
      if (e.Trim().Length > 0) r += " [stderr " + e.Replace("\r", "").Replace("\n", " ").Trim() + "]";
      return r;
    }
  }

  // ---------------- the start files' write-open probe ----------------
  // The cmd line a start file runs to learn whether its drive's app is running or starting (docs/app-updates.md
  // 5.6): an append-open of the root exe that writes nothing, read with || on the same line, inside the
  // `if exist` guard (without it `>>` would create a 0-byte exe). The path must hold no " % ^ ! (run-hold.ps1
  // refuses such a root).
  public static string ProbeArgs(string exePath) {
    return "/d /c \"if exist \"" + exePath + "\" (2>nul (>>\"" + exePath + "\" (call )) && (echo PROBE=FREE) || (echo PROBE=HELD)) else (echo PROBE=ABSENT)\"";
  }
  // "free" (no instance holds the exe), "held", "absent" (no file), or "error ..." with what cmd printed.
  public static string Probe(string exePath, out double ms) {
    int code; string o;
    try { o = RunCmd(Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe", ProbeArgs(exePath), out code, out ms); }
    catch (Exception ex) { ms = -1; return "error " + ex.Message; }
    if (o.Contains("PROBE=FREE")) return "free";
    if (o.Contains("PROBE=HELD")) return "held";
    if (o.Contains("PROBE=ABSENT")) return "absent";
    return "error exit " + code + " " + o;
  }

  // ---------------- the poll after WM_CLOSE ----------------
  // sw: the harness's Stopwatch (the close was issued at tCloseMs on it). Records, on sw, the first poll at
  // which each event is seen; checks run in this order inside one poll: app exited, app tree exited, unpack
  // dir gone, plugins dir gone, stub's exe handle closed, the write-open probe read free, rename of exePath
  // succeeded, stub exited. The unpack dir is re-checked right after the first free probe (unpack_at_probe) and
  // right after the first successful rename, before the rename back (unpack_at_rename): two events 1 to 2 ms
  // apart cannot be ordered by the poll itself. The probe and the rename run one after the other in this
  // thread and the rename is undone before the next check, so the exe is at its path whenever the probe runs.
  // Ends when the stub has exited, the probe read free, the rename succeeded and the dirs are gone, or at
  // timeoutMs after the close.
  public static string PollAfterClose(Stopwatch sw, double tCloseMs, IntPtr hStub, int stubPid, IntPtr hApp, IntPtr[] hTree,
                                      string unpackDir, string pluginsDir, string exePath, long stubExeHandle, int intervalMs, int timeoutMs) {
    double tApp = -1, tTree = -1, tUnpack = -1, tPlugins = -1, tHandle = -1, tRename = -1, tStub = -1, renOut = -1, renBack = -1;
    double tProbe = -1, tProbeEnd = -1, probeMsMax = -1;
    int polls = 0, renameTries = 0, probeTries = 0, probeHeld = 0; var errs = new Dictionary<int, int>();
    string unpackAtProbe = "null", unpackAtRename = "null", probeOther = "";
    string tmp = exePath + ".t11ren";
    bool havePlugins = !string.IsNullOrEmpty(pluginsDir);
    var order = new List<string>();
    // every check takes its own timestamp (a rename on a write-through stick can block a poll for >100 ms)
    while (true) {
      polls++;
      if (tApp < 0 && Exited(hApp)) { tApp = sw.Elapsed.TotalMilliseconds; order.Add("app-exit@" + polls); }
      if (tTree < 0) { bool all = true; foreach (var h in hTree) if (!Exited(h)) { all = false; break; } if (all) { tTree = sw.Elapsed.TotalMilliseconds; order.Add("tree-exit@" + polls); } }
      if (tUnpack < 0 && !Directory.Exists(unpackDir)) { tUnpack = sw.Elapsed.TotalMilliseconds; order.Add("unpack-gone@" + polls); }
      if (havePlugins && tPlugins < 0 && !Directory.Exists(pluginsDir)) { tPlugins = sw.Elapsed.TotalMilliseconds; order.Add("plugins-gone@" + polls); }
      if (tHandle < 0 && stubExeHandle != 0) { double th = sw.Elapsed.TotalMilliseconds; string hs = HandleState(stubPid, stubExeHandle, Path.GetFileName(exePath)); if (hs != "open") { tHandle = th; order.Add("handle-" + hs + "@" + polls); } }
      if (tProbe < 0) {
        probeTries++; double ts = sw.Elapsed.TotalMilliseconds; double pms; string v = Probe(exePath, out pms);
        if (pms > probeMsMax) probeMsMax = pms;
        if (v == "free") {
          tProbe = ts; tProbeEnd = sw.Elapsed.TotalMilliseconds;
          unpackAtProbe = Directory.Exists(unpackDir) ? "present" : "absent";
          order.Add("probe-free@" + polls);
        } else if (v == "held") probeHeld++;
        else if (probeOther.Length < 400) probeOther += "[" + polls + ": " + v.Replace(";", ",").Replace("=", ":") + "]";
      }
      if (tRename < 0) {
        renameTries++; double tr = sw.Elapsed.TotalMilliseconds; double a, b; bool up;
        int e = TryRenameCheck(exePath, tmp, unpackDir, out a, out b, out up);
        if (e == 0) { tRename = tr; renOut = a; renBack = b; unpackAtRename = up ? "present" : "absent"; order.Add("rename-ok@" + polls); }
        else { if (!errs.ContainsKey(e)) errs[e] = 0; errs[e]++; if (e < -100000) return "FATAL rename-back failed " + e; }
      }
      if (tStub < 0 && Exited(hStub)) { tStub = sw.Elapsed.TotalMilliseconds; order.Add("stub-exit@" + polls); }
      if (tStub >= 0 && tProbe >= 0 && tRename >= 0 && tUnpack >= 0 && (!havePlugins || tPlugins >= 0)) break;
      if (sw.Elapsed.TotalMilliseconds - tCloseMs > timeoutMs) { order.Add("timeout@" + polls); break; }
      Thread.Sleep(intervalMs);
    }
    var sb = new StringBuilder();
    var inv = System.Globalization.CultureInfo.InvariantCulture;
    Func<double, string> f = x => x < 0 ? "null" : (x - tCloseMs).ToString("0.0", inv);
    sb.Append("app_exit=" + f(tApp) + ";tree_exit=" + f(tTree) + ";unpack_gone=" + f(tUnpack) + ";plugins_gone=" + f(tPlugins) +
              ";handle_closed=" + f(tHandle) + ";probe_free=" + f(tProbe) + ";probe_free_end=" + f(tProbeEnd) + ";unpack_at_probe=" + unpackAtProbe +
              ";rename_ok=" + f(tRename) + ";unpack_at_rename=" + unpackAtRename + ";stub_exit=" + f(tStub) +
              ";rename_out_ms=" + renOut.ToString("0.0", inv) + ";rename_back_ms=" + renBack.ToString("0.0", inv) +
              ";probe_tries=" + probeTries + ";probe_held=" + probeHeld + ";probe_ms_max=" + probeMsMax.ToString("0.0", inv) + ";probe_other=" + probeOther +
              ";polls=" + polls + ";rename_tries=" + renameTries + ";order=" + string.Join(",", order.ToArray()) + ";rename_errs=");
    foreach (var kv in errs) sb.Append(kv.Key + "x" + kv.Value + " ");
    return sb.ToString();
  }
}
