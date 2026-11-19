'use strict';
const { createScheduler } = require('./scheduler.js');
const { createKuGouSource } = require('./sources/kugou.js');
const { createSodaSource } = require('./sources/soda.js');
const { createSessionSource } = require('./sources/session.js');
const { createBilibiliSource } = require('./sources/bilibili.js');
const { simplifyLines } = require('./t2s.js');
const stateMod = require('./state.js');
const ANCHOR_FRESH_MS = 4000;
const STATUS_EVERY_MS = 1000;
const STATUS_HEARTBEAT_MS = 5000;
const SOURCE_ORDER = ['kugou', 'soda', 'bilibili', 'session'];
function monoMs() { return Number(process.hrtime.bigint() / 1000000n); }
let plainKey = '';
let plainLines = null;
function lyricLines(track) {
  if (!track || !Array.isArray(track.lines)) return track ? track.lines : null;
  const key = String(track.key) + '|' + track.lines.length;
  if (key !== plainKey) {
    plainKey = key;
    plainLines = simplifyLines(track.lines);
  }
  return plainLines;
}
function createEngine(options) {
  const opts = options || {};
  const logger = opts.logger || { debug: function () {}, info: function () {}, warn: function () {}, error: function () {} };
  const onChange = typeof opts.onChange === 'function' ? opts.onChange : function () {};
  const onLine = typeof opts.onLine === 'function' ? opts.onLine : function () {};
  const getConfig = typeof opts.getConfig === 'function' ? opts.getConfig : function () { return stateMod.loadConfig(); };
  const st = {
    started: false,
    timer: null,
    scheduler: null,
    kugou: null,
    soda: null,
    bilibili: null,
    session: null,
    slots: {
      kugou: { track: null, anchor: { posMs: 0, playing: false }, anchorAt: 0 },
      soda: { track: null, anchor: { posMs: 0, playing: false }, anchorAt: 0 },
      bilibili: { track: null, anchor: { posMs: 0, playing: false }, anchorAt: 0 },
      session: { track: null, anchor: { posMs: 0, playing: false }, anchorAt: 0 }
    },
    active: null,
    line: null,
    error: null,
    emitted: 0,
    lastStatusAt: 0,
    lastStatusSig: '',
    lastStatusText: null
  };
  const media = {};
  function getMedia(source) {
    const item = media[source];
    if (!item || Date.now() - item.at > 5000) return null;
    return Object.assign({}, item, { positionMs: Number.isFinite(item.positionMs) ? item.positionMs + (item.playing ? Date.now() - item.at : 0) : null });
  }
  function cfg() { try { return getConfig() || {}; } catch (e) { return {}; } }
  function getLyric() {
    const config = cfg();
    const on = !!(config.pluginEnabled !== false && config.lyricEnabled !== false);
    const line = st.line;
    const slot = st.active ? st.slots[st.active] : null;
    const track = slot && slot.track;
    const live = st.scheduler ? st.scheduler.getState() : null;
    const lines = track && Array.isArray(track.lines) ? track.lines : null;
    const lineIdx = line && Number.isFinite(line.index) ? line.index : -1;
    let window = null;
    if (lines && lineIdx >= 0) {
      const start = Math.max(0, lineIdx - 2);
      const end = Math.min(lines.length, lineIdx + 3);
      window = [];
      for (let i = start; i < end; i++) {
        const ln = lines[i];
        window.push({ i: i, text: ln.text, translation: ln.translation || '' });
      }
    }
    return {
      on: on,
      text: on && line ? (line.text || '') : '',
      translation: on && line ? (line.translation || '') : '',
      source: line && line.source ? line.source : null,
      title: line && line.title ? line.title : '',
      artist: line && line.artist ? line.artist : '',
      album: track && track.album ? track.album : '',
      artwork: track && track.artwork ? track.artwork : '',
      index: lineIdx,
      total: lines ? lines.length : 0,
      window: window,
      posMs: live && Number.isFinite(live.posMs) ? live.posMs : (line && Number(line.posMs)) || 0,
      durationMs: track && Number(track.durationMs) > 0 ? Number(track.durationMs) : 0,
      playing: !!(on && line && st.active && st.slots[st.active].anchor.playing && isFresh(st.active, monoMs()))
    };
  }
  function anchorPos(slot, now) {
    if (!slot.anchor) return 0;
    const elapsed = slot.anchor.playing ? Math.max(0, now - slot.anchorAt) : 0;
    return Math.max(0, (slot.anchor.posMs || 0) + elapsed);
  }
  function slotTrack(source) {
    const slot = st.slots[source];
    if (!slot.track) return null;
    const config = cfg();
    return {
      key: slot.track.key,
      source: source,
      title: slot.track.title,
      artist: slot.track.artist,
      lines: lyricLines(slot.track),
      offsetMs: slot.track.offsetMs,
      untimed: slot.track.untimed,
      maxChars: config.maxChars > 0 ? config.maxChars : 200,
      showTranslation: config.showTranslation !== false
    };
  }
  function handleSchedulerLine(payload) {
    st.line = payload;
    st.emitted++;
    if (payload.reason !== 'clear') {
      st.lastStatusText = payload.text;
      logger.info('line ' + payload.index + '/' + payload.total + ' [' + payload.source + '] "' + payload.text + '" pos=' + payload.posMs + 'ms ' + payload.reason);
    } else {
      logger.info('line cleared (' + (payload.source || 'none') + ')');
    }
    try { onLine(getLyric(), payload); } catch (e) { logger.warn('onLine threw: ' + (e && e.message)); }
    try { onChange(); } catch (e) { logger.warn('onChange threw: ' + (e && e.message)); }
    try { writeStatus(true); } catch (e) { logger.warn('status write threw: ' + (e && e.message)); }
  }
  function sourceAnchor(which) {
    return function (anchor) {
      if (!anchor) return;
      const slot = st.slots[which];
      const changedPlaying = slot.anchor.playing !== !!anchor.playing;
      slot.anchor = { posMs: Math.max(0, Number(anchor.posMs) || 0), playing: !!anchor.playing };
      slot.anchorAt = monoMs();
      if (st.active === which && st.scheduler) st.scheduler.setAnchor(slot.anchor);
      if (changedPlaying) { try { onChange(); } catch (_) {} }
    };
  }
  function isFresh(which, now) {
    const slot = st.slots[which];
    return !!(slot && slot.track && slot.anchor.playing && (now - slot.anchorAt) < ANCHOR_FRESH_MS);
  }
  function sourceTrack(which) {
    return function (track) {
      const slot = st.slots[which];
      if (!track) {
        if (slot.track) logger.info(which + ': 曲目结束');
        slot.track = null;
        if (st.active === which && st.scheduler) { st.active = null; st.scheduler.setTrack(null); }
        try { onChange(); } catch (e) { /* ignore */ }
        return;
      }
      const changed = !slot.track || slot.track.key !== track.key;
      slot.track = track;
      if (changed) logger.info(which + ': 曲目就绪 "' + track.title + '" 行数=' + (track.lines ? track.lines.length : 0));
      if (!st.scheduler) return;
      if (changed) {
        if (st.active && st.active !== which && currentHolds(monoMs())) {
          logger.info(which + ': 新曲目不抢占正在播放的 ' + st.active);
          try { onChange(); } catch (e) { /* ignore */ }
          return;
        }
        const prevTrackSource = st.active;
        st.active = which;
        if (prevTrackSource !== which) logger.info('source switch ' + (prevTrackSource || 'none') + ' -> ' + which + ' (new track)');
        st.scheduler.setAnchor(slot.anchor);
        st.scheduler.setTrack(slotTrack(which));
      } else if (st.active === which) {
        st.scheduler.setAnchor(slot.anchor);
      }
      try { onChange(); } catch (e) { /* ignore */ }
    };
  }
  function currentHolds(now) {
    const cur = st.active;
    if (!cur) return false;
    const slot = st.slots[cur];
    if (!slot || !slot.track) return false;
    if (!slot.anchor || !slot.anchor.playing) return false;
    return (now - slot.anchorAt) < ANCHOR_FRESH_MS;
  }
  function switchReason(prev, next) {
    if (!next) return 'no source';
    if (!prev) return 'first track';
    const slot = st.slots[prev];
    if (!slot || !slot.track) return 'prev gone';
    if (!slot.anchor || !slot.anchor.playing) return 'prev paused';
    return 'prev stale';
  }
  function pickActive(now) {
    const cur = st.active;
    if (cur && currentHolds(now)) return cur;
    for (let i = 0; i < SOURCE_ORDER.length; i++) {
      const source = SOURCE_ORDER[i];
      if (source !== cur && isFresh(source, now)) return source;
    }
    if (cur && isFresh(cur, now)) return cur;
    return null;
  }
  function tick() {
    const now = monoMs();
    const config = cfg();
    const active = config.pluginEnabled === false || config.lyricEnabled === false ? null : pickActive(now);
    if (active !== st.active) {
      const prevSource = st.active;
      st.active = active;
      if (prevSource !== active) logger.info('source switch ' + (prevSource || 'none') + ' -> ' + (active || 'none') + ' (' + switchReason(prevSource, active) + ')');
      if (active) st.scheduler.setAnchor({ posMs: anchorPos(st.slots[active], now), playing: st.slots[active].anchor.playing });
      st.scheduler.setTrack(active ? slotTrack(active) : null);
    }
    if (now - st.lastStatusAt >= STATUS_EVERY_MS) writeStatus(false);
  }
  function safeTick() { try { tick(); } catch (e) { logger.warn('engine tick threw: ' + (e && e.message)); } }
  function writeStatus(force) {
    const config = cfg();
    const lyric = getLyric();
    const payload = {
      v: 1,
      pluginReady: true,
      pluginEnabled: config.pluginEnabled !== false,
      lyricEnabled: config.lyricEnabled !== false,
      active: st.active,
      lyric: lyric,
      line: st.line ? { index: st.line.index, posMs: st.line.posMs, reason: st.line.reason, at: st.line.at } : null,
      emitted: st.emitted,
      sources: {
        kugou: st.kugou ? st.kugou.status() : null,
        soda: st.soda ? st.soda.status() : null,
        bilibili: st.bilibili ? st.bilibili.status() : null,
        session: st.session ? st.session.status() : null
      },
      error: st.error
    };
    let sig = '';
    try { sig = JSON.stringify(payload); } catch (_) { sig = ''; }
    const now = monoMs();
    if (!force && sig === st.lastStatusSig && now - st.lastStatusAt < STATUS_HEARTBEAT_MS) return;
    st.lastStatusSig = sig;
    st.lastStatusAt = now;
    stateMod.writeStatus(payload);
  }
  function startSources() {
    const config = cfg();
    if (config.pluginEnabled === false) return;
    if (!st.kugou && config.kugou && config.kugou.enabled !== false) {
      st.kugou = createKuGouSource({
        uiTimeline: opts.kugouTimeline,
        logger: logger.child ? logger.child('kugou') : logger,
        getConfig: cfg,
        getMedia: function () { return getMedia('kugou'); },
        onTrack: sourceTrack('kugou'),
        onAnchor: sourceAnchor('kugou'),
        onError: function (e) {
          if (!e) return;
          st.error = { source: 'kugou', code: e.code, message: e.message };
          logger.debug('kugou error: ' + e.code + ' ' + e.message);
        }
      });
      try { st.kugou.start(); } catch (e) { logger.warn('kugou source start failed: ' + (e && e.message)); }
    }
    if (!st.soda && config.soda && config.soda.enabled !== false) {
      st.soda = createSodaSource({
        logger: logger.child ? logger.child('soda') : logger,
        getConfig: cfg,
        onTrack: sourceTrack('soda'),
        onAnchor: sourceAnchor('soda')
      });
      try { st.soda.start(); } catch (e) { logger.warn('soda source start failed: ' + (e && e.message)); }
    }
    if (!st.bilibili && config.bilibili && config.bilibili.enabled !== false && typeof opts.getSessionMedia === 'function') {
      st.bilibili = createBilibiliSource({
        logger: logger.child ? logger.child('bilibili') : logger,
        getConfig: cfg,
        getMedia: opts.getSessionMedia,
        onTrack: sourceTrack('bilibili'),
        onAnchor: sourceAnchor('bilibili')
      });
      try { st.bilibili.start(); } catch (e) { logger.warn('bilibili source start failed: ' + (e && e.message)); }
    }
    if (!st.session && config.session && config.session.enabled !== false &&
        config.online && config.online.enabled !== false && typeof opts.getSessionMedia === 'function') {
      st.session = createSessionSource({
        logger: logger.child ? logger.child('session') : logger,
        getConfig: cfg,
        getMedia: opts.getSessionMedia,
        getOnline: function () { return opts.online || null; },
        onTrack: sourceTrack('session'),
        onAnchor: sourceAnchor('session')
      });
      try { st.session.start(); } catch (e) { logger.warn('session source start failed: ' + (e && e.message)); }
    }
  }
  function stopSources() {
    if (st.kugou) { try { st.kugou.stop(); } catch (e) { /* ignore */ } st.kugou = null; }
    if (st.soda) { try { st.soda.stop(); } catch (e) { /* ignore */ } st.soda = null; }
    if (st.bilibili) { try { st.bilibili.stop(); } catch (e) { /* ignore */ } st.bilibili = null; }
    if (st.session) { try { st.session.stop(); } catch (e) { /* ignore */ } st.session = null; }
    for (let i = 0; i < SOURCE_ORDER.length; i++) st.slots[SOURCE_ORDER[i]].track = null;
    st.active = null;
    if (st.scheduler) st.scheduler.setTrack(null);
  }
  return {
    start: function () {
      if (st.started) return this;
      st.started = true;
      st.scheduler = createScheduler({
        logger: logger.child ? logger.child('scheduler') : logger,
        tickMs: (cfg().tickMs > 0 ? cfg().tickMs : 100),
        onLine: handleSchedulerLine
      });
      st.scheduler.start();
      startSources();
      st.timer = setInterval(safeTick, 100);
      if (st.timer && typeof st.timer.unref === 'function') st.timer.unref();
      logger.info('engine started');
      return this;
    },
    stop: function () {
      st.started = false;
      if (st.timer) { clearInterval(st.timer); st.timer = null; }
      if (st.scheduler) st.scheduler.stop();
      stopSources();
      return this;
    },
    getLyric: getLyric,
    ingestMedia: function (info) {
      const sessions = Array.isArray(info && info.sessions) ? info.sessions : info ? [info] : [];
      const item = sessions.find(s => /kugou/i.test(String(s.sourceApp || '')));
      if (!item) { delete media.kugou; return; }
      const positionSeconds = Number(item.positionSeconds);
      const hasLivePosition = Number.isFinite(positionSeconds) && positionSeconds > 0;
      media.kugou = { title: String(item.title || ''), artist: String(item.artist || ''),
        playing: item.isPlaying === true,
        positionMs: hasLivePosition ? positionSeconds * 1000 : null,
        at: Date.now() };
    },
    setLyricEnabled: function (on) {
      const r = stateMod.saveConfig({ lyricEnabled: !!on });
      logger.info('lyric display -> ' + (on ? 'on' : 'off'));
      if (!on) {
        st.line = null;
        st.active = null;
        if (st.scheduler) st.scheduler.setTrack(null);
      } else {
        /* 首次开启时把来源、当前曲目与时间轴重新对齐，等价于用户手动「关闭再打开」。
           如果来源在插件启动时没有跑起来，或当前曲目歌词没取到，这里立即补齐。 */
        startSources();
        if (st.scheduler) st.scheduler.start();
        if (st.session && typeof st.session.retry === 'function') {
          try { st.session.retry(); } catch (e) { /* ignore */ }
        }
        const active = pickActive(monoMs());
        st.active = active;
        if (st.scheduler) {
          if (active) {
            st.scheduler.setAnchor({ posMs: anchorPos(st.slots[active], monoMs()), playing: st.slots[active].anchor.playing });
            st.scheduler.setTrack(slotTrack(active));
          } else {
            st.scheduler.setTrack(null);
          }
        }
      }
      try { onChange(); } catch (e) { /* ignore */ }
      writeStatus();
      return r;
    },
    toggleLyric: function () {
      const cur = cfg().lyricEnabled !== false;
      return this.setLyricEnabled(!cur);
    },
    setPluginEnabled: function (on) {
      const r = stateMod.saveConfig({ pluginEnabled: !!on });
      logger.info('plugin -> ' + (on ? 'on' : 'off'));
      if (on) { startSources(); if (st.scheduler) st.scheduler.start(); }
      else { st.line = null; stopSources(); }
      try { onChange(); } catch (e) { /* ignore */ }
      writeStatus();
      return r;
    },
    setOnlineEnabled: function (on) {
      const r = stateMod.saveConfig({ online: { enabled: !!on } });
      logger.info('online lyrics -> ' + (on ? 'on' : 'off'));
      if (on) {
        startSources();
      } else {
        if (st.session) { try { st.session.stop(); } catch (e) { /* ignore */ } st.session = null; }
        st.slots.session.track = null;
        st.slots.session.anchor = { posMs: 0, playing: false };
        if (st.active === 'session') {
          st.active = null;
          if (st.scheduler) st.scheduler.setTrack(null);
        }
      }
      try { onChange(); } catch (e) { /* ignore */ }
      writeStatus(true);
      return r;
    },
    pollSodaNow: function () { return st.soda ? st.soda.pollNow() : null; },
    status: function () {
      return {
        started: st.started,
        active: st.active,
        emitted: st.emitted,
        lyric: getLyric(),
        line: st.line ? { index: st.line.index, text: st.line.text, posMs: st.line.posMs, at: st.line.at } : null,
        kugou: st.kugou ? st.kugou.status() : null,
        soda: st.soda ? st.soda.status() : null,
        bilibili: st.bilibili ? st.bilibili.status() : null,
        session: st.session ? st.session.status() : null
      };
    },
    bilibiliStatus: function () { return st.bilibili ? st.bilibili.status() : null; },
    _internal: st
  };
}
module.exports = { createEngine: createEngine, ANCHOR_FRESH_MS: ANCHOR_FRESH_MS };
