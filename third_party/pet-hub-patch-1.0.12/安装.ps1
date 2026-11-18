<#
  桌宠模块安装脚本（可重复执行）
  用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1 [-AppDir 'auto'|<MCHOSE HUB 安装目录>] [-NoRestart] [-DryRun] [-Yes]

  -AppDir 默认 'auto'：按 运行中进程 -> 注册表卸载表 -> 默认安装路径 -> 开始菜单快捷方式 自动识别
            宿主安装目录（识别逻辑在 scripts\detect-mhub.ps1）；识别到多个时列编号询问，10 秒无输入默认第 1 项。
  -Yes     非交互：多个候选直接取优先级最高的一个，需要提问的场景一律不提问。
  -DryRun  只打印计划：不停进程、不复制、不写文件，且不需要管理员权限。

  步骤：解析宿主目录 -> 校验入口结构（结构不符立刻中止，不改动任何文件）-> 停宿主（只停本次安装
        目录的进程）-> 备份原始入口（只做一次）-> 白名单式清理模块目录（凡不在本次 payload 内、
        且不在 backup\ 与 pets\ 保护前缀下的文件一律删除）-> 复制 payload（顺带解除
        Mark-of-the-Web）-> 幂等打入口补丁 -> 写装机清单 -> 文件自检。
  装机清单：<AppDir>\pet-hub-manifest.json（版本取自 payload 根 VERSION，含装机时间与文件清单，
            只作安装记录，陈旧文件清理不再依赖它）。
  失败也会把宿主重新拉起来（-NoRestart 除外），并打印入口备份与卸载脚本两条可恢复路径。
#>
[CmdletBinding()]
param(
  [string]$AppDir = 'auto',
  [switch]$NoRestart,
  [switch]$DryRun,
  [switch]$Yes
)

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ErrorActionPreference = 'Stop'

function Say($m) { Write-Host "[pet-hub] $m" }

# 宿主识别脚本只定义函数，dot-source 没有副作用
$detectScript = Join-Path $PSScriptRoot 'detect-mhub.ps1'
if (-not (Test-Path -LiteralPath $detectScript)) { throw "缺少宿主识别脚本：$detectScript（请重新解压完整安装包）" }
. $detectScript

# 宿主安装目录：'auto' 自动识别，或使用 -AppDir 指定的目录（-DryRun 与 -Yes 一律非交互）
$AppDir = Resolve-MhubAppDir -Requested $AppDir -NonInteractive:($Yes -or $DryRun)
Say "宿主安装目录：$AppDir"

# payload 根：分发包形态是 <脚本目录>\payload；仓库形态是脚本目录的父目录
$packaged = Test-Path -LiteralPath (Join-Path $PSScriptRoot 'payload')
if ($packaged) {
  $payloadRoot = Join-Path $PSScriptRoot 'payload'
} else {
  $payloadRoot = Split-Path -Parent $PSScriptRoot
}
if ($packaged) {
  Say "payload 根：$payloadRoot（分发包形态）"
} else {
  Say "payload 根：$payloadRoot（仓库形态）"
}

$appRoot = Join-Path $AppDir 'resources\app'
$entry = Join-Path $appRoot 'out\main\index.js'
$moduleDir = Join-Path $appRoot 'pet-hub'
$backupEntry = Join-Path $moduleDir 'backup\index.js.orig'
$manifestPath = Join-Path $AppDir 'pet-hub-manifest.json'
$hostExe = Join-Path $AppDir 'MCHOSE HUB.exe'
$archivePath = Join-Path $AppDir 'resources\app.asar'
$archiveMode = Test-Path -LiteralPath $archivePath -PathType Leaf
$wrapperPackage = Join-Path $appRoot 'package.json'
$archivePackage = $null
$archiveBackup = $archivePath + '.friend-original'
if ($archiveMode) {
  $archivePackage = Get-MhubArchivePackage $archivePath
  if ((Test-Path -LiteralPath $wrapperPackage) -and ((Get-Content -LiteralPath $wrapperPackage -Raw -Encoding UTF8 | ConvertFrom-Json).friendLoader -ne 1)) { throw 'resources\app 已有其他应用入口，未覆盖。' }
}
$hostNames = @('MCHOSE HUB', 'MCHOSE HUB Agent', 'MCHOSE HUB Notifier')
$version = '1.0.0'
function GetHostProcesses {
  @(Get-Process -Name $hostNames -ErrorAction SilentlyContinue | Where-Object {
    try { $_.Path -eq $hostExe } catch { $true }
  })
}

