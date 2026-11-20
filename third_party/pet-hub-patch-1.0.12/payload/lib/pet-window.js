'use strict';

const path = require('path');

const BASE_WIDTH = 192;
const BASE_HEIGHT = 328;
const MARGIN = 24;
const SIZE_ANIM_MS = 180;
const SIZE_ANIM_FRAME_MS = 16;
const INERTIA_FRAME_MS = 16;
const INERTIA_FRICTION = 0.9;
const INERTIA_BOUNCE = -0.35;
const INERTIA_MIN_SPEED = 220;
const INERTIA_STOP_SPEED = 40;
const INERTIA_MAX_MS = 1200;
// A renderer bug or a throttled tab must not fling the pet across every display.
const INERTIA_MAX_INPUT = 4000;
const EDGE_SNAP = 8;
// A drag without a DRAG_MOVE/DRAG_END for this long is treated as abandoned (renderer crash, a
// swallowed mouseup, a window that stopped hearing the pointer) and closed out here.
const DRAG_WATCHDOG_MS = 3000;
// How much of the window has to stay on a display. Crossing displays is allowed, losing the pet
// behind a monitor is not.
const MIN_VISIBLE = 64;

function computeSize(scale) {
  const safe = Number.isFinite(scale) ? Math.min(150, Math.max(0, scale)) : 100;
  return {
    // Native windows require positive bounds. Zero scale hides the window below.
    width: Math.max(1, Math.round((BASE_WIDTH * safe) / 100)),
    height: Math.max(1, Math.round((BASE_HEIGHT * safe) / 100))
  };
}

// No work area means "this machine told us nothing about its screens", not "pretend 1280x720":
// the position is passed through untouched so a later state push can place it for real.
function clampPosition(position, size, workArea) {
  const area = normalizeArea(workArea);
  const width = size && Number.isFinite(size.width) ? size.width : BASE_WIDTH;
  const height = size && Number.isFinite(size.height) ? size.height : BASE_HEIGHT;
  const rawX = position && Number.isFinite(position.x) ? Math.round(position.x) : null;
  const rawY = position && Number.isFinite(position.y) ? Math.round(position.y) : null;
  if (!area) return { x: rawX === null ? 0 : rawX, y: rawY === null ? 0 : rawY };
  const minX = area.x;
  const minY = area.y;
  const maxX = Math.max(minX, area.x + area.width - width);
  const maxY = Math.max(minY, area.y + area.height - height);
  return {
    x: Math.min(Math.max(rawX === null ? area.x : rawX, minX), maxX),
    y: Math.min(Math.max(rawY === null ? area.y : rawY, minY), maxY)
  };
}

