'use strict';
const bilibili = require('../bilibili.js');
function monoMs() { return Number(process.hrtime.bigint() / 1000000n); }
function text(value, max) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max || 200);
}
function isBilibili(media) {
  if (!media) return false;
  const id = String(media.id || '');
  return /bilibili|哔哩|bili/i.test(id);
}
function isBrowser(media) {
  if (!media) return false;
  return /chrome|edge|firefox|brave|opera|vivaldi/i.test(String(media.id || ''));
}
function positionOf(media) {
  if (!media) return 0;
  let pos = Math.max(0, Number(media.positionMs) || 0);
  if (media.playing === true) {
    const anchorAt = Number(media.positionAt) > 0 && Number(media.positionAt) <= Date.now()
      ? Number(media.positionAt) : (Number(media.at) || Date.now());
    const rate = Number(media.playbackRate) > 0 ? Number(media.playbackRate) : 1;
    pos += Math.max(0, Date.now() - anchorAt) * rate;
  }
  if (Number(media.durationMs) > 0) pos = Math.min(pos, Number(media.durationMs));
  return Math.max(0, pos);
}
function createBilibiliSource(options) {
  const opts = options || {};
  const logger = opts.logger || { debug: function () {}, info: function () {}, warn: function () {}, error: function () {} };
  const getConfig = typeof opts.getConfig === 'function' ? opts.getConfig : function () { return {}; };
  const getMedia = typeof opts.getMedia === 'function' ? opts.getMedia : function () { return null; };
  const onTrack = typeof opts.onTrack === 'function' ? opts.onTrack : function () {};
  const onAnchor = typeof opts.onAnchor === 'function' ? opts.onAnchor : function () {};
  const client = opts.client || bilibili;
  const st = {
    running: false,
    timer: null,
    key: null,
    track: null,
    meta: null,
    generation: 0,
    resolving: false,
    retryAt: 0,
    lastMediaAt: 0,
    lastPos: 0,
    lastPlaying: false,
    clock: { pos: 0, at: 0, valid: false },
    web: false,
    estimated: false,
    state: 'idle',
    error: null,
    bvid: null,
    videoTitle: null,
    lines: 0,
    cached: false,
    polls: 0,
    hits: 0
  };
  function holdMs() {
    const c = getConfig() || {};
    return c.bilibili && c.bilibili.holdMs >= 0 ? c.bilibili.holdMs : 8000;
  }
  function retryMs() {
    const c = getConfig() || {};
    return c.bilibili && c.bilibili.retryMs > 0 ? c.bilibili.retryMs : 30000;
  }
  function enabled() {
    const c = getConfig() || {};
    return !c.bilibili || c.bilibili.enabled !== false;
  }
  function webEnabled() {
    const c = getConfig() || {};
    return !c.bilibili || c.bilibili.web !== false;
  }
  function setState(state, error) {
    st.state = state;
    st.error = error || null;
  }
  function reset() {
    if (!st.track && st.state === 'idle') return;
    st.track = null;
    st.meta = null;
    st.key = null;
    st.bvid = null;
    st.videoTitle = null;
    st.lines = 0;
    st.cached = false;
    st.web = false;
    st.estimated = false;
    st.generation++;
    st.resolving = false;
    st.retryAt = 0;
    setState('idle', null);
    try { onTrack(null); } catch (e) { /* ignore */ }
  }
  async function resolve(media, generation, web) {
    if (st.resolving) return;
    st.resolving = true;
    setState('resolving', null);
    try {
      const found = web ? await client.findForWeb(media) : await client.findForMedia(media);
      if (generation !== st.generation) return;
      if (!found || found.ok === false) {
        const code = found && found.error ? String(found.error.code || 'NO_VIDEO') : 'NO_VIDEO';
        setState(code === 'NO_BVID' ? 'no-bvid' : 'no-video', found && found.error ? found.error.message : '');
        st.retryAt = Date.now() + (web ? Math.max(60000, retryMs()) : retryMs());
        return;
      }
      st.bvid = found.bvid;
      st.videoTitle = text(found.title, 160);
      st.meta = {
        key: 'bilibili|' + found.bvid,
        title: text(found.title, 160),
        artist: text(found.artist, 120),
        album: '',
        durationMs: Math.max(0, Number(found.durationMs) || 0)
      };
      const cids = Array.isArray(found.cids) ? found.cids : [];
      for (let i = 0; i < cids.length; i++) {
        let sub = null;
        try { sub = await client.subtitlesFor(found.bvid, cids[i]); }
        catch (e) { sub = { ok: false, error: { code: 'THROW', message: String(e && e.message) } }; }
        if (generation !== st.generation) return;
        if (sub && sub.ok) {
          st.hits++;
          st.lines = sub.lines.length;
          st.cached = !!sub.cached;
          st.track = {
            key: st.meta.key,
            source: 'bilibili',
            title: st.meta.title,
            artist: st.meta.artist,
            album: '',
            durationMs: st.meta.durationMs,
            lines: sub.lines,
            offsetMs: 0,
            untimed: false
          };
          setState('ready', null);
          logger.info('bilibili: 字幕就绪 "' + st.meta.title + '" 行数=' + sub.lines.length + (sub.cached ? ' 来源=缓存' : ' 来源=在线'));
          try { onTrack(st.track); } catch (e) { /* ignore */ }
          try { onAnchor({ posMs: st.lastPos, playing: st.lastPlaying, at: monoMs() }); } catch (e) { /* ignore */ }
          return;
        }
        const code = sub && sub.error ? String(sub.error.code || '') : '';
        if (code === 'NO_COOKIE') {
          setState('no-cookie', 'B 站字幕需要 SESSDATA');
          st.retryAt = Date.now() + 5000;
          return;
        }
        if (code !== 'NO_SUBTITLE' && code !== 'EMPTY_SUBTITLE') {
          setState('error', sub && sub.error ? sub.error.message : '');
          st.retryAt = Date.now() + retryMs();
          return;
        }
      }
      setState('no-subtitle', '该视频没有可用字幕');
      st.retryAt = Date.now() + 120000;
    } catch (e) {
      if (generation !== st.generation) return;
      setState('error', String(e && e.message));
      st.retryAt = Date.now() + retryMs();
      logger.debug('bilibili resolve failed: ' + (e && e.message));
    } finally {
      st.resolving = false;
    }
  }
  function poll() {
    st.polls++;
    if (!enabled()) { reset(); return; }
    let media = null;
    try { media = getMedia(); } catch (e) { /* ignore */ }
    const native = isBilibili(media);
    const web = !native && !!media && !!media.title && isBrowser(media) && webEnabled();
    if (!media || !media.title || (!native && !web)) {
      if (st.track || st.meta) {
        if (Date.now() - st.lastMediaAt > holdMs()) reset();
        else if (st.track) onAnchor({ posMs: st.lastPos, playing: false, at: monoMs() });
      } else if (st.state !== 'idle') {
        setState('idle', null);
      }
      return;
    }
    st.lastMediaAt = Date.now();
    st.web = web;
    const key = String(media.key || (media.id + '|' + media.title));
    if (key !== st.key) {
      st.key = key;
      st.generation++;
      st.track = null;
      st.meta = null;
      st.resolving = false;
      st.lastPos = 0;
      st.clock = { pos: 0, at: 0, valid: false };
      st.retryAt = 0;
      setState('resolving', null);
      try { onTrack(null); } catch (e) { /* ignore */ }
    }
    const now = Date.now();
    const rawPos = Math.max(0, Number(media.positionMs) || 0);
    const hasTimeline = rawPos > 0 || (Number(media.durationMs) || 0) > 0;
    st.estimated = !hasTimeline;
    if (rawPos > 0) {
      st.lastPos = positionOf(media);
      st.clock = { pos: st.lastPos, at: now, valid: true };
    } else if (!st.clock.valid && media.playing === true) {
      st.clock = { pos: 0, at: now, valid: true };
      st.lastPos = 0;
    } else if (st.clock.valid) {
      if (media.playing === true) st.clock.pos += Math.max(0, now - st.clock.at);
      st.clock.at = now;
      const duration = Number(media.durationMs) || 0;
      st.lastPos = duration > 0 ? Math.min(st.clock.pos, duration) : st.clock.pos;
    } else {
      st.lastPos = positionOf(media);
    }
    st.lastPlaying = media.playing === true;
    if (!st.track && !st.resolving && now >= st.retryAt) {
      resolve(media, st.generation, web).catch(function (e) { logger.debug('bilibili resolve threw: ' + (e && e.message)); });
    }
    if (st.track) {
      try { onAnchor({ posMs: st.lastPos, playing: st.lastPlaying, at: monoMs() }); } catch (e) { /* ignore */ }
    }
  }
  function safePoll() {
    try { poll(); } catch (e) { logger.debug('bilibili poll threw: ' + (e && e.message)); }
  }
  return {
    start: function () {
      if (st.running) return this;
      st.running = true;
      safePoll();
      const c = getConfig() || {};
      const ms = c.bilibili && c.bilibili.pollMs > 0 ? c.bilibili.pollMs : 1000;
      st.timer = setInterval(safePoll, ms);
      if (st.timer && typeof st.timer.unref === 'function') st.timer.unref();
      return this;
    },
    stop: function () {
      st.running = false;
      if (st.timer) { clearInterval(st.timer); st.timer = null; }
      reset();
      return this;
    },
    pollNow: function () { safePoll(); return this.status(); },
    status: function () {
      return {
        running: st.running,
        state: st.state,
        error: st.error,
        bvid: st.bvid,
        title: st.videoTitle || (st.meta ? st.meta.title : null),
        lines: st.lines,
        cached: st.cached,
        web: st.web,
        estimated: st.estimated,
        playing: st.lastPlaying,
        hasCookie: typeof client.hasCookie === 'function' ? client.hasCookie() : false,
        polls: st.polls,
        hits: st.hits
      };
    },
    _internal: st
  };
}
module.exports = { createBilibiliSource: createBilibiliSource, isBilibili: isBilibili };
