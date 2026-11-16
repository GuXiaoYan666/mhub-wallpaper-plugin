param([string]$ReleaseVersion = '')

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$work = Join-Path $env:TEMP ("mhub-wallpaper-build-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$stage = Join-Path $work 'payload-stage'
$dist = Join-Path $root 'dist'
$zip = Join-Path $work 'payload.zip'
$installer = Join-Path $root 'src\installer\Installer.cs'
$manifest = Join-Path $root 'src\installer\app.manifest'

$version = 'dev'
if ($ReleaseVersion) {
    $version = $ReleaseVersion.TrimStart('v')
} elseif ($env:MHUB_VERSION) {
    $version = $env:MHUB_VERSION.TrimStart('v')
} else {
    try {
        $tag = (git -C $root describe --tags --abbrev=0 2>$null)
        if ($tag) { $version = $tag.TrimStart('v') }
    } catch { }
}
$out = Join-Path $dist ("M-HUB-Wallpaper-Startup-Plugin-" + $version + ".exe")

Write-Host "[1/4] Stage payload (version $version)"
New-Item -ItemType Directory -Path $stage -Force | Out-Null
Copy-Item (Join-Path $root 'src\payload\*') $stage -Recurse -Force
foreach ($name in @('lyric-bridge', 'sysdeck')) {
    $src = Join-Path $root "src\plugins\$name"
    if (Test-Path $src) {
        Copy-Item $src (Join-Path $stage $name) -Recurse -Force
    }
}

Write-Host '[2/4] Pack payload.zip'
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip, [System.IO.Compression.CompressionLevel]::Optimal, $false)

Write-Host '[3/4] Compile installer'
if (-not (Test-Path $dist)) { New-Item -ItemType Directory -Path $dist -Force | Out-Null }
if (Test-Path $out) {
    $out = Join-Path $dist ("M-HUB-Wallpaper-Startup-Plugin-" + $version + "-" + (Get-Date -Format 'HHmmss') + ".exe")
}

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) {
    $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if (-not (Test-Path $csc)) {
    throw 'csc.exe not found. Please enable .NET Framework 4.x.'
}

$cscArgs = @(
    '/nologo',
    '/target:winexe',
    '/platform:anycpu',
    '/optimize+',
    "/win32manifest:$manifest",
    "/out:$out",
    "/resource:$zip,payload.zip",
    '/reference:System.dll',
    '/reference:System.Core.dll',
    '/reference:System.Drawing.dll',
    '/reference:System.Windows.Forms.dll',
    '/reference:System.IO.Compression.dll',
    '/reference:System.IO.Compression.FileSystem.dll',
    $installer
)
& $csc $cscArgs
if ($LASTEXITCODE -ne 0) { throw "csc failed with exit code $LASTEXITCODE" }

Write-Host '[4/4] Done'
$file = Get-Item $out
$hash = (Get-FileHash $out -Algorithm SHA256).Hash.ToLower()
Write-Host ("Output: {0}" -f $file.FullName)
Write-Host ("Size:   {0} bytes" -f $file.Length)
Write-Host ("SHA256: {0}" -f $hash)
Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
