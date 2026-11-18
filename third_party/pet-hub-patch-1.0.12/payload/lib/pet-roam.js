'use strict';

const { clampPosition } = require('./pet-window.js');

const DEFAULT_MIN_MS = 20000;
const DEFAULT_MAX_MS = 45000;
const STEP_MS = 16;
const SPEED_PX_S = 90;
const MIN_DISTANCE = 120;
const MAX_DISTANCE = 300;
const EDGE_MARGIN = 24;
// A 2D target can sit on the far side of the desktop, so one walk is capped: past MAX_RUN_PX the
// target slides back along its own ray. 2400px still crosses a 1920px display (~27s at 90px/s).
const MAX_RUN_PX = 2400;
// Rejections cover the gaps of an L-shaped display union; a target that fails this many times means
// the geometry offers nothing and the 1D walk gets its turn.
const TARGET_TRIES = 8;
// The straight line to the target is sampled once at start instead of being policed per step, so a
// dozen samples are enough to reject a path that would cut a corner off the desktop.
const PATH_SAMPLES = 12;
// A roam that starts with less room than this in both directions is pointless: skip it instead of
// firing ROAM{active:true} and an immediate edge stop in the same frame.
const MIN_ROOM = 16;
const MIN_ENV = 'PET_ROAM_MIN_MS';
const MAX_ENV = 'PET_ROAM_MAX_MS';

