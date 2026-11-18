<#
  宿主识别模块：被 scripts\install.ps1 与 scripts\uninstall.ps1 dot-source。
  本文件只定义函数，没有任何副作用（不读注册表、不查询进程、不写文件）。
  导出函数：
    Test-MhubAppDir   -Path <dir> [-Reason [ref]$why]        校验目录是不是完整的 MCHOSE HUB 安装目录
    Get-MhubCandidates                                       收集候选安装目录（进程/注册表/默认路径/开始菜单）
    Resolve-MhubAppDir -Requested <auto|dir> [-NonInteractive] 解析出唯一的 MCHOSE HUB 安装目录
#>

function Write-MhubLine {
  param([string]$Message)
  Write-Host "[pet-hub] $Message"
}

# 把任意路径规范化成可比较的目录路径：去引号、去尾随斜杠、尽力解析成绝对路径
function ConvertTo-MhubKey {
  param([string]$Path)
  if (-not $Path) { return "" }
  $p = $Path.Trim()
  $p = $p.Trim([char]34)
  $p = $p.TrimEnd([char[]]@([char]92, [char]47))
  if (-not $p) { return "" }
  try { $p = [System.IO.Path]::GetFullPath($p) } catch { }
  try {
    $rp = Resolve-Path -LiteralPath $p -ErrorAction Stop
    if ($rp -and $rp.ProviderPath) { $p = $rp.ProviderPath }
  } catch { }
  return $p.TrimEnd([char[]]@([char]92, [char]47))
}

# 宿主版本：优先 resources\app\package.json，其次 MCHOSE HUB.exe 的文件版本；都读不到就留空
function Get-MhubVersion {
  param([string]$AppDir)
  $v = ""
  try {
    $pkg = Join-Path $AppDir "resources\app\package.json"
    if (Test-Path -LiteralPath $pkg) {
      $data = Get-Content -LiteralPath $pkg -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($data -and $data.version) { $v = [string]$data.version }
    }
  } catch { $v = "" }
  if (-not $v) {
    try {
      $exe = Join-Path $AppDir "MCHOSE HUB.exe"
      if (Test-Path -LiteralPath $exe) { $v = [string](Get-Item -LiteralPath $exe).VersionInfo.FileVersion }
    } catch { $v = "" }
  }
  if ($v) { $v = $v.Trim() }
  return $v
}

function Get-MhubArchivePackage {
  param([string]$Archive)
  $stream = [IO.File]::OpenRead($Archive)
  try {
    $reader = [IO.BinaryReader]::new($stream)
    $lead = $reader.ReadBytes(16)
    if ($lead.Length -ne 16) { throw 'ASAR header incomplete' }
    $jsonLength = [BitConverter]::ToUInt32($lead,12)
    if ($jsonLength -gt 16777216) { throw 'ASAR header too large' }
    $header = [Text.Encoding]::UTF8.GetString($reader.ReadBytes($jsonLength)) | ConvertFrom-Json
    $package = $header.files.'package.json'
    if (-not $package -or $package.unpacked -or $package.size -gt 1048576) { throw 'ASAR package metadata unavailable' }
    [void]$stream.Seek((8 + [BitConverter]::ToUInt32($lead,4) + [long]$package.offset),[IO.SeekOrigin]::Begin)
    $data = [Text.Encoding]::UTF8.GetString($reader.ReadBytes([int]$package.size)) | ConvertFrom-Json
    if ($data.name -ne 'MCHOSEHUB' -or $data.main -notmatch '^\.?/?out/main/index\.js$' -or -not $header.files.out.files.main.files.'index.jsc') { throw 'Unsupported MHUB archive structure' }
    return $data
  } finally { $stream.Dispose() }
}

function Get-MhubArchiveEntry {
  param([string]$Archive)
  $bytes = [IO.File]::ReadAllBytes($Archive)
  $headerSize = [BitConverter]::ToUInt32($bytes,4)
  $length = [BitConverter]::ToUInt32($bytes,12)
  if ($length -gt 16777216 -or (8 + $headerSize) -gt $bytes.Length) { throw 'Invalid ASAR header' }
  $header = [Text.Encoding]::UTF8.GetString($bytes,16,$length) | ConvertFrom-Json
  $item = $header.files.out.files.main.files.'index.js'
  if (-not $item -or $item.unpacked -or $item.size -gt 1048576) { throw 'Unsupported ASAR main entry' }
  $entry = [Text.Encoding]::UTF8.GetString($bytes,(8 + $headerSize + [long]$item.offset),$item.size)
  return @{ Bytes=$bytes; Header=$header; DataStart=(8+$headerSize); Entry=$entry; Item=$item }
}

