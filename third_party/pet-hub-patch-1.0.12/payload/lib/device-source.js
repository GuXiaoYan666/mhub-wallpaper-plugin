'use strict';

const fs = require('fs');
const path = require('path');

const WATCH_DEBOUNCE_MS = 200;
const POLL_INTERVAL_MS = 1500;
const RETRY_MAX = 3;
const RETRY_DELAY_MS = 60;
const LOG_THROTTLE_MS = 30000;

// 宿主只把这三份可回读的设备状态写在磁盘上（docs/P0-CONTRACT.md 第 12 节）。
const FILES = Object.freeze([
  { key: 'light', name: 'light.json' },
  { key: 'eq', name: 'eq.json' },
  { key: 'keyboardLight', name: 'keyboardLight.json' }
]);

const LIGHT_FIELDS = ['enable', 'speed', 'brightness', 'mode', 'color', 'direction', 'colors', 'index'];
const KEYBOARD_FIELDS = ['effectKey', 'switchValue', 'detail'];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function unionKeys(a, b) {
  const out = [];
  const push = (key) => {
    if (out.indexOf(key) < 0) out.push(key);
  };
  if (isPlainObject(a)) Object.keys(a).forEach(push);
  if (isPlainObject(b)) Object.keys(b).forEach(push);
  return out;
}

function unionFields(before, after, preferred) {
  const out = [];
  const push = (key) => {
    if (out.indexOf(key) < 0) out.push(key);
  };
  (preferred || []).forEach(push);
  if (isPlainObject(before)) Object.keys(before).forEach(push);
  if (isPlainObject(after)) Object.keys(after).forEach(push);
  return out;
}

function sameValue(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) {
      if (!sameValue(a[index], b[index])) return false;
    }
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (!hasOwn(b, key) || !sameValue(a[key], b[key])) return false;
    }
    return true;
  }
  return false;
}

// 每条变化都带上 snapshot（变化字段所属的那一份 next 对象），适配层据此拿同设备兄弟字段拼文案。
function pushField(out, file, deviceKey, field, before, after, snapshot) {
  const prev = isPlainObject(before) && hasOwn(before, field) ? before[field] : undefined;
  const next = isPlainObject(after) && hasOwn(after, field) ? after[field] : undefined;
  if (sameValue(prev, next)) return;
  out.push({
    file: file,
    deviceKey: deviceKey,
    field: field,
    prev: prev,
    next: next,
    snapshot: snapshot || {}
  });
}

function diffLight(prev, next) {
  const out = [];
  unionKeys(prev, next).forEach((deviceKey) => {
    const before = isPlainObject(prev[deviceKey]) ? prev[deviceKey] : null;
    const after = isPlainObject(next[deviceKey]) ? next[deviceKey] : null;
    unionFields(before, after, LIGHT_FIELDS).forEach((field) => {
      pushField(out, 'light', deviceKey, field, before, after, after || before || {});
    });
  });
  return out;
}

// eq.json 里唯一与时序有关的字段是 current（设备名 -> 预设名）；预置数据本体改动不播报。
function diffEq(prev, next) {
  const out = [];
  const before = isPlainObject(prev.current) ? prev.current : {};
  const after = isPlainObject(next.current) ? next.current : {};
  unionKeys(before, after).forEach((deviceKey) => {
    const prevName = before[deviceKey];
    const nextName = after[deviceKey];
    if (sameValue(prevName, nextName)) return;
    out.push({
      file: 'eq',
      deviceKey: deviceKey,
      field: 'current',
      prev: prevName,
      next: nextName,
      snapshot: after
    });
  });
  return out;
}

function keyboardItems(root) {
  const map = {};
  const list = isPlainObject(root) && Array.isArray(root.keyboardMusicDanceConfig) ? root.keyboardMusicDanceConfig : [];
  list.forEach((item) => {
    if (!isPlainObject(item)) return;
    if (typeof item.keyboardKey !== 'string' || !item.keyboardKey) return;
    map[item.keyboardKey] = item;
  });
  return map;
}

function diffKeyboardLight(prev, next) {
  const out = [];
  const before = keyboardItems(prev);
  const after = keyboardItems(next);
  unionKeys(before, after).forEach((deviceKey) => {
    const b = before[deviceKey] || null;
    const a = after[deviceKey] || null;
    unionFields(b, a, KEYBOARD_FIELDS).forEach((field) => {
      pushField(out, 'keyboardLight', deviceKey, field, b, a, a || b || {});
    });
  });
  return out;
}

