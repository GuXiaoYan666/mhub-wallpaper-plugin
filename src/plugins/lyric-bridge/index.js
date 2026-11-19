'use strict';
const path = require('path');
const fs = require('fs');
const TAG = 'lyric-bridge';
const ICON_PRIME_DELAY_MS = 6000;
const PLAYERS_REFRESH_MS = 60000;
const PLAYERS_REFRESH_IDLE_MS = 300000;   /* 零播放器时放宽到 5 分钟 */
const RUNNING_REFRESH_MS = 2000;
const RUNNING_REFRESH_IDLE_MS = 15000;   /* 休眠时 15s 一次 */
const ACTIVITY_IDLE_THRESHOLD_MS = 30000; /* 30s 没活动就进入休眠 */
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
  const logMod = require('./lib/log.js');
  const logger = logMod.createLogger({ tag: TAG });
  const stateMod = require('./lib/state.js');
  const { createInjector } = require('./lib/inject.js');
  const { createBridge } = require('./lib/bridge.js');
  const { createEngine } = require('./lib/engine.js');
  const { createMediaSession, createKuGouMediaTimeline } = require('./lib/media-session.js');
  const { createOnlineLyrics } = require('./lib/lyrics-online.js');
  const { createKuGouUiTimeline } = require('./lib/kugou-uia.js');
  const { createAudioReactive } = require('./lib/audio-reactive.js');
  const kugou = require('./lib/kugou.js');
  const bilibili = require('./lib/bilibili.js');
  const mineradio = require('./lib/mineradio.js');
  const { createMineradioUia } = require('./lib/mineradio-uia.js');
  const kugouTimeline = createKuGouUiTimeline();
  const mineradioUia = createMineradioUia();
  const mergeKuGouTimeline = createKuGouMediaTimeline();
  const version = readVersion();
  const bootAt = Date.now();
  const env = {
    version: version,
    startedAt: bootAt,
    logger: logger,
    error: null,
    players: [],
    playersAt: 0,
    playersBusy: false,
    playersReady: false,
    playerAction: null,
    mediaSession: null,
    mediaAction: null,
    stopping: false,
    delivery: null,
    runningBusy: false,
    iconCache: new Map(),
    iconTimer: null,
    timers: [],
    idleSince: 0          /* 零活动时间戳；超过阈值则进入休眠模式，定时器间隔拉长 */
  };
  function setError(code, e) {
    env.error = errorPayload(e, code);
    logger.warn('error ' + code + ': ' + env.error.message);
  }
  let playersMod = null;
  try { playersMod = require('./lib/players.js'); }
  catch (e) { logger.warn('players module unavailable: ' + (e && e.message)); }
  function getConfig() {
    try { return stateMod.loadConfig(); } catch (e) { return stateMod.DEFAULT_CONFIG; }
  }
  let kugouIniCache = { key: '', at: 0, title: null };
  function kugouIniTitle(media, iniPath) {
    const cacheKey = media.key + '|' + (iniPath || '');
    const now = Date.now();
    if (kugouIniCache.key !== cacheKey || now - kugouIniCache.at > 2000) {
      const r = kugou.readConfig(iniPath);
      kugouIniCache = { key: cacheKey, at: now, title: r && r.ok ? r.title : null };
    }
    return kugouIniCache.title;
  }
  function currentMedia(config) {
    const cfgNow = config || getConfig();
    const raw = env.mediaSession ? env.mediaSession.snapshot() : { media: null };
    let media = mergeKuGouTimeline(raw.media || null, kugouTimeline.current());
    if (media && /kugou/i.test(media.id)) {
      const title = kugouIniTitle(media, cfgNow.kugou && cfgNow.kugou.iniPath);
      if (title && kugou.samePlaybackTrack(media, title)) {
        const divider = title.lastIndexOf(' - ');
        if (divider > 0) media = Object.assign({}, media, { artist: title.slice(0, divider) });
      }
    }
    let mineradioRunning;
    for (let i = 0; i < env.players.length; i++) {
      if (/^mineradio$/i.test(env.players[i].id)) { mineradioRunning = !!env.players[i].running; break; }
    }
    const local = mineradio.current(mineradioRunning, mineradioUia.current());
    if (local && local.playing) return local;
    const placeholder = !!media && /mineradio/i.test(media.id) && !mineradio.hasMetadata(media);
    if (!media || placeholder || !media.playing) {
      if (local) return local;
      return placeholder ? null : media;
    }
    return media;
  }
  function snapshot() {
    const config = getConfig();
    const lyric = env.engine ? env.engine.getLyric() : {
      on: config.pluginEnabled !== false && config.lyricEnabled !== false,
      text: '', source: null, title: '', artist: '', album: '', posMs: 0, durationMs: 0, playing: false
    };
    const nowPlaying = env.mediaSession ? env.mediaSession.snapshot() : {ready:false,media:null,error:null};
    nowPlaying.media = currentMedia(config);
    if (nowPlaying.media && lyric && lyric.on && lyric.artwork && !nowPlaying.media.artwork &&
        String(lyric.title || '').trim() === String(nowPlaying.media.title || '').trim()) {
      nowPlaying.media = Object.assign({}, nowPlaying.media, { artwork: lyric.artwork });
    }
    if (!nowPlaying.media && lyric && lyric.on && lyric.title) {
      nowPlaying.media = {
        id: 'lyric:' + (lyric.source || 'unknown'),
        key: 'lyric|' + (lyric.source || '') + '|' + lyric.title + '|' + (lyric.artist || ''),
        title: lyric.title,
        artist: lyric.artist || '',
        album: lyric.album || '',
        artwork: lyric.artwork || '',
        playing: !!lyric.playing,
        positionMs: Math.max(0, Number(lyric.posMs) || 0),
        durationMs: Math.max(0, Number(lyric.durationMs) || 0),
        at: Date.now(),
        controls: { previous: false, playPause: false, next: false, seek: false }
      };
    }
    return {
      v: 1,
      pluginEnabled: config.pluginEnabled !== false,
      lyric: lyric,
      players: env.players,
      playersReady: env.playersReady,
      playersNote: env.playersNote || null,
      playerAction: env.playerAction,
      nowPlaying: Object.assign({}, nowPlaying, {action:env.mediaAction}),
      online: env.online ? env.online.status() : null,
      bilibili: env.engine ? env.engine.bilibiliStatus() : null,
      error: env.error
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
  env.online = createOnlineLyrics({ logger: logger.child('online'), getConfig: getConfig });
  try { env.online.prune(); } catch (e) { logger.debug('lyrics cache prune failed: ' + (e && e.message)); }
  const engine = createEngine({
    kugouTimeline: kugouTimeline,
    logger: logger.child('engine'),
    getConfig: getConfig,
    online: env.online,
    getSessionMedia: function () {
      return currentMedia();
    },
    onChange: function () { try { bridge.push(snapshot()); } catch (e) { /* ignore */ } },
    onLine: function () { /* 行变化已通过 onChange 推快照 */ }
  });
  env.engine = engine;
  env.audioReactive = createAudioReactive({onChange:function (summary) { bridge.pushAudio(summary); }});
  function updateAudioDemand() {
    const now = env.mediaSession && env.mediaSession.snapshot();
    env.audioReactive.setActive(!env.stopping && bridge.audioWanted() && getConfig().pluginEnabled !== false && !!(now && now.ready && !now.error && now.media && now.media.playing));
  }
  let lastAutoScanAt = 0;
  let mediaActivityKey = '';
  function maybeAutoScanPlayers() {
    const now = env.mediaSession && env.mediaSession.snapshot();
    const media = now && now.media;
    if (!media || !media.id) return;
    if (/chrome|edge|firefox|brave|opera|vivaldi|webview/i.test(media.id)) return;
    if (String(media.id).indexOf('lyric:') === 0) return;
    for (let i = 0; i < env.players.length; i++) {
      if (playersMod && playersMod.sessionMatchesPlayer(media.id, env.players[i])) return;
    }
    if (Date.now() - lastAutoScanAt < 60000) return;
    lastAutoScanAt = Date.now();
    logger.info('players: 发现未登记的播放器 ' + media.id + '，自动重新扫描列表');
    refreshPlayers(true);
  }
  env.mediaSession = createMediaSession({onChange:function () {
    const now = env.mediaSession && env.mediaSession.snapshot();
    const media = now && now.media;
    const activityKey = media ? [media.id, media.key, media.playing ? 1 : 0].join('|') : '';
    /* 时间轴通知很频繁，只有切歌或播放状态变化才算真实活动。 */
    if (activityKey !== mediaActivityKey) {
      mediaActivityKey = activityKey;
      if (env.resetIdle) env.resetIdle();
    }
    bridge.push(snapshot());
    updateAudioDemand();
    maybeAutoScanPlayers();
  }});
  function handleUplink(msg, wc) {
    const wcId = wc && wc.id;
    switch (msg && msg.t) {
      case 'audioView':
        updateAudioDemand();
        break;
      case 'media':
        if (msg.media && typeof msg.media === 'object') engine.ingestMedia(msg.media);
        break;
      case 'delivery':
        env.delivery = msg;
        logger.info('device ' + msg.phase + ' [' + (msg.source || '') + '] ' + (msg.text || msg.error || ''));
        try { stateMod.atomicWriteJson(path.join(stateMod.paths.DATA_DIR, 'delivery.json'), msg); } catch (_) {}
        break;
      case 'ready':
        logger.info('page ready (wc=' + wcId + ', url=' + String(wc && wc.getURL && wc.getURL()).slice(0, 120) + ')');
        bridge.pushForced();
        break;
      case 'toggle': {
        const want = typeof msg.on === 'boolean' ? msg.on : !(getConfig().lyricEnabled !== false);
        engine.setLyricEnabled(want);
        logger.info('toggle -> lyricEnabled=' + want + ' (wc=' + wcId + ')');
        bridge.pushForced();
        break;
      }
      case 'online': {
        const online = getConfig().online || {};
        const want = typeof msg.on === 'boolean' ? msg.on : online.enabled === false;
        engine.setOnlineEnabled(want);
        logger.info('online lyrics -> ' + want + ' (wc=' + wcId + ')');
        bridge.pushForced();
        break;
      }
      case 'clearLyricsCache': {
        const result = env.online ? env.online.clearCache() : { ok: false, removed: 0 };
        logger.info('clear lyric cache -> ' + (result.removed || 0) + ' files');
        bridge.pushForced();
        break;
      }
      case 'biliOpen': {
        const st = engine.bilibiliStatus ? engine.bilibiliStatus() : null;
        const bvid = st && st.bvid ? String(st.bvid) : '';
        if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) { logger.warn('bili open: no bvid'); break; }
        try {
          const media = env.mediaSession && env.mediaSession.snapshot ? env.mediaSession.snapshot().media : null;
          if (media && media.controls && media.controls.playPause && st && st.playing && !st.web) {
            env.mediaSession.command({ sessionId: media.id, trackKey: media.key, action: 'pause' }).catch(function () {});
          }
        } catch (e) { /* ignore */ }
        try { electron.shell.openExternal('https://www.bilibili.com/video/' + bvid); logger.info('bili open -> ' + bvid); }
        catch (e) { logger.warn('bili open failed: ' + (e && e.message)); }
        break;
      }
      case 'biliLogin': {
        bilibili.loginViaBrowser().then(function (r) {
          logger.info('bili login -> ' + (r && r.ok ? 'ok' : String(r && r.error || 'failed')));
          env.biliLogin = r || null;
          bridge.pushForced();
        }).catch(function (e) {
          logger.warn('bili login threw: ' + (e && e.message));
          bridge.pushForced();
        });
        break;
      }
      case 'launch':
        launchPlayer(msg.id, wcId);
        break;
      case 'refreshPlayers':
        refreshPlayers(true);
        break;
      case 'mediaControl':
        controlMedia(msg);
        break;
      case 'error':
        logger.warn('page error: ' + JSON.stringify(msg).slice(0, 400));
        env.error = { code: 'PAGE_ERROR', message: String(msg.message || msg.where || '').slice(0, 300), at: Date.now() };
        break;
      default:
        logger.warn('unknown uplink: ' + JSON.stringify(msg).slice(0, 300));
    }
  }
  function controlMedia(msg) {
    if (!env.mediaSession || env.mediaAction && env.mediaAction.phase === 'pending') return;
    env.mediaAction = {phase:'pending',action:msg.action,trackKey:msg.trackKey,at:Date.now()};
    bridge.pushForced();
    env.mediaSession.command(msg).then(function(result) {
      env.mediaAction = {phase:result.ok ? 'success' : 'error',action:msg.action,trackKey:msg.trackKey,
        message:result.ok ? '' : '操作未完成，请重试或在播放器中操作',at:Date.now()};
      logger.info('media control ' + msg.action + ' -> ' + (result.ok ? 'success' : result.error));
      bridge.pushForced();
    }).catch(function(err) {
      env.mediaAction = {phase:'error',message:'播放器连接中断，请重试',at:Date.now()};
      logger.warn('media control failed: '+err.message); bridge.pushForced();
    });
  }
  function launchPlayer(id, wcId) {
    if (!playersMod) { logger.warn('launch ' + id + ': players module unavailable'); return; }
    env.playerAction = { id: id, phase: 'launching', at: Date.now() };
    bridge.pushForced();
    Promise.resolve()
      .then(function () { return playersMod.launch(id); })
      .then(function (r) {
        env.playerAction = { id: id, phase: r && r.ok ? (r.warning ? 'error' : 'success') : 'error', message: r && r.ok ? (r.warning ? '播放器已运行，请从任务栏打开窗口' : '') : '启动失败，请重试或从桌面打开播放器', at: Date.now() };
        bridge.pushForced();
        logger.info('launch ' + id + ' (wc=' + wcId + ') -> ' + JSON.stringify(r).slice(0, 400));
        setTimeout(function () { refreshPlayers(true); }, 3000);
        return r;
      })
      .catch(function (e) { env.playerAction = { id: id, phase: 'error', message: '启动失败，请重试', at: Date.now() }; bridge.pushForced(); logger.warn('launch ' + id + ' failed: ' + (e && e.message)); });
  }
  function applyIcons(list) {
    let changed = false;
    for (let i = 0; i < list.length; i++) {
      const icon = env.iconCache.get(list[i].id);
      if (icon && list[i].icon !== icon) { list[i].icon = icon; changed = true; }
    }
    return changed;
  }
  function refreshPlayers(force) {
    if (!playersMod || env.playersBusy) return Promise.resolve(null);
    const config = getConfig();
    if (!config.players || config.players.enabled === false) return Promise.resolve(null);
    const ttl = (config.players.refreshMs > 0 ? config.players.refreshMs : PLAYERS_REFRESH_MS);
    if (!force && env.players.length && Date.now() - env.playersAt < ttl) return Promise.resolve(env.players);
    const prevIds = env.players.map(function (p) { return p.id; });
    const prevRunningIds = env.players.filter(function (p) { return p.running; }).map(function (p) { return p.id; });
    env.playersBusy = true;
    return Promise.resolve()
      .then(function () { return playersMod.scanPlayers({ force: !!force }); })
      .then(function (r) {
        env.playersBusy = false;
        if (!r || !r.ok) { setError('PLAYERS_SCAN_FAILED', r && r.error); return null; }
        const list = [];
        for (let i = 0; i < r.players.length; i++) {
          const p = r.players[i];
          list.push({ id: p.id, name: p.name, running: !!p.running, icon: env.iconCache.get(p.id) || '', exe: p.exe });
        }
        env.players = list;
        env.playersReady = true;
        env.playersAt = Date.now();
        env.playersNote = {
          at: Date.now(),
          count: list.length,
          added: list.filter(function (p) { return prevIds.indexOf(p.id) === -1; }).length
        };
        logger.info('players: ' + list.length + ' 个 (' + list.map(function (p) { return p.id + (p.running ? '*' : ''); }).join(',') + ')');
        /* 新播放器或新启动的进程才唤醒，持续运行本身不反复重置休眠。 */
        if ((env.resetIdle) && (list.length > prevIds.length || list.some(function (p) { return p.running && prevRunningIds.indexOf(p.id) === -1; }))) {
          env.resetIdle();
          logger.debug('player activity detected, waking from idle mode');
        }
        bridge.pushForced();
        primeIcons();
        return list;
      })
      .catch(function (e) {
        env.playersBusy = false;
        setError('PLAYERS_SCAN_THREW', e);
        return null;
      });
  }
  function primeIcons() {
    if (!playersMod || !env.players.length) return Promise.resolve(null);
    const ids = env.players.map(function (p) { return p.id; });
    let chain = Promise.resolve();
    ids.forEach(function (id) {
      chain = chain.then(function () {
        if (env.iconCache.has(id)) return null;
        return Promise.resolve()
          .then(function () { return playersMod.getIcon(id); })
          .then(function (ic) {
            if (ic && ic.ok && ic.dataUrl) {
              env.iconCache.set(id, ic.dataUrl);
              let hit = false;
              for (let i = 0; i < env.players.length; i++) {
                if (env.players[i].id === id) { env.players[i].icon = ic.dataUrl; hit = true; }
              }
              if (hit) bridge.pushForced();
              logger.info('icon ' + id + ' ' + Math.round(ic.dataUrl.length / 1024) + 'KB fromCache=' + !!ic.fromCache);
            } else if (ic && ic.error) {
              logger.debug('icon ' + id + ' failed: ' + JSON.stringify(ic.error).slice(0, 200));
            }
            return null;
          })
          .catch(function (e) { logger.debug('icon ' + id + ' threw: ' + (e && e.message)); return null; });
      });
    });
    return chain;
  }
  function refreshRunning() {
    if (!playersMod || env.runningBusy || !env.players.length) return;
    env.runningBusy = true;
    playersMod.refreshRunning(env.players.map(p => p.id)).then(function (result) {
      if (!result || !result.ok) return;
      let changed = false;
      let started = false;
      env.players.forEach(function (p) {
        const running = !!(result.states[p.id] && result.states[p.id].running);
        if (p.running !== running) { p.running = running; changed = true; started = started || running; }
      });
      if (started && env.resetIdle) env.resetIdle();
      if (changed) bridge.pushForced();
    }).catch(function () {}).finally(function () { env.runningBusy = false; });
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
  function start() {
    logger.info('plugin ready v' + env.version + ' pid=' + process.pid + ' node=' + process.versions.node + ' electron=' + process.versions.electron + ' data=' + stateMod.paths.DATA_DIR);
    try { stateMod.writeStatus({ v: 1, pluginReady: true, version: env.version, startedAt: bootAt, players: [] }); }
    catch (e) { logger.warn('boot status write failed: ' + (e && e.message)); }
    kugouTimeline.start();
    mineradioUia.start();
    engine.start();
    bridge.start();
    env.mediaSession.start();
    env.idleSince = Date.now();
    electron.app.once('before-quit', function () { env.stopping = true; env.timers.forEach(function (h) { if (typeof h === 'number') clearInterval(h); else if (h) clearTimeout(h); }); clearTimeout(env.iconTimer); env.audioReactive.stop(); env.mediaSession.stop(); engine.stop(); kugouTimeline.stop(); mineradioUia.stop(); });
    refreshPlayers(false);

    /* 动态间隔调度：根据 idle 状态决定频率，零播放器时 CPU 占用降一个量级 */
    function isIdle() {
      return Date.now() - env.idleSince > ACTIVITY_IDLE_THRESHOLD_MS;
    }
    function resetIdle() { env.idleSince = Date.now(); }
    env.resetIdle = resetIdle;

    function schedulePlayersRefresh() {
      if (env.stopping) return;
      var ms = isIdle() ? PLAYERS_REFRESH_IDLE_MS : PLAYERS_REFRESH_MS;
      var t = setTimeout(function () {
        refreshPlayers(false).then(function () { schedulePlayersRefresh(); });
      }, ms);
      if (typeof t.unref === 'function') t.unref();
    }
    schedulePlayersRefresh();

    function scheduleRunningRefresh() {
      if (env.stopping) return;
      var ms = isIdle() ? RUNNING_REFRESH_IDLE_MS : RUNNING_REFRESH_MS;
      var t = setTimeout(function () {
        safe(refreshRunning, 'players running')();
        scheduleRunningRefresh();
      }, ms);
      if (typeof t.unref === 'function') t.unref();
    }
    scheduleRunningRefresh();

    function scheduleAudioDemand() {
      if (env.stopping) return;
      var ms = isIdle() ? 10000 : 1000;   /* 休眠时 10s 查一次 */
      var t = setTimeout(function () {
        safe(updateAudioDemand, 'audio demand')();
        scheduleAudioDemand();
      }, ms);
      if (typeof t.unref === 'function') t.unref();
    }
    scheduleAudioDemand();

    /* 剪贴板 B 站链接扫描：休眠时停掉，活动时每 5s 扫一次 */
    function scheduleClipboardScan() {
      if (env.stopping) return;
      var idle = isIdle();
      var ms = idle ? 30000 : 5000;
      var t = setTimeout(function () {
        if (!idle) {
          var cb = electron.clipboard;
          if (cb && typeof cb.readText === 'function') {
            var text = cb.readText();
            if (text && text.length < 4000 && /bilibili\.com|BV[0-9A-Za-z]{10}/.test(text))
              bilibili.noteText(text);
          }
        }
        scheduleClipboardScan();
      }, ms);
      if (typeof t.unref === 'function') t.unref();
    }
    scheduleClipboardScan();

    env.iconTimer = setTimeout(safe(function () { refreshPlayers(false).then(function () { return primeIcons(); }); }, 'icon prime'), ICON_PRIME_DELAY_MS);
    if (env.iconTimer && env.iconTimer.unref) env.iconTimer.unref();
    logger.info('plugin ready: bridge+engine started');
    return env;
  }
  env.start = start;
  env.snapshot = snapshot;
  env.bridge = bridge;
  env.injector = injector;
  env.refreshPlayers = refreshPlayers;
  env.handleUplink = handleUplink;
  env.status = function () {
    return {
      version: env.version,
      startedAt: env.startedAt,
      uptimeMs: Date.now() - env.startedAt,
      bridge: bridge.status(),
      inject: injector.info(),
      engine: engine.status(),
      online: env.online ? env.online.status() : null,
      audio: env.audioReactive.snapshot(),
      players: env.players.map(function (p) { return { id: p.id, running: p.running, icon: !!p.icon }; }),
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
