'use strict';

const fs = require('fs');
const path = require('path');

const FORMAT = 'MCHOSE_PET';
// 当前磁盘 schema 版本。加一档就补一条 MIGRATIONS 步骤，别再拿版本号做严格相等判死。
const SCHEMA_VERSION = 2;
const MIN_SUPPORTED_VERSION = 1;
const VERSION = SCHEMA_VERSION;
const DEBOUNCE_MS = 300;
// 设置页滑块的取值区间，取值只在这个区间内夹取（renderer/settings/index.html:68-70）。
const SCALE_MIN = 0;
const SCALE_MAX = 150;
const SMART_INTERP_FPS = [24, 30, 60];
// 补帧档位改成「源帧率的整数倍」：固定 24/30/60 帧时 steps=round(fps×源帧时长/1000)
// 会随动作里各帧 durations 在 2/3 之间跳，时间轴对不齐就有果冻感；倍数下每个源帧固定 mult 格。
// smartInterpFps 保留只读以兼容老配置：24→×2 / 30→×3 / 60→×4 折算成倍数，不写回文件。
const SMART_INTERP_MULT = [2, 3, 4];
const LEGACY_INTERP_FPS_MULT = { 24: 2, 30: 3, 60: 4 };
const BUBBLE_MS = [2500, 3500, 5000];
const LOCALES = ['zh', 'en'];
const ACTION_IDS = [
  'idle',
  'running-right',
  'running-left',
  'waving',
  'jumping',
  'failed',
  'waiting',
  'running',
  'review'
];
const NAME_MAX = 20;
const ID_MAX = 32;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const LEGACY_PET_ID = 'aby';

const DEFAULT_SETTINGS = Object.freeze({
  visible: false,
  scale: 75,
  alwaysOnTop: true,
  clickThrough: false,
  autoPlay: true,
  followInput: true,
  showKeyHints: true,
  showLevel: true,
  sharpRender: false,
  characterLighting: true,
  lightStrength: 40,
  groundShadow: true,
  smartInterp: false,
  smartInterpFps: 24,
  smartInterpMult: 3,
  pageEntry: true,
  petId: '',
  petNames: {},
  growthProfiles: {},
  action: 'idle',
  position: null,
  locale: 'zh',
  roam: true,
  dragPhysics: true,
  touchFeedback: true,
  bubbles: true,
  bubbleMs: 3500,
  quietMode: false,
  quietFullscreen: true,
  deviceNotify: true,
  notifyKeyboard: true,
  notifyMouse: true,
  notifyHeadset: true,
  notifyBattery: true
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// 白名单字段的统一入口：数字原样、数字字符串强制转数，其余（undefined/null/bool/对象/NaN）一律 null。
function toFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// 宠物大小按 1% 步进：任意整数百分比都要原样保留（滑块 step=1、输入框手输、↑↓ 步进 1），
// 这里只取整并夹到滑块区间，不做档位吸附。0 是"隐藏宠物"的语义，由 pet-window 按 scale===0 判定。
function clampScale(value) {
  const raw = toFiniteNumber(value);
  if (raw === null) return DEFAULT_SETTINGS.scale;
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round(raw)));
}

function createDefaultSettings() {
  return Object.assign({}, DEFAULT_SETTINGS);
}

function cleanName(value) {
  if (typeof value !== 'string') return null;
  const text = value.normalize('NFC').trim();
  if (!text) return null;
  if (Array.from(text).length > NAME_MAX) return null;
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(text)) return null;
  return text;
}

function cleanPetId(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!ID_PATTERN.test(text) || text.length > ID_MAX) return '';
  return text;
}

function cleanNameMap(value) {
  const src = isPlainObject(value) ? value : {};
  const out = {};
  Object.keys(src).forEach((key) => {
    if (!ID_PATTERN.test(key)) return;
    const name = cleanName(src[key]);
    if (name) out[key] = name;
  });
  return out;
}

function cleanProfileMap(value) {
  const src = isPlainObject(value) ? value : {};
  const out = {};
  Object.keys(src).forEach((key) => {
    if (!ID_PATTERN.test(key)) return;
    const profile = cleanGrowth(src[key]);
    if (profile) out[key] = profile;
  });
  return out;
}

