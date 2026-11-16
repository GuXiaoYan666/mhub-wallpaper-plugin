#requires -Version 5.1
param([int]$ParentProcessId=0)
# KuGou 20.1 player's native accessibility time text, sampled without input.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName Accessibility
Add-Type -Path (Join-Path $PSScriptRoot 'kugou-native.cs')
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using Accessibility;
public static class LyricBridgeKuGouTime {
  [DllImport("oleacc.dll")]
  private static extern int AccessibleObjectFromWindow(IntPtr hwnd, int objid, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IAccessible acc);
  [DllImport("oleacc.dll")]
  private static extern int AccessibleChildren(IAccessible acc, int start, int count, [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex=2)] object[] children, out int got);
  // KuGou places the same player bar under different accessibility branches
  // on the lyric-detail page and the search/library page.
  private static readonly int[][] Paths = {
    new int[]{2,6,6,2,1,0}, new int[]{2,5,6,2,1,0},
    new int[]{1,13,6,2,1,0}, new int[]{1,14,6,2,1,0}
  };
  private static IntPtr oldHwnd;
  private static IAccessible timeLabel;
  public static string Read(IntPtr hwnd) {
    if (hwnd == IntPtr.Zero) return null;
    try {
      if (timeLabel == null || hwnd != oldHwnd) {
        oldHwnd = hwnd;
        timeLabel = null;
        Guid iid = new Guid("618736e0-3c3d-11cf-810c-00aa00389b71");
        IAccessible root;
        if (AccessibleObjectFromWindow(hwnd, -4, ref iid, out root) < 0 || root == null) return null;
        foreach (int[] path in Paths) {
          try {
            IAccessible cur = root;
            bool found = true;
            foreach (int index in path) {
              int count = cur.accChildCount;
              if (count <= index || count > 1000) { found = false; break; }
              object[] children = new object[1];
              int got;
              if (AccessibleChildren(cur, index, 1, children, out got) < 0 || got != 1 || !(children[0] is IAccessible)) { found = false; break; }
              cur = (IAccessible)children[0];
            }
            if (found && !String.IsNullOrEmpty(cur.get_accName(0)) && cur.get_accName(0).IndexOf('/') >= 0) { timeLabel = cur; break; }
          } catch { }
        }
        if (timeLabel == null) {
          Queue<IAccessible> queue = new Queue<IAccessible>(); queue.Enqueue(root);
          for (int visited = 0; queue.Count > 0 && visited < 800; visited++) {
            IAccessible cur = queue.Dequeue();
            try {
              if (Regex.IsMatch(cur.get_accName(0) ?? "", @"^\d{1,3}:\d{2}/\d{1,3}:\d{2}$")) { timeLabel = cur; break; }
              int count = cur.accChildCount;
              if (count < 1 || count > 1000) continue;
              object[] children = new object[count]; int got;
              if (AccessibleChildren(cur, 0, count, children, out got) < 0) continue;
              for (int i = 0; i < got && queue.Count < 1000; i++) if (children[i] is IAccessible) queue.Enqueue((IAccessible)children[i]);
            } catch { }
          }
        }
        if (timeLabel == null) return null;
      }
      string value = timeLabel.get_accName(0);
      if (String.IsNullOrEmpty(value) || value.IndexOf('/') < 0) { timeLabel = null; return null; }
      return value;
    } catch { timeLabel = null; return null; }
  }
}
'@ -ReferencedAssemblies @('Accessibility','System.Windows.Forms')

$hwnd = [IntPtr]::Zero
$lastWindowCheck = [DateTime]::MinValue
while ($true) {
  if ($ParentProcessId -gt 0 -and -not (Get-Process -Id $ParentProcessId -ErrorAction SilentlyContinue)) { break }
  if (([DateTime]::UtcNow - $lastWindowCheck).TotalMilliseconds -ge 1000) {
    $lastWindowCheck = [DateTime]::UtcNow
    $windows = @([LyricBridgeKuGouWindows]::Candidates())
    $hwnd = [IntPtr]::Zero
    foreach ($candidate in $windows) {
      if ([LyricBridgeKuGouTime]::Read($candidate)) { $hwnd = $candidate; break }
    }
  }
  $label = [LyricBridgeKuGouTime]::Read($hwnd)
  if ($label -match '^(\d{1,3}):(\d{2})/(\d{1,3}):(\d{2})$') {
    $row = [ordered]@{
      elapsedMs = (([int]$matches[1] * 60) + [int]$matches[2]) * 1000
      durationMs = (([int]$matches[3] * 60) + [int]$matches[4]) * 1000
      at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
    [Console]::WriteLine(($row | ConvertTo-Json -Compress))
  }
  Start-Sleep -Milliseconds 150
}
