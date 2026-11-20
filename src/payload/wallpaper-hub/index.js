'use strict';
/*
 * M HUB 壁纸插件：把 Wallpaper Engine 本地壁纸接进 M HUB 主界面。
 * - 由独立 bootstrap 装载，启动页关闭保护位于 startup-guard.js。
 * - 壁纸只作用于 M HUB 自身背景（.wallpaper-background），不再修改桌面壁纸。
 * - 壁纸库与美化面板注入到「设置 → 主题设置」页面。
 * - 上行 console.dir('[mhub-wp]'+JSON)，下行 window.__mhubWpReceive(JSON)。
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { Readable } = require('stream');
require('./startup-guard.js');

const SCHEME = 'mchose-wallpaper';
const PREFIX = '[mhub-wp]';
const APP_URL_RE = /^mchose-renderer:\/\/app\/.*\/index\.html/i;
const STARTUP_URL_RE = /startup-loading\.html/i;
const RENDERER_DIR = path.join(__dirname, 'renderer');
const DATA_DIR = path.join(process.env.APPDATA || os.homedir(), 'MCHOSEHUB', 'wallpaper-hub');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const LOG_FILE = path.join(DATA_DIR, 'wallpaper-hub.log');
const CMD_FILE = path.join(DATA_DIR, 'dev-cmd.json');
const OUT_FILE = path.join(DATA_DIR, 'dev-out.json');
const SHOT_FILE = path.join(DATA_DIR, 'shot.png');
const TYPE_LABEL = { scene: '场景', video: '视频', web: '网页', application: '应用' };
const VIDEO_EXT = ['.mp4', '.webm', '.mov', '.mkv'];
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
const MAX_MANUAL_DEPTH = 4;
const MAX_MANUAL_DIRS = 500;
const VERSION = '4.3';
const AUTHOR = '顾小颜';

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
}

function log(level, message) {
  try {
    ensureDir(DATA_DIR);
    try {
      const st = fs.statSync(LOG_FILE);
      if (st.size > 768 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    } catch (e) { /* ignore */ }
    fs.appendFileSync(LOG_FILE, new Date().toISOString() + ' [' + level + '] ' + message + '\n');
  } catch (e) { /* ignore */ }
}

function stripBom(text) {
  return String(text).replace(/^\uFEFF/, '');
}

function readJson(file) {
  try { return JSON.parse(stripBom(fs.readFileSync(file, 'utf8'))); }
  catch (e) { return null; }
}

const DEFAULT_BEAUTIFY = {
  blur: 0,
  brightness: 100,
  dim: 0,
  saturation: 100,
  scale: 100,
  fit: 'cover',
  posX: 50,
  posY: 50,
  motion: 'none',
  speed: 1,
  nativeBlur: 0,
  nativeBrightness: 50,
  deviceBlur: 12
};

const DEFAULT_SPLASH = {
  enabled: true,
  mode: 'mhub',              // mhub=原生六幕 / moon=月下少女 / gallery=图片开场 / dragon=龙娘 / launcher=缎带书写
  bgMode: 'follow',          // follow=跟随壁纸 custom=指定壁纸 color=纯色 off=不铺背景
  bgId: '',
  bgColor: '#05070c',
  bgBlur: 0,
  bgBrightness: 100,
  bgDim: 12,
  bgSaturation: 100,
  bgScale: 100,
  theme: 'auto',             // auto | light | dark
  glass: true,
  glassOpacity: 55,
  glassBlur: 18,
  glassSaturate: 160,
  glassBackdropBlur: 0,
  speed: 1,
  requireInteraction: true,
  allowSkip: true,
  startMaximized: false,     // 启动时把启动页与驱动主窗口直接最大化
  sfx: true,
  sfxVolume: 50,
  voice: true,
  voiceSource: 'asset',
  voiceVolume: 90,
  voiceRate: 0.9,
  voicePitch: 0.9,
  identityName: 'MCHOSE USER',
  identityId: 'MCHOSE-01',
  welcomeName: 'GXY',
  accessLevel: '03',
  accent: '#1f63ff',
  glitchA: '#ff3b30',
  glitchB: '#2971b8',
  /* 分阶段开关：intro(黑幕→洗白) / setup(品牌块进入) / steps(5步授权) / welcome(终幕)。
     全部 false 时直接收窗，跳过全部动画。 */
  stages: { intro: true, setup: true, steps: true, welcome: true }
};

/* ── 内置壁纸：随启动动画联动（如选「月光下的持剑少女」则桌面壁纸同步为该图）─────
   文件随 payload 打包在 wallpaper-hub/assets/ 下，运行时 __dirname 指向 wallpaper-hub。 */
const BUILTIN_WALLPAPERS = {
  moon: { id: 'builtin:moon', title: '月光下的持剑少女', file: path.join(__dirname, 'assets', 'moon-wallpaper.jpg') }
};
function ensureBuiltinItems(ctx) {
  for (const key of Object.keys(BUILTIN_WALLPAPERS)) {
    const b = BUILTIN_WALLPAPERS[key];
    if (ctx.byId.has(b.id)) continue;
    let ok = false;
    try { ok = !!b.file && fs.existsSync(b.file); } catch (e) { ok = false; }
    if (!ok) continue;
    ctx.items.push({
      id: b.id, title: b.title, type: '', typeLabel: 'M HUB 内置', tags: [],
      preview: SCHEME + '://img/preview/' + encodeURIComponent(b.id),
      thumb: SCHEME + '://img/thumb/' + encodeURIComponent(b.id),
      kind: 'image', source: 'builtin', libraryId: 'builtin', adult: false
    });
    ctx.byId.set(b.id, {
      dir: path.dirname(b.file), projectJson: '', preview: b.file, image: b.file,
      video: '', scenePkg: '', sceneEntry: '', webEntry: '', kind: 'image',
      props: [], source: 'builtin', libraryId: 'builtin'
    });
  }
}
/* 启动动画模式 ↔ 桌面壁纸联动：当前仅 moon 模式联动到内置 moon 壁纸。 */
function applyModeWallpaperSync() {
  if (state.splash.mode !== 'moon') return false;
  if (!state.byId || !state.byId.has('builtin:moon')) return false;
  if (state.bgId === 'builtin:moon') return false;
  setBackground('builtin:moon');
  return true;
}
/* 注入到启动页的配置（含运行时壁纸地址 wpBg，供 launcher 缎带模式把背景同步为驱动壁纸）。
   不写回 state.splash，避免把运行时 URL 持久化到 state.json。 */
function splashConfigForInject() {
  const cfg = Object.assign({}, state.splash);
  try { cfg.wpBg = splashBg(); } catch (e) { cfg.wpBg = null; }
  return cfg;
}
let initialModeSyncDone = false;

const DEFAULT_HOTKEYS = {
  next: 'Alt+Right',
  prev: 'Alt+Left',
  random: 'Alt+R',
  toggle: 'Alt+P',
  preview: ''
};

const DEFAULT_SCENE_PERFORMANCE = {
  preset: 'balanced',
  fps: 30,
  renderDpr: 1,
  videoTexScale: 0.75,
  pauseWhenHidden: true
};

const state = {
  items: [],
  byId: new Map(),
  libraries: [],
  manualLibraries: [],
  libraryStates: Object.create(null),
  favorites: [],
  recent: [],
  rotation: { enabled: false, intervalMinutes: 30, scope: 'all', lastRunAt: 0 },
  scenePerformance: Object.assign({}, DEFAULT_SCENE_PERFORMANCE),
  bgId: '',
  enabled: false,
  /* false：壁纸只作为背景，官方前景层（设备图标、名称、电量等）保持可见；
     true：连官方前景层一起遮盖，只显示壁纸（旧行为，需用户在面板手动开启）。 */
  overlayOfficial: false,
  beautify: Object.assign({}, DEFAULT_BEAUTIFY),
  /* 场景壁纸自定义属性值：{ [wallpaperId]: { [propertyKey]: value } } */
  props: Object.create(null),
  splash: Object.assign({}, DEFAULT_SPLASH),
  hotkeys: Object.assign({}, DEFAULT_HOTKEYS),
  hotkeyErrors: [],
  error: null,
  scannedAt: 0
};

(function restore() {
  const saved = readJson(STATE_FILE);
  if (!saved) return;
  state.bgId = String(saved.bgId || saved.lastApplied || '');
  state.enabled = !!saved.enabled && !!state.bgId;
  state.overlayOfficial = !!saved.overlayOfficial;
  if (saved.beautify && typeof saved.beautify === 'object') {
    for (const key of Object.keys(DEFAULT_BEAUTIFY)) {
      if (saved.beautify[key] !== undefined) state.beautify[key] = saved.beautify[key];
    }
  }
  if (saved.props && typeof saved.props === 'object' && !Array.isArray(saved.props)) {
    for (const key of Object.keys(saved.props)) {
      const value = saved.props[key];
      if (value && typeof value === 'object' && !Array.isArray(value)) state.props[key] = Object.assign({}, value);
    }
  }
  if (saved.splash && typeof saved.splash === 'object') {
    for (const key of Object.keys(DEFAULT_SPLASH)) {
      if (saved.splash[key] !== undefined) state.splash[key] = saved.splash[key];
    }
  }
  if (['mhub', 'moon', 'gallery', 'dragon', 'launcher'].indexOf(state.splash.mode) === -1) state.splash.mode = 'mhub';
  if (saved.hotkeys && typeof saved.hotkeys === 'object') {
    for (const key of Object.keys(DEFAULT_HOTKEYS)) {
      if (typeof saved.hotkeys[key] === 'string') state.hotkeys[key] = saved.hotkeys[key];
    }
  }
  if (saved.libraryStates && typeof saved.libraryStates === 'object') {
    for (const key of Object.keys(saved.libraryStates)) {
      const value = saved.libraryStates[key];
      if (value && typeof value === 'object') state.libraryStates[key] = { enabled: value.enabled !== false };
    }
  }
  if (Array.isArray(saved.manualLibraries)) {
    const seen = new Set();
    for (const savedLib of saved.manualLibraries) {
      if (!savedLib || typeof savedLib.path !== 'string') continue;
      const root = path.resolve(savedLib.path);
      const key = root.toLowerCase();
      if (path.parse(root).root === root || seen.has(key)) continue;
      seen.add(key);
      state.manualLibraries.push({
        id: String(savedLib.id || ('manual-' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 12))),
        label: String(savedLib.label || path.basename(root)).slice(0, 80),
        path: root,
        source: 'manual',
        enabled: savedLib.enabled !== false
      });
    }
  }
  if (Array.isArray(saved.favorites)) state.favorites = [...new Set(saved.favorites.map(String))].slice(0, 2000);
  if (Array.isArray(saved.recent)) state.recent = [...new Set(saved.recent.map(String))].slice(0, 30);
  if (saved.rotation && typeof saved.rotation === 'object') {
    state.rotation.enabled = !!saved.rotation.enabled;
    state.rotation.intervalMinutes = Math.min(1440, Math.max(1, Number(saved.rotation.intervalMinutes) || 30));
    state.rotation.scope = saved.rotation.scope === 'favorites' ? 'favorites' : 'all';
    state.rotation.lastRunAt = Number(saved.rotation.lastRunAt) || 0;
  }
  if (saved.scenePerformance && typeof saved.scenePerformance === 'object') {
    const p = saved.scenePerformance;
    state.scenePerformance.preset = /^(saver|balanced|quality)$/.test(p.preset) ? p.preset : 'balanced';
    state.scenePerformance.fps = Math.min(120, Math.max(5, Number(p.fps) || 30));
    state.scenePerformance.renderDpr = Math.min(2, Math.max(0.5, Number(p.renderDpr) || 1));
    state.scenePerformance.videoTexScale = Math.min(1, Math.max(0.25, Number(p.videoTexScale) || 0.75));
    state.scenePerformance.pauseWhenHidden = p.pauseWhenHidden !== false;
  }
})();

/* 关闭启动动画时应完全沿用官方启动页：既不挂载自定义动画，也不拦截官方窗口关闭。
   这个标志供 startup-guard.js 的关闭保护读取。 */
function splashAnimationOn() {
  return !!(state && state.splash && state.splash.enabled !== false);
}

function syncSplashFlag() {
  try { global.__mhubSplashAnimation = splashAnimationOn(); } catch (e) { /* ignore */ }
}

syncSplashFlag();

function saveState() {
  try {
    ensureDir(DATA_DIR);
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      bgId: state.bgId,
      enabled: state.enabled,
      overlayOfficial: state.overlayOfficial,
      beautify: state.beautify,
      props: state.props,
      splash: state.splash,
      hotkeys: state.hotkeys,
      manualLibraries: state.manualLibraries,
      libraryStates: state.libraryStates,
      favorites: state.favorites,
      recent: state.recent,
      rotation: state.rotation,
      scenePerformance: state.scenePerformance
    }, null, 2));
  } catch (e) { /* ignore */ }
}

// ---------- Wallpaper Engine 定位 ----------

function registryValue(key, value) {
  try {
    const out = execFileSync('reg', ['query', key, '/v', value], {
      encoding: 'utf8', windowsHide: true, timeout: 3000
    });
    const re = new RegExp(value + '\\s+REG_SZ\\s+(.+)', 'i');
    const m = out.match(re);
    if (m && m[1]) return path.win32.normalize(m[1].trim().replace(/\//g, '\\'));
  } catch (e) { /* ignore */ }
  return '';
}

function steamPathFromRegistry() {
  const direct = registryValue('HKCU\\Software\\Valve\\Steam', 'SteamPath');
  if (direct) return direct;
  const exe = registryValue('HKCU\\Software\\Valve\\Steam', 'SteamExe');
  return exe ? path.dirname(exe) : '';
}

function fixedDrives() {
  const drives = [];
  for (let n = 67; n <= 90; n++) {
    const drive = String.fromCharCode(n) + ':\\';
    if (isDirectory(drive)) drives.push(drive);
  }
  return drives;
}

/* 只靠注册表找不到"装在非系统盘"的 Steam / 壁纸引擎：
   常见情况是 Steam 或 steamapps 库放在 G:/D: 这类数据盘，注册表仍指向旧路径。
   这里按盘符做一层浅扫描，把带 steamapps 的目录和壁纸引擎目录捞出来。 */
function driveRootDirs() {
  const out = new Set();
  for (const drive of fixedDrives()) {
    out.add(drive);
    let children = [];
    try {
      children = fs.readdirSync(drive, { withFileTypes: true }).filter(function (d) { return d.isDirectory(); });
    } catch (e) { continue; }
    for (const child of children) {
      const dir = path.join(drive, child.name);
      if (/steam|library|game|program files|wallpaper|wegame|tencent|valve/i.test(child.name)) out.add(dir);
    }
  }
  return [...out];
}

function steamLibraries() {
  const roots = new Set();
  const reg = steamPathFromRegistry();
  if (reg) roots.add(reg);
  /* 某些机器 HKCU 没有 SteamPath，但 HKLM 仍记录真实安装目录。 */
  for (const key of ['HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'HKLM\\SOFTWARE\\Valve\\Steam']) {
    const install = registryValue(key, 'InstallPath');
    if (install) roots.add(install);
  }
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  roots.add(path.join(pf86, 'Steam'));
  roots.add(path.join(pf, 'Steam'));
  /* 各盘符里的 Steam / SteamLibrary / steamapps 目录（含 G: 等非系统盘） */
  for (const dir of driveRootDirs()) {
    if (isDirectory(path.join(dir, 'steamapps'))) {
      roots.add(dir);
      continue;
    }
    for (const name of ['Steam', 'steam', 'SteamLibrary', 'steamlibrary']) {
      const sub = path.join(dir, name);
      if (isDirectory(path.join(sub, 'steamapps'))) roots.add(sub);
    }
  }

  const libs = new Set();
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    libs.add(root);
    try {
      const vdf = fs.readFileSync(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8');
      let m;
      const modern = /"path"\s+"([^"]+)"/g;
      while ((m = modern.exec(vdf))) libs.add(path.win32.normalize(m[1].replace(/\\\\/g, '\\')));
      /* 旧版 libraryfolders.vdf 使用 "1" "D:\\SteamLibrary" 格式。 */
      const legacy = /"\d+"\s+"([A-Za-z]:[^"]+)"/g;
      while ((m = legacy.exec(vdf))) libs.add(path.win32.normalize(m[1].replace(/\\\\/g, '\\')));
    } catch (e) { /* ignore */ }
  }
  return [...libs];
}

