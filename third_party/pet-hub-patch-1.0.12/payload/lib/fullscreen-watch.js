'use strict';

const path = require('path');

const DEFAULT_INTERVAL_MS = 1500;
const TOLERANCE_PX = 4;
const MONITOR_DEFAULTTONEAREST = 2;
const CLASS_NAME_MAX = 256;
const MONITORINFO_FALLBACK_SIZE = 40;
const EXCLUDED_CLASSES = new Set([
  'Progman',
  'WorkerW',
  'Shell_TrayWnd',
  'Shell_SecondaryTrayWnd',
]);

let structSeq = 0;

function defaultLoadKoffi() {
  const electron = require('electron');
  return require(path.join(electron.app.getAppPath(), 'node_modules', 'koffi'));
}

function toNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return 0;
}

function normalizeInterval(value) {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_INTERVAL_MS;
  return Math.max(1, Math.round(value));
}

function errorKey(err) {
  if (err && typeof err.message === 'string' && err.message) return err.message;
  return String(err);
}

module.exports.createFullscreenWatch = function createFullscreenWatch(opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const intervalMs = normalizeInterval(options.intervalMs);
  const loadKoffi = typeof options.loadKoffi === 'function' ? options.loadKoffi : defaultLoadKoffi;
  const logWarn = (() => {
    const log = options.log;
    if (log && typeof log.warn === 'function') return (line) => log.warn(line);
    if (typeof log === 'function') return (line) => log(line);
    return null;
  })();

  const warned = new Set();
  let api;
  let timer = null;
  let forced;
  let forcedSince = 0;
  let active = false;
  let since = 0;
  let hwnd = 0;

  function warn(scope, err) {
    const key = scope + ': ' + errorKey(err);
    if (warned.has(key)) return;
    warned.add(key);
    if (!logWarn) return;
    try {
      logWarn('[fullscreen-watch] ' + key);
    } catch {
      /* a broken logger must never reach the caller */
    }
  }

  function resolveApi() {
    if (api !== undefined) return api;
    api = null;
    if (process.platform !== 'win32') {
      warn('platform', new Error('unsupported platform: ' + process.platform));
      return api;
    }
    try {
      const koffi = loadKoffi();
      if (!koffi || typeof koffi.load !== 'function') throw new Error('koffi load missing');
      if (typeof koffi.struct !== 'function') throw new Error('koffi struct missing');
      structSeq += 1;
      const tag = '_FSW' + structSeq;
      const RECT = koffi.struct('RECT' + tag, {
        left: 'int32',
        top: 'int32',
        right: 'int32',
        bottom: 'int32',
      });
      const MONITORINFO = koffi.struct('MONITORINFO' + tag, {
        cbSize: 'uint32',
        rcMonitor: RECT,
        rcWork: RECT,
        dwFlags: 'uint32',
      });
      const user32 = koffi.load('user32.dll');
      if (!user32 || typeof user32.func !== 'function') throw new Error('user32 func missing');
      const pick = (signature) => {
        const fn = user32.func(signature);
        if (typeof fn !== 'function') throw new Error('user32 function missing: ' + signature);
        return fn;
      };
      const getForegroundWindow = pick('uint64 __stdcall GetForegroundWindow(void)');
      const getWindowRect = pick('int32 __stdcall GetWindowRect(uint64 hwnd, RECT' + tag + ' *rect)');
      const monitorFromWindow = pick('uint64 __stdcall MonitorFromWindow(uint64 hwnd, uint32 flags)');
      const getMonitorInfo = pick(
        'int32 __stdcall GetMonitorInfoW(uint64 hmonitor, MONITORINFO' + tag + ' *info)'
      );
      const getClassName = pick('int32 __stdcall GetClassNameW(uint64 hwnd, uint16 *name, int32 maxCount)');
      const isIconic = pick('int32 __stdcall IsIconic(uint64 hwnd)');
      const size = typeof koffi.sizeof === 'function' ? toNumber(koffi.sizeof(MONITORINFO)) : 0;
      // koffi does not write struct pointers back into JS objects (verified on koffi 2.9.2:
      // GetWindowRect through a plain object leaves it all zeros), so output must go through
      // koffi.alloc/encode/decode. Without those the probe would silently read zeros and
      // report a bogus fullscreen, so treat their absence as unsupported.
      const alloc = koffi.alloc;
      const encode = koffi.encode;
      const decode = koffi.decode;
      const free = koffi.free;
      if (typeof alloc !== 'function' || typeof decode !== 'function') {
        throw new Error('koffi alloc/decode missing');
      }
      if (typeof encode !== 'function' || typeof free !== 'function') {
        throw new Error('koffi encode/free missing');
      }
      api = {
        RECT,
        MONITORINFO,
        monitorInfoSize: size > 0 ? size : MONITORINFO_FALLBACK_SIZE,
        alloc,
        encode,
        decode,
        free,
        getForegroundWindow,
        getWindowRect,
        monitorFromWindow,
        getMonitorInfo,
        getClassName,
        isIconic,
      };
    } catch (err) {
      api = null;
      warn('load', err);
    }
    return api;
  }

  function readClassName(entry, target) {
    const buffer = new Uint16Array(CLASS_NAME_MAX);
    const written = toNumber(entry.getClassName(target, buffer, CLASS_NAME_MAX));
    if (written <= 0) return '';
    let end = Math.min(written, CLASS_NAME_MAX);
    while (end > 0 && buffer[end - 1] === 0) end -= 1;
    let text = '';
    for (let i = 0; i < end; i += 1) text += String.fromCharCode(buffer[i]);
    return text;
  }

  function releaseBuffer(entry, buffer) {
    if (!buffer) return;
    try {
      entry.free(buffer);
    } catch (err) {
      warn('free', err);
    }
  }

  function readRect(entry, target) {
    const buffer = entry.alloc(entry.RECT, 1);
    try {
      if (!toNumber(entry.getWindowRect(target, buffer))) throw new Error('GetWindowRect failed');
      const rect = entry.decode(buffer, entry.RECT);
      if (!rect) throw new Error('GetWindowRect decode failed');
      return rect;
    } finally {
      releaseBuffer(entry, buffer);
    }
  }

  function readMonitorRect(entry, target) {
    const monitor = toNumber(entry.monitorFromWindow(target, MONITOR_DEFAULTTONEAREST));
    if (monitor === 0) throw new Error('MonitorFromWindow returned NULL');
    const buffer = entry.alloc(entry.MONITORINFO, 1);
    try {
      entry.encode(buffer, entry.MONITORINFO, {
        cbSize: entry.monitorInfoSize,
        rcMonitor: { left: 0, top: 0, right: 0, bottom: 0 },
        rcWork: { left: 0, top: 0, right: 0, bottom: 0 },
        dwFlags: 0,
      });
      if (!toNumber(entry.getMonitorInfo(monitor, buffer))) throw new Error('GetMonitorInfoW failed');
      const info = entry.decode(buffer, entry.MONITORINFO);
      if (!info || !info.rcMonitor) throw new Error('GetMonitorInfoW decode failed');
      return info.rcMonitor;
    } finally {
      releaseBuffer(entry, buffer);
    }
  }

  function probe() {
    const entry = resolveApi();
    if (!entry) return { active: false, hwnd: 0 };
    let target = 0;
    try {
      target = toNumber(entry.getForegroundWindow());
      if (target === 0) return { active: false, hwnd: 0 };
      if (toNumber(entry.isIconic(target)) !== 0) return { active: false, hwnd: target };
      if (EXCLUDED_CLASSES.has(readClassName(entry, target))) return { active: false, hwnd: target };

      const rect = readRect(entry, target);
      const mon = readMonitorRect(entry, target);
      // Win32 rects are physical pixels; both sides of this comparison live in that space,
      // so the result is independent of the machine's DPI scale factor.
      const covers =
        toNumber(rect.left) <= toNumber(mon.left) + TOLERANCE_PX &&
        toNumber(rect.top) <= toNumber(mon.top) + TOLERANCE_PX &&
        toNumber(rect.right) >= toNumber(mon.right) - TOLERANCE_PX &&
        toNumber(rect.bottom) >= toNumber(mon.bottom) - TOLERANCE_PX;
      return { active: covers === true, hwnd: target };
    } catch (err) {
      warn('probe', err);
      return { active: false, hwnd: target };
    }
  }

  function applyActive(next) {
    if (next === active) return;
    active = next;
    since = next ? Date.now() : 0;
  }

  function tick() {
    const result = probe();
    hwnd = result.hwnd;
    applyActive(result.active);
  }

  function isFullscreen() {
    return forced === undefined ? active : forced;
  }

  function state() {
    const resolved = resolveApi();
    const currentSince = forced === undefined ? since : forcedSince;
    return Object.freeze({
      active: isFullscreen(),
      since: currentSince,
      hwnd,
      supported: resolved !== null,
    });
  }

  function force(value) {
    if (value === true || value === false) {
      forced = value;
      forcedSince = value ? Date.now() : 0;
      return;
    }
    forced = undefined;
    forcedSince = 0;
  }

  function start() {
    if (timer) return;
    if (forced === undefined && String(process.env.PET_FORCE_FULLSCREEN || '') === '1') force(true);
    if (!resolveApi()) return;
    tick();
    timer = setInterval(tick, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    active = false;
    since = 0;
    hwnd = 0;
  }

  return { start, stop, isFullscreen, force, state };
};
