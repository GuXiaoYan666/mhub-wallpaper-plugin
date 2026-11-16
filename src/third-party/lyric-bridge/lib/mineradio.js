'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const MARK = '{"version":1,"savedAt":';
const CURRENT = '"current":{';
const FRESH_MS = 12000;
const RECENT_MS = 120000;
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const FALLBACK_MS = 180000;
const STALE_MS = 8000;
const UIA_FRESH_MS = 3000;
const UIA_CHANGE_MS = 20000;
const UIA_FIRST_MS = 30000;
const CACHE_MS = 1200;
const MAX_FILE = 4 * 1024 * 1024;
let cache = { at: 0, found: null };
let lastGood = null;
let live = { key: '', at: 0 };
let dirsCache = { at: 0, dirs: [] };
function roaming() {
  return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
}
function storeDirs() {
  const now = Date.now();
  if (now - dirsCache.at < 60000 && dirsCache.dirs.length) return dirsCache.dirs;
  const base = path.join(roaming(), 'Mineradio');
  const dirs = [];
  const push = function (dir) {
    if (dirs.indexOf(dir) !== -1) return;
    try { if (fs.statSync(dir).isDirectory()) dirs.push(dir); } catch (_) { /* 不存在 */ }
  };
  push(path.join(base, 'Cache', 'chromium', 'Mineradio', 'Local Storage', 'leveldb'));
  push(path.join(base, 'Local Storage', 'leveldb'));
  try {
    for (const name of fs.readdirSync(base)) {
      if (name === 'Partitions' || name === 'Cache') continue;
      push(path.join(base, name, 'Local Storage', 'leveldb'));
    }
  } catch (_) { /* 应用目录还没建立 */ }
  dirsCache = { at: now, dirs: dirs };
  return dirs;
}
function sliceObject(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (c === 92) escaped = true;
      else if (c === 34) inString = false;
      continue;
    }
    if (c === 34) inString = true;
    else if (c === 123) depth++;
    else if (c === 125) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
function number(re, text) {
  const m = re.exec(text);
  return m ? Number(m[1]) : 0;
}
function parseSnapshot(text) {
  let best = null;
  let at = text.indexOf(MARK);
  while (at !== -1) {
    const start = text.indexOf(CURRENT, at);
    if (start !== -1 && start - at < 4000) {
      const json = sliceObject(text, start + CURRENT.length - 1);
      if (json) {
        try {
          const head = text.slice(at, start);
          const item = {
            savedAt: number(/"savedAt":(\d+)/, head),
            currentTime: number(/"currentTime":([\d.]+)/, head),
            duration: number(/"duration":([\d.]+)/, head),
            playing: /"playing":true/.test(head),
            current: JSON.parse(json),
          };
          if (!best || item.savedAt > best.savedAt) best = item;
        } catch (_) { /* 跳过不完整的记录 */ }
      }
    }
    at = text.indexOf(MARK, at + 1);
  }
  return best;
}
function seconds(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n * 1000 : 0;
}
function artworkUrl(value) {
  const url = String(value || '').trim();
  return /^http:/i.test(url) ? url.replace(/^http:/i, 'https:') : url;
}
function coverOf(item) {
  const cur = item || {};
  return artworkUrl(cur.cover || cur.artwork || cur.picUrl || '');
}
function toMedia(snap, playing) {
  const cur = snap.current || {};
  const title = String(cur.name || cur.title || '').trim();
  if (!title) return null;
  const artist = String(cur.artist || '').trim();
  const album = String(cur.album || '').trim();
  const durationMs = Math.round(seconds(snap.duration) || Number(cur.durationMs) || seconds(cur.duration));
  const now = Date.now();
  const savedAt = Number(snap.savedAt) || now;
  let positionMs = Math.max(0, Number(snap.currentTime) || 0) * 1000;
  if (playing && now > savedAt) positionMs += now - savedAt;
  if (durationMs > 0) positionMs = Math.min(durationMs, positionMs);
  return {
    id: 'mineradio',
    key: 'mineradio|' + title + '|' + artist + '|' + album,
    title: title,
    artist: artist,
    album: album,
    artwork: coverOf(cur),
    playing: playing,
    positionMs: Math.round(positionMs),
    durationMs: durationMs,
    positionAt: 0,
    playbackRate: 1,
    at: now,
    controls: { previous: false, playPause: false, next: false, seek: false },
  };
}
function fromUia(sample, playing) {
  const title = String(sample.title || '').trim();
  if (!title) return null;
  const artist = String(sample.artist || '').trim();
  const key = 'mineradio|' + title + '|' + artist + '|';
  const now = Date.now();
  const sampleAt = Number(sample.at) || now;
  const samplePos = sample.positionMs === null || sample.positionMs === undefined ? NaN : Number(sample.positionMs);
  const sampleDur = Number(sample.durationMs);
  const durationMs = Number.isFinite(sampleDur) && sampleDur > 0 ? Math.round(sampleDur) : 0;
  let positionMs;
  if (live.key !== key) live = { key: key, at: now };
  if (Number.isFinite(samplePos) && samplePos >= 0) {
    positionMs = samplePos + (playing !== false ? Math.max(0, now - sampleAt) : 0);
  } else {
    positionMs = Math.max(0, now - live.at);
  }
  if (durationMs > 0) positionMs = Math.min(durationMs, positionMs);
  return {
    id: 'mineradio',
    key: key,
    title: title,
    artist: artist,
    album: '',
    artwork: '',
    playing: playing !== false,
    positionMs: Math.round(Math.max(0, positionMs)),
    durationMs: durationMs,
    positionAt: 0,
    playbackRate: 1,
    at: now,
    controls: { previous: false, playPause: false, next: false, seek: false },
  };
}
function readStore() {
  const files = [];
  for (const dir of storeDirs()) {
    let names;
    try { names = fs.readdirSync(dir); } catch (_) { continue; }
    for (const name of names) {
      if (!/\.(log|ldb)$/i.test(name)) continue;
      const file = path.join(dir, name);
      try {
        const st = fs.statSync(file);
        if (st.size > 0 && st.size <= MAX_FILE) files.push({ file: file, mtime: st.mtimeMs });
      } catch (_) { /* 文件可能正在被写入 */ }
    }
  }
  files.sort(function (a, b) { return b.mtime - a.mtime; });
  const now = Date.now();
  for (const item of files) {
    const age = now - item.mtime;
    if (age > MAX_AGE_MS) break;
    let buf;
    try { buf = fs.readFileSync(item.file); } catch (_) { continue; }
    const snap = parseSnapshot(buf.toString('utf16le'))
      || parseSnapshot(buf.slice(1).toString('utf16le'))
      || parseSnapshot(buf.toString('latin1'));
    if (snap) {
      const savedAt = Number(snap.savedAt) || 0;
      return { snap: snap, age: savedAt > 0 ? Math.max(0, now - savedAt) : age };
    }
  }
  return null;
}
function current(appRunning, uia) {
  const now = Date.now();
  if (now - cache.at > CACHE_MS) {
    cache = { at: now, found: readStore() };
    if (cache.found) lastGood = { snap: cache.found.snap, age: cache.found.age, at: now };
  }
  let found = cache.found;
  if (lastGood) {
    const stale = !found || (Number(found.snap.savedAt) || 0) < (Number(lastGood.snap.savedAt) || 0);
    if (stale) {
      const age = now - lastGood.at + lastGood.age;
      if (age <= FALLBACK_MS) found = { snap: lastGood.snap, age: age };
    }
  }
  const snapAge = found ? Math.max(0, now - (Number(found.snap.savedAt) || (now - found.age))) : 0;
  if (appRunning !== false && uia && uia.title && now - uia.at <= UIA_FRESH_MS) {
    const uiaTitle = String(uia.title).trim();
    const snapCur = found ? (found.snap.current || {}) : {};
    const snapTitle = String(snapCur.name || snapCur.title || '').trim();
    const changedAt = Number(uia.changedAt) || 0;
    const freshChange = changedAt > 0 ? now - changedAt <= UIA_CHANGE_MS : snapAge > UIA_FIRST_MS;
    if ((!found || snapAge > STALE_MS) && snapTitle !== uiaTitle && freshChange) {
      const media = fromUia(uia, !found || found.snap.playing === true);
      if (media) {
        if (snapTitle === media.title) media.artwork = coverOf(found.snap.current);
        return media;
      }
    }
  }
  if (!found) return null;
  if (appRunning === false && snapAge > FRESH_MS) return null;
  const playing = found.snap.playing === true && snapAge <= RECENT_MS;
  return toMedia(found.snap, playing);
}
function hasMetadata(media) {
  const title = String((media && media.title) || '').trim();
  return !!title && title.toLowerCase() !== 'mineradio';
}
module.exports = {
  current: current,
  hasMetadata: hasMetadata,
  __internal: { parseSnapshot: parseSnapshot, sliceObject: sliceObject, toMedia: toMedia, storeDirs: storeDirs },
};
