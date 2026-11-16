#requires -Version 5.1
param([int]$ParentProcessId,[int]$Seconds=0)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
try {
  Add-Type -Path (Join-Path $PSScriptRoot 'audio-reactive.cs')
  [LyricBridgeAudio.Loopback]::Run($ParentProcessId,$Seconds)
} catch {
  [Console]::WriteLine('{"t":"error","error":"output-analysis-unavailable"}')
  [Console]::Error.WriteLine($_.Exception.ToString())
  exit 1
}
