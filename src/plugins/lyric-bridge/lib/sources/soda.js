'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const P = require('../paths.js');
const kugou = require('../kugou.js');
const LRC_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const LRC_META = /^\[([a-zA-Z]+):([^\]]*)\]$/;
const KRC_LINE = /^\[\d+,\d+\]/;
function monoMs() { return Number(process.hrtime.bigint() / 1000000n); }
function fracToMs(frac) {
  if (!frac) return 0;
  if (frac.length === 1) return Number(frac) * 100;
  if (frac.length === 2) return Number(frac) * 10;
  return Number(frac.slice(0, 3));
}
function detectFormat(text) {
  const t = String(text || '');
  if (/(^|\r?\n)\s*\[\d+\s*,\s*\d+\]/.test(t)) return 'krc';
  if (/\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/.test(t)) return 'lrc';
  return 'plain';
}
function unescapeContent(raw) {
  let s = String(raw == null ? '' : raw);
  if (!s) return '';
  const t = s.trim();
  if ((t.charAt(0) === '"' && t.charAt(t.length - 1) === '"') || t.charAt(0) === '{' || t.charAt(0) === '[') {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') s = parsed;
      else if (parsed && typeof parsed === 'object' && typeof parsed.lyricContent === 'string') s = parsed.lyricContent;
    } catch (e) { /* 不是 JSON，按原文处理 */ }
  }
  return s.replace(/\\n/g, '\n').replace(/\\r/g, '');
}
function parseLrc(text) {
  const lines = [];
  const meta = Object.create(null);
  let offsetMs = 0;
  const rows = String(text).split(/\r?\n/);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row.trim()) continue;
    const mm = LRC_META.exec(row.trim());
    if (mm && !/\d+:\d+/.test(mm[1])) {
      const key = mm[1].toLowerCase();
      meta[key] = mm[2];
      if (key === 'offset') { const n = Number(String(mm[2]).trim()); if (Number.isFinite(n)) offsetMs = n; }
      continue;
    }
    LRC_TAG.lastIndex = 0;
    const times = [];
    let m;
    let body = row;
    while ((m = LRC_TAG.exec(row)) !== null) {
      const min = Number(m[1]);
      const sec = Number(m[2]);
      times.push(min * 60000 + sec * 1000 + fracToMs(m[3]));
      body = row.slice(m.index + m[0].length);
      if (LRC_TAG.lastIndex <= m.index) break;
    }
    if (!times.length) continue;
    const textLine = body.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    if (!textLine) continue;
    for (let k = 0; k < times.length; k++) lines.push({ timeMs: Math.max(0, times[k] + offsetMs), text: textLine });
  }
  lines.sort(function (a, b) { return a.timeMs - b.timeMs; });
  return { lines: lines, offsetMs: offsetMs, meta: meta, format: 'lrc' };
}
function parseKrcTextSafe(text) {
  const parsed = kugou.parseKrcText(text);
  const meta = parsed.meta || {};
  const off = Number(meta.offset);
  const offsetMs = Number.isFinite(off) ? off : 0;
  const lines = [];
  for (let i = 0; i < parsed.lines.length; i++) {
    const l = parsed.lines[i];
    const t = String(l.text || '').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    lines.push({ timeMs: l.timeMs, text: t });
  }
  return { lines: lines, offsetMs: offsetMs, meta: meta, format: 'krc' };
}
function parsePlain(text) {
  const rows = String(text).split(/\r?\n/);
  const lines = [];
  for (let i = 0; i < rows.length; i++) {
    const t = rows[i].replace(/\s+/g, ' ').trim();
    if (!t) continue;
    lines.push({ timeMs: lines.length * 4200, text: t });
  }
  return { lines: lines, offsetMs: 0, meta: Object.create(null), format: 'plain', untimed: true };
}
function parseLyric(text) {
  const clean = unescapeContent(text);
  if (!clean.trim()) return { lines: [], offsetMs: 0, format: 'empty' };
  const fmt = detectFormat(clean);
  if (fmt === 'krc') {
    const r = parseKrcTextSafe(clean);
    if (r.lines.length) return r;
  }
  if (fmt === 'lrc' || fmt === 'krc') {
    const r = parseLrc(clean);
    if (r.lines.length) return r;
  }
  return parsePlain(clean);
}
function alignTranslation(main, trans) {
  if (!trans || !trans.lines || !trans.lines.length) return;
  if (trans.format === 'plain' || trans.untimed) {
    const n = Math.min(main.lines.length, trans.lines.length);
    for (let i = 0; i < n; i++) main.lines[i].translation = trans.lines[i].text;
    return;
  }
  let j = 0;
  for (let i = 0; i < main.lines.length; i++) {
    const line = main.lines[i];
    while (j + 1 < trans.lines.length && Math.abs(trans.lines[j + 1].timeMs - line.timeMs) <= Math.abs(trans.lines[j].timeMs - line.timeMs)) j++;
    if (Math.abs(trans.lines[j].timeMs - line.timeMs) <= 1500) line.translation = trans.lines[j].text;
  }
}
function readRawFile(file) {
  let st;
  try { st = fs.statSync(file); } catch (e) { return { ok: false, code: e.code || 'STAT_FAILED', at: Date.now() }; }
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { ok: false, code: 'READ_FAILED', at: Date.now() }; }
  return { ok: true, text: text, mtimeMs: st.mtimeMs, size: st.size };
}
let lastParse = null;
function readSoda(options) {
  const opts = options || {};
  const file = opts.file || P.SODA_FILE;
  const staleMs = opts.staleMs > 0 ? opts.staleMs : 10000;
  const raw = readRawFile(file);
  if (!raw.ok) return null;
  const ageMs = Date.now() - raw.mtimeMs;
  if (ageMs > staleMs) return null;
  let base = lastParse && lastParse.file === file && lastParse.mtimeMs === raw.mtimeMs && lastParse.size === raw.size ? lastParse.base : null;
  if (!base) {
    let obj;
    try { obj = JSON.parse(raw.text); } catch (e) { return null; }
    if (!obj || typeof obj !== 'object') return null;
    const content = typeof obj.lyricContent === 'string' ? obj.lyricContent : (typeof obj.lyric === 'string' ? obj.lyric : '');
    if (!String(content).trim()) return null;
    const main = parseLyric(content);
    if (!main.lines.length) return null;
    let trans = null;
    if (typeof obj.translation === 'string' && obj.translation.trim()) trans = parseLyric(obj.translation);
    else if (obj.translation && typeof obj.translation === 'object') {
      try { trans = parseLyric(JSON.stringify(obj.translation)); } catch (e) { trans = null; }
    }
    if (trans && trans.lines && trans.lines.length) alignTranslation(main, trans);
    const pos = obj.positionMs == null ? NaN : Number(obj.positionMs);
    const meta = main.meta || Object.create(null);
    const durationMs = Number(obj.durationMs);
    base = {
      ok: true,
      source: 'soda',
      title: String(obj.title || meta.ti || meta.title || ''),
      artist: String(obj.artist || meta.ar || meta.artist || ''),
      album: String(obj.album || meta.al || meta.album || ''),
      durationMs: Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0,
      lines: main.lines,
      offsetMs: main.offsetMs || 0,
      untimed: !!main.untimed,
      format: main.format,
      translation: !!trans,
      fingerprint: crypto.createHash('sha1').update(JSON.stringify(main.lines)).digest('hex'),
      updatedAt: Number(obj.updatedAt) || Date.parse(obj.updatedAt) || raw.mtimeMs,
      playing: obj.playing !== false,
      positionMs: Number.isFinite(pos) ? Math.max(0, pos) : null
    };
    lastParse = { file: file, mtimeMs: raw.mtimeMs, size: raw.size, base: base };
  }
  return Object.assign({}, base, { ageMs: ageMs, file: file, mtimeMs: raw.mtimeMs });
}
function createSodaSource(options) {
  const opts = options || {};
  const logger = opts.logger || { debug: function () {}, info: function () {}, warn: function () {}, error: function () {} };
  const onTrack = typeof opts.onTrack === 'function' ? opts.onTrack : function () {};
  const onAnchor = typeof opts.onAnchor === 'function' ? opts.onAnchor : function () {};
  const getConfig = typeof opts.getConfig === 'function' ? opts.getConfig : function () { return {}; };
  const st = {
    timer: null, running: false, track: null, lastGoodAt: 0, titleSince: monoMs(),
    polls: 0, hits: 0, stale: false, lastError: null, lastFormat: null
  };
  function poll() {
    st.polls++;
    const cfg = getConfig() || {};
    const sodaCfg = cfg.soda || {};
    const file = sodaCfg.file || P.SODA_FILE;
    const staleMs = sodaCfg.staleMs > 0 ? sodaCfg.staleMs : 10000;
    const holdMs = sodaCfg.staleHoldMs >= 0 ? sodaCfg.staleHoldMs : 5000;
    let track = null;
    try { track = readSoda({ file: file, staleMs: staleMs }); }
    catch (e) { st.lastError = { code: 'SODA_READ_THROW', message: String(e && e.message) }; }
    if (!track) {
      st.stale = true;
      const heldFor = Date.now() - st.lastGoodAt;
      if (st.track && st.lastGoodAt && heldFor < holdMs) return;
      if (st.track) {
        logger.info('soda: 文件缺失或过期(' + staleMs + 'ms)，清除歌词');
        st.track = null;
        st.lastError = { code: 'SODA_STALE', message: 'soda-lyrics.json 不存在或超过 ' + staleMs + 'ms 未更新: ' + file };
        onTrack(null);
      }
      return;
    }
    st.hits++;
    st.stale = false;
    st.lastFormat = track.format;
    st.lastError = null;
    const changed = !st.track || st.track.title !== track.title || st.track.artist !== track.artist ||
      st.track.fingerprint !== track.fingerprint || st.track.file !== track.file;
    if (changed) {
      if (!st.track || st.track.title !== track.title) {
        st.titleSince = monoMs();
        logger.info('soda: 曲目 "' + track.title + '" 行数=' + track.lines.length + ' 格式=' + track.format + ' 翻译=' + track.translation);
      }
      st.track = {
        key: 'soda|' + track.title + '|' + track.artist + '|' + track.fingerprint,
        fingerprint: track.fingerprint,
        source: 'soda',
        title: track.title,
        artist: track.artist,
        album: track.album,
        durationMs: track.durationMs,
        lines: track.lines,
        offsetMs: track.offsetMs,
        untimed: track.untimed,
        translation: track.translation,
        updatedAt: track.updatedAt,
        file: track.file,
        positionMs: track.positionMs
      };
      st.lastGoodAt = Date.now();
      onTrack(st.track);
    } else {
      st.track.positionMs = track.positionMs;
      st.track.updatedAt = track.updatedAt;
      st.lastGoodAt = Date.now();
    }
    let pos;
    if (track.positionMs != null) {
      pos = track.positionMs + (track.playing ? Math.max(0, Date.now() - track.updatedAt) : 0);
    } else {
      pos = Math.max(0, monoMs() - st.titleSince);
    }
    onAnchor({ posMs: pos, playing: track.playing, at: monoMs() });
  }
  function safePoll() { try { poll(); } catch (e) { st.lastError = { code: 'SODA_POLL_THROW', message: String(e && e.message) }; } }
  return {
    start: function () {
      if (st.running) return this;
      st.running = true;
      safePoll();
      const cfg = getConfig() || {};
      const ms = (cfg.soda && cfg.soda.pollMs) || 500;
      st.timer = setInterval(safePoll, ms);
      if (st.timer && typeof st.timer.unref === 'function') st.timer.unref();
      return this;
    },
    stop: function () {
      st.running = false;
      if (st.timer) { clearInterval(st.timer); st.timer = null; }
      return this;
    },
    pollNow: function () { safePoll(); return this.status(); },
    status: function () {
      return { running: st.running, polls: st.polls, hits: st.hits, stale: st.stale, title: st.track ? st.track.title : null, lines: st.track ? st.track.lines.length : 0, format: st.lastFormat, error: st.lastError };
    },
    _internal: st
  };
}
module.exports = {
  readSoda: readSoda,
  parseLyric: parseLyric,
  parseLrc: parseLrc,
  parsePlain: parsePlain,
  detectFormat: detectFormat,
  alignTranslation: alignTranslation,
  createSodaSource: createSodaSource,
  DEFAULT_FILE: P.SODA_FILE
};
