'use strict';
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const CFG = {
  scanTtlMs: 60000,
  runningTtlMs: 900,
  procTimeoutMs: 15000,
  iconTimeoutMs: 40000,
  focusTimeoutMs: 15000,
  spawnWaitMs: 5000,
  spawnPollMs: 250,
};
const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const STATE_DIR = path.join(APPDATA, 'MCHOSEHUB', 'lyric-bridge');
const ICON_DIR = path.join(STATE_DIR, 'cache', 'icons');
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const CATALOG = [
  {
    id: 'kugou',
    name: '酷狗音乐',
    match: /酷狗|kugou/i,
    proc: ['KuGou.exe'],
    exe: ['KuGou.exe'],
    paths: ['%ProgramFiles%\\KuGou\\KGMusic\\KuGou.exe', '%ProgramFiles(x86)%\\KuGou\\KGMusic\\KuGou.exe'],
  },
  {
    id: 'kuwo',
    name: '酷我音乐',
    match: /酷我|kuwo|kwmusic/i,
    proc: ['KwMusic.exe'],
    exe: ['KwMusic.exe'],
    paths: [
      '%ProgramFiles(x86)%\\Kuwo\\KwMusic\\KwMusic.exe',
      '%ProgramFiles%\\Kuwo\\KwMusic\\KwMusic.exe',
      '%ProgramFiles(x86)%\\KwMusic\\KwMusic.exe',
      '%ProgramFiles%\\KwMusic\\KwMusic.exe',
      '%LOCALAPPDATA%\\Kuwo\\KwMusic\\KwMusic.exe',
    ],
  },
  {
    id: 'qqmusic',
    name: 'QQ音乐',
    match: /qq音乐|qqmusic|tencent\s*music/i,
    proc: ['QQMusic.exe'],
    exe: ['QQMusic.exe'],
    paths: ['%ProgramFiles(x86)%\\Tencent\\QQMusic\\QQMusic.exe', '%ProgramFiles%\\Tencent\\QQMusic\\QQMusic.exe'],
  },
  {
    id: 'cloudmusic',
    name: '网易云音乐',
    match: /网易云|netease|cloudmusic/i,
    proc: ['cloudmusic.exe'],
    exe: ['cloudmusic.exe'],
    paths: [
      '%ProgramFiles%\\NetEase\\CloudMusic\\cloudmusic.exe',
      '%ProgramFiles(x86)%\\NetEase\\CloudMusic\\cloudmusic.exe',
      '%LOCALAPPDATA%\\NetEase\\CloudMusic\\cloudmusic.exe',
    ],
  },
  {
    id: 'sodamusic',
    name: '汽水音乐',
    match: /汽水|soda/i,
    proc: ['SodaMusic.exe', 'Soda Music.exe'],
    exe: ['SodaMusic.exe', 'Soda Music.exe'],
    launcher: ['SodaMusicLauncher.exe'],
    paths: ['%LOCALAPPDATA%\\Programs\\Soda Music\\SodaMusicLauncher.exe', '%LOCALAPPDATA%\\Programs\\Soda Music\\SodaMusic.exe'],
  },
  {
    id: 'lxmusic',
    name: '洛雪音乐助手',
    match: /洛雪|落雪|lx[- ]?music|lxmusic/i,
    proc: ['lx-music-desktop.exe'],
    exe: ['lx-music-desktop.exe'],
    paths: [
      '%LOCALAPPDATA%\\Programs\\lx-music-desktop\\lx-music-desktop.exe',
      '%ProgramFiles%\\lx-music-desktop\\lx-music-desktop.exe',
      '%ProgramFiles(x86)%\\lx-music-desktop\\lx-music-desktop.exe',
      '%LOCALAPPDATA%\\lx-music-desktop\\lx-music-desktop.exe',
    ],
  },
  {
    id: 'migu',
    name: '咪咕音乐',
    match: /咪咕|migu/i,
    proc: ['MiguMusic.exe'],
    exe: ['MiguMusic.exe'],
    paths: [
      '%ProgramFiles(x86)%\\MiguMusic\\MiguMusic.exe',
      '%ProgramFiles%\\MiguMusic\\MiguMusic.exe',
      '%LOCALAPPDATA%\\MiguMusic\\MiguMusic.exe',
    ],
  },
  {
    id: 'qianqian',
    name: '千千音乐',
    match: /千千|qianqian|百度音乐|baidu\s*music/i,
    proc: ['BaiduMusic.exe'],
    exe: ['BaiduMusic.exe'],
    paths: [
      '%ProgramFiles(x86)%\\Baidu\\BaiduMusic\\BaiduMusic.exe',
      '%ProgramFiles%\\Baidu\\BaiduMusic\\BaiduMusic.exe',
    ],
  },
  {
    id: 'spotify',
    name: 'Spotify',
    match: /spotify/i,
    proc: ['Spotify.exe'],
    exe: ['Spotify.exe'],
    paths: ['%APPDATA%\\Spotify\\Spotify.exe', '%LOCALAPPDATA%\\Spotify\\Spotify.exe'],
  },
  {
    id: 'applemusic',
    name: 'Apple Music',
    match: /apple\s*music/i,
    proc: ['AppleMusic.exe'],
    exe: ['AppleMusic.exe'],
    store: true,
  },
  {
    id: 'folia',
    name: 'Folia',
    match: /folia/i,
    proc: ['Folia.exe'],
    exe: ['Folia.exe'],
    paths: [
      '%ProgramFiles%\\Folia\\Folia.exe',
      '%ProgramFiles(x86)%\\Folia\\Folia.exe',
      '%LOCALAPPDATA%\\Programs\\Folia\\Folia.exe',
      '%LOCALAPPDATA%\\Folia\\Folia.exe',
    ],
  },
  {
    id: 'mineradio',
    name: 'Mineradio',
    match: /mineradio/i,
    proc: ['Mineradio.exe'],
    exe: ['Mineradio.exe'],
    paths: [
      '%LOCALAPPDATA%\\Programs\\Mineradio\\Mineradio.exe',
      '%LOCALAPPDATA%\\Mineradio\\Mineradio.exe',
      '%ProgramFiles%\\Mineradio\\Mineradio.exe',
      '%ProgramFiles(x86)%\\Mineradio\\Mineradio.exe',
      '%SystemDrive%\\Mineradio\\Mineradio.exe',
    ],
  },
  {
    id: 'bilibili',
    name: '哔哩哔哩',
    match: /bilibili|哔哩|b站/i,
    proc: ['哔哩哔哩.exe'],
    exe: ['哔哩哔哩.exe'],
    paths: [
      '%ProgramFiles%\\bilibili\\哔哩哔哩.exe',
      '%ProgramFiles(x86)%\\bilibili\\哔哩哔哩.exe',
      '%LOCALAPPDATA%\\Programs\\bilibili\\哔哩哔哩.exe',
      '%LOCALAPPDATA%\\bilibili\\哔哩哔哩.exe',
    ],
  },
];
const GENERIC_MUSIC_RE = /音乐|music player|apple\s*music|groove|spotify|foobar|aimp|musicbee|kuwo|酷我|洛雪|落雪|lxmusic|migu|咪咕|qianqian|千千/i;
const NOT_PLAYER_RE = /卸载|uninstall|driver|驱动|update|升级|sdk|codec|firmware|repaire|修复|运行库|runtime/i;
const INSTALLER_EXE_RE = /^(unins|uninstall|setup|install|update|upgrade)/i;
const PROC_SKIP_RE = /^(chrome|msedge|firefox|brave|opera|vivaldi|iexplore|webviewhost|mchose|electron|node|powershell|pwsh|conhost|cmd|explorer|rundll32|svchost|java|python|code)$/i;
const PROC_HELPER_RE = /(update|upgrade|helper|crash|report|service|setup|install|uninst|elevat|renderer|gpu|utility|cef|daemon|watchdog|launcher|proxy)/i;
const PROC_PLAYER_RE = /music|player|音乐|播放|apple\s*music|cloudmusic|kugou|kuwo|qqmusic|netease|soda|spotify|foobar|aimp|musicbee|groove|tidal|deezer|lx[-_ ]?music|migu|qianqian|baidumusic|bilibili|哔哩|folia|mineradio/i;
function E(code, message, details) {
  const error = { code, message };
  if (details && typeof details === 'object') error.details = details;
  return { ok: false, error };
}
function errMsg(e) {
  if (!e) return 'unknown error';
  return String((e && e.message) || e);
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function decodeBuffer(buf) {
  if (!buf || buf.length === 0) return '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch {
      return buf.toString('latin1');
    }
  }
}
function runFile(cmd, args, opts) {
  const timeout = (opts && opts.timeoutMs) || CFG.procTimeoutMs;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    let child;
    try {
      child = execFile(
        cmd,
        args,
        { timeout: timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'buffer' },
        (err, stdout, stderr) => {
          finish({
            ok: !err,
            code: err && typeof err.code === 'number' ? err.code : err ? -1 : 0,
            error: err ? errMsg(err) : null,
            stdout: decodeBuffer(stdout),
            stderr: decodeBuffer(stderr),
          });
        }
      );
    } catch (e) {
      finish({ ok: false, code: -1, error: errMsg(e), stdout: '', stderr: '' });
      return;
    }
    if (child && typeof child.on === 'function') {
      child.on('error', (e) => finish({ ok: false, code: -1, error: errMsg(e), stdout: '', stderr: '' }));
    }
  });
}
function runPowerShell(script, timeoutMs) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return runFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { timeoutMs: timeoutMs || CFG.procTimeoutMs }
  );
}
function psString(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}
function expandEnv(raw) {
  if (!raw) return raw;
  return String(raw)
    .replace(/%([^%]+)%/g, (m, name) => {
      const v = process.env[name] || process.env[name.toUpperCase()] || process.env[name.toLowerCase()];
      return v || m;
    })
    .trim();
}
function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\.exe$/, '')
    .replace(/[^a-z0-9]+/g, '');
}
function isPng(buf) {
  return Buffer.isBuffer(buf) && buf.length > 64 && buf.subarray(0, 4).equals(PNG_MAGIC);
}
async function statSafe(p) {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}
function fileExistsSync(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
function dirExistsSync(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
const UNINSTALL_ROOTS = [
  ['HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/reg:64'],
  ['HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/reg:32'],
  ['HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/reg:64'],
  ['HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/reg:32'],
];
function parseUninstallDump(text) {
  const entries = [];
  let cur = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    if (!raw) continue;
    if (/^HKEY_/i.test(raw)) {
      cur = { key: raw.trim(), DisplayName: '', InstallLocation: '', DisplayIcon: '', DisplayVersion: '' };
      entries.push(cur);
      continue;
    }
    if (!cur) continue;
    const m = /^ {4}(\S+)\s+(REG_[A-Z_]+)\s+(.*)$/.exec(raw);
    if (!m) continue;
    if (Object.prototype.hasOwnProperty.call(cur, m[1]) && !cur[m[1]]) cur[m[1]] = m[3].trim();
  }
  return entries.filter((e) => e.DisplayName);
}
async function readUninstallEntries() {
  const runs = await Promise.all(
    UNINSTALL_ROOTS.map((pair) => runFile('reg.exe', ['query', pair[0], '/s', pair[1]]))
  );
  const entries = [];
  const seen = new Set();
  let okCount = 0;
  for (const r of runs) {
    if (!r.ok && !r.stdout) continue;
    okCount += 1;
    for (const entry of parseUninstallDump(r.stdout)) {
      if (seen.has(entry.key)) continue;
      seen.add(entry.key);
      entries.push(entry);
    }
  }
  return { ok: okCount > 0, entries: entries, error: okCount > 0 ? null : (runs[0] && runs[0].error) || 'reg query failed' };
}
function stripIconValue(raw) {
  if (!raw) return null;
  let v = String(raw).trim();
  if (v.startsWith('"')) {
    const end = v.indexOf('"', 1);
    v = end > 0 ? v.slice(1, end) : v.slice(1);
  } else {
    const comma = v.lastIndexOf(',');
    if (comma > 0 && /^-?\d+$/.test(v.slice(comma + 1).trim())) v = v.slice(0, comma);
  }
  v = v.trim();
  return v || null;
}
function normalizeIconPath(raw) {
  const v = stripIconValue(raw);
  if (!v || !/\.exe$/i.test(v)) return null;
  return v;
}
const LNK_SCRIPT = [
  "$ProgressPreference = 'SilentlyContinue'",
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  '$shell = New-Object -ComObject WScript.Shell',
  '$dirs = @(',
  "  (Join-Path $env:ProgramData 'Microsoft\\Windows\\Start Menu\\Programs'),",
  "  (Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs')",
  ')',
  "$pattern = '酷狗|kugou|酷我|kuwo|qq音乐|qqmusic|网易云|netease|cloudmusic|汽水|soda|洛雪|落雪|lx[- ]?music|lxmusic|咪咕|migu|千千|qianqian|spotify|音乐|music'",
  'foreach ($dir in $dirs) {',
  '  if (-not (Test-Path -LiteralPath $dir)) { continue }',
  '  Get-ChildItem -LiteralPath $dir -Filter *.lnk -Recurse -ErrorAction SilentlyContinue | ForEach-Object {',
  '    if ($_.Name -notmatch $pattern) { return }',
  '    try {',
  '      $sc = $shell.CreateShortcut($_.FullName)',
  "      if ($sc -and $sc.TargetPath) { 'LNK|' + $_.Name + '|' + $sc.TargetPath }",
  '    } catch { }',
  '  }',
  '}',
].join('\n');
async function readStartMenuTargets() {
  const r = await runPowerShell(LNK_SCRIPT, 30000);
  const targets = [];
  for (const line of String(r.stdout || '').split(/\r?\n/)) {
    const m = /^LNK\|([^|]*)\|(.+)$/.exec(line.trim());
    if (!m) continue;
    const target = m[2].trim();
    if (!/\.exe$/i.test(target)) continue;
    targets.push({ name: m[1].replace(/\.lnk$/i, ''), exe: target });
  }
  return { ok: r.ok || targets.length > 0, targets: targets, error: r.ok ? null : r.error };
}
const APPX_SCRIPT = [
  "$ProgressPreference = 'SilentlyContinue'",
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  "Get-AppxPackage -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '(?i)apple.*music' } | ForEach-Object {",
  '  $package = $_',
  '  $manifest = $null',
  '  try { $manifest = Get-AppxPackageManifest -Package $package.PackageFullName -ErrorAction Stop } catch { }',
  '  if ($manifest) {',
  '    foreach ($app in @($manifest.Package.Applications.Application)) {',
  '      if (-not $app.Id) { continue }',
  "      'APPX:' + (@{",
  '        name=[string]$package.Name',
  '        packageFamilyName=[string]$package.PackageFamilyName',
  '        installLocation=[string]$package.InstallLocation',
  '        version=[string]$package.Version',
  '        appId=[string]$app.Id',
  '        executable=[string]$app.Executable',
  '      } | ConvertTo-Json -Compress)',
  '    }',
  '  }',
  '}',
].join('\n');
async function readAppxPackages() {
  const r = await runPowerShell(APPX_SCRIPT, 30000);
  const packages = [];
  for (const line of String(r.stdout || '').split(/\r?\n/)) {
    const text = line.trim();
    if (text.indexOf('APPX:') !== 0) continue;
    try {
      const entry = JSON.parse(text.slice(5));
      if (entry && entry.packageFamilyName && entry.appId) packages.push(entry);
    } catch {}
  }
  return { ok: r.ok || packages.length > 0, packages: packages, error: r.ok ? null : r.error };
}
function findInDir(dir, names, maxDepth) {
  const depthLimit = typeof maxDepth === 'number' ? maxDepth : 2;
  const queue = [{ dir: dir, depth: 0 }];
  const hits = [];
  while (queue.length) {
    const cur = queue.shift();
    if (cur.depth > depthLimit) continue;
    for (const name of names) {
      const candidate = path.join(cur.dir, name);
      if (fileExistsSync(candidate)) hits.push(candidate);
    }
    if (cur.depth === depthLimit) continue;
    let subdirs = [];
    try {
      subdirs = fs
        .readdirSync(cur.dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !/^packages?$/i.test(d.name))
        .map((d) => path.join(cur.dir, d.name));
    } catch {
      subdirs = [];
    }
    for (const sub of subdirs) queue.push({ dir: sub, depth: cur.depth + 1 });
  }
  return hits;
}
function specById(id) {
  return CATALOG.find((s) => s.id === id) || null;
}
function normalizeSessionId(value) {
  let key = String(value == null ? '' : value).trim().toLowerCase();
  const bang = key.lastIndexOf('!');
  if (bang >= 0) key = key.slice(bang + 1);
  key = key.split(/[\\/]/).pop();
  return slugify(key);
}
function sessionMatchesPlayer(sessionId, player) {
  const raw = String(sessionId || '').trim();
  if (!raw || !player) return false;
  const spec = specById(player.id);
  if (spec && spec.match.test(raw)) return true;
  const rawKey = raw.toLowerCase().replace(/\.exe$/, '');
  const rawExe = String(player.exe || '').toLowerCase().split(/[\\/]/).pop().replace(/\.exe$/, '');
  if (rawExe && (rawExe.indexOf(rawKey) >= 0 || rawKey.indexOf(rawExe) >= 0)) return true;
  const sessionKey = normalizeSessionId(raw);
  if (!sessionKey) return false;
  const aliases = [player.id, player.name, player.exe, player.packageFamilyName, player.appId];
  if (spec) aliases.push(...spec.proc, ...spec.exe);
  for (const alias of aliases) {
    if (!alias) continue;
    const aliasRaw = String(alias).trim();
    if (aliasRaw.toLowerCase() === raw.toLowerCase()) return true;
    const aliasKey = normalizeSessionId(aliasRaw);
    if (aliasKey && aliasKey === sessionKey) return true;
  }
  const exeKey = normalizeSessionId(player.exe);
  return !!exeKey && (exeKey.indexOf(sessionKey) >= 0 || sessionKey.indexOf(exeKey) >= 0);
}
function resolveExe(input) {
  const baseExe = input.baseExe;
  const installDir = input.installDir;
  const spec = input.spec;
  const exeNames = spec ? spec.exe || [] : [];
  const launcherNames = spec ? spec.launcher || [] : [];
  if (installDir && exeNames.length) {
    const hits = findInDir(installDir, exeNames, 2);
    if (hits.length) return { exe: hits[0], via: 'installDir' };
  }
  if (baseExe && fileExistsSync(baseExe)) {
    const base = path.basename(baseExe).toLowerCase();
    const isLauncher = launcherNames.some((n) => n.toLowerCase() === base);
    if (!isLauncher) return { exe: baseExe, via: 'displayIcon' };
  }
  if (installDir && launcherNames.length) {
    const hits = findInDir(installDir, launcherNames, 2);
    if (hits.length) return { exe: hits[0], via: 'launcher' };
  }
  if (baseExe && fileExistsSync(baseExe)) return { exe: baseExe, via: 'displayIcon' };
  return null;
}
function playerFromRegistryEntry(entry) {
  const displayName = entry.DisplayName || '';
  const iconValue = stripIconValue(entry.DisplayIcon);
  const iconExe = iconValue && /\.exe$/i.test(iconValue) ? iconValue : null;
  const installRaw = String(entry.InstallLocation || '').trim().replace(/^"|"$/g, '');
  const installDir = installRaw && dirExistsSync(installRaw) ? installRaw : null;
  const spec = CATALOG.find(
    (s) =>
      s.match.test(displayName) ||
      (iconExe && s.exe.some((n) => n.toLowerCase() === path.basename(iconExe).toLowerCase()))
  );
  if (NOT_PLAYER_RE.test(displayName)) return null;
  if (!spec && !GENERIC_MUSIC_RE.test(displayName)) return null;
  const baseDir = installDir || (iconValue ? path.dirname(iconValue) : null);
  const resolved = resolveExe({ baseExe: iconExe, installDir: baseDir, spec: spec });
  if (!resolved) return null;
  const exe = path.resolve(resolved.exe);
  if (INSTALLER_EXE_RE.test(path.basename(exe))) return null;
  return {
    id: spec ? spec.id : slugify(path.basename(exe)),
    name: spec ? spec.name : displayName,
    exe: exe,
    installDir: installDir || path.dirname(exe),
    version: entry.DisplayVersion || null,
    source: 'registry',
  };
}
function playerFromShortcut(target) {
  const exe = path.resolve(target.exe);
  if (!fileExistsSync(exe)) return null;
  const base = path.basename(exe);
  const spec = CATALOG.find(
    (s) =>
      s.exe.some((n) => n.toLowerCase() === base.toLowerCase()) ||
      s.match.test(target.name) ||
      s.match.test(base)
  );
  const resolved = resolveExe({ baseExe: exe, installDir: path.dirname(exe), spec: spec });
  if (!resolved) return null;
  const finalExe = path.resolve(resolved.exe);
  if (INSTALLER_EXE_RE.test(path.basename(finalExe))) return null;
  return {
    id: spec ? spec.id : slugify(path.basename(finalExe)),
    name: spec ? spec.name : target.name,
    exe: finalExe,
    installDir: path.dirname(finalExe),
    version: null,
    source: 'shortcut',
  };
}
function playerFromWhitelist(spec, rawPath) {
  const exe = expandEnv(rawPath);
  if (!fileExistsSync(exe)) return null;
  const resolved = resolveExe({ baseExe: exe, installDir: path.dirname(exe), spec: spec });
  if (!resolved) return null;
  return {
    id: spec.id,
    name: spec.name,
    exe: path.resolve(resolved.exe),
    installDir: path.resolve(path.dirname(exe)),
    version: null,
    source: 'whitelist',
  };
}
function playerFromStorePackage(entry) {
  if (!entry) return null;
  const packageFamilyName = String(entry.packageFamilyName || '').trim();
  const installDir = String(entry.installLocation || '').trim();
  const appId = String(entry.appId || '').trim();
  const declaredExe = String(entry.executable || '').trim();
  const spec = CATALOG.find(
    (s) => s.store && (s.match.test(String(entry.name || '')) || s.match.test(packageFamilyName))
  );
  if (!spec || !packageFamilyName || !installDir || !appId) return null;
  const appMatches =
    spec.match.test(appId) ||
    spec.exe.some((n) => n.toLowerCase() === path.basename(declaredExe).toLowerCase());
  if (!appMatches) return null;
  const exeName = declaredExe || spec.exe[0];
  return {
    id: spec.id,
    name: spec.name,
    exe: path.resolve(installDir, exeName),
    installDir: path.resolve(installDir),
    version: entry.version || null,
    source: 'store',
    packageFamilyName: packageFamilyName,
    appId: appId,
    launchTarget: 'shell:AppsFolder\\' + packageFamilyName + '!' + appId,
  };
}
let procCache = { at: 0, map: new Map(), ok: false, error: null };
function parseTasklist(text) {
  const map = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.startsWith('"')) continue;
    const parts = line.split('","');
    if (parts.length < 2) continue;
    const name = parts[0].replace(/^"/, '').toLowerCase();
    const pid = parseInt(parts[1], 10);
    if (!name || !Number.isFinite(pid)) continue;
    const list = map.get(name);
    if (list) list.push(pid);
    else map.set(name, [pid]);
  }
  return map;
}
async function snapshotProcesses(opts) {
  const force = !!(opts && opts.force);
  const now = Date.now();
  if (!force && procCache.at && now - procCache.at < CFG.runningTtlMs) return procCache;
  const r = await runFile('tasklist.exe', ['/fo', 'csv', '/nh']);
  if (!r.ok && !r.stdout) {
    procCache = { at: now, map: new Map(), ok: false, error: r.error || 'tasklist failed' };
    return procCache;
  }
  procCache = { at: Date.now(), map: parseTasklist(r.stdout), ok: true, error: null };
  return procCache;
}
function procNamesFor(player) {
  const names = [];
  const push = (n) => {
    if (n && names.indexOf(n.toLowerCase()) === -1) names.push(n.toLowerCase());
  };
  push(path.basename(player.exe));
  const spec = specById(player.id);
  if (spec) for (const n of spec.proc) push(n);
  return names;
}
function matchPids(snapshot, names) {
  const out = [];
  for (const n of names) {
    const pids = snapshot.map.get(n);
    if (!pids) continue;
    for (const pid of pids) if (out.indexOf(pid) === -1) out.push(pid);
  }
  return out.sort((a, b) => a - b);
}
/* 进程快照里已有内置播放器在运行，但它还没进入播放器列表：
   说明是刚启动的，需要立即补扫，而不是等缓存过期。 */
