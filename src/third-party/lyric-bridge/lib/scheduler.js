'use strict';
const MAX_CHARS = 200;
const UNTIMED_STEP_MS = 4200;
function monoMs() { return Number(process.hrtime.bigint() / 1000000n); }
function clampText(raw, maxChars) {
  const n = maxChars > 0 ? maxChars : MAX_CHARS;
  let s = String(raw == null ? '' : raw);
  s = s.replace(/[\u0000-\u001f\u007f]+/g, ' ');
  s = s.replace(/[\u200b-\u200f\uFEFF]/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > n) s = s.slice(0, n);
  return s;
}
function findLineIndex(lines, posMs) {
  let lo = 0, hi = lines.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].timeMs <= posMs) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}
function normalizeLines(lines) {
  const out = [];
  if (!Array.isArray(lines)) return out;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l || !Number.isFinite(l.timeMs)) continue;
    const text = String(l.text == null ? '' : l.text);
    if (!text.trim()) continue;
    out.push({ timeMs: Math.max(0, l.timeMs), text: text, tr: l.translation || l.tr || '' });
  }
  out.sort(function (a, b) { return a.timeMs - b.timeMs; });
  return out;
}
function createScheduler(options) {
  const opts = options || {};
  const logger = opts.logger || null;
  const tickMs = opts.tickMs > 0 ? opts.tickMs : 100;
  const onLine = typeof opts.onLine === 'function' ? opts.onLine : function () {};
  const st = {
    running: false,
    timer: null,
    track: null,
    index: -2,
    anchor: { posMs: 0, wall: monoMs() },
    playing: false,
    posMs: 0,
    lastEmitAt: 0,
    emits: 0,
    lastText: null
  };
  function emit(payload) {
    try { onLine(payload); } catch (e) { if (logger) logger.warn('scheduler onLine threw: ' + (e && e.message)); }
  }
  function currentPos(now) {
    const elapsed = st.playing ? Math.max(0, now - st.anchor.wall) : 0;
    let pos = st.anchor.posMs + elapsed;
    if (pos < 0) pos = 0;
    return pos;
  }
  function composeText(track, line) {
    let text = line.text;
    const tr = line.tr && String(line.tr).trim();
    if (tr && track.showTranslation !== false) text = text + ' · ' + tr;
    return clampText(text, track.maxChars || MAX_CHARS);
  }
  function payloadFor(track, index, pos, reason) {
    const line = index >= 0 && index < track.lines.length ? track.lines[index] : null;
    const text = line ? composeText(track, line) : '';
    return {
      index: index,
      text: text,
      rawText: line ? line.text : '',
      translation: line ? (line.tr || '') : '',
      source: track.source,
      title: track.title || '',
      artist: track.artist || '',
      playing: !!st.playing,
      posMs: Math.round(pos),
      lineTimeMs: line ? line.timeMs : null,
      total: track.lines.length,
      reason: reason,
      at: Date.now()
    };
  }
  function tick() {
    if (!st.track || !st.track.lines.length) {
      if (st.index !== -1) {
        st.index = -1;
        st.posMs = 0;
        emit({ index: -1, text: '', rawText: '', translation: '', source: st.track ? st.track.source : null, title: st.track ? st.track.title : '', artist: st.track ? st.track.artist : '', playing: false, posMs: 0, lineTimeMs: null, total: 0, reason: 'clear', at: Date.now() });
      }
      return;
    }
    const now = monoMs();
    const pos = currentPos(now);
    st.posMs = pos;
    const track = st.track;
    let idx;
    if (track.untimed) {
      idx = Math.min(track.lines.length - 1, Math.floor(pos / UNTIMED_STEP_MS));
    } else {
      idx = findLineIndex(track.lines, pos - (track.offsetMs || 0));
    }
    if (idx !== st.index) {
      const reason = st.index === -2 ? 'track' : (st.index === -1 ? 'start' : (idx > st.index ? (idx - st.index > 1 ? 'jump' : 'advance') : 'seek-back'));
      st.index = idx;
      st.emits++;
      st.lastEmitAt = now;
      st.lastText = idx >= 0 ? track.lines[idx].text : '';
      emit(payloadFor(track, idx, pos, reason));
    }
  }
  function safeTick() { try { tick(); } catch (e) { if (logger) logger.warn('scheduler tick threw: ' + (e && e.message)); } }
  return {
    start: function () {
      if (st.running) return this;
      st.running = true;
      safeTick();
      st.timer = setInterval(safeTick, tickMs);
      if (st.timer && typeof st.timer.unref === 'function') st.timer.unref();
      return this;
    },
    stop: function () {
      st.running = false;
      if (st.timer) { clearInterval(st.timer); st.timer = null; }
      return this;
    },
    setTrack: function (track) {
      if (!track || !Array.isArray(track.lines) || !track.lines.length) {
        if (st.track) {
          st.track = null;
          st.index = -1;
          emit({ index: -1, text: '', rawText: '', translation: '', source: null, title: '', artist: '', playing: false, posMs: 0, lineTimeMs: null, total: 0, reason: 'clear', at: Date.now() });
        }
        return this;
      }
      const sig = (function (lines) {
        if (!Array.isArray(lines) || !lines.length) return '0';
        return lines.length + ':' + lines[0].timeMs + ':' + lines[lines.length - 1].timeMs;
      })(track.lines);
      const key = track.key || ((track.source || 'unknown') + '|' + (track.title || '') + '|' + sig);
      if (st.track && st.track.key === key) {
        const next = {
          offsetMs: Number(track.offsetMs) || 0,
          untimed: !!track.untimed,
          maxChars: track.maxChars || MAX_CHARS,
          showTranslation: track.showTranslation !== false
        };
        let changed = false;
        for (const k in next) {
          if (st.track[k] !== next[k]) { st.track[k] = next[k]; changed = true; }
        }
        if (changed) { st.index = -2; safeTick(); }
        return this;
      }
      st.track = {
        key: key,
        source: track.source || 'unknown',
        title: track.title || '',
        artist: track.artist || '',
        offsetMs: Number(track.offsetMs) || 0,
        untimed: !!track.untimed,
        maxChars: track.maxChars || MAX_CHARS,
        showTranslation: track.showTranslation !== false,
        lines: normalizeLines(track.lines)
      };
      st.index = -2;
      if (!st.track.lines.length) { st.track = null; return this; }
      safeTick();
      return this;
    },
    setAnchor: function (anchor) {
      if (!anchor) return this;
      const pos = Number(anchor.posMs);
      if (Number.isFinite(pos)) st.anchor = { posMs: Math.max(0, pos), wall: monoMs() };
      if (typeof anchor.playing === 'boolean') st.playing = anchor.playing;
      return this;
    },
    setPlaying: function (v) { st.playing = !!v; return this; },
    tick: safeTick,
    getState: function () {
      return {
        source: st.track ? st.track.source : null,
        title: st.track ? st.track.title : '',
        artist: st.track ? st.track.artist : '',
        index: st.index,
        posMs: Math.round(st.posMs),
        playing: st.playing,
        text: st.lastText,
        total: st.track ? st.track.lines.length : 0,
        emits: st.emits,
        lines: st.track ? st.track.lines.length : 0
      };
    },
    _internal: st
  };
}
module.exports = {
  createScheduler: createScheduler,
  clampText: clampText,
  findLineIndex: findLineIndex,
  normalizeLines: normalizeLines,
  monoMs: monoMs,
  MAX_CHARS: MAX_CHARS,
  UNTIMED_STEP_MS: UNTIMED_STEP_MS
};
