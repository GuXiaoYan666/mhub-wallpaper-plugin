'use strict';

const path = require('path');

// The inline page starts where the host content area starts: the top-level frame's first
// <iframe> is that anchor, so a measured offset always wins over this fallback.
const FALLBACK_HEADER_DIP = 80;
const HEADER_MIN_DIP = 56;
const HEADER_MAX_DIP = 140;
// Same renderer wiring the standalone settings window used: nodeIntegration on, no isolation,
// no sandbox, no preload (the settings page requires('electron') directly).
const DEFAULT_WEB_PREFERENCES = Object.freeze({
  nodeIntegration: true,
  contextIsolation: false,
  sandbox: false
});
const HIDE_EVENTS = ['hide', 'minimize'];
const SHOW_EVENTS = ['show', 'restore'];
const RELAYOUT_EVENTS = ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'];
const NAVIGATE_EVENTS = ['did-navigate', 'did-navigate-in-page'];
const SETTLE_MEASURE_MS = 300;
// The settings page is a local file loaded with nodeIntegration on, so its webContents must never
// be talked into navigating anywhere else: one remote page in there would run with Node access.
const LOCAL_NAVIGATION_PROTOCOLS = ['file:', 'about:'];
const EXTERNAL_PROTOCOLS = ['http:', 'https:'];

function clampHeaderDip(value, maxDip) {
  const ceiling = Number.isFinite(maxDip) && maxDip > HEADER_MAX_DIP ? Math.round(maxDip) : HEADER_MAX_DIP;
  if (!Number.isFinite(value)) return FALLBACK_HEADER_DIP;
  if (value < HEADER_MIN_DIP) return HEADER_MIN_DIP;
  if (value > ceiling) return ceiling;
  return Math.round(value);
}

// The host chrome is real DOM (its tab row), so a scaled or high-DPI host can push it past the
// fixed HEADER_MAX_DIP ceiling. Relaxing the ceiling to 60% of the content height keeps the
// measured anchor honest while always leaving at least 40% of the area to the page itself: the
// per-monitor 150% case scaled 140 DIP of chrome to about 210 CSS px, and clamping that back to
// 140 would have covered the host's tab row by the difference.
function ceilingDipFor(contentHeight) {
  const height = Number.isFinite(contentHeight) && contentHeight > 0 ? contentHeight : 0;
  if (height <= 0) return HEADER_MAX_DIP;
  return Math.max(HEADER_MAX_DIP, Math.round(height * 0.6));
}

function normalizeMeasure(value) {
  if (!value || typeof value !== 'object') return null;
  if (!Number.isFinite(value.top)) return null;
  return {
    top: value.top,
    width: Number.isFinite(value.width) && value.width > 0 ? value.width : 0
  };
}

function headerDipOf(measure, contentWidth, contentHeight) {
  const source = normalizeMeasure(measure);
  if (!source) return FALLBACK_HEADER_DIP;
  const areaWidth = Number.isFinite(contentWidth) && contentWidth > 0 ? contentWidth : 0;
  const scale = source.width > 0 && areaWidth > 0 ? areaWidth / source.width : 1;
  return clampHeaderDip(source.top * scale, ceilingDipFor(contentHeight));
}

function computeBounds(contentBounds, headerDip) {
  const area = contentBounds && typeof contentBounds === 'object' ? contentBounds : {};
  const width = Number.isFinite(area.width) ? Math.max(0, Math.round(area.width)) : 0;
  const height = Number.isFinite(area.height) ? Math.max(0, Math.round(area.height)) : 0;
  const header = clampHeaderDip(headerDip, ceilingDipFor(height));
  return { x: 0, y: header, width, height: Math.max(0, height - header) };
}

function sameBounds(a, b) {
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

// The pathname of a file: URL is /C:/... on Windows, and a decoded '..' segment would let a
// crafted URL look like it sits inside the settings directory, so those are refused outright.
function fileUrlToFsPath(fileUrl) {
  let raw = '';
  try {
    raw = decodeURIComponent(new URL(fileUrl).pathname);
  } catch (err) {
    return '';
  }
  if (raw.indexOf('\u0000') >= 0) return '';
  if (/(^|[\\/])\.\.([\\/]|$)/.test(raw)) return '';
  if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(raw)) raw = raw.slice(1);
  const normal = path.normalize(raw);
  return process.platform === 'win32' ? normal.toLowerCase() : normal;
}

