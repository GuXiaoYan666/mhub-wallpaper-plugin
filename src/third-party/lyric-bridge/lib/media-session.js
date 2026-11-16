'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ACTIONS = new Set(['previous', 'toggle', 'next', 'seek']);
function normalizeMedia(value) {
  if (!value || !value.key || !value.title) return null;
  const number = n => Number.isFinite(Number(n)) ? Math.max(0, Number(n)) : 0;
  const at = number(value.at) || Date.now(), durationMs = number(value.durationMs);
  let positionMs = number(value.positionMs);
  const positionAt = number(value.positionAt);
  if (/soda|\u6c7d\u6c34/i.test(value.id) && value.playing === true && durationMs > 0 && positionAt > 0 && positionAt <= at) {
    const rate = Number(value.playbackRate);
    positionMs = Math.min(durationMs, positionMs + (at - positionAt) * (Number.isFinite(rate) && rate > 0 ? rate : 1));
  }
  return { id: String(value.id), key: String(value.key), title: String(value.title),
    artist: String(value.artist || ''), album: String(value.album || ''),
    artwork: /^data:image\/(png|jpeg|jpg|webp|bmp);base64,[a-z\d+/=]+$/i.test(value.artwork || '') && value.artwork.length < 2800000 ? value.artwork : '',
    playing: value.playing === true, positionMs, durationMs, positionAt,
    playbackRate: Number(value.playbackRate) > 0 ? Number(value.playbackRate) : 1,
    at, controls: Object.fromEntries(['previous', 'playPause', 'next', 'seek'].map(k => [k, value.controls && value.controls[k] === true])) };
}
function createKuGouMediaTimeline(options = {}) {
  const now = options.now || Date.now;
  let key = null, trackAt = 0, previous = null;
  return function merge(media, clock) {
    if (!media || !/kugou/i.test(media.id)) { key = null; previous = null; return media; }
    const at = now();
    if (key !== media.key) { key = media.key; trackAt = at; previous = null; }
    const fresh = clock && clock.at >= trackAt && at - clock.at <= 1000 &&
      clock.durationMs > 0 && Number.isFinite(clock.positionMs);
    const durationMs = fresh ? clock.durationMs : media.durationMs || (previous && previous.durationMs) || 0;
    let positionMs = media.positionMs;
    if (fresh) positionMs = media.playing ? clock.positionMs : Math.floor(clock.positionMs / 1000) * 1000;
    else if (!media.durationMs && previous) positionMs = previous.positionMs + (previous.playing ? Math.max(0, at - previous.at) : 0);
    const result = Object.assign({}, media, { durationMs, positionMs: Math.max(0, Math.min(durationMs, positionMs)), at });
    previous = result;
    return result;
  };
}
function createMediaSession(options = {}) {
  const onChange = options.onChange || (() => {});
  const pending = new Map();
  const st = { child: null, dir: null, media: null, receivedAt: 0, ready: false, error: null, buffer: '', count: 0, running: false, retry: null, failures: 0, outputAt: 0, watchdog: null };
  function notify() { try { onChange(); } catch (_) {} }
  function remove(file) { try { fs.unlinkSync(file); } catch (_) {} }
  function finish(id, result) {
    const p = pending.get(id);
    if (!p) return;
    clearTimeout(p.timer); pending.delete(id); remove(p.file); p.resolve(result);
  }
  function accept(row) {
    if (!row || typeof row !== 'object') return;
    if (row.t === 'state') {
      st.media = normalizeMedia(row.media); st.receivedAt = Date.now(); st.ready = true; st.error = null; st.failures = 0;
      notify();
    } else if (row.t === 'result') {
      finish(row.requestId, { ok: row.ok === true, error: row.error || null });
    } else if (row.t === 'error') {
      st.error = String(row.error || 'Media session unavailable'); notify();
      if (++st.failures >= 5 && st.child) st.child.kill();
    }
  }
  function failPending(message) {
    for (const id of pending.keys()) finish(id, {ok:false,error:message});
  }
  function launch() {
    if (!st.running || st.child) return;
    try {
      if (!st.dir) st.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-media-'));
      st.buffer = ''; st.outputAt = Date.now(); st.failures = 0;
      const child = (options.spawn || spawn)('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'media-session.ps1'),'-CommandDir',st.dir,'-ParentProcessId',String(process.pid)], {windowsHide:true,stdio:['ignore','pipe','pipe']});
      st.child = child;
      if (child.stdout.setEncoding) child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        if (st.child !== child) return;
        st.outputAt = Date.now();
        st.buffer += String(chunk);
        if (st.buffer.length > 6000000) st.buffer = '';
        let end;
        while ((end = st.buffer.indexOf('\n')) >= 0) {
          const line = st.buffer.slice(0,end); st.buffer = st.buffer.slice(end+1);
          try { accept(JSON.parse(line)); } catch (_) {}
        }
      });
      child.stderr.on('data', chunk => { st.error = String(chunk).slice(0,250); });
      const failed = message => {
        if (st.child !== child) return;
        st.child = null; st.media = null; st.error = message; st.ready = true;
        failPending(message); notify(); scheduleRetry();
      };
      child.on('error', err => failed(err.message));
      child.on('exit', () => failed('Media helper stopped'));
    } catch(e) { st.error = e.message; st.ready = true; notify(); scheduleRetry(); }
  }
  function scheduleRetry() {
    if (st.running && !st.retry) {
      st.retry = setTimeout(() => { st.retry = null; launch(); }, options.retryMs || 2000);
      if (st.retry.unref) st.retry.unref();
    }
  }
  return {
    start() {
      if (st.running) return; st.running = true; launch();
      st.watchdog = setInterval(() => { if (st.child && Date.now()-st.outputAt > 12000) st.child.kill(); },2000);
      if (st.watchdog.unref) st.watchdog.unref();
    },
    snapshot() {
      const media = st.media && Date.now() - st.receivedAt < 5000 ? st.media : null;
      return { ready: st.ready, media, error: st.error };
    },
    command(message) {
      const media = this.snapshot().media;
      if (!message || !ACTIONS.has(message.action) || !media || !st.child ||
          message.sessionId !== media.id || message.trackKey !== media.key)
        return Promise.resolve({ok:false,error:'当前歌曲已变化，请重试'});
      const cap = message.action === 'toggle' ? 'playPause' : message.action;
      if (!media.controls[cap]) return Promise.resolve({ok:false,error:'播放器暂不支持此操作'});
      if (message.action === 'seek' && (!Number.isFinite(message.positionMs) || !Number.isFinite(message.durationMs) || message.durationMs <= 0 || message.positionMs < 0 || message.positionMs > message.durationMs))
        return Promise.resolve({ok:false,error:'播放位置无效'});
      if (pending.size) return Promise.resolve({ok:false,error:'正在处理上一次操作'});
      const requestId = Date.now() + '-' + (++st.count);
      return new Promise(resolve => {
        const file = path.join(st.dir,requestId+'.json');
        const timeoutMs = options.commandTimeoutMs || 6000;
        const timer = setTimeout(() => finish(requestId, {ok:false,error:'播放器响应超时，请重试'}), timeoutMs);
        pending.set(requestId,{resolve,timer,file});
        try {
          fs.writeFileSync(file+'.tmp',JSON.stringify({requestId,expiresAt:Date.now()+Math.min(5000,timeoutMs),sessionId:media.id,trackKey:media.key,action:message.action,positionMs:message.positionMs,durationMs:message.durationMs}));
          fs.renameSync(file+'.tmp',file);
        } catch(e) { remove(file+'.tmp'); finish(requestId, {ok:false,error:e.message}); }
      });
    },
    stop() {
      st.running = false; clearTimeout(st.retry); st.retry = null; clearInterval(st.watchdog); st.watchdog = null;
      const child = st.child; st.child = null;
      if (child) child.kill();
      failPending('Media session stopped'); st.media = null;
      if (st.dir) { try { fs.rmSync(st.dir,{recursive:true,force:true}); } catch(_) {} st.dir = null; }
    },
    _accept: accept, _internal: st
  };
}
module.exports = { createMediaSession, normalizeMedia, createKuGouMediaTimeline };