const DIFFERS = {
  light: diffLight,
  eq: diffEq,
  keyboardLight: diffKeyboardLight
};

function diffFor(fileKey, prev, next) {
  const differ = DIFFERS[fileKey];
  if (!differ) return [];
  return differ(isPlainObject(prev) ? prev : {}, isPlainObject(next) ? next : {});
}

function normaliseLog(log) {
  const sink = log || {};
  const pick = (level) => (typeof sink[level] === 'function' ? sink[level].bind(sink) : () => {});
  return { debug: pick('debug'), info: pick('info'), warn: pick('warn'), error: pick('error') };
}

function resolveConfigDir(app) {
  let base = null;
  try {
    if (app && typeof app.getPath === 'function') base = app.getPath('appData');
  } catch (err) {
    base = null;
  }
  if (!base || typeof base !== 'string') return null;
  return path.join(base, 'MCHOSEHUB', 'files', 'config');
}

function createConfigSource(options) {
  const opts = options || {};
  const dir = typeof opts.dir === 'string' && opts.dir ? opts.dir : null;
  const onChange = typeof opts.onChange === 'function' ? opts.onChange : null;
  const log = normaliseLog(opts.log);
  const timers = new Set();
  const items = FILES.map((entry) => ({
    key: entry.key,
    name: entry.name,
    file: dir ? path.join(dir, entry.name) : null,
    current: null,
    sig: null,
    ok: false,
    error: null,
    lastLogAt: 0,
    changes: 0,
    // 在途读取的令牌（0 = 空闲）。布尔 busy 在 stop() 清定时器后会永久卡住，
    // 换成单调令牌 + 纪元：纪元一变，旧回调的 done() 就再也改不动状态。
    pending: 0
  }));
  const byName = {};
  items.forEach((item) => {
    byName[item.name] = item;
  });
  let watcher = null;
  let pollTimer = null;
  let debounceTimer = null;
  let dirty = null;
  let started = false;
  // start()/stop() 各推进一次纪元，用来判定"这个回调是不是属于还在跑的那一轮"。
  let epoch = 0;
  let seq = 0;
  let baselineAt = 0;
  let changeCount = 0;
  let lastChangeAt = 0;

  function later(ms, fn) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      try {
        fn();
      } catch (err) {
        log.warn('device source timer failed', err);
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

  function logThrottled(item, message, error) {
    const now = Date.now();
    if (now - item.lastLogAt < LOG_THROTTLE_MS) return;
    item.lastLogAt = now;
    log.warn(message, error);
  }

  function emit(changes) {
    if (!onChange) return;
    try {
      onChange(changes);
    } catch (err) {
      log.warn('device source onChange threw', err);
    }
  }

  function apply(item, data) {
    if (!started) return;
    if (item.current === null) {
      item.current = data;
      item.ok = true;
      item.error = null;
      if (!baselineAt) baselineAt = Date.now();
      return;
    }
    const changes = diffFor(item.key, item.current, data);
    item.current = data;
    item.ok = true;
    item.error = null;
    if (!changes.length) return;
    item.changes += changes.length;
    changeCount += changes.length;
    lastChangeAt = Date.now();
    emit(changes);
  }

  function fail(item, error) {
    if (!started) return;
    item.ok = false;
    item.error = error;
    // 保留 sig=null，让下一轮轮询（1.5s）重新读，半截写入可自愈。
    item.sig = null;
    logThrottled(item, 'device source parse failed, skipped: ' + item.file, error);
  }

  // 回调只在该读取仍属于当前纪元/当前令牌时才允许改状态。
  function current(item, token) {
    return started && item.pending === token;
  }

  function readJson(item, attempt, token, done) {
    fs.readFile(item.file, 'utf8', (readErr, text) => {
      if (!current(item, token)) {
        done();
        return;
      }
      if (readErr) {
        if (readErr.code === 'ENOENT') {
          item.ok = false;
          done();
          return;
        }
        if (attempt < RETRY_MAX) {
          later(RETRY_DELAY_MS, () => readJson(item, attempt + 1, token, done));
          return;
        }
        fail(item, readErr);
        done();
        return;
      }
      let data = null;
      let parseErr = null;
      try {
        data = JSON.parse(text);
      } catch (err) {
        parseErr = err;
      }
      if (!parseErr && !isPlainObject(data)) parseErr = new Error('payload is not an object');
      if (parseErr) {
        if (attempt < RETRY_MAX) {
          later(RETRY_DELAY_MS, () => readJson(item, attempt + 1, token, done));
          return;
        }
        fail(item, parseErr);
        done();
        return;
      }
      apply(item, data);
      done();
    });
  }

  function refresh(item, reason) {
    if (!started || !item || !item.file || item.pending) return;
    const startedEpoch = epoch;
    fs.stat(item.file, (statErr, stat) => {
      // stop()/start() 之后才回来的 stat 一律作废，不许动新纪元的状态。
      if (!started || startedEpoch !== epoch || item.pending) return;
      if (statErr) {
        if (statErr.code !== 'ENOENT') logThrottled(item, 'device source stat failed: ' + item.file, statErr);
        return;
      }
      const sig = String(stat.mtimeMs) + ':' + String(stat.size);
      if (reason !== 'baseline' && item.sig === sig) return;
      item.sig = sig;
      const token = ++seq;
      item.pending = token;
      readJson(item, 0, token, () => {
        if (item.pending === token) item.pending = 0;
      });
    });
  }

  function scheduleRefresh(item) {
    if (!started) return;
    if (!dirty) dirty = new Set();
    dirty.add(item);
    dropTimer(debounceTimer);
    debounceTimer = later(WATCH_DEBOUNCE_MS, () => {
      debounceTimer = null;
      const batch = dirty ? Array.from(dirty) : [];
      dirty = null;
      batch.forEach((entry) => refresh(entry, 'watch'));
    });
  }

  function onWatchEvent(kind, filename) {
    if (!started) return;
    const name = typeof filename === 'string' ? filename : '';
    if (name && byName[name]) {
      scheduleRefresh(byName[name]);
      return;
    }
    // Windows 上偶尔只报目录或 null，退化成三份文件全查。
    items.forEach((item) => scheduleRefresh(item));
  }

  function schedulePoll() {
    if (!started) return;
    pollTimer = later(POLL_INTERVAL_MS, () => {
      pollTimer = null;
      if (!started) return;
      items.forEach((item) => refresh(item, 'poll'));
      schedulePoll();
    });
  }

  function start() {
    if (started) return state();
    if (!dir) {
      log.warn('device source disabled: no config directory');
      return state();
    }
    started = true;
    epoch += 1;
    // 新纪元从干净的令牌开始：上一轮 stop() 打断的在途读取不能再置位/占用。
    items.forEach((item) => {
      item.pending = 0;
    });
    items.forEach((item) => refresh(item, 'baseline'));
    try {
      watcher = fs.watch(dir, { persistent: false }, onWatchEvent);
      if (watcher && typeof watcher.on === 'function') {
        watcher.on('error', (err) => log.warn('device source watch error: ' + dir, err));
      }
    } catch (err) {
      watcher = null;
      log.warn('device source watch unavailable, polling only: ' + dir, err);
    }
    schedulePoll();
    return state();
  }

  function stop() {
    started = false;
    // 推进纪元并把令牌清零：被清掉的定时器不会再来 done()，旧读取的收尾也全部作废。
    // （A7 的根因就是 done() 永不执行、busy 永久为 true，此后该文件不再刷新。）
    epoch += 1;
    items.forEach((item) => {
      item.pending = 0;
    });
    if (watcher) {
      try {
        watcher.close();
      } catch (err) {
        log.warn('device source watch close failed', err);
      }
      watcher = null;
    }
    dropTimer(pollTimer);
    pollTimer = null;
    dropTimer(debounceTimer);
    debounceTimer = null;
    timers.forEach((timer) => clearTimeout(timer));
    timers.clear();
    dirty = null;
    return state();
  }

  function state() {
    return {
      dir: dir,
      started: started,
      watching: !!watcher,
      timers: timers.size,
      baselineAt: baselineAt,
      changeCount: changeCount,
      lastChangeAt: lastChangeAt,
      files: items.map((item) => ({
        key: item.key,
        name: item.name,
        ok: item.ok,
        error: item.error ? String(item.error.message || item.error) : null,
        sig: item.sig,
        changes: item.changes
      }))
    };
  }

  return { start: start, stop: stop, state: state };
}

module.exports = {
  FILES,
  WATCH_DEBOUNCE_MS,
  POLL_INTERVAL_MS,
  RETRY_MAX,
  RETRY_DELAY_MS,
  LOG_THROTTLE_MS,
  resolveConfigDir,
  diffFor,
  sameValue,
  createConfigSource
};
