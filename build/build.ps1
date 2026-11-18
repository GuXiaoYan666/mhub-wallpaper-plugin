param([string]$ReleaseVersion = '')

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$work = Join-Path $env:TEMP ("mhub-wallpaper-build-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$stage = Join-Path $work 'payload-stage'
$dist = Join-Path $root 'dist'
$zip = Join-Path $work 'payload.zip'
$installer = Join-Path $root 'src\installer\Installer.cs'
$installerUi = Join-Path $root 'src\installer\InstallerUi.cs'
$manifest = Join-Path $root 'src\installer\app.manifest'
$webWallGlRoot = Join-Path $root 'src\payload\wallpaper-hub\vendor\webwallgl'
$webWallGlExpectedHash = 'EE2FBE9A4D15A9ECCA837C08A76B90D8C3D98DD2619976929890C9F51DE2FF9C'
$petRoot = Join-Path $root 'third_party\pet-hub-patch-1.0.12'
$petManifestName = (-join ([char]0x7248, [char]0x672C, [char]0x4FE1, [char]0x606F)) + '.json'
$petManifestPath = Join-Path $petRoot $petManifestName

foreach ($name in @('webwallgl.global.min.js', 'LICENSE', 'package.json')) {
    $file = Join-Path $webWallGlRoot $name
    if (-not (Test-Path $file -PathType Leaf)) {
        throw "Required offline WebWallGL file is missing: $file"
    }
}
$webWallGlActualHash = (Get-FileHash (Join-Path $webWallGlRoot 'webwallgl.global.min.js') -Algorithm SHA256).Hash
if ($webWallGlActualHash -ne $webWallGlExpectedHash) {
    throw "WebWallGL SHA256 mismatch. Expected $webWallGlExpectedHash, got $webWallGlActualHash"
}

if (-not (Test-Path $petManifestPath -PathType Leaf)) {
    throw "Pinned pet-hub manifest is missing: $petManifestPath"
}
$petManifest = Get-Content -Raw -LiteralPath $petManifestPath | ConvertFrom-Json
if ($petManifest.name -ne 'pet-hub' -or $petManifest.version -ne '1.0.12') {
    throw "Unexpected pet package: $($petManifest.name) $($petManifest.version)"
}
foreach ($entry in $petManifest.files) {
    $file = Join-Path $petRoot $entry.path
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        throw "Pinned pet-hub file is missing: $($entry.path)"
    }
    $item = Get-Item -LiteralPath $file
    if ($item.Length -ne [int64]$entry.bytes) {
        throw "pet-hub byte count mismatch: $($entry.path)"
    }
    $actualHash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
    if ($actualHash -ne ([string]$entry.sha256).ToUpperInvariant()) {
        throw "pet-hub SHA256 mismatch: $($entry.path)"
    }
}
$petPayloadRoot = Join-Path $petRoot 'payload'
$petPayloadFiles = @(Get-ChildItem -LiteralPath $petPayloadRoot -Recurse -File)
$petPayloadEntries = @($petManifest.files | Where-Object { $_.path -like 'payload/*' })
if ($petPayloadFiles.Count -ne 61 -or $petPayloadEntries.Count -ne [int]$petManifest.payload.fileCount) {
    throw 'pet-hub payload file count mismatch'
}
$petPayloadBytes = ($petPayloadFiles | Measure-Object Length -Sum).Sum
if ($petPayloadBytes -ne [int64]$petManifest.payload.bytes) {
    throw 'pet-hub payload byte count mismatch'
}
$petIndexHash = (Get-FileHash -LiteralPath (Join-Path $petPayloadRoot 'index.js') -Algorithm SHA256).Hash
if ($petIndexHash -ne 'A2D311D4C7856194344A878445230147D1BE9ED7B88364642E6EAFC8AC7B5D20') {
    throw 'pet-hub payload/index.js SHA256 mismatch'
}

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
foreach ($name in @('bootstrap', 'renderer', 'wallpaper-hub')) {
    Copy-Item (Join-Path $root "src\payload\$name") (Join-Path $stage $name) -Recurse -Force
}
Copy-Item (Join-Path $petRoot 'payload') (Join-Path $stage 'pet-hub') -Recurse -Force
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
    $installer,
    $installerUi
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
