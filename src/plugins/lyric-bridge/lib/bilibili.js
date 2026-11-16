'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const P = require('./paths.js');
const stateMod = require('./state.js');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const REFERER = 'https://www.bilibili.com/';
const LOG_FILE = path.join(P.APPDATA, 'Bilibili', 'logs', 'main.log');
const COOKIE_FILE = path.join(P.DATA_DIR, 'bilibili-sessdata.txt');
const CACHE_DIR = path.join(P.DATA_DIR, 'bilibili');
const MAX_BODY = 4 * 1024 * 1024;
const MAX_LINES = 3000;
const MAX_LOG_BYTES = 512 * 1024;
const MAX_PAGES = 6;
const logCache = { at: 0, size: -1, mtimeMs: 0, ids: [] };
const viewCache = {};
const wbiCache = { at: 0, key: '' };
let linkHint = { bvid: '', at: 0 };
const MIXIN = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];
function cfg() {
  let c = {};
  try { c = stateMod.loadConfig() || {}; } catch (e) { /* ignore */ }
  return c.bilibili || {};
}
function cookieValue() {
  const c = cfg();
  let value = String(c.sessdata || '').trim();
  if (!value) {
    const file = c.file ? String(c.file) : COOKIE_FILE;
    try { value = fs.readFileSync(file, 'utf8').trim(); } catch (e) { /* ignore */ }
  }
  if (!value) return '';
  const m = /(?:^|;)\s*SESSDATA\s*=\s*([^;]+)/i.exec(value);
  if (m) value = m[1];
  return value.replace(/^[\s"']+|[\s"']+$/g, '');
}
function hasCookie() { return !!cookieValue(); }
function headers(cookie) {
  const h = {
    'User-Agent': UA,
    'Referer': REFERER,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9'
  };
  if (cookie) h.Cookie = 'SESSDATA=' + cookie;
  return h;
}
function getJson(url, cookie, redirects) {
  return new Promise(function (resolve, reject) {
    let settled = false;
    function done(error, value) {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve(value);
    }
    let req;
    try {
      req = https.get(url, { headers: headers(cookie) }, function (res) {
        const code = Number(res.statusCode) || 0;
        if (code >= 300 && code < 400 && res.headers.location && (redirects || 0) > 0) {
          res.resume();
          const next = String(res.headers.location).indexOf('http') === 0
            ? String(res.headers.location) : 'https:' + String(res.headers.location);
          return getJson(next, cookie, (redirects || 0) - 1).then(function (v) { done(null, v); }, done);
        }
        if (code !== 200) {
          res.resume();
          return done(new Error('HTTP ' + code));
        }
        const chunks = [];
        let size = 0;
        res.on('data', function (chunk) {
          size += chunk.length;
          if (size > MAX_BODY) { req.destroy(new Error('BODY TOO LARGE')); return; }
          chunks.push(chunk);
        });
        res.on('end', function () {
          try { done(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch (e) { done(new Error('BAD JSON')); }
        });
        res.on('error', done);
      });
    } catch (e) { return done(e); }
    req.setTimeout(12000, function () { req.destroy(new Error('TIMEOUT')); });
    req.on('error', done);
  });
}
function clean(value) {
  return String(value == null ? '' : value)
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}
function normTitle(value) {
  return String(value || '').toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/[^0-9a-z\u4e00-\u9fff]+/g, '');
}
function titleScore(a, b) {
  const x = normTitle(a), y = normTitle(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const min = Math.min(x.length, y.length);
  if (min >= 6 && (x.indexOf(y) >= 0 || y.indexOf(x) >= 0)) return 0.92;
  let same = 0;
  const max = Math.min(x.length, y.length);
  while (same < max && x.charAt(same) === y.charAt(same)) same++;
  return same / Math.max(x.length, y.length);
}
function extractBvid(text) {
  const s = String(text || '');
  const m = /BV[0-9A-Za-z]{10}/.exec(s);
  return m ? m[0] : '';
}
function noteText(text) {
  const bvid = extractBvid(text);
  if (bvid) linkHint = { bvid: bvid, at: Date.now() };
}
function recentLinkBvid() {
  return Date.now() - linkHint.at < 10 * 60000 ? linkHint.bvid : '';
}
function encoded(value) {
  return encodeURIComponent(String(value).replace(/[!'()*]/g, ''));
}
async function wbiKey() {
  if (wbiCache.key && Date.now() - wbiCache.at < 1800000) return wbiCache.key;
  const nav = await getJson('https://api.bilibili.com/x/web-interface/nav', '', 2);
  const img = nav && nav.data && nav.data.wbi_img;
  if (!img) throw new Error('WBI_UNAVAILABLE');
  const nameOf = function (url) { return String(url || '').split('/').pop().split('.')[0]; };
  const raw = nameOf(img.img_url) + nameOf(img.sub_url);
  let key = '';
  for (let i = 0; i < MIXIN.length; i++) key += raw.charAt(MIXIN[i]);
  wbiCache.at = Date.now();
  wbiCache.key = key.slice(0, 32);
  return wbiCache.key;
}
function durationMsOf(value) {
  if (typeof value === 'number' && value > 0) return value * 1000;
  const parts = String(value || '').split(':');
  if (!parts.length || parts.length > 3) return 0;
  let sec = 0;
  for (let i = 0; i < parts.length; i++) {
    const n = Number(parts[i]);
    if (!Number.isFinite(n) || n < 0) return 0;
    sec = sec * 60 + n;
  }
  return sec * 1000;
}
async function searchVideos(keyword) {
  const key = await wbiKey();
  const params = { search_type: 'video', keyword: String(keyword || '').slice(0, 80), page: 1 };
  const wts = Math.floor(Date.now() / 1000);
  const query = Object.keys(params).sort().map(function (k) {
    return encoded(k) + '=' + encoded(params[k]);
  }).join('&') + '&wts=' + wts;
  const rid = crypto.createHash('md5').update(query + key).digest('hex');
  const json = await getJson('https://api.bilibili.com/x/web-interface/wbi/search/type?' + query + '&w_rid=' + rid, '', 2);
  const list = json && json.code === 0 && json.data && Array.isArray(json.data.result) ? json.data.result : [];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!item || !/^BV[0-9A-Za-z]{10}$/.test(String(item.bvid || ''))) continue;
    out.push({
      bvid: item.bvid,
      title: clean(item.title),
      author: clean(item.author),
      durationMs: durationMsOf(item.duration)
    });
  }
  return out;
}
function pickPage(info, wantedMs) {
  const pages = pageOf(info);
  let pageIndex = 0;
  let pageTitle = '';
  let pageMs = info.durationMs;
  if (wantedMs > 0) {
    let bestDiff = Infinity;
    for (let p = 0; p < pages.length; p++) {
      const ms = pages[p].durationMs || 0;
      if (ms <= 0) continue;
      const diff = Math.abs(ms - wantedMs);
      if (diff < bestDiff) { bestDiff = diff; pageIndex = p; pageTitle = pages[p].part; pageMs = ms; }
    }
  }
  return { pages: pages, pageIndex: pageIndex, pageTitle: pageTitle, durationMs: pageMs };
}
function videoResult(info, wantedMs) {
  const page = pickPage(info, wantedMs);
  return {
    ok: true,
    bvid: info.bvid,
    cids: orderCids(page.pages, page.pageIndex),
    title: info.title,
    pageTitle: page.pageTitle,
    artist: info.owner,
    durationMs: page.durationMs || info.durationMs
  };
}
function webTitle(value) {
  const raw = clean(value);
  if (!raw) return '';
  if (/哔哩哔哩\s*\(゜-゜\)|干杯~?-bilibili/i.test(raw)) return '';
  const cut = raw
    .replace(/[\s_\-–—|·:：~]*哔哩哔哩[\s_\-–—|·:：]*bilibili[\s]*$/i, '')
    .replace(/[\s_\-–—|·:：~]+哔哩哔哩[\s]*$/i, '')
    .replace(/[\s_\-–—|·:：~]+bilibili[\s]*$/i, '')
    .trim();
  return cut.length >= 2 ? cut : '';
}
async function findForWeb(media) {
  const wanted = webTitle(media && media.title);
  const wantedMs = Math.max(0, Number(media && media.durationMs) || 0);
  if (!wanted) return { ok: false, error: { code: 'NO_VIDEO', message: '浏览器只提供标签页标题，未识别到视频名' } };
  const hint = recentLinkBvid();
  if (hint) {
    try {
      const info = await viewInfo(hint);
      const score = titleScore(wanted, info.title);
      const durOk = !wantedMs || !info.durationMs || Math.abs(info.durationMs - wantedMs) <= Math.max(10000, info.durationMs * 0.05);
      if (score >= 0.6 || (score >= 0.4 && durOk)) return videoResult(info, wantedMs);
    } catch (e) { /* ignore */ }
  }
  let list = [];
  try { list = await searchVideos(wanted); } catch (e) { return { ok: false, error: { code: 'SEARCH_FAILED', message: String(e && e.message) } }; }
  let best = null;
  for (let i = 0; i < list.length && i < 10; i++) {
    const item = list[i];
    const score = titleScore(wanted, item.title);
    const durScore = wantedMs > 0 && item.durationMs > 0
      ? 1 - Math.min(1, Math.abs(item.durationMs - wantedMs) / Math.max(item.durationMs, wantedMs)) : 0;
    const total = score * 0.8 + durScore * 0.2;
    if (!best || total > best.total) best = { item: item, score: score, total: total };
  }
  if (!best || best.score < 0.9) return { ok: false, error: { code: 'NO_VIDEO', message: '网页视频未匹配到 B 站' } };
  if (wantedMs > 0 && best.item.durationMs > 0 && Math.abs(best.item.durationMs - wantedMs) > Math.max(10000, best.item.durationMs * 0.06)) {
    return { ok: false, error: { code: 'NO_VIDEO', message: '网页视频时长不匹配' } };
  }
  let info = null;
  try { info = await viewInfo(best.item.bvid); } catch (e) { return { ok: false, error: { code: 'VIEW_FAILED', message: String(e && e.message) } }; }
  return videoResult(info, wantedMs);
}
function latestBvids(limit) {
  let stat;
  try { stat = fs.statSync(LOG_FILE); } catch (e) { return []; }
  const now = Date.now();
  if (logCache.size === stat.size && logCache.mtimeMs === stat.mtimeMs && now - logCache.at < 3000) {
    return logCache.ids.slice(0, limit || 12);
  }
  const start = Math.max(0, stat.size - MAX_LOG_BYTES);
  const length = stat.size - start;
  const buffer = Buffer.alloc(length);
  let fd = null;
  try {
    fd = fs.openSync(LOG_FILE, 'r');
    fs.readSync(fd, buffer, 0, length, start);
  } catch (e) {
    return [];
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (e2) { /* ignore */ } }
  }
  const text = buffer.toString('utf8');
  const re = /Open player window:\s*(\{[^\r\n]*\})/g;
  const ids = [];
  const seen = {};
  let match;
  while ((match = re.exec(text))) {
    let item = null;
    try { item = JSON.parse(match[1]); } catch (e) { continue; }
    if (!item || item.type !== 'ugc' || !/^BV[0-9A-Za-z]{10}$/.test(String(item.bvid || ''))) continue;
    if (seen[item.bvid]) continue;
    seen[item.bvid] = true;
    ids.push(item.bvid);
  }
  const result = ids.slice(-24).reverse();
  logCache.at = now;
  logCache.size = stat.size;
  logCache.mtimeMs = stat.mtimeMs;
  logCache.ids = result;
  return result.slice(0, limit || 12);
}
async function viewInfo(bvid) {
  const hit = viewCache[bvid];
  if (hit && Date.now() - hit.at < 600000) return hit.value;
  const url = 'https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid);
  const json = await getJson(url, '', 2);
  if (!json || json.code !== 0 || !json.data) throw new Error((json && json.message) || 'VIEW_FAILED');
  const data = json.data;
  const pages = Array.isArray(data.pages) ? data.pages.map(function (page) {
    return {
      cid: page.cid,
      part: clean(page.part),
      durationMs: Math.max(0, Number(page.duration) || 0) * 1000
    };
  }) : [];
  const value = {
    bvid: bvid,
    aid: data.aid,
    cid: data.cid,
    title: clean(data.title),
    owner: clean(data.owner && data.owner.name),
    durationMs: Math.max(0, Number(data.duration) || 0) * 1000,
    pages: pages
  };
  viewCache[bvid] = { at: Date.now(), value: value };
  return value;
}
function orderCids(pages, pageIndex) {
  const ordered = [];
  if (pages[pageIndex] && pages[pageIndex].cid) ordered.push(pages[pageIndex].cid);
  for (let p = 0; p < pages.length; p++) {
    if (p !== pageIndex && pages[p].cid) ordered.push(pages[p].cid);
  }
  return ordered.slice(0, MAX_PAGES);
}
function pageOf(info) {
  return info.pages && info.pages.length ? info.pages : [{ cid: info.cid, part: '', durationMs: info.durationMs }];
}
async function findForMedia(media) {
  const wanted = clean(media && media.title);
  const wantedMs = Math.max(0, Number(media && media.durationMs) || 0);
  const ids = latestBvids(12);
  if (!ids.length) return { ok: false, error: { code: 'NO_BVID', message: '未找到 B 站播放记录' } };
  let best = null;
  for (let i = 0; i < ids.length && i < 8; i++) {
    let info = null;
    try { info = await viewInfo(ids[i]); } catch (e) { continue; }
    let score = titleScore(wanted, info.title);
    let pageTitle = '';
    let pageMs = info.durationMs;
    let pageIndex = 0;
    const pages = pageOf(info);
    for (let p = 0; p < pages.length; p++) {
      const s = pages[p].part ? titleScore(wanted, info.title + ' ' + pages[p].part) : 0;
      if (s > score) { score = s; pageTitle = pages[p].part; pageMs = pages[p].durationMs || pageMs; pageIndex = p; }
    }
    if (pages.length > 1 && wantedMs > 0) {
      let bestDiff = Infinity;
      for (let p = 0; p < pages.length; p++) {
        const ms = pages[p].durationMs || 0;
        if (ms <= 0) continue;
        const diff = Math.abs(ms - wantedMs);
        if (diff < bestDiff) { bestDiff = diff; pageIndex = p; pageTitle = pages[p].part; pageMs = ms; }
      }
    }
    const durationScore = wantedMs > 0 && pageMs > 0
      ? 1 - Math.min(1, Math.abs(pageMs - wantedMs) / Math.max(pageMs, wantedMs)) : 0;
    const total = score * 0.82 + durationScore * 0.18;
    if (!best || total > best.total) {
      best = {
        total: total,
        score: score,
        info: info,
        pageTitle: pageTitle,
        durationMs: pageMs,
        cids: orderCids(pages, pageIndex)
      };
    }
    if (score >= 0.94) break;
  }
  if (!best || best.score < 0.55) {
    try {
      const info = await viewInfo(ids[0]);
      const pages = pageOf(info);
      let pageIndex = 0;
      if (wantedMs > 0) {
        let bestDiff = Infinity;
        for (let p = 0; p < pages.length; p++) {
          const ms = pages[p].durationMs || 0;
          if (ms <= 0) continue;
          const diff = Math.abs(ms - wantedMs);
          if (diff < bestDiff) { bestDiff = diff; pageIndex = p; }
        }
      }
      return {
        ok: true,
        weak: true,
        bvid: info.bvid,
        cids: orderCids(pages, pageIndex),
        title: info.title,
        pageTitle: pages[pageIndex] ? pages[pageIndex].part : '',
        artist: info.owner,
        durationMs: (pages[pageIndex] && pages[pageIndex].durationMs) || info.durationMs
      };
    } catch (e) { /* ignore */ }
    return { ok: false, error: { code: 'NO_VIDEO', message: '未匹配到当前视频' } };
  }
  return {
    ok: true,
    bvid: best.info.bvid,
    cids: best.cids,
    title: best.info.title,
    pageTitle: best.pageTitle,
    artist: best.info.owner,
    durationMs: best.durationMs || best.info.durationMs
  };
}
function cacheFile(bvid, cid) {
  return path.join(CACHE_DIR, String(bvid).replace(/[^A-Za-z0-9]/g, '') + '_' + String(cid).replace(/[^0-9]/g, '') + '.json');
}
function readCache(bvid, cid) {
  try {
    const value = JSON.parse(fs.readFileSync(cacheFile(bvid, cid), 'utf8'));
    if (value && Array.isArray(value.lines) && value.lines.length) return value;
  } catch (e) { /* ignore */ }
  return null;
}
function parseSubtitle(json) {
  const body = json && Array.isArray(json.body) ? json.body : [];
  const lines = [];
  for (let i = 0; i < body.length && lines.length < MAX_LINES; i++) {
    const item = body[i];
    if (!item) continue;
    const from = Number(item.from);
    const text = clean(item.content);
    if (!Number.isFinite(from) || from < 0 || !text) continue;
    lines.push({ timeMs: Math.max(0, Math.round(from * 1000)), text: text });
  }
  lines.sort(function (a, b) { return a.timeMs - b.timeMs; });
  return lines;
}
async function subtitlesFor(bvid, cid) {
  const cached = readCache(bvid, cid);
  const hours = Math.max(1, Number(cfg().cacheHours) || 12);
  if (cached && Date.now() - Number(cached.fetchedAt || 0) < hours * 3600000) {
    return { ok: true, lines: cached.lines, title: cached.title || '', cached: true };
  }
  const cookie = cookieValue();
  if (!cookie) {
    if (cached) return { ok: true, lines: cached.lines, title: cached.title || '', cached: true, stale: true };
    return { ok: false, error: { code: 'NO_COOKIE', message: 'B 站字幕需要 SESSDATA' } };
  }
  let info = null;
  try {
    info = await getJson('https://api.bilibili.com/x/player/wbi/v2?bvid=' + encodeURIComponent(bvid) + '&cid=' + encodeURIComponent(cid), cookie, 2);
    if (!info || info.code !== 0 || !info.data) {
      info = await getJson('https://api.bilibili.com/x/player/v2?bvid=' + encodeURIComponent(bvid) + '&cid=' + encodeURIComponent(cid), cookie, 2);
    }
  } catch (e) {
    if (cached) return { ok: true, lines: cached.lines, title: cached.title || '', cached: true, stale: true };
    return { ok: false, error: { code: 'HTTP', message: String(e && e.message) } };
  }
  const subtitle = info && info.data && info.data.subtitle;
  const list = subtitle && Array.isArray(subtitle.subtitles) ? subtitle.subtitles : [];
  const usable = list.filter(function (item) { return item && item.subtitle_url; });
  usable.sort(function (a, b) {
    const rank = function (lan) {
      const s = String(lan || '').toLowerCase();
      if (s === 'ai-zh' || s === 'zh-cn' || s === 'zh-hans') return 0;
      if (s.indexOf('zh') === 0 || s.indexOf('ai-zh') === 0) return 1;
      if (s.indexOf('ai-') === 0) return 2;
      return 3;
    };
    return rank(a.lan) - rank(b.lan);
  });
  const pick = usable[0];
  if (!pick) {
    if (cached) return { ok: true, lines: cached.lines, title: cached.title || '', cached: true, stale: true };
    return { ok: false, error: { code: 'NO_SUBTITLE', message: '该视频没有可用字幕' } };
  }
  const url = String(pick.subtitle_url).indexOf('//') === 0 ? 'https:' + pick.subtitle_url : String(pick.subtitle_url);
  let json = null;
  try { json = await getJson(url, '', 2); }
  catch (e) {
    if (cached) return { ok: true, lines: cached.lines, title: cached.title || '', cached: true, stale: true };
    return { ok: false, error: { code: 'SUBTITLE_HTTP', message: String(e && e.message) } };
  }
  const lines = parseSubtitle(json);
  if (!lines.length) {
    if (cached) return { ok: true, lines: cached.lines, title: cached.title || '', cached: true, stale: true };
    return { ok: false, error: { code: 'EMPTY_SUBTITLE', message: '字幕内容为空' } };
  }
  const title = clean((info.data && info.data.title) || '');
  try {
    stateMod.atomicWriteJson(cacheFile(bvid, cid), {
      v: 1, bvid: bvid, cid: cid, title: title, fetchedAt: Date.now(), lines: lines
    });
  } catch (e) { /* ignore */ }
  return { ok: true, lines: lines, title: title, cached: false };
}
let loginPending = null;
function loginViaBrowser() {
  if (loginPending) return loginPending;
  let BrowserWindow = null;
  try { BrowserWindow = require('electron').BrowserWindow; } catch (e) { /* ignore */ }
  if (!BrowserWindow) return Promise.resolve({ ok: false, error: 'NO_ELECTRON' });
  loginPending = new Promise(function (resolve) {
    let settled = false;
    let timer = null;
    let timeout = null;
    const win = new BrowserWindow({
      width: 460,
      height: 640,
      title: 'B 站扫码登录',
      autoHideMenuBar: true,
      resizable: true,
      minimizable: false,
      maximizable: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false }
    });
    try { win.setMenuBarVisibility(false); } catch (e) { /* ignore */ }
    const ses = win.webContents.session;
    function finish(result) {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      if (timeout) clearTimeout(timeout);
      loginPending = null;
      try { if (!win.isDestroyed()) win.close(); } catch (e) { /* ignore */ }
      resolve(result);
    }
    timer = setInterval(function () {
      ses.cookies.get({ name: 'SESSDATA' }).then(function (list) {
        const hit = (list || []).filter(function (c) {
          return c && c.value && /bilibili\.com$/i.test(String(c.domain || ''));
        })[0];
        if (!hit) return;
        const saved = stateMod.saveConfig({ bilibili: { sessdata: hit.value } });
        if (saved && saved.ok) finish({ ok: true });
        else finish({ ok: false, error: 'SAVE_FAILED' });
      }).catch(function () { /* ignore */ });
    }, 1200);
    if (timer && typeof timer.unref === 'function') timer.unref();
    timeout = setTimeout(function () { finish({ ok: false, error: 'TIMEOUT' }); }, 300000);
    if (timeout && typeof timeout.unref === 'function') timeout.unref();
    win.on('closed', function () { finish({ ok: false, error: 'CANCELLED' }); });
    win.loadURL('https://passport.bilibili.com/login');
  });
  return loginPending;
}
module.exports = {
  hasCookie: hasCookie,
  cookieFile: COOKIE_FILE,
  logFile: LOG_FILE,
  latestBvids: latestBvids,
  findForMedia: findForMedia,
  findForWeb: findForWeb,
  subtitlesFor: subtitlesFor,
  noteText: noteText,
  loginViaBrowser: loginViaBrowser,
  _internal: { clean: clean, titleScore: titleScore, normTitle: normTitle, readCache: readCache, extractBvid: extractBvid }
};
