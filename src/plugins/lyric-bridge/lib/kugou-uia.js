'use strict';
const path = require('path');
const { spawn } = require('child_process');
function parseTimeSample(line) {
  let data;
  try { data = JSON.parse(line); } catch (_) { return null; }
  if (!data || !Number.isFinite(data.elapsedMs) || !Number.isFinite(data.durationMs) ||
      data.elapsedMs < 0 || data.durationMs <= 0 || data.elapsedMs > data.durationMs + 1500) return null;
  return { elapsedMs: data.elapsedMs, durationMs: data.durationMs, at: Number(data.at) || Date.now() };
}
function createKuGouUiTimeline(options) {
  const opts = options || {};
  const spawnProcess = opts.spawn || spawn;
  const helper = opts.helper || path.join(__dirname, 'kugou-timeline.ps1');
  const st = { child: null, running: false, buffer: '', sample: null, changedAt: 0,
    samples: 0, errors: 0, lastError: null };
  function accept(data) {
    const now = Date.now();
    if (!data || now - data.at > 1000 || data.at - now > 1000) return;
    if (!st.sample || data.elapsedMs !== st.sample.elapsedMs || data.durationMs !== st.sample.durationMs) st.changedAt = now;
    st.sample = data;
    st.samples++;
  }
  function receive(chunk) {
    st.buffer += String(chunk);
    if (st.buffer.length > 65536) st.buffer = '';
    let end;
    while ((end = st.buffer.indexOf('\n')) >= 0) {
      const line = st.buffer.slice(0, end).trim();
      st.buffer = st.buffer.slice(end + 1);
      if (line) accept(parseTimeSample(line));
    }
  }
  return {
    start() {
      if (st.running) return;
      st.running = true;
      try {
        const child = spawnProcess('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper,'-ParentProcessId',String(process.pid)], { windowsHide:true, stdio:['ignore','pipe','pipe'] });
        st.child = child;
        child.stdout.on('data', receive);
        child.stderr.on('data', chunk => { st.errors++; st.lastError = String(chunk).slice(0, 300); });
        child.on('error', err => { st.errors++; st.lastError = String(err && err.message || err); });
        child.on('exit', code => { if (st.child === child) st.child = null; if (st.running) { st.errors++; st.lastError = 'helper exited: ' + code; } });
      } catch (e) { st.errors++; st.lastError = String(e && e.message || e); }
    },
    stop() { st.running = false; if (st.child) { try { st.child.kill(); } catch (_) {} st.child = null; } st.sample = null; },
    current() {
      const s = st.sample, now = Date.now();
      if (!s || now - s.at > 800) return null;
      const age = Math.max(0, now - st.changedAt);
      const playing = age < 1500;
      const positionMs = s.elapsedMs + (playing ? Math.min(999, age) : 0);
      return { positionMs: Math.min(positionMs, s.durationMs), playing, durationMs: s.durationMs, at: s.at };
    },
    status() { const clock = this.current(); return { ready: !!clock, positionMs: clock ? clock.positionMs : null, durationMs: clock ? clock.durationMs : null, playing: clock ? clock.playing : false, sampleAgeMs: st.sample ? Date.now() - st.sample.at : null, samples: st.samples, errors: st.errors, error: st.lastError }; },
    _internal: st,
    _accept: accept
  };
}
module.exports = { createKuGouUiTimeline, parseTimeSample };