function Get-MhubFileHash {
  param([string]$File)
  $stream = [IO.File]::OpenRead($File)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-','') } finally { $stream.Dispose(); $sha.Dispose() }
}

function Set-MhubArchiveEntry {
  param([string]$Archive,[string]$Entry)
  $source = Get-MhubArchiveEntry $Archive
  $entryBytes = [Text.Encoding]::UTF8.GetBytes($Entry)
  $source.Item.offset = [string]($source.Bytes.Length - $source.DataStart)
  $source.Item.size = $entryBytes.Length
  if ($source.Item.PSObject.Properties['integrity']) {
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $hash = [BitConverter]::ToString($hasher.ComputeHash($entryBytes)).Replace('-','').ToLowerInvariant() } finally { $hasher.Dispose() }
    $source.Item.integrity.hash = $hash
    $source.Item.integrity.blocks = @($hash)
  }
  $json = [Text.Encoding]::UTF8.GetBytes(($source.Header | ConvertTo-Json -Depth 100 -Compress))
  $payloadLength = [int]([Math]::Ceiling(($json.Length + 4)/4.0)*4)
  $prefix = New-Object byte[] (12 + $payloadLength)
  [BitConverter]::GetBytes([uint32]4).CopyTo($prefix,0)
  [BitConverter]::GetBytes([uint32]($payloadLength+4)).CopyTo($prefix,4)
  [BitConverter]::GetBytes([uint32]$payloadLength).CopyTo($prefix,8)
  [BitConverter]::GetBytes([uint32]$json.Length).CopyTo($prefix,12)
  $json.CopyTo($prefix,16)
  $temporary = $Archive + '.friend-tmp'
  $stream = [IO.File]::Open($temporary,[IO.FileMode]::Create,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try {
    $stream.Write($prefix,0,$prefix.Length)
    $stream.Write($source.Bytes,$source.DataStart,($source.Bytes.Length-$source.DataStart))
    $stream.Write($entryBytes,0,$entryBytes.Length)
    $stream.Flush($true)
  } finally { $stream.Dispose() }
  if ((Get-MhubArchiveEntry $temporary).Entry -ne $Entry) { Remove-Item -LiteralPath $temporary -Force; throw 'ASAR entry verification failed' }
  $previous = $Archive + '.friend-previous'
  [IO.File]::Replace($temporary,$Archive,$previous)
  Remove-Item -LiteralPath $previous -Force
}

function Test-MhubAppDir {
  param([string]$Path, [ref]$Reason)
  $p = ""
  if ($Path) { $p = ConvertTo-MhubKey $Path }
  $why = ""
  if (-not $p) {
    $why = "路径为空或无法解析"
  } else {
    $exe = Join-Path $p "MCHOSE HUB.exe"
    $mainDir = Join-Path $p "resources\app\out\main"
    $entry = Join-Path $mainDir "index.js"
    $loader = Join-Path $mainDir "bytecode-loader.cjs"
    $jsc = Join-Path $mainDir "index.jsc"
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
      $why = "缺少 $exe"
    } elseif (Test-Path -LiteralPath (Join-Path $p 'resources\app.asar') -PathType Leaf) {
      try { $null = Get-MhubArchivePackage (Join-Path $p 'resources\app.asar') } catch { $why = $_.Exception.Message }
    } elseif (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
      $why = "缺少 $entry"
    } elseif (-not ((Test-Path -LiteralPath $loader -PathType Leaf) -or (Test-Path -LiteralPath $jsc -PathType Leaf))) {
      $why = "缺少 $loader 与 $jsc（至少要有一个）"
    }
  }
  if ($why) {
    if ($Reason) { $Reason.Value = $why }
    return $false
  }
  if ($Reason) { $Reason.Value = "" }
  return $true
}

# 来源优先级：运行中进程(0) > 注册表(1) > 默认路径(2) > 开始菜单快捷方式(3)
function Get-MhubSourceRank {
  param([string]$Source)
  $rank = 9
  if (-not $Source) { return $rank }
  foreach ($part in ($Source -split ";")) {
    $r = 9
    switch ($part.Trim().ToLowerInvariant()) {
      "process"  { $r = 0 }
      "registry" { $r = 1 }
      "default"  { $r = 2 }
      "shortcut" { $r = 3 }
      default    { $r = 9 }
    }
    if ($r -lt $rank) { $rank = $r }
  }
  return $rank
}

