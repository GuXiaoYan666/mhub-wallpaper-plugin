'use strict';
// sysdeck 主进程入口（MCHOSE HUB 侧）。
// 只由 resources\app\out\main\index.js 末尾一行 try{require("../../sysdeck/index.js")}catch(e){...} 装载。
// 约定：这里绝不 throw 到宿主；所有异常吞掉并写 %APPDATA%\MCHOSEHUB\sysdeck.log。

const path = require('path');
const fs = require('fs');

const TAG = 'sysdeck';
const SAMPLE_MS = 1000;      // CPU/内存采样
const NET_POLL_MS = 2000;    // 网速采样
const WEATHER_MIN_MS = 30 * 60 * 1000; // 天气刷新
const STATUS_HEARTBEAT_MS = 5000;

let ctx = null;
let bootError = null;

function readVersion() {
  try { return fs.readFileSync(path.join(__dirname, 'VERSION'), 'utf8').trim() || '0.0.0'; }
  catch (e) { return '0.0.0'; }
}

function errorPayload(e, code) {
  return { code: code || 'ERROR', message: String((e && (e.message || e.stack)) || e || '').slice(0, 400), at: Date.now() };
}

function createContext() {
  const electron = require('electron');
  if (!electron || !electron.app || !electron.webContents) throw new Error('electron app/webContents unavailable');

  const logger = require('./lib/log.js').createLogger({ tag: TAG });
  const stateMod = require('./lib/state.js');
  const { createCollector } = require('./lib/collectors.js');
  const { createNetRate } = require('./lib/net-rate.js');
  const { createWeather } = require('./lib/weather.js');
  const { createBattery } = require('./lib/battery.js');
  const lunar = require('./lib/lunar.js');
  const { createInjector } = require('./lib/inject.js');
  const { createBridge } = require('./lib/bridge.js');

  const version = readVersion();
  const bootAt = Date.now();

  const env = {
    version: version,
    startedAt: bootAt,
    logger: logger,
    error: null,
    timers: [],
    stopping: false
  };

  function setError(code, e) {
    env.error = errorPayload(e, code);
    logger.warn('error ' + code + ': ' + env.error.message);
  }

  function getConfig() {
    try { return stateMod.loadConfig(); } catch (e) { return stateMod.DEFAULT_CONFIG; }
  }

  const collector = createCollector({ logger: logger.child('collect') });
  const net = createNetRate({ logger: logger.child('net') });
  const weather = createWeather({ logger: logger.child('weather') });
  const battery = createBattery({ logger: logger.child('batt') });

  // 农历：纯本地计算，按日期键缓存（跨天失效）
  let lunarCache = { key: '', value: null };
  function lunarSnapshot() {
    const d = new Date();
    const key = d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
    if (lunarCache.key === key && lunarCache.value) return lunarCache.value;
    let v = null;
    try { v = lunar.describe(d); } catch (e) { v = null; }
    lunarCache = { key: key, value: v };
    return v;
  }

  // 倒数日：按日期升序，days<=0 的排前面（今天/已过）
  function startOfDay(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function countdownSnapshot() {
    const cfg = getConfig();
    const list = Array.isArray(cfg.countdowns) ? cfg.countdowns : [];
    const today = startOfDay(Date.now());
    const out = [];
    for (let i = 0; i < list.length && i < 10; i++) {
      const it = list[i];
      if (!it || !/^\d{4}-\d{2}-\d{2}$/.test(String(it.date || ''))) continue;
      let t;
      try { t = startOfDay(Date.parse(it.date + 'T00:00:00')); } catch (e) { continue; }
      if (!isFinite(t)) continue;
      out.push({
        i: i,
        name: String(it.name || '纪念日').slice(0, 20),
        date: it.date,
        days: Math.round((t - today) / 86400000)
      });
    }
    out.sort(function (a, b) { return a.days - b.days; });
    return out;
  }

  function snapshot() {
    const config = getConfig();
    const on = config.pluginEnabled !== false;
    return {
      v: 2,
      plugin: 'sysdeck',
      version: version,
      pluginEnabled: on,
      config: {
        position: config.position,
        collapsed: !!config.collapsed,
        theme: config.theme || 'auto',
        weatherEnabled: !(config.weather && config.weather.enabled === false),
        netEnabled: !(config.net && config.net.enabled === false),
        diskEnabled: !(config.disk && config.disk.enabled === false),
        pomodoroEnabled: !(config.pomodoro && config.pomodoro.enabled === false),
        lunarEnabled: !(config.lunar && config.lunar.enabled === false),
        batteryEnabled: !(config.battery && config.battery.enabled === false),
        countdownEnabled: config.countdownEnabled !== false,
        weatherCity: config.weatherCity || '',
        docked: config.docked !== false
      },
      sys: on ? collector.snapshot() : null,
      net: (on && !(config.net && config.net.enabled === false)) ? net.snapshot() : null,
      weather: (on && !(config.weather && config.weather.enabled === false)) ? weather.snapshot() : null,
      lunar: (on && !(config.lunar && config.lunar.enabled === false)) ? lunarSnapshot() : null,
      battery: (on && !(config.battery && config.battery.enabled === false)) ? battery.snapshot() : null,
      countdowns: on ? countdownSnapshot() : null,
      pomo: on ? pomoSnapshot() : null,
      error: env.error
    };
  }

  // ---------- 番茄钟（主进程状态机，页面刷新不丢） ----------
  const pomo = { phase: 'idle', running: false, endAt: 0, remainMs: 0, round: 0 };

  function pomoWorkMs() {
    const c = getConfig();
    const m = c.pomodoro && Number(c.pomodoro.workMin);
    return (m > 0 && m <= 180 ? m : 25) * 60 * 1000;
  }
  function pomoBreakMs() {
    const c = getConfig();
    const m = c.pomodoro && Number(c.pomodoro.breakMin);
    return (m > 0 && m <= 60 ? m : 5) * 60 * 1000;
  }

  function pomoStart() {
    if (pomo.running) return;
    if (pomo.phase === 'idle' || pomo.phase === 'paused') {
      if (pomo.phase === 'idle') pomo.remainMs = pomoWorkMs();
      pomo.phase = 'work';
      pomo.running = true;
      pomo.endAt = Date.now() + pomo.remainMs;
    }
  }
  function pomoPause() {
    if (!pomo.running) return;
    pomo.remainMs = Math.max(0, pomo.endAt - Date.now());
    pomo.running = false;
    pomo.phase = 'paused';
  }
  function pomoReset() {
    pomo.phase = 'idle';
    pomo.running = false;
    pomo.remainMs = 0;
    pomo.endAt = 0;
    pomo.round = 0;
  }
  function pomoTick() {
    if (!pomo.running) return;
    const left = pomo.endAt - Date.now();
    if (left > 0) { pomo.remainMs = left; return; }
    if (pomo.phase === 'work') {
      pomo.phase = 'break';
      pomo.remainMs = pomoBreakMs();
      pomo.endAt = Date.now() + pomo.remainMs;
      pomo.round += 1;
      logger.info('pomodoro work done, round=' + pomo.round + ' -> break');
    } else if (pomo.phase === 'break') {
      pomo.phase = 'idle';
      pomo.running = false;
      pomo.remainMs = 0;
      logger.info('pomodoro break done -> idle');
    }
  }
  function pomoSnapshot() {
    return {
      phase: pomo.phase,
      running: pomo.running,
      round: pomo.round,
      remainSec: pomo.running ? Math.max(0, Math.ceil((pomo.endAt - Date.now()) / 1000))
        : Math.max(0, Math.ceil((pomo.remainMs || 0) / 1000)),
      workMin: Math.round(pomoWorkMs() / 60000),
      breakMin: Math.round(pomoBreakMs() / 60000)
    };
  }

  const injector = createInjector({ logger: logger.child('inject') });
  const bridge = createBridge({
    logger: logger.child('bridge'),
    injector: injector,
    getSnapshot: snapshot,
    onUplink: function (msg, wc) {
      try { handleUplink(msg, wc); } catch (e) { logger.warn('uplink handler threw: ' + (e && e.message)); }
    }
  });

  function handleUplink(msg, wc) {
    const wcId = wc && wc.id;
    switch (msg && msg.t) {
      case 'desktopToggle':
        toggleDesktopWindow();
        break;
      case 'desktopHide':
        hideDesktopWindow();
        break;
      case 'desktopHeight':
        resizeDesktopWindow(msg.h);
        break;
      case 'ready':
        logger.info('page ready (wc=' + wcId + ')');
        bridge.pushForced();
        break;
      case 'toggle': {
        const want = typeof msg.on === 'boolean' ? msg.on : !(getConfig().pluginEnabled !== false);
        stateMod.saveConfig({ pluginEnabled: want });
        logger.info('toggle -> pluginEnabled=' + want + ' (wc=' + wcId + ')');
        bridge.pushForced();
        break;
      }
      case 'collapse': {
        const want = typeof msg.collapsed === 'boolean' ? msg.collapsed : !getConfig().collapsed;
        stateMod.saveConfig({ collapsed: want });
        logger.info('collapse -> ' + want + ' (wc=' + wcId + ')');
        bridge.pushForced();
        break;
      }
      case 'position': {
        const p = msg.pos;
        if (p && typeof p.left === 'number' && typeof p.top === 'number' &&
            isFinite(p.left) && isFinite(p.top)) {
          const clamp = function (v) { return Math.max(0, Math.min(0.92, v)); };
          stateMod.saveConfig({ position: { left: clamp(p.left), top: clamp(p.top) }, docked: msg.docked !== false });
          logger.info('position -> ' + JSON.stringify(p) + ' (wc=' + wcId + ')');
          bridge.pushForced();
        }
        break;
      }
      case 'refreshWeather':
        weather.refresh(true, { location: getConfig().weatherCity || '' });
        logger.info('weather refresh requested (wc=' + wcId + ')');
        bridge.pushForced();
        break;
      case 'setWeatherCity': {
        const city = String(msg.city || '').trim().slice(0, 30);
        stateMod.saveConfig({ weatherCity: city });
        logger.info('weather city -> ' + (city || '(auto)') + ' (wc=' + wcId + ')');
        weather.refresh(true, { location: city }, function (fresh) {
          logger.info('weather city refreshed: ' + (fresh && fresh.city || 'failed'));
          bridge.pushForced();
        });
        bridge.pushForced();
        break;
      }
      case 'theme': {
        const want = msg.theme === 'light' || msg.theme === 'dark' || msg.theme === 'auto' ? msg.theme : 'auto';
        stateMod.saveConfig({ theme: want });
        logger.info('theme -> ' + want + ' (wc=' + wcId + ')');
        bridge.pushForced();
        break;
      }
      case 'pomodoro': {
        const act = msg.action;
        if (act === 'start') pomoStart();
        else if (act === 'pause') pomoPause();
        else if (act === 'reset') pomoReset();
        logger.info('pomodoro ' + act + ' -> ' + pomo.phase + ' (wc=' + wcId + ')');
        bridge.pushForced();
        break;
      }
      case 'countdown': {
        const cfg = getConfig();
        let list = Array.isArray(cfg.countdowns) ? cfg.countdowns.slice() : [];
        if (msg.op === 'add') {
          const name = String(msg.name || '').trim().slice(0, 20) || '纪念日';
          const date = String(msg.date || '').trim();
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date + 'T00:00:00'))) {
            logger.warn('countdown add: bad date "' + date + '" (wc=' + wcId + ')');
            break;
          }
          if (list.length >= 10) { logger.warn('countdown add: limit reached'); break; }
          list.push({ name: name, date: date });
          stateMod.saveConfig({ countdowns: list });
          logger.info('countdown add "' + name + '" ' + date + ' (wc=' + wcId + ')');
        } else if (msg.op === 'del') {
          const idx = Number(msg.idx);
          if (isFinite(idx) && idx >= 0 && idx < list.length && Math.floor(idx) === idx) {
            const removed = list.splice(idx, 1)[0];
            stateMod.saveConfig({ countdowns: list });
            logger.info('countdown del #' + idx + ' "' + (removed && removed.name) + '" (wc=' + wcId + ')');
          }
        }
        bridge.pushForced();
        break;
      }
      case 'error':
        logger.warn('page error: ' + JSON.stringify(msg).slice(0, 400));
        env.error = { code: 'PAGE_ERROR', message: String(msg.message || msg.where || '').slice(0, 300), at: Date.now() };
        break;
      default:
        logger.warn('unknown uplink: ' + JSON.stringify(msg).slice(0, 300));
    }
  }

  // ---------- 桌面悬浮窗 ----------
  let desktopWin = null;
  let desktopSaveTimer = null;

  function clampDesktopBounds(x, y, w, h) {
    try {
      const wa = electron.screen.getDisplayMatching({ x: Math.round(x), y: Math.round(y), width: w, height: h }).workArea;
      return {
        x: Math.max(wa.x + 4, Math.min(wa.x + wa.width - w - 4, Math.round(x))),
        y: Math.max(wa.y + 4, Math.min(wa.y + wa.height - h - 4, Math.round(y))),
        width: w,
        height: h
      };
    } catch (e) {
      return { x: Math.round(x), y: Math.round(y), width: w, height: h };
    }
  }

  function createDesktopWindow(show) {
    if (desktopWin && !desktopWin.isDestroyed()) {
      if (show !== false) { try { desktopWin.showInactive(); } catch (e) { /* ignore */ } }
      return desktopWin;
    }
    let wa = { x: 0, y: 0, width: 1280, height: 800 };
    try { wa = electron.screen.getPrimaryDisplay().workArea; } catch (e) { /* ignore */ }
    const cfg = getConfig();
    const pos = cfg.desktopPos;
    const w = 320;
    const h = 720;
    const x = pos && isFinite(pos.x) ? pos.x : wa.x + wa.width - w - 16;
    const y = pos && isFinite(pos.y) ? pos.y : wa.y + 24;
    const b = clampDesktopBounds(x, y, w, h);

    desktopWin = new electron.BrowserWindow({
      x: b.x, y: b.y, width: w, height: h,
      frame: false, transparent: true, backgroundColor: '#00000000',
      resizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, alwaysOnTop: true, hasShadow: false, show: false,
      title: 'SenseDeck',
      webPreferences: {
        preload: path.join(__dirname, 'renderer', 'desktop-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false
      }
    });
    try { desktopWin.setAlwaysOnTop(true, 'floating'); } catch (e) { /* ignore */ }
    try { desktopWin.setMenuBarVisibility(false); } catch (e) { /* ignore */ }
    const htmlPath = path.join(__dirname, 'renderer', 'desktop.html');
    try {
      if (!require('fs').existsSync(htmlPath)) logger.warn('desktop html missing: ' + htmlPath);
    } catch (e) { /* ignore */ }
    desktopWin.loadFile(htmlPath);
    desktopWin.webContents.on('did-fail-load', function (_e, code, desc, url) {
      logger.warn('desktop load failed: ' + code + ' ' + desc + ' ' + url);
    });
    desktopWin.webContents.on('preload-error', function (_e, preloadPath, error) {
      logger.warn('desktop preload error: ' + preloadPath + ' -> ' + (error && error.message));
    });
    desktopWin.webContents.on('console-message', function (_e, level, message) {
      if (level >= 2) logger.warn('desktop console: ' + message);
    });

    const reveal = function () {
      if (!desktopWin || desktopWin.isDestroyed()) return;
      if (show === false) return;
      try { desktopWin.showInactive(); } catch (e) { /* ignore */ }
      try {
        logger.info('desktop show visible=' + desktopWin.isVisible() + ' bounds=' + JSON.stringify(desktopWin.getBounds()));
      } catch (e) { /* ignore */ }
    };
    desktopWin.once('ready-to-show', reveal);
    setTimeout(reveal, 1200);

    desktopWin.on('close', function (e) {
      if (env.stopping) return;
      e.preventDefault();
      try { desktopWin.hide(); } catch (err) { /* ignore */ }
    });
    desktopWin.on('closed', function () { desktopWin = null; });
    desktopWin.on('moved', function () {
      if (!desktopWin || desktopWin.isDestroyed()) return;
      clearTimeout(desktopSaveTimer);
      desktopSaveTimer = setTimeout(function () {
        try {
          const bb = desktopWin.getBounds();
          stateMod.saveConfig({ desktopPos: { x: bb.x, y: bb.y } });
        } catch (e) { /* ignore */ }
      }, 400);
    });
    desktopWin.webContents.on('did-finish-load', function () {
      try { desktopWin.webContents.send('sysdeck:snapshot', snapshot()); } catch (e) { /* ignore */ }
    });
    logger.info('desktop widget created at ' + b.x + ',' + b.y);
    return desktopWin;
  }

  function showDesktopWindow() {
    createDesktopWindow(true);
    try { stateMod.saveConfig({ desktopOpen: true }); } catch (e) { /* ignore */ }
  }

  function hideDesktopWindow() {
    try { if (desktopWin && !desktopWin.isDestroyed()) desktopWin.hide(); } catch (e) { /* ignore */ }
    try { stateMod.saveConfig({ desktopOpen: false }); } catch (e) { /* ignore */ }
  }

  function toggleDesktopWindow() {
    const vis = !!(desktopWin && !desktopWin.isDestroyed() && desktopWin.isVisible());
    logger.info('desktop toggle visible=' + vis);
    if (vis) hideDesktopWindow();
    else showDesktopWindow();
  }

  function resizeDesktopWindow(h) {
    if (!desktopWin || desktopWin.isDestroyed()) return;
    const n = Math.round(Number(h));
    if (!isFinite(n) || n < 260) return;
    try {
      const b = desktopWin.getBounds();
      let wa = null;
      try { wa = electron.screen.getDisplayMatching(b).workArea; } catch (e) { /* ignore */ }
      const hh = Math.min(n, wa ? Math.max(260, wa.height - 8) : 900);
      let y = b.y;
      if (wa && y + hh > wa.y + wa.height - 4) y = Math.max(wa.y + 4, wa.y + wa.height - hh - 4);
      desktopWin.setBounds({ x: b.x, y: y, width: b.width, height: hh });
    } catch (e) { /* ignore */ }
  }

  try {
    electron.ipcMain.on('sysdeck:ready', function () {
      if (!desktopWin || desktopWin.isDestroyed()) return;
      try { desktopWin.webContents.send('sysdeck:snapshot', snapshot()); } catch (e) { /* ignore */ }
    });
    electron.ipcMain.on('sysdeck:uplink', function (_e, msg) {
      try { handleUplink(msg, null); } catch (e) { logger.warn('desktop uplink threw: ' + (e && e.message)); }
    });
  } catch (e) {
    logger.warn('desktop ipc register failed: ' + (e && e.message));
  }

  function safe(fn, name) {
    return function () {
      try { return fn.apply(null, arguments); }
      catch (e) {
        logger.warn((name || 'task') + ' threw: ' + (e && e.message));
        return null;
      }
    };
  }

  function pushLoop() {
    try {
      const s = snapshot();
      bridge.push(s);
      if (desktopWin && !desktopWin.isDestroyed() && desktopWin.isVisible()) {
        try { desktopWin.webContents.send('sysdeck:snapshot', s); } catch (e) { /* ignore */ }
      }
    } catch (e) { /* ignore */ }
  }

  function start() {
    logger.info('plugin ready v' + env.version + ' pid=' + process.pid + ' node=' + process.versions.node + ' electron=' + process.versions.electron + ' data=' + stateMod.paths.DATA_DIR);
    try { stateMod.writeStatus({ v: 1, pluginReady: true, plugin: 'sysdeck', version: version, startedAt: bootAt }); }
    catch (e) { logger.warn('boot status write failed: ' + (e && e.message)); }

    bridge.start();

    collector.start();
    env.timers.push(setInterval(safe(function () { collector.sample(); }, 'cpu sample'), SAMPLE_MS));
    env.timers.push(setInterval(safe(function () { net.poll(); }, 'net poll'), NET_POLL_MS));
    env.timers.push(setInterval(safe(function () { battery.poll(); }, 'battery poll'),
      Math.max(NET_POLL_MS, 120000)));
    env.timers.push(setInterval(safe(function () {
      weather.refresh(false, { location: getConfig().weatherCity || '' });
    }, 'weather'), 60000));
    env.timers.push(setInterval(safe(pushLoop, 'push loop'), 1000));
    env.timers.push(setInterval(safe(function () { try { pomoTick(); } catch (e) { /* ignore */ } }, 'pomodoro tick'), 1000));
    env.timers.push(setInterval(safe(function () {
      try { stateMod.writeStatus({ v: 1, plugin: 'sysdeck', version: version }); } catch (e) { /* ignore */ }
    }, 'status heartbeat'), STATUS_HEARTBEAT_MS));
    weather.refresh(false, { location: getConfig().weatherCity || '' });
    battery.poll();
    pushLoop();

    // 上次开着桌面悬浮窗的话，随 M HUB 启动一起恢复
    if (getConfig().desktopOpen) {
      try {
        electron.app.whenReady().then(function () {
          setTimeout(function () {
            try { if (!desktopWin && getConfig().desktopOpen) createDesktopWindow(true); } catch (e) { /* ignore */ }
          }, 1500);
        });
      } catch (e) { /* ignore */ }
    }

    electron.app.once('before-quit', function () {
      env.stopping = true;
      env.timers.forEach(clearInterval);
    collector.stop();
    net.stop();
    battery.stop();
      try { if (desktopWin && !desktopWin.isDestroyed()) desktopWin.destroy(); } catch (e) { /* ignore */ }
    });

    for (let i = 0; i < env.timers.length; i++) if (env.timers[i] && env.timers[i].unref) env.timers[i].unref();

    logger.info('plugin ready: bridge+collectors started');
    return env;
  }

  env.start = start;
  env.snapshot = snapshot;
  env.bridge = bridge;
  env.injector = injector;
  env.handleUplink = handleUplink;
  env.status = function () {
    return {
      version: version,
      startedAt: env.startedAt,
      uptimeMs: Date.now() - env.startedAt,
      bridge: bridge.status(),
      inject: injector.info(),
      sys: collector.snapshot(),
      net: net.snapshot(),
      weather: weather.snapshot(),
      battery: battery.snapshot(),
      countdowns: countdownSnapshot(),
      error: env.error
    };
  };
  return env;
}

function boot() {
  if (ctx) return ctx;
  try {
    ctx = createContext();
    ctx.start();
  } catch (e) {
    bootError = errorPayload(e, 'BOOT_FAILED');
    try { require('./lib/log.js').crashLog(TAG, e); } catch (e2) { /* ignore */ }
  }
  return ctx;
}

try { boot(); } catch (e) { /* 绝不再抛 */ }

module.exports = {
  boot: boot,
  context: function () { return ctx; },
  snapshot: function () { return ctx ? ctx.snapshot() : null; },
  status: function () { return ctx ? ctx.status() : { error: bootError }; },
  version: readVersion
};