$versionFile = Join-Path $payloadRoot 'VERSION'
if (Test-Path -LiteralPath $versionFile) {
  $v = (Get-Content -LiteralPath $versionFile -Raw -Encoding UTF8).Trim()
  if ($v) { $version = $v }
} else {
  Say "警告：缺少 $versionFile，清单版本按 $version 记录"
}

# 装机 payload 排除：脚本、回归入口、文档、仓库元数据、调试备份图（历史遗留文件名，路径值勿改）都不进模块目录
$excludeNames = @('scripts', 'tests', 'docs', 'backup', '.gitignore')
if (-not $packaged) { $excludeNames += 'packaging' }
$excludeRel = @('renderer\pet\assets\pet-aby-atk-backup.webp')

# 待装清单（相对 payload 根）：复制与清单共用同一份，避免"装了什么"与"记了什么"不一致
$staged = New-Object 'System.Collections.Generic.List[string]'
Get-ChildItem -LiteralPath $payloadRoot -Recurse -File -Force | ForEach-Object {
  $rel = $_.FullName.Substring($payloadRoot.Length).TrimStart('\', '/')
  $parts = $rel -split '[\\/]'
  if ($excludeNames -contains $parts[0]) { return }
  if ($excludeRel -contains $rel) { return }
  $staged.Add($rel)
}
if ($staged.Count -eq 0) { throw "源目录没有可安装文件：$payloadRoot" }

# 入口结构校验放在所有写操作之前：结构不认识就一行都不改
if ($archiveMode) {
  $origEntry = (Get-MhubArchiveEntry $archivePath).Entry
} else {
  if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { throw "找不到入口：$entry（请确认 -AppDir 指向 MCHOSE HUB 安装目录）" }
  $origEntry = [System.IO.File]::ReadAllText($entry, (New-Object System.Text.UTF8Encoding($false)))
}
$missingRequires = New-Object 'System.Collections.Generic.List[string]'
if ($origEntry -notmatch 'bytecode-loader\.cjs') { $missingRequires.Add('bytecode-loader.cjs') }
if ($origEntry -notmatch 'index\.jsc') { $missingRequires.Add('index.jsc') }
if (-not $archiveMode -and $missingRequires.Count -gt 0) {
  Say "入口里缺失的 require：$($missingRequires -join ", ")"
  throw "不支持的宿主入口结构（$entry 里没有 bytecode-loader.cjs / index.jsc 的 require）。可能 MHUB 大版本变了，已中止，未改动任何文件。备份：$backupEntry"
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin -and -not $DryRun) { throw '需要管理员权限运行（安装目录在 Program Files 下）' }

$failure = $null
$stopped = $false
try {
  Say "安装 pet-hub v$version -> $moduleDir（$($staged.Count) 个文件）"

  if ($archiveMode -and -not $DryRun) {
    if ($origEntry -notmatch 'pet-hub/index\.js|pet-hub.*index\.js') { Copy-Item -LiteralPath $archivePath -Destination $archiveBackup -Force }
    elseif (-not (Test-Path -LiteralPath $archiveBackup)) { throw '缺少官方 ASAR 备份，停止重复安装。' }
    elseif ((Test-Path -LiteralPath $manifestPath) -and ((Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json).archiveInstalledHash -ne (Get-MhubFileHash $archivePath))) { throw '宿主归档与安装记录不一致，未用旧原包覆盖。' }
    # Always rebuild from the saved official archive; repeated installs never grow the archive.
    $origEntry = (Get-MhubArchiveEntry $archiveBackup).Entry
  }

  if ($DryRun) {
    Say "[dry-run] 停止宿主进程（只停 $hostExe 的进程）"
  } else {
    $procs = GetHostProcesses
    if ($procs.Count -gt 0) {
      Say "停止 MCHOSE HUB 进程（$($procs.Count) 个）"
      $procs | Stop-Process -Force -ErrorAction SilentlyContinue
      $stopped = $true
      Start-Sleep -Milliseconds 1200
    }
  }

  # 备份只做一次：入口已含 pet-hub 说明被改过，不能当成原始入口
  if (-not $archiveMode -and -not (Test-Path -LiteralPath $backupEntry)) {
    if ($origEntry -match 'pet-hub') {
      $plainLines = @($origEntry -split '\r\n|\n' | Where-Object { $_ -notmatch 'pet-hub/index\.js' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
      $knownLines = @('"use strict";', 'require("./bytecode-loader.cjs");', 'require("./index.jsc");')
      if (($plainLines -join "`n") -eq ($knownLines -join "`n")) {
        if (-not $DryRun) { New-Item -ItemType Directory -Force -Path (Split-Path -Parent $backupEntry) | Out-Null; [IO.File]::WriteAllText($backupEntry,($plainLines -join "`r`n")+"`r`n",[Text.UTF8Encoding]::new($false)) }
        Say '已识别升级后沿用的入口标记，保存经过校验的官方三行入口备份'
      } else { Say '警告：入口已含 pet-hub 但无法确认原始结构，跳过推断备份。' }
    } elseif ($DryRun) {
      Say "[dry-run] 备份入口 -> $backupEntry"
    } else {
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $backupEntry) | Out-Null
      Copy-Item $entry $backupEntry -Force
      Say "已备份原始入口 -> $backupEntry"
    }
  }

  # 白名单式清理：装完后遍历模块目录，凡不在本次 $staged 内、又不在受保护前缀下的文件一律删除。
  # backup\ 是卸载还原点（$backupEntry，且 backup 从不进 staged），pets\ 是用户导入宠物的落点
  # （lib\pets.js defaultPetsDir()），两者一律不删。
  $protectedPrefixes = @('backup\', 'pets\')
  $newSet = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($rel in $staged) { [void]$newSet.Add($rel) }
  $stale = New-Object 'System.Collections.Generic.List[string]'
  # 模块目录可能以 8.3 短名传入（如 C:\PROGRA~1\...），Get-ChildItem 返回的是长名：先取规范根再算相对路径
  $moduleRoot = $moduleDir
  if (Test-Path -LiteralPath $moduleDir) { $moduleRoot = (Get-Item -LiteralPath $moduleDir).FullName }
  if (Test-Path -LiteralPath $moduleRoot) {
    foreach ($item in @(Get-ChildItem -LiteralPath $moduleRoot -Recurse -File -Force -ErrorAction SilentlyContinue)) {
      if (-not $item.FullName.StartsWith($moduleRoot, [StringComparison]::OrdinalIgnoreCase)) { continue }
      $rel = $item.FullName.Substring($moduleRoot.Length).TrimStart('\', '/')
      if ($newSet.Contains($rel)) { continue }
      $keep = $false
      foreach ($prefix in $protectedPrefixes) {
        if ($rel.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { $keep = $true; break }
      }
      if ($keep) { continue }
      $stale.Add($rel)
    }
  }
  $staleFailed = 0
  foreach ($rel in $stale) {
    if ($DryRun) { Say "[dry-run] 将删除 $rel"; continue }
    try {
      Remove-Item -LiteralPath (Join-Path $moduleRoot $rel) -Force -ErrorAction Stop
      Say "已删除陈旧文件 $rel"
    } catch {
      $staleFailed++
      Say "警告：删除失败 $rel（$($_.Exception.Message)），继续安装"
    }
  }
  if ($DryRun) {
    Say "[dry-run] 待删陈旧文件 $($stale.Count) 个（不在本次 $($staged.Count) 个文件内，且不含 backup\ 与 pets\）"
  } else {
    Say "陈旧文件清理：待删 $($stale.Count) 个，失败 $staleFailed 个"
  }

  # pets\ 下已经存在的文件一律保留：那里是用户数据（导入的宠物、改过的名字与立绘），升级不覆盖
  $petKeep = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  $deletedPetFiles = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  $deletedPetDirs = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  $recycleRoot = Join-Path $moduleDir 'pets\.trash'
  foreach ($record in @(Get-ChildItem -LiteralPath $recycleRoot -Filter record.json -Recurse -File -ErrorAction SilentlyContinue)) {
    try { $data = Get-Content -LiteralPath $record.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($data.dirName -match '^[A-Za-z0-9_-]{1,32}$' -and -not (Test-Path -LiteralPath (Join-Path $moduleDir ('pets\' + $data.dirName)))) { [void]$deletedPetDirs.Add([string]$data.dirName) }
    } catch { }
  }
  foreach ($rel in $staged) {
    if (-not $rel.StartsWith('pets\', [StringComparison]::OrdinalIgnoreCase)) { continue }
    $petName = ($rel -split '\\')[1]
    if ($deletedPetDirs.Contains($petName)) { [void]$petKeep.Add($rel); [void]$deletedPetFiles.Add($rel); continue }
    if (Test-Path -LiteralPath (Join-Path $moduleDir $rel) -PathType Leaf) { [void]$petKeep.Add($rel) }
  }

  if ($DryRun) {
    Say "[dry-run] 复制 payload -> $moduleDir（排除 $($excludeNames -join ", ")）"
    if ($petKeep.Count -gt 0) { Say "[dry-run] 保留已有宠物数据 $($petKeep.Count) 个文件（pets\ 不覆盖）" }
  } else {
    if (-not (Test-Path -LiteralPath $moduleDir)) { New-Item -ItemType Directory -Force -Path $moduleDir | Out-Null }
    foreach ($rel in $staged) {
      if ($petKeep.Contains($rel)) { continue }
      $destFile = Join-Path $moduleDir $rel
      $destParent = Split-Path -Parent $destFile
      if (-not (Test-Path -LiteralPath $destParent)) { New-Item -ItemType Directory -Force -Path $destParent | Out-Null }
      Copy-Item (Join-Path $payloadRoot $rel) $destFile -Force
      # 从网上下载的包裹进 Program Files 后仍带 Mark-of-the-Web，顺手解除
      try { Unblock-File -LiteralPath $destFile -ErrorAction SilentlyContinue } catch { }
    }
    Say "已复制 $($staged.Count - $petKeep.Count) 个文件"
    if ($petKeep.Count -gt 0) { Say "保留已有宠物数据 $($petKeep.Count) 个文件（pets\ 不覆盖）" }

    # 陈旧文件删完留下的空目录（保留模块目录本身，跳过 backup\ 与 pets\ 保护前缀）
    Get-ChildItem -LiteralPath $moduleRoot -Recurse -Directory -Force -ErrorAction SilentlyContinue |
      Sort-Object { $_.FullName.Length } -Descending |
      ForEach-Object {
        if ($_.FullName -eq $moduleRoot) { return }
        if (-not $_.FullName.StartsWith($moduleRoot, [StringComparison]::OrdinalIgnoreCase)) { return }
        $relDir = $_.FullName.Substring($moduleRoot.Length).TrimStart('\', '/')
        $keepDir = $false
        foreach ($prefix in $protectedPrefixes) {
          if ($relDir.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { $keepDir = $true; break }
        }
        if ($keepDir) { return }
        if (@(Get-ChildItem -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue).Count -eq 0) {
          Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
        }
      }
  }

  # 入口补丁：保留原有行、保留 "use strict" 在首行，只插入一行 require；重复执行字节不变
  $injectLine = @'
try { require("../../pet-hub/index.js"); } catch (e) { try { const p = require("path").join(process.env.APPDATA || ".", "MCHOSEHUB"); require("fs").mkdirSync(p, { recursive: true }); require("fs").appendFileSync(require("path").join(p, "pet-hub.log"), new Date().toISOString() + " ENTRY FAIL " + (e && e.stack) + "\n"); } catch (_) {} }
'@
  $injectLine = $injectLine.TrimEnd([char[]]@([char]13, [char]10))
  if ($archiveMode) { $injectLine = $injectLine.Replace('require("../../pet-hub/index.js")','require(require("path").join(process.resourcesPath,"app/pet-hub/index.js"))') }

  # 行尾风格沿用原文（以 CRLF 为主就用 CRLF）
  $eol = [string][char]10
  $crlfCount = ([regex]::Matches($origEntry, '\r\n')).Count
  $lfCount = ([regex]::Matches($origEntry, '(?<!\r)\n')).Count
  if ($crlfCount -gt 0 -and $crlfCount -ge $lfCount) { $eol = [string][char]13 + [string][char]10 }
  $hadTrailingNewline = $origEntry.EndsWith([string][char]10)
  $origLines = @($origEntry -split '\r\n|\n')
  if ($origLines.Count -gt 0 -and $origLines[$origLines.Count - 1] -eq '') {
    if ($origLines.Count -eq 1) { $origLines = @() } else { $origLines = @($origLines[0..($origLines.Count - 2)]) }
  }
  # 幂等：先删掉任何已含 pet-hub/index.js 的行，再统一插入一行
  $kept = @($origLines | Where-Object { $_ -notmatch 'pet-hub/index\.js' })
  $firstNonEmpty = -1
  for ($i = 0; $i -lt $kept.Count; $i++) { if ($kept[$i].Trim()) { $firstNonEmpty = $i; break } }
  $strictPattern = '^\s*[''"]use strict[''"];?\s*$'
  $newLines = New-Object 'System.Collections.Generic.List[string]'
  if ($firstNonEmpty -ge 0 -and ($kept[$firstNonEmpty] -match $strictPattern)) {
    $newLines.Add($kept[$firstNonEmpty])
    $newLines.Add($injectLine)
    for ($i = 0; $i -lt $kept.Count; $i++) { if ($i -ne $firstNonEmpty) { $newLines.Add($kept[$i]) } }
  } else {
    $newLines.Add($injectLine)
    foreach ($l in $kept) { $newLines.Add($l) }
  }
  $newEntry = ($newLines -join $eol)
  if ($hadTrailingNewline) { $newEntry = $newEntry + $eol }

  if ($DryRun) {
    $eolName = 'LF'
    if ($eol.Length -eq 2) { $eolName = 'CRLF' }
    Say "[dry-run] 写入口补丁 -> $entry（保留 use strict、恰好 1 行注入、行尾 $eolName）"
  } else {
    if ($archiveMode) {
      Copy-Item -LiteralPath $archiveBackup -Destination $archivePath -Force
      Set-MhubArchiveEntry $archivePath $newEntry
      # Retire the external-loader draft only when it carries our ownership marker.
      if ((Test-Path -LiteralPath $wrapperPackage) -and ((Get-Content -LiteralPath $wrapperPackage -Raw -Encoding UTF8 | ConvertFrom-Json).friendLoader -eq 1)) { Remove-Item -LiteralPath $wrapperPackage -Force; if (Test-Path -LiteralPath $entry) { Remove-Item -LiteralPath $entry -Force } }
    } else { [System.IO.File]::WriteAllText($entry, $newEntry, (New-Object System.Text.UTF8Encoding($false))) }
    # 写完回读断言：注入标记恰好 1 处，两个 require 都还在
    $written = $(if ($archiveMode) { (Get-MhubArchiveEntry $archivePath).Entry } else { [System.IO.File]::ReadAllText($entry, (New-Object System.Text.UTF8Encoding($false))) })
    $markCount = ([regex]::Matches($written, [regex]::Escape('pet-hub/index.js'))).Count
    $hasLoader = $written -match 'bytecode-loader\.cjs'
    $hasJsc = $written -match 'index\.jsc'
    if ($markCount -ne 1 -or (-not $archiveMode -and (-not $hasLoader -or -not $hasJsc))) {
      throw "入口补丁校验失败（注入标记 $markCount 处、bytecode-loader.cjs=$hasLoader、index.jsc=$hasJsc）：$entry。可用备份还原：$backupEntry"
    }
    Say "入口补丁已写入并校验（无 BOM，注入标记 1 处）"
  }

  $manifest = [ordered]@{
    name = 'pet-hub'
    version = $version
    hostLayout = $(if ($archiveMode) { 'asar-entry-v1' } else { 'unpacked-v1' })
    archiveInstalledHash = $(if ($archiveMode -and -not $DryRun) { Get-MhubFileHash $archivePath } else { '' })
    installedAt = (Get-Date).ToString('o')
    appDir = $AppDir
    moduleDir = $moduleDir
    entry = $entry
    excluded = (@($excludeNames) + @($excludeRel))
    files = @($staged | Where-Object { -not $deletedPetFiles.Contains($_) } | Sort-Object)
    build = $(if (Test-Path -LiteralPath (Join-Path $payloadRoot 'BUILD.json')) { (Get-Content -LiteralPath (Join-Path $payloadRoot 'BUILD.json') -Raw -Encoding UTF8 | ConvertFrom-Json).build } else { '' })
  }
  if ($DryRun) {
    Say "[dry-run] 写装机清单 -> $manifestPath"
  } else {
    $json = ($manifest | ConvertTo-Json -Depth 5) + [Environment]::NewLine
    [System.IO.File]::WriteAllText($manifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))
    Say "装机清单已写入 -> $manifestPath（v$version，$($staged.Count) 个文件）"
  }

  $need = @(
    'pet-hub\VERSION',
    'pet-hub\index.js',
    'pet-hub\shared\actions.js',
    'pet-hub\lib\ipc.js',
    'pet-hub\lib\config.js',
    'pet-hub\lib\pets.js',
    'pet-hub\lib\pet-window.js',
    'pet-hub\lib\page-view.js',
    'pet-hub\renderer\pet\index.html',
    'pet-hub\renderer\pet\pet.js',
    'pet-hub\renderer\settings\index.html',
    'pet-hub\renderer\settings\settings.js'
  )
  foreach ($petDir in @(Get-ChildItem (Join-Path $payloadRoot 'pets') -Directory -Force -ErrorAction SilentlyContinue)) {
    if ($deletedPetDirs.Contains($petDir.Name)) { continue }
    $need += "pet-hub\pets\$($petDir.Name)\pet.json"
  }
  if (@($need | Where-Object { $_ -match '\\pets\\' }).Count -eq 0) { Say '警告：源目录 pets 下没有宠物包' }
  if ($DryRun) {
    Say "[dry-run] 文件自检 $($need.Count) 项"
  } else {
    $missing = @($need | Where-Object { -not (Test-Path (Join-Path $appRoot $_)) })
    if ($missing.Count -gt 0) { throw "安装不完整，缺少：$($missing -join ', ')" }
    Say "文件自检通过（$($need.Count) 项）"
  }
} catch {
  $failure = $_
} finally {
  # 装坏了也得把宿主拉起来，否则 App 一直关着、用户看不到任何提示
  if ($stopped -and -not $NoRestart -and -not $DryRun) {
    if (Test-Path -LiteralPath $hostExe) {
      Say '启动 MCHOSE HUB'
      # 提权上下文里直接 Start-Process 会被宿主静默丢弃（退出码 0、不写日志），
      # 因此一律交给 Explorer（普通权限、交互式会话）拉起，再轮询确认进程真的出现
      $launched = $false
      try {
        Start-Process -FilePath 'explorer.exe' -ArgumentList ('"' + $hostExe + '"') -ErrorAction Stop
        for ($i = 0; $i -lt 24; $i++) {
          Start-Sleep -Milliseconds 500
          if ((GetHostProcesses).Count -gt 0) { $launched = $true; break }
        }
      } catch {
        Say "警告：自动启动失败（$($_.Exception.Message)）"
      }
      if ($launched) { Say '宿主已重新启动' } else { Say "警告：没能确认宿主已启动，请手动双击 $hostExe" }
    } else {
      Say "警告：找不到 $hostExe，请手动启动宿主"
    }
  }
}
if ($failure) {
  Say "安装失败：$($failure.Exception.Message)"
  Say "入口备份：$backupEntry"
  Say "完全还原：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall.ps1 -AppDir '$AppDir'"
  exit 1
}
  Say '完成：托盘菜单「Friend」或 Ctrl+Alt+P 显示 Friend，Ctrl+Alt+O 打开设置'