function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch (e) { return false; }
}

function isDirectory(dir) {
  try { return fs.statSync(dir).isDirectory(); } catch (e) { return false; }
}

function canonicalPath(value) {
  try { return fs.realpathSync(value); } catch (e) { return path.resolve(value); }
}

function pathKey(value) {
  return canonicalPath(value).toLowerCase();
}

function shortHash(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 12);
}

function insidePath(root, candidate) {
  const rel = path.relative(canonicalPath(root), canonicalPath(candidate));
  return !!rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

function validEngineDir(dir) {
  if (!dir || !isDirectory(dir)) return false;
  if (isDirectory(path.join(dir, 'projects'))) return true;
  return ['wallpaper64.exe', 'wallpaper32.exe', 'bin\\wallpaper64.exe', 'bin\\wallpaper32.exe']
    .some(function (name) { return isFile(path.join(dir, name)); });
}

function steamEngineDirs(lib) {
  const dirs = [path.join(lib, 'steamapps', 'common', 'wallpaper_engine')];
  try {
    const acf = fs.readFileSync(path.join(lib, 'steamapps', 'appmanifest_431960.acf'), 'utf8');
    const m = acf.match(/"installdir"\s+"([^"]+)"/i);
    if (m && m[1]) dirs.unshift(path.join(lib, 'steamapps', 'common', m[1].replace(/\\\\/g, '\\')));
  } catch (e) { /* ignore */ }
  const seen = new Set();
  return dirs.filter(function (dir) {
    const key = pathKey(dir);
    if (seen.has(key) || !validEngineDir(dir)) return false;
    seen.add(key);
    return true;
  });
}

function wallpaperUninstallDirs() {
  const dirs = new Set();
  const roots = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
  ];
  for (const root of roots) {
    let out;
    try {
      out = execFileSync('reg', ['query', root, '/s'], {
        encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024
      });
    } catch (e) { continue; }
    let display = '';
    let install = '';
    function flush() {
      if (/wallpaper\s*engine/i.test(display) && install) dirs.add(path.win32.normalize(install.replace(/"/g, '').trim()));
      display = '';
      install = '';
    }
    for (const line of out.split(/\r?\n/)) {
      if (/^HKEY_/i.test(line.trim())) { flush(); continue; }
      let m = line.match(/^\s*DisplayName\s+REG(?:_EXPAND)?_SZ\s+(.+)$/i);
      if (m) { display = m[1].trim(); continue; }
      m = line.match(/^\s*InstallLocation\s+REG(?:_EXPAND)?_SZ\s+(.+)$/i);
      if (m) install = m[1].trim();
    }
    flush();
  }
  return [...dirs];
}

function runningEngineDirs() {
  const dirs = new Set();
  try {
    const script = 'Get-Process -Name wallpaper64,wallpaper32 -ErrorAction SilentlyContinue | ForEach-Object { $_.Path }';
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', windowsHide: true, timeout: 5000
    });
    for (const line of out.split(/\r?\n/)) {
      const exe = line.trim();
      if (!exe || !isFile(exe)) continue;
      let dir = path.dirname(exe);
      if (/^bin(?:32|64)?$/i.test(path.basename(dir))) dir = path.dirname(dir);
      if (validEngineDir(dir)) dirs.add(dir);
    }
  } catch (e) { /* ignore */ }
  return [...dirs];
}

function commonWeGameDirs() {
  const dirs = new Set();
  const rels = [
    ['WeGameApps', 'wallpaper_engine'], ['WeGameApps', 'Wallpaper Engine'],
    ['WeGame', 'wallpaper_engine'], ['WeGame', 'apps', 'wallpaper_engine'],
    ['Tencent', 'WeGameApps', 'wallpaper_engine'], ['Tencent', 'WeGame', 'apps', 'wallpaper_engine'],
    ['RailApps', 'wallpaper_engine']
  ];
  for (let n = 67; n <= 90; n++) {
    const drive = String.fromCharCode(n) + ':\\';
    if (!isDirectory(drive)) continue;
    for (const rel of rels) {
      const dir = path.join.apply(path, [drive].concat(rel));
      if (validEngineDir(dir)) dirs.add(dir);
    }
  }
  return [...dirs];
}

/* 直接在各盘符根目录 / 常见目录里找壁纸引擎本体，
   覆盖"壁纸引擎装在 G 盘、又没进注册表卸载项"的情况。 */
function driveEngineDirs() {
  const dirs = new Set();
  for (const dir of driveRootDirs()) {
    if (validEngineDir(dir)) dirs.add(dir);
    const steamCommon = path.join(dir, 'steamapps', 'common', 'wallpaper_engine');
    if (validEngineDir(steamCommon)) dirs.add(steamCommon);
    for (const name of ['Wallpaper Engine', 'wallpaper_engine', 'WallpaperEngine']) {
      const sub = path.join(dir, name);
      if (validEngineDir(sub)) dirs.add(sub);
    }
  }
  return [...dirs];
}

function additionalEngines() {
  const result = [];
  const seen = new Set();
  function add(dir, forceWeGame) {
    if (!validEngineDir(dir)) return;
    const resolved = canonicalPath(dir);
    const key = resolved.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const wegame = forceWeGame || /wegame|rail|tencent/i.test(resolved);
    result.push({ dir: resolved, source: wegame ? 'wegame' : 'auto' });
  }
  for (const dir of wallpaperUninstallDirs()) add(dir, false);
  for (const dir of commonWeGameDirs()) add(dir, true);
  for (const dir of driveEngineDirs()) add(dir, false);
  for (const dir of runningEngineDirs()) add(dir, false);
  return result;
}

// ---------- 扫描壁纸 ----------

function projectFile(dir, declared) {
  if (!declared) return '';
  const file = path.resolve(dir, String(declared));
  const rel = path.relative(dir, file);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return '';
  return isFile(file) ? file : '';
}

function pickPreview(dir, declared) {
  const names = [];
  if (declared) names.push(String(declared));
  names.push('preview.jpg', 'preview.gif', 'preview.png', 'preview.webp');
  for (const name of names) {
    const file = projectFile(dir, name);
    if (file) return file;
  }
  return '';
}

function findVideo(dir, declared) {
  const candidates = [];
  if (declared) candidates.push(String(declared));
  try {
    for (const name of fs.readdirSync(dir)) {
      if (VIDEO_EXT.indexOf(path.extname(name).toLowerCase()) >= 0) candidates.push(name);
    }
  } catch (e) { /* ignore */ }
  for (const name of candidates) {
    if (VIDEO_EXT.indexOf(path.extname(name).toLowerCase()) < 0) continue;
    const file = projectFile(dir, name);
    if (file) return file;
  }
  return '';
}

function makeLibrary(source, root, label, savedId) {
  const resolved = canonicalPath(root);
  const key = resolved.toLowerCase();
  const pref = state.libraryStates[key];
  const names = { steam: 'Steam', wegame: 'WeGame', auto: 'Wallpaper Engine', manual: '自定义库' };
  return {
    id: savedId || (source + '-' + shortHash(key)),
    label: String(label || (names[source] + ' · ' + (path.basename(resolved) || resolved))).slice(0, 100),
    path: resolved,
    source: source,
    enabled: pref ? pref.enabled : true,
    removable: source === 'manual',
    itemCount: 0,
    truncated: false
  };
}

function registerLibrary(ctx, library) {
  const key = library.path.toLowerCase();
  const existing = ctx.libraryByPath.get(key);
  if (existing) return existing;
  ctx.libraryByPath.set(key, library);
  ctx.libraries.push(library);
  return library;
}

function generatedProjectId(library, root, dir) {
  const rel = path.relative(root, dir) || path.basename(dir);
  return (library.source === 'manual' ? 'm:' : 'g:') + shortHash(library.id + '|' + rel.toLowerCase());
}

const PROP_LABELS = {
  ui_browse_properties_scheme_color: '配色方案'
};

function cleanPropText(value) {
  return String(value == null ? '' : value)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(div|p|li|h\d)>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#x([0-9a-f]+);/gi, function (_, n) { return String.fromCharCode(parseInt(n, 16)); })
    .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(Number(n)); })
    .replace(/\s+/g, ' ')
    .trim();
}

/* 读取 Wallpaper Engine 项目里 project.json → general.properties 的自定义属性，
   供面板生成与壁纸引擎一致的调节项。 */
function projectProperties(meta) {
  const src = meta && meta.general && meta.general.properties;
  if (!src || typeof src !== 'object') return [];
  const out = [];
  for (const key of Object.keys(src)) {
    const p = src[key];
    if (!p || typeof p !== 'object') continue;
    const type = String(p.type || '').toLowerCase();
    if (!type || type === 'group') continue;
    /* 只保留真正需要用户调节的属性：滑块、开关、颜色、下拉、短文本。
       纯展示文字、链接、文件/目录、脚本等一律不在面板里出现。 */
    if (type !== 'slider' && type !== 'color' && type !== 'bool' && type !== 'combo' && type !== 'textinput') continue;
    if (typeof p.value === 'string') {
      const text = p.value.trim();
      if (/imgr/i.test(text) || /^https?:\/\//i.test(text) || text.length > 80) continue;
    }
    let label = cleanPropText(p.text);
    if (PROP_LABELS[label]) label = PROP_LABELS[label];
    /* 未翻译的内部 key（例如 ui_browse_properties_xxx）没有展示价值。 */
    if (!label || /^ui_[a-z0-9_]+$/i.test(label)) continue;
    const prop = { key: key, label: label.slice(0, 60), type: type, value: p.value };
    if (p.min !== undefined) prop.min = p.min;
    if (p.max !== undefined) prop.max = p.max;
    if (p.step !== undefined) prop.step = p.step;
    if (Array.isArray(p.options)) {
      /* combo 选项既可能是字符串数组，也可能是 {label, value} 对象数组。 */
      prop.options = p.options.map(function (o, index) {
        if (o && typeof o === 'object') {
          return {
            label: cleanPropText(o.label !== undefined ? o.label : o.value) || String(index),
            value: o.value !== undefined ? o.value : String(index)
          };
        }
        return { label: String(o), value: String(index) };
      });
    }
    if (p.order !== undefined) prop.order = Number(p.order) || 0;
    out.push(prop);
  }
  out.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
  return out;
}

function addProject(ctx, dir, id, library) {
  const projectJson = path.join(dir, 'project.json');
  const canonical = canonicalPath(dir);
  if (ctx.seenProjects.has(canonical.toLowerCase())) return;
  let raw;
  try { raw = fs.readFileSync(projectJson, 'utf8'); } catch (e) { return; }
  let meta;
  try { meta = JSON.parse(stripBom(raw)); } catch (e) { return; }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return;
  ctx.seenProjects.add(canonical.toLowerCase());

  const type = String(meta.type || '').toLowerCase();
  const preview = pickPreview(dir, meta.preview);
  const videoFile = findVideo(dir, meta.file);
  const declaredFile = projectFile(dir, meta.file);
  let scenePkg = '';
  let sceneEntry = '';
  let webEntry = '';
  if (type === 'scene') {
    if (declaredFile && path.extname(declaredFile).toLowerCase() === '.pkg') scenePkg = declaredFile;
    else sceneEntry = declaredFile;
    if (!scenePkg) scenePkg = projectFile(dir, 'scene.pkg');
    if (!scenePkg && !sceneEntry) sceneEntry = projectFile(dir, 'scene.json');
  }
  if (type === 'web') {
    if (declaredFile && /^\.html?$/i.test(path.extname(declaredFile))) webEntry = declaredFile;
    if (!webEntry) webEntry = projectFile(dir, 'index.html');
  }
  let imageFile = '';
  if (declaredFile && IMAGE_EXT.indexOf(path.extname(declaredFile).toLowerCase()) >= 0) imageFile = declaredFile;
  if (!imageFile) imageFile = preview;
  const kind = (scenePkg || sceneEntry) ? 'scene' : (webEntry ? 'web' : (videoFile ? 'video' : 'image'));
  const props = (kind === 'scene' || kind === 'web') ? projectProperties(meta) : [];
  if (!preview && !videoFile && !imageFile && !scenePkg && !sceneEntry && !webEntry) return;

  if (ctx.byId.has(id)) id += ':' + shortHash(canonical).slice(0, 8);
  const item = {
    id: id,
    title: String(meta.title || path.basename(dir)).trim().slice(0, 120),
    type: type,
    typeLabel: TYPE_LABEL[type] || '壁纸',
    tags: Array.isArray(meta.tags) ? meta.tags.slice(0, 3).map(String) : [],
    preview: preview ? SCHEME + '://img/preview/' + encodeURIComponent(id) : '',
    thumb: preview ? SCHEME + '://img/thumb/' + encodeURIComponent(id) : '',
    kind: kind,
    source: library.source,
    libraryId: library.id,
    adult: /questionable|mature/i.test(String(meta.contentrating || ''))
  };
  if (props.length) item.props = props;
  ctx.byId.set(id, {
    dir: canonical,
    projectJson: projectJson,
    preview: preview,
    image: imageFile,
    video: videoFile,
    scenePkg: scenePkg,
    sceneEntry: sceneEntry,
    webEntry: webEntry,
    kind: kind,
    props: props,
    source: library.source,
    libraryId: library.id
  });
  ctx.items.push(item);
  library.itemCount++;
}

function scanDirectProjects(ctx, base, library, legacyPrefix) {
  let dirs;
  try { dirs = fs.readdirSync(base, { withFileTypes: true }); } catch (e) { return; }
  dirs.sort(function (a, b) { return a.name.localeCompare(b.name); });
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(base, d.name);
    const id = legacyPrefix ? legacyPrefix + d.name : generatedProjectId(library, library.path, dir);
    addProject(ctx, dir, id, library);
  }
}

