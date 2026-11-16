'use strict';
// 网速采集：读取 Windows 性能原始计数器（Win32_PerfRawData_Tcpip_NetworkInterface）
// 的累计收发字节数，在 JS 侧按两次采样差值折算速率。不含环回接口。
// PowerShell 不可用时降级为 ok=false，绝不阻塞主进程。

const { spawn } = require('child_process');

const PS_QUERY =
  '$ErrorActionPreference="SilentlyContinue";' +
  'Get-CimInstance Win32_PerfRawData_Tcpip_NetworkInterface |' +
  ' Where-Object { $_.Name -notmatch "Loopback|isatap|Teredo" } |' +
  ' Select-Object Name,BytesReceivedPersec,BytesSentPersec |' +
  ' ConvertTo-Json -Compress';

const BACKOFF_AFTER_FAILS = 3;
const BACKOFF_MULTIPLIER = 5;

function toNumber(v) {
  const n = Number(v);
  return isFinite(n) && n >= 0 ? n : null;
}

function normalize(value) {
  let list = value;
  if (!list) return [];
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch (e) { return []; }
  }
  if (!Array.isArray(list)) list = [list];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    if (!it || typeof it !== 'object') continue;
    const name = String(it.Name || it.name || '');
    if (/loopback|isatap|teredo/i.test(name)) continue;
    const rx = toNumber(it.BytesReceivedPersec);
    const tx = toNumber(it.BytesSentPersec);
    if (rx === null || tx === null) continue;
    out.push({ rx: rx, tx: tx });
  }
  return out;
}

function createNetRate(options) {
  const logger = options && options.logger;
  const state = {
    lastRx: null,
    lastTx: null,
    lastAt: 0,
    down: 0,       // bytes/s
    up: 0,
    downHist: [],
    upHist: [],
    ok: null,      // null=未采样, true, false
    err: null,
    fails: 0,
    busy: false,
    child: null,
    stopping: false
  };
  const HIST_LEN = 60;

  function pushHist(arr, v) {
    arr.push(v);
    while (arr.length > HIST_LEN) arr.shift();
  }

  function handleResult(raw) {
    const items = normalize(raw);
    let rx = 0, tx = 0;
    for (let i = 0; i < items.length; i++) { rx += items[i].rx; tx += items[i].tx; }
    const now = Date.now();
    if (state.lastRx !== null && state.lastAt > 0) {
      const dt = (now - state.lastAt) / 1000;
      const dRx = rx - state.lastRx;
      const dTx = tx - state.lastTx;
      if (dt > 0.2 && dRx >= 0 && dTx >= 0) {
        state.down = Math.round(dRx / dt);
        state.up = Math.round(dTx / dt);
        pushHist(state.downHist, state.down);
        pushHist(state.upHist, state.up);
      }
      // 计数器回绕或网卡重置：负增量只刷新基线，本次不更新速率。
    }
    state.lastRx = rx;
    state.lastTx = tx;
    state.lastAt = now;
    state.ok = true;
    state.err = null;
    state.fails = 0;
  }

  function poll() {
    if (state.busy || state.stopping) return;
    state.busy = true;
    let settled = false;
    let child = null;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_QUERY],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      state.busy = false;
      markFail('spawn: ' + (e && e.message));
      return;
    }
    state.child = child;
    let out = '';
    const timer = setTimeout(function () {
      try { child.kill(); } catch (e) { /* ignore */ }
    }, 10000);
    if (timer.unref) timer.unref();

    const finish = function (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      state.busy = false;
      state.child = null;
      if (err) { markFail(err); return; }
      try { handleResult(out); }
      catch (e) { markFail('parse: ' + (e && e.message)); }
    };

    child.stdout.on('data', function (d) { out += String(d); });
    child.on('error', function (e) { finish('error: ' + (e && e.message)); });
    child.on('close', function (code) {
      if (code !== 0 && out.trim() === '') { finish('powershell exit ' + code); return; }
      finish(null);
    });
  }

  function markFail(message) {
    state.fails++;
    state.err = String(message).slice(0, 200);
    state.ok = false;
    if (state.fails >= BACKOFF_AFTER_FAILS && logger) {
      logger.debug('net poll failing (' + state.fails + '): ' + state.err);
    }
  }

  function effectivePollMs(base) {
    return state.fails >= BACKOFF_AFTER_FAILS ? base * BACKOFF_MULTIPLIER : base;
  }

  function snapshot() {
    return {
      ok: state.ok,
      err: state.err,
      down: state.down,
      up: state.up,
      downHist: state.downHist.slice(),
      upHist: state.upHist.slice()
    };
  }

  function stop() {
    state.stopping = true;
    try { if (state.child) state.child.kill(); } catch (e) { /* ignore */ }
  }

  return { poll: poll, snapshot: snapshot, stop: stop, effectivePollMs: effectivePollMs };
}

module.exports = { createNetRate: createNetRate };
