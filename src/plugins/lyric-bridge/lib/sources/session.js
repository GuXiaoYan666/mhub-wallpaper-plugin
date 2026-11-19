'use strict';
const ONLINE_LINE_LIMIT = 400;
const SILENT_GRACE_MS = 3000;
function monoMs() { return Number(process.hrtime.bigint() / 1000000n); }
function text(value, max) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max || 200);
}
function trackKey(media) {
  return 'session|' + text(media && media.id, 80) + '|' + text(media && media.title, 160) + '|' +
    text(media && media.artist, 120) + '|' + Math.round((Number(media && media.durationMs) || 0) / 10000);
}
function positionOf(media) {
  if (!media) return 0;
  let pos = Math.max(0, Number(media.positionMs) || 0);
  if (media.playing === true && !/soda|kugou/i.test(String(media.id || ''))) {
    const anchorAt = Number(media.positionAt) > 0 && Number(media.positionAt) <= Date.now()
      ? Number(media.positionAt) : (Number(media.at) || Date.now());
    const rate = Number(media.playbackRate) > 0 ? Number(media.playbackRate) : 1;
    pos += Math.max(0, Date.now() - anchorAt) * rate;
  }
  if (Number(media.durationMs) > 0) pos = Math.min(pos, Number(media.durationMs));
  return Math.max(0, pos);
}
function validLines(lines) {
  if (!Array.isArray(lines)) return null;
  const out = [];
  for (let i = 0; i < lines.length && out.length < ONLINE_LINE_LIMIT; i++) {
    const line = lines[i];
    if (!line || !Number.isFinite(line.timeMs)) continue;
    const content = text(line.text, 300);
    if (!content) continue;
    const item = { timeMs: Math.max(0, line.timeMs), text: content };
    if (line.translation) item.translation = text(line.translation, 300);
    out.push(item);
  }
  return out.length ? out : null;
}
function createSessionSource(options) {
  const opts = options || {};
  const logger = opts.logger || { debug: function () {}, info: function () {}, warn: function () {}, error: function () {} };
  const getConfig = typeof opts.getConfig === 'function' ? opts.getConfig : function () { return {}; };
  const getMedia = typeof opts.getMedia === 'function' ? opts.getMedia : function () { return null; };
  const getOnline = typeof opts.getOnline === 'function' ? opts.getOnline : function () { return null; };
  const onTrack = typeof opts.onTrack === 'function' ? opts.onTrack : function () {};
  const onAnchor = typeof opts.onAnchor === 'function' ? opts.onAnchor : function () {};
  const st = {
    running: false,
    timer: null,
    key: null,
    pendingKey: null,
    pendingSince: 0,
    track: null,
    meta: null,
    lastPos: 0,
    lastPlaying: false,
    lastMediaAt: 0,
    clock: { pos: 0, at: 0, valid: false },
    generation: 0,
    lookupSeq: 0,
    lookupPending: false,
    attempts: 0,
    retryAt: 0,
    polls: 0,
    hits: 0,
    lastError: null
  };
  function clearTrack(reason) {
    if (!st.track && !st.meta) return;
    logger.info('session: 清除歌词 (' + reason + ')');
    st.track = null;
    st.meta = null;
    st.key = null;
    st.pendingKey = null;
    st.generation++;
    try { onTrack(null); } catch (e) { /* ignore */ }
  }
  /* 在线歌词可能因为网络抖动或曲库暂时未索引而首次取不到。
     以前只请求一次，取不到就永远停在这个曲目上；现在失败后按退避自动重试，
     切换曲目时重新计数，避免「必须关掉歌词再打开」才能恢复。 */
  function loadLyrics(generation) {
    const online = getOnline();
    if (!online || !st.meta) return;
    const seq = ++st.lookupSeq;
    st.lookupPending = true;
    online.get(st.meta, function (result) {
      if (generation !== st.generation || seq !== st.lookupSeq) return;
      st.lookupPending = false;
      const lines = result && result.ok === false ? null : validLines(result && result.lines);
      if (!lines) {
        st.lastError = result && result.reason ? { code: String(result.reason).toUpperCase(), message: result.error || '' } : null;
        st.attempts++;
        if (st.attempts >= 6) {
          st.retryAt = Infinity;
        } else {
          const delays = [4000, 8000, 15000, 30000, 60000];
          st.retryAt = Date.now() + delays[Math.min(delays.length - 1, st.attempts - 1)];
        }
        logger.info('session: 歌词未就绪 "' + st.meta.title + '" (' + ((result && result.reason) || 'miss') + ')，第 ' + st.attempts + ' 次尝试');
        return;
      }
      st.hits++;
      st.attempts = 0;
      st.retryAt = 0;
      st.lastError = null;
      st.track = {
        key: st.meta.key,
        source: 'session',
        title: st.meta.title,
        artist: st.meta.artist,
        album: st.meta.album,
        durationMs: st.meta.durationMs,
        lines: lines,
        offsetMs: Number(result.offsetMs) || 0,
        untimed: !!result.untimed,
        artwork: String(result.artwork || '')
      };
      logger.info('session: 歌词就绪 "' + st.meta.title + '" 行数=' + lines.length + (result.cached ? ' 来源=缓存' : ' 来源=在线'));
      try { onTrack(st.track); } catch (e) { /* ignore */ }
      try { onAnchor({ posMs: st.lastPos, playing: st.lastPlaying, at: monoMs() }); } catch (e) { /* ignore */ }
    });
  }
  function beginTrack(media) {
    const key = trackKey(media);
    const generation = ++st.generation;
    st.key = key;
    st.pendingKey = null;
    st.meta = {
      key: key,
      title: text(media.title, 160),
      artist: text(media.artist, 120),
      album: text(media.album, 120),
      durationMs: Math.max(0, Number(media.durationMs) || 0),
      id: text(media.id, 80)
    };
    st.track = null;
    st.attempts = 0;
    st.retryAt = 0;
    st.lastPos = positionOf(media);
    st.lastPlaying = media.playing === true;
    st.lastMediaAt = Date.now();
    const startAt = st.pendingSince || Date.now();
    st.clock = { pos: media.playing ? Math.max(0, Date.now() - startAt) : 0, at: Date.now(), valid: true };
    logger.info('session: 新曲目 "' + st.meta.title + '" - ' + st.meta.artist);
    try { onTrack(null); } catch (e) { /* ignore */ }
    loadLyrics(generation);
  }
  function poll() {
    st.polls++;
    const config = getConfig() || {};
    const sessionCfg = config.session || {};
    const onlineCfg = config.online || {};
    const holdMs = onlineCfg.holdMs >= 0 ? onlineCfg.holdMs : 8000;
    const debounceMs = sessionCfg.changeDebounceMs >= 0 ? sessionCfg.changeDebounceMs : 900;
    if (onlineCfg.enabled === false) { clearTrack('在线歌词已关闭'); return; }
    let media = null;
    try { media = getMedia(); } catch (e) { st.lastError = { code: 'SESSION_READ_THROW', message: String(e && e.message) }; }
    if (!media || !media.title) {
      if (st.track || st.meta) {
        const silent = Date.now() - st.lastMediaAt;
        if (silent > holdMs) clearTrack('媒体会话已结束');
        else if (st.track && silent > SILENT_GRACE_MS) onAnchor({ posMs: st.lastPos, playing: false, at: monoMs() });
      }
      return;
    }
    if (/bilibili|哔哩|bili/i.test(String(media.id || ''))) {
      clearTrack('B站字幕源接管');
      return;
    }
    st.lastMediaAt = Date.now();
    const key = trackKey(media);
    if (st.key !== key) {
      if (st.pendingKey !== key) {
        st.pendingKey = key;
        st.pendingSince = Date.now();
        if (st.track) onAnchor({ posMs: st.lastPos, playing: false, at: monoMs() });
        return;
      }
      if (Date.now() - st.pendingSince < debounceMs) return;
      beginTrack(media);
      return;
    }
    st.pendingKey = null;
    if (!st.track) {
      if (!st.lookupPending && st.meta && Date.now() >= st.retryAt) loadLyrics(st.generation);
      return;
    }
    const now = Date.now();
    const rawPos = Math.max(0, Number(media.positionMs) || 0);
    if (rawPos > 0) {
      st.lastPos = positionOf(media);
      st.clock = { pos: st.lastPos, at: now, valid: true };
    } else if (st.clock.valid) {
      if (media.playing === true) st.clock.pos += Math.max(0, now - st.clock.at);
      st.clock.at = now;
      const durationMs = Number(media.durationMs) || 0;
      st.lastPos = durationMs > 0 ? Math.min(st.clock.pos, durationMs) : st.clock.pos;
    } else {
      st.lastPos = positionOf(media);
    }
    st.lastPlaying = media.playing === true;
    try { onAnchor({ posMs: st.lastPos, playing: st.lastPlaying, at: monoMs() }); } catch (e) { /* ignore */ }
  }
  function safePoll() {
    try { poll(); } catch (e) {
      st.lastError = { code: 'SESSION_POLL_THROW', message: String(e && e.message) };
      logger.debug('session poll threw: ' + (e && e.message));
    }
  }
  return {
    start: function () {
      if (st.running) return this;
      st.running = true;
      safePoll();
      const config = getConfig() || {};
      const ms = config.session && config.session.pollMs > 0 ? config.session.pollMs : 500;
      st.timer = setInterval(safePoll, ms);
      if (st.timer && typeof st.timer.unref === 'function') st.timer.unref();
      return this;
    },
    stop: function () {
      st.running = false;
      if (st.timer) { clearInterval(st.timer); st.timer = null; }
      clearTrack('播放器停止');
      return this;
    },
    /* 用户重新开启歌词显示时立即补一次：当前曲目已识别但歌词还没取到的话，不再等轮询。 */
    retry: function () {
      if (!st.meta || st.track) return this;
      st.attempts = 0;
      st.retryAt = 0;
      if (!st.lookupPending) loadLyrics(st.generation);
      return this;
    },
    status: function () {
      return {
        running: st.running,
        polls: st.polls,
        hits: st.hits,
        key: st.key,
        title: st.meta ? st.meta.title : null,
        artist: st.meta ? st.meta.artist : null,
        lines: st.track ? st.track.lines.length : 0,
        playing: st.lastPlaying,
        error: st.lastError
      };
    },
    _internal: st
  };
}
module.exports = { createSessionSource: createSessionSource };
