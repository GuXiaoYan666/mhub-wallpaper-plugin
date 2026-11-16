'use strict';
// 电池状态采集（笔记本）：Win32_Battery 查询电量与充电状态。
// 台式机/无电池时 available=false，面板自动隐藏。PowerShell 不可用降级 ok=false。
// 轮询间隔 2 分钟；查询失败指数退避（×5），绝不阻塞主进程。

const { spawn } = require('child_process');

const PS_QUERY =
  '$ErrorActionPreference="SilentlyContinue";' +
  'Get-CimInstance Win32_Battery | Select-Object -First 1 EstimatedChargeRemaining,BatteryStatus |' +
  ' ConvertTo-Json -Compress';

const BACKOFF_AFTER_FAILS = 3;
const BACKOFF_MULTIPLIER = 5;

function createBattery(options) {
  const logger = options && options.logger;
  const state = {
    pct: null,
    charging: null,   // null=未知, true=接通电源, false=电池供电
    available: null,  // null=未探测, true, false（台式机）
    ok: null,
    err: null,
    fails: 0,
    busy: false,
    child: null,
    stopping: false
  };

  function handleResult(raw) {
    let v = raw;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { v = null; } }
    if (Array.isArray(v)) v = v[0];
    if (!v || typeof v !== 'object' || v.EstimatedChargeRemaining === null || v.EstimatedChargeRemaining === undefined) {
      state.available = false;
      state.pct = null;
      state.charging = null;
      state.ok = true;
      state.err = null;
      state.fails = 0;
      return;
    }
    const p = Number(v.EstimatedChargeRemaining);
    state.available = true;
    state.pct = isFinite(p) ? Math.max(0, Math.min(100, Math.round(p))) : null;
    // BatteryStatus: 1=放电, 2=接通电源(交流), 其他视为未知
    state.charging = Number(v.BatteryStatus) === 2;
    state.ok = true;
    state.err = null;
    state.fails = 0;
  }

  function markFail(message) {
    state.fails++;
    state.err = String(message).slice(0, 200);
    state.ok = false;
    if (state.fails >= BACKOFF_AFTER_FAILS && logger) {
      logger.debug('battery poll failing (' + state.fails + '): ' + state.err);
    }
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

  function snapshot() {
    return {
      ok: state.ok,
      available: state.available,
      pct: state.pct,
      charging: state.charging,
      err: state.err
    };
  }

  function stop() {
    state.stopping = true;
    try { if (state.child) state.child.kill(); } catch (e) { /* ignore */ }
  }

  function effectivePollMs(base) {
    return state.fails >= BACKOFF_AFTER_FAILS ? base * BACKOFF_MULTIPLIER : base;
  }

  return { poll: poll, snapshot: snapshot, stop: stop, effectivePollMs: effectivePollMs };
}

module.exports = { createBattery: createBattery };
