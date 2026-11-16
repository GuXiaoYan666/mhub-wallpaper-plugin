'use strict';
const URL_RE = /^mchose-renderer:\/\/app\/.*\/index\.html/;
const PREFIX = '[mc-bridge]';
const PUSH_MIN_MS = 100;
const REINJECT_IDLE_MS = 5000;
const MAX_INJECT_ATTEMPTS = 3;
function nowMs() { return Date.now(); }
function escapeJs(json) {
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);
  return String(json).replace(/[\u2028\u2029]/g, function (ch) {
    return ch === LS ? '\\u2028' : '\\u2029';
  });
}
function createBridge(options) {
  const opts = options || {};
  const logger = opts.logger || { debug: function () {}, info: function () {}, warn: function () {}, error: function () {} };
  const injector = opts.injector;
  const getSnapshot = typeof opts.getSnapshot === 'function' ? opts.getSnapshot : function () { return null; };
  const onUplink = typeof opts.onUplink === 'function' ? opts.onUplink : function () {};
  const entries = new Map();
  const attached = new WeakSet();
  let lastJson = '';
  let lastPushAt = 0;
  let trailing = null;
  let pollTimer = null;
  let started = false;
  let electron = null;
  const stats = { injected: 0, injectErrors: 0, pushes: 0, audioPushes: 0, uplinks: 0, parseErrors: 0, lastUplink: null, lastPushAt: 0 };
  function urlOf(wc) { try { return wc.getURL() || ''; } catch (e) { return ''; } }
  function isTarget(wc) {
    try {
      if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return false;
      return URL_RE.test(urlOf(wc));
    } catch (e) { return false; }
  }
  function exec(wc, code) {
    try {
      const p = wc.executeJavaScript(code, false);
      if (p && typeof p.catch === 'function') p.catch(function () { /* 页面切换/销毁，忽略 */ });
      return p;
    } catch (e) {
      return null;
    }
  }
  function messageOf(args) {
    if (typeof args[2] === 'string') return args[2];
    const a0 = args[0];
    if (a0 && typeof a0 === 'object' && typeof a0.message === 'string') return a0.message;
    if (typeof args[1] === 'string') return args[1];
    return null;
  }
  function handleConsole(wc, args) {
    const text = messageOf(args);
    if (!text || text.indexOf(PREFIX) !== 0) return;
    const raw = text.slice(PREFIX.length);
    stats.uplinks++;
    stats.lastUplink = { raw: raw.slice(0, 400), at: nowMs(), wcId: wc && wc.id };
    let msg = null;
    try { msg = JSON.parse(raw); } catch (e) { stats.parseErrors++; logger.warn('uplink parse failed: ' + raw.slice(0, 200)); return; }
    if (!msg || typeof msg !== 'object') { stats.parseErrors++; return; }
    if (msg.t !== 'media' && msg.t !== 'audioView') logger.info('uplink raw: ' + raw.slice(0, 400));
    const entry = entries.get(wc && wc.id);
    if (msg.t === 'audioView' && entry) entry.audioUntil = msg.active === true ? nowMs() + 5000 : 0;
    if (msg.t === 'ready' && entry) {
      entry.ready = true;
      entry.readyAt = nowMs();
      logger.info('uplink ready (wc=' + wc.id + ')');
      pushNow(true);
    }
    try { onUplink(msg, wc); } catch (e) { logger.warn('uplink handler threw: ' + (e && e.message)); }
  }
  function injectInto(entry) {
    const info = injector.get();
    if (!info || !info.ok) { logger.warn('inject payload unavailable: ' + (info && info.error && info.error.message)); return; }
    entry.hash = info.hash;
    entry.injectedAt = nowMs();
    entry.attempts++;
    entry.ready = false;
    try {
      const r = exec(entry.wc, info.payload);
      stats.injected++;
      const id = entry.wc.id;
      if (r && typeof r.then === 'function') {
        r.then(function () { logger.info('injected wc=' + id + ' hash=' + info.hash + ' ui=' + info.hasUi + ' bytes=' + info.bytes); },
               function (err) { entry.hash = ''; stats.injectErrors++; logger.warn('inject failed wc=' + id + ': ' + (err && err.message)); });
      } else {
        logger.info('injected wc=' + entry.wc.id + ' hash=' + info.hash + ' ui=' + info.hasUi);
      }
    } catch (e) {
      entry.hash = '';
      stats.injectErrors++;
      logger.warn('inject threw: ' + (e && e.message));
    }
  }
  function consider(wc) {
    if (!isTarget(wc)) return;
    const info = injector.get();
    let entry = entries.get(wc.id);
    if (!entry) {
      entry = { wc: wc, hash: '', injectedAt: 0, ready: false, readyAt: 0, attempts: 0 };
      entries.set(wc.id, entry);
    }
    if (entry.hash !== info.hash) { injectInto(entry); return; }
    if (!entry.ready && entry.attempts < MAX_INJECT_ATTEMPTS && nowMs() - entry.injectedAt > REINJECT_IDLE_MS) injectInto(entry);
  }
  function attachWebContents(wc) {
    if (!wc || attached.has(wc)) return;
    attached.add(wc);
    try {
      wc.on('console-message', function () { handleConsole(wc, Array.prototype.slice.call(arguments)); });
    } catch (e) { logger.warn('console-message hook failed: ' + (e && e.message)); }
    try {
      wc.on('did-finish-load', function () {
        const e = entries.get(wc.id);
        if (e) { e.ready = false; e.hash = ''; e.attempts = 0; e.audioUntil = 0; }
        logger.debug('did-finish-load wc=' + wc.id + ' url=' + String(urlOf(wc)).slice(0, 120));
        consider(wc);
      });
    } catch (e) { /* ignore */ }
    try {
      wc.on('did-navigate', function () { const e = entries.get(wc.id); if (e) { e.ready = false; e.hash = ''; e.attempts = 0; e.audioUntil = 0; } });
    } catch (e) { /* ignore */ }
    try {
      wc.on('destroyed', function () { entries.delete(wc.id); logger.debug('wc destroyed id=' + wc.id); });
    } catch (e) { /* ignore */ }
    if (isTarget(wc)) consider(wc);
  }
  function pushNow(force, provided) {
    const snapshot = provided || getSnapshot();
    if (!snapshot) return false;
    let json;
    try { json = JSON.stringify(snapshot); } catch (e) { return false; }
    const now = nowMs();
    if (!force && json === lastJson) return false;
    if (!force && now - lastPushAt < PUSH_MIN_MS) {
      if (!trailing) {
        trailing = setTimeout(function () { trailing = null; pushNow(true); }, PUSH_MIN_MS);
        if (trailing && typeof trailing.unref === 'function') trailing.unref();
      }
      return false;
    }
    lastPushAt = now;
    lastJson = json;
    stats.pushes++;
    stats.lastPushAt = now;
    let sent = 0;
    entries.forEach(function (entry) {
      if (!entry.ready || !isTarget(entry.wc)) return;
      const code = 'window.__mcBridge&&window.__mcBridge.apply(' + escapeJs(json) + ')';
      const r = exec(entry.wc, code);
      if (r && typeof r.then === 'function') r.catch(function () { entry.ready = false; });
      sent++;
    });
    return sent > 0;
  }
  function audioVisible(entry) {
    if (!entry.ready || !(entry.audioUntil > nowMs()) || !isTarget(entry.wc)) return false;
    try {
      const owner = entry.wc.getOwnerBrowserWindow && entry.wc.getOwnerBrowserWindow();
      return !owner || (!owner.isDestroyed() && owner.isVisible() && !owner.isMinimized());
    } catch (_) { return false; }
  }
  function pushAudio(summary) {
    const code = 'window.__mcUI && window.__mcUI.applyAudio(' + escapeJs(JSON.stringify(summary)) + ');';
    entries.forEach(function (entry) {
      if (!audioVisible(entry) || entry.audioBusy) return;
      entry.audioBusy = true; stats.audioPushes++;
      Promise.resolve(exec(entry.wc, code)).then(function () { entry.audioBusy = false; }, function () { entry.audioBusy = false; });
    });
  }
  function start() {
    if (started) return this;
    started = true;
    electron = require('electron');
    const app = electron.app;
    const webContents = electron.webContents;
    app.on('web-contents-created', function (_e, wc) {
      try { attachWebContents(wc); } catch (e) { logger.warn('web-contents-created hook: ' + (e && e.message)); }
    });
    Promise.resolve(app.whenReady()).then(function () {
      if (pollTimer) return;
      pollTimer = setInterval(function () {
        try {
          const all = webContents.getAllWebContents();
          for (let i = 0; i < all.length; i++) { attachWebContents(all[i]); consider(all[i]); }
        } catch (e) { logger.debug('poll: ' + (e && e.message)); }
      }, 600);
      if (pollTimer && typeof pollTimer.unref === 'function') pollTimer.unref();
    }).catch(function (e) { logger.warn('whenReady failed: ' + (e && e.message)); });
    return this;
  }
  return {
    start: start,
    push: function (snapshot) { return pushNow(false, snapshot); },
    pushForced: function () { return pushNow(true); },
    pushAudio: pushAudio,
    audioWanted: function () { return Array.from(entries.values()).some(audioVisible); },
    invalidate: function () { lastJson = ''; },
    status: function () {
      const list = [];
      entries.forEach(function (e) { list.push({ id: e.wc.id, ready: !!e.ready, attempts: e.attempts, url: String(urlOf(e.wc)).slice(0, 160) }); });
      return { entries: list, stats: stats, lastJsonBytes: lastJson.length };
    },
    _internal: { entries: entries, consider: consider, handleConsole: handleConsole }
  };
}
module.exports = { createBridge: createBridge, escapeJs: escapeJs, URL_RE: URL_RE, PREFIX: PREFIX, PUSH_MIN_MS: PUSH_MIN_MS };
