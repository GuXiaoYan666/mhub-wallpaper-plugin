param([int]$ParentProcessId = 0, [int]$IntervalMs = 700)
# Mineradio is an Electron player: it neither updates its window title nor writes
# SMTC, and its playback snapshot can be up to a minute old while the window is
# in the background. This helper reads the player console title/artist and the
# progress text through UI Automation so track switches and lyric positions
# show up at once.
#
# Keep this file ASCII-only: Windows PowerShell 5.1 decodes BOM-less scripts with
# the system code page, and non-ASCII bytes can break the parser.
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker

$titleCond = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, 'control-title')
$artistCond = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, 'control-artist')
$textCond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)
$timeRe = '^\d+(:\d+)?:\d{2}\s*/\s*\d+(:\d+)?:\d{2}$'

$win = $null
$lastHandle = [IntPtr]::Zero
$lastProbe = 0
$lastPos = -1
$lastPosAt = 0
$lastTitle = ''
$playing = $true

function Find-Window {
  $p = Get-Process -Name Mineradio -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } |
    Select-Object -First 1
  if (-not $p) { return $null }
  if ($script:win -and $script:lastHandle -eq $p.MainWindowHandle) { return $script:win }
  $script:lastHandle = $p.MainWindowHandle
  try { return $AE::FromHandle($p.MainWindowHandle) } catch { return $null }
}

# Multiple consoles exist (home bar / lyrics page / hidden duplicates). Pick the
# visible one first, otherwise the first one found.
function Find-Element($root, $cond) {
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
  $fallback = $null
  foreach ($e in $all) {
    if (-not $e.Current.IsOffscreen) { return $e }
    if (-not $fallback) { $fallback = $e }
  }
  return $fallback
}

# control-title / control-artist are Groups without an accessible name in
# Mineradio's Chromium build; the real text lives in their Text children.
function Get-TextOf($group) {
  if (-not $group) { return '' }
  $name = [string]$group.Current.Name
  if ($name.Trim()) { return $name.Trim() }
  try {
    $kids = $group.FindAll([System.Windows.Automation.TreeScope]::Descendants, $textCond)
    foreach ($k in $kids) {
      if ($k.Current.IsOffscreen) { continue }
      $n = [string]$k.Current.Name
      if ($n.Trim()) { return $n.Trim() }
    }
    foreach ($k in $kids) {
      $n = [string]$k.Current.Name
      if ($n.Trim()) { return $n.Trim() }
    }
  } catch { }
  return ''
}

# The progress text has no AutomationId and can also appear in a hidden console
# stuck at 0:00. Walk up from the title element and only take a visible text.
function Find-Progress($titleEl) {
  if (-not $titleEl) { return '' }
  $node = $titleEl
  for ($depth = 0; $depth -lt 8 -and $node; $depth++) {
    try {
      $texts = $node.FindAll([System.Windows.Automation.TreeScope]::Descendants, $textCond)
    } catch { return '' }
    foreach ($t in $texts) {
      if ($t.Current.IsOffscreen) { continue }
      $n = [string]$t.Current.Name
      if ($n -match $timeRe) { return $n }
    }
    try { $node = $walker.GetParent($node) } catch { return '' }
    if ($node -and $node.Current.ControlType -eq [System.Windows.Automation.ControlType]::Window) { break }
  }
  return ''
}

while ($true) {
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if ($ParentProcessId -gt 0) {
    if (-not (Get-Process -Id $ParentProcessId -ErrorAction SilentlyContinue)) { break }
  }

  $probeGap = if ($win) { 5000 } else { 2000 }
  if (($now - $lastProbe) -ge $probeGap) {
    $lastProbe = $now
    try { $win = Find-Window } catch { $win = $null }
  }

  $title = ''
  $artist = ''
  $timeText = ''
  if ($win) {
    try {
      $titleEl = Find-Element $win $titleCond
      $artistEl = Find-Element $win $artistCond
      $title = Get-TextOf $titleEl
      $artist = Get-TextOf $artistEl
      if ($title) { $timeText = Find-Progress $titleEl }
    } catch { $win = $null; $title = '' }
  }

  $positionMs = -1
  $durationMs = 0
  if ($timeText -match '(\d+(?::\d+)?:\d{2})\s*/\s*(\d+(?::\d+)?:\d{2})') {
    $positionMs = 0
    foreach ($part in $Matches[1].Split(':')) { $positionMs = $positionMs * 60 + [int]$part }
    $positionMs = $positionMs * 1000
    $durationMs = 0
    foreach ($part in $Matches[2].Split(':')) { $durationMs = $durationMs * 60 + [int]$part }
    $durationMs = $durationMs * 1000
  }

  if ($title -ne $lastTitle) {
    $lastTitle = $title
    $lastPos = -1
    $lastPosAt = $now
  }
  if ($title -and $positionMs -ge 0) {
    if ($positionMs -ne $lastPos) {
      $lastPos = $positionMs
      $lastPosAt = $now
      $playing = $true
    } elseif (($now - $lastPosAt) -ge 3000) {
      $playing = $false
    }
  }

  $row = [ordered]@{
    title = $title
    artist = $artist
    positionMs = $positionMs
    durationMs = $durationMs
    playing = $playing
    at = $now
  }
  # Node reads the pipe as UTF-8, but Windows PowerShell may encode redirected
  # output with the system code page. Escape non-ASCII characters so track names
  # always survive.
  $json = ConvertTo-Json -InputObject $row -Compress
  $sb = New-Object System.Text.StringBuilder
  foreach ($ch in $json.ToCharArray()) {
    if ([int]$ch -gt 127) { [void]$sb.AppendFormat('\u{0:x4}', [int]$ch) }
    else { [void]$sb.Append($ch) }
  }
  Write-Output $sb.ToString()

  Start-Sleep -Milliseconds $IntervalMs
}
