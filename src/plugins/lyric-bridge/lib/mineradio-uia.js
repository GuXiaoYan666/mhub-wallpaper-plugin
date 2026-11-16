'use strict';
const path = require('path');
const { spawn } = require('child_process');
const FRESH_MS = 3000;
function parseSample(line) {
  let data;
  try { data = JSON.parse(line); } catch (_) { return null; }
  if (!data || typeof data.title !== 'string') return null;
  const at = Number(data.at) || Date.now();
  const position = Number(data.positionMs);
  const duration = Number(data.durationMs);
  return {
    title: data.title.trim(),
    artist: String(data.artist || '').trim(),
    at: at,
    positionMs: Number.isFinite(position) && position >= 0 ? position : null,
    durationMs: Number.isFinite(duration) && duration > 0 ? duration : 0,
    playing: typeof data.playing === 'boolean' ? data.playing : null,
  };
}
function createMineradioUia(options) {
  const opts = options || {};
  const spawnProcess = opts.spawn || spawn;
  const helper = opts.helper || path.join(__dirname, 'mineradio-uia.ps1');
  const st = { child: null, running: false, buffer: '', sample: null, errors: 0, lastError: null, lastKey: '', changedAt: 0 };
  function receive(chunk) {
    st.buffer += String(chunk);
    if (st.buffer.length > 65536) st.buffer = '';
    let end;
    while ((end = st.buffer.indexOf('\n')) >= 0) {
      const line = st.buffer.slice(0, end).trim();
      st.buffer = st.buffer.slice(end + 1);
      if (!line) continue;
      const sample = parseSample(line);
      if (!sample) continue;
      const key = sample.title + '|' + sample.artist;
      if (key !== st.lastKey) {
        st.changedAt = st.lastKey ? sample.at : 0;
        st.lastKey = key;
      }
      sample.changedAt = st.changedAt;
      st.sample = sample;
    }
  }
  return {
    start() {
      if (st.running) return;
      st.running = true;
      try {
        const child = spawnProcess('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper,'-ParentProcessId',String(process.pid)], { windowsHide: true, stdio: ['ignore','pipe','pipe'] });
        st.child = child;
        child.stdout.on('data', receive);
        child.stderr.on('data', function (chunk) { st.errors++; st.lastError = String(chunk).slice(0, 300); });
        child.on('error', function (err) { st.errors++; st.lastError = String((err && err.message) || err); });
        child.on('exit', function (code) {
          if (st.child === child) st.child = null;
          if (st.running) { st.errors++; st.lastError = 'helper exited: ' + code; }
        });
      } catch (e) { st.errors++; st.lastError = String((e && e.message) || e); }
    },
    stop() {
      st.running = false;
      if (st.child) { try { st.child.kill(); } catch (_) { /* 已退出 */ } st.child = null; }
      st.sample = null;
    },
    current() {
      const s = st.sample;
      if (!s || !s.title) return null;
      if (Date.now() - s.at > FRESH_MS) return null;
      return s;
    },
    status() {
      return { ready: !!this.current(), title: st.sample ? st.sample.title : '', sampleAgeMs: st.sample ? Date.now() - st.sample.at : null, errors: st.errors, error: st.lastError };
    }
  };
}
module.exports = { createMineradioUia, parseSample };