# 带超时的单行输入（只在真实控制台调用；重定向输入时返回 $null）：超时返回 $null
function Read-MhubLine {
  param([int]$TimeoutSeconds = 10)
  try { $null = [Console]::KeyAvailable } catch { return $null }
  $sb = New-Object System.Text.StringBuilder
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $limit = 0
  if ($TimeoutSeconds -gt 0) { $limit = $TimeoutSeconds * 1000 }
  while ($true) {
    if ($limit -gt 0 -and $sw.ElapsedMilliseconds -ge $limit) { return $null }
    $available = $false
    try { $available = [Console]::KeyAvailable } catch { return $null }
    if (-not $available) { Start-Sleep -Milliseconds 50; continue }
    $key = [Console]::ReadKey($true)
    if ($key.Key -eq [ConsoleKey]::Enter) { Write-Host ""; return $sb.ToString() }
    if ($key.Key -eq [ConsoleKey]::Escape) { return $null }
    if ($key.Key -eq [ConsoleKey]::Backspace) {
      if ($sb.Length -gt 0) {
        [void]$sb.Length--
        Write-Host ([string][char]8 + " " + [string][char]8) -NoNewline
      }
      continue
    }
    [void]$sb.Append($key.KeyChar)
    Write-Host $key.KeyChar -NoNewline
  }
  return $null
}

function Add-MhubRaw {
  param($List, [string]$Path, [string]$Source, [bool]$Running)
  if (-not $Path) { return }
  if (-not (ConvertTo-MhubKey $Path)) { return }
  $List.Add([pscustomobject]@{
    Path = $Path
    Source = $Source
    Running = [bool]$Running
  })
}

