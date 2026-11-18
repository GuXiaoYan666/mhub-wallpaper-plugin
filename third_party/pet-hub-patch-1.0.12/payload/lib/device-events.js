'use strict';

const ipc = require('./ipc.js');
const hostTips = require('./host-tips.js');
const hostState = require('./host-state.js');

const MERGE_WINDOW_MS = 500;
const MERGE_MAX_HOLD_MS = 2000;
const DEFAULT_PRIORITY = 3;
const DEFAULT_TTL_MS = 3500;
const TTL_MIN = 500;
const TTL_MAX = 60000;
const TEXT_MAX = 80;
const ID_MAX = 64;

const KINDS = ['profile', 'dpi', 'rgb', 'eq', 'mode', 'mic', 'battery', 'connection', 'volume', 'config'];
const RESULTS = ['confirmed', 'pending', 'failed', 'unknown'];
const ACTIONS = ['idle', 'running-right', 'running-left', 'waving', 'jumping', 'failed', 'waiting', 'running', 'review'];
const DEVICE_TYPES = ['keyboard', 'mouse', 'headset', 'speaker', 'unknown'];

// 宿主只暴露 mode 序号，映射表用于展示，未知序号按原值回显。
const LIGHT_MODES = {
  0: '关闭',
  1: '常亮',
  2: '单色呼吸',
  3: '呼吸',
  4: '彩虹',
  5: '光谱循环',
  6: '波浪',
  7: '涟漪',
  8: '星光',
  9: '音乐律动'
};

// index 是当前选中的灯效档位、colors 是调色板，两者单独变动不播报。
const SILENT_LIGHT_FIELDS = ['index', 'colors'];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normaliseLog(log) {
  const sink = log || {};
  const pick = (level) => (typeof sink[level] === 'function' ? sink[level].bind(sink) : () => {});
  return { debug: pick('debug'), info: pick('info'), warn: pick('warn'), error: pick('error') };
}

function slug(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '';
  const out = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  if (out) return out;
  // 纯非 ASCII 设备名会被上面的替换清空，用短哈希兜底避免不同设备撞同一个 id。
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) % 100000;
  }
  return 'dev-' + hash.toString(36);
}

function deviceForName(name) {
  const raw = typeof name === 'string' ? name.trim() : '';
  const id = slug(raw) || 'device';
  if (/\bK5\b/i.test(raw)) return { id: id, type: 'mouse' };
  if (/K20\s*(?:GT|PRO)\b|speaker|音箱|音响/i.test(raw)) return { id: id, type: 'speaker' };
  if (/headset|耳机/i.test(raw)) return { id: id, type: 'headset' };
  if (/K\d|K20|keyboard/i.test(raw)) return { id: id, type: 'keyboard' };
  if (/M\d|mouse/i.test(raw)) return { id: id, type: 'mouse' };
  if (/V\d|headset|耳机/i.test(raw)) return { id: id, type: 'headset' };
  return { id: id, type: 'unknown' };
}

function modeLabel(value) {
  if (value === null || value === undefined) return '';
  const key = String(value).trim();
  if (!key) return '';
  if (Object.prototype.hasOwnProperty.call(LIGHT_MODES, key)) return LIGHT_MODES[key];
  return key;
}

function colorLabel(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text) return '';
  const hex = /^#?[0-9a-fA-F]{6}$/.test(text) ? (text.charAt(0) === '#' ? text : '#' + text) : text;
  return hex.toUpperCase();
}

function clamp(number, min, max) {
  return Math.min(max, Math.max(min, number));
}