function scanProjectTree(ctx, root, library) {
  const queue = [{ dir: root, depth: 0 }];
  const visited = new Set();
  let count = 0;
  while (queue.length) {
    if (count >= MAX_MANUAL_DIRS) { library.truncated = true; break; }
    const current = queue.shift();
    const key = pathKey(current.dir);
    if (visited.has(key)) continue;
    visited.add(key);
    count++;
    if (isFile(path.join(current.dir, 'project.json'))) {
      addProject(ctx, current.dir, generatedProjectId(library, root, current.dir), library);
      continue;
    }
    if (current.depth >= MAX_MANUAL_DEPTH) continue;
    let dirs;
    try { dirs = fs.readdirSync(current.dir, { withFileTypes: true }); } catch (e) { continue; }
    dirs.sort(function (a, b) { return a.name.localeCompare(b.name); });
    for (const d of dirs) {
      if (d.isDirectory() && d.name !== '.git' && d.name !== 'node_modules') {
        queue.push({ dir: path.join(current.dir, d.name), depth: current.depth + 1 });
      }
    }
  }
}

function scanAll() {
  const ctx = { items: [], byId: new Map(), libraries: [], libraryByPath: new Map(), seenProjects: new Set() };
  const steamRoots = steamLibraries();
  let engineFound = false;

  /* 创意工坊扫描不依赖主程序 exe 是否定位成功；旧 w:/l: ID 保持不变。 */
  for (const root of steamRoots) {
    const library = registerLibrary(ctx, makeLibrary('steam', root));
    if (!library.enabled) continue;
    const engines = steamEngineDirs(root);
    const workshop = path.join(root, 'steamapps', 'workshop', 'content', '431960');
    if (engines.length || isDirectory(workshop)) engineFound = true;
    scanDirectProjects(ctx, workshop, library, 'w:');
    for (const engine of engines) {
      scanDirectProjects(ctx, path.join(engine, 'projects', 'myprojects'), library, 'l:');
      scanDirectProjects(ctx, path.join(engine, 'projects', 'defaultprojects'), library, 'l:');
    }
  }

  for (const detected of additionalEngines()) {
    if (steamRoots.some(function (root) { return insidePath(root, detected.dir); })) continue;
    engineFound = true;
    const label = (detected.source === 'wegame' ? 'WeGame' : 'Wallpaper Engine') + ' · ' + path.basename(detected.dir);
    const library = registerLibrary(ctx, makeLibrary(detected.source, detected.dir, label));
    if (library.enabled) scanProjectTree(ctx, library.path, library);
  }

  for (const saved of state.manualLibraries) {
    const library = makeLibrary('manual', saved.path, saved.label, saved.id);
    if (!state.libraryStates[library.path.toLowerCase()]) library.enabled = saved.enabled !== false;
    const registered = registerLibrary(ctx, library);
    if (registered.enabled) scanProjectTree(ctx, registered.path, registered);
  }

  ctx.items.sort(function (a, b) {
    return String(a.title).localeCompare(String(b.title), 'zh-Hans-CN');
  });
  ensureBuiltinItems(ctx);
  state.items = ctx.items;
  state.byId = ctx.byId;
  /* 首次扫描完成后，按当前启动动画模式联动桌面壁纸（如 moon → 内置 moon 壁纸）。 */
  if (!initialModeSyncDone) {
    initialModeSyncDone = true;
    try { applyModeWallpaperSync(); } catch (e) { log('warn', 'initial mode sync: ' + String(e && e.message || e)); }
  }
  state.libraries = ctx.libraries;
  state.error = null;
  if (!ctx.items.length) {
    state.error = (engineFound || state.manualLibraries.length)
      ? { code: 'NO_PROJECTS', message: '已检测到壁纸库，但没有可读取的壁纸项目' }
      : { code: 'ENGINE_MISSING', message: '未检测到 Wallpaper Engine、WeGame 壁纸或自定义壁纸库' };
  }
  state.scannedAt = Date.now();
  if (state.bgId && !ctx.byId.has(state.bgId)) {
    state.bgId = '';
    state.enabled = false;
    saveState();
  }
  log('info', 'scan: ' + ctx.items.length + ' items, libraries=' + ctx.libraries.length + ', bg=' + state.bgId);
  return ctx.items.length;
}

function libraryResult(wc, ok, message) {
  if (!wc) return;
  runIn(wc, 'window.__mhubWpLibraryResult&&window.__mhubWpLibraryResult(' + toJs({ ok: !!ok, message: String(message || '') }) + ')');
}

function refreshLibraries(wc, message) {
  scanAll();
  pushState();
  pushBackground();
  pushCropPreview();
  for (const target of startupTargets()) injectStartup(target, true);
  if (message) libraryResult(wc, true, message);
}

function addManualLibrary(rawPath, wc) {
  const input = String(rawPath || '').trim();
  if (!input) { libraryResult(wc, false, '请选择壁纸库目录'); return false; }
  const resolved = path.resolve(input);
  if (path.parse(resolved).root === resolved) {
    libraryResult(wc, false, '不能直接添加磁盘根目录，请选择具体壁纸库目录');
    return false;
  }
  if (!isDirectory(resolved)) { libraryResult(wc, false, '目录不存在或不可访问'); return false; }
  const root = canonicalPath(resolved);
  const key = root.toLowerCase();
  if (state.manualLibraries.some(function (lib) { return pathKey(lib.path) === key; }) ||
      state.libraries.some(function (lib) { return pathKey(lib.path) === key; })) {
    libraryResult(wc, false, '该目录已在壁纸来源列表中');
    return false;
  }
  state.manualLibraries.push({
    id: 'manual-' + shortHash(key),
    label: path.basename(root) || root,
    path: root,
    source: 'manual',
    enabled: true
  });
  state.libraryStates[key] = { enabled: true };
  saveState();
  refreshLibraries(wc, '壁纸库已添加');
  return true;
}

function chooseManualLibrary(wc) {
  const el = electron();
  if (!el || !el.dialog || typeof el.dialog.showOpenDialog !== 'function') {
    libraryResult(wc, false, '当前环境无法打开目录选择器');
    return;
  }
  el.dialog.showOpenDialog({ title: '选择 Wallpaper Engine 或壁纸项目目录', properties: ['openDirectory'] })
    .then(function (result) {
      if (result.canceled || !result.filePaths || !result.filePaths[0]) return;
      addManualLibrary(result.filePaths[0], wc);
    })
    .catch(function (e) { libraryResult(wc, false, e && e.message ? e.message : '目录选择失败'); });
}

function updateLibrary(payload, wc) {
  if (!payload || typeof payload !== 'object') return;
  const id = String(payload.id || '');
  const library = state.libraries.find(function (item) { return item.id === id; });
  const manualIndex = state.manualLibraries.findIndex(function (item) { return item.id === id; });
  if (!library && manualIndex < 0) { libraryResult(wc, false, '壁纸来源不存在，请刷新后重试'); return; }
  if (payload.remove) {
    if (manualIndex < 0) { libraryResult(wc, false, '自动检测的来源只能停用，不能移除'); return; }
    const removed = state.manualLibraries.splice(manualIndex, 1)[0];
    delete state.libraryStates[pathKey(removed.path)];
    saveState();
    refreshLibraries(wc, '已移除自定义壁纸库，磁盘文件未改动');
    return;
  }
  if (payload.enabled !== undefined && library) {
    const enabled = !!payload.enabled;
    state.libraryStates[library.path.toLowerCase()] = { enabled: enabled };
    if (manualIndex >= 0) state.manualLibraries[manualIndex].enabled = enabled;
    saveState();
    refreshLibraries(wc, enabled ? '壁纸来源已启用' : '壁纸来源已停用');
  }
}

// ---------- 预览图 / 背景图 ----------

const THUMB_CACHE_LIMIT = 32;
const THUMB_CACHE_CHAR_LIMIT = 8 * 1024 * 1024;
const thumbCache = new Map();
let thumbCacheChars = 0;

function electron() {
  try { return require('electron'); } catch (e) { return null; }
}

function imageDataUrl(file, width) {
  const el = electron();
  if (!el || !el.nativeImage) return '';
  try {
    let img = el.nativeImage.createFromPath(file);
    if (img.isEmpty()) return '';
    if (width > 0) {
      const size = img.getSize();
      if (size.width > width) img = img.resize({ width: width, quality: 'good' });
    }
    /* JPEG 比 PNG dataURL 小得多，且同时降低主进程字符串和渲染进程图片缓存。 */
    return 'data:image/jpeg;base64,' + img.toJPEG(82).toString('base64');
  } catch (e) {
    return '';
  }
}

function thumbFor(id) {
  const entry = state.byId.get(id);
  if (!entry || !entry.preview) return '';
  if (thumbCache.has(id)) {
    const cached = thumbCache.get(id);
    /* Map 的插入顺序同时作为 LRU 顺序。 */
    thumbCache.delete(id);
    thumbCache.set(id, cached);
    return cached;
  }
  const url = imageDataUrl(entry.preview, 420);
  if (url && url.length <= THUMB_CACHE_CHAR_LIMIT) {
    thumbCache.set(id, url);
    thumbCacheChars += url.length;
    while (thumbCache.size > THUMB_CACHE_LIMIT || thumbCacheChars > THUMB_CACHE_CHAR_LIMIT) {
      const oldest = thumbCache.keys().next().value;
      const value = thumbCache.get(oldest) || '';
      thumbCache.delete(oldest);
      thumbCacheChars -= value.length;
    }
  }
  return url;
}

// ---------- 协议 ----------

function fileType(ext) {
  const map = {
    '.gif': 'image/gif', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
    '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.glsl': 'text/plain; charset=utf-8',
    '.frag': 'text/plain; charset=utf-8', '.vert': 'text/plain; charset=utf-8',
    '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2'
  };
  return map[String(ext || '').toLowerCase()] || 'application/octet-stream';
}

function readRange(file, rangeHeader, type) {
  const stat = fs.statSync(file);
  const total = stat.size;
  const m = /bytes=(\d*)-(\d*)/i.exec(String(rangeHeader || ''));
  if (!m) {
    return {
      status: 200,
      headers: { 'Content-Type': type, 'Content-Length': String(total), 'Accept-Ranges': 'bytes' },
      body: fs.createReadStream(file)    };
  }
  let start = m[1] ? Number(m[1]) : 0;
  let end = m[2] ? Number(m[2]) : total - 1;
  if (!m[1] && m[2]) { start = Math.max(0, total - Number(m[2])); end = total - 1; }
  if (start > end || start >= total || end < 0) {
    return {
      status: 416,
      headers: { 'Content-Type': type, 'Content-Range': 'bytes */' + total, 'Accept-Ranges': 'bytes' },
      body: Buffer.alloc(0)
    };
  }
  end = Math.min(end, total - 1);
  const length = end - start + 1;
  /* 必须流式返回 Range：bytes=0- 在部分视频上会覆盖整个文件，
     原先的 Buffer.alloc(length) 会把数百 MB 视频直接留在主进程内存里。 */
  return {
    status: 206,
    headers: {
      'Content-Type': type,
      'Content-Length': String(length),
      'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
      'Accept-Ranges': 'bytes'
    },
    body: fs.createReadStream(file, { start: start, end: end })
  };
}

function resolveSceneAsset(entry, rawPath) {
  if (!entry || (entry.kind !== 'scene' && entry.kind !== 'web') || !entry.dir) return { status: 404 };
  const raw = String(rawPath || '');
  if (!raw || raw.length > 4096 || raw.indexOf('\\') >= 0 || raw.indexOf('\0') >= 0) return { status: 403 };
  const parts = [];
  const encoded = raw.split('/');
  for (const part of encoded) {
    let decoded;
    try { decoded = decodeURIComponent(part); } catch (e) { return { status: 400 }; }
    if (!decoded || decoded === '.' || decoded === '..' || /[\\/\0-\x1f]/.test(decoded)) return { status: 403 };
    parts.push(decoded);
  }

  let root;
  let file;
  try {
    root = fs.realpathSync(entry.dir);
    file = path.resolve(root, ...parts);
    const rel = path.relative(root, file);
    if (!rel || rel === '..' || rel.indexOf('..' + path.sep) === 0 || path.isAbsolute(rel)) return { status: 403 };
    /* realpath 同时拦住项目目录里指向库外的符号链接。 */
    file = fs.realpathSync(file);
    const realRel = path.relative(root, file);
    if (!realRel || realRel === '..' || realRel.indexOf('..' + path.sep) === 0 || path.isAbsolute(realRel)) return { status: 403 };
    if (!fs.statSync(file).isFile()) return { status: 404 };
  } catch (e) {
    return { status: 404 };
  }
  return { status: 200, file: file };
}

/* 普通包内资源只采样前几条，project.json/scene.pkg 与异常始终记录。 */
let sceneAssetLogCount = 0;

/* 路由结果统一用 {status, headers, body} 表示；body 为 Buffer / Node Readable。
   新版 Electron 在 installProtocol 里转成 Response，旧版直接交给 registerStreamProtocol。 */
function part(status, headers, body) {
  return { status: status, headers: headers || {}, body: body == null ? Buffer.alloc(0) : body };
}

/* 新版 request.headers 是 Headers 实例，旧版 registerStreamProtocol 是普通对象。 */
function headerOf(request, name) {
  try {
    const h = request && request.headers;
    if (!h) return '';
    if (typeof h.get === 'function') return h.get(name) || '';
    return h[name] || h[name.toLowerCase()] || '';
  } catch (e) { return ''; }
}