function Get-MhubCandidates {
  $raw = New-Object "System.Collections.Generic.List[object]"

  # a. 运行中的宿主进程（.Path 访问被拒时静默跳过）
  foreach ($name in @("MCHOSE HUB", "MCHOSE HUB Launcher", "MCHOSE HUB Watcher")) {
    foreach ($proc in @(Get-Process -Name $name -ErrorAction SilentlyContinue)) {
      $exePath = ""
      try { $exePath = $proc.Path } catch { $exePath = "" }
      if (-not $exePath) { continue }
      $dir = Split-Path -Parent $exePath
      if (-not $dir) { continue }
      # 进程可能跑在 libs\EXE 这类子目录，向上找到真正的宿主根目录
      $root = $dir
      $cur = $dir
      for ($i = 0; $i -lt 4 -and $cur; $i++) {
        if (Test-MhubAppDir -Path $cur) { $root = $cur; break }
        $parent = Split-Path -Parent $cur
        if (-not $parent -or $parent -eq $cur) { break }
        $cur = $parent
      }
      Add-MhubRaw -List $raw -Path $root -Source "process" -Running $true
    }
  }

  # b. 注册表卸载表：目录优先取 InstallLocation，其次 DisplayIcon，再次 UninstallString
  $uninstallRoots = @(
    "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
    "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"
  )
  foreach ($root in $uninstallRoots) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    foreach ($key in @(Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue)) {
      $props = $null
      try { $props = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction Stop } catch { $props = $null }
      if (-not $props) { continue }
      if (-not $props.DisplayName) { continue }
      if (-not ($props.DisplayName -match "MCHOSE")) { continue }
      $dir = ""
      if ($props.InstallLocation -and ([string]$props.InstallLocation).Trim()) {
        $dir = ([string]$props.InstallLocation).Trim()
      }
      if (-not $dir -and $props.DisplayIcon) {
        $icon = ([string]$props.DisplayIcon).Trim()
        $icon = $icon -replace ",\s*-?\d+\s*$", ""
        $icon = $icon.Trim([char]34).Trim()
        $icon = [Environment]::ExpandEnvironmentVariables($icon)
        if ($icon) {
          $parent = Split-Path -Parent $icon
          if ($parent) { $dir = $parent }
        }
      }
      if (-not $dir -and $props.UninstallString) {
        $cmd = ([string]$props.UninstallString).Trim()
        if ($cmd.StartsWith([string][char]34)) {
          $parts = $cmd -split [string][char]34
          if ($parts.Count -ge 2) { $cmd = $parts[1] } else { $cmd = "" }
        } else {
          $cmd = ($cmd -split "\s+")[0]
        }
        if ($cmd) { $cmd = [Environment]::ExpandEnvironmentVariables($cmd.Trim()) }
        if ($cmd) {
          $parent = Split-Path -Parent $cmd
          if ($parent) { $dir = $parent }
        }
      }
      Add-MhubRaw -List $raw -Path $dir -Source "registry" -Running $false
    }
  }

  # c. 默认安装路径
  $defaults = New-Object "System.Collections.Generic.List[string]"
  $pf = [Environment]::GetFolderPath("ProgramFiles")
  if ($pf) { $defaults.Add((Join-Path $pf "MCHOSE HUB\M HUB")); $defaults.Add((Join-Path $pf "MCHOSE HUB")) }
  $pfx86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
  if ($pfx86) { $defaults.Add((Join-Path $pfx86 "MCHOSE HUB")) }
  if ($env:LOCALAPPDATA) { $defaults.Add((Join-Path $env:LOCALAPPDATA "Programs\MCHOSE HUB")) }
  if ($env:ProgramData) { $defaults.Add((Join-Path $env:ProgramData "MCHOSE HUB")) }
  foreach ($d in $defaults) {
    if (Test-Path -LiteralPath $d -PathType Container) { Add-MhubRaw -List $raw -Path $d -Source "default" -Running $false }
  }

  # d. 开始菜单快捷方式（名字含 MCHOSE / MHub）
  $startDirs = @()
  if ($env:ProgramData) { $startDirs += (Join-Path $env:ProgramData "Microsoft\Windows\Start Menu\Programs") }
  if ($env:APPDATA) { $startDirs += (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs") }
  $shell = $null
  try { $shell = New-Object -ComObject WScript.Shell } catch { $shell = $null }
  foreach ($sd in $startDirs) {
    if (-not (Test-Path -LiteralPath $sd)) { continue }
    foreach ($lnk in @(Get-ChildItem -LiteralPath $sd -Recurse -File -Force -Filter "*.lnk" -ErrorAction SilentlyContinue)) {
      if (-not ($lnk.Name -match "MCHOSE|MHub")) { continue }
      $target = ""
      if ($shell) {
        try { $target = $shell.CreateShortcut($lnk.FullName).TargetPath } catch { $target = "" }
      }
      if (-not $target) { continue }
      $parent = Split-Path -Parent $target
      Add-MhubRaw -List $raw -Path $parent -Source "shortcut" -Running $false
    }
  }
  if ($shell) { try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell) } catch { } }

  # 合并同目录候选：大小写不敏感去重，Source 记录全部命中来源，Running 取或
  $merged = New-Object "System.Collections.Generic.List[object]"
  $index = New-Object "System.Collections.Generic.Dictionary[string,int]" ([StringComparer]::OrdinalIgnoreCase)
  foreach ($item in $raw) {
    $key = ConvertTo-MhubKey $item.Path
    if (-not $key) { continue }
    if ($index.ContainsKey($key)) {
      $prev = $merged[$index[$key]]
      $sources = @(([string]$prev.Source) -split ";")
      if (-not ($sources -contains $item.Source)) {
        $prev.Source = ([string]$prev.Source) + ";" + $item.Source
      }
      if ($item.Running) { $prev.Running = $true }
    } else {
      $index[$key] = $merged.Count
      $merged.Add([pscustomobject]@{
        AppDir = $key
        Source = [string]$item.Source
        Running = [bool]$item.Running
        Version = (Get-MhubVersion $key)
      })
    }
  }
  return @($merged.ToArray())
}