function catalogRunningButUnknown(snapshot) {
  if (!snapshot || !snapshot.ok) return false;
  const known = new Set(scanState.players.map((p) => p.id));
  for (const spec of CATALOG) {
    if (known.has(spec.id)) continue;
    const probe = { id: spec.id, exe: (spec.exe && spec.exe[0]) || '' };
    if (matchPids(snapshot, procNamesFor(probe)).length) return true;
  }
  return false;
}
const PROC_LIST_PS = [
  "$ProgressPreference = 'SilentlyContinue'",
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  'Get-Process -ErrorAction SilentlyContinue | ForEach-Object {',
  '  $p = $null',
  '  try { $p = $_.Path } catch { }',
  "  if ($p) { 'P' + [char]9 + $_.ProcessName + [char]9 + $_.MainWindowTitle + [char]9 + $p }",
  '}',
].join('\n');
let procPathCache = { at: 0, list: [], ok: false, error: null };
function parseProcList(text) {
  const list = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (line.indexOf('P\t') !== 0) continue;
    const parts = line.split('\t');
    if (parts.length < 4) continue;
    const exePath = parts[parts.length - 1];
    const name = parts[1];
    if (!name || !exePath) continue;
    list.push({ name: name, title: parts.slice(2, parts.length - 1).join('\t'), path: exePath });
  }
  return list;
}
async function readProcessPaths() {
  const now = Date.now();
  if (procPathCache.at && now - procPathCache.at < CFG.runningTtlMs) return procPathCache;
  const r = await runPowerShell(PROC_LIST_PS, CFG.procTimeoutMs);
  if (!r.ok && !r.stdout) {
    procPathCache = { at: now, list: [], ok: false, error: r.error || 'Get-Process failed' };
    return procPathCache;
  }
  procPathCache = { at: Date.now(), list: parseProcList(r.stdout), ok: true, error: null };
  return procPathCache;
}
function playerFromProcess(proc) {
  if (!proc || !proc.path) return null;
  const exe = path.resolve(proc.path);
  if (!fileExistsSync(exe)) return null;
  if (/\\Temp\\/i.test(exe)) return null;
  const base = path.basename(exe);
  const dir = path.dirname(exe);
  if (PROC_SKIP_RE.test(base.replace(/\.exe$/i, ''))) return null;
  if (NOT_PLAYER_RE.test(base)) return null;
  const helper = PROC_HELPER_RE.test(base);
  let spec = CATALOG.find(
    (s) =>
      s.exe.some((n) => n.toLowerCase() === base.toLowerCase()) ||
      s.proc.some((n) => n.toLowerCase() === base.toLowerCase())
  );
  if (!spec && !helper) spec = CATALOG.find((s) => s.match.test(dir) || s.match.test(base));
  if (!spec && (helper || !PROC_PLAYER_RE.test(base + ' ' + dir))) return null;
  return {
    id: spec ? spec.id : slugify(base),
    name: spec ? spec.name : base.replace(/\.exe$/i, ''),
    exe: exe,
    installDir: dir,
    version: null,
    source: 'process',
  };
}
const ICON_PS_HEAD = [
  "$ProgressPreference = 'SilentlyContinue'",
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Drawing',
  'Add-Type @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class McIcon {',
  '  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
  '  public static extern int PrivateExtractIcons(string lpszFile, int nIconIndex, int cxIcon, int cyIcon, IntPtr[] phicon, int[] piconid, int nIcons, int flags);',
  '  [DllImport("user32.dll", SetLastError = true)]',
  '  public static extern bool DestroyIcon(IntPtr hIcon);',
  '}',
  '"@',
  'function Emit-Png($icon) {',
  '  $bmp = $icon.ToBitmap()',
  '  $ms = New-Object System.IO.MemoryStream',
  '  try {',
  '    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)',
  '    return [Convert]::ToBase64String($ms.ToArray())',
  '  } finally {',
  '    $ms.Dispose()',
  '    $bmp.Dispose()',
  '  }',
  '}',
].join('\n');
const ICON_PS_TAIL = [
  '$out = $null',
  'foreach ($size in 256, 128, 64, 48, 32) {',
  '  $hs = New-Object IntPtr[] 1',
  '  $ids = New-Object int[] 1',
  '  $n = 0',
  '  try { $n = [McIcon]::PrivateExtractIcons($path, 0, $size, $size, $hs, $ids, 1, 0) } catch { $n = 0 }',
  '  if ($n -gt 0 -and $hs[0] -ne [IntPtr]::Zero) {',
  '    try {',
  '      $ico = [System.Drawing.Icon]::FromHandle($hs[0])',
  '      $out = Emit-Png $ico',
  '      $ico.Dispose()',
  '    } catch { $out = $null }',
  '    [McIcon]::DestroyIcon($hs[0]) | Out-Null',
  '    if ($out) { break }',
  '  }',
  '}',
  'if (-not $out) {',
  '  try {',
  '    $ico = [System.Drawing.Icon]::ExtractAssociatedIcon($path)',
  '    if ($ico) { $out = Emit-Png $ico; $ico.Dispose() }',
  '  } catch { $out = $null }',
  '}',
  "if ($out) { 'OK:' + $out } else { 'FAIL:no-icon' }",
].join('\n');
function buildIconScript(exe) {
  return ICON_PS_HEAD + '\n$path = ' + psString(exe) + '\n' + ICON_PS_TAIL;
}
async function extractIconPng(exe) {
  const r = await runPowerShell(buildIconScript(exe), CFG.iconTimeoutMs);
  const m = /^OK:(.+)$/m.exec(r.stdout || '');
  if (!m) {
    return {
      ok: false,
      error: r.ok ? 'no icon payload' : r.error || 'powershell failed',
      stderr: (r.stderr || '').slice(0, 400),
    };
  }
  const png = Buffer.from(m[1].trim(), 'base64');
  if (!isPng(png)) return { ok: false, error: 'icon payload is not a PNG' };
  return { ok: true, png: png };
}
const FOCUS_PS_BODY = [
  "$ProgressPreference = 'SilentlyContinue'",
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  'Add-Type @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class McWin {',
  '  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);',
  '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
  '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '}',
  '"@',
].join('\n');
const FOCUS_PS_TAIL = [
  "$target = Get-Process -Name $names -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1",
  "if (-not $target) { 'NOWIN'; exit 0 }",
  '$h = $target.MainWindowHandle',
  '[McWin]::ShowWindowAsync($h, 9) | Out-Null',
  '[McWin]::SetForegroundWindow($h) | Out-Null',
  'Start-Sleep -Milliseconds 120',
  "if ([McWin]::GetForegroundWindow() -eq $h) { 'FOCUSED:' + $target.Id; exit 0 }",
  'try {',
  '  $ws = New-Object -ComObject WScript.Shell',
  '  $ws.AppActivate($target.Id) | Out-Null',
  '} catch { }',
  'Start-Sleep -Milliseconds 180',
  "if ([McWin]::GetForegroundWindow() -eq $h) { 'FOCUSED2:' + $target.Id } else { 'UNVERIFIED:' + $target.Id }",
].join('\n');
async function focusWindow(player) {
  const names = [];
  for (const raw of procNamesFor(player)) {
    const n = raw.replace(/\.exe$/, '');
    if (names.indexOf(n) === -1) names.push(n);
  }
  const script =
    FOCUS_PS_BODY + '\n$names = @(' + names.map(psString).join(', ') + ')\n' + FOCUS_PS_TAIL;
  const r = await runPowerShell(script, CFG.focusTimeoutMs);
  const out = String(r.stdout || '').trim();
  const m = /^FOCUSED2?:(\d+)/.exec(out);
  if (m) return { ok: true, method: 'showwindow+setforeground', pid: Number(m[1]) };
  const u = /^UNVERIFIED:(\d+)/.exec(out);
  if (u) return { ok: true, method: 'setforeground-unverified', pid: Number(u[1]) };
  if (/^NOWIN/.test(out)) return { ok: true, method: 'no-window', pid: null };
  return { ok: false, error: r.error || 'focus script failed', raw: (out || r.stderr || '').slice(0, 300) };
}
const SPAWN_ENV_DROP = ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'ELECTRON_ENABLE_LOGGING', 'NODE_OPTIONS'];
function childEnv() {
  const env = Object.assign({}, process.env);
  for (const key of SPAWN_ENV_DROP) delete env[key];
  return env;
}
function spawnDetached(exe, args) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    let child;
    try {
      const options = {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        env: childEnv(),
      };
      if (path.isAbsolute(exe)) options.cwd = path.dirname(exe);
      child = spawn(exe, Array.isArray(args) ? args : [], options);
    } catch (e) {
      finish({ ok: false, error: errMsg(e) });
      return;
    }
    child.on('error', (e) => finish({ ok: false, error: errMsg(e) }));
    child.on('spawn', () => {
      try {
        child.unref();
      } catch {}
      finish({ ok: true, pid: child.pid });
    });
    const guard = setTimeout(() => {
      try {
        child.unref();
      } catch {}
      finish({ ok: true, pid: child.pid });
    }, 2000);
    if (typeof guard.unref === 'function') guard.unref();
  });
}
function launchCandidates(player) {
  const out = [];
  const push = (p) => {
    if (!p) return;
    const abs = path.resolve(p);
    if (!fileExistsSync(abs)) return;
    if (out.some((x) => x.toLowerCase() === abs.toLowerCase())) return;
    out.push(abs);
  };
  const spec = specById(player.id);
  push(player.exe);
  if (spec) {
    const dir = player.installDir || path.dirname(player.exe);
    for (const name of spec.exe || []) push(path.join(dir, name));
    for (const name of spec.launcher || []) push(path.join(dir, name));
    for (const raw of spec.paths || []) push(expandEnv(raw));
  }
  return out;
}
async function waitForProcess(player, timeoutMs) {
  const names = procNamesFor(player);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snap = await snapshotProcesses({ force: true });
    if (snap.ok) {
      const pids = matchPids(snap, names);
      if (pids.length) return { pid: pids[0], pids: pids };
    }
    if (Date.now() >= deadline) return null;
    await delay(CFG.spawnPollMs);
  }
}
let scanState = { at: 0, players: [] };
/* 同一时刻只允许一次完整扫描：定时刷新与识别补扫可能同时触发，
   叠加执行会让界面长时间停在旧列表上。 */
