'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const DEFAULT_INI = path.join(process.env.APPDATA || 'C:\\Users\\Administrator\\AppData\\Roaming', 'KuGou8', 'KuGou.ini');
const DEFAULT_KRC_DIR = 'C:\\KuGou\\Lyric';
const KRC_MAGIC = 'krc1';
const KRC_XOR_KEY = Buffer.from([0x40, 0x47, 0x61, 0x77, 0x5e, 0x32, 0x74, 0x47, 0x51, 0x36, 0x31, 0x2d, 0xce, 0xd2, 0x6e, 0x69]);
const HASH_SUFFIX = /-(?:[0-9a-fA-F]{32})-[0-9]+-[0-9]+$/;
function monoMs() { return Number(process.hrtime.bigint() / 1000000n); }
function fail(code, message, extra) {
  const e = { code: code, message: String(message) };
  if (extra) for (const k of Object.keys(extra)) e[k] = extra[k];
  return { ok: false, error: e };
}
function stripBomText(s) {
  if (s && s.charCodeAt(0) === 0xFEFF) return s.slice(1);
  return s;
}
function decodeIniText(buf) {
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'utf-16le' };
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), encoding: 'utf-16be' };
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8-sig' };
  let nul = 0;
  const probe = Math.min(buf.length, 1024);
  for (let i = 1; i < probe; i += 2) if (buf[i] === 0) nul++;
  if (probe > 16 && nul > probe / 4) return { text: new TextDecoder('utf-16le').decode(buf), encoding: 'utf-16le' };
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8' }; }
  catch (e) { try { return { text: new TextDecoder('gbk').decode(buf), encoding: 'gbk' }; } catch (e2) { return { text: buf.toString('latin1'), encoding: 'latin1' }; } }
}
function parseIni(text) {
  const sections = Object.create(null);
  let cur = null;
  const rows = String(text).split(/\r?\n/);
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    const line = raw.trim();
    if (!line) continue;
    if (line[0] === ';' || line[0] === '#') continue;
    const sm = /^\[(.+)\]$/.exec(line);
    if (sm) { cur = sm[1]; if (!sections[cur]) sections[cur] = Object.create(null); continue; }
    const eq = line.indexOf('=');
    if (eq <= 0 || cur === null) continue;
    sections[cur][line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return sections;
}
function readConfig(iniPath) {
  const p = iniPath || DEFAULT_INI;
  let buf, st;
  try { st = fs.statSync(p); }
  catch (e) { return fail('INI_NOT_FOUND', '酷狗配置文件不存在: ' + p + ' (' + e.code + ')', { iniPath: p }); }
  try { buf = fs.readFileSync(p); }
  catch (e) { return fail('INI_UNREADABLE', '酷狗配置文件无法读取: ' + e.message, { iniPath: p }); }
  if (!buf.length) return fail('INI_EMPTY', '酷狗配置文件为空', { iniPath: p });
  const dec = decodeIniText(buf);
  const sections = parseIni(dec.text);
  const pb = sections['PlaybackState'] || {};
  const lc = sections['LyricConfigSection'] || {};
  const posRaw = pb['LastPlayingSongPos'];
  const pos = posRaw === undefined ? null : Number(String(posRaw).trim());
  if (posRaw !== undefined && !Number.isFinite(pos)) return fail('INI_BAD_POS', 'LastPlayingSongPos 不是数字: ' + posRaw, { iniPath: p });
  let lyricDir = lc['LyricPath'] || DEFAULT_KRC_DIR;
  if (lyricDir && !/[\\\/]$/.test(lyricDir)) lyricDir += path.sep;
  return {
    ok: true,
    iniPath: p,
    encoding: dec.encoding,
    iniMtimeMs: st.mtimeMs,
    lyricDir: lyricDir,
    title: pb['LastPlayingTitleName'] || null,
    itemId: pb['LastPlayingSongItem'] || null,
    table: pb['LastPlayingSongTable'] || null,
    list: pb['LastPlayingSongList'] || null,
    positionMs: pos,
    sections: sections
  };
}
function decodeKrcBuffer(buf) {
  if (!buf || !buf.length) throw Object.assign(new Error('空文件'), { krcCode: 'KRC_EMPTY' });
  if (buf.length > 4 && buf.subarray(0, 4).toString('latin1') === KRC_MAGIC) {
    const body = buf.subarray(4);
    const plain = Buffer.allocUnsafe(body.length);
    for (let i = 0; i < body.length; i++) plain[i] = body[i] ^ KRC_XOR_KEY[i % 16];
    try { return { text: stripBomText(zlib.inflateSync(plain).toString('utf8')), container: 'krc1+zlib' }; }
    catch (e) { throw Object.assign(new Error('KRC zlib 解压失败: ' + e.message), { krcCode: 'KRC_INFLATE' }); }
  }
  if (buf[0] === 0x78) {
    try { return { text: stripBomText(zlib.inflateSync(buf).toString('utf8')), container: 'raw-zlib' }; }
    catch (e) { throw Object.assign(new Error('裸 zlib 解压失败: ' + e.message), { krcCode: 'KRC_INFLATE' }); }
  }
  if (buf[0] === 0x5B || buf[0] === 0xEF) return { text: stripBomText(buf.toString('utf8')), container: 'plain-text' };
  throw Object.assign(new Error('未知容器头: ' + buf.subarray(0, 4).toString('hex')), { krcCode: 'KRC_BAD_MAGIC' });
}
const LINE_RE = /^\[(\d+),(\d+)\]([\s\S]*)$/;
const WORD_RE = /<(\d+),(\d+),-?\d+>([^<]*)/g;
const META_RE = /^\[([A-Za-z_]+):([\s\S]*)\]$/;
function parseKrcText(text) {
  const meta = Object.create(null);
  const lines = [];
  const rows = String(text).split(/\r?\n/);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const lm = LINE_RE.exec(row);
    if (lm) {
      const timeMs = Number(lm[1]);
      const durationMs = Number(lm[2]);
      const body = lm[3];
      let out = '';
      let found = false;
      WORD_RE.lastIndex = 0;
      let wm;
      while ((wm = WORD_RE.exec(body)) !== null) { found = true; out += wm[3]; }
      if (!found) out = body.replace(/<[^>]*>/g, '');
      const t = out.replace(/\s+/g, ' ').trim();
      if (!t) continue;
      lines.push({ timeMs: timeMs, durationMs: durationMs, text: t });
      continue;
    }
    const mm = META_RE.exec(row);
    if (mm) meta[mm[1]] = mm[2];
  }
  lines.sort(function (a, b) { return a.timeMs - b.timeMs; });
  return { lines: lines, meta: meta };
}
function parseKrcFile(filePath) {
  let buf;
  try { buf = fs.readFileSync(filePath); }
  catch (e) { return fail('KRC_NOT_FOUND', '无法读取 KRC: ' + filePath + ' (' + (e.code || e.message) + ')', { path: filePath }); }
  let dec;
  try { dec = decodeKrcBuffer(buf); }
  catch (e) { return fail(e.krcCode || 'KRC_DECODE', 'KRC 解码失败: ' + e.message, { path: filePath }); }
  const parsed = parseKrcText(dec.text);
  if (!parsed.lines.length) return fail('KRC_NO_LINES', 'KRC 中没有可解析的歌词行', { path: filePath, container: dec.container });
  return { ok: true, path: filePath, container: dec.container, lines: parsed.lines, meta: parsed.meta, byteLength: buf.length };
}
function splitKrcFileName(fileName) {
  const base = String(fileName).replace(/\.krc$/i, '');
  const m = HASH_SUFFIX.exec(base);
  if (!m) return { stem: base, hash: null, raw: String(fileName) };
  const hash = m[0].slice(1).split('-')[0];
  return { stem: base.slice(0, base.length - m[0].length), hash: hash, raw: String(fileName) };
}
function listKrc(dir) {
  const d = dir || DEFAULT_KRC_DIR;
  let names;
  try { names = fs.readdirSync(d); }
  catch (e) { return fail('KRC_DIR_UNREADABLE', '歌词目录不可读: ' + d + ' (' + (e.code || e.message) + ')', { dir: d }); }
  const files = [];
  for (let i = 0; i < names.length; i++) {
    const n = names[i];
    if (!/\.krc$/i.test(n)) continue;
    const full = path.join(d, n);
    let st;
    try { st = fs.statSync(full); } catch (e) { continue; }
    if (!st.isFile()) continue;
    const parts = splitKrcFileName(n);
    files.push({ name: n, path: full, stem: parts.stem, hash: parts.hash, size: st.size, mtimeMs: st.mtimeMs });
  }
  return { ok: true, dir: d, files: files, count: files.length };
}
function normalizeTitle(s) {
  return String(s == null ? '' : s)
    .replace(/[\u200b-\u200f\uFEFF]/g, '')
    .replace(/[\\\/:*?"<>|]/g, '')
    .replace(/[\uFF08]/g, '(').replace(/[\uFF09]/g, ')')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
function samePlaybackTrack(media, iniTitle) {
  if (!media || !media.title || !iniTitle) return false;
  const full = normalizeTitle(iniTitle);
  const mediaFull = normalizeTitle((media.artist ? media.artist + ' - ' : '') + media.title);
  if (mediaFull === full) return true;
  const cut = String(iniTitle).lastIndexOf(' - ');
  if (cut < 0 || normalizeTitle(media.title) !== normalizeTitle(String(iniTitle).slice(cut + 3))) return false;
  if (!media.artist) return true;
  const artists = String(iniTitle).slice(0, cut).split(/[,，、/＆&;；]+/).map(normalizeTitle);
  const reported = String(media.artist).split(/[,，、/＆&;；]+/).map(normalizeTitle);
  return reported.some(function (artist) { return artist && artists.includes(artist); });
}
function bigrams(s) {
  const set = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    set.set(g, (set.get(g) || 0) + 1);
  }
  return set;
}
function dice(a, b) {
  if (!a.length || !b.length) return 0;
  const A = bigrams(a), B = bigrams(b);
  let inter = 0;
  A.forEach(function (v, k) { if (B.has(k)) inter += Math.min(v, B.get(k)); });
  const total = (a.length - 1) + (b.length - 1);
  return total > 0 ? (2 * inter) / total : 0;
}
function scoreTitle(titleNorm, stemNorm) {
  if (!titleNorm || !stemNorm) return 0;
  if (titleNorm === stemNorm) return 1;
  if (stemNorm.indexOf(titleNorm) === 0 || titleNorm.indexOf(stemNorm) === 0) {
    const ratio = Math.min(titleNorm.length, stemNorm.length) / Math.max(titleNorm.length, stemNorm.length);
    return 0.7 + 0.25 * ratio;
  }
  return dice(titleNorm, stemNorm) * 0.85;
}
function matchKrcForTitle(title, dir, options) {
  const opts = options || {};
  const threshold = opts.threshold == null ? 0.6 : opts.threshold;
  if (!title) return fail('NO_TITLE', '当前没有播放标题（LastPlayingTitleName 为空）');
  const listed = listKrc(dir);
  if (!listed.ok) return listed;
  if (!listed.count) return fail('NO_KRC', '歌词目录中没有 .krc 文件: ' + listed.dir, { dir: listed.dir });
  const tn = normalizeTitle(title);
  if (!tn) return fail('NO_TITLE', '标题归一化后为空: ' + title);
  let best = null;
  const scored = [];
  for (let i = 0; i < listed.files.length; i++) {
    const f = listed.files[i];
    const sc = scoreTitle(tn, normalizeTitle(f.stem));
    scored.push({ file: f, score: sc });
    if (!best || sc > best.score) best = { file: f, score: sc };
  }
  scored.sort(function (a, b) { return b.score - a.score; });
  if (!best || best.score < threshold) {
    return fail('NO_MATCH', '未匹配到歌词文件: ' + title, {
      best: scored.slice(0, 3).map(function (x) { return { name: x.file.name, score: Number(x.score.toFixed(3)) }; })
    });
  }
  return { ok: true, path: best.file.path, file: best.file, score: Number(best.score.toFixed(4)), candidates: scored.slice(0, 3).map(function (x) { return { name: x.file.name, score: Number(x.score.toFixed(3)) }; }) };
}
function findLineIndex(lines, posMs) {
  let lo = 0, hi = lines.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].timeMs <= posMs) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}