function createAdapter(options) {
  const opts = options || {};
  const getSettings = typeof opts.getSettings === 'function' ? opts.getSettings : () => ({});
  const send = typeof opts.send === 'function' ? opts.send : () => false;
  const log = normaliseLog(opts.log);
  const timers = new Set();
  const pending = new Map();
  let seq = 0;
  let disposed = false;
  let delivered = 0;
  let lastRejected = null, lastDelivered = null;
  // 同一个 tip id 只播一次：宿主的 value 会把还活着的通知反复带回来。
  const tipDedupe = hostTips.createDedupe(hostTips.DEDUPE_LIMIT);
  const hostTracker = hostState.createTracker();
  const recentHost = new Map();
  let hostUpdates = 0;
  let lastHostUpdateAt = 0;

  function knownDevice(name) {
    const clean = value => String(value || '').replace(/mchose|\s|[-_]/gi, '').toLowerCase();
    const target = clean(name);
    return hostTracker.devices().find(d => target && clean(d.name) && (target.includes(clean(d.name)) || clean(d.name).includes(target)));
  }

  function hostDevice(tip, classified) {
    const named = knownDevice(tip.text);
    if (named && named.deviceType !== 'unknown') return { id: slug(named.id), type: named.deviceType };
    const matches = hostTracker.devices().filter(d => classified.type === 'audio' ? ['headset', 'speaker'].includes(d.deviceType) : classified.type !== 'unknown'
      ? d.deviceType === classified.type : classified.kind === 'profile' && d.profileIndex !== null);
    if (matches.length === 1) return { id: slug(matches[0].id), type: matches[0].deviceType };
    return { id: classified.type, type: DEVICE_TYPES.includes(classified.type) ? classified.type : 'unknown' };
  }

  function enqueueHost(event) {
    const settings = readSettings();
    // A state and its toast often describe the same operation. Merge them into
    // the existing 500ms window using the same device id and event kind.
    const identity = event.device.id + '|' + event.kind;
    const existing = pending.get(identity);
    // MHUB briefly clears/repopulates its list while rescanning. A disconnect
    // immediately followed by reconnect is not a physical unplug notification.
    if (event.kind === 'connection' && typeof event.connected === 'boolean' && existing &&
        typeof existing.event.connected === 'boolean' && event.connected !== existing.event.connected) {
      dropTimer(existing.timer);
      pending.delete(identity);
      recentHost.delete(identity + '|' + existing.event.text);
      recentHost.delete(identity + '|' + event.text);
      return true;
    }
    const signature = identity + '|' + event.text;
    const previous = recentHost.get(signature);
    recentHost.set(signature, Date.now());
    if (recentHost.size > 128) recentHost.delete(recentHost.keys().next().value);
    if (previous && Date.now() - previous < 2000) return false;
    if (!allowed(event, settings)) { if (pending.has(identity)) { dropTimer(pending.get(identity).timer); pending.delete(identity); } return false; }
    return enqueue(event, event.kind === 'connection' && typeof event.connected === 'boolean' ? 1600 : MERGE_WINDOW_MS);
  }

  function ingestHostState(payload) {
    if (disposed || !payload || !Array.isArray(payload.value)) return 0;
    hostUpdates++;
    lastHostUpdateAt = Date.now();
    const events = hostTracker.ingest(payload.value, payload.initial === true);
    let count = 0;
    events.forEach(raw => {
      const event = normalizeEvent(raw);
      if (event && event.device.type !== 'unknown' && enqueueHost(event)) count++;
    });
    return count;
  }

  function ingestHostMode(payload) {
    if (disposed || !payload || !/^MCHOSE K20 (?:GT|PRO)$/.test(payload.product) || !Number.isInteger(payload.mode)) return false;
    const names = ['音乐模式', '游戏模式', '电影模式'];
    if (!names[payload.mode]) return false;
    const device = knownDevice(payload.product);
    return enqueueHost(normalizeEvent({ kind: 'mode', source: 'mhub.driver', result: 'confirmed',
      action: 'review', priority: 2, text: '音效模式：' + names[payload.mode],
      device: { id: device ? device.id : payload.product, type: 'speaker' } }));
  }

  function later(ms, fn) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      try {
        fn();
      } catch (err) {
        log.warn('device adapter timer failed', err);
      }
    }, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
    timers.add(timer);
    return timer;
  }

  function dropTimer(timer) {
    if (!timer) return;
    clearTimeout(timer);
    timers.delete(timer);
  }

  function readSettings() {
    try {
      const settings = getSettings();
      return isPlainObject(settings) ? settings : {};
    } catch (err) {
      log.warn('device adapter settings read failed', err);
      return {};
    }
  }

  function nextId(kind) {
    seq += 1;
    return kind + '-' + seq;
  }

  function baseEvent(kind, fields) {
    const event = {
      id: nextId(kind),
      t: Date.now(),
      kind: kind,
      result: 'confirmed',
      action: 'idle',
      text: '',
      priority: DEFAULT_PRIORITY,
      source: 'local',
      device: { id: 'device', type: 'unknown' },
      ttlMs: DEFAULT_TTL_MS,
      critical: false
    };
    if (isPlainObject(fields)) {
      Object.keys(fields).forEach((key) => {
        event[key] = fields[key];
      });
    }
    return event;
  }

  function rgbText(entry) {
    const snapshot = isPlainObject(entry.snapshot) ? entry.snapshot : {};
    if (snapshot.enable === false) return '灯效：关闭';
    const parts = [];
    const mode = modeLabel(snapshot.mode !== undefined ? snapshot.mode : entry.next);
    if (mode) parts.push(mode);
    const color = colorLabel(snapshot.color);
    if (color) parts.push(color);
    if (!parts.length) return '灯效已更新';
    return '灯效：' + parts.join(' · ');
  }

  function eventFromEntry(entry) {
    if (!isPlainObject(entry)) return null;
    if (entry.file === 'light') {
      if (typeof entry.field === 'string' && SILENT_LIGHT_FIELDS.indexOf(entry.field) >= 0) return null;
      return baseEvent('rgb', {
        action: 'jumping',
        text: rgbText(entry),
        device: (() => { const d = knownDevice(entry.deviceKey); return d ? { id: slug(d.id), type: d.deviceType } : deviceForName(entry.deviceKey); })()
      });
    }
    if (entry.file === 'eq') {
      if (entry.field !== 'current') return null;
      const name = typeof entry.next === 'string' ? entry.next.trim() : '';
      if (!name) return null;
      return baseEvent('eq', {
        action: 'review',
        text: 'EQ：' + name,
        device: { id: 'headset', type: 'headset' }
      });
    }
    if (entry.file === 'keyboardLight') {
      // 灯效 GIF / 音乐律动开关在契约里没有文案，只留痕不播报。
      log.debug('keyboard light change ignored: ' + String(entry.deviceKey) + ' ' + String(entry.field));
      return null;
    }
    return null;
  }

  function allowed(event, settings) {
    const reject = reason => { lastRejected = { at: Date.now(), kind: event.kind, deviceType: event.device && event.device.type, reason }; return false; };
    if (settings.deviceNotify === false) return reject('notifications-off');
    if (event.kind === 'battery' && settings.notifyBattery === false) return reject('battery-off');
    const type = event.device ? event.device.type : 'unknown';
    if (type === 'keyboard' && settings.notifyKeyboard === false) return reject('keyboard-off');
    if (type === 'mouse' && settings.notifyMouse === false) return reject('mouse-off');
    if ((type === 'headset' || type === 'speaker') && settings.notifyHeadset === false) return reject('audio-off');
    // 安静模式：主进程直接丢弃 P2 及以下噪音（P3/P4 与契约 §3 一致，越高越舍）。
    if (settings.quietMode === true && event.priority >= 2) return reject('quiet');
    return true;
  }

  function deliver(event) {
    if (disposed) return false;
    delivered += 1;
    try {
      const ok = send(ipc.NOTIFY, event);
      lastDelivered = { at: Date.now(), kind: event.kind, deviceType: event.device && event.device.type, delivered: ok !== false };
      if (ok === false) log.debug('device notify dropped by sender: ' + event.kind);
      return ok !== false;
    } catch (err) {
      log.warn('device notify send failed: ' + event.kind, err);
      return false;
    }
  }

  function flushKey(key) {
    const entry = pending.get(key);
    if (!entry) return false;
    pending.delete(key);
    dropTimer(entry.timer);
    return allowed(entry.event, readSettings()) ? deliver(entry.event) : false;
  }

  function enqueue(event, delayMs) {
    const delay = delayMs || MERGE_WINDOW_MS;
    const key = event.device.id + '|' + event.kind;
    const existing = pending.get(key);
    const now = Date.now();
    if (existing) {
      existing.event = event;
      if (now - existing.firstAt >= MERGE_MAX_HOLD_MS) {
        flushKey(key);
        return true;
      }
      dropTimer(existing.timer);
      existing.timer = later(delay, () => flushKey(key));
      return true;
    }
    const entry = { event: event, firstAt: now, timer: null };
    entry.timer = later(delay, () => flushKey(key));
    pending.set(key, entry);
    return true;
  }

  function ingest(rawList) {
    if (disposed) return 0;
    if (!Array.isArray(rawList) || rawList.length === 0) return 0;
    const settings = readSettings();
    let accepted = 0;
    rawList.forEach((raw) => {
      const event = eventFromEntry(raw);
      if (!event) return;
      if (!allowed(event, settings)) return;
      if (enqueue(event)) accepted += 1;
    });
    return accepted;
  }

  // 转发宿主已生成的设备通知：只有 value 里新出现的 id 算新事件。
  function handleHostTip(payload) {
    if (disposed) return 0;
    if (!isPlainObject(payload)) return 0;
    const value = isPlainObject(payload.value) ? payload.value : {};
    const oldValue = isPlainObject(payload.oldValue) ? payload.oldValue : {};
    const tips = hostTips.extractTips(oldValue, value);
    if (!tips.length) return 0;
    const settings = readSettings();
    let accepted = 0;
    tips.forEach((tip) => {
      // 先去重再门禁：静音期间到达的通知也算已消费，用户打开开关后不会再补播旧提示。
      if (!tipDedupe.fresh(tip.id)) return;
      const classified = hostTips.classifyTip(tip);
      if (!classified) {
        log.debug('host tip ignored: not a dpi tip or device notification');
        return;
      }
      const device = hostDevice(tip, classified);
      if (device.type === 'unknown') { log.debug('host tip ignored: device type unavailable'); return; }
      const event = baseEvent(classified.kind, {
        action: classified.action,
        text: classified.text,
        result: classified.result,
        critical: classified.critical,
        priority: 2,
        source: 'mhub.driver',
        connected: classified.kind === 'connection' ? classified.connected : undefined,
        device: device
      });
      if (!allowed(event, settings)) return;
      if (classified.kind === 'dpi' ? deliver(event) : enqueueHost(event)) accepted += 1;
    });
    return accepted;
  }

  function normalizeEvent(payload) {
    if (!isPlainObject(payload)) return null;
    if (KINDS.indexOf(payload.kind) < 0) return null;
    const kind = payload.kind;
    const device = isPlainObject(payload.device) ? payload.device : {};
    const type = DEVICE_TYPES.indexOf(device.type) >= 0 ? device.type : 'unknown';
    const deviceId = typeof device.id === 'string' && device.id.trim() ? slug(device.id) || 'device' : 'device';
    const rawPriority = Number(payload.priority);
    const rawTtl = Number(payload.ttlMs);
    const text = typeof payload.text === 'string' ? payload.text.trim().slice(0, TEXT_MAX) : '';
    const id = typeof payload.id === 'string' && payload.id.trim() ? payload.id.trim().slice(0, ID_MAX) : nextId(kind);
    const event = {
      id: id,
      t: Number.isFinite(payload.t) ? Math.round(payload.t) : Date.now(),
      kind: kind,
      result: RESULTS.indexOf(payload.result) >= 0 ? payload.result : 'unknown',
      action: ACTIONS.indexOf(payload.action) >= 0 ? payload.action : 'idle',
      text: text,
      priority: Number.isFinite(rawPriority) ? clamp(Math.round(rawPriority), 0, 4) : DEFAULT_PRIORITY,
      source: ['mhub.device-service', 'mhub.driver'].indexOf(payload.source) >= 0 ? payload.source : 'local',
      device: { id: deviceId, type: type },
      ttlMs: Number.isFinite(rawTtl) ? clamp(Math.round(rawTtl), TTL_MIN, TTL_MAX) : DEFAULT_TTL_MS,
      critical: payload.critical === true,
      connected: typeof payload.connected === 'boolean' ? payload.connected : undefined
    };
    return event;
  }

  // 调试通道（pet:debug）进来的事件不参与 500ms 合并窗口，通过门控后立即下发。
  function ingestEvent(payload) {
    if (disposed) return null;
    const event = normalizeEvent(payload);
    if (!event) {
      log.warn('device event rejected: not a contract event');
      return null;
    }
    if (!allowed(event, readSettings())) return null;
    deliver(event);
    return event;
  }

  function flush() {
    const keys = Array.from(pending.keys());
    let count = 0;
    keys.forEach((key) => {
      if (flushKey(key)) count += 1;
    });
    return count;
  }

  function dispose() {
    disposed = true;
    if (activeAdapter === api) activeAdapter = null;
    pending.forEach((entry) => dropTimer(entry.timer));
    pending.clear();
    timers.forEach((timer) => clearTimeout(timer));
    timers.clear();
    return true;
  }

  const api = {
    ingest: ingest,
    ingestEvent: ingestEvent,
    ingestHostState: ingestHostState,
    ingestHostMode: ingestHostMode,
    hostState: () => ({ updates: hostUpdates, lastUpdateAt: lastHostUpdateAt, devices: hostTracker.devices() }),
    diagnostics: () => ({ lastRejected, lastDelivered }),
    handleHostTip: handleHostTip,
    flush: flush,
    dispose: dispose,
    pendingCount: () => pending.size,
    deliverCount: () => delivered,
    timerCount: () => timers.size
  };
  // 模块级 ipc 监听只认最近创建的那个 adapter（真实运行里就是 device-ipc 建的那一个）。
  activeAdapter = api;
  moduleLog = log;
  return api;
}