function overlappingBox(rect, area) {
  const left = Math.max(rect.x, area.x);
  const top = Math.max(rect.y, area.y);
  const right = Math.min(rect.x + rect.width, area.x + area.width);
  const bottom = Math.min(rect.y + rect.height, area.y + area.height);
  return { width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

function hasMinVisible(rect, area, minVisible) {
  const box = overlappingBox(rect, area);
  const min = Number.isFinite(minVisible) ? minVisible : MIN_VISIBLE;
  return box.width >= min && box.height >= min;
}

// Soft clamp: any spot that still shows MIN_VISIBLE x MIN_VISIBLE of the window on one of the
// work areas is kept as-is (so dragging across displays stays possible); anything past that is
// pulled back onto the owning - else nearest - area, leaving exactly the minimum overlap.
function softClampPosition(position, size, workAreas, minVisible) {
  const areas = normalizeAreas(workAreas);
  const dims = normalizeSize(size);
  const min = Number.isFinite(minVisible) ? minVisible : MIN_VISIBLE;
  const raw = {
    x: position && Number.isFinite(position.x) ? Math.round(position.x) : 0,
    y: position && Number.isFinite(position.y) ? Math.round(position.y) : 0
  };
  if (areas.length === 0) return raw;
  const rect = { x: raw.x, y: raw.y, width: dims.width, height: dims.height };
  for (let index = 0; index < areas.length; index += 1) {
    if (hasMinVisible(rect, areas[index], min)) return raw;
  }
  const area = pickOwnerArea(rect, areas) || pickNearestArea(rect, areas);
  if (!area) return raw;
  const lowX = area.x - dims.width + min;
  const highX = area.x + area.width - min;
  const lowY = area.y - dims.height + min;
  const highY = area.y + area.height - min;
  return {
    x: Math.round(Math.min(Math.max(raw.x, Math.min(lowX, highX)), Math.max(lowX, highX))),
    y: Math.round(Math.min(Math.max(raw.y, Math.min(lowY, highY)), Math.max(lowY, highY)))
  };
}

// Bubbles flip near the window's own edges, so the renderer needs to know which one is near.
// Distance is signed on purpose: a window parked slightly outside the work area still reads as
// that edge instead of "none".
function edgeOf(rect, area) {
  if (!rect || !area) return 'none';
  const gapTop = rect.y - area.y;
  const gapLeft = rect.x - area.x;
  const gapRight = area.x + area.width - (rect.x + rect.width);
  if (gapTop <= EDGE_SNAP) return 'top';
  if (gapLeft <= EDGE_SNAP) return 'left';
  if (gapRight <= EDGE_SNAP) return 'right';
  return 'none';
}

// One 16ms tick of the release slide. Pure, so the runtime timer and the unit tests run exactly the
// same rule: friction first, then a clamped step, then the bounce on whichever axis hit a wall,
// stopping on the 1200ms cap or once the speed falls under the dead band.
function inertiaTick(state, size, workArea) {
  const current = state || {};
  const x = Number.isFinite(current.x) ? current.x : 0;
  const y = Number.isFinite(current.y) ? current.y : 0;
  const vx = Number.isFinite(current.vx) ? current.vx : 0;
  const vy = Number.isFinite(current.vy) ? current.vy : 0;
  const elapsed = Number.isFinite(current.elapsed) ? current.elapsed : 0;
  const next = {
    x,
    y,
    vx: vx * INERTIA_FRICTION,
    vy: vy * INERTIA_FRICTION,
    elapsed: elapsed + INERTIA_FRAME_MS,
    done: false,
    bounced: false
  };
  const speed = Math.sqrt(next.vx * next.vx + next.vy * next.vy);
  if (next.elapsed >= INERTIA_MAX_MS || speed < INERTIA_STOP_SPEED) {
    next.done = true;
    next.vx = 0;
    next.vy = 0;
    return next;
  }
  const dt = INERTIA_FRAME_MS / 1000;
  const wantX = Math.round(x + next.vx * dt);
  const wantY = Math.round(y + next.vy * dt);
  const locked = clampPosition({ x: wantX, y: wantY }, size, workArea);
  if (locked.x !== wantX) {
    next.vx = next.vx * INERTIA_BOUNCE;
    next.bounced = true;
  }
  if (locked.y !== wantY) {
    next.vy = next.vy * INERTIA_BOUNCE;
    next.bounced = true;
  }
  next.x = locked.x;
  next.y = locked.y;
  return next;
}

// DRAG_END carries nothing until the renderer learns to sample, and any value can arrive from a
// paused tab, so absent or insane velocities collapse to "no inertia" / the input cap.
function readVelocity(payload) {
  const cap = function (value) {
    return Math.max(-INERTIA_MAX_INPUT, Math.min(INERTIA_MAX_INPUT, value));
  };
  const vx = payload && Number.isFinite(payload.vx) ? cap(payload.vx) : 0;
  const vy = payload && Number.isFinite(payload.vy) ? cap(payload.vy) : 0;
  return { vx, vy, speed: Math.sqrt(vx * vx + vy * vy) };
}

function defaultPosition(size, workArea) {
  const area = normalizeArea(workArea);
  const width = size && Number.isFinite(size.width) ? size.width : BASE_WIDTH;
  const height = size && Number.isFinite(size.height) ? size.height : BASE_HEIGHT;
  if (!area) return { x: 0, y: 0 };
  return clampPosition(
    { x: area.x + area.width - width - MARGIN, y: area.y + area.height - height - MARGIN },
    { width, height },
    area
  );
}

function normalizeArea(area) {
  if (!area) return null;
  if (!Number.isFinite(area.x) || !Number.isFinite(area.y)) return null;
  if (!Number.isFinite(area.width) || !Number.isFinite(area.height)) return null;
  return { x: area.x, y: area.y, width: area.width, height: area.height };
}

function normalizeAreas(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (let index = 0; index < list.length; index += 1) {
    const area = normalizeArea(list[index]);
    if (area) out.push(area);
  }
  return out;
}

function normalizeSize(size) {
  const width = size && Number.isFinite(size.width) && size.width > 0 ? size.width : BASE_WIDTH;
  const height = size && Number.isFinite(size.height) && size.height > 0 ? size.height : BASE_HEIGHT;
  return { width, height };
}

function rectIntersectionArea(rect, area) {
  const left = Math.max(rect.x, area.x);
  const top = Math.max(rect.y, area.y);
  const right = Math.min(rect.x + rect.width, area.x + area.width);
  const bottom = Math.min(rect.y + rect.height, area.y + area.height);
  if (right <= left || bottom <= top) return 0;
  return (right - left) * (bottom - top);
}

function rectDistanceSquared(rect, area) {
  const dx = Math.max(area.x - (rect.x + rect.width), rect.x - (area.x + area.width), 0);
  const dy = Math.max(area.y - (rect.y + rect.height), rect.y - (area.y + area.height), 0);
  return dx * dx + dy * dy;
}

function pickOwnerArea(rect, areas) {
  let best = null;
  let bestOverlap = 0;
  for (let index = 0; index < areas.length; index += 1) {
    const overlap = rectIntersectionArea(rect, areas[index]);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = areas[index];
    }
  }
  return best;
}

function pickNearestArea(rect, areas) {
  let best = null;
  let bestDistance = Infinity;
  for (let index = 0; index < areas.length; index += 1) {
    const distance = rectDistanceSquared(rect, areas[index]);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = areas[index];
    }
  }
  return best;
}

