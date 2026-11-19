'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('./http.js');
const P = require('./paths.js');
const stateMod = require('./state.js');
const { parseLyric } = require('./sources/soda.js');
const netease = require('./sources/netease.js');
const PROVIDER = 'lrclib';
const BASE = 'https://lrclib.net';
const USER_AGENT = 'LyricBridge/1.3.10 (MCHOSE K20 GT lyric bridge)';
const MEMORY_LIMIT = 60;
const MAX_BODY = 2 * 1024 * 1024;
const CACHE_DIR = P.LYRICS_DIR;
function clean(value, max) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max || 200);
}
function stripTitleNoise(title) {
  let t = clean(title, 160);
  if (!t) return t;
  t = t.replace(/[（(\[【][^（）()[\]】]*[）)\]】]/g, ' ');
  t = t.replace(/\s+-\s+(live|remix|acoustic|demo|instrumental|karaoke|version|edit|radio\s*edit|mv|ost|主题曲|片尾曲|插曲|现场版|演唱会版)\b/gi, ' ');
  t = t.replace(/\b(feat\.?|ft\.?|featuring)\b.+/i, '');
  return t.replace(/\s+/g, ' ').trim();
}
function titleVariants(title) {
  const out = [];
  const raw = clean(title, 160);
  if (raw) out.push(raw);
  const stripped = stripTitleNoise(raw);
  if (stripped && stripped !== raw) out.push(stripped);
  return out;
}
const MATCH_VERSION = 'v2';
function cacheKey(track) {
  const dur = track && track.durationMs > 0 ? Math.round(track.durationMs / 1000) : 0;
  return crypto.createHash('sha1')
    .update(MATCH_VERSION + '\n' +
      clean(track && track.artist, 120).toLowerCase() + '\n' +
      clean(track && track.title, 160).toLowerCase() + '\n' + dur)
    .digest('hex');
}
function cacheFile(key) { return path.join(CACHE_DIR, key + '.json'); }
function requestJson(url, timeoutMs) {
  return http.requestJson(url, timeoutMs, { 'User-Agent': USER_AGENT, 'Accept': 'application/json' });
}
function normalizeText(track) {
  const title = clean(track && track.title, 160);
  return { title: title, artist: clean(track && track.artist, 120), album: clean(track && track.album, 120), durationMs: Number(track && track.durationMs) || 0 };
}
function queryString(params) {
  const parts = [];
  Object.keys(params).forEach(function (key) {
    const value = params[key];
    if (value === undefined || value === null || value === '') return;
    parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)));
  });
  return parts.join('&');
}
function parsePayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const synced = typeof payload.syncedLyrics === 'string' ? payload.syncedLyrics : '';
  const plain = typeof payload.plainLyrics === 'string' ? payload.plainLyrics : '';
  if (!synced.trim() && !plain.trim()) return null;
  let parsed = synced.trim() ? parseLyric(synced) : null;
  if (!parsed || !parsed.lines.length) parsed = plain.trim() ? parseLyric(plain) : null;
  if (!parsed || !parsed.lines.length) return null;
  return {
    lines: parsed.lines,
    offsetMs: parsed.offsetMs || 0,
    untimed: !!parsed.untimed,
    instrumental: payload.instrumental === true
  };
}
function firstArtist(value) {
  return String(value || '').split(/[,，、/&＆;；]+/)[0].trim();
}
function artistMatches(entryArtist, trackArtist) {
  const artist = clean(trackArtist, 120).toLowerCase();
  if (!artist) return true;
  const entry = clean(entryArtist, 120).toLowerCase();
  if (!entry) return false;
  if (entry === artist) return true;
  if (entry.indexOf(artist) >= 0 || artist.indexOf(entry) >= 0) return true;
  const trackFirst = firstArtist(artist);
  const entryFirst = firstArtist(entry);
  return !!(trackFirst && entryFirst && (trackFirst.indexOf(entryFirst) >= 0 || entryFirst.indexOf(trackFirst) >= 0));
}
function score(entry, track) {
  if (!entry || typeof entry !== 'object') return -Infinity;
  const title = clean(track.title, 160).toLowerCase();
  const artist = clean(track.artist, 120).toLowerCase();
  const entryTitle = clean(entry.trackName, 160).toLowerCase();
  const entryArtist = clean(entry.artistName, 120).toLowerCase();
  const titleExact = entryTitle && entryTitle === title;
  const titlePartial = entryTitle && !titleExact && (entryTitle.indexOf(title) >= 0 || title.indexOf(entryTitle) >= 0);
  const artistExact = artist && entryArtist && entryArtist === artist;
  const artistOk = artistMatches(entryArtist, track.artist);
  const artistPartial = artistOk && !artistExact;
  if (track.artist && !artistOk) return -Infinity;
  if (!track.artist && !titleExact) return -Infinity;
  let value = 0;
  if (titleExact) value += 5;
  else if (titlePartial) value += 2;
  if (artistExact) value += 4;
  else if (artistPartial) value += 2;
  const duration = Number(entry.duration) > 0 ? Number(entry.duration) * 1000 : 0;
  if (track.durationMs > 0 && duration > 0) {
    const diff = Math.abs(duration - track.durationMs);
    if (diff <= 2000) value += 4;
    else if (diff <= 5000) value += 1;
    else value -= 2;
  }
  if (entry.syncedLyrics) value += 3;
  else if (entry.plainLyrics) value += 1;
  return value;
}
function pickBest(list, track) {
  if (!Array.isArray(list) || !list.length) return null;
  let best = null;
  let bestScore = -Infinity;
  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    if (!entry || (!entry.syncedLyrics && !entry.plainLyrics)) continue;
    const value = score(entry, track);
    if (value < 2) continue;
    if (value > bestScore) { bestScore = value; best = entry; }
  }
  return best;
}
function scoreNetease(song, track) {
  if (!song || typeof song !== 'object') return -Infinity;
  const title = clean(track.title, 160).toLowerCase();
  const artist = clean(track.artist, 120).toLowerCase();
  const entryTitle = clean(song.title, 160).toLowerCase();
  const entryArtist = clean(song.artist, 120).toLowerCase();
  const titleExact = entryTitle && entryTitle === title;
  const titlePartial = entryTitle && !titleExact && (entryTitle.indexOf(title) >= 0 || title.indexOf(entryTitle) >= 0);
  const artistExact = artist && entryArtist && entryArtist === artist;
  const artistOk = artistMatches(entryArtist, track.artist);
  const artistPartial = artistOk && !artistExact;
  if (track.artist && !artistOk) return -Infinity;
  if (!track.artist && !titleExact) return -Infinity;
  let value = 0;
  if (titleExact) value += 5;
  else if (titlePartial) value += 2;
  if (artistExact) value += 4;
  else if (artistPartial) value += 2;
  if (track.durationMs > 0 && song.durationMs > 0) {
    const diff = Math.abs(song.durationMs - track.durationMs);
    if (diff <= 2000) value += 4;
    else if (diff <= 5000) value += 1;
    else value -= 2;
  }
  return value;
}
function pickBestNetease(songs, track) {
  if (!Array.isArray(songs) || !songs.length) return null;
  let best = null;
  let bestScore = -Infinity;
  for (let i = 0; i < songs.length; i++) {
    const value = scoreNetease(songs[i], track);
    if (value < 2) continue;
    if (value > bestScore) { bestScore = value; best = songs[i]; }
  }
  return best;
}
function mergeTranslation(lines, tlyric) {
  if (!tlyric || !tlyric.trim()) return lines;
  const t = parseLyric(tlyric);
  if (!t || !t.lines || !t.lines.length) return lines;
  const tlines = t.lines;
  for (let i = 0; i < lines.length; i++) {
    let best = null;
    let bestDiff = Infinity;
    for (let j = 0; j < tlines.length; j++) {
      const diff = Math.abs(tlines[j].timeMs - lines[i].timeMs);
      if (diff < bestDiff) { bestDiff = diff; best = tlines[j]; }
    }
    if (best && bestDiff <= 1500 && best.text && best.text !== lines[i].text) {
      lines[i].translation = best.text;
    }
  }
  return lines;
}
async function neteaseCover(track, timeoutMs) {
  const limit = Math.min(timeoutMs > 0 ? timeoutMs : 6000, 3000);
  const work = (async function () {
    let songs = await netease.searchSongs(track, limit, true);
    let song = pickBestNetease(songs, track);
    if (!song && track.artist) {
      songs = await netease.searchSongs(track, limit, false);
      song = pickBestNetease(songs, track);
    }
    if (!song) return '';
    return await netease.fetchCover(song.id, limit);
  })().catch(function () { return ''; });
  return Promise.race([
    work,
    new Promise(function (resolve) {
      const timer = setTimeout(function () { resolve(''); }, limit);
      if (timer && typeof timer.unref === 'function') timer.unref();
    })
  ]);
}
async function fetchFromNetease(track, timeoutMs) {
  let songs;
  try { songs = await netease.searchSongs(track, timeoutMs, true); }
  catch (e) { throw e; }
  let song = pickBestNetease(songs, track);
  if (!song && track.artist) {
    try { songs = await netease.searchSongs(track, timeoutMs, false); }
    catch (e) { throw e; }
    song = pickBestNetease(songs, track);
  }
  if (!song) return null;
  let raw;
  try { raw = await netease.fetchLyrics(song.id, timeoutMs); }
  catch (e) { throw e; }
  if (!raw || (!raw.lrc && !raw.tlyric)) return null;
  let parsed = raw.lrc.trim() ? parseLyric(raw.lrc) : null;
  if (!parsed || !parsed.lines.length) parsed = raw.tlyric.trim() ? parseLyric(raw.tlyric) : null;
  if (!parsed || !parsed.lines.length) return null;
  const lines = parsed.lines.filter(function (ln) { return !netease.isMetaLine(ln.text); });
  if (!lines.length) return null;
  mergeTranslation(lines, raw.tlyric);
  let artwork = '';
  try { artwork = await netease.fetchCover(song.id, timeoutMs); } catch (e) { logger.debug('netease cover failed: ' + (e && e.message)); }
  return {
    lines: lines,
    offsetMs: parsed.offsetMs || 0,
    untimed: !!parsed.untimed,
    instrumental: raw.nolyric === true,
    neteaseId: song.id,
    neteaseTitle: song.title,
    neteaseArtist: song.artist,
    artwork: artwork
  };
}
function createOnlineLyrics(options) {
  const opts = options || {};
  const logger = opts.logger || { debug: function () {}, info: function () {}, warn: function () {}, error: function () {} };
  const getConfig = typeof opts.getConfig === 'function' ? opts.getConfig : function () { return stateMod.loadConfig(); };
  const st = { state: 'idle', provider: null, title: '', artist: '', cached: false, stale: false, lines: 0, at: 0, error: null, requests: 0, hits: 0, misses: 0, networkErrors: 0 };
  const memory = new Map();
  const inflight = new Map();
  function cfg() {
    let all = {};
    try { all = getConfig() || {}; } catch (e) { all = {}; }
    const online = all.online || {};
    return {
      enabled: online.enabled !== false,
      cacheDays: online.cacheDays > 0 ? online.cacheDays : 30,
      timeoutMs: online.timeoutMs > 0 ? online.timeoutMs : 6000
    };
  }
  function setStatus(patch) {
    Object.assign(st, patch || {}, { at: Date.now() });
  }
  function readCache(key, maxAgeMs) {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(cacheFile(key), 'utf8')); }
    catch (e) { return null; }
    if (!raw || !Array.isArray(raw.lines) || !raw.lines.length) return null;
    const fetchedAt = Number(raw.fetchedAt) || 0;
    const stale = !(maxAgeMs > 0) || !fetchedAt || Date.now() - fetchedAt > maxAgeMs;
    return {
      ok: true,
      provider: raw.provider || PROVIDER,
      cached: true,
      stale: stale,
      fetchedAt: fetchedAt,
      lines: raw.lines,
      offsetMs: Number(raw.offsetMs) || 0,
      untimed: !!raw.untimed,
      title: raw.title || '',
      artist: raw.artist || '',
      artwork: typeof raw.artwork === 'string' ? raw.artwork : ''
    };
  }
  function writeCache(key, track, parsed, provider) {
    try {
      stateMod.atomicWriteJson(cacheFile(key), {
        v: 1,
        provider: provider || PROVIDER,
        title: track.title,
        artist: track.artist,
        durationMs: track.durationMs || 0,
        fetchedAt: Date.now(),
        offsetMs: parsed.offsetMs || 0,
        untimed: !!parsed.untimed,
        artwork: parsed.artwork || '',
        lines: parsed.lines
      });
      return true;
    } catch (e) {
      logger.debug('lyric cache write failed: ' + (e && e.message));
      return false;
    }
  }
  function remember(key, result) {
    if (memory.has(key)) memory.delete(key);
    memory.set(key, result);
    while (memory.size > MEMORY_LIMIT) memory.delete(memory.keys().next().value);
  }
  async function fetchOnline(track, timeoutMs) {
    st.requests++;
    const durationSec = track.durationMs > 0 ? Math.round(track.durationMs / 1000) : 0;
    const variants = titleVariants(track.title);
    let payload = null;
    if (durationSec > 0) {
      for (let i = 0; i < variants.length && !payload; i++) {
        const q = queryString({ artist_name: track.artist, track_name: variants[i], album_name: track.album, duration: durationSec });
        let got = null;
        try { got = await requestJson(BASE + '/api/get?' + q, timeoutMs); }
        catch (e) { logger.debug('lrclib get failed: ' + (e && e.message)); }
        if (got && got.statusCode === 404) got = null;
        if (got && artistMatches(got.artistName, track.artist)) payload = got;
      }
    }
    if (!payload || (!payload.syncedLyrics && !payload.plainLyrics)) {
      for (let i = 0; i < variants.length && !payload; i++) {
        let list = null;
        try { list = await requestJson(BASE + '/api/search?' + queryString({ track_name: variants[i], artist_name: track.artist }), timeoutMs); }
        catch (e) { logger.debug('lrclib search failed: ' + (e && e.message)); throw e; }
        payload = pickBest(list, track);
        if (!payload && track.artist) {
          try { list = await requestJson(BASE + '/api/search?' + queryString({ track_name: variants[i] }), timeoutMs); }
          catch (e) { logger.debug('lrclib title-only search failed: ' + (e && e.message)); }
          payload = pickBest(list, track);
        }
      }
    }
    if (payload) {
      const parsed = parsePayload(payload);
      if (parsed && !parsed.artwork) parsed.artwork = await neteaseCover(track, timeoutMs);
      return parsed;
    }
    const net = await fetchFromNetease(track, timeoutMs);
    if (net) return net;
    return null;
  }
  function finish(key, result, callbacks) {
    inflight.delete(key);
    if (result && result.lines && result.lines.length) {
      st.hits++;
      remember(key, result);
      setStatus({
        state: result.stale ? 'cached' : (result.cached ? 'cached' : 'found'),
        provider: result.provider || PROVIDER,
        title: result.title || st.title,
        artist: result.artist || st.artist,
        cached: !!result.cached,
        stale: !!result.stale,
        lines: result.lines.length,
        error: null
      });
    } else if (result && result.reason === 'offline') {
      st.networkErrors++;
      setStatus({ state: 'offline', error: result.error || 'network error', lines: 0 });
    } else if (result && result.reason === 'disabled') {
      setStatus({ state: 'disabled', lines: 0, error: null });
    } else {
      st.misses++;
      setStatus({ state: 'miss', lines: 0, error: null });
    }
    for (let i = 0; i < callbacks.length; i++) {
      try { callbacks[i](result); } catch (e) { logger.debug('online lyric callback threw: ' + (e && e.message)); }
    }
  }
  function get(track, done) {
    const callback = typeof done === 'function' ? done : function () {};
    const conf = cfg();
    const info = normalizeText(track);
    if (!info.title) { callback(null); return; }
    if (!conf.enabled) { callback({ ok: false, reason: 'disabled' }); return; }
    const key = cacheKey(info);
    const cached = memory.get(key);
    if (cached) {
      setStatus({
        state: cached.cached ? 'cached' : 'found',
        provider: cached.provider || PROVIDER,
        title: cached.title || info.title,
        artist: cached.artist || info.artist,
        cached: !!cached.cached,
        stale: !!cached.stale,
        lines: cached.lines.length,
        error: null
      });
      callback(cached);
      return;
    }
    const waiting = inflight.get(key);
    if (waiting) { waiting.push(callback); return; }
    inflight.set(key, [callback]);
    const callbacks = inflight.get(key);
    setStatus({ state: 'searching', title: info.title, artist: info.artist, cached: false, stale: false, lines: 0, error: null });
    const disk = readCache(key, conf.cacheDays * 86400000);
    if (disk && !disk.stale) {
      remember(key, disk);
      finish(key, disk, callbacks);
      return;
    }
    fetchOnline(info, conf.timeoutMs).then(function (parsed) {
      if (parsed) {
        const isNetease = !!parsed.neteaseId;
        const result = {
          ok: true, provider: isNetease ? 'netease' : PROVIDER, cached: false, stale: false,
          lines: parsed.lines, offsetMs: parsed.offsetMs, untimed: parsed.untimed,
          instrumental: parsed.instrumental, title: info.title, artist: info.artist,
          artwork: parsed.artwork || '',
          fetchedAt: Date.now()
        };
        writeCache(key, info, parsed, result.provider);
        logger.info('在线歌词命中 "' + info.title + '" - ' + info.artist + ' 行数=' + parsed.lines.length + ' 来源=' + result.provider + (parsed.untimed ? '（无时间轴）' : ''));
        finish(key, result, callbacks);
        return;
      }
      if (disk) {
        logger.info('在线未命中，使用过期缓存 "' + info.title + '"');
        remember(key, disk);
        finish(key, disk, callbacks);
        return;
      }
      finish(key, { ok: false, reason: 'miss' }, callbacks);
    }).catch(function (error) {
      if (disk) {
        logger.info('在线不可用，使用本地缓存 "' + info.title + '"');
        remember(key, disk);
        finish(key, disk, callbacks);
        return;
      }
      finish(key, { ok: false, reason: 'offline', error: String(error && error.message || error).slice(0, 160) }, callbacks);
    });
  }
  function prune() {
    const conf = cfg();
    const maxAgeMs = conf.cacheDays * 86400000;
    const now = Date.now();
    let removed = 0;
    memory.forEach(function (value, key) {
      if (!value || !value.fetchedAt || now - value.fetchedAt > maxAgeMs) memory.delete(key);
    });
    try {
      const names = fs.readdirSync(CACHE_DIR);
      for (let i = 0; i < names.length; i++) {
        if (!/^[a-f0-9]{40}\.json$/i.test(names[i])) continue;
        const file = path.join(CACHE_DIR, names[i]);
        try {
          if (now - fs.statSync(file).mtimeMs > maxAgeMs) { fs.unlinkSync(file); removed++; }
        } catch (e) { /* 文件可能正被其他实例清理 */ }
      }
    } catch (e) { /* 目录不存在即视为空 */ }
    if (removed) logger.info('过期歌词缓存已清理 ' + removed + ' 个文件');
    return removed;
  }
  return {
    get: get,
    status: function () {
      const conf = cfg();
      return {
        enabled: conf.enabled,
        cacheDays: conf.cacheDays,
        state: st.state,
        provider: st.provider,
        title: st.title,
        artist: st.artist,
        cached: st.cached,
        stale: st.stale,
        lines: st.lines,
        at: st.at,
        error: st.error,
        requests: st.requests,
        hits: st.hits,
        misses: st.misses,
        networkErrors: st.networkErrors,
        memory: memory.size,
        dir: CACHE_DIR
      };
    },
    clearCache: function () {
      let removed = 0;
      try {
        const names = fs.readdirSync(CACHE_DIR);
        for (let i = 0; i < names.length; i++) {
          if (!/^[a-f0-9]{40}\.json$/i.test(names[i])) continue;
          try { fs.unlinkSync(path.join(CACHE_DIR, names[i])); removed++; } catch (e) { /* ignore */ }
        }
      } catch (e) { /* 目录不存在即视为空 */ }
      memory.clear();
      setStatus({ state: 'idle', lines: 0, cached: false, stale: false });
      logger.info('歌词缓存已清理 ' + removed + ' 个文件');
      return { ok: true, removed: removed };
    },
    prune: prune,
    _cacheKey: cacheKey,
    _internal: { st: st, memory: memory, inflight: inflight }
  };
}
module.exports = { createOnlineLyrics: createOnlineLyrics };
