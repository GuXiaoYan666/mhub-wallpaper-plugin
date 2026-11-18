'use strict';

// 键名表：把 GetAsyncKeyState 采到的虚拟键码翻成可读键名与鼠标键标签（供按键提示浮层使用），键名口径与差异见 docs/pet-growth-spec.md §5

const path = require('path');

const DEFAULT_INTERVAL_MS = 30;
const KEY_DOWN_BIT = 0x8000;

const KEY_LABELS = Object.freeze({
  0x08: 'Backspace',
  0x09: 'Tab',
  0x0d: 'Enter',
  0x10: 'Shift',
  0x11: 'Ctrl',
  0x12: 'Alt',
  0x14: 'Caps',
  0x1b: 'Esc',
  0x20: 'Space',
  0x21: 'PageUp',
  0x22: 'PageDown',
  0x23: 'End',
  0x24: 'Home',
  0x25: '←',
  0x26: '↑',
  0x27: '→',
  0x28: '↓',
  0x2e: 'Delete'
});

const MOUSE_LABELS = Object.freeze({
  0x01: '左键',
  0x02: '右键',
  0x04: '中键',
  0x05: '后退键',
  0x06: '前进键'
});

function isMouseVk(vk) {
  return Object.prototype.hasOwnProperty.call(MOUSE_LABELS, vk);
}

function labelForVk(vk) {
  if (!Number.isFinite(vk)) return null;
  const code = Math.trunc(vk);
  if (isMouseVk(code)) return MOUSE_LABELS[code];
  if (Object.prototype.hasOwnProperty.call(KEY_LABELS, code)) return KEY_LABELS[code];
  if (code >= 0x41 && code <= 0x5a) return String.fromCharCode(code);
  if (code >= 0x30 && code <= 0x39) return String.fromCharCode(code);
  if (code >= 0x70 && code <= 0x87) return 'F' + (code - 0x6f);
  return null;
}

function buildTrackedVks() {
  const vks = [];
  const seen = new Set();
  function push(vk) {
    if (seen.has(vk)) return;
    seen.add(vk);
    vks.push(vk);
  }
  for (let vk = 0x41; vk <= 0x5a; vk += 1) push(vk);
  for (let vk = 0x30; vk <= 0x39; vk += 1) push(vk);
  for (let vk = 0x70; vk <= 0x87; vk += 1) push(vk);
  Object.keys(KEY_LABELS).forEach((key) => push(Number(key)));
  Object.keys(MOUSE_LABELS).forEach((key) => push(Number(key)));
  return Object.freeze(vks);
}

const TRACKED_VKS = buildTrackedVks();

function defaultLoadKoffi() {
  const electron = require('electron');
  return require(path.join(electron.app.getAppPath(), 'node_modules', 'koffi'));
}

function defaultScreen() {
  return require('electron').screen;
}

module.exports.createInputWatcher = function createInputWatcher(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const deps = opts.deps && typeof opts.deps === 'object' ? opts.deps : {};
  const onKey = typeof opts.onKey === 'function' ? opts.onKey : null;
  const onMouseDown = typeof opts.onMouseDown === 'function' ? opts.onMouseDown : null;
  const onMouseMove = typeof opts.onMouseMove === 'function' ? opts.onMouseMove : null;
  const intervalMs = Number.isFinite(opts.intervalMs) && opts.intervalMs > 0 ? opts.intervalMs : DEFAULT_INTERVAL_MS;
  const loadKoffi = typeof deps.loadKoffi === 'function' ? deps.loadKoffi : defaultLoadKoffi;

  let api;
  let timer = null;
  let running = false;
  let pressed = Object.create(null);
  let lastPoint = null;

  function resolveApi() {
    if (api !== undefined) return api;
    try {
      const koffi = loadKoffi();
      if (!koffi || typeof koffi.load !== 'function') throw new Error('koffi load missing');
      const user32 = koffi.load('user32.dll');
      if (!user32 || typeof user32.func !== 'function') throw new Error('user32 func missing');
      const getAsyncKeyState = user32.func('int16 __stdcall GetAsyncKeyState(int)');
      if (typeof getAsyncKeyState !== 'function') throw new Error('GetAsyncKeyState missing');
      api = getAsyncKeyState;
    } catch {
      api = null;
    }
    return api;
  }

  function resolveScreen() {
    if (deps.screen && typeof deps.screen.getCursorScreenPoint === 'function') return deps.screen;
    try {
      return defaultScreen();
    } catch {
      return null;
    }
  }

  function readCursor() {
    const screen = resolveScreen();
    if (!screen || typeof screen.getCursorScreenPoint !== 'function') return null;
    const point = screen.getCursorScreenPoint();
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
    return { x: point.x, y: point.y };
  }

  function emitKey(vk, at) {
    const label = labelForVk(vk);
    if (!label) return;
    if (isMouseVk(vk)) {
      if (onMouseDown) onMouseDown(label, at);
      return;
    }
    if (onKey) onKey(label, at);
  }

  function sample() {
    const at = Date.now();
    for (let index = 0; index < TRACKED_VKS.length; index += 1) {
      const vk = TRACKED_VKS[index];
      const down = (api(vk) & KEY_DOWN_BIT) !== 0;
      const was = pressed[vk] === true;
      if (down === was) continue;
      if (!down) {
        delete pressed[vk];
        continue;
      }
      pressed[vk] = true;
      emitKey(vk, at);
    }
    const point = readCursor();
    if (!point) return;
    const previous = lastPoint;
    lastPoint = point;
    if (!previous || !onMouseMove) return;
    const dx = point.x - previous.x;
    const dy = point.y - previous.y;
    if (dx === 0 && dy === 0) return;
    onMouseMove(dx, dy);
  }

  function stop() {
    running = false;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    pressed = Object.create(null);
    lastPoint = null;
  }

  function tick() {
    timer = null;
    if (!running) return;
    try {
      sample();
    } catch {
      stop();
      api = null;
      return;
    }
    timer = setTimeout(tick, intervalMs);
  }

  function start() {
    if (running) return true;
    if (!resolveApi()) return false;
    running = true;
    pressed = Object.create(null);
    lastPoint = null;
    tick();
    return running;
  }

  function isAvailable() {
    return resolveApi() !== null;
  }

  return { start, stop, isAvailable };
};

module.exports.labelForVk = labelForVk;
module.exports.KEY_LABELS = KEY_LABELS;
module.exports.MOUSE_LABELS = MOUSE_LABELS;
module.exports.TRACKED_VKS = TRACKED_VKS;
module.exports.DEFAULT_INTERVAL_MS = DEFAULT_INTERVAL_MS;
