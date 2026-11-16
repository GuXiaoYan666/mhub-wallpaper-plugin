'use strict';
const fs = require('fs');
const path = require('path');
const P = require('./paths.js');
const DEFAULT_CONFIG = {
  version: 1,
  pluginEnabled: true,
  lyricEnabled: true,
  showTranslation: true,
  maxChars: 200,
  tickMs: 100,
  pushMinMs: 100,
  kugou: { enabled: true, iniPath: null, lyricDir: null, intervalMs: 250, pauseAfterMs: 5000, positionLeadMs: 2600, uiTimeline: true, uiPositionLeadMs: 300 },
  soda: { enabled: true, file: null, staleMs: 10000, staleHoldMs: 5000, pollMs: 500 },
  session: { enabled: true, pollMs: 500, changeDebounceMs: 900 },
  bilibili: { enabled: true, web: true, sessdata: null, file: null, pollMs: 1000, cacheHours: 12, holdMs: 8000, retryMs: 30000 },
  online: { enabled: true, cacheDays: 30, timeoutMs: 6000, holdMs: 8000 },
  players: { enabled: true, refreshMs: 60000, iconMax: 0 }
};
const cache = { config: null, mtimeMs: 0, size: -1, errors: 0 };
function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function deepMerge(base, patch) {
  const out = {};
  const keys = Object.keys(base || {});
  for (let i = 0; i < keys.length; i++) out[keys[i]] = isObject(base[keys[i]]) ? deepMerge(base[keys[i]], {}) : base[keys[i]];
  if (!isObject(patch)) return out;
  const pk = Object.keys(patch);
  for (let i = 0; i < pk.length; i++) {
    const k = pk[i];
    if (isObject(out[k]) && isObject(patch[k])) out[k] = deepMerge(out[k], patch[k]);
    else if (patch[k] !== undefined) out[k] = patch[k];
  }
  return out;
}
function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); return true; } catch (e) { return false; }
}
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) { /* ignore */ }
}
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
  if (!cfg.soda || !cfg.soda.file) cfg.soda.file = P.SODA_FILE;
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
function resetConfig() {
  const next = defaults();
  next.soda.file = P.SODA_FILE;
  const r = atomicWriteJson(configPath(), next);
  cache.config = next;
  cache.mtimeMs = 0;
  cache.size = -1;
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
  resetConfig: resetConfig,
  readStatus: readStatus,
  writeStatus: writeStatus,
  atomicWrite: atomicWrite,
  atomicWriteJson: atomicWriteJson,
  deepMerge: deepMerge,
  ensureDir: ensureDir,
  configPath: configPath
};