async function serveScheme(request) {
  try {
      const url = new URL(request.url);
      const host = url.hostname;
      const rawRel = (url.pathname || '/').replace(/^\/+/, '');
      /* 场景资源逐段解码并返回精确状态码，不能在进入分支前统一解码。 */
      const rel = host === 'scene' ? rawRel : decodeURIComponent(rawRel);

      if (host === 'img') {
        const m = rel.match(/^(preview|thumb|full)\/(.+)$/);
        if (!m) return part(404);
        const id = decodeURIComponent(m[2]);
        const entry = state.byId.get(id);
        if (!entry) return part(404);
        if (m[1] === 'thumb') {
          const dataUrl = thumbFor(id);
          if (dataUrl) {
            const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
            return part(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' }, Buffer.from(base64, 'base64'));
          }
          /* nativeImage 不认识部分 WebP/GIF 编码时，回退给 Chromium 直接解码原图，
             不能因为缩略图生成失败就让整个卡片变空白。 */
        }
        const imageFile = m[1] === 'full' ? (entry.image || entry.preview) : entry.preview;
        if (!imageFile) return part(404);
        let r;
        try {
          r = readRange(imageFile, headerOf(request, 'range'), fileType(path.extname(imageFile)));
        } catch (e) {
          return part(404);
        }
        /* 图片开场需要把壁纸画进 canvas 生成线稿，必须允许跨源读取像素 */
        return part(r.status, Object.assign({
          'Cache-Control': 'public, max-age=86400',
          'Access-Control-Allow-Origin': '*'
        }, r.headers), r.body);
      }

      if (host === 'media') {
        const m = rel.match(/^video\/(.+)$/);
        if (!m) return part(404);
        const entry = state.byId.get(decodeURIComponent(m[1]));
        if (!entry || !entry.video) return part(404);
        const r = readRange(entry.video, headerOf(request, 'range'), fileType(path.extname(entry.video)));
        return part(r.status, r.headers, r.body);
      }

      if (host === 'scene') {
        /* 仅暴露已入库项目的目录；ID 与资源路径分别解码，禁止编码斜线和穿越段。 */
        const m = rawRel.match(/^project\/([^/]+)\/(.+)$/);
        if (!m) {
          log('warn', 'scene request invalid url=' + request.url.slice(0, 1000));
          return part(404);
        }
        let id;
        try { id = decodeURIComponent(m[1]); } catch (e) { return part(400); }
        if (!id || /[\\/\0]/.test(id)) return part(403);
        const keyResource = m[2] === 'project.json' || m[2] === 'scene.pkg';
        const sampled = keyResource || sceneAssetLogCount < 12;
        if (!keyResource && sampled) sceneAssetLogCount++;
        const range = String(headerOf(request, 'range') || '').slice(0, 80);
        if (sampled) {
          log('info', 'scene request id=' + id + ' rel=' + m[2].slice(0, 500) +
            ' method=' + request.method + ' range=' + (range || '-') + ' url=' + request.url.slice(0, 1000));
        }
        if (request.method === 'OPTIONS') {
          if (sampled) log('info', 'scene response id=' + id + ' rel=' + m[2].slice(0, 500) + ' status=204 preflight');
          return part(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
            'Access-Control-Allow-Headers': 'Range, Content-Type',
            'Access-Control-Max-Age': '3600',
            'Cache-Control': 'no-store'
          });
        }
        const resolved = resolveSceneAsset(state.byId.get(id), m[2]);
        if (resolved.status !== 200) {
          log('warn', 'scene resolve id=' + id + ' rel=' + m[2].slice(0, 500) + ' status=' + resolved.status);
          return part(resolved.status, { 'Access-Control-Allow-Origin': '*' });
        }
        const r = readRange(resolved.file, range, fileType(path.extname(resolved.file)));
        const headers = Object.assign({
          'Cache-Control': 'public, max-age=3600',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Expose-Headers': 'Content-Type, Content-Length, Content-Range, Accept-Ranges',
          'X-Content-Type-Options': 'nosniff'
        }, r.headers);
        if (sampled || r.status >= 400) {
          log(r.status >= 400 ? 'warn' : 'info', 'scene response id=' + id + ' rel=' + m[2].slice(0, 500) +
            ' status=' + r.status + ' length=' + String(r.headers['Content-Length'] || '-') +
            ' contentRange=' + String(r.headers['Content-Range'] || '-'));
        }
        return part(r.status, headers, r.body);
      }

      if (host === 'splash') {
        /* 启动动画资源：asar 只按归档索引解析文件，新加的 splash.css / splash.js
           不会被读取，所以改由插件自己的目录提供。 */
        const base = path.join(__dirname, 'splash');
        const file = path.resolve(base, rel);
        if (file.indexOf(base) !== 0) return part(403);
        try {
          const st = fs.statSync(file);
          if (!st.isFile()) return part(404);
        } catch (e) {
          return part(404);
        }
        const r = readRange(file, headerOf(request, 'range'), fileType(path.extname(file)));
        const headers = Object.assign({ 'Cache-Control': 'no-store' }, r.headers);
        return part(r.status, headers, r.body);
      }

      if (host === 'ui') {
        /* 裁剪预览小窗页面：走自定义协议，避免 data: 页面拿不到 mchose-wallpaper:// 资源 */
        if (rel === 'crop-preview') {
          return part(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, Buffer.from(cropHtml(), 'utf8'));
        }
        /* 启动动画预览的空白宿主页：和自定义协议同源，壁纸 / 启动素材都能正常加载。
           预览内容由 previewSplash 注入，避免 file:// 页面触发正式启动页的挂载流程。 */
        if (rel === 'splash-preview') {
          const shell = '<!doctype html><html class="theme-dark"><head><meta charset="utf-8">' +
            '<style>html,body{width:100%;height:100%;margin:0;padding:0;overflow:hidden;background:transparent}</style>' +
            '</head><body></body></html>';
          return part(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, Buffer.from(shell, 'utf8'));
        }
        return part(404);
      }

      return part(404);
    } catch (e) {
      log('warn', 'protocol error: ' + String(e && (e.stack || e.message) || e).slice(0, 2000));
      return part(500, { 'Access-Control-Allow-Origin': '*' });
    }
}

/* Electron 25+ 用 protocol.handle（Response API）；旧版 Electron 只有 registerStreamProtocol，
   需要把同一个路由结果转换成旧版回包格式。 */
function installProtocol(el) {
  if (!el || !el.protocol) return;
  if (typeof el.protocol.handle === 'function') {
    try { el.protocol.unhandle(SCHEME); } catch (e) { /* ignore */ }
    el.protocol.handle(SCHEME, function (request) {
      return Promise.resolve().then(function () { return serveScheme(request); }).then(function (res) {
        const status = res.status || 200;
        if (status === 204 || status === 205 || status === 304) {
          return new Response(null, { status: status, headers: res.headers || {} });
        }
        let body = res.body;
        if (body && typeof body.pipe === 'function') {
          try { body = Readable.toWeb(body); } catch (e) { body = Buffer.alloc(0); }
        }
        return new Response(body == null ? '' : body, { status: status, headers: res.headers || {} });
      });
    });
    return;
  }
  if (typeof el.protocol.registerStreamProtocol === 'function') {
    try { el.protocol.unregisterProtocol(SCHEME); } catch (e) { /* ignore */ }
    el.protocol.registerStreamProtocol(SCHEME, function (request, callback) {
      Promise.resolve().then(function () { return serveScheme(request); }).then(function (res) {
        let data = res.body;
        if (data == null) data = Buffer.alloc(0);
        else if (typeof data === 'string') data = Buffer.from(data, 'utf8');
        callback({ statusCode: res.status || 200, headers: res.headers || {}, data: data });
      }).catch(function (e) {
        log('warn', 'protocol legacy error: ' + String(e && e.message || e).slice(0, 500));
        callback({ statusCode: 500 });
      });
    });
    log('info', 'protocol registered (legacy stream, electron=' + process.versions.electron + ')');
    return;
  }
  log('warn', 'protocol API unavailable, electron=' + process.versions.electron);
}

// ---------- 状态与下行 ----------

function snapshot() {
  return {
    v: 3,
    version: VERSION,
    author: AUTHOR,
    items: state.items,
    libraries: state.libraries,
    bgId: state.bgId,
    enabled: state.enabled,
    overlayOfficial: state.overlayOfficial,
    favorites: state.favorites,
    recent: state.recent,
    rotation: state.rotation,
    scenePerformance: state.scenePerformance,
    beautify: state.beautify,
    props: state.props,
    splash: state.splash,
    hotkeys: state.hotkeys,
    hotkeyErrors: state.hotkeyErrors,
    error: state.error,
    at: state.scannedAt
  };
}

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

function toJs(value) {
  return JSON.stringify(value).replace(/[\u2028\u2029]/g, function (ch) {
    return ch === LS ? '\\u2028' : '\\u2029';
  });
}

function runIn(wc, code) {
  try {
    const p = wc.executeJavaScript(code, false);
    if (p && typeof p.catch === 'function') p.catch(function () { /* ignore */ });
  } catch (e) { /* ignore */ }
}

function targetWebContents() {
  const el = electron();
  if (!el) return [];
  try { return el.webContents.getAllWebContents().filter(isTarget); } catch (e) { return []; }
}

function pushState(target) {
  const code = 'window.__mhubWpReceive&&window.__mhubWpReceive(' + toJs(snapshot()) + ')';
  const list = target ? [target] : targetWebContents();
  if (!list.length) log('warn', 'pushState: no targets');
  for (const wc of list) {
    try {
      const p = wc.executeJavaScript(code, false);
      if (p && typeof p.then === 'function') p.catch(function (e) { log('warn', 'pushState failed: ' + (e && e.message)); });
    } catch (e) {
      log('warn', 'pushState threw: ' + (e && e.message));
    }
  }
}

function resolveProps(id) {
  const entry = state.byId.get(id);
  const list = entry && entry.props;
  if (!list || !list.length) return null;
  const saved = state.props[id] || {};
  const out = {};
  for (const p of list) {
    out[p.key] = saved[p.key] !== undefined ? saved[p.key] : p.value;
  }
  return out;
}

function backgroundMedia() {
  const entry = state.byId.get(state.bgId);
  if (!entry) return null;
  const kind = entry.kind || (entry.video ? 'video' : 'image');
  return {
    id: state.bgId,
    kind: kind,
    image: entry.preview || entry.image ? SCHEME + '://img/full/' + encodeURIComponent(state.bgId) : '',
    video: kind === 'video' && entry.video ? (SCHEME + '://media/video/' + encodeURIComponent(state.bgId)) : '',
    sceneBase: kind === 'scene' || kind === 'web' ? SCHEME + '://scene/project/' + encodeURIComponent(state.bgId) + '/' : '',
    performance: state.scenePerformance,
    props: resolveProps(state.bgId)
  };
}

// ---------- 裁剪预览小窗 ----------

let cropWin = null;

function cropPayload() {
  const b = state.beautify;
  const posX = Math.min(100, Math.max(0, Number(b.posX === undefined ? 50 : b.posX) || 0));
  const posY = Math.min(100, Math.max(0, Number(b.posY === undefined ? 50 : b.posY) || 0));
  const fit = b.fit === 'tile' ? 'cover' : (b.fit || 'cover');
  const parts = [];
  if (Number(b.blur) > 0) parts.push('blur(' + Number(b.blur) + 'px)');
  if (Number(b.brightness) !== 100) parts.push('brightness(' + Number(b.brightness) + '%)');
  if (Number(b.saturation) !== 100) parts.push('saturate(' + Number(b.saturation) + '%)');
  return {
    media: backgroundMedia(),
    fit: fit,
    posX: posX,
    posY: posY,
    scale: Math.min(160, Math.max(100, Number(b.scale) || 100)) / 100,
    filter: parts.join(' '),
    dim: Math.min(90, Math.max(0, Number(b.dim) || 0)) / 100,
    accent: /^#[0-9a-f]{6}$/i.test(String(state.accent || '')) ? state.accent : '#1f63ff'
  };
}

function pushCropPreview() {
  if (!cropWin || cropWin.isDestroyed()) return;
  runIn(cropWin.webContents, 'window.__mhubWpPreview&&window.__mhubWpPreview(' + toJs(cropPayload()) + ')');
}

function cropHtml() {
  return '<!doctype html><html><head><meta charset="utf-8"><style>' +
    'html,body{margin:0;height:100%;background:transparent;overflow:hidden;' +
    'font-family:"Microsoft YaHei UI","Segoe UI",sans-serif;-webkit-user-select:none;cursor:default}' +
    '.win{position:absolute;inset:0;border-radius:12px;overflow:hidden;background:rgba(10,14,22,.94);' +
    'border:1px solid rgba(255,255,255,.14);box-shadow:0 18px 48px rgba(0,0,0,.55)}' +
    '.bar{height:32px;display:flex;align-items:center;gap:8px;padding:0 10px;' +
    'background:linear-gradient(180deg,rgba(255,255,255,.09),rgba(255,255,255,.02));' +
    '-webkit-app-region:drag;color:#dce5f5;font-size:12px}' +
    '.dot{width:7px;height:7px;border-radius:50%;background:#1f63ff;box-shadow:0 0 8px #1f63ff;flex:none}' +
    '.ttl{font-weight:600;letter-spacing:.4px}' +
    '.hint{margin-left:auto;font-size:11px;opacity:.42;white-space:nowrap}' +
    '.x{-webkit-app-region:no-drag;width:22px;height:20px;border:0;border-radius:6px;' +
    'background:rgba(255,255,255,.08);color:#c8d3e6;font-size:14px;line-height:1;cursor:pointer;' +
    'display:flex;align-items:center;justify-content:center;padding:0}' +
    '.x:hover{background:rgba(255,78,78,.38);color:#fff}' +
    '.stage{position:absolute;left:0;right:0;top:32px;bottom:0;overflow:hidden;cursor:grab}' +
    '.stage.grabbing{cursor:grabbing}' +
    '#node{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:50% 50%;' +
    'transform-origin:center;pointer-events:none}' +
    '#dim{position:absolute;left:0;right:0;top:32px;bottom:0;background:#000;opacity:0;pointer-events:none}' +
    '.foot{position:absolute;left:0;right:0;bottom:0;height:26px;display:flex;align-items:center;' +
    'justify-content:center;font-size:11px;color:#e8eefb;letter-spacing:.4px;pointer-events:none;' +
    'background:linear-gradient(0deg,rgba(0,0,0,.55),rgba(0,0,0,0))}' +
    '</style></head><body><div class="win">' +
    '<div class="bar"><span class="dot"></span><span class="ttl">裁剪预览</span>' +
    '<span class="hint">拖动画面调整位置 · 滚轮缩放 · Esc 关闭</span>' +
    '<button class="x" id="close">×</button></div>' +
    '<div class="stage" id="stage"><img id="node" alt=""></div><div id="dim"></div>' +
    '<div class="foot" id="foot"></div></div>' +
    '<script>(function(){' +
    'var node=document.getElementById("node"),dim=document.getElementById("dim"),stage=document.getElementById("stage"),' +
    'foot=document.getElementById("foot"),dot=document.querySelector(".dot");' +
    'var st={posX:50,posY:50,zoom:100},drag=null,sendTimer=0,videoMode=false;' +
    'function clamp(v,a,b){return Math.min(b,Math.max(a,v));}' +
    'function paint(){}' +
    'function footText(){return "位置 "+Math.round(st.posX)+"% / "+Math.round(st.posY)+"%  ·  缩放 "+Math.round(st.zoom)+"%";}' +
    'function apply(){if(!node)return;node.style.objectPosition=st.posX+"% "+st.posY+"%";' +
    'node.style.transform="scale("+(st.zoom/100)+")";foot.textContent=footText();}' +
    'function send(){var code=JSON.stringify({t:"beautify",payload:{posX:Math.round(st.posX),posY:Math.round(st.posY),scale:Math.round(st.zoom)}});' +
    'console.log("[mhub-wp]"+code);}' +
    'function sendSoon(){if(sendTimer)return;sendTimer=setTimeout(function(){sendTimer=0;send();},70);}' +
    'window.__mhubWpPreview=function(m){try{' +
    'if(!m||!m.media)return;' +
    'if(m.accent){dot.style.background=m.accent;dot.style.boxShadow="0 0 8px "+m.accent;}' +
    'var isVideo=m.media.kind==="video";' +
    'if(videoMode!==isVideo){var e=document.createElement(isVideo?"video":"img");e.id="node";' +
    'if(isVideo){e.muted=true;e.loop=true;e.autoplay=true;e.playsInline=true;}' +
    'node.parentNode.replaceChild(e,node);node=e;videoMode=isVideo;}' +
    'var src=isVideo?m.media.video:m.media.image;' +
    'if(node.getAttribute("src")!==src){node.src=src;if(isVideo)node.play().catch(function(){});}' +
    'node.style.objectFit=m.fit;node.style.filter=m.filter||"none";dim.style.opacity=String(m.dim||0);' +
    'if(!drag){st.posX=m.posX;st.posY=m.posY;st.zoom=Math.round((m.scale||1)*100);}' +
    'apply();}catch(err){}};' +
    'stage.addEventListener("pointerdown",function(ev){' +
    'drag={x:ev.clientX,y:ev.clientY,px:st.posX,py:st.posY,w:stage.clientWidth,h:stage.clientHeight};' +
    'stage.classList.add("grabbing");stage.setPointerCapture(ev.pointerId);});' +
    'stage.addEventListener("pointermove",function(ev){if(!drag)return;' +
    'st.posX=clamp(drag.px-(ev.clientX-drag.x)/drag.w*100,0,100);' +
    'st.posY=clamp(drag.py-(ev.clientY-drag.y)/drag.h*100,0,100);' +
    'apply();sendSoon();});' +
    'function endDrag(ev){if(!drag)return;drag=null;stage.classList.remove("grabbing");try{stage.releasePointerCapture(ev.pointerId);}catch(e){}send();}' +
    'stage.addEventListener("pointerup",endDrag);stage.addEventListener("pointercancel",endDrag);' +
    'stage.addEventListener("wheel",function(ev){ev.preventDefault();' +
    'st.zoom=clamp(st.zoom+(ev.deltaY<0?4:-4),100,160);apply();sendSoon();},{passive:false});' +
    'document.getElementById("close").addEventListener("click",function(){window.close();});' +
    'document.addEventListener("keydown",function(ev){if(ev.key==="Escape")window.close();});' +
    '})();</script></body></html>';
}

