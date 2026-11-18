'use strict';
// config.json / status.json 的读写：原子写（临时文件 + rename），读写全部吞错。

const fs = require('fs');
const path = require('path');
const P = require('./paths.js');

const DEFAULT_CONFIG = {
  version: 3,
  pluginEnabled: true,
  collapsed: true,          // 默认收进顶部导航，点芯片展开面板
  navLayout: 1,             // 布局版本：面板挂在导航下方
  theme: 'auto',            // auto | light | dark
  position: { left: 1, top: 0 },
  weatherCity: '',          // 手动指定的城市；留空则按 IP 粗略定位
  docked: true,             // true=吸附在顶部导航下方，false=自由拖动
  desktopOpen: false,       // 桌面悬浮窗是否显示（随 M HUB 重启恢复）
  desktopPos: null,         // 桌面悬浮窗位置 { x, y }
  sample: { intervalMs: 1000, histLen: 60 },
  net: { enabled: true, pollMs: 2000 },
  disk: { enabled: true },
  lunar: { enabled: true },
  battery: { enabled: true },
  weather: { enabled: true, refreshMin: 30, location: '', forecast: true },
  countdownEnabled: true,
  countdowns: []            // [{ name: '生日', date: 'YYYY-MM-DD' }]，最多 10 条
};

const cache = { config: null, mtimeMs: 0, size: -1, errors: 0 };

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function deepMerge(base, patch) {
  const out = {};
  const keys = Object.keys(base || {});
  for (let i = 0; i < keys.length; i++) {
    const v = base[keys[i]];
    out[keys[i]] = Array.isArray(v) ? v.slice() : (isObject(v) ? deepMerge(v, {}) : v);
  }
  if (!isObject(patch)) return out;
  const pk = Object.keys(patch);
  for (let i = 0; i < pk.length; i++) {
    const k = pk[i];
    if (isObject(out[k]) && isObject(patch[k])) out[k] = deepMerge(out[k], patch[k]);
    else if (patch[k] !== undefined) out[k] = Array.isArray(patch[k]) ? patch[k].slice() : patch[k];
  }
  return out;
}

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); return true; } catch (e) { return false; }
}

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) { /* ignore */ }
}

// 原子写：同目录临时文件 → rename（Windows 上 libuv 用 MoveFileExW + REPLACE_EXISTING）。
function atomicWrite(file, text, attempts) {
  const max = attempts || 4;
  const dir = path.dirname(file);
  if (!ensureDir(dir)) return { ok: false, error: { code: 'MKDIR_FAILED', message: dir } };
  const tmp = path.join(dir, '.' + path.basename(file) + '.' + process.pid + '.' + Date.now().toString(36) + '.tmp');
  try {
    fs.writeFileSync(tmp, text, 'utf8');
  } catch (e) {
    return { ok: false, error: { code: 'WRITE_FAILED', message: String(e && e.message) } };
  }
  for (let i = 0; i < max; i++) {
    try {
      fs.renameSync(tmp, file);
      return { ok: true, path: file, bytes: Buffer.byteLength(text) };
    } catch (e) {
      if (i === max - 1) {
        try { fs.unlinkSync(tmp); } catch (e2) { /* ignore */ }
        return { ok: false, error: { code: 'RENAME_FAILED', message: String(e && e.message) } };
      }
      sleepSync(15);
    }
  }
  return { ok: false, error: { code: 'RENAME_FAILED', message: 'exhausted' } };
}

function atomicWriteJson(file, value) {
  let text;
  try { text = JSON.stringify(value, null, 2); } catch (e) { return { ok: false, error: { code: 'SERIALIZE_FAILED', message: String(e && e.message) } }; }
  return atomicWrite(file, text + '\n');
}

function configPath() { return P.CONFIG_FILE; }

function defaults() { return deepMerge(DEFAULT_CONFIG, {}); }

function loadConfig() {
  const file = configPath();
  let st = null;
  try { st = fs.statSync(file); } catch (e) { st = null; }
  if (st && cache.config && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.config;

  let raw = null;
  if (st) {
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) {
      cache.errors++;
      try { fs.renameSync(file, file + '.bad'); } catch (e2) { /* ignore */ }
      raw = null;
    }
  }
  const cfg = deepMerge(DEFAULT_CONFIG, raw || {});
  // 旧版本是悬浮窗；升级后一次性切到「导航芯片 + 下拉面板」布局。
  if (cfg.navLayout !== 1) {
    cfg.navLayout = 1;
    cfg.collapsed = true;
    cfg.position = { left: 1, top: 0 };
    if (st) { try { atomicWriteJson(file, cfg); } catch (e) { /* ignore */ } }
  }
  cache.config = cfg;
  cache.mtimeMs = st ? st.mtimeMs : 0;
  cache.size = st ? st.size : -1;
  if (!st) atomicWriteJson(file, cfg);
  return cfg;
}

function saveConfig(patch) {
  const cur = loadConfig();
  const next = deepMerge(cur, patch || {});
  const r = atomicWriteJson(configPath(), next);
  if (r.ok) {
    try {
      const st = fs.statSync(configPath());
      cache.mtimeMs = st.mtimeMs;
      cache.size = st.size;
    } catch (e) { cache.mtimeMs = 0; cache.size = -1; }
    cache.config = next;
  }
  return { ok: r.ok, config: next, error: r.error || null };
}

function readStatus() {
  try { return JSON.parse(fs.readFileSync(P.STATUS_FILE, 'utf8')); } catch (e) { return null; }
}

function writeStatus(value) {
  const payload = {};
  if (isObject(value)) { const k = Object.keys(value); for (let i = 0; i < k.length; i++) payload[k[i]] = value[k[i]]; }
  payload.at = Date.now();
  return atomicWriteJson(P.STATUS_FILE, payload);
}

module.exports = {
  DEFAULT_CONFIG: DEFAULT_CONFIG,
  paths: P,
  loadConfig: loadConfig,
  saveConfig: saveConfig,
  readStatus: readStatus,
  writeStatus: writeStatus,
  atomicWrite: atomicWrite,
  atomicWriteJson: atomicWriteJson,
  deepMerge: deepMerge,
  ensureDir: ensureDir,
  configPath: configPath
};