function createKuGouWatcher(options) {
  const opts = options || {};
  const intervalMs = opts.intervalMs > 0 ? opts.intervalMs : 500;
  const pauseAfterMs = opts.pauseAfterMs == null ? 5000 : opts.pauseAfterMs;
  const positionLeadMs = Number.isFinite(Number(opts.positionLeadMs)) ? Number(opts.positionLeadMs) : 0;
  const maxExtrapolateMs = opts.maxExtrapolateMs == null ? 120000 : opts.maxExtrapolateMs;
  const assumePlayingBeforeFirstSnapshotChange = opts.assumePlayingBeforeFirstSnapshotChange !== false;
  const iniPath = opts.iniPath || DEFAULT_INI;
  const statusProvider = typeof opts.statusProvider === 'function' ? opts.statusProvider : null;
  const mediaProvider = typeof opts.mediaProvider === 'function' ? opts.mediaProvider : null;
  const st = {
    running: false, timer: null, ticks: 0, errors: 0,
    title: null, krcPath: null, lines: [], meta: null, krcError: null,
    index: -1, posMs: 0, playing: false, pausedInferred: false,
    anchor: { posMs: 0, wall: monoMs() },
    lastSnap: { pos: null, mtime: null },
    sawSnapshotChange: false,
    lastChangeWall: monoMs(),
    lastErrorCode: null,
    noTitleWarned: false,
    totalMs: 0
  };
  let lastTrackLoadAt = 0;
  function emit(name, payload) {
    const fn = opts[name];
    if (typeof fn !== 'function') return;
    try { fn(payload); } catch (e) { /* 回调异常不得打死轮询 */ }
  }
  function reportError(code, message, extra) {
    st.errors++;
    st.lastErrorCode = code;
    const e = { code: code, message: String(message), at: Date.now() };
    if (extra) for (const k of Object.keys(extra)) e[k] = extra[k];
    emit('onError', e);
    return e;
  }
  function loadTrack(title, cfg) {
    lastTrackLoadAt = monoMs();
    st.title = title;
    st.krcPath = null; st.lines = []; st.meta = null; st.krcError = null;
    st.index = -1; st.totalMs = 0;
    const dir = (cfg && cfg.lyricDir) || DEFAULT_KRC_DIR;
    const m = matchKrcForTitle(title, dir);
    if (!m.ok) {
      st.krcError = m.error;
      reportError(m.error.code, m.error.message, { title: title, dir: dir, best: m.error.best });
      emit('onTrack', { title: title, krcPath: null, lineCount: 0, error: m.error });
      return;
    }
    const p = parseKrcFile(m.path);
    if (!p.ok) {
      st.krcError = p.error;
      reportError(p.error.code, p.error.message, { path: m.path });
      emit('onTrack', { title: title, krcPath: m.path, lineCount: 0, error: p.error });
      return;
    }
    st.krcPath = m.path;
    st.lines = p.lines;
    st.meta = p.meta;
    const last = p.lines[p.lines.length - 1];
    st.totalMs = last.timeMs + last.durationMs;
    emit('onTrack', { title: title, krcPath: m.path, lineCount: p.lines.length, meta: p.meta, container: p.container, score: m.score, initialPosMs: st.anchor.posMs, playing: st.playing });
  }
  function computePlaying(t0) {
    if (statusProvider) {
      let s = null;
      try { s = statusProvider(); } catch (e) { s = null; }
      if (s === 'playing' || s === true) { st.pausedInferred = false; return true; }
      if (s === 'paused' || s === false) { st.pausedInferred = false; return false; }
    }
    if (!st.sawSnapshotChange && assumePlayingBeforeFirstSnapshotChange) { st.pausedInferred = false; return true; }
    if (pauseAfterMs > 0) {
      const idle = t0 - st.lastChangeWall;
      if (idle >= pauseAfterMs) { st.pausedInferred = true; return false; }
    }
    st.pausedInferred = false;
    return true;
  }
  function tick() {
    const t0 = monoMs();
    st.ticks++;
    let cfg;
    try { cfg = readConfig(iniPath); }
    catch (e) { reportError('CONFIG_THROW', 'readConfig 抛出: ' + e.message); return; }
    if (!cfg.ok) {
      if (st.lastErrorCode !== cfg.error.code) reportError(cfg.error.code, cfg.error.message, cfg.error);
      const prev = st.playing;
      st.playing = false;
      if (prev !== st.playing) emit('onState', snapshotState());
      return;
    }
    const live = mediaProvider ? mediaProvider(cfg) : null;
    const iniMatches = !live || samePlaybackTrack(live, cfg.title);
    const liveTitle = live && live.title ? ((live.artist ? live.artist + ' - ' : '') + live.title) : null;
    const title = (iniMatches && cfg.title) || liveTitle || cfg.title || null;
    const iniPos = iniMatches ? cfg.positionMs : null;
    const ledIniPos = iniPos == null ? null : (iniPos > 0 ? Math.max(0, iniPos + positionLeadMs) : 0);
    if (title !== st.title) {
      if (!title && st.title) {
        if (!st.noTitleWarned) { st.noTitleWarned = true; reportError('INI_NO_TITLE', 'ini 中标题暂时为空（可能正在写入），保留当前曲目'); }
      } else {
        st.noTitleWarned = false;
        st.anchor = { posMs: live && Number.isFinite(live.positionMs) ? live.positionMs : ledIniPos == null ? 0 : ledIniPos, wall: t0 };
        st.lastSnap = { pos: iniPos, mtime: cfg.iniMtimeMs };
        st.posMs = st.anchor.posMs;
        st.index = -1;
        st.playing = mediaProvider ? !!(live && live.playing) : computePlaying(t0);
        loadTrack(title, cfg);
      }
    }
    if (title && !st.krcPath && t0 - lastTrackLoadAt > 1500) loadTrack(title, cfg);
    const snapPos = live && Number.isFinite(live.positionMs) ? live.positionMs : ledIniPos;
    const mtime = cfg.iniMtimeMs;
    const posChanged = snapPos !== st.lastSnap.pos;
    const mtimeChanged = mtime !== st.lastSnap.mtime;
    if (posChanged || mtimeChanged) {
      st.lastChangeWall = t0;
      if (posChanged && snapPos != null) {
        st.sawSnapshotChange = true;
        st.anchor = { posMs: snapPos, wall: t0 };
      }
      st.lastSnap = { pos: snapPos, mtime: mtime };
    }
    const playing = mediaProvider ? !!(live && live.playing) : computePlaying(t0);
    if (live && Number.isFinite(live.positionMs)) st.anchor = { posMs: live.positionMs, wall: t0 };
    if (playing !== st.playing) {
      if (!playing) st.anchor = { posMs: st.posMs, wall: t0 };
      else st.anchor = { posMs: st.anchor.posMs, wall: t0 };
      st.playing = playing;
      emit('onState', snapshotState());
    }
    const elapsed = playing ? (t0 - st.anchor.wall) : 0;
    let pos = st.anchor.posMs + elapsed;
    if (maxExtrapolateMs > 0) pos = Math.min(pos, st.anchor.posMs + maxExtrapolateMs);
    if (st.totalMs > 0) pos = Math.min(pos, st.totalMs + 1500);
    if (pos < 0) pos = 0;
    st.posMs = pos;
    if (!st.lines.length) {
      if (st.index !== -1) {
        st.index = -1;
        emit('onLine', { index: -1, total: 0, text: null, timeMs: null, durationMs: null, posMs: Math.round(pos), lineProgress: 0, playing: playing, song: { title: st.title, krcPath: st.krcPath }, reason: 'clear', error: st.krcError });
      }
      return;
    }
    const idx = findLineIndex(st.lines, pos);
    if (idx !== st.index) {
      const reason = st.index === -1 ? 'start' : (idx > st.index ? (idx - st.index > 1 ? 'jump' : 'advance') : 'seek-back');
      st.index = idx;
      const line = idx >= 0 ? st.lines[idx] : null;
      const next = idx + 1 < st.lines.length ? st.lines[idx + 1] : null;
      const dur = line ? (line.durationMs || (next ? next.timeMs - line.timeMs : 0)) : 0;
      const lp = line && dur > 0 ? Math.min(1, Math.max(0, (pos - line.timeMs) / dur)) : 0;
      emit('onLine', {
        index: idx, total: st.lines.length,
        text: line ? line.text : null,
        timeMs: line ? line.timeMs : null,
        durationMs: line ? dur : null,
        posMs: Math.round(pos), lineProgress: Number(lp.toFixed(3)),
        playing: playing, song: { title: st.title, krcPath: st.krcPath }, reason: reason
      });
    } else if (opts.emitProgress && idx >= 0) {
      const line = st.lines[idx];
      const next = idx + 1 < st.lines.length ? st.lines[idx + 1] : null;
      const dur = line.durationMs || (next ? next.timeMs - line.timeMs : 0);
      const lp = dur > 0 ? Math.min(1, Math.max(0, (pos - line.timeMs) / dur)) : 0;
      emit('onProgress', { index: idx, total: st.lines.length, text: line.text, timeMs: line.timeMs, posMs: Math.round(pos), lineProgress: Number(lp.toFixed(3)), playing: playing });
    }
  }
  function snapshotState() {
    return { title: st.title, krcPath: st.krcPath, lineCount: st.lines.length, index: st.index, posMs: Math.round(st.posMs), playing: st.playing, pausedInferred: st.pausedInferred, totalMs: st.totalMs, ticks: st.ticks, errors: st.errors };
  }
  function safeTick() { try { tick(); } catch (e) { reportError('TICK_THROW', '轮询内部异常: ' + (e && e.message)); } }
  return {
    start: function () {
      if (st.running) return this;
      st.running = true;
      safeTick();
      st.timer = setInterval(safeTick, intervalMs);
      if (st.timer && typeof st.timer.unref === 'function') st.timer.unref();
      return this;
    },
    stop: function () {
      st.running = false;
      if (st.timer) { clearInterval(st.timer); st.timer = null; }
      return this;
    },
    pollNow: function () { safeTick(); return snapshotState(); },
    setPlaying: function (v) {
      const p = !!v;
      if (p === st.playing) return this;
      st.anchor = { posMs: p ? st.anchor.posMs : st.posMs, wall: monoMs() };
      st.playing = p;
      st.pausedInferred = false;
      emit('onState', snapshotState());
      return this;
    },
    getState: snapshotState,
    _internal: st
  };
}
module.exports = {
  readConfig: readConfig,
  listKrc: listKrc,
  parseKrcFile: parseKrcFile,
  matchKrcForTitle: matchKrcForTitle,
  createKuGouWatcher: createKuGouWatcher,
  decodeKrcBuffer: decodeKrcBuffer,
  parseKrcText: parseKrcText,
  decodeIniText: decodeIniText,
  parseIni: parseIni,
  samePlaybackTrack: samePlaybackTrack,
  splitKrcFileName: splitKrcFileName,
  normalizeTitle: normalizeTitle,
  findLineIndex: findLineIndex,
  DEFAULTS: { iniPath: DEFAULT_INI, krcDir: DEFAULT_KRC_DIR, xorKey: KRC_XOR_KEY }
};