function openCropWindow() {
  const el = electron();
  if (!el || !el.BrowserWindow) return;
  if (cropWin && !cropWin.isDestroyed()) { cropWin.show(); cropWin.focus(); pushCropPreview(); return; }
  let x;
  let y;
  try {
    const main = mainBrowserWindow();
    if (main && !main.isDestroyed()) {
      const b = main.getBounds();
      x = Math.round(b.x + b.width - 600 - 36);
      y = Math.round(b.y + b.height - 400 - 52);
    }
  } catch (e) { /* ignore */ }
  cropWin = new el.BrowserWindow({
    width: 600,
    height: 400,
    x: x,
    y: y,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    title: '裁剪预览',
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  cropWin.loadURL(SCHEME + '://ui/crop-preview');
  cropWin.webContents.on('did-finish-load', function () { pushCropPreview(); });
  cropWin.webContents.on('console-message', function () {
    const args = Array.prototype.slice.call(arguments);
    let text = null;
    if (typeof args[2] === 'string') text = args[2];
    else if (args[0] && typeof args[0].message === 'string') text = args[0].message;
    else if (typeof args[1] === 'string') text = args[1];
    if (!text || text.indexOf(PREFIX) !== 0) return;
    handleUplink(text.slice(PREFIX.length), cropWin && cropWin.webContents);
  });
  cropWin.on('closed', function () { cropWin = null; });
}

function closeCropWindow() {
  if (cropWin && !cropWin.isDestroyed()) cropWin.close();
  cropWin = null;
}

function pushBackground(target) {
  const media = backgroundMedia();
  const code = 'window.__mhubWpMedia&&window.__mhubWpMedia(' + toJs(media) + ')';
  const list = target ? [target] : targetWebContents();
  for (const wc of list) runIn(wc, code);
}

function pushThumb(target, id) {
  const code = 'window.__mhubWpThumb&&window.__mhubWpThumb(' + toJs(id) + ',' + toJs(thumbFor(id)) + ')';
  const list = target ? [target] : targetWebContents();
  for (const wc of list) runIn(wc, code);
}

// ---------- 启动页背景同步 ----------

let startupCache = { id: '', url: '' };

function isStartup(wc) {
  try {
    return STARTUP_URL_RE.test(wc.getURL() || '');
  } catch (e) {
    return false;
  }
}

function pushSplashConfig(wc) {
  const list = wc ? [wc] : startupTargets();
  if (!list.length) return;
  const code = '(function(){try{' +
    'window.__MHUBSplashConfig=' + toJs(splashConfigForInject()) + ';' +
    'if(window.__MHUBApplySplashConfig)window.__MHUBApplySplashConfig(window.__MHUBSplashConfig);' +
    'return "ok";}catch(e){return "err:"+e.message;}})()';
  for (const target of list) runIn(target, code);
}

function startupTargets() {
  const el = electron();
  if (!el) return [];
  try { return el.webContents.getAllWebContents().filter(isStartup); } catch (e) { return []; }
}

/* 启动页背景优先走自定义协议（mchose-wallpaper://img/preview/<id>），
   避免把整张大图转成 base64 data URL 塞进 executeJavaScript 导致
   "Array buffer allocation failed" 或注入失败。协议由 installProtocol 注册，
   所有窗口（含真实启动页与预览窗口）均可访问。 */
function startupBgUrl(id) {
  const entry = state.byId.get(id);
  if (!entry || !entry.preview) return '';
  return SCHEME + '://img/preview/' + encodeURIComponent(id);
}

function splashBg() {
  const s = state.splash;
  if (!s.enabled || s.bgMode === 'off') return null;
  if (s.bgMode === 'color') return { kind: 'color', color: String(s.bgColor || '#05070c') };
  const id = s.bgMode === 'custom' ? String(s.bgId || '') : state.bgId;
  if (!id) return null;
  const entry = state.byId.get(id);
  if (!entry) return null;
  /* 视频壁纸优先用视频本身：preview 一般是 1024px 以下的小图，
     放到全屏启动页里放大后会明显发糊；视频是原始分辨率，清晰得多。 */
  if (entry.kind === 'video' || (!entry.kind && entry.video)) {
    return {
      kind: 'video',
      id: id,
      url: SCHEME + '://media/video/' + encodeURIComponent(id),
      poster: startupBgUrl(id)
    };
  }
  const url = startupBgUrl(id);
  if (!url) return null;
  return { kind: 'image', id: id, url: url };
}

/* ---------- 启动动画：挂载到官方启动页 ----------
   asar 只按归档索引解析，往 app.asar.unpacked 里新增 splash.css / splash.js 不会被读取，
   而 startup-loading.html 还会按归档记录的尺寸被截断。因此保留官方启动页作为宿主窗口，
   由插件在 dom-ready 时替换页面内容并注入自己的动画运行时和样式。 */
const SPLASH_DIR = path.join(__dirname, 'splash');
let splashRuntime = null;

function buildSplashRuntime() {
  if (splashRuntime) return splashRuntime;
  function read(name) { return fs.readFileSync(path.join(SPLASH_DIR, name), 'utf8'); }
  const html = read('startup-loading.html');
  const m = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  splashRuntime = {
    markup: m ? m[1] : '',
    css: read('splash.css'),
    js: read('splash.js'),
    assetBase: SCHEME + '://splash/startup-assets/'
  };
  return splashRuntime;
}

/* 缎带书写的 Three.js 动画包。启动页是 file:// 页面，跨源 <script> 在个别
   Electron 版本里会静默挂起（既没有 onload 也没有 onerror），表现为只剩背景、
   一直卡在启动页。这里改由主进程按顺序直接注入，执行失败会写进日志。 */
let launcherBundleCache = null;
function launcherBundleCode() {
  if (launcherBundleCache != null) return launcherBundleCache;
  launcherBundleCache = fs.readFileSync(
    path.join(SPLASH_DIR, 'startup-assets', 'modes', 'launcher', 'launcher.bundle.js'),
    'utf8'
  );
  return launcherBundleCache;
}

function injectLauncherBundle(wc, mode) {
  if (mode !== 'launcher') return Promise.resolve();
  let code;
  try {
    code = launcherBundleCode();
  } catch (e) {
    log('warn', 'launcher bundle missing: ' + (e && e.message));
    return Promise.resolve();
  }
  return wc.executeJavaScript(code, false).then(function () {
    log('info', 'launcher bundle injected wc=' + wc.id + ' len=' + code.length);
  }).catch(function (e) {
    log('warn', 'launcher bundle inject failed: ' + (e && e.message));
  });
}

/* 上一次运行遗留的启动页窗口：它们被关闭拦截挡住后一直留在后台，
   里面的六幕授权动画还在继续放声音，听上去就像"每个动画都带授权音频"。 */
function closeStaleSplashWindows(current) {
  const el = electron();
  if (!el || !el.BrowserWindow) return;
  const previewWc = previewWin && !previewWin.isDestroyed() ? previewWin.webContents : null;
  /* 当前挂载的就是预览窗口时不动真正的启动页 */
  if (previewWc && previewWc === current) return;
  let list = [];
  try { list = el.webContents.getAllWebContents(); } catch (e) { return; }
  for (const wc of list) {
    if (wc === current || wc === previewWc || wc.isDestroyed()) continue;
    if (!isStartup(wc)) continue;
    try {
      const win = el.BrowserWindow.fromWebContents(wc);
      if (!win || win.isDestroyed()) continue;
      global.__mhubSplashForceClose = true;
      try { win.destroy(); } catch (e) { /* ignore */ }
      log('info', 'stale splash window closed wc=' + wc.id);
    } catch (e) { /* ignore */ }
    finally { global.__mhubSplashForceClose = false; }
  }
}

function mountSplash(wc) {
  /* 关闭启动动画时保留官方启动页，不替换内容。 */
  if (!splashAnimationOn()) return;
  try { closeStaleSplashWindows(wc); } catch (e) { /* ignore */ }
  let rt;
  try {
    rt = buildSplashRuntime();
  } catch (e) {
    /* 运行时缺失时不能继续拦截关闭，否则透明/残页窗口会长期盖住主界面。 */
    try { global.__mhubSplashFailed = true; } catch (_) {}
    log('error', 'splash runtime missing: ' + (e && e.message));
    return;
  }
  try { wc.insertCSS(rt.css); } catch (e) { /* ignore */ }
  /* 缎带书写要整屏透明画布。Windows 上透明窗口会走软件合成路径，
     画布层可能不被合成（动画在跑但屏幕上只剩壁纸）。先尝试给窗口一个不透明底色，
     让它回到正常合成路径；失败也不影响其它模式。 */
  try {
    let m0 = '';
    try { m0 = String(splashConfigForInject().mode || ''); } catch (e) { /* ignore */ }
    if (m0 === 'launcher') {
      const el = electron();
      const bw = el && el.BrowserWindow && el.BrowserWindow.fromWebContents(wc);
      if (bw && !bw.isDestroyed()) {
        bw.setBackgroundColor('#05060c');
        log('info', 'launcher: splash window background set opaque');
      }
    }
  } catch (e) { log('warn', 'launcher setBackgroundColor failed: ' + (e && e.message)); }
  const code = '(function(){try{' +
    'if(window.__MHUB_SPLASH_MOUNTED)return "mounted";' +
    'window.__MHUB_SPLASH_MOUNTED=1;' +
    /* 必须在 splash.js 执行前写入配置：mountSplash 在 dom-ready 才跑，
       而 attach 早期的注入可能落在 about:blank 上下文里被导航丢弃。
       缺少这一步时 splash.js 会读默认 mode=mhub，导致所有启动动画都播六幕授权。 */
    'window.__MHUBSplashConfig=' + toJs(splashConfigForInject()) + ';' +
    'window.__MHUB_SPLASH_ASSETS=' + toJs(rt.assetBase) + ';' +
    'if(!document.body)return "no body";' +
    'document.body.innerHTML=' + toJs(rt.markup) + ';' +
    'return "ok";}catch(e){return "err:"+e.message;}})()';
  const p = wc.executeJavaScript(code, false).then(function (r) {
    /* 已挂载过的窗口不再重复注入运行时，否则会创建第二套时间线/第二路声音。 */
    if (r === 'mounted') return;
    let mountMode = '';
    try { mountMode = String(splashConfigForInject().mode || ''); } catch (e) { /* ignore */ }
    return injectLauncherBundle(wc, mountMode).then(function () {
      return wc.executeJavaScript(rt.js, false).then(function () {
        try { global.__mhubSplashFailed = false; } catch (e) {}
        log('info', 'splash mounted wc=' + wc.id + ' (' + r + ')');
      });
    });
  });
  if (p && typeof p.catch === 'function') {
    p.catch(function (e) {
      try { global.__mhubSplashFailed = true; } catch (_) {}
      log('warn', 'splash mount failed: ' + (e && e.message));
    });
  }
}

function injectStartup(wc, force) {
  if (!isStartup(wc)) return;
  const s = state.splash;
  /* 关闭启动动画：官方启动页原样播放，不注入配置/背景，也不提前关闭。 */
  if (!s.enabled) return;
  const cfgSig = JSON.stringify(s);
  if (force || wc.__mhubSplashCfgSig !== cfgSig) {
    wc.__mhubSplashCfgSig = cfgSig;
    pushSplashConfig(wc);
  }

  const bg = splashBg();
  const blur = Math.max(0, Math.min(60, Number(s.bgBlur) || 0));
  const bright = Math.max(20, Math.min(300, Number(s.bgBrightness) || 100));
  const sat = Math.max(0, Math.min(220, Number(s.bgSaturation) || 100));
  const dim = Math.max(0, Math.min(90, Number(s.bgDim) || 0)) / 100;
  const scale = Math.max(1, Math.min(1.6, (Number(s.bgScale) || 100) / 100));
  const sig = JSON.stringify({ bg: bg, blur: blur, bright: bright, sat: sat, dim: dim, scale: scale, glass: !!s.glass, color: s.bgColor });
  if (!force && wc.__mhubStartupSig === sig) return;
  wc.__mhubStartupSig = sig;

  const filter = [];
  if (blur > 0) filter.push('blur(' + blur + 'px)');
  if (Math.round(bright) !== 100) filter.push('brightness(' + Math.round(bright) + '%)');
  if (Math.round(sat) !== 100) filter.push('saturate(' + Math.round(sat) + '%)');
  const imgStyle = 'width:100%;height:100%;display:block;object-fit:cover;' + (filter.length ? 'filter:' + filter.join(' ') + ';' : '');
  const mediaStyle = 'position:absolute;inset:0;transform:scale(' + scale + ');transform-origin:center;will-change:transform;';
  const bgCode = bg
    ? (bg.kind === 'color'
      ? '{kind:"color",color:' + toJs(bg.color) + '}'
      : (bg.kind === 'video'
        ? '{kind:"video",url:' + toJs(bg.url) + ',poster:' + toJs(bg.poster) + '}'
        : '{kind:"image",url:' + toJs(bg.url) + '}'))
    : 'null';

  const code = '(function(){try{' +
    'var id="mhub-startup-bg";' +
    'var old=document.getElementById(id);if(old&&old.parentNode)old.parentNode.removeChild(old);' +
    'var host=document.getElementById("startup-root")||document.body;if(!host)return "no host";' +
    /* 场景壁纸只有 ~1024px 预览图，放大后用 3×3 卷积锐化找回一些细节 */
    'if(!document.getElementById("mhub-startup-sharpen")){' +
    'var sw=document.createElement("div");sw.id="mhub-startup-sharpen";' +
    'sw.style.cssText="position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;";' +
    'sw.innerHTML=' + toJs('<svg width="0" height="0" aria-hidden="true"><filter id="mhubWpSharpen" color-interpolation-filters="sRGB"><feConvolveMatrix order="3" preserveAlpha="true" edgeMode="duplicate" kernelMatrix="0 -0.3 0 -0.3 2.2 -0.3 0 -0.3 0" /></filter></svg>') + ';' +
    'document.body.appendChild(sw);}' +
    'var bg=' + bgCode + ';' +
    'if(bg){' +
    'var d=document.createElement("div");d.id=id;' +
    'd.style.cssText="position:absolute;inset:0;z-index:0;overflow:hidden;pointer-events:none;";' +
    'if(bg.kind==="color"){d.style.background=bg.color;}' +
    'else{' +
    'var media=document.createElement("div");media.style.cssText=' + toJs(mediaStyle) + ';' +
    'if(bg.kind==="video"){' +
    'var v=document.createElement("video");v.src=bg.url;v.poster=bg.poster||"";v.muted=true;v.loop=true;v.autoplay=true;v.defaultMuted=true;v.setAttribute("muted","");v.setAttribute("playsinline","");v.setAttribute("disablepictureinpicture","");v.style.cssText=' + toJs(imgStyle) + ';' +
    'var tp=function(){try{var p=v.play();if(p&&p.catch)p.catch(function(){});}catch(e){}};' +
    'v.addEventListener("loadeddata",tp);v.addEventListener("canplay",tp);tp();' +
    'media.appendChild(v);}' +
    'else{' +
    'var img=document.createElement("img");img.alt="";img.src=bg.url;img.decoding="async";img.style.cssText=' + toJs(imgStyle + 'filter:url(#mhubWpSharpen);') + ';' +
    'media.appendChild(img);}' +
    'd.appendChild(media);}' +
    'var t=document.createElement("div");t.style.cssText="position:absolute;inset:0;background:#000;opacity:' + dim + ';";d.appendChild(t);' +
    'host.insertBefore(d,host.firstChild);}' +
    'var st=document.getElementById("mhub-startup-style");' +
    'if(!st){st=document.createElement("style");st.id="mhub-startup-style";document.head.appendChild(st);}' +
    'st.textContent="body{background:" + ' + toJs(String(s.bgColor || '#05070c')) + ' + " !important;}" + (' + (s.glass ? '""' : '".dsu-plate{background:transparent !important;}"') + ');' +
    'return "ok";}catch(e){return "err:"+e.message;}})()';
  try {
    const p = wc.executeJavaScript(code, false);
    if (p && typeof p.then === 'function') {
      p.then(function (r) {
        log('info', 'startup bg ' + r);
      }, function (e) {
        log('warn', 'startup inject: ' + (e && e.message));
      });
    }
  } catch (e) {
    log('warn', 'startup inject threw: ' + (e && e.message));
  }
}

// ---------- 操作 ----------

function setBackground(id) {
  const entry = state.byId.get(id);
  if (!entry) { log('warn', 'set: unknown id ' + id); return; }
  state.bgId = id;
  state.enabled = true;
  state.recent = [id].concat(state.recent.filter(function (recentId) { return recentId !== id; })).slice(0, 30);
  saveState();
  log('info', 'set background ' + id + ' (' + (entry.kind || 'image') + ')');
  pushBackground();
  pushState();
  pushCropPreview();
  for (const wc of startupTargets()) injectStartup(wc, true);
}

function resetBackground() {
  state.bgId = '';
  state.enabled = false;
  saveState();
  log('info', 'reset background');
  pushBackground();
  pushState();
  for (const wc of startupTargets()) injectStartup(wc, true);
}

function updateProps(payload) {
  const id = String(payload && payload.id || '');
  const entry = state.byId.get(id);
  const values = payload && payload.values;
  if (!entry || !entry.props || !entry.props.length || !values || typeof values !== 'object') return;
  const next = Object.assign({}, state.props[id] || {});
  let changed = false;
  for (const p of entry.props) {
    if (values[p.key] === undefined) continue;
    const v = values[p.key];
    const t = typeof v;
    if (t !== 'number' && t !== 'string' && t !== 'boolean') continue;
    next[p.key] = v;
    changed = true;
  }
  if (!changed) return;
  state.props[id] = next;
  saveState();
  pushBackground();
}

function updateFavorite(payload) {
  const id = String(payload && payload.id || '');
  if (!state.byId.has(id)) return;
  const index = state.favorites.indexOf(id);
  const favorite = payload.favorite === undefined ? index < 0 : !!payload.favorite;
  if (favorite && index < 0) state.favorites.push(id);
  if (!favorite && index >= 0) state.favorites.splice(index, 1);
  saveState();
  pushState();
}

const SCENE_PRESETS = {
  saver: { fps: 15, renderDpr: 0.75, videoTexScale: 0.5 },
  balanced: { fps: 30, renderDpr: 1, videoTexScale: 0.75 },
  quality: { fps: 60, renderDpr: 1.5, videoTexScale: 1 }
};

function updateScenePerformance(patch) {
  if (!patch || typeof patch !== 'object') return;
  const preset = /^(saver|balanced|quality)$/.test(patch.preset) ? patch.preset : state.scenePerformance.preset;
  Object.assign(state.scenePerformance, SCENE_PRESETS[preset], { preset: preset });
  if (patch.pauseWhenHidden !== undefined) state.scenePerformance.pauseWhenHidden = !!patch.pauseWhenHidden;
  saveState();
  pushState();
  pushBackground();
}

let rotationTimer = null;

function scheduleRotation() {
  if (rotationTimer) { clearInterval(rotationTimer); rotationTimer = null; }
  if (!state.rotation.enabled) return;
  rotationTimer = setInterval(function () {
    const rotation = state.rotation;
    const interval = Math.min(1440, Math.max(1, Number(rotation.intervalMinutes) || 30)) * 60000;
    const now = Date.now();
    if (now - (Number(rotation.lastRunAt) || 0) < interval) return;
    rotation.lastRunAt = now;
    randomBackground(rotation.scope);
    saveState();
  }, 15000);
}

function updateRotation(patch) {
  if (!patch || typeof patch !== 'object') return;
  const r = state.rotation;
  const wasEnabled = r.enabled;
  const oldInterval = r.intervalMinutes;
  if (patch.enabled !== undefined) r.enabled = !!patch.enabled;
  if (patch.intervalMinutes !== undefined && isFinite(Number(patch.intervalMinutes))) {
    r.intervalMinutes = Math.min(1440, Math.max(1, Number(patch.intervalMinutes)));
  }
  if (patch.scope !== undefined) r.scope = patch.scope === 'favorites' ? 'favorites' : 'all';
  if ((r.enabled && !wasEnabled) || r.intervalMinutes !== oldInterval) r.lastRunAt = Date.now();
  saveState();
  scheduleRotation();
  pushState();
}

function updateBeautify(patch) {
  if (!patch || typeof patch !== 'object') return;
  const b = state.beautify;
  const nums = { blur: [0, 60], brightness: [20, 180], dim: [0, 90], saturation: [0, 220], scale: [100, 160], speed: [0.3, 3], nativeBlur: [0, 50], nativeBrightness: [0, 100], deviceBlur: [0, 60], posX: [0, 100], posY: [0, 100] };
  for (const key of Object.keys(nums)) {
    if (patch[key] === undefined) continue;
    const n = Number(patch[key]);
    if (!isFinite(n)) continue;
    b[key] = Math.min(nums[key][1], Math.max(nums[key][0], n));
  }
  if (patch.fit !== undefined && /^(cover|contain|fill|tile)$/.test(patch.fit)) b.fit = patch.fit;
  if (patch.motion !== undefined && /^(none|kenburns|parallax|breathe)$/.test(patch.motion)) b.motion = patch.motion;
  if (patch.enabled !== undefined) state.enabled = !!patch.enabled && !!state.bgId;
  saveState();
  pushState();
  pushCropPreview();
}

function updateSplash(patch) {
  if (!patch || typeof patch !== 'object') return;
  const s = state.splash;
  const nums = {
    bgBlur: [0, 60], bgBrightness: [20, 180], bgDim: [0, 90], bgSaturation: [0, 220], bgScale: [100, 160],
    glassOpacity: [15, 95], glassBlur: [0, 60], glassSaturate: [100, 200], glassBackdropBlur: [0, 80],
    speed: [0.35, 3], sfxVolume: [0, 100], voiceVolume: [0, 100], voiceRate: [0.5, 1.5], voicePitch: [0.5, 1.5]
  };
  for (const key of Object.keys(nums)) {
    if (patch[key] === undefined) continue;
    const n = Number(patch[key]);
    if (!isFinite(n)) continue;
    s[key] = Math.min(nums[key][1], Math.max(nums[key][0], n));
  }
  const bools = ['enabled', 'glass', 'requireInteraction', 'allowSkip', 'startMaximized', 'sfx', 'voice'];
  for (const key of bools) {
    if (patch[key] !== undefined) s[key] = !!patch[key];
  }
  /* stages：只覆盖传入的键，未传的保留原值；确保最终有完整四键 */
  if (patch.stages && typeof patch.stages === 'object') {
    const def = DEFAULT_SPLASH.stages;
    const cur = s.stages || {};
    s.stages = {
      intro: patch.stages.intro !== undefined ? !!patch.stages.intro : (cur.intro !== false),
      setup: patch.stages.setup !== undefined ? !!patch.stages.setup : (cur.setup !== false),
      steps: patch.stages.steps !== undefined ? !!patch.stages.steps : (cur.steps !== false),
      welcome: patch.stages.welcome !== undefined ? !!patch.stages.welcome : (cur.welcome !== false)
    };
  } else if (!s.stages || typeof s.stages !== 'object') {
    s.stages = Object.assign({}, DEFAULT_SPLASH.stages);
  }
  if (patch.bgMode !== undefined && /^(follow|custom|color|off)$/.test(patch.bgMode)) s.bgMode = patch.bgMode;
  if (patch.mode !== undefined && /^(mhub|moon|gallery|dragon|launcher)$/.test(patch.mode)) {
    s.mode = patch.mode;
    /* 切换到 moon 模式时，桌面壁纸同步为内置「月光下的持剑少女」。 */
    if (s.mode === 'moon') {
      try { applyModeWallpaperSync(); } catch (e) { log('warn', 'mode sync: ' + String(e && e.message || e)); }
    }
  }
  if (patch.theme !== undefined && /^(auto|light|dark)$/.test(patch.theme)) s.theme = patch.theme;
  if (patch.voiceSource !== undefined) s.voiceSource = patch.voiceSource === 'tts' ? 'tts' : 'asset';
  for (const key of ['bgColor', 'accent', 'glitchA', 'glitchB']) {
    if (patch[key] !== undefined && /^#[0-9a-f]{6}$/i.test(String(patch[key]))) s[key] = String(patch[key]);
  }
  for (const key of ['bgId', 'identityName', 'identityId', 'accessLevel', 'welcomeName']) {
    if (patch[key] !== undefined) s[key] = String(patch[key]).slice(0, 64);
  }
  saveState();
  syncSplashFlag();
  const targets = startupTargets();
  for (const wc of targets) injectStartup(wc, true);
  pushState();
  log('info', 'splash updated: enabled=' + s.enabled + ' bg=' + s.bgMode + ' glass=' + s.glass + ' speed=' + s.speed);
}

let previewWin = null;
/* 启动动画只在本次应用启动的第一次打开时播放。
   应用切到后台、台前调度恢复、或二次创建启动页时都直接沿用官方启动页，不再播放。 */
let splashPlayedThisRun = false;

function previewSplash() {
  const el = electron();
  if (!el || !el.BrowserWindow) return 'no electron';
  try {
    if (previewWin && !previewWin.isDestroyed()) {
      previewWin.show();
      previewWin.focus();
      return 'focused';
    }
  } catch (e) { /* ignore */ }
  try {
    const win = new el.BrowserWindow({
      width: 1180,
      height: 740,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: true,
      resizable: true,
      show: true,
      title: 'M HUB Startup Preview',
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false }
    });
    previewWin = win;
    /* 走自定义协议的空白宿主页：同源，才能加载壁纸和启动素材。
       绝不能直接 loadFile(startup-loading.html)：那个 URL 会被 isStartup() 命中，
       dom-ready 时 mountSplash 会二次替换 body，导致已经启动的动画实例全部失效 → 黑屏。 */
    win.loadURL(SCHEME + '://ui/splash-preview');
    const wc = win.webContents;
    /* 预览窗口也记一份关键日志：动画自身报错 / 渲染诊断能直接落到插件日志里 */
    try {
      wc.on('console-message', function () {
        const args = Array.prototype.slice.call(arguments);
        let text = null;
        if (typeof args[2] === 'string') text = args[2];
        else if (args[0] && typeof args[0].message === 'string') text = args[0].message;
        else if (typeof args[1] === 'string') text = args[1];
        if (text && /mhub-wp-diag|Uncaught|WebGL|THREE|Shader/i.test(text)) {
          log('preview-console', String(text).slice(0, 500));
        }
      });
    } catch (e) { /* ignore */ }
    wc.once('did-finish-load', function () {
      let rt;
      try { rt = buildSplashRuntime(); } catch (e) {
        log('warn', 'splash preview runtime missing: ' + (e && e.message));
        return;
      }
      let cfg;
      try { cfg = splashConfigForInject(); } catch (e) { cfg = state.splash; }
      const mount = 'window.__MHUBSplashConfig=' + toJs(cfg) + ';' +
        'window.__MHUB_SPLASH_ASSETS=' + toJs(SCHEME + '://splash/startup-assets/') + ';' +
        'window.__MHUB_SPLASH_PREVIEW=1;' +
        'document.body.innerHTML=' + toJs(rt.markup) + ';';
      Promise.resolve().then(function () {
        return wc.insertCSS(rt.css);
      }).then(function () {
        return wc.executeJavaScript(mount, false);
      }).then(function () {
        return injectLauncherBundle(wc, cfg && cfg.mode);
      }).then(function () {
        return wc.executeJavaScript(rt.js, false);
      }).then(function () {
        log('info', 'splash preview mounted mode=' + (cfg && cfg.mode) + ' wc=' + wc.id);
      }).catch(function (e) {
        log('warn', 'splash preview mount failed: ' + (e && e.message));
      });
    });
    win.once('ready-to-show', function () { try { win.show(); win.focus(); } catch (e) { /* ignore */ } });
    win.on('closed', function () { if (previewWin === win) previewWin = null; });

    /* 预览窗口在终幕欢迎语结束后自动淡出关闭，避免一直挡在界面上 */
    const watch = setInterval(function () {
      if (win.isDestroyed()) { clearInterval(watch); return; }
      win.webContents.executeJavaScript('!!(window.__MHUBSplash && window.__MHUBSplash.welcomeDone)').then(function (done) {
        if (!done) return;
        clearInterval(watch);
        setTimeout(function () {
          if (!win.isDestroyed()) runIn(win.webContents, 'window.dismissStartup && window.dismissStartup(600)');
        }, 1600);
      }).catch(function () { /* ignore */ });
    }, 800);
    return 'preview';
  } catch (e) {
    log('warn', 'preview failed: ' + (e && e.message));
    return 'preview error: ' + (e && e.message);
  }
}

// ---------- 注入 ----------

let payloadCode = '';
let payloadHash = '';
let payloadAt = '';
let scenePayloadCode = '';
let scenePayloadHash = '';
let scenePayloadAt = '';

function buildPayload() {
  try {
    let file = path.join(RENDERER_DIR, 'shell.js');
    /* 仅开发调试时允许 %APPDATA%\MCHOSEHUB\wallpaper-hub\shell.js 覆盖内置版本。
       以前无条件优先会让旧的调试副本一直遮盖安装包里的新界面。 */
    if (process.env.MHUB_WP_DEV_SHELL === '1') {
      const override = path.join(DATA_DIR, 'shell.js');
      try {
        if (fs.statSync(override).isFile()) file = override;
      } catch (e) { /* ignore */ }
    }
    const signature = file + ':' + fs.statSync(file).mtimeMs;
    if (payloadCode && payloadAt === signature) return { code: payloadCode, hash: payloadHash };
    const code = fs.readFileSync(file, 'utf8');
    payloadHash = crypto.createHash('sha1').update(code).digest('hex').slice(0, 12);
    payloadCode = '(function(){try{\n' + code + '\n}catch(e){try{console.dir("[mhub-wp]"+JSON.stringify({t:"error",where:"shell",message:String(e&&e.message)}))}catch(_){}}})();';
    payloadAt = signature;
    return { code: payloadCode, hash: payloadHash };
  } catch (e) {
    log('error', 'shell.js missing: ' + (e && e.message));
    return null;
  }
}

function buildSceneRuntime() {
  try {
    const vendorFile = path.join(__dirname, 'vendor', 'webwallgl', 'webwallgl.global.min.js');
    const sceneFile = path.join(RENDERER_DIR, 'scene.js');
    /* 仅场景/网页壁纸按需加载；普通图片和视频不保留 WebWallGL 的 JS/纹理缓存。 */
    const files = [sceneFile, vendorFile];
    const signature = files.map(function (name) { return name + ':' + fs.statSync(name).mtimeMs; }).join('|');
    if (scenePayloadCode && scenePayloadAt === signature) return { code: scenePayloadCode, hash: scenePayloadHash };
    const code = files.map(function (name) { return fs.readFileSync(name, 'utf8'); }).join('\n;\n');
    scenePayloadHash = crypto.createHash('sha1').update(code).digest('hex').slice(0, 12);
    scenePayloadCode = '(function(){try{\n' + code +
      '\n;return {ok:!!(window.__mhubWpScene&&window.WebWallGL),version:window.__mhubWpScene&&window.__mhubWpScene.version||""};' +
      '}catch(e){return {ok:false,error:String(e&&e.message||e)};}})();';
    scenePayloadAt = signature;
    return { code: scenePayloadCode, hash: scenePayloadHash };
  } catch (e) {
    log('error', 'scene runtime missing: ' + (e && e.message));
    return null;
  }
}

const attached = new Set();
const injectedHash = new Map();
const sceneRuntimeHash = new Map();
const sceneRuntimePending = new Map();
const sceneRuntimeEpoch = new Map();

function isTarget(wc) {
  try {
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return false;
    const url = wc.getURL() || '';
    return APP_URL_RE.test(url);
  } catch (e) { return false; }
}

function inject(wc) {
  const payload = buildPayload();
  if (!payload || !isTarget(wc)) return;
  try {
    const p = wc.executeJavaScript(payload.code, false);
    if (p && typeof p.then === 'function') {
      p.then(function () {
        injectedHash.set(wc.id, payload.hash);
        log('info', 'injected wc=' + wc.id + ' hash=' + payload.hash);
        pushState(wc);
        if (state.bgId) pushBackground(wc);
        pushThumb(wc, state.bgId || (state.items[0] && state.items[0].id) || '');
      }, function (err) {
        log('warn', 'inject failed wc=' + wc.id + ': ' + (err && err.message));
      });
    }
  } catch (e) {
    log('warn', 'inject threw: ' + (e && e.message));
  }
}

function injectSceneRuntime(wc) {
  const payload = buildSceneRuntime();
  if (!payload || !isTarget(wc)) return;
  const epoch = sceneRuntimeEpoch.get(wc.id) || 0;
  if (sceneRuntimeHash.get(wc.id) === payload.hash) {
    runIn(wc, 'window.__mhubWpSceneRuntimeReady&&window.__mhubWpSceneRuntimeReady()');
    return;
  }
  const pending = sceneRuntimePending.get(wc.id);
  if (pending && pending.hash === payload.hash && pending.epoch === epoch) return;
  sceneRuntimePending.set(wc.id, { hash: payload.hash, epoch: epoch });
  let execution;
  try {
    execution = wc.executeJavaScript(payload.code, false);
  } catch (e) {
    sceneRuntimePending.delete(wc.id);
    log('warn', 'scene runtime inject threw wc=' + wc.id + ': ' + (e && e.message));
    runIn(wc, 'window.__mhubWpSceneRuntimeError&&window.__mhubWpSceneRuntimeError(' + toJs(String(e && e.message || e)) + ')');
    return;
  }
  Promise.resolve(execution).then(function (result) {
    const current = sceneRuntimePending.get(wc.id);
    if (current && current.epoch === epoch) sceneRuntimePending.delete(wc.id);
    if ((sceneRuntimeEpoch.get(wc.id) || 0) !== epoch || !isTarget(wc)) return;
    if (!result || !result.ok) throw new Error(result && result.error || 'WebWallGL unavailable');
    sceneRuntimeHash.set(wc.id, payload.hash);
    log('info', 'scene runtime injected wc=' + wc.id + ' hash=' + payload.hash + ' version=' + result.version);
    runIn(wc, 'window.__mhubWpSceneRuntimeReady&&window.__mhubWpSceneRuntimeReady()');
  }).catch(function (e) {
    const current = sceneRuntimePending.get(wc.id);
    if (current && current.epoch === epoch) sceneRuntimePending.delete(wc.id);
    if ((sceneRuntimeEpoch.get(wc.id) || 0) !== epoch || !isTarget(wc)) return;
    const message = String(e && e.message || e).slice(0, 300);
    log('warn', 'scene runtime inject failed wc=' + wc.id + ': ' + message);
    runIn(wc, 'window.__mhubWpSceneRuntimeError&&window.__mhubWpSceneRuntimeError(' + toJs(message) + ')');
  });
}

let splashMaxPending = false;

function mainBrowserWindow() {
  const el = electron();
  if (!el || !el.BrowserWindow) return null;
  for (const wc of targetWebContents()) {
    try {
      const win = el.BrowserWindow.fromWebContents(wc);
      if (win && !win.isDestroyed()) return win;
    } catch (e) { /* ignore */ }
  }
  return null;
}

function maximizeMainWindow() {
  const main = mainBrowserWindow();
  if (!main) return false;
  try {
    if (!main.isMaximized()) main.maximize();
    return true;
  } catch (e) { return false; }
}

function restoreMainWindow() {
  const main = mainBrowserWindow();
  if (!main) return;
  try { if (main.isMaximized()) main.unmaximize(); } catch (e) { /* ignore */ }
}

/* 启动默认最大化：真实启动页窗口自动铺满工作区，并一起最大化驱动主窗口。
   预览窗口（previewSplash 创建）不参与，避免预览也被放大。 */
function autoMaximizeStartup(wc) {
  if (!state.splash.startMaximized) return;
  if (wc.__mhubAutoMaxed) return;
  wc.__mhubAutoMaxed = true;
  setTimeout(function () {
    try {
      if (isStartup(wc)) splashWindowAction(wc, 'maximize');
    } catch (e) { /* ignore */ }
  }, 160);
}

function splashWindowAction(wc, action) {
  const el = electron();
  if (!el || !el.BrowserWindow) return 'no electron';
  let win = null;
  try { win = el.BrowserWindow.fromWebContents(wc); } catch (e) { return 'err:' + e.message; }
  if (!win || win.isDestroyed()) return 'no window';
  try {
    if (action === 'minimize') win.minimize();
    else if (action === 'maximize') {
      /* 驱动主窗口一起最大化；若主窗口还没创建，标记待补 */
      splashMaxPending = !maximizeMainWindow();
      /* 用工作区尺寸模拟最大化：固定尺寸窗口也能放大，还原时一定能回到原位置 */
      if (win.__mhubWinBounds) return 'already';
      const before = win.getBounds();
      win.__mhubWinBounds = before;
      win.__mhubWinResizable = win.isResizable();
      if (win.isMaximized()) win.unmaximize();
      if (!win.isResizable()) win.setResizable(true);
      let area = null;
      try { area = el.screen.getDisplayMatching(before).workArea; } catch (e) { area = null; }
      if (area) win.setBounds({ x: area.x, y: area.y, width: area.width, height: area.height });
      else win.maximize();
    }
    else if (action === 'unmaximize') {
      splashMaxPending = false;
      restoreMainWindow();
      const back = win.__mhubWinBounds;
      win.__mhubWinBounds = null;
      if (win.isFullScreen && win.isFullScreen()) win.setFullScreen(false);
      if (win.isMaximized()) win.unmaximize();
      if (back) {
        if (!win.isResizable()) win.setResizable(true);
        win.setBounds(back);
      }
      if (win.__mhubWinResizable === false) win.setResizable(false);
      win.__mhubWinResizable = null;
    }
    else if (action === 'close') win.close();
    else return 'bad action';
    log('info', 'splash window ' + action + ' wc=' + wc.id);
    return 'ok';
  } catch (e) {
    return 'err:' + e.message;
  }
}

function handleUplink(raw, wc) {  let msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }
  const t = msg && msg.t;
  if (t === 'ready' || t === 'list') {
    pushState(wc);
    if (state.bgId) pushBackground(wc);
    return;
  }
  if (t === 'set') { setBackground(msg.payload && msg.payload.id); return; }
  if (t === 'reset') { resetBackground(); return; }
  if (t === 'favorite') { updateFavorite(msg.payload); return; }
  if (t === 'rotation') { updateRotation(msg.payload); return; }
  if (t === 'scenePerformance') { updateScenePerformance(msg.payload); return; }
  if (t === 'sceneRuntimeNeeded') {
    const id = msg.payload && msg.payload.id;
    const entry = state.byId.get(id);
    if (id === state.bgId && entry && (entry.kind === 'scene' || entry.kind === 'web')) injectSceneRuntime(wc);
    return;
  }
  if (t === 'sceneStatus') {
    const p = msg.payload || {};
    log(p.level === 'info' ? 'info' : 'warn', 'scene: ' + JSON.stringify({
      id: p.id || '', phase: p.phase || '', status: p.status,
      url: String(p.url || '').slice(0, 1000), message: String(p.message || 'unknown').slice(0, 500)
    }));
    return;
  }
  if (t === 'beautify') { updateBeautify(msg.payload); return; }
  if (t === 'props') { updateProps(msg.payload); return; }
  if (t === 'overlayOfficial') {
    const value = msg.payload || {};
    state.overlayOfficial = !!value.enabled;
    saveState();
    log('info', 'overlay official layer: ' + (state.overlayOfficial ? 'on' : 'off'));
    pushState();
    pushBackground();
    return;
  }
  if (t === 'hotkeys') { updateHotkeys(msg.payload); return; }
  if (t === 'splash') { updateSplash(msg.payload); return; }
  if (t === 'splashPreview') { log('info', 'splash preview: ' + previewSplash()); return; }
  if (t === 'splashAllowClose') {
    /* JS 层 finish() 发出信号，允许主进程放行 splash 窗口的 close */
    try {
      const BrowserWindow = electron().BrowserWindow;
      const win = BrowserWindow.fromWebContents(wc);
      if (win && win.__mhubSplashProtected) {
        win.__mhubSplashAllowClose = true;
        try { win.setAlwaysOnTop(false); } catch (e) { /* ignore */ }
        log('info', 'splash ALLOWED close by JS finish signal');
      }
    } catch (_) {}
    return;
  }
  if (t === 'splashWin') { splashWindowAction(wc, msg.payload && msg.payload.action); return; }
  if (t === 'preview') {
    if (msg.payload && msg.payload.open) openCropWindow();
    else closeCropWindow();
    return;
  }
  if (t === 'refresh') { refreshLibraries(); return; }
  if (t === 'libraryAdd') { addManualLibrary(msg.payload && msg.payload.path, wc); return; }
  if (t === 'libraryChoose') { chooseManualLibrary(wc); return; }
  if (t === 'libraryUpdate') { updateLibrary(msg.payload, wc); return; }
  if (t === 'thumb') { pushThumb(wc, msg.payload && msg.payload.id); return; }
  if (t === 'error') { log('warn', 'page: ' + JSON.stringify(msg).slice(0, 400)); return; }
}

/* ★★★ 最彻底的 splash 关闭拦截：主进程拦截 BrowserWindow close + hide 事件
   不管主应用是直接 win.close()、还是调渲染进程的 window.close()、
   还是 win.hide() 然后 show 主窗口，这里都能拦住。
   拦截持续到 JS 层 finish() 放行（splashAllowClose）或页面标记 #done。 */
function installSplashGuard(wc) {
  if (!wc || wc.isDestroyed() || !isStartup(wc)) return;
  const el = electron();
  if (!el || !el.BrowserWindow) return;
  let win = null;
  try { win = el.BrowserWindow.fromWebContents(wc); } catch (e) { return; }
  if (!win || win.isDestroyed() || win.__mhubSplashProtected) return;
  win.__mhubSplashProtected = true;
  win.__mhubSplashAllowClose = false;
  win.__mhubSplashStartTime = Date.now();
  function release() {
    try { if (!win.isDestroyed()) win.setAlwaysOnTop(false); } catch (e) { /* ignore */ }
  }
  win.on('close', function (e) {
    const since = Date.now() - (win.__mhubSplashStartTime || Date.now());
    let url = '';
    let title = '';
    try {
      const other = win.webContents;
      url = other && !other.isDestroyed() ? (other.getURL() || '') : '';
      title = String(win.getTitle() || '');
    } catch (err) { /* ignore */ }
    const finished = win.__mhubSplashAllowClose ||
      url.indexOf('#done') !== -1 || title.indexOf('#done') !== -1;
    if (!finished) {
      try { log('info', 'splash close BLOCKED by main-process guard, since=' + since + 'ms'); } catch (_) {}
      /* BrowserWindow 的 close 事件只提供 preventDefault，没有 stopPropagation。 */
      try { if (e && typeof e.preventDefault === 'function') e.preventDefault(); } catch (_) {}
      return false;
    }
    release();
    try { log('info', 'splash close ALLOWED (finish signal), since=' + since + 'ms'); } catch (_) {}
    return true;
  });
  win.on('hide', function () {
    if (!win.__mhubSplashAllowClose) {
      try { log('info', 'splash HIDE blocked (main-process guard)'); } catch (_) {}
      setTimeout(function () { try { if (!win.isDestroyed() && !win.isMinimized()) win.show(); } catch (_) {} }, 0);
    }
  });
  win.on('closed', release);
  /* 驱动主窗口 ready-to-show 后会自己 show 到最前面，把启动页压下去——
     这正是"动画只播 1-2 秒就结束"的观感来源。启动动画期间让启动页始终置顶。 */
  try {
    win.setAlwaysOnTop(true, 'screen-saver');
    if (!win.isVisible()) win.show();
    win.focus();
  } catch (e) { /* ignore */ }
  try { log('info', 'splash main-process guard installed, win=' + win.id + ' wc=' + wc.id); } catch (_) {}
}

function attach(wc) {
  if (!wc) return;
  /* 窗口刚创建时 URL 还是 about:blank，isStartup 判定不出来；
     只在"首次 attach"里装拦截会永远装不上，所以这里每次都要尝试（内部按窗口去重）。 */
  if (!splashPlayedThisRun) {
    try { installSplashGuard(wc); } catch (e) { log('warn', 'main-process splash guard install failed: ' + (e && e.message)); }
  }
  if (!attached.has(wc.id)) {
    attached.add(wc.id);

    /* 启动页配置必须在 splash.js 加载前就位。
       attach 绑定在 'web-contents-created' 事件——窗口刚创建时 URL 是 about:blank，
       isStartup(wc) 判断不出来，所以**无条件**对所有新 wc 注入配置：
       executeJavaScript 在窗口还没 load 时也不会报错，只是排队等 DOM ready 执行。
       splash.js 是 HTML 里的同步 <script>，解析到标签时才执行，那时配置已在 window 上。 */
    try {
      runIn(wc, 'try{window.__MHUBSplashConfig=' + toJs(splashConfigForInject()) + ';}catch(e){}');
    } catch (e) { /* ignore — 极少数情况下窗口已销毁 */ }
    try {
      wc.on('console-message', function () {
        const args = Array.prototype.slice.call(arguments);
        let text = null;
        if (typeof args[2] === 'string') text = args[2];
        else if (args[0] && typeof args[0].message === 'string') text = args[0].message;
        else if (typeof args[1] === 'string') text = args[1];
        if (!text || text.indexOf(PREFIX) !== 0) {
          if (text && /mhub-wp|Uncaught|SyntaxError|TypeError|ReferenceError|WebGL|THREE|Shader/i.test(text)) {
            log('page-console', String(text).slice(0, 400));
          }
          return;
        }
        handleUplink(text.slice(PREFIX.length), wc);
      });
    } catch (e) { log('warn', 'console hook failed: ' + (e && e.message)); }
    try {
      wc.on('did-finish-load', function () {
        injectedHash.delete(wc.id);
        sceneRuntimeHash.delete(wc.id);
        sceneRuntimePending.delete(wc.id);
        sceneRuntimeEpoch.set(wc.id, (sceneRuntimeEpoch.get(wc.id) || 0) + 1);
        if (isTarget(wc)) setTimeout(function () { inject(wc); }, 250);
      });
    } catch (e) { /* ignore */ }
    /* ★ 场景壁纸属性面板消失修复：SPA 路由切换（退出主题设置再进）
       不会触发 did-finish-load，但会触发 did-navigate。
       每次 navigate 后重新 pushState 确保 panel 组件拿到 props 数据。 */
    try {
      wc.on('did-navigate', function () {
        if (isTarget(wc)) {
          setTimeout(function () {
            try { inject(wc); } catch (_) {}
            try { pushState(wc); } catch (_) {}
          }, 300);
        }
      });
    } catch (e) { /* ignore */ }
    try {
      wc.on('destroyed', function () {
        attached.delete(wc.id);
        injectedHash.delete(wc.id);
        sceneRuntimeHash.delete(wc.id);
        sceneRuntimePending.delete(wc.id);
        sceneRuntimeEpoch.delete(wc.id);
      });
    } catch (e) { /* ignore */ }
    try {
      wc.on('dom-ready', function () {
        if (!isStartup(wc)) return;
        /* 只在本次运行的第一次打开播放；后台恢复 / 台前调度 / 二次显示都不播 */
        if (splashPlayedThisRun) {
          try { log('info', 'startup animation skipped (already played this run)'); } catch (_) {}
          return;
        }
        splashPlayedThisRun = true;
        /* 页面就绪时 URL 已经确定，这里立即装拦截/置顶，别等 1.2s 轮询。 */
        try { installSplashGuard(wc); } catch (e) { /* ignore */ }
        mountSplash(wc);
        setTimeout(function () { injectStartup(wc, true); }, 220);
        if (!previewWin || previewWin.isDestroyed() || previewWin.webContents !== wc) autoMaximizeStartup(wc);
      });
    } catch (e) { /* ignore */ }
    try {
      wc.on('did-finish-load', function () {
        if (isStartup(wc) && splashPlayedThisRun) setTimeout(function () { injectStartup(wc, true); }, 200);
      });
    } catch (e) { /* ignore */ }
  }
  if (isStartup(wc)) {
    if (!splashPlayedThisRun) {
      injectStartup(wc);
      if (!previewWin || previewWin.isDestroyed() || previewWin.webContents !== wc) autoMaximizeStartup(wc);
    }
    return;
  }
  if (isTarget(wc)) {
    const payload = buildPayload();
    if (payload && injectedHash.get(wc.id) !== payload.hash) inject(wc);
  }
}

// ---------- 本地调试桥（采集/截图） ----------

let cmdSeen = '';
async function runCommand(cmd) {
  const el = electron();
  if (!el) return 'no electron';
  if (cmd && cmd.cmd === 'show') {
    try {
      const wins = el.BrowserWindow.getAllWindows();
      let hit = null;
      for (const win of wins) {
        try { if (isTarget(win.webContents)) { hit = win; break; } } catch (e) { /* ignore */ }
      }
      if (!hit) return 'no window';
      if (hit.isMinimized()) hit.restore();
      hit.show();
      hit.maximize();
      hit.focus();
      return 'shown';
    } catch (e) {
      return 'show error: ' + (e && e.message);
    }
  }
  if (cmd && cmd.cmd === 'shot') {
    try {
      const wc = targetWebContents()[0];
      if (!wc) return 'no target';
      const image = await wc.capturePage();
      fs.writeFileSync(SHOT_FILE, image.toPNG());
      return 'shot:' + SHOT_FILE;
    } catch (e) {
      return 'shot error: ' + (e && e.message);
    }
  }
  if (cmd && cmd.cmd === 'memory') {
    try {
      const targets = targetWebContents();
      const targetStats = [];
      for (const wc of targets) {
        try {
          const value = await wc.executeJavaScript('(function(){var p=performance.memory||{};var w=window.__mhubWallpaper;return {url:location.href,usedJSHeapBytes:p.usedJSHeapSize||0,totalJSHeapBytes:p.totalJSHeapSize||0,webWallGL:!!window.WebWallGL,wallpaper:w&&w.memoryInfo?w.memoryInfo():null};})()', false);
          targetStats.push({ id: wc.id, stats: value });
        } catch (e) {
          targetStats.push({ id: wc.id, error: String(e && e.message || e) });
        }
      }
      const metrics = typeof el.app.getAppMetrics === 'function' ? el.app.getAppMetrics() : [];
      return JSON.stringify({
        capturedAt: new Date().toISOString(),
        main: { pid: process.pid, memoryUsage: process.memoryUsage() },
        appMetrics: metrics.map(function (m) {
          return {
            pid: m.pid,
            type: m.type,
            memory: m.memory || null,
            workingSetMB: m.memory && m.memory.workingSetSize ? Math.round(m.memory.workingSetSize / 1024 * 100) / 100 : null
          };
        }),
        wallpaper: {
          thumbEntries: thumbCache.size,
          thumbChars: thumbCacheChars,
          sceneRuntimeTargets: sceneRuntimeHash.size,
          targets: targetStats
        }
      });
    } catch (e) {
      return 'memory error: ' + (e && e.message);
    }
  }
  if (cmd && cmd.cmd === 'hotkey') {
    try {
      if (cmd.action === 'random') return 'random=' + randomBackground();
      return 'cycle=' + cycleBackground(Number(cmd.step) || 1);
    } catch (e) {
      return 'hotkey error: ' + (e && e.message);
    }
  }
  if (!cmd || typeof cmd.expr !== 'string') return 'bad cmd';
  const wc = targetWebContents()[0];
  if (!wc) return 'no target';
  try {
    const value = await wc.executeJavaScript(cmd.expr, false);
    let out;
    try { out = JSON.stringify(value); } catch (e) { out = String(value); }
    return out === undefined ? 'undefined' : out;
  } catch (e) {
    return 'EXC: ' + (e && e.message);
  }
}

function devBridge() {
  let stat;
  try { stat = fs.statSync(CMD_FILE); } catch (e) { return; }
  const sig = stat.mtimeMs + ':' + stat.size;
  if (sig === cmdSeen) return;
  cmdSeen = sig;
  const cmd = readJson(CMD_FILE);
  runCommand(cmd).then(function (result) {
    try {
      ensureDir(DATA_DIR);
      fs.writeFileSync(OUT_FILE, JSON.stringify({ at: Date.now(), result: result }));
      fs.unlinkSync(CMD_FILE);
    } catch (e) { /* ignore */ }
  });
}

// ---------- 全局快捷键 ----------

function cycleBackground(step) {
  const list = state.items;
  if (!list.length) return 'empty';
  let idx = list.findIndex(function (it) { return it.id === state.bgId; });
  if (idx < 0) idx = step > 0 ? -1 : 0;
  const next = list[(idx + step + list.length) % list.length];
  if (!next) return 'none';
  setBackground(next.id);
  log('info', 'hotkey cycle -> ' + next.id);
  return next.id;
}

function randomBackground(scope) {
  const favorites = new Set(state.favorites);
  const list = scope === 'favorites'
    ? state.items.filter(function (item) { return favorites.has(item.id); })
    : state.items;
  if (!list.length) return 'empty';
  const pool = list.filter(function (it) { return it.id !== state.bgId; });
  const candidates = pool.length ? pool : list;
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  if (!pick) return 'none';
  setBackground(pick.id);
  log('info', 'random (' + (scope === 'favorites' ? 'favorites' : 'all') + ') -> ' + pick.id);
  return pick.id;
}

let hotkeysDone = false;

const HOTKEY_ACTIONS = {
  next: function () { cycleBackground(1); },
  prev: function () { cycleBackground(-1); },
  random: function () { randomBackground(); },
  toggle: function () {
    state.enabled = !state.enabled && !!state.bgId;
    if (!state.bgId) state.enabled = false;
    saveState();
    pushState();
    pushBackground();
    pushCropPreview();
    log('info', 'hotkey toggle enabled=' + state.enabled);
  },
  preview: function () { openCropWindow(); }
};

function sanitizeAccel(text) {
  const raw = String(text || '').replace(/\s+/g, '');
  if (!raw) return '';
  const parts = raw.split('+');
  const key = parts.pop();
  const mods = [];
  for (const p of parts) {
    const low = p.toLowerCase();
    if (low === 'ctrl' || low === 'control') { if (mods.indexOf('Ctrl') < 0) mods.push('Ctrl'); }
    else if (low === 'alt') { if (mods.indexOf('Alt') < 0) mods.push('Alt'); }
    else if (low === 'shift') { if (mods.indexOf('Shift') < 0) mods.push('Shift'); }
    else if (low === 'super' || low === 'win' || low === 'meta') { if (mods.indexOf('Super') < 0) mods.push('Super'); }
    else return '';
  }
  if (!mods.length) return '';
  let k = key;
  if (/^[a-z]$/i.test(k)) k = k.toUpperCase();
  else if (/^[0-9]$/.test(k)) { /* keep */ }
  else if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(k)) k = k.toUpperCase();
  else if (!/^(Left|Right|Up|Down|Space|Enter|Escape|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Plus|Minus|Comma|Period|Slash|Semicolon|Quote|Brackets?Left|Brackets?Right)$/.test(k)) return '';
  return mods.join('+') + '+' + k;
}