let scanInflight = null;
/* 补扫冷却：播放器进程存在但确实无法识别时，避免每 2 秒重复完整扫描。 */
let unknownProbeAt = 0;
async function discoverPlayers() {
  const warnings = [];
  const sources = await Promise.all([readUninstallEntries(), readStartMenuTargets(), readProcessPaths(), readAppxPackages()]);
  const reg = sources[0];
  const lnk = sources[1];
  const procs = sources[2];
  const store = sources[3];
  if (!reg.ok) warnings.push('registry: ' + (reg.error || 'unavailable'));
  if (!lnk.ok) warnings.push('shortcuts: ' + (lnk.error || 'unavailable'));
  if (!procs.ok) warnings.push('processes: ' + (procs.error || 'unavailable'));
  if (!store.ok) warnings.push('store: ' + (store.error || 'unavailable'));
  const found = [];
  for (const entry of reg.entries) {
    try {
      const p = playerFromRegistryEntry(entry);
      if (p) found.push(p);
    } catch (e) {
      warnings.push('registry entry skipped: ' + errMsg(e));
    }
  }
  for (const target of lnk.targets) {
    try {
      const p = playerFromShortcut(target);
      if (p) found.push(p);
    } catch (e) {
      warnings.push('shortcut skipped: ' + errMsg(e));
    }
  }
  for (const spec of CATALOG) {
    for (const rawPath of spec.paths || []) {
      try {
        const p = playerFromWhitelist(spec, rawPath);
        if (p) found.push(p);
      } catch (e) {
        warnings.push('whitelist skipped: ' + errMsg(e));
      }
    }
  }
  for (const entry of store.packages) {
    try {
      const p = playerFromStorePackage(entry);
      if (p) found.push(p);
    } catch (e) {
      warnings.push('store entry skipped: ' + errMsg(e));
    }
  }
  for (const proc of procs.list) {
    try {
      const p = playerFromProcess(proc);
      if (p) found.push(p);
    } catch (e) {
      warnings.push('process skipped: ' + errMsg(e));
    }
  }
  const rank = { store: 0, registry: 1, shortcut: 2, whitelist: 3, process: 4 };
  const byId = new Map();
  const byExe = new Set();
  for (const p of found) {
    const exeKey = p.exe.toLowerCase();
    const existing = byId.get(p.id);
    if (existing) {
      if (rank[p.source] < rank[existing.source]) {
        byId.set(p.id, p);
        byExe.add(exeKey);
      }
      continue;
    }
    if (byExe.has(exeKey)) continue;
    byId.set(p.id, p);
    byExe.add(exeKey);
  }
  const order = CATALOG.map((s) => s.id);
  const players = [...byId.values()].sort((a, b) => {
    const ia = order.indexOf(a.id);
    const ib = order.indexOf(b.id);
    const wa = ia === -1 ? 99 : ia;
    const wb = ib === -1 ? 99 : ib;
    return wa - wb || a.name.localeCompare(b.name);
  });
  return { players: players, warnings: warnings, regOk: reg.ok, lnkOk: lnk.ok, storeOk: store.ok };
}
async function scanPlayers(opts) {
  if (scanInflight) return scanInflight;
  scanInflight = scanPlayersOnce(opts);
  try { return await scanInflight; }
  finally { scanInflight = null; }
}
async function scanPlayersOnce(opts) {
  const started = Date.now();
  try {
    const force = !!(opts && opts.force);
    const now = Date.now();
    const warm = !force && scanState.players.length > 0 && now - scanState.at < CFG.scanTtlMs;
    let players = scanState.players.map((p) => ({ ...p }));
    let warnings = [];
    if (!warm) {
      const discovered = await discoverPlayers();
      players = discovered.players.map((p) => ({ ...p }));
      warnings = discovered.warnings;
      if (!discovered.regOk && !discovered.lnkOk && !discovered.storeOk && players.length === 0) {
        return E('SCAN_FAILED', 'no player source available', { warnings: warnings });
      }
      scanState = { at: Date.now(), players: players.map((p) => ({ ...p })) };
    }
    const snap = await snapshotProcesses({ force: false });
    if (!snap.ok) warnings.push('tasklist: ' + (snap.error || 'unavailable'));
    const out = players.map((p) => {
      const pids = snap.ok ? matchPids(snap, procNamesFor(p)) : [];
      return {
        id: p.id,
        name: p.name,
        exe: p.exe,
        installDir: p.installDir,
        version: p.version,
        running: pids.length > 0,
      };
    });
    const result = { ok: true, players: out, elapsedMs: Date.now() - started };
    if (warnings.length) result.warnings = warnings;
    return result;
  } catch (e) {
    return E('SCAN_FAILED', errMsg(e));
  }
}
async function findPlayer(id) {
  if (typeof id !== 'string' || !id.trim()) return E('INVALID_ID', 'player id must be a non-empty string');
  const key = id.trim().toLowerCase();
  const now = Date.now();
  if (!scanState.players.length || now - scanState.at > CFG.scanTtlMs) {
    const s = await scanPlayers({});
    if (!s.ok) return s;
  }
  const player = scanState.players.find((p) => p.id === key);
  if (!player) {
    return E('UNKNOWN_PLAYER', 'unknown player id: ' + key, { known: scanState.players.map((p) => p.id) });
  }
  return { ok: true, player: { ...player } };
}
async function getIcon(id) {
  try {
    const found = await findPlayer(id);
    if (!found.ok) return found;
    const player = found.player;
    const cachePath = path.join(ICON_DIR, player.id + '.png');
    const cachedStat = await statSafe(cachePath);
    const mem = iconMem.get(player.id);
    if (cachedStat && mem && mem.mtimeMs === cachedStat.mtimeMs) {
      return { ok: true, dataUrl: mem.dataUrl, fromCache: true, cachePath: cachePath };
    }
    if (cachedStat && cachedStat.size > 0) {
      const buf = await fsp.readFile(cachePath).catch(() => null);
      if (isPng(buf)) {
        const dataUrl = 'data:image/png;base64,' + buf.toString('base64');
        iconMem.set(player.id, { dataUrl: dataUrl, mtimeMs: cachedStat.mtimeMs });
        return { ok: true, dataUrl: dataUrl, fromCache: true, cachePath: cachePath };
      }
    }
    const exeStat = await statSafe(player.exe);
    if (!exeStat || !exeStat.isFile()) {
      return E('EXE_MISSING', 'executable not found: ' + player.exe, { id: player.id });
    }
    const extracted = await extractIconPng(player.exe);
    if (!extracted.ok) {
      return E('ICON_EXTRACT_FAILED', extracted.error || 'icon extraction failed', {
        id: player.id,
        exe: player.exe,
        stderr: extracted.stderr || null,
      });
    }
    await fsp.mkdir(ICON_DIR, { recursive: true });
    await fsp.writeFile(cachePath, extracted.png);
    const newStat = await statSafe(cachePath);
    const dataUrl = 'data:image/png;base64,' + extracted.png.toString('base64');
    iconMem.set(player.id, { dataUrl: dataUrl, mtimeMs: newStat ? newStat.mtimeMs : 0 });
    return { ok: true, dataUrl: dataUrl, fromCache: false, cachePath: cachePath, bytes: extracted.png.length };
  } catch (e) {
    return E('ICON_FAILED', errMsg(e));
  }
}
const iconMem = new Map();
async function isRunning(id) {
  try {
    const found = await findPlayer(id);
    if (!found.ok) return found;
    const snap = await snapshotProcesses({ force: true });
    if (!snap.ok) return E('TASKLIST_FAILED', snap.error || 'tasklist unavailable');
    const pids = matchPids(snap, procNamesFor(found.player));
    return { ok: true, running: pids.length > 0, pids: pids };
  } catch (e) {
    return E('ISRUNNING_FAILED', errMsg(e));
  }
}
async function refreshRunning(ids) {
  try {
    const list = Array.isArray(ids) ? ids : [];
    const snap = await snapshotProcesses({ force: false });
    if (!snap.ok) return E('TASKLIST_FAILED', snap.error || 'tasklist unavailable');
    const now = Date.now();
    if (!scanState.players.length || now - scanState.at > CFG.scanTtlMs) {
      const scanned = await scanPlayers({});
      if (!scanned.ok) return scanned;
    }
    /* 轻量轮询发现新启动的播放器时立即补一次完整扫描，
       否则要等缓存过期（最长 60 秒）才会出现在列表里。 */
    if (catalogRunningButUnknown(snap) && Date.now() - unknownProbeAt > 30000) {
      unknownProbeAt = Date.now();
      const scanned = await scanPlayers({ force: true });
      if (!scanned.ok) return scanned;
    }
    const states = {};
    for (const raw of list) {
      const key = String(raw == null ? '' : raw).trim().toLowerCase();
      if (!key) continue;
      const player = scanState.players.find((p) => p.id === key);
      const pids = player ? matchPids(snap, procNamesFor(player)) : [];
      states[key] = { running: pids.length > 0, pids: pids };
    }
    return { ok: true, states: states };
  } catch (e) {
    return E('REFRESH_FAILED', errMsg(e));
  }
}
async function launch(id) {
  try {
    const found = await findPlayer(id);
    if (!found.ok) return found;
    const player = found.player;
    const state = await isRunning(player.id);
    if (!state.ok) return state;
    if (state.running) {
      const focused = await focusWindow(player);
      const result = { ok: true, action: 'focused', pid: state.pids[0] || null, pids: state.pids };
      if (focused.ok) {
        result.method = focused.method;
        if (focused.pid) result.windowPid = focused.pid;
      } else {
        result.method = 'focus-failed';
        result.warning = focused.error || 'focus failed';
      }
      return result;
    }
    const storeTarget = player.launchTarget || null;
    const candidates = storeTarget ? [storeTarget] : launchCandidates(player);
    if (!candidates.length) {
      return E('EXE_MISSING', 'no launchable executable for ' + player.id, { id: player.id, exe: player.exe });
    }
    const explorer = path.join(process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows', 'explorer.exe');
    const failures = [];
    for (const candidate of candidates) {
      const spawned = storeTarget
        ? await spawnDetached(explorer, [candidate])
        : await spawnDetached(candidate);
      if (!spawned.ok) {
        failures.push({ exe: candidate, error: spawned.error });
        continue;
      }
      const detected = await waitForProcess(player, CFG.spawnWaitMs);
      if (detected) {
        const result = {
          ok: true,
          action: 'spawned',
          pid: detected.pid,
          exe: storeTarget ? player.exe : candidate,
          spawnPid: spawned.pid,
          verified: true,
        };
        if (storeTarget) result.launchTarget = candidate;
        if (detected.pids.length > 1) result.pids = detected.pids;
        return result;
      }
      failures.push({ exe: candidate, error: 'process did not appear within ' + CFG.spawnWaitMs + 'ms' });
    }
    return E('SPAWN_FAILED', 'could not start ' + player.name, { id: player.id, attempts: failures });
  } catch (e) {
    return E('LAUNCH_FAILED', errMsg(e));
  }
}
module.exports = {
  scanPlayers: scanPlayers,
  getIcon: getIcon,
  isRunning: isRunning,
  launch: launch,
  refreshRunning: refreshRunning,
  sessionMatchesPlayer: sessionMatchesPlayer,
  __internal: {
    CATALOG: CATALOG,
    ICON_DIR: ICON_DIR,
    STATE_DIR: STATE_DIR,
    parseTasklist: parseTasklist,
    parseUninstallDump: parseUninstallDump,
    normalizeIconPath: normalizeIconPath,
    parseProcList: parseProcList,
    playerFromProcess: playerFromProcess,
    readProcessPaths: readProcessPaths,
    slugify: slugify,
    expandEnv: expandEnv,
    resolveExe: resolveExe,
    playerFromRegistryEntry: playerFromRegistryEntry,
    playerFromShortcut: playerFromShortcut,
    playerFromStorePackage: playerFromStorePackage,
    normalizeSessionId: normalizeSessionId,
    sessionMatchesPlayer: sessionMatchesPlayer,
    procNamesFor: procNamesFor,
    snapshotProcesses: snapshotProcesses,
    matchPids: matchPids,
    findPlayer: findPlayer,
    buildIconScript: buildIconScript,
    isPng: isPng,
  },
};