function readEnvMs(source, key) {
  const raw = source ? source[key] : undefined;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

// The 20-45s idle window is the shipped behaviour; the env pair exists only so acceptance runs can
// force a roam without waiting. Missing or malformed values leave the default untouched, and an
// inverted range pulls the *defaulted* side along so a lone override still means what it says.
function scheduleRange(source) {
  const env = source || process.env || {};
  const rawMin = readEnvMs(env, MIN_ENV);
  const rawMax = readEnvMs(env, MAX_ENV);
  let min = rawMin === null ? DEFAULT_MIN_MS : rawMin;
  let max = rawMax === null ? DEFAULT_MAX_MS : rawMax;
  if (min > max) {
    if (rawMin === null) min = max;
    else if (rawMax === null) max = min;
    else {
      const low = max;
      max = min;
      min = low;
    }
  }
  return { min, max };
}

function pickDistance(random) {
  const sample = typeof random === 'function' ? random() : Math.random();
  const ratio = Math.min(1, Math.max(0, Number.isFinite(sample) ? sample : 0));
  return Math.round(MIN_DISTANCE + (MAX_DISTANCE - MIN_DISTANCE) * ratio);
}

function durationFor(distance) {
  return Math.max(STEP_MS, Math.round((distance / SPEED_PX_S) * 1000));
}

function isArea(area) {
  return !!area && Number.isFinite(area.x) && Number.isFinite(area.y) &&
    Number.isFinite(area.width) && Number.isFinite(area.height);
}

function roomOf(bounds, area) {
  if (!isArea(area)) return { left: Infinity, right: Infinity };
  return {
    left: bounds.x - area.x,
    right: area.x + area.width - (bounds.x + bounds.width)
  };
}

// Two touching displays form one continuous surface, so "on screen" cannot mean "inside one work
// area": a window straddling the seam belongs to neither. Coverage is decided per vertical strip
// instead - each strip of the rect must be filled by the merged y-spans of the areas crossing it.
function coversRect(rect, areas) {
  if (!isArea(rect) || !Array.isArray(areas) || areas.length === 0) return false;
  const left = rect.x;
  const right = rect.x + rect.width;
  const top = rect.y;
  const bottom = rect.y + rect.height;
  const cuts = [left, right];
  areas.forEach(function (area) {
    if (!isArea(area)) return;
    if (area.x > left && area.x < right) cuts.push(area.x);
    if (area.x + area.width > left && area.x + area.width < right) cuts.push(area.x + area.width);
  });
  cuts.sort(function (a, b) { return a - b; });
  for (let i = 0; i + 1 < cuts.length; i += 1) {
    const low = cuts[i];
    const high = cuts[i + 1];
    if (high - low <= 0) continue;
    const mid = (low + high) / 2;
    const spans = [];
    areas.forEach(function (area) {
      if (!isArea(area)) return;
      if (area.x > mid || area.x + area.width < mid) return;
      spans.push([area.y, area.y + area.height]);
    });
    if (spans.length === 0) return false;
    spans.sort(function (a, b) { return a[0] - b[0]; });
    let reach = top;
    for (let s = 0; s < spans.length && reach < bottom; s += 1) {
      if (spans[s][0] > reach) break;
      if (spans[s][1] > reach) reach = spans[s][1];
    }
    if (reach < bottom) return false;
  }
  return true;
}

function inflateRect(rect, margin) {
  const gap = Number.isFinite(margin) ? Math.max(0, margin) : 0;
  return {
    x: rect.x - gap,
    y: rect.y - gap,
    width: rect.width + gap * 2,
    height: rect.height + gap * 2
  };
}

// Every top-left corner that keeps a window of `size` inside one area with `margin` to spare. The
// box spans all displays, so sampling it is what lets a target land on another screen; a display
// too small to host the window simply contributes nothing.
function insetBox(areas, size, margin) {
  const width = size && Number.isFinite(size.width) ? size.width : 1;
  const height = size && Number.isFinite(size.height) ? size.height : 1;
  const gap = Number.isFinite(margin) ? Math.max(0, margin) : EDGE_MARGIN;
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  const list = Array.isArray(areas) ? areas : [];
  list.forEach(function (area) {
    if (!isArea(area)) return;
    const minX = area.x + gap;
    const maxX = area.x + area.width - gap - width;
    const minY = area.y + gap;
    const maxY = area.y + area.height - gap - height;
    if (maxX < minX || maxY < minY) return;
    if (minX < left) left = minX;
    if (maxX > right) right = maxX;
    if (minY < top) top = minY;
    if (maxY > bottom) bottom = maxY;
  });
  if (left > right || top > bottom) return null;
  return { left: left, right: right, top: top, bottom: bottom };
}

function unitSample(random) {
  const sample = typeof random === 'function' ? random() : Math.random();
  return Math.min(1, Math.max(0, Number.isFinite(sample) ? sample : 0));
}

// The display a landing rect sits on, named in the single info line a roam writes. A rect that
// straddles a seam has no single owner; null then means "the union, not one screen".
function ownerOf(rect, areas) {
  const list = Array.isArray(areas) ? areas : [];
  for (let i = 0; i < list.length; i += 1) {
    const area = list[i];
    if (!isArea(area)) continue;
    if (rect.x >= area.x && rect.x + rect.width <= area.x + area.width &&
      rect.y >= area.y && rect.y + rect.height <= area.y + area.height) return area;
  }
  return null;
}

function pathCovered(origin, corner, size, areas) {
  const dx = corner.x - origin.x;
  const dy = corner.y - origin.y;
  for (let i = 1; i <= PATH_SAMPLES; i += 1) {
    const t = i / PATH_SAMPLES;
    const rect = {
      x: Math.round(origin.x + dx * t),
      y: Math.round(origin.y + dy * t),
      width: size.width,
      height: size.height
    };
    if (!coversRect(rect, areas)) return false;
  }
  return true;
}

// Target sampling: a uniform point of the union of the displays' inset boxes, kept only if the
// window really fits there with EDGE_MARGIN to spare *and* the straight line to it stays on screen.
// Uniform means any spot on the desktop is equally likely, which is what makes the walk look random:
// sometimes a short hop, sometimes the far screen.
function pickTarget(areas, origin, size, margin, random, maxRun) {
  if (!origin || !Number.isFinite(origin.x) || !Number.isFinite(origin.y)) return null;
  const box = insetBox(areas, size, margin);
  if (!box) return null;
  const cap = Number.isFinite(maxRun) && maxRun > 0 ? maxRun : MAX_RUN_PX;
  for (let attempt = 0; attempt < TARGET_TRIES; attempt += 1) {
    const x = Math.round(box.left + (box.right - box.left) * unitSample(random));
    const y = Math.round(box.top + (box.bottom - box.top) * unitSample(random));
    let dx = x - origin.x;
    let dy = y - origin.y;
    let distance = Math.round(Math.sqrt(dx * dx + dy * dy));
    if (distance < MIN_DISTANCE) continue;
    if (distance > cap) {
      // The far corner of a wide desktop would make one walk last a minute: keep the direction, cut
      // the length, so a single roam never outruns its distance budget at 90px/s.
      const scale = cap / distance;
      dx = Math.round(dx * scale);
      dy = Math.round(dy * scale);
      distance = Math.round(Math.sqrt(dx * dx + dy * dy));
      // Rounding the two components can overshoot the cap by a pixel; the reported length is what
      // becomes durationMs, so keep it honest rather than a hair over budget.
      if (distance > cap) distance = cap;
      if (distance < MIN_DISTANCE) continue;
    }
    const corner = { x: origin.x + dx, y: origin.y + dy };
    const rect = { x: corner.x, y: corner.y, width: size.width, height: size.height };
    if (!coversRect(inflateRect(rect, margin), areas)) continue;
    if (!pathCovered(origin, corner, size, areas)) continue;
    const owner = ownerOf(rect, areas);
    return {
      x: corner.x,
      y: corner.y,
      dx: dx,
      dy: dy,
      distance: distance,
      areaId: owner && Number.isFinite(owner.id) ? owner.id : null
    };
  }
  return null;
}

// A roam that ends on (or stops at) a work-area edge leaves the pet glued to it, where the bubble
// would be clipped. Shifting the nearest offending edge inward by a full margin guarantees the
// final gap is at least EDGE_MARGIN no matter how small the original gap was; a window already
// poking out of the area (unplugged display) gets the extra distance it needs to land inside.
function nudgeInside(bounds, area, margin) {
  const gap = Number.isFinite(margin) ? Math.max(0, margin) : EDGE_MARGIN;
  const box = {
    x: Number.isFinite(bounds && bounds.x) ? bounds.x : 0,
    y: Number.isFinite(bounds && bounds.y) ? bounds.y : 0,
    width: Number.isFinite(bounds && bounds.width) ? bounds.width : 1,
    height: Number.isFinite(bounds && bounds.height) ? bounds.height : 1
  };
  if (!isArea(area)) return { x: box.x, y: box.y };
  const left = box.x - area.x;
  const right = area.x + area.width - (box.x + box.width);
  const top = box.y - area.y;
  const bottom = area.y + area.height - (box.y + box.height);
  const inward = function (edgeGap) {
    return gap + (edgeGap < 0 ? -edgeGap : 0);
  };
  let x = box.x;
  let y = box.y;
  if (left < gap && left <= right) x = box.x + inward(left);
  else if (right < gap) x = box.x - inward(right);
  if (top < gap && top <= bottom) y = box.y + inward(top);
  else if (bottom < gap) y = box.y - inward(bottom);
  return clampPosition({ x, y }, { width: box.width, height: box.height }, area);
}

function createRoam(options) {
  const opts = options || {};
  const getWindow = typeof opts.getWindow === 'function' ? opts.getWindow : () => null;
  const getWorkAreaFor = typeof opts.getWorkAreaFor === 'function' ? opts.getWorkAreaFor : () => null;
  // Injected only by a host that can describe the whole desktop. Absent means "no display union
  // available", which keeps the shipped 1D walk byte-identical for older hosts and unit harnesses.
  const getAllAreas = typeof opts.getAllAreas === 'function' ? opts.getAllAreas : null;
  const getSettings = typeof opts.getSettings === 'function' ? opts.getSettings : () => ({});
  const isBlocked = typeof opts.isBlocked === 'function' ? opts.isBlocked : () => false;
  const isSuppressed = typeof opts.isSuppressed === 'function' ? opts.isSuppressed : null;
  const onRoam = typeof opts.onRoam === 'function' ? opts.onRoam : () => {};
  const random = typeof opts.random === 'function' ? opts.random : Math.random;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const sink = opts.log || null;

  let started = false;
  let active = false;
  let dir = 'right';
  let stepTimer = null;
  let scheduleTimer = null;
  let session = null;
  let nextAt = 0;
  let lastReason = 'init';
  let count = 0;
  const warned = Object.create(null);

  function logLine(level, message, error) {
    if (!sink) return;
    try {
      if (typeof sink === 'function') {
        sink(level, message, error);
        return;
      }
      const fn = sink[level] || sink.info;
      if (typeof fn === 'function') fn('[pet-roam] ' + message, error);
    } catch (err) {
      return;
    }
  }

  function emit(payload) {
    try {
      onRoam(payload);
    } catch (err) {
      logLine('warn', 'roam emit failed', err);
    }
  }

  function destroyed(win) {
    if (!win) return true;
    try {
      return typeof win.isDestroyed === 'function' && win.isDestroyed();
    } catch (err) {
      return true;
    }
  }

  function resolveArea(win) {
    try {
      const area = getWorkAreaFor(win);
      if (isArea(area)) return area;
    } catch (err) {
      warnOnce('workarea', 'getWorkAreaFor failed', err);
    }
    return null;
  }

  // Display geometry is read on every step, so a probe that starts throwing would otherwise write a
  // warn line 60 times a second. One line per key is enough to notice it.
  function warnOnce(key, message, error) {
    if (warned[key]) return;
    warned[key] = true;
    logLine('warn', message, error);
  }

  // The display union, or null when the host never wired one. A host that has the capability but no
  // usable geometry right now (screen not ready, display list empty) still roams - inside the single
  // display it can see - instead of falling back to the 1D walk.
  function resolveAreas(win) {
    if (!getAllAreas) return null;
    let list = null;
    try {
      list = getAllAreas();
    } catch (err) {
      warnOnce('areas', 'getAllAreas failed', err);
    }
    const valid = [];
    if (Array.isArray(list)) {
      list.forEach(function (area) {
        if (isArea(area)) valid.push(area);
      });
    }
    if (valid.length > 0) return valid;
    const single = resolveArea(win);
    return single ? [single] : null;
  }

  // Read on every trigger *and* on every 16ms step, so flipping quiet mode (or a fullscreen probe
  // turning true) stops a roam in flight instead of letting it walk to the end of its run.
  function quietReason() {
    const current = getSettings() || {};
    if (current.roam === false) return 'roam-off';
    if (current.quietMode === true) return 'quiet';
    if (isSuppressed) {
      try {
        if (isSuppressed() === true) return 'suppressed';
      } catch (err) {
        // A broken suppression probe must never take roaming down with it.
      }
    }
    return null;
  }

  function settingsAllow() {
    if (quietReason()) return false;
    const win = getWindow();
    if (!win || destroyed(win)) return false;
    try {
      if (typeof win.isVisible === 'function' && win.isVisible() !== true) return false;
    } catch (err) {
      return false;
    }
    return true;
  }

  // A11: a drag - or the inertia slide it released into - owns the window. A probe that throws is
  // read as "not blocked" so a broken window handle cannot wedge roaming forever.
  function blockedNow() {
    try {
      return !!isBlocked();
    } catch (err) {
      logLine('warn', 'isBlocked failed', err);
      return false;
    }
  }

  function clearStep() {
    if (!stepTimer) return;
    clearInterval(stepTimer);
    stepTimer = null;
  }

  function clearSchedule() {
    if (!scheduleTimer) return;
    clearTimeout(scheduleTimer);
    scheduleTimer = null;
  }

  function scheduleNext() {
    clearSchedule();
    nextAt = 0;
    if (!started || active) return;
    const range = scheduleRange();
    const delay = Math.round(range.min + random() * Math.max(0, range.max - range.min));
    nextAt = now() + delay;
    scheduleTimer = setTimeout(onSchedule, delay);
  }

  function onSchedule() {
    scheduleTimer = null;
    nextAt = 0;
    if (!started || active) return;
    // When automatic poses own the programme, only a running pose starts a walk.
    // A second independent timer must not cut a 20-second pose short.
    if (opts.actionDriven === true && getSettings().autoPlay === true) {
      scheduleNext();
      return;
    }
    beginRoam();
  }

  function settle() {
    const win = getWindow();
    if (!win || destroyed(win)) return;
    let bounds = null;
    try {
      bounds = win.getBounds();
    } catch (err) {
      return;
    }
    const area = resolveArea(win);
    if (!area) return;
    const target = nudgeInside(bounds, area, EDGE_MARGIN);
    if (target.x === bounds.x && target.y === bounds.y) return;
    try {
      moveWindow(win, target, bounds);
      logLine('debug', 'roam nudge ' + bounds.x + ',' + bounds.y + ' -> ' + target.x + ',' + target.y);
    } catch (err) {
      logLine('warn', 'roam nudge failed', err);
    }
  }

  function moveWindow(win, target, size) {
    // On Windows at fractional display scaling, repeated setPosition calls can
    // round the current native size upward each frame. Always supply the stable
    // route size along with its position; retain the old host API as a fallback.
    if (typeof win.setBounds === 'function') win.setBounds({ x: target.x, y: target.y, width: size.width, height: size.height });
    else win.setPosition(target.x, target.y);
  }

  function finish(reason) {
    if (!active) return;
    const done = session;
    active = false;
    session = null;
    clearStep();
    lastReason = reason;
    // Only a roam that actually travelled ends near an edge; an interrupted one hands the window to
    // the drag and must not be moved from under the pointer.
    // A 2D run lands on a point that already carries EDGE_MARGIN, and that point may straddle a seam
    // where no single display owns the window; nudging there would drag a legal landing back to one
    // screen. Only an xy run that was cut short, or the 1D walk, needs the nudge.
    const nudges = done && (reason === 'edge' || (reason === 'done' && done.plane !== 'xy'));
    if (nudges) settle();
    if (done) emit(endEvent(done, reason));
    logLine('info', 'roam ' + reason + (done ? ' ' + done.dir + ' ' + done.distance + 'px ' + done.durationMs + 'ms' : ''));
    if (started) scheduleNext();
  }

  // The payload the renderer already understands, plus the 2D extras. Existing field names and
  // meanings never change: dir stays 'left'/'right' even on a diagonal walk, dy/target are additive.
  function startEvent(run) {
    const base = { active: true, dir: run.dir, durationMs: run.durationMs };
    if (run.plane !== 'xy') return base;
    base.dy = run.dy;
    base.target = { x: run.target.x, y: run.target.y };
    return base;
  }

  function endEvent(run, reason) {
    const base = { active: false, dir: run.dir, durationMs: run.durationMs };
    if (reason === 'action' || reason === 'interrupt:action' || reason === 'interrupt:direction' || reason === 'interrupt:roam-off') base.preserveAction = true;
    if (run.plane !== 'xy') return base;
    base.dy = run.dy;
    base.target = { x: run.target.x, y: run.target.y };
    return base;
  }

  function step() {
    if (!active || !session) return;
    if (blockedNow()) {
      finish('blocked');
      return;
    }
    const win = getWindow();
    if (!win || destroyed(win)) {
      finish('lost');
      return;
    }
    const gate = quietReason();
    if (gate) {
      finish(gate);
      return;
    }
    if (typeof opts.getAction === 'function') {
      const expected = session.dir === 'left' ? 'running-left' : 'running-right';
      if (opts.getAction() !== expected) {
        // Wait briefly for the renderer's running-pose acknowledgement before any
        // first move. A higher-priority pose may reject the roam animation entirely.
        if (!session.acknowledged && now() - session.startedAt < 1000) return;
        finish('action');
        return;
      }
      if (!session.acknowledged) {
        session.acknowledged = true;
        session.startedAt = now();
      }
    }
    const elapsed = now() - session.startedAt;
    const progress = session.durationMs <= 0 ? 1 : Math.min(1, elapsed / session.durationMs);
    // One vector, split in two: travel grows at 90px/s along the whole path, so a diagonal walk
    // covers the same ground per second as a horizontal one instead of running sqrt(2) times faster.
    const travel = Math.round(session.distance * progress);
    const size = session.size;
    let wantX = 0;
    let wantY = session.y0;
    let target = null;
    if (session.plane === 'xy') {
      wantX = Math.round(session.x0 + session.ux * travel);
      wantY = Math.round(session.y0 + session.uy * travel);
      if (!coversRect({ x: wantX, y: wantY, width: size.width, height: size.height }, resolveAreas(win) || session.areas)) {
        // The desktop changed under the walk (display unplugged, seam closed): stop on the last spot
        // that still had screen instead of carrying the pet into the void.
        finish('edge');
        return;
      }
      target = { x: wantX, y: wantY };
    } else {
      wantX = session.x0 + session.sign * travel;
      target = clampPosition({ x: wantX, y: session.y0 }, size, resolveArea(win));
    }
    try {
      moveWindow(win, target, size);
    } catch (err) {
      logLine('warn', 'roam setPosition failed', err);
      finish('lost');
      return;
    }
    if (session.plane !== 'xy' && target.x !== wantX) {
      // Clamped means the pet reached the work-area edge: stop dead, no bounce.
      finish('edge');
      return;
    }
    if (progress >= 1) finish('done');
  }

  // The shipped walk: one horizontal run of 120-300px inside the work area the window is on. Kept
  // verbatim as the fallback for hosts without a display union and for geometry with no legal target.
  function plan1d(bounds, area, direction, minDuration) {
    const room = roomOf(bounds, area);
    let chosen = direction || (random() < 0.5 ? 'left' : 'right');
    if ((chosen === 'left' ? room.left : room.right) < MIN_ROOM) {
      chosen = chosen === 'left' ? 'right' : 'left';
    }
    if ((chosen === 'left' ? room.left : room.right) < MIN_ROOM) return null;
    const sign = chosen === 'left' ? -1 : 1;
    const sampled = pickDistance(random);
    const distance = direction || minDuration ? Math.min(sampled, chosen === 'left' ? room.left : room.right) : sampled;
    return {
      plane: 'x',
      dir: chosen,
      dy: 'none',
      sign: sign,
      ux: sign,
      uy: 0,
      target: null,
      areaId: null,
      distance: distance,
      durationMs: Math.max(minDuration || 0, durationFor(distance))
    };
  }

  // A real 2D walk: pick a point of the desktop union, then run at it along the straight line. dir is
  // still decided by the x component because that is all the renderer can animate; dy carries the
  // vertical half so the window can actually climb or descend while it runs.
  function plan2d(areas, bounds, size, direction, minDuration) {
    let target = null;
    for (let attempt = 0; attempt < (direction ? TARGET_TRIES : 1); attempt += 1) {
      const candidate = pickTarget(areas, bounds, size, EDGE_MARGIN, random, MAX_RUN_PX);
      if (candidate && (!direction || (candidate.dx < 0 ? 'left' : 'right') === direction)) { target = candidate; break; }
    }
    if (!target) return null;
    const distance = target.distance;
    return {
      plane: 'xy',
      dir: target.dx < 0 ? 'left' : 'right',
      dy: target.dy < 0 ? 'up' : (target.dy > 0 ? 'down' : 'none'),
      sign: target.dx < 0 ? -1 : 1,
      ux: distance > 0 ? target.dx / distance : 0,
      uy: distance > 0 ? target.dy / distance : 0,
      target: { x: target.x, y: target.y },
      areaId: target.areaId,
      distance: distance,
      durationMs: Math.max(minDuration || 0, durationFor(distance))
    };
  }

  function beginRoam(request) {
    if (active) return false;
    clearSchedule();
    nextAt = 0;
    // A11: never start a roam into a drag that is already holding the window; step() takes care of
    // a roam that was running when the pointer grabbed it.
    if (blockedNow()) {
      logLine('debug', 'roam skipped: blocked');
      if (started) scheduleNext();
      return false;
    }
    if (!settingsAllow()) {
      if (started) scheduleNext();
      return false;
    }
    const win = getWindow();
    let bounds = null;
    try {
      bounds = win.getBounds();
    } catch (err) {
      logLine('warn', 'roam getBounds failed', err);
      if (started) scheduleNext();
      return false;
    }
    if (!bounds) {
      if (started) scheduleNext();
      return false;
    }
    const area = resolveArea(win) || bounds;
    const size = { width: bounds.width, height: bounds.height };
    const areas = resolveAreas(win);
    const direction = request && (request.dir === 'left' || request.dir === 'right') ? request.dir : null;
    const requestedDuration = request && Number.isFinite(request.minDurationMs) ? request.minDurationMs : opts.minDurationMs;
    const minDuration = Number.isFinite(requestedDuration) ? Math.max(0, Math.min(28000, requestedDuration)) : 0;
    let plan = areas ? plan2d(areas, bounds, size, direction, minDuration) : null;
    // A union with no reachable target (tiny displays, everything in a gap) still gets the 1D walk.
    if (!plan) plan = plan1d(bounds, area, direction, minDuration);
    if (!plan) {
      logLine('debug', 'roam skipped: no room');
      if (started) scheduleNext();
      return false;
    }
    dir = plan.dir;
    const run = {
      plane: plan.plane,
      dir: plan.dir,
      dy: plan.dy,
      sign: plan.sign,
      ux: plan.ux,
      uy: plan.uy,
      target: plan.target,
      areaId: plan.areaId,
      areas: plan.plane === 'xy' ? areas : null,
      x0: bounds.x,
      y0: bounds.y,
      size: size,
      distance: plan.distance,
      durationMs: plan.durationMs,
      startedAt: now()
    };
    session = run;
    active = true;
    count += 1;
    lastReason = 'start';
    emit(startEvent(run));
    stepTimer = setInterval(step, STEP_MS);
    // One info line per roam - direction, distance, duration, landing point, display - and nothing
    // per step, so a long walk cannot flood the host log.
    logLine('info', 'roam start ' + run.dir + (run.plane === 'xy' ? '/' + run.dy : '') +
      ' ' + run.distance + 'px ' + run.durationMs + 'ms' +
      (run.plane === 'xy'
        ? ' target ' + run.target.x + ',' + run.target.y +
          (run.areaId === null ? ' display union' : ' display ' + run.areaId)
        : ''));
    return true;
  }

  function state() {
    const at = now();
    return {
      started,
      active,
      dir: active && session ? session.dir : dir,
      remainingMs: active && session ? Math.max(0, session.durationMs - (at - session.startedAt)) : 0,
      nextInMs: scheduleTimer && nextAt ? Math.max(0, nextAt - at) : 0,
      reason: lastReason,
      timers: (stepTimer ? 1 : 0) + (scheduleTimer ? 1 : 0),
      count
    };
  }

  function start() {
    started = true;
    scheduleNext();
    return state();
  }

  function stop() {
    const pending = session;
    clearSchedule();
    clearStep();
    active = false;
    session = null;
    nextAt = 0;
    started = false;
    lastReason = 'stop';
    if (pending) emit(endEvent(pending));
    return state();
  }

  function notifyInterrupt(reason) {
    const tag = 'interrupt:' + (typeof reason === 'string' && reason ? reason : 'unknown');
    if (active) {
      finish(tag);
      return true;
    }
    lastReason = tag;
    if (started) scheduleNext();
    return false;
  }

  return {
    start,
    stop,
    notifyInterrupt,
    state,
    forceNow: beginRoam,
    runDirection: (direction, durationMs) => beginRoam({
      dir: direction,
      minDurationMs: Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0
    })
  };
}

module.exports = {
  DEFAULT_MIN_MS,
  DEFAULT_MAX_MS,
  STEP_MS,
  SPEED_PX_S,
  MIN_DISTANCE,
  MAX_DISTANCE,
  EDGE_MARGIN,
  MIN_ROOM,
  MAX_RUN_PX,
  TARGET_TRIES,
  scheduleRange,
  pickDistance,
  durationFor,
  roomOf,
  nudgeInside,
  coversRect,
  insetBox,
  pickTarget,
  createRoam
};