function updateHotkeys(patch) {
  if (!patch || typeof patch !== 'object') return;
  for (const key of Object.keys(DEFAULT_HOTKEYS)) {
    if (patch[key] === undefined) continue;
    const val = sanitizeAccel(patch[key]);
    if (patch[key] !== '' && !val) continue;
    state.hotkeys[key] = val;
  }
  saveState();
  registerHotkeys();
  pushState();
}

const registeredHotkeys = new Set();

function unregisterWallpaperHotkeys(el) {
  if (!el || !el.globalShortcut) return;
  for (const accel of registeredHotkeys) {
    try { el.globalShortcut.unregister(accel); } catch (e) { /* ignore */ }
  }
  registeredHotkeys.clear();
}

function registerHotkeys() {
  const el = electron();
  if (!el || !el.globalShortcut) return;
  unregisterWallpaperHotkeys(el);
  const errors = [];
  const used = {};
  for (const action of Object.keys(HOTKEY_ACTIONS)) {
    const accel = String(state.hotkeys[action] || '');
    if (!accel) continue;
    if (used[accel]) { errors.push({ action: action, accel: accel, reason: 'duplicate' }); continue; }
    used[accel] = true;
    try {
      const ok = el.globalShortcut.register(accel, HOTKEY_ACTIONS[action]);
      if (ok) registeredHotkeys.add(accel);
      else errors.push({ action: action, accel: accel, reason: 'occupied' });
    } catch (e) {
      errors.push({ action: action, accel: accel, reason: 'error' });
    }
  }
  state.hotkeyErrors = errors;
  if (errors.length) log('warn', 'hotkey issues: ' + JSON.stringify(errors));
  if (!hotkeysDone) {
    hotkeysDone = true;
    try {
      el.app.on('will-quit', function () { unregisterWallpaperHotkeys(el); });
    } catch (e) { /* ignore */ }
  }
}