function normalizeRootDir(rootDir) {
  const text = typeof rootDir === 'string' ? rootDir : '';
  if (!text) return '';
  const normal = path.normalize(text);
  return process.platform === 'win32' ? normal.toLowerCase() : normal;
}

// Only the settings directory itself and about:blank stay in this webContents. Everything else
// is a refusal, and a real http(s) address is handed to the OS browser instead of being loaded.
function isSettingsNavigationAllowed(rawUrl, rootDir) {
  const text = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!text) return false;
  let parsed = null;
  try {
    parsed = new URL(text);
  } catch (err) {
    return false;
  }
  if (LOCAL_NAVIGATION_PROTOCOLS.indexOf(parsed.protocol) < 0) return false;
  if (parsed.protocol === 'about:') return parsed.href === 'about:blank' || parsed.pathname === 'blank';
  const root = normalizeRootDir(rootDir);
  if (!root) return false;
  const target = fileUrlToFsPath(text);
  if (!target) return false;
  if (target === root) return true;
  const withSeparator = root.slice(-1) === path.sep ? root : root + path.sep;
  return target.indexOf(withSeparator) === 0;
}

// Only a real http(s) URL may reach shell.openExternal, which would otherwise happily launch
// file: or a registered protocol handler on behalf of whatever the page asked for.
function safeExternalUrl(rawUrl) {
  const text = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!text) return '';
  let parsed = null;
  try {
    parsed = new URL(text);
  } catch (err) {
    return '';
  }
  if (EXTERNAL_PROTOCOLS.indexOf(parsed.protocol) < 0) return '';
  if (!parsed.host) return '';
  return parsed.href;
}