// ---- 宿主提示的 ipc 接线 ----
// index.js 不在本次改动范围内，所以本模块在 electron 可用时自己接一条 ipcMain.on；
// 探针在纯 node 下 require('electron') 会抛 MODULE_NOT_FOUND，这里静默跳过，模块保持可独立测试。
let activeAdapter = null;
let moduleLog = normaliseLog(null);

function handleHostTip(payload) {
  if (!activeAdapter) return 0;
  try {
    return activeAdapter.handleHostTip(payload);
  } catch (err) {
    moduleLog.warn('host tip handler threw', err);
    return 0;
  }
}

function onHostTipMessage(_event, payload) {
  handleHostTip(payload);
}

function bindHostTipIpc(ipcMain, channel) {
  if (!ipcMain || typeof ipcMain.on !== 'function') return false;
  const target = channel || ipc.PET_TIP;
  try {
    // 只摘自己这一个监听：重复 require 或热重载时不能叠出两条播报。
    if (typeof ipcMain.removeListener === 'function') ipcMain.removeListener(target, onHostTipMessage);
    ipcMain.on(target, onHostTipMessage);
    return true;
  } catch (err) {
    moduleLog.warn('host tip ipc bind failed: ' + target, err);
    return false;
  }
}

(function bindElectronHostTip() {
  let electron = null;
  try {
    electron = require('electron');
  } catch (err) {
    return;
  }
  if (!electron || !electron.ipcMain) return;
  bindHostTipIpc(electron.ipcMain, ipc.PET_TIP);
})();

module.exports = {
  MERGE_WINDOW_MS,
  MERGE_MAX_HOLD_MS,
  KINDS,
  RESULTS,
  ACTIONS,
  DEVICE_TYPES,
  LIGHT_MODES,
  SILENT_LIGHT_FIELDS,
  slug,
  deviceForName,
  modeLabel,
  colorLabel,
  createAdapter,
  handleHostTip,
  bindHostTipIpc
};