function resolvePlacement(options) {
  const opts = options || {};
  const size = normalizeSize(opts.size);
  const areas = normalizeAreas(opts.workAreas);
  const primary = normalizeArea(opts.primaryWorkArea) || (areas.length > 0 ? areas[0] : null);
  const position = opts.position;
  const known = !!position && Number.isFinite(position.x) && Number.isFinite(position.y);
  // A19: with no display geometry we refuse to invent a screen - the caller's own position stands
  // (or 0,0 for a brand new window) and workArea stays null so nothing clamps against a fiction.
  if (!primary) {
    return {
      x: known ? Math.round(position.x) : 0,
      y: known ? Math.round(position.y) : 0,
      width: size.width,
      height: size.height,
      reason: 'no-work-area',
      workArea: null
    };
  }
  const list = areas.length > 0 ? areas : [primary];
  if (!known) {
    const home = defaultPosition(size, primary);
    return { x: home.x, y: home.y, width: size.width, height: size.height, reason: 'primary-default', workArea: primary };
  }
  const rect = { x: Math.round(position.x), y: Math.round(position.y), width: size.width, height: size.height };
  const owner = pickOwnerArea(rect, list);
  if (owner) {
    const locked = clampPosition(rect, size, owner);
    return { x: locked.x, y: locked.y, width: size.width, height: size.height, reason: 'owner-area', workArea: owner };
  }
  const nearest = pickNearestArea(rect, list) || primary;
  const locked = clampPosition(rect, size, nearest);
  return { x: locked.x, y: locked.y, width: size.width, height: size.height, reason: 'nearest-area', workArea: nearest };
}

