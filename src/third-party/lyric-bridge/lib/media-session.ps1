#requires -Version 5.1
param([Parameter(Mandatory=$true)][string]$CommandDir,[int]$ParentProcessId=0)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
function Await($op, [Type]$type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  if (-not $task.Wait(3000)) { throw 'Media operation timed out' }
  return $task.Result
}
function Emit($data) { [Console]::WriteLine(($data | ConvertTo-Json -Depth 6 -Compress)) }
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime] | Out-Null
[Windows.Storage.Streams.DataReader,Windows.Storage.Streams,ContentType=WindowsRuntime] | Out-Null
$manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$asStream = [System.IO.WindowsRuntimeStreamExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsStream' -and $_.GetParameters().Count -eq 1 } | Select-Object -First 1
$coverKey = ''; $cover = ''; $selected = $null; $state = $null
Add-Type -Path (Join-Path $PSScriptRoot 'kugou-native.cs')
function Read-Cover($properties) {
  if (-not $properties.Thumbnail) { return '' }
  $stream = $null; $net = $null; $output = $null
  try {
    $stream = Await ($properties.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
    # WinRT returns a COM interface here. Reflection preserves its interface
    # conversion; PowerShell's normal overload binder cannot convert it.
    $net = $asStream.Invoke($null,@($stream))
    if ($net.Length -le 0 -or $net.Length -gt 2097152) { return '' }
    $output = New-Object IO.MemoryStream
    $net.CopyTo($output); $bytes = $output.ToArray()
    $mime = 'image/png'
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 255 -and $bytes[1] -eq 216) { $mime = 'image/jpeg' }
    elseif ($bytes.Length -ge 12 -and [Text.Encoding]::ASCII.GetString($bytes,8,4) -eq 'WEBP') { $mime = 'image/webp' }
    elseif ($bytes.Length -ge 2 -and $bytes[0] -eq 66 -and $bytes[1] -eq 77) { $mime = 'image/bmp' }
    return ('data:' + $mime + ';base64,' + [Convert]::ToBase64String($bytes))
  } catch { return '' }
  finally { if ($output) { $output.Dispose() }; if ($net) { $net.Dispose() } elseif ($stream) { $stream.Dispose() } }
}
function Update-Cover([string]$key,$properties) {
  # A title can arrive before its thumbnail. Re-read the live thumbnail on
  # every sample, even when the track key and thumbnail reference stay equal.
  # Keep a good image through a transient read failure only for this track.
  if ($key -ne $script:coverKey) { $script:coverKey = $key; $script:cover = '' }
  $freshCover = Read-Cover $properties
  if ($freshCover) { $script:cover = $freshCover }
  return $script:cover
}
function Seek-KuGou([double]$positionMs,[double]$durationMs) {
  if (-not ('LyricBridgeKuGouSeek' -as [type])) {
    Add-Type -AssemblyName Accessibility
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Accessibility;
public static class LyricBridgeKuGouSeek {
  public static string LastError="";
  [DllImport("oleacc.dll")]
  private static extern int AccessibleObjectFromWindow(IntPtr hwnd, int objid, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IAccessible acc);
  [DllImport("oleacc.dll")]
  private static extern int AccessibleChildren(IAccessible acc, int start, int count, [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex=2)] object[] children, out int got);
  [DllImport("oleacc.dll")]
  private static extern int WindowFromAccessibleObject(IAccessible acc, out IntPtr hwnd);
  [StructLayout(LayoutKind.Sequential)] private struct Point { public int x,y; }
  [DllImport("user32.dll")] private static extern bool ScreenToClient(IntPtr hwnd, ref Point pt);
  [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);
  [DllImport("user32.dll")] private static extern bool IsChild(IntPtr parent,IntPtr child);
  [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  private static bool IsProgress(IAccessible control) {
    try { return control!=null && control.get_accName(0)=="\u8fdb\u5ea6" && Convert.ToInt32(control.get_accRole(0))==51; }
    catch { return false; }
  }
  private static IAccessible FindProgress(IntPtr hwnd) {
    Guid iid = new Guid("618736e0-3c3d-11cf-810c-00aa00389b71");
    IAccessible root;
    if (AccessibleObjectFromWindow(hwnd,-4,ref iid,out root)<0 || root==null) return null;
    foreach (int[] path in new int[][] {new int[]{2,5,5},new int[]{2,6,5},new int[]{1,13,5},new int[]{1,14,5}}) {
      try {
        IAccessible cur=root;
        foreach(int index in path) {
          object[] kids=new object[1];int got;
          if(AccessibleChildren(cur,index,1,kids,out got)<0 || got!=1 || !(kids[0] is IAccessible)) {cur=null;break;}
          cur=(IAccessible)kids[0];
        }
        if(IsProgress(cur)) return cur;
      } catch { }
    }
    // The player bar moves between branches when KuGou changes pages.
    // Match its exact name and slider role, with a bounded traversal.
    Queue<IAccessible> queue=new Queue<IAccessible>();queue.Enqueue(root);
    for(int visited=0;queue.Count>0 && visited<800;visited++) {
      IAccessible cur=queue.Dequeue();
      if(IsProgress(cur)) return cur;
      try {
        int count=cur.accChildCount;
        if(count<1 || count>1000) continue;
        object[] kids=new object[count];int got;
        if(AccessibleChildren(cur,0,count,kids,out got)<0) continue;
        for(int i=0;i<got && queue.Count<1000;i++) if(kids[i] is IAccessible) queue.Enqueue((IAccessible)kids[i]);
      } catch { }
    }
    return null;
  }
  private static bool Confirm(IAccessible control,double target,int attempts) {
    for(int attempt=0;attempt<attempts;attempt++) {
      System.Threading.Thread.Sleep(80);
      try {
        string value=control.get_accValue(0);double percent;
        if(double.TryParse((value??"").TrimEnd('%'),System.Globalization.NumberStyles.Float,System.Globalization.CultureInfo.InvariantCulture,out percent) && Math.Abs(percent-target*100)<1.5) return true;
      } catch { }
    }
    return false;
  }
  public static bool Seek(IntPtr hwnd, double fraction) {
    LastError="";
    bool minimized=IsIconic(hwnd);
    IntPtr previousDpi=IntPtr.Zero;
    try {
      // MSAA reports physical screen bounds. Keep coordinate conversion in
      // that same space on monitors with display scaling.
      try {previousDpi=SetThreadDpiAwarenessContext(new IntPtr(-4));} catch(EntryPointNotFoundException) { }
      // Find the hidden native window directly. Seeking must never restore,
      // activate, move, or change the z-order of KuGou's window.
      IAccessible control=null;
      for(int i=0;i<6 && control==null;i++) {control=FindProgress(hwnd);if(control==null)System.Threading.Thread.Sleep(40);}
      if(control==null) {LastError="KuGou progress control not found";return false;}
      double target=Math.Max(0,Math.Min(1,fraction));
      try {
        control.set_accValue(0,(target*100).ToString("0.###",System.Globalization.CultureInfo.InvariantCulture)+"%");
        if(Confirm(control,target,2)) return true;
      } catch { }
      // Custom KuGou sliders reject the setter. Deliver only to the window
      // owning this exact control; never move the global pointer or focus.
      IntPtr owner;int x,y,width,height;
      if(WindowFromAccessibleObject(control,out owner)<0 || (owner!=hwnd && !IsChild(hwnd,owner))) {LastError="Invalid KuGou progress owner";return false;}
      control.accLocation(out x,out y,out width,out height,0);
      if(width<30 || height<1) {LastError="Invalid KuGou progress bounds";return false;}
      Point point=new Point{x=x+(int)Math.Round(target*(width-1)),y=y+height/2};
      if(!ScreenToClient(owner,ref point) || point.x<0 || point.y<0 || point.x>32767 || point.y>32767) {LastError="Invalid KuGou progress coordinates";return false;}
      IntPtr packed=new IntPtr((point.y<<16)|(point.x&65535));
      if(!PostMessage(owner,0x0201,new IntPtr(1),packed) || !PostMessage(owner,0x0202,IntPtr.Zero,packed)) {LastError="KuGou did not accept progress input";return false;}
      if(Confirm(control,target,8)) return true;
      LastError="KuGou did not confirm the new position (expected="+(target*100).ToString("0.###",System.Globalization.CultureInfo.InvariantCulture)+"%, actual="+control.get_accValue(0)+", minimized="+minimized+", bounds="+x+","+y+","+width+","+height+")";return false;
    } catch(Exception error) {LastError=error.Message;return false;}
    finally {
      if(previousDpi!=IntPtr.Zero) SetThreadDpiAwarenessContext(previousDpi);
    }
  }
}
'@ -ReferencedAssemblies @('Accessibility','System.Windows.Forms')
  }
  $windows = @([LyricBridgeKuGouWindows]::Candidates())
  if ($windows.Count -eq 0 -or $durationMs -le 0) { throw 'KuGou window or duration unavailable' }
  foreach ($hwnd in $windows) {
    if ([LyricBridgeKuGouSeek]::Seek($hwnd,($positionMs/$durationMs))) { return $true }
  }
  throw ('KuGou progress slider unavailable: ' + [LyricBridgeKuGouSeek]::LastError)
}
function Get-QQMusicTarget {
  # Resolve the executable from the one live player, including tray-only
  # windows. Never start a registered path or guess a window coordinate.
  $players = @(Get-Process -Name QQMusic -ErrorAction SilentlyContinue)
  if ($players.Count -ne 1) { return $null }
  try {
    $path = $players[0].Path
    if ($path -and [IO.Path]::GetFileName($path) -ieq 'QQMusic.exe' -and [IO.File]::Exists($path)) {
      return @{path=$path; pid=$players[0].Id}
    }
  } catch { }
  return $null
}
function Read-QQMusicSession($session) {
  $properties = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  $timeline = $session.GetTimelineProperties()
  return @{
    key=([string]$session.SourceAppUserModelId + '|' + $properties.Title + '|' + $properties.Artist + '|' + $properties.AlbumTitle)
    positionMs=$timeline.Position.TotalMilliseconds
    durationMs=($timeline.EndTime - $timeline.StartTime).TotalMilliseconds
    positionAt=$timeline.LastUpdatedTime.ToUnixTimeMilliseconds()
    playing=([string]$session.GetPlaybackInfo().PlaybackStatus -eq 'Playing')
  }
}
function Send-QQMusicSeek($target,[double]$positionMs) {
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName = $target.path
  # QQ's native seekto command takes seconds and forwards to its running
  # instance without activating its window. Only an invariant number is sent.
  $start.Arguments = '/seekto ' + ($positionMs/1000).ToString('0.###',[Globalization.CultureInfo]::InvariantCulture)
  $start.UseShellExecute = $false; $start.CreateNoWindow = $true; $start.WindowStyle = 'Hidden'
  $process = [Diagnostics.Process]::Start($start)
  if (-not $process) { throw 'QQ Music seek command could not start' }
  $process.Dispose()
}
function Seek-QQMusic($session,[string]$trackKey,[double]$positionMs,[double]$durationMs) {
  if ([double]::IsNaN($positionMs) -or [double]::IsInfinity($positionMs) -or
      [double]::IsNaN($durationMs) -or [double]::IsInfinity($durationMs) -or
      $durationMs -le 0 -or $positionMs -lt 0 -or $positionMs -gt $durationMs) { throw 'Invalid QQ Music seek position' }
  $target = Get-QQMusicTarget
  if (-not $target) { throw 'QQ Music background control is unavailable' }
  $before = Read-QQMusicSession $session
  if ($before.key -ne $trackKey) { throw 'The playing track changed. Retry the action.' }
  if ($before.durationMs -le 0 -or $positionMs -gt $before.durationMs -or [Math]::Abs($durationMs-$before.durationMs) -gt 2000) { throw 'QQ Music track duration changed. Retry the action.' }
  $confirmed = $false
  try {
    Send-QQMusicSeek $target $positionMs
    $deadline = [DateTime]::UtcNow.AddMilliseconds(3200)
    while ([DateTime]::UtcNow -lt $deadline) {
      Start-Sleep -Milliseconds 60
      $current = Read-QQMusicSession $session
      if ($current.key -ne $trackKey) { throw 'The playing track changed. Retry the action.' }
      # Playback status arrives before QQ's next timeline sample. Re-pause
      # immediately instead of letting a paused seek play for a full second.
      if (-not $before.playing -and $current.playing) {
        if (-not (Await ($session.TryPauseAsync()) ([bool]))) { throw 'QQ Music could not preserve the paused state' }
        continue
      }
      # A successful process launch or the unchanged pre-seek sample is not
      # proof of a seek. Require a fresh timeline and the requested position.
      if ($current.positionAt -ne $before.positionAt -and [Math]::Abs($current.positionMs-$positionMs) -lt 1300) { $confirmed = $true; break }
    }
    if (-not $confirmed) { throw 'QQ Music did not confirm the new playback position' }
  } finally {
    # QQ seekto resumes paused songs. Preserve the original pause state on
    # success and failure, but never pause a different track after a change.
    if (-not $before.playing) {
      $current = Read-QQMusicSession $session
      if ($current.key -eq $trackKey -and $current.playing) {
        if (-not (Await ($session.TryPauseAsync()) ([bool]))) { throw 'QQ Music could not preserve the paused state' }
        $pauseDeadline = [DateTime]::UtcNow.AddMilliseconds(600)
        do {
          Start-Sleep -Milliseconds 40
          $current = Read-QQMusicSession $session
        } while ($current.key -eq $trackKey -and $current.playing -and [DateTime]::UtcNow -lt $pauseDeadline)
        if ($current.key -ne $trackKey) { throw 'The playing track changed. Retry the action.' }
        if ($current.playing) { throw 'QQ Music did not confirm the paused state' }
      }
    }
  }
  return $true
}
while ($true) {
  if ($ParentProcessId -gt 0 -and -not (Get-Process -Id $ParentProcessId -ErrorAction SilentlyContinue)) { break }
  try {
    $sessions = @($manager.GetSessions())
    $current = $manager.GetCurrentSession()
    $playing = @($sessions | Where-Object { [string]$_.GetPlaybackInfo().PlaybackStatus -eq 'Playing' })
    $previousId = if ($selected) { $selected.SourceAppUserModelId } else { '' }
    $selected = $playing | Where-Object { $current -and $_.SourceAppUserModelId -eq $current.SourceAppUserModelId } | Select-Object -First 1
    if (-not $selected) { $selected = $playing | Where-Object { $_.SourceAppUserModelId -eq $previousId } | Select-Object -First 1 }
    if (-not $selected) { $selected = $playing | Select-Object -First 1 }
    if (-not $selected -and $current) { $selected = $sessions | Where-Object { $_.SourceAppUserModelId -eq $current.SourceAppUserModelId } | Select-Object -First 1 }
    if (-not $selected) { $selected = $sessions | Select-Object -First 1 }
    if ($selected) {
      $properties = Await ($selected.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
      $info = $selected.GetPlaybackInfo(); $timeline = $selected.GetTimelineProperties()
      $id = [string]$selected.SourceAppUserModelId
      $key = $id + '|' + $properties.Title + '|' + $properties.Artist + '|' + $properties.AlbumTitle
      $cover = Update-Cover $key $properties
      $state = [ordered]@{
        id=$id; key=$key; title=[string]$properties.Title; artist=[string]$properties.Artist; album=[string]$properties.AlbumTitle
        artwork=$cover; playing=([string]$info.PlaybackStatus -eq 'Playing')
        positionMs=[Math]::Max(0,$timeline.Position.TotalMilliseconds)
        positionAt=$timeline.LastUpdatedTime.ToUnixTimeMilliseconds()
        playbackRate=$(if ($info.PlaybackRate -gt 0) { [double]$info.PlaybackRate } else { 1 })
        durationMs=[Math]::Max(0,($timeline.EndTime - $timeline.StartTime).TotalMilliseconds)
        at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        controls=@{previous=$info.Controls.IsPreviousEnabled; next=$info.Controls.IsNextEnabled; playPause=$info.Controls.IsPlayPauseToggleEnabled; seek=($info.Controls.IsPlaybackPositionEnabled -or $id -match '(?i)kugou' -or ($id -match '(?i)qqmusic' -and $null -ne (Get-QQMusicTarget)))}
      }
    } else { $state = $null; $coverKey = ''; $cover = '' }
    Emit @{t='state'; media=$state}
    foreach ($file in @(Get-ChildItem -LiteralPath $CommandDir -Filter '*.json' -File | Sort-Object Name)) {
      $command = $null
      try {
        $command = Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
        Remove-Item -LiteralPath $file.FullName -Force
        if (-not $command.expiresAt -or [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -gt [double]$command.expiresAt) { throw 'Media action expired. Retry the action.' }
        if (-not $selected -or $command.sessionId -ne $state.id -or $command.trackKey -ne $state.key) { throw 'The playing track changed. Retry the action.' }
        $fresh = Await ($selected.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
        if (($state.id + '|' + $fresh.Title + '|' + $fresh.Artist + '|' + $fresh.AlbumTitle) -ne $command.trackKey) { throw 'The playing track changed. Retry the action.' }
        $ok = $false
        switch ($command.action) {
          'toggle' { $ok = Await ($selected.TryTogglePlayPauseAsync()) ([bool]) }
          'previous' { $ok = Await ($selected.TrySkipPreviousAsync()) ([bool]) }
          'next' { $ok = Await ($selected.TrySkipNextAsync()) ([bool]) }
          'seek' {
            if ($state.id -match '(?i)kugou') { $ok = Seek-KuGou ([double]$command.positionMs) ([double]$command.durationMs) }
            elseif ($state.id -match '(?i)qqmusic') { $ok = Seek-QQMusic $selected ([string]$command.trackKey) ([double]$command.positionMs) ([double]$command.durationMs) }
            else { $ok = Await ($selected.TryChangePlaybackPositionAsync([long]([double]$command.positionMs * 10000))) ([bool]) }
          }
          default { throw 'Unsupported media action' }
        }
        Emit @{t='result'; requestId=$command.requestId; ok=[bool]$ok; error=$(if($ok){$null}else{'The player did not accept the action.'})}
      } catch { Emit @{t='result'; requestId=$command.requestId; ok=$false; error=$_.Exception.Message} }
    }
  } catch { Emit @{t='error'; error=$_.Exception.Message} }
  Start-Sleep -Milliseconds 400
}