// ---------- 启动 ----------

function boot() {
  const el = electron();
  if (!el) return;
  const app = el.app;

  try {
    if (el.protocol && !app.isReady() && typeof el.protocol.registerSchemesAsPrivileged === 'function') {
      el.protocol.registerSchemesAsPrivileged([{
        scheme: SCHEME,
        privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
      }]);
    }
  } catch (e) { log('warn', 'scheme register failed: ' + (e && e.message)); }

  const start = function () {
    installProtocol(el);
    scanAll();
    scheduleRotation();

    try {
      app.on('web-contents-created', function (_e, wc) { attach(wc); });
      el.webContents.getAllWebContents().forEach(attach);
    } catch (e) { log('warn', 'attach failed: ' + (e && e.message)); }

    const timer = setInterval(function () {
      try { el.webContents.getAllWebContents().forEach(attach); } catch (e) { /* ignore */ }
      try { if (splashMaxPending) splashMaxPending = !maximizeMainWindow(); } catch (e) { /* ignore */ }
      try { devBridge(); } catch (e) { /* ignore */ }
    }, 1200);
    if (timer.unref) timer.unref();

    registerHotkeys();
    log('info', 'plugin ready v2, pid=' + process.pid);
  };

  try {
    if (app.isReady()) start();
    else app.whenReady().then(start).catch(function (e) { log('error', 'whenReady failed: ' + (e && e.message)); });
  } catch (e) {
    log('error', 'boot failed: ' + (e && e.message));
  }
}

try { boot(); } catch (e) { log('error', 'boot threw: ' + (e && e.message)); }