function workAreasOf(screenLike) {
  const areas = [];
  try {
    if (screenLike && typeof screenLike.getAllDisplays === 'function') {
      const displays = screenLike.getAllDisplays() || [];
      for (let index = 0; index < displays.length; index += 1) {
        const area = normalizeArea(displays[index] && displays[index].workArea);
        if (area) areas.push(area);
      }
    }
  } catch (err) {
    return areas;
  }
  return areas;
}

function createPetWindow(ctx) {
  const config = ctx || {};
  const electron = config.electron || {};
  const BrowserWindow = electron.BrowserWindow;
  const screen = electron.screen;
  const store = config.store || null;
  const logger = config.logger || null;
  const htmlPath = config.htmlPath || path.join(__dirname, '..', 'renderer', 'pet', 'index.html');
  let win = null;
  let dragging = false;
  let roaming = false;
  let inertia = null;
  let sizeAnim = null;
  let alwaysOnTopApplied = null;
  let clickThroughApplied = null;
  let lastPlacement = null;
  let dragWatchdog = null;
  let dragWatchdogWarned = false;

  function log(level, message, error) {
    if (!logger) return;
    try {
      const sink = logger[level] || logger.info;
      if (typeof sink === 'function') sink('[pet-window] ' + message, error);
    } catch (err) {
      return;
    }
  }

  function settings() {
    return store ? store.getSettings() : {};
  }

  // A19: null means "no usable geometry", and every caller of this either skips the clamp or
  // cancels the move; the old hardcoded 1280x720 fallback used to drag the pet onto a fictional
  // screen.
  function primaryWorkArea() {
    try {
      const display = screen.getPrimaryDisplay();
      const area = normalizeArea(display && display.workArea);
      if (area) return area;
      log('warn', 'primary display reported no usable workArea');
    } catch (err) {
      log('warn', 'getPrimaryDisplay failed', err);
    }
    return null;
  }

  function allWorkAreas() {
    const areas = workAreasOf(screen);
    if (areas.length > 0) return areas;
    const primary = primaryWorkArea();
    return primary ? [primary] : [];
  }

  // Which display a given rect belongs to, using the same owner/nearest rule the placement uses,
  // so a roam or a slide that crosses displays keeps clamping to the one it is actually on.
  function workAreaFor(rect) {
    const placement = resolvePlacement({
      position: { x: rect.x, y: rect.y },
      size: { width: rect.width, height: rect.height },
      workAreas: allWorkAreas(),
      primaryWorkArea: primaryWorkArea()
    });
    return placement.workArea;
  }

  function isAlive() {
    return !!win && !win.isDestroyed();
  }

  function persistPosition(bounds) {
    if (!store || !bounds) return;
    try {
      store.patch({ position: { x: bounds.x, y: bounds.y } });
    } catch (err) {
      log('warn', 'persist position failed', err);
    }
  }

  function resolvePosition(current, size) {
    const placement = resolvePlacement({
      position: current ? current.position : null,
      size,
      workAreas: allWorkAreas(),
      primaryWorkArea: primaryWorkArea()
    });
    if (lastPlacement !== placement.reason + '@' + placement.x + ',' + placement.y) {
      lastPlacement = placement.reason + '@' + placement.x + ',' + placement.y;
      log('info', 'placement ' + placement.reason + ' -> ' + placement.x + ',' + placement.y + ' ' + placement.width + 'x' + placement.height);
    }
    return placement;
  }

  function clearDragWatchdog() {
    if (!dragWatchdog) return;
    clearTimeout(dragWatchdog);
    dragWatchdog = null;
  }

  function onDragWatchdog() {
    dragWatchdog = null;
    if (!dragging) return;
    if (!dragWatchdogWarned) {
      dragWatchdogWarned = true;
      log('warn', 'no DRAG_MOVE/DRAG_END for ' + DRAG_WATCHDOG_MS + 'ms, ending the drag');
    }
    // Recover without trusting the stale drag: no persistence, no inertia, just drop the flag.
    endDrag(null, { persist: false });
  }

  function armDragWatchdog() {
    clearDragWatchdog();
    dragWatchdog = setTimeout(onDragWatchdog, DRAG_WATCHDOG_MS);
    // Never hold the event loop open just for a watchdog.
    if (dragWatchdog && typeof dragWatchdog.unref === 'function') dragWatchdog.unref();
  }

  function applyAlwaysOnTop(enabled) {
    if (!isAlive()) return;
    const want = enabled !== false;
    if (alwaysOnTopApplied === want) return;
    try {
      if (want) win.setAlwaysOnTop(true, 'screen-saver');
      else win.setAlwaysOnTop(false);
      alwaysOnTopApplied = want;
    } catch (err) {
      log('warn', 'setAlwaysOnTop failed', err);
    }
  }

  function applyClickThrough(enabled) {
    if (!isAlive()) return;
    const want = enabled === true;
    if (clickThroughApplied === want) return;
    try {
      if (want) win.setIgnoreMouseEvents(true, { forward: true });
      else win.setIgnoreMouseEvents(false);
      clickThroughApplied = want;
    } catch (err) {
      log('warn', 'setIgnoreMouseEvents failed', err);
    }
  }

  function ensure() {
    if (isAlive()) return win;
    if (typeof BrowserWindow !== 'function') {
      log('warn', 'BrowserWindow unavailable, pet window disabled');
      return null;
    }
    const current = settings();
    const size = computeSize(current.scale);
    const position = resolvePosition(current, size);
    try {
      win = new BrowserWindow({
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        frame: false,
        transparent: true,
        resizable: false,
        maximizable: false,
        minimizable: false,
        skipTaskbar: true,
        hasShadow: false,
        focusable: false,
        alwaysOnTop: true,
        show: false,
        backgroundColor: '#00000000',
        webPreferences: {
          nodeIntegration: true,
          contextIsolation: false,
          backgroundThrottling: false
        }
      });
      alwaysOnTopApplied = null;
      clickThroughApplied = null;
      applyAlwaysOnTop(current.alwaysOnTop);
      applyClickThrough(current.clickThrough);
      const created = win;
      win.on('closed', () => {
        /* 重建窗口时旧窗口的 closed 可能晚于新窗口创建，只清理自己那一份引用。 */
        if (win !== created) return;
        cancelInertia();
        cancelSizeAnim();
        clearDragWatchdog();
        dragging = false;
        roaming = false;
        win = null;
        alwaysOnTopApplied = null;
        clickThroughApplied = null;
      });
      win.webContents.on('did-finish-load', () => {
        if (typeof config.onReady === 'function') {
          try {
            config.onReady(win);
          } catch (err) {
            log('warn', 'onReady hook failed', err);
          }
        }
      });
      const loaded = win.loadFile(htmlPath);
      if (loaded && typeof loaded.catch === 'function') {
        loaded.catch((err) => log('warn', 'loadFile failed: ' + htmlPath, err));
      }
    } catch (err) {
      log('error', 'create pet window failed', err);
      win = null;
      return null;
    }
    return win;
  }

  let showTimers = [];
  let hiddenByUser = false;
  let reopenFresh = false;

  // Windows 上透明无边框窗口 hide() 后再 show()，命中的鼠标输入状态与窗口层级可能丢失，
  // 表现为「再显示后拖不动」。显示后重新断言一次置顶与点击穿透，并在窗口真正显示后补断言。
  function assertInputState() {
    if (!isAlive()) return;
    alwaysOnTopApplied = null;
    clickThroughApplied = null;
    applyAlwaysOnTop(settings().alwaysOnTop);
    applyClickThrough(settings().clickThrough);
  }

  function clearShowTimers() {
    for (let i = 0; i < showTimers.length; i += 1) clearTimeout(showTimers[i]);
    showTimers = [];
  }

  function show() {
    const current = settings();
    if (current.scale === 0) {
      hide();
      return false;
    }
    /* 用户隐藏过之后再显示：直接重建窗口最可靠，彻底避开 Windows 透明窗口
       hide→show 后鼠标命中区域不恢复的问题。 */
    if (reopenFresh && isAlive()) {
      clearShowTimers();
      try { win.destroy(); } catch (e) { /* ignore */ }
      win = null;
      reopenFresh = false;
      dragging = false;
      roaming = false;
    }
    const target = ensure();
    if (!target) return false;
    hiddenByUser = false;
    try {
      if (!target.isVisible()) target.showInactive();
      assertInputState();
      if (current.alwaysOnTop !== false) {
        try { target.moveTop(); } catch (e) { /* ignore */ }
      }
      /* 分多次补断言，同时记录定时器，用户隐藏时可以全部取消，避免迟到的定时器把窗口又显示出来。 */
      clearShowTimers();
      [120, 360, 900].forEach(function (delay) {
        showTimers.push(setTimeout(function () {
          if (!isAlive() || hiddenByUser) return;
          try { if (!win.isVisible()) win.showInactive(); } catch (e) { /* ignore */ }
          assertInputState();
          if (settings().alwaysOnTop !== false) {
            try { win.moveTop(); } catch (e) { /* ignore */ }
          }
        }, delay));
      });
      log('info', 'shown');
      return true;
    } catch (err) {
      log('warn', 'show failed', err);
      return false;
    }
  }

  function hide() {
    if (!isAlive()) return false;
    try {
      /* 先取消显示后的补断言，否则它们会在隐藏后把窗口重新 showInactive 出来。 */
      clearShowTimers();
      hiddenByUser = true;
      reopenFresh = true;
      /* 隐藏时如果还处在拖拽状态，先把拖拽收口，避免再次显示后残留 dragging 标记。 */
      if (dragging) endDrag(null, { persist: false });
      if (win.isVisible()) win.hide();
      log('info', 'hidden');
      return true;
    } catch (err) {
      log('warn', 'hide failed', err);
      return false;
    }
  }

  function getBounds() {
    if (isAlive()) {
      try {
        return win.getBounds();
      } catch (err) {
        log('warn', 'getBounds failed', err);
      }
    }
    const current = settings();
    const size = computeSize(current.scale);
    const position = resolvePosition(current, size);
    return { x: position.x, y: position.y, width: size.width, height: size.height };
  }

  function setWindowBounds(bounds) {
    try {
      win.setBounds(bounds);
    } catch (err) {
      log('warn', 'setBounds failed', err);
    }
  }

  function cancelSizeAnim() {
    if (!sizeAnim) return;
    clearInterval(sizeAnim.timer);
    sizeAnim = null;
  }

  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  // Native bounds cannot be animated by CSS, so a size change is tweened here. The pet keeps its
  // bottom centre: growing from the middle would read as a jump, while the renderer scales the
  // sprite around the same point (renderer/pet/pet.js applyScale), so both stay in step.
  function place(current, size) {
    if (!isAlive()) return;
    const target = resolvePosition(current, size);
    const bounds = win.getBounds();
    if (bounds.x === target.x && bounds.y === target.y && bounds.width === size.width && bounds.height === size.height) {
      cancelSizeAnim();
      return;
    }
    const resized = bounds.width !== size.width || bounds.height !== size.height;
    const to = { x: target.x, y: target.y, width: size.width, height: size.height };
    if (!resized || config.sizeAnimation === false) {
      cancelSizeAnim();
      setWindowBounds(to);
      return;
    }
    const from = bounds;
    const centreX = from.x + from.width / 2;
    const bottomY = from.y + from.height;
    const area = target.workArea || primaryWorkArea();
    const startedAt = Date.now();
    const step = function () {
      if (!isAlive()) {
        cancelSizeAnim();
        return;
      }
      const progress = Math.min(1, (Date.now() - startedAt) / SIZE_ANIM_MS);
      if (progress >= 1) {
        cancelSizeAnim();
        setWindowBounds(to);
        return;
      }
      const eased = easeOutCubic(progress);
      const width = Math.max(1, Math.round(from.width + (to.width - from.width) * eased));
      const height = Math.max(1, Math.round(from.height + (to.height - from.height) * eased));
      const locked = clampPosition(
        { x: Math.round(centreX - width / 2), y: Math.round(bottomY - height) },
        { width, height },
        area
      );
      setWindowBounds({ x: locked.x, y: locked.y, width, height });
    };
    cancelSizeAnim();
    sizeAnim = { timer: setInterval(step, SIZE_ANIM_FRAME_MS) };
    step();
  }

  function applyState(state) {
    const current = (state && state.settings) || settings();
    const visible = current.visible === true && current.scale !== 0;
    if (!isAlive()) {
      if (visible) show();
      return getBounds();
    }
    const size = computeSize(current.scale);
    if (!dragging && !roaming) place(current, size);
    applyAlwaysOnTop(current.alwaysOnTop);
    applyClickThrough(current.clickThrough);
    if (visible) show();
    else hide();
    return getBounds();
  }

  function moveBy(dx, dy) {
    if (!isAlive()) return getBounds();
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return getBounds();
    // Any delta during a drag proves the renderer is still driving it, so the watchdog restarts.
    if (dragging) armDragWatchdog();
    try {
      const bounds = win.getBounds();
      const target = softClampPosition(
        { x: bounds.x + dx, y: bounds.y + dy },
        { width: bounds.width, height: bounds.height },
        allWorkAreas(),
        MIN_VISIBLE
      );
      win.setPosition(target.x, target.y);
      return win.getBounds();
    } catch (err) {
      log('warn', 'moveBy failed', err);
      return getBounds();
    }
  }

  function beginDrag() {
    // A new press during the release slide takes ownership back: the slide is abandoned where it
    // is (never persisted) and the renderer's DRAG_MOVE deltas drive the window from there.
    cancelInertia();
    dragging = true;
    cancelSizeAnim();
    dragWatchdogWarned = false;
    armDragWatchdog();
  }

  function cancelInertia() {
    if (!inertia) return;
    clearInterval(inertia.timer);
    inertia = null;
  }

  // The pre-inertia behaviour, unchanged: clamp into the owning work area, then persist - unless
  // the caller is recovering from a broken drag, where the spot is not worth remembering.
  function settleDrag(persist) {
    if (!isAlive()) return getBounds();
    let bounds = getBounds();
    const size = { width: bounds.width, height: bounds.height };
    const placement = resolvePlacement({
      position: { x: bounds.x, y: bounds.y },
      size,
      workAreas: allWorkAreas(),
      primaryWorkArea: primaryWorkArea()
    });
    if (placement.x !== bounds.x || placement.y !== bounds.y) {
      try {
        win.setPosition(placement.x, placement.y);
        bounds = win.getBounds();
      } catch (err) {
        log('warn', 'clamp position failed', err);
      }
    }
    if (persist !== false) persistPosition(bounds);
    return bounds;
  }

  function startInertia(velocity) {
    const bounds = getBounds();
    const size = { width: bounds.width, height: bounds.height };
    const state = { x: bounds.x, y: bounds.y, vx: velocity.vx, vy: velocity.vy, elapsed: 0 };
    cancelInertia();
    // The dragging flag stays raised for the whole slide so applyState keeps skipping place();
    // otherwise a settings push mid-slide would yank the window back to the persisted position.
    dragging = true;
    const tick = function () {
      if (!inertia) return;
      if (!isAlive()) {
        cancelInertia();
        dragging = false;
        return;
      }
      const area = workAreaFor({
        x: inertia.state.x,
        y: inertia.state.y,
        width: inertia.size.width,
        height: inertia.size.height
      });
      inertia.state = inertiaTick(inertia.state, inertia.size, area);
      try {
        win.setPosition(inertia.state.x, inertia.state.y);
      } catch (err) {
        log('warn', 'inertia setPosition failed', err);
        cancelInertia();
        dragging = false;
        settleDrag();
        return;
      }
      if (!inertia.state.done) return;
      cancelInertia();
      dragging = false;
      const settled = settleDrag();
      log('debug', 'inertia settled ' + settled.x + ',' + settled.y);
      if (typeof config.onDragSettled === 'function') {
        try {
          config.onDragSettled(settled);
        } catch (err) {
          log('warn', 'onDragSettled hook failed', err);
        }
      }
    };
    inertia = { timer: setInterval(tick, INERTIA_FRAME_MS), state, size };
  }

  // options.persist === false is the watchdog's recovery path: the drag ended without the renderer
  // ever saying where the window is, so neither the position nor a fling may be trusted.
  function endDrag(payload, options) {
    const opts = options || {};
    const persist = opts.persist !== false;
    clearDragWatchdog();
    cancelInertia();
    const velocity = readVelocity(payload);
    const current = settings();
    const fling = persist && isAlive() && current.dragPhysics !== false && velocity.speed >= INERTIA_MIN_SPEED;
    if (fling) {
      startInertia(velocity);
      return getBounds();
    }
    dragging = false;
    return settleDrag(persist);
  }

  // A roam drives the window from the main process for a few seconds; while it does, place() must
  // not re-apply the persisted position under it, and the settled spot has to be persisted or the
  // next state push would snap the pet back to where the roam started. A blocked roam
  // (options.persist === false) moves nowhere, so persisting would only store a lie.
  function setRoaming(enabled, options) {
    const want = enabled === true;
    const opts = options || {};
    if (roaming === want) return roaming;
    roaming = want;
    if (want) {
      cancelSizeAnim();
      return roaming;
    }
    if (opts.persist !== false) persistPosition(getBounds());
    return roaming;
  }

  function getEdge() {
    if (!isAlive()) return 'none';
    let bounds = null;
    try {
      bounds = win.getBounds();
    } catch (err) {
      log('warn', 'getBounds failed', err);
      return 'none';
    }
    const area = workAreaFor(bounds);
    return edgeOf(bounds, area);
  }

  function getWorkArea() {
    return workAreaFor(getBounds());
  }

  function destroy() {
    cancelInertia();
    cancelSizeAnim();
    clearDragWatchdog();
    dragging = false;
    roaming = false;
    if (!isAlive()) return;
    const target = win;
    win = null;
    alwaysOnTopApplied = null;
    clickThroughApplied = null;
    try {
      target.removeAllListeners('closed');
      target.destroy();
    } catch (err) {
      log('warn', 'destroy failed', err);
    }
  }

  // Test/debug surface: the drag watchdog is invisible from the outside otherwise.
  function state() {
    return {
      dragging,
      watchdogActive: !!dragWatchdog,
      roaming,
      inertia: !!inertia,
      sizeAnimating: !!sizeAnim,
      hasWindow: isAlive()
    };
  }

  return {
    show,
    hide,
    applyState,
    getBounds,
    moveBy,
    destroy,
    beginDrag,
    endDrag,
    ensure,
    getEdge,
    getWorkArea,
    setRoaming,
    state,
    isDragging: () => dragging,
    hasInertia: () => !!inertia,
    hasDragWatchdog: () => !!dragWatchdog,
    getWindow: () => (isAlive() ? win : null),
    isVisible: () => (isAlive() ? win.isVisible() : false),
    getHtmlPath: () => htmlPath
  };
}

module.exports = {
  BASE_WIDTH,
  BASE_HEIGHT,
  MARGIN,
  MIN_VISIBLE,
  DRAG_WATCHDOG_MS,
  computeSize,
  clampPosition,
  softClampPosition,
  hasMinVisible,
  defaultPosition,
  rectIntersectionArea,
  rectDistanceSquared,
  pickOwnerArea,
  pickNearestArea,
  resolvePlacement,
  workAreasOf,
  edgeOf,
  inertiaTick,
  readVelocity,
  INERTIA_FRAME_MS,
  INERTIA_FRICTION,
  INERTIA_BOUNCE,
  INERTIA_MIN_SPEED,
  INERTIA_STOP_SPEED,
  INERTIA_MAX_MS,
  EDGE_SNAP,
  createPetWindow
};