function createPageView(ctx) {
  const config = ctx || {};
  const electron = config.electron || {};
  const logger = config.logger || null;
  const htmlPath = config.htmlPath || path.join(__dirname, '..', 'renderer', 'settings', 'index.html');
  const preloadPath = typeof config.preloadPath === 'string' && config.preloadPath ? config.preloadPath : null;
  const setTimer = typeof config.setTimeout === 'function' ? config.setTimeout : (handler, ms) => setTimeout(handler, ms);
  const clearTimer = typeof config.clearTimeout === 'function' ? config.clearTimeout : (timer) => clearTimeout(timer);
  const webPreferences = Object.assign({}, DEFAULT_WEB_PREFERENCES, config.webPreferences || {});
  if (preloadPath) webPreferences.preload = preloadPath;
  const settingsDir = path.dirname(htmlPath);
  const openExternal = typeof config.openExternal === 'function'
    ? config.openExternal
    : (electron.shell && typeof electron.shell.openExternal === 'function'
      ? (url) => electron.shell.openExternal(url)
      : null);

  let view = null;
  let host = null;
  let bindings = [];
  let opened = false;
  let attached = false;
  let visible = false;
  let headerDip = null;
  // One anchor line is logged at info per attach: debug output is filtered unless PET_HUB_DEBUG is
  // set, and the anchor is the number a misplaced page needs, so it must survive the default level.
  let anchorAnnounced = false;
  let appliedBounds = null;
  let measureToken = 0;
  let measuring = false;
  let measurePending = false;
  let boundContents = null;
  let contentsBindings = [];
  let disposed = false;
  let bridge = null;
  let settleTimer = null;

  function log(level, message, error) {
    if (!logger) return;
    try {
      const sink = logger[level] || logger.info;
      if (typeof sink === 'function') sink.call(logger, '[page-view] ' + message, error);
    } catch (err) {
      return;
    }
  }

  function contentsOf(target) {
    try {
      return target && target.webContents ? target.webContents : null;
    } catch (err) {
      return null;
    }
  }

  function isContentsDead(contents) {
    if (!contents) return true;
    try {
      return typeof contents.isDestroyed === 'function' && contents.isDestroyed() === true;
    } catch (err) {
      return true;
    }
  }

  function isViewAlive(target) {
    return !!target && !isContentsDead(contentsOf(target));
  }

  function isValidHost(target) {
    if (!target || typeof target !== 'object') return false;
    try {
      if (typeof target.isDestroyed === 'function' && target.isDestroyed() === true) return false;
    } catch (err) {
      return false;
    }
    return true;
  }

  function resolveHost(hostWindow) {
    if (isValidHost(hostWindow)) return hostWindow;
    if (typeof config.resolveHostWindow !== 'function') return null;
    let resolved = null;
    try {
      resolved = config.resolveHostWindow();
    } catch (err) {
      log('warn', 'resolveHostWindow failed', err);
      return null;
    }
    return isValidHost(resolved) ? resolved : null;
  }

  function readContentBounds(target) {
    if (!target || typeof target.getContentBounds !== 'function') return null;
    try {
      const area = target.getContentBounds();
      if (!area || !Number.isFinite(area.width) || !Number.isFinite(area.height)) return null;
      return area;
    } catch (err) {
      log('warn', 'getContentBounds failed', err);
      return null;
    }
  }

  // An outside address is opened by the OS browser, and only when it really is http(s); a refused
  // target is reported instead of silently doing nothing.
  function openExternalSafely(rawUrl) {
    const target = safeExternalUrl(rawUrl);
    if (!target) {
      if (rawUrl) log('warn', 'refused to hand ' + String(rawUrl) + ' to the OS');
      return false;
    }
    if (typeof openExternal !== 'function') {
      log('warn', 'no shell.openExternal available for ' + target);
      return false;
    }
    try {
      const result = openExternal(target);
      if (result && typeof result.catch === 'function') {
        result.catch((err) => log('warn', 'openExternal failed: ' + target, err));
      }
      log('info', 'opened in the OS browser: ' + target);
      return true;
    } catch (err) {
      log('warn', 'openExternal threw: ' + target, err);
      return false;
    }
  }

  // This webContents loads the settings page with nodeIntegration on and no isolation, so a
  // navigation away from it (or a window.open) would be a local Node surface driven by a remote
  // page. The same rule covers will-redirect, because a redirect can follow an allowed load.
  function guardNavigation(contents) {
    if (!contents) return;
    const onNavigate = (event, url) => {
      const target = typeof url === 'string' ? url : (event && typeof event.url === 'string' ? event.url : '');
      if (isSettingsNavigationAllowed(target, settingsDir)) return;
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      log('warn', 'blocked inline page navigation to ' + (target || '(empty)'));
      openExternalSafely(target);
    };
    if (typeof contents.on === 'function') {
      try {
        contents.on('will-navigate', onNavigate);
      } catch (err) {
        log('warn', 'bind will-navigate failed', err);
      }
      try {
        contents.on('will-redirect', onNavigate);
      } catch (err) {
        log('warn', 'bind will-redirect failed', err);
      }
    }
    if (typeof contents.setWindowOpenHandler === 'function') {
      try {
        contents.setWindowOpenHandler((details) => {
          const target = details && typeof details.url === 'string' ? details.url : '';
          log('warn', 'denied window.open from the inline page: ' + (target || '(empty)'));
          openExternalSafely(target);
          return { action: 'deny' };
        });
      } catch (err) {
        log('warn', 'bind setWindowOpenHandler failed', err);
      }
    }
  }

  function createView() {
    const View = electron.WebContentsView;
    if (typeof View !== 'function') {
      log('warn', 'WebContentsView unavailable, inline page view disabled');
      return null;
    }
    let created = null;
    try {
      created = new View({ webPreferences: Object.assign({}, webPreferences) });
    } catch (err) {
      log('error', 'create WebContentsView failed', err);
      return null;
    }
    view = created;
    const contents = contentsOf(created);
    if (contents && typeof contents.on === 'function') {
      try {
        contents.on('destroyed', () => {
          if (view !== created) return;
          view = null;
          attached = false;
          visible = false;
          headerDip = null;
          appliedBounds = null;
          log('info', 'page webContents destroyed');
        });
      } catch (err) {
        log('warn', 'bind webContents destroyed failed', err);
      }
    }
    guardNavigation(contents);
    if (contents && typeof contents.loadFile === 'function') {
      try {
        const loaded = contents.loadFile(htmlPath);
        if (loaded && typeof loaded.catch === 'function') {
          loaded.catch((err) => log('warn', 'loadFile failed: ' + htmlPath, err));
        }
      } catch (err) {
        log('warn', 'loadFile threw: ' + htmlPath, err);
      }
    }
    log('info', 'view created for ' + htmlPath);
    return created;
  }

  function unbindHost() {
    unbindHostContents();
    const target = host;
    const list = bindings;
    bindings = [];
    host = null;
    if (!target || list.length === 0) return false;
    if (typeof target.removeListener !== 'function') return false;
    for (let index = 0; index < list.length; index += 1) {
      try {
        target.removeListener(list[index][0], list[index][1]);
      } catch (err) {
        log('debug', 'unbind host listener failed', err);
      }
    }
    return true;
  }

  function bindHost(target) {
    unbindHost();
    host = target;
    if (!target || typeof target.on !== 'function') return false;
    const handlers = [];
    function on(event, handler) {
      try {
        target.on(event, handler);
        handlers.push([event, handler]);
      } catch (err) {
        log('warn', 'bind host ' + event + ' failed', err);
      }
    }
    on('closed', () => destroy('host closed'));
    for (let index = 0; index < HIDE_EVENTS.length; index += 1) {
      on(HIDE_EVENTS[index], () => setVisible(false));
    }
    for (let index = 0; index < SHOW_EVENTS.length; index += 1) {
      on(SHOW_EVENTS[index], () => setVisible(true));
    }
    for (let index = 0; index < RELAYOUT_EVENTS.length; index += 1) {
      on(RELAYOUT_EVENTS[index], () => fit());
    }
    bindings = handlers;
    bindHostContents(target);
    return handlers.length > 0;
  }

  function unbindHostContents() {
    const target = boundContents;
    const list = contentsBindings;
    contentsBindings = [];
    boundContents = null;
    if (!target || list.length === 0 || typeof target.removeListener !== 'function') return false;
    for (let index = 0; index < list.length; index += 1) {
      try {
        target.removeListener(list[index][0], list[index][1]);
      } catch (err) {
        log('debug', 'unbind host contents listener failed', err);
      }
    }
    return true;
  }

  function bindHostContents(target) {
    unbindHostContents();
    const contents = contentsOf(target);
    if (!contents || typeof contents.on !== 'function') return false;
    boundContents = contents;
    const handlers = [];
    for (let index = 0; index < NAVIGATE_EVENTS.length; index += 1) {
      const event = NAVIGATE_EVENTS[index];
      const handler = () => onHostNavigate(target);
      try {
        contents.on(event, handler);
        handlers.push([event, handler]);
      } catch (err) {
        log('warn', 'bind host contents ' + event + ' failed', err);
      }
    }
    contentsBindings = handlers;
    return handlers.length > 0;
  }

  // The inline page mirrors a host page, so any host navigation dismisses it: the host stays the
  // authority on what is on screen. Opening the page never navigates the host, so our own open()
  // cannot reach this path.
  function onHostNavigate(target) {
    if (disposed || !opened || host !== target) return false;
    log('info', 'closed on host navigation');
    return close();
  }

  function attachTo(target) {
    if (!view || !target) return false;
    const container = target.contentView;
    if (!container || typeof container.addChildView !== 'function') {
      log('warn', 'host contentView unavailable, page view not attached');
      return false;
    }
    if (attached) {
      if (host === target) return true;
      detach();
    }
    try {
      container.addChildView(view);
    } catch (err) {
      log('warn', 'addChildView failed', err);
      return false;
    }
    attached = true;
    host = target;
    anchorAnnounced = false;
    log('info', 'attached to host window');
    return true;
  }

  function detach() {
    if (!attached) return false;
    const target = host;
    attached = false;
    appliedBounds = null;
    if (target && target.contentView && typeof target.contentView.removeChildView === 'function') {
      try {
        target.contentView.removeChildView(view);
      } catch (err) {
        log('warn', 'removeChildView failed', err);
      }
    }
    log('info', 'detached from host window (view kept)');
    return true;
  }

  function applyBounds(bounds) {
    if (!view || !bounds) return false;
    if (sameBounds(appliedBounds, bounds)) return true;
    try {
      view.setBounds(bounds);
    } catch (err) {
      log('warn', 'setBounds failed', err);
      return false;
    }
    appliedBounds = bounds;
    return true;
  }

  function refit() {
    if (!view || !attached) return null;
    const area = readContentBounds(host);
    if (!area) return null;
    const bounds = computeBounds(area, headerDip === null ? FALLBACK_HEADER_DIP : headerDip);
    if (!applyBounds(bounds)) return null;
    return bounds;
  }

  // Every fit re-measures: the anchor is read out of the host page, so a route change, a resize
  // or a DPI change can all move it. Identical results are dropped by sameBounds().
  function fit() {
    const bounds = refit();
    if (bounds) requestMeasure(host);
    return bounds;
  }

  function setVisible(next) {
    const want = next === true;
    if (!view || !attached) {
      visible = false;
      return false;
    }
    visible = want;
    if (typeof view.setVisible === 'function') {
      try {
        view.setVisible(want);
        if (want) fit();
        return true;
      } catch (err) {
        log('warn', 'view.setVisible failed', err);
      }
    }
    const target = host;
    detach();
    if (want) {
      attachTo(target);
      fit();
    }
    return true;
  }

  function defaultMeasure(target) {
    const contents = contentsOf(target);
    if (!contents) return null;
    if (!bridge) {
      try {
        bridge = require('./page-entry.js');
      } catch (err) {
        log('warn', 'page-entry bridge unavailable for measuring', err);
        return null;
      }
    }
    if (typeof bridge.measureHostAnchor === 'function') return bridge.measureHostAnchor(contents);
    if (typeof bridge.measureContentTop === 'function') return bridge.measureContentTop(contents);
    if (typeof bridge.measureTabStripTop === 'function') return bridge.measureTabStripTop(contents);
    return null;
  }

  function remeasure(target) {
    const measure = typeof config.measureContentTop === 'function'
      ? config.measureContentTop
      : typeof config.measureTabStrip === 'function' ? config.measureTabStrip : defaultMeasure;
    measureToken += 1;
    const token = measureToken;
    let pending = null;
    try {
      pending = measure(target);
    } catch (err) {
      log('warn', 'content anchor measure failed', err);
      return Promise.resolve(null);
    }
    return Promise.resolve(pending).then((value) => {
      if (disposed || token !== measureToken || !opened || host !== target) return null;
      const area = readContentBounds(target);
      const next = headerDipOf(value, area ? area.width : 0, area ? area.height : 0);
      const scale = value && Number.isFinite(value.width) && area && area.width > 0 ? area.width / value.width : 1;
      const anchorPath = value && value.path === 'tabs' ? 'tabs' : 'bar';
      const detail = 'anchor ' + anchorPath + ' ' + next + ' DIP (raw top ' + (value && Number.isFinite(value.top) ? value.top : 'n/a') + ' CSS px, scale ' + scale + ')';
      if (!anchorAnnounced) {
        anchorAnnounced = true;
        log('info', detail);
      } else if (headerDip !== null && headerDip !== next) {
        log('info', 'anchor updated ' + headerDip + ' -> ' + next + ' DIP (' + anchorPath + ')');
      }
      log('debug', detail);
      if (headerDip === next) return next;
      headerDip = next;
      refit();
      return next;
    }).catch((err) => {
      log('debug', 'measure rejected', err);
      return null;
    });
  }

  // At most one measure round trip at a time; a fit that lands during one marks a single
  // follow-up round so a burst of resize events cannot queue up script executions.
  function requestMeasure(target) {
    const source = target || host;
    if (disposed || !opened || !source || !view || !attached) return false;
    if (measuring) {
      measurePending = true;
      return false;
    }
    measuring = true;
    remeasure(source).then(() => {
      measuring = false;
      if (measurePending && !disposed) {
        measurePending = false;
        requestMeasure(source);
      }
    }).catch(() => {
      measuring = false;
    });
    return true;
  }

  function focusView() {
    const contents = contentsOf(view);
    if (!contents || typeof contents.focus !== 'function') return false;
    try {
      contents.focus();
      return true;
    } catch (err) {
      log('debug', 'focus page failed', err);
      return false;
    }
  }

  function showHost(target) {
    if (typeof config.showHostWindow !== 'function') return false;
    try {
      config.showHostWindow(target);
      return true;
    } catch (err) {
      log('warn', 'showHostWindow failed', err);
      return false;
    }
  }

  function notifyShow(target) {
    if (typeof config.onShow !== 'function') return false;
    try {
      config.onShow(target);
      return true;
    } catch (err) {
      log('warn', 'onShow failed', err);
      return false;
    }
  }

  function clearSettle() {
    if (settleTimer === null) return false;
    const timer = settleTimer;
    settleTimer = null;
    try {
      clearTimer(timer);
    } catch (err) {
      log('debug', 'settle measure cancel failed', err);
    }
    return true;
  }

  // The host's tab row is real DOM and can finish rendering after the first measure round trip,
  // so one delayed re-measure picks up the settled anchor. Single shot by design: no interval and
  // no retry loop.
  function settleMeasure(target) {
    clearSettle();
    if (disposed || !opened || !target) return false;
    try {
      settleTimer = setTimer(() => {
        settleTimer = null;
        if (disposed || !opened || host !== target) return;
        requestMeasure(target);
      }, SETTLE_MEASURE_MS);
    } catch (err) {
      settleTimer = null;
      log('warn', 'settle measure timer failed', err);
      return false;
    }
    return true;
  }

  function open(hostWindow) {
    if (disposed) {
      log('warn', 'page view disposed, open ignored');
      return null;
    }
    const target = resolveHost(hostWindow);
    if (!target) {
      log('warn', 'no host window available, page view not opened');
      return null;
    }
    const container = target.contentView;
    if (!container || typeof container.addChildView !== 'function') {
      log('warn', 'host contentView unavailable, page view not opened');
      return null;
    }
    if (!isViewAlive(view)) {
      view = null;
      attached = false;
      visible = false;
      headerDip = null;
      appliedBounds = null;
      if (!createView()) return null;
    }
    if (attached && host && host !== target) detach();
    opened = true;
    bindHost(target);
    showHost(target);
    if (!attachTo(target)) {
      opened = false;
      return null;
    }
    setVisible(true);
    fit();
    settleMeasure(target);
    focusView();
    notifyShow(target);
    return view;
  }

  function close() {
    if (!view) return false;
    const wasAttached = attached;
    const wasOpen = opened;
    opened = false;
    visible = false;
    clearSettle();
    detach();
    if (wasOpen && typeof config.onClose === 'function') {
      try { config.onClose(host); } catch (err) { log('warn', 'onClose failed', err); }
    }
    log('info', 'closed, view kept for reuse');
    return wasAttached;
  }

  function toggle(hostWindow) {
    if (opened && attached) {
      close();
      return false;
    }
    return open(hostWindow) !== null;
  }

  function deliver(channel, payload) {
    const contents = contentsOf(view);
    if (isContentsDead(contents)) return false;
    try {
      contents.send(channel, payload);
      return true;
    } catch (err) {
      log('warn', 'send failed: ' + channel, err);
      return false;
    }
  }

  function send(channel, payload) {
    if (!view || !attached || !opened) return false;
    return deliver(channel, payload);
  }

  function broadcast(channel, payload) {
    return deliver(channel, payload);
  }

  function destroy(reason) {
    const target = view;
    close();
    detach();
    unbindHost();
    view = null;
    opened = false;
    visible = false;
    headerDip = null;
    appliedBounds = null;
    measuring = false;
    measurePending = false;
    measureToken += 1;
    clearSettle();
    if (!target) return false;
    const contents = contentsOf(target);
    if (!isContentsDead(contents)) {
      try {
        if (typeof contents.close === 'function') contents.close();
        else if (typeof contents.destroy === 'function') contents.destroy();
      } catch (err) {
        log('warn', 'close page webContents failed', err);
      }
    }
    log('info', 'page view destroyed (' + (reason || 'manual') + ')');
    return true;
  }

  function dispose() {
    if (disposed) return false;
    disposed = true;
    destroy('dispose');
    return true;
  }

  return {
    open,
    close,
    toggle,
    setVisible,
    isOpen: () => opened === true && isViewAlive(view),
    fit,
    send,
    broadcast,
    dispose,
    getView: () => (isViewAlive(view) ? view : null),
    getHostWindow: () => host,
    getHeaderDip: () => headerDip,
    getBounds: () => appliedBounds,
    getHtmlPath: () => htmlPath,
    getWebPreferences: () => Object.assign({}, webPreferences)
  };
}

module.exports = {
  FALLBACK_HEADER_DIP,
  HEADER_MIN_DIP,
  HEADER_MAX_DIP,
  SETTLE_MEASURE_MS,
  DEFAULT_WEB_PREFERENCES,
  clampHeaderDip,
  ceilingDipFor,
  normalizeMeasure,
  headerDipOf,
  computeBounds,
  isSettingsNavigationAllowed,
  safeExternalUrl,
  createPageView
};