// 删宠物时宿主只删目录，成长档案 / 改过的名字会留在 settings 里变成孤儿；
// cleanProfileMap / cleanNameMap 只做归一化，不会按宠物列表剔除。这里只按成员关系剔，
// 不做数值归一化：清扫本身不该改动保留下来那些条目。列表为空 / 没给出可用 id 时一律不动——
// 那时宠物列表可能还没加载完，按空列表剔除会把所有条目一次清空。
function pruneByMembership(map, petIds) {
  const src = isPlainObject(map) ? map : {};
  const keep = Object.create(null);
  if (Array.isArray(petIds)) {
    petIds.forEach((id) => {
      if (typeof id === 'string' && id) keep[id] = true;
    });
  }
  const usable = Object.keys(keep).length > 0;
  const kept = {};
  const removed = [];
  Object.keys(src).forEach((key) => {
    if (usable && !keep[key]) {
      removed.push(key);
      return;
    }
    kept[key] = src[key];
  });
  return { kept: kept, removed: removed };
}

function pruneProfiles(profiles, petIds) {
  const result = pruneByMembership(profiles, petIds);
  return { profiles: result.kept, removed: result.removed };
}

// settings.petNames 与成长档案同源：删掉的宠物改过的名字也会留在设置里。
function pruneNames(names, petIds) {
  const result = pruneByMembership(names, petIds);
  return { names: result.kept, removed: result.removed };
}

function migrateSettings(rawSettings, legacyGrowth) {
  const src = isPlainObject(rawSettings) ? rawSettings : {};
  const declaredId = cleanPetId(src.petId);
  const names = cleanNameMap(src.petNames);
  const profiles = cleanProfileMap(src.growthProfiles);
  const legacyName = cleanName(src.petName);
  const growth = cleanGrowth(legacyGrowth);
  const profileKeys = Object.keys(profiles);
  const nameKeys = Object.keys(names);
  const targetId = declaredId || (profileKeys.length === 1 ? profileKeys[0] : '') || (nameKeys.length === 1 ? nameKeys[0] : '') || LEGACY_PET_ID;
  if (legacyName && !names[targetId]) names[targetId] = legacyName;
  if (growth && !profiles[targetId]) profiles[targetId] = growth;
  const out = Object.assign({}, src);
  delete out.petName;
  out.petId = declaredId || (growth || legacyName ? targetId : '');
  out.petNames = names;
  out.growthProfiles = profiles;
  return out;
}

function cleanPosition(value) {
  if (!isPlainObject(value)) return null;
  if (!Number.isSafeInteger(value.x) || !Number.isSafeInteger(value.y)) return null;
  return { x: value.x, y: value.y };
}

function readInterpMult(src) {
  const value = Number(src && src.smartInterpMult);
  if (SMART_INTERP_MULT.indexOf(value) >= 0) return value;
  // 老配置只有 smartInterpFps：折算成倍数，只影响读出的值，不回写文件。
  return LEGACY_INTERP_FPS_MULT[Number(src && src.smartInterpFps)] || DEFAULT_SETTINGS.smartInterpMult;
}

function cleanSettings(raw) {
  const src = isPlainObject(raw) ? raw : {};
  const readBool = (key) => (typeof src[key] === 'boolean' ? src[key] : DEFAULT_SETTINGS[key]);
  const readChoice = (key, allowed) => (allowed.indexOf(src[key]) >= 0 ? src[key] : DEFAULT_SETTINGS[key]);
  return {
    visible: readBool('visible'),
    scale: clampScale(src.scale),
    alwaysOnTop: readBool('alwaysOnTop'),
    clickThrough: readBool('clickThrough'),
    autoPlay: readBool('autoPlay'),
    followInput: readBool('followInput'),
    showKeyHints: readBool('showKeyHints'),
    showLevel: readBool('showLevel'),
    sharpRender: readBool('sharpRender'),
    characterLighting: readBool('characterLighting'),
    lightStrength: readChoice('lightStrength', [20, 40, 65]),
    groundShadow: readBool('groundShadow'),
    smartInterp: readBool('smartInterp'),
    // Legacy payloads predate the tier key: an absent smartInterpFps falls back to 24, so an old
    // smartInterp === true reads back as 24 without rewriting the file.
    smartInterpFps: readChoice('smartInterpFps', SMART_INTERP_FPS),
    smartInterpMult: readInterpMult(src),
    pageEntry: readBool('pageEntry'),
    petId: cleanPetId(src.petId),
    petNames: cleanNameMap(src.petNames),
    growthProfiles: cleanProfileMap(src.growthProfiles),
    action: readChoice('action', ACTION_IDS),
    position: cleanPosition(src.position),
    locale: readChoice('locale', LOCALES),
    roam: readBool('roam'),
    dragPhysics: readBool('dragPhysics'),
    touchFeedback: readBool('touchFeedback'),
    bubbles: readBool('bubbles'),
    bubbleMs: readChoice('bubbleMs', BUBBLE_MS),
    quietMode: readBool('quietMode'),
    quietFullscreen: readBool('quietFullscreen'),
    deviceNotify: readBool('deviceNotify'),
    notifyKeyboard: readBool('notifyKeyboard'),
    notifyMouse: readBool('notifyMouse'),
    notifyHeadset: readBool('notifyHeadset'),
    notifyBattery: readBool('notifyBattery')
  };
}