function Resolve-MhubAppDir {
  param([string]$Requested = "auto", [switch]$NonInteractive)

  $interactive = -not $NonInteractive
  if ($interactive) {
    try { if ([Console]::IsInputRedirected) { $interactive = $false } } catch { $interactive = $false }
  }

  $req = ""
  if ($Requested) { $req = $Requested.Trim().Trim([char]34).Trim() }
  if ($req -and ($req.ToLowerInvariant() -ne "auto")) {
    $why = ""
    if (Test-MhubAppDir -Path $req -Reason ([ref]$why)) {
      $resolved = ConvertTo-MhubKey $req
      Write-MhubLine "使用指定宿主目录：$resolved"
      return $resolved
    }
    throw "指定的宿主目录不可用：$req（$why）。请用 -AppDir 指向 MCHOSE HUB 的安装目录（该目录下应有 MCHOSE HUB.exe 与 resources\app\out\main\index.js），或去掉 -AppDir 让脚本自动识别。"
  }

  $candidates = @(Get-MhubCandidates)
  $valid = New-Object "System.Collections.Generic.List[object]"
  foreach ($c in $candidates) {
    if (Test-MhubAppDir -Path $c.AppDir) { $valid.Add($c) }
  }
  # 运行中的排最前，其次按来源优先级 a > b > c > d
  $sorted = @($valid | Sort-Object @{ Expression = { if ($_.Running) { 0 } else { 1 } } }, @{ Expression = { Get-MhubSourceRank -Source $_.Source } })
  $count = $sorted.Count

  if ($count -eq 1) {
    Write-MhubLine "自动识别宿主：$($sorted[0].AppDir)（来源：$($sorted[0].Source)）"
    return $sorted[0].AppDir
  }

  if ($count -gt 1) {
    if (-not $interactive) {
      $chosen = $sorted[0]
      $state = ""
      if ($chosen.Running) { $state = "，正在运行" }
      Write-MhubLine "自动识别到 $count 个 MCHOSE HUB 目录，非交互模式选用：$($chosen.AppDir)（来源：$($chosen.Source)$state）"
      $others = @($sorted | Select-Object -Skip 1 | ForEach-Object { $_.AppDir })
      if ($others.Count -gt 0) { Write-MhubLine "其余候选未使用：$($others -join "；")" }
      return $chosen.AppDir
    }
    Write-MhubLine "自动识别到 $count 个 MCHOSE HUB 目录，请输入要操作的序号（10 秒无输入默认 1）："
    for ($i = 0; $i -lt $count; $i++) {
      $c = $sorted[$i]
      $run = "否"
      if ($c.Running) { $run = "是" }
      $ver = "未知"
      if ($c.Version) { $ver = $c.Version }
      Write-Host ("  [{0}] {1}" -f ($i + 1), $c.AppDir)
      Write-Host ("      来源：{0}    正在运行：{1}    版本：{2}" -f $c.Source, $run, $ver)
    }
    for ($attempt = 0; $attempt -lt 2; $attempt++) {
      Write-Host ("请输入序号 [1-{0}]（10 秒无输入默认 1）： " -f $count) -NoNewline
      $line = Read-MhubLine -TimeoutSeconds 10
      if ($null -eq $line) {
        Write-MhubLine "等待超时，默认使用 [1] $($sorted[0].AppDir)"
        return $sorted[0].AppDir
      }
      $line = $line.Trim()
      if (-not $line) { return $sorted[0].AppDir }
      $n = 0
      if ([int]::TryParse($line, [ref]$n)) {
        if ($n -ge 1 -and $n -le $count) { return $sorted[$n - 1].AppDir }
      }
      if ($attempt -eq 0) { Write-MhubLine "输入无效（需要 1 到 $count 之间的序号），请重试一次" }
    }
    throw "无法确定宿主目录：连续两次输入无效。请用 -AppDir 显式指定，例如 -AppDir ""$($sorted[0].AppDir)"""
  }

  # 0 个候选
  $hint = "已尝试的来源：运行中进程、注册表卸载项、默认安装路径（Program Files / Program Files (x86) / LOCALAPPDATA\Programs / ProgramData）、开始菜单快捷方式。"
  if (-not $interactive) {
    throw "没有识别到 MCHOSE HUB 安装目录（$hint）。请确认已安装 MCHOSE HUB，或用 -AppDir 显式指定安装目录。"
  }
  Write-MhubLine "没识别到 MCHOSE HUB 安装目录。请把 MCHOSE HUB 安装目录拖进来或粘贴路径后回车（直接回车取消）："
  for ($attempt = 0; $attempt -lt 2; $attempt++) {
    Write-Host "路径： " -NoNewline
    $line = Read-MhubLine -TimeoutSeconds 120
    if ($null -eq $line) { break }
    $line = $line.Trim()
    if ($line -match "^&\s*(.*)$") { $line = $Matches[1] }
    $line = $line.Trim().Trim([char]34).Trim()
    if (-not $line) { break }
    $why = ""
    if (Test-MhubAppDir -Path $line -Reason ([ref]$why)) {
      $resolved = ConvertTo-MhubKey $line
      Write-MhubLine "使用指定宿主目录：$resolved"
      return $resolved
    }
    if ($attempt -eq 0) { Write-MhubLine "这个路径不可用（$why），请再输入一次" }
  }
  throw "没有识别到 MCHOSE HUB 安装目录（$hint）。请确认已安装 MCHOSE HUB，或用 -AppDir 显式指定安装目录。"
}
