using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

// MainWindowHandle becomes zero when KuGou closes its window to the tray.
// Enumerate only windows owned by the real KuGou processes, including hidden
// windows. Callers still validate the exact accessible player controls.
public static class LyricBridgeKuGouWindows {
  private delegate bool EnumWindowProc(IntPtr hwnd, IntPtr parameter);
  [StructLayout(LayoutKind.Sequential)] private struct Rect { public int left, top, right, bottom; }
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowProc callback, IntPtr parameter);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out Rect rectangle);
  [DllImport("user32.dll")] private static extern int GetWindowLong(IntPtr hwnd, int index);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  public static IntPtr[] Candidates() {
    HashSet<uint> ids = new HashSet<uint>();
    List<IntPtr> result = new List<IntPtr>();
    foreach (Process process in Process.GetProcessesByName("KuGou")) {
      using (process) {
        try {
          ids.Add((uint)process.Id);
          if (process.MainWindowHandle != IntPtr.Zero) result.Add(process.MainWindowHandle);
        } catch (InvalidOperationException) { }
      }
    }
    List<KeyValuePair<IntPtr, long>> hidden = new List<KeyValuePair<IntPtr, long>>();
    EnumWindows(delegate(IntPtr hwnd, IntPtr parameter) {
      uint id; GetWindowThreadProcessId(hwnd, out id);
      Rect bounds;
      if (!ids.Contains(id) || result.Contains(hwnd) || (GetWindowLong(hwnd, -20) & 0x80) != 0 || !GetWindowRect(hwnd, out bounds)) return true;
      int width = bounds.right - bounds.left, height = bounds.bottom - bounds.top;
      if (width >= 400 && height >= 200) hidden.Add(new KeyValuePair<IntPtr, long>(hwnd, (long)width * height));
      return true;
    }, IntPtr.Zero);
    hidden.Sort(delegate(KeyValuePair<IntPtr, long> a, KeyValuePair<IntPtr, long> b) { return b.Value.CompareTo(a.Value); });
    foreach (KeyValuePair<IntPtr, long> window in hidden) result.Add(window.Key);
    return result.ToArray();
  }
}