// 成长存档的键集合：totalXp/level/updatedAt 是本轨要求的对外字段，
// lastAwardAt/curveVersion 是 lib/growth.js:80-90 与 docs/pet-growth-spec.md §「存档校验」要求往返的字段，
// 丢掉 lastAwardAt 会让 10s 发放冷却归零（growth.js:awardFor），因此一并保留。
const GROWTH_KEYS = ['totalXp', 'level', 'updatedAt', 'lastAwardAt', 'curveVersion'];

function cleanGrowth(value) {
  if (!isPlainObject(value)) return null;
  const out = {};
  for (let index = 0; index < GROWTH_KEYS.length; index += 1) {
    const key = GROWTH_KEYS[index];
    if (!hasOwn(value, key)) continue;
    const number = toFiniteNumber(value[key]);
    if (number === null) continue;
    if (key === 'totalXp') out.totalXp = Math.max(0, Math.round(number * 1000) / 1000);
    else if (key === 'level') out.level = Math.max(1, Math.floor(number));
    else if (key === 'lastAwardAt') out.lastAwardAt = Math.max(0, Math.round(number));
    else out[key] = number;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function defaultFilePath(electron) {
  let dir = process.cwd();
  try {
    if (electron && electron.app && typeof electron.app.getPath === 'function') {
      dir = electron.app.getPath('userData') || dir;
    }
  } catch (err) {
    dir = process.cwd();
  }
  return path.join(dir, 'pet-hub.json');
}

// 逐版本迁移链：键 = 磁盘上的来源版本，函数负责把该版本的 payload 推进到下一版。
// 当前 schema 只有 1 -> 2 一步，内容是 identity（字段卫生化交给 cleanSettings）；
// 以后再改存档形状，加一条 2 -> 3 即可，读档不再因为版本号不相等就整体丢回默认值。
const MIGRATIONS = Object.freeze({
  1: function migrateV1(payload) {
    return payload;
  }
});

// 读到的 payload -> { ok:true, migratedFrom, state } 或 { ok:false, reason }。
// 失败只表达"这份文件用不了"，由调用方保留内存默认值，绝不动磁盘。
function migrate(raw) {
  if (!isPlainObject(raw)) return { ok: false, reason: 'not-object' };
  if (raw.format !== FORMAT) return { ok: false, reason: 'format' };
  const declared = toFiniteNumber(raw.version);
  if (declared === null || !Number.isInteger(declared) || declared < MIN_SUPPORTED_VERSION) {
    return { ok: false, reason: 'version' };
  }
  if (declared > SCHEMA_VERSION) return { ok: false, reason: 'ahead' };
  let version = declared;
  let payload = raw;
  while (version < SCHEMA_VERSION) {
    const step = MIGRATIONS[version];
    if (typeof step !== 'function') return { ok: false, reason: 'no-migration' };
    let next = null;
    try {
      next = step(payload);
    } catch (err) {
      return { ok: false, reason: 'migration-threw', error: err };
    }
    if (!isPlainObject(next)) return { ok: false, reason: 'migration-bad' };
    payload = next;
    version += 1;
  }
  return {
    ok: true,
    migratedFrom: declared,
    state: {
      format: FORMAT,
      version: SCHEMA_VERSION,
      settings: cleanSettings(migrateSettings(payload.settings, payload.growth))
    }
  };
}

function createStore(filePath, options) {
  const opts = options || {};
  const debounceMs = Number.isFinite(opts.debounceMs) && opts.debounceMs >= 0 ? opts.debounceMs : DEBOUNCE_MS;
  const logger = opts.logger || null;
  const target = typeof filePath === 'string' && filePath ? filePath : null;
  const listeners = new Set();
  let state = { format: FORMAT, version: SCHEMA_VERSION, settings: createDefaultSettings() };
  let timer = null;
  let dirty = false;
  let disposed = false;
  // 上一次 load() 的结果；null = 还没 load 过，别谎报 defaulted。
  let lastLoad = null;
  // 读档失败（文件存在但用不了）后第一次落盘前先把原文件另存一份，避免把用户数据直接抹掉。
  let backupPending = false;

  function log(level, message, error) {
    if (!logger) return;
    try {
      const sink = logger[level] || logger.info;
      if (typeof sink === 'function') sink('[config] ' + message, error);
    } catch (err) {
      return;
    }
  }

  function emit(reason) {
    listeners.forEach((listener) => {
      try {
        listener(createDefaultSettingsSafe(), snapshot(), reason);
      } catch (err) {
        log('warn', 'listener threw', err);
      }
    });
  }

  function createDefaultSettingsSafe() {
    return Object.assign({}, state.settings);
  }

  function snapshot() {
    return {
      format: state.format,
      version: state.version,
      settings: Object.assign({}, state.settings),
      loadedFromDisk: lastLoad ? lastLoad.loadedFromDisk : false,
      defaulted: lastLoad ? !lastLoad.loadedFromDisk : false,
      loadReason: lastLoad ? lastLoad.reason : 'pending',
      migratedFrom: lastLoad ? lastLoad.migratedFrom : 0
    };
  }

  // -> { ok:true, reason, migratedFrom } | { ok:false, reason }
  function readFromDisk() {
    if (!target) return { ok: false, reason: 'no-path' };
    let text = null;
    try {
      text = fs.readFileSync(target, 'utf8');
    } catch (err) {
      const code = err && err.code;
      if (code !== 'ENOENT') {
        log('warn', 'read failed, keeping defaults: ' + target, err);
        return { ok: false, reason: 'read-failed' };
      }
      return { ok: false, reason: 'missing' };
    }
    let raw = null;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      log('warn', 'invalid json, keeping defaults (disk untouched)', err);
      return { ok: false, reason: 'invalid-json' };
    }
    const result = migrate(raw);
    if (!result.ok) {
      log('warn', 'unsupported payload (' + result.reason + '), keeping defaults (disk untouched)', result.error);
      return { ok: false, reason: result.reason };
    }
    state = result.state;
    if (result.migratedFrom !== SCHEMA_VERSION) log('info', 'config migrated ' + result.migratedFrom + ' -> ' + SCHEMA_VERSION);
    return { ok: true, reason: 'loaded', migratedFrom: result.migratedFrom };
  }

  // 读档失败意味着磁盘上那份文件我们理解不了；第一次覆盖前另存 <file>.corrupt，别让用户数据无声消失。
  function backupUnreadable() {
    if (!backupPending || !target) return true;
    try {
      if (!fs.existsSync(target)) return true;
      fs.copyFileSync(target, target + '.corrupt');
      return true;
    } catch (err) {
      log('warn', 'backup of unreadable config failed: ' + target, err);
      return false;
    }
  }

  function writeNow() {
    if (!target) return false;
    if (!backupUnreadable()) return false;
    const payload = JSON.stringify(state, null, 2);
    const tmp = target + '.' + process.pid + '.' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + '.tmp';
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(tmp, payload, 'utf8');
      fs.renameSync(tmp, target);
      backupPending = false;
      return true;
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch (cleanupErr) {
        log('debug', 'tmp cleanup skipped', cleanupErr);
      }
      log('error', 'atomic write failed: ' + target, err);
      return false;
    }
  }

  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!dirty) return true;
    const ok = writeNow();
    if (ok) dirty = false;
    return ok;
  }

  function schedule() {
    if (disposed) return;
    dirty = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, debounceMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function load() {
    const result = readFromDisk();
    lastLoad = {
      loadedFromDisk: result.ok === true,
      reason: result.reason,
      migratedFrom: result.ok ? result.migratedFrom : 0
    };
    // 文件存在但读不懂：内存里继续用默认值，下一次落盘前先备份原文件。
    if (!result.ok && result.reason !== 'missing' && result.reason !== 'no-path') backupPending = true;
    emit('load');
    return snapshot();
  }

  function save() {
    schedule();
    return snapshot();
  }

  function patch(partial) {
    if (!isPlainObject(partial)) return Object.assign({}, state.settings);
    state.settings = cleanSettings(Object.assign({}, state.settings, partial));
    schedule();
    emit('patch');
    return Object.assign({}, state.settings);
  }

  function getSettings() {
    return Object.assign({}, state.settings);
  }

  function onChange(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function offChange(listener) {
    listeners.delete(listener);
  }

  function dispose() {
    flush();
    listeners.clear();
    disposed = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  return {
    path: target,
    load,
    save,
    flush,
    patch,
    getSettings,
    getState: snapshot,
    onChange,
    offChange,
    dispose,
    isDirty: () => dirty
  };
}

module.exports = {
  FORMAT,
  VERSION,
  DEBOUNCE_MS,
  SMART_INTERP_FPS,
  SMART_INTERP_MULT,
  BUBBLE_MS,
  LOCALES,
  ACTION_IDS,
  NAME_MAX,
  DEFAULT_SETTINGS,
  createStore,
  createDefaultSettings,
  cleanSettings,
  cleanGrowth,
  cleanName,
  cleanNameMap,
  cleanProfileMap,
  pruneProfiles,
  pruneNames,
  cleanPetId,
  cleanPosition,
  migrateSettings,
  defaultFilePath
};
