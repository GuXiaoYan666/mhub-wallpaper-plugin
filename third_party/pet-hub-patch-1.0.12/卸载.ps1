<#
  桌宠模块卸载脚本：还原入口、删除 pet-hub 目录与装机清单（默认保留用户数据 pet-hub.json）
  用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall.ps1 [-AppDir 'auto'|<MCHOSE HUB 安装目录>] [-PurgeData]

  -AppDir 默认 'auto'：按 运行中进程 -> 注册表卸载表 -> 默认安装路径 -> 开始菜单快捷方式 自动识别
            宿主安装目录（识别逻辑在 scripts\detect-mhub.ps1）；识别到多个时列编号询问，10 秒无输入默认第 1 项。

  安全约束（与 install.ps1 一致）：入口文件必须存在，未以管理员运行直接报错；入口必须含 pet-hub
  注入标记才允许改写，否则报错退出，避免把官方更新后的干净入口覆盖掉。
  -PurgeData 额外清理用户数据与 hd-cache 高清图集缓存（上限 96MB）。
#>
[CmdletBinding()]
param(
  [string]$AppDir = 'auto',
  [switch]$PurgeData
)

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ErrorActionPreference = 'Stop'

function Say($m) { Write-Host "[pet-hub] $m" }

# 宿主识别脚本只定义函数，dot-source 没有副作用
$detectScript = Join-Path $PSScriptRoot 'detect-mhub.ps1'
if (-not (Test-Path -LiteralPath $detectScript)) { throw "缺少宿主识别脚本：$detectScript（请重新解压完整安装包）" }
. $detectScript

# 宿主安装目录：'auto' 自动识别，或使用 -AppDir 指定的目录
$AppDir = Resolve-MhubAppDir -Requested $AppDir
Say "宿主安装目录：$AppDir"

$appRoot = Join-Path $AppDir 'resources\app'
$entry = Join-Path $appRoot 'out\main\index.js'
$moduleDir = Join-Path $appRoot 'pet-hub'
$backupEntry = Join-Path $moduleDir 'backup\index.js.orig'
$manifestPath = Join-Path $AppDir 'pet-hub-manifest.json'
$hostExe = Join-Path $AppDir 'MCHOSE HUB.exe'
$hostNames = @('MCHOSE HUB', 'MCHOSE HUB Agent', 'MCHOSE HUB Notifier')
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw '需要管理员权限运行（安装目录在 Program Files 下）' }

$archivePath = Join-Path $AppDir 'resources\app.asar'
if (Test-Path -LiteralPath $archivePath) {
  $archiveBackup = $archivePath + '.friend-original'
  $archiveEntry = (Get-MhubArchiveEntry $archivePath).Entry
  if ($archiveEntry -notmatch 'pet-hub/index\.js') { Say '官方归档没有 Friend 入口，无需还原。'; exit 0 }
  if (-not (Test-Path -LiteralPath $archiveBackup) -or -not (Test-Path -LiteralPath $manifestPath)) { throw '缺少安装记录或官方备份，未改动归档。' }
  $installed = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($installed.archiveInstalledHash -ne (Get-MhubFileHash $archivePath)) { throw '宿主归档已变化，未用旧备份覆盖，请重新安装插件后再卸载。' }
  Get-Process -Name $hostNames -ErrorAction SilentlyContinue | Where-Object { try { $_.Path -eq $hostExe } catch { $false } } | Stop-Process -Force
  Start-Sleep -Milliseconds 800
  Copy-Item -LiteralPath $archiveBackup -Destination $archivePath -Force
  Remove-Item -LiteralPath $manifestPath -Force
  Say '官方归档已完整还原，Friend 素材与配置保留，重装可恢复。'
  exit 0
}

if (-not (Test-Path $entry)) { throw "找不到入口：$entry" }
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw '需要管理员权限运行（安装目录在 Program Files 下）' }

# 只有被我们改过的入口才允许还原，否则官方新版入口会被踩掉
if ((Get-Content $entry -Raw -Encoding UTF8) -notmatch 'pet-hub') {
  if (-not (Test-Path $moduleDir)) { Say '入口不含 pet-hub 注入标记，模块目录也不存在：当前已是干净状态'; exit 0 }
  throw "入口不含 pet-hub 注入标记，已中止未改写：$entry（模块目录仍在 $moduleDir，请人工核对）"
}

$procs = @(Get-Process -Name $hostNames -ErrorAction SilentlyContinue | Where-Object {
  try { $_.Path -eq $hostExe } catch { $true }
})
if ($procs.Count -gt 0) {
  Say "停止 MCHOSE HUB 进程（$($procs.Count) 个）"
  $procs | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 1200
}

$archiveLoader = (Test-Path -LiteralPath (Join-Path $AppDir 'resources\app.asar')) -and (Test-Path -LiteralPath (Join-Path $appRoot 'package.json')) -and ((Get-Content -LiteralPath (Join-Path $appRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).friendLoader -eq 1)
if ($archiveLoader) {
  Remove-Item -LiteralPath $entry -Force
  Remove-Item -LiteralPath (Join-Path $appRoot 'package.json') -Force
  if (Test-Path -LiteralPath $manifestPath) { Remove-Item -LiteralPath $manifestPath -Force }
  Say '外置入口已移除，官方 app.asar 保持原样；Friend 素材保留，重装可恢复。'
  exit 0
} elseif (Test-Path $backupEntry) {
  Copy-Item $backupEntry $entry -Force
  Say '入口已从备份还原'
} else {
  $pristine = @'
"use strict";
require("./bytecode-loader.cjs");
require("./index.jsc");
'@
  [System.IO.File]::WriteAllText($entry, $pristine, (New-Object System.Text.UTF8Encoding($false)))
  Say '未找到备份，已写入原始三行入口'
}
if (Test-Path $moduleDir) { Remove-Item $moduleDir -Recurse -Force; Say '模块目录已删除' }
if (Test-Path $manifestPath) { Remove-Item $manifestPath -Force; Say '装机清单已删除' }

if ($PurgeData) {
  $dataDir = Join-Path $env:APPDATA 'MCHOSEHUB'
  foreach ($f in @('pet-hub.json', 'pet-hub.log', 'pet-hub.old.log')) {
    $p = Join-Path $dataDir $f
    if (Test-Path $p) { Remove-Item $p -Force; Say "已删除 $f" }
  }
  # 高清图集缓存：<userData>\hd-cache（lib/hd-cache.js 的 DIR_NAME，LRU 3 条 / 96MB 上限）
  $hdCache = Join-Path $dataDir 'hd-cache'
  if (Test-Path $hdCache) { Remove-Item $hdCache -Recurse -Force; Say '已删除 hd-cache 目录（高清图集缓存）' }
}
Say '卸载完成'
