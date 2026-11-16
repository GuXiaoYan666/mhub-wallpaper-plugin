'use strict';
const fs = require('fs');
const path = require('path');
const P = require('./paths.js');
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const TARGETS = [P.LOG_FILE, P.MIRROR_LOG_FILE].filter(function (f, i, a) { return a.indexOf(f) === i; });
const state = { ready: false, day: null, failed: false, lastRotateCheck: 0, targets: TARGETS.slice() };
function dayKey(d) {
  const t = d instanceof Date ? d : new Date(d);
  if (!(t instanceof Date) || isNaN(t.getTime())) return 'unknown';
  return t.getFullYear() + '-' + (t.getMonth() + 1) + '-' + t.getDate();
}
function ensureDirs() {
  if (state.ready) return;
  state.ready = true;
  for (let i = 0; i < TARGETS.length; i++) {
    try { fs.mkdirSync(path.dirname(TARGETS[i]), { recursive: true }); } catch (e) { /* 目录建不出来就退化为只写另一个目标 */ }
  }
}
function rotateIfNeeded(now) {
  const today = dayKey(now);
  if (state.day === today) return;
  state.day = today;
  for (let i = 0; i < TARGETS.length; i++) {
    const f = TARGETS[i];
    try {
      const st = fs.statSync(f);
      if (!st.isFile()) continue;
      if (dayKey(st.mtimeMs) === today) continue;
      const old = f + '.1';
      try { fs.unlinkSync(old); } catch (e) { /* 没有旧 .1 */ }
      fs.renameSync(f, old);
    } catch (e) { /* 文件还不存在 */ }
  }
}
function append(line) {
  ensureDirs();
  let wrote = false;
  for (let i = 0; i < TARGETS.length; i++) {
    try { fs.appendFileSync(TARGETS[i], line); wrote = true; } catch (e) { /* 换下一个目标 */ }
  }
  if (!wrote && !state.failed) {
    state.failed = true;
    try { console.error('[lyric-bridge] log unavailable: ' + line.trim()); } catch (e) { /* ignore */ }
  }
  return wrote;
}
function format(level, tag, scope, message) {
  const d = new Date();
  const iso = d.toISOString();
  const head = '[' + iso + '] [' + level + '] [' + tag + ']' + (scope ? ' [' + scope + ']' : '');
  return head + ' ' + message;
}
function stringifyExtra(extra) {
  if (extra === undefined || extra === null) return '';
  if (typeof extra === 'string') return ' ' + extra;
  if (extra instanceof Error) return ' ' + (extra.stack || extra.message || String(extra));
  try { return ' ' + JSON.stringify(extra); } catch (e) { return ' ' + String(extra); }
}
function createLogger(options) {
  const opts = options || {};
  const tag = opts.tag || 'lyric-bridge';
  const min = LEVELS[opts.level] || (process.env.LYRIC_BRIDGE_DEBUG ? LEVELS.debug : LEVELS.info);
  function emit(level, scope, message, extra) {
    if (LEVELS[level] < min) return;
    const line = format(level, tag, scope, String(message) + stringifyExtra(extra)) + '\n';
    const now = Date.now();
    if (now - state.lastRotateCheck > 30000) { state.lastRotateCheck = now; rotateIfNeeded(now); }
    append(line);
  }
  const logger = {
    tag: tag,
    file: P.LOG_FILE,
    mirror: P.MIRROR_LOG_FILE,
    debug: function (m, e) { emit('debug', '', m, e); },
    info: function (m, e) { emit('info', '', m, e); },
    warn: function (m, e) { emit('warn', '', m, e); },
    error: function (m, e) { emit('error', '', m, e); },
    child: function (scope) {
      return {
        scope: scope,
        debug: function (m, e) { emit('debug', scope, m, e); },
        info: function (m, e) { emit('info', scope, m, e); },
        warn: function (m, e) { emit('warn', scope, m, e); },
        error: function (m, e) { emit('error', scope, m, e); }
      };
    },
    line: format,
    targets: TARGETS.slice()
  };
  return logger;
}
function crashLog(tagName, err) {
  try {
    const line = format('error', tagName || 'lyric-bridge', '', 'fatal: ' + ((err && (err.stack || err.message)) || String(err))) + '\n';
    ensureDirs();
    append(line);
  } catch (e) { /* 绝不再抛 */ }
}
module.exports = {
  createLogger: createLogger,
  crashLog: crashLog,
  paths: P,
  LOG_LEVELS: LEVELS
};
