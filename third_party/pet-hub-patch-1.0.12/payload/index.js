'use strict';

const fs = require('fs');
const path = require('path');

const loggerModule = require('./lib/logger.js');
const ipc = require('./lib/ipc.js');
const configModule = require('./lib/config.js');
const petWindowModule = require('./lib/pet-window.js');
const pageViewModule = require('./lib/page-view.js');
const trayModule = require('./lib/tray.js');
const hotkeyModule = require('./lib/hotkey.js');
const pageEntryModule = require('./lib/page-entry.js');
const petsModule = require('./lib/pets.js');
const hdCacheModule = require('./lib/hd-cache.js');
const deviceModule = require('./lib/device-ipc.js');
const petRoamModule = require('./lib/pet-roam.js');
const petLibraryModule = require('./lib/pet-library.js');
const imageValidatorModule = require('./lib/image-validator.js');
const fullscreenWatchModule = require('./lib/fullscreen-watch.js');

const logger = loggerModule.createLogger({ tag: 'pet-hub' });
const PLUGIN_VERSION = (() => {
  try { return fs.readFileSync(path.join(__dirname, 'VERSION'), 'utf8').trim() || '—'; }
  catch (_) { return '—'; }
})();
const BUILD_INFO = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'BUILD.json'), 'utf8')); } catch (_) { return null; } })();

const LEVEL_UP_FALLBACK_MS = 3000;
const INPUT_LABEL_MAX = 24;
const GROWTH_AWARD = 1;
const MOVE_MIN_PX = 2;
const STATE_PUSH_MIN_MS = 400;
const GROWTH_MAX_LEVEL = 30;
const GROWTH_TITLES = ['新手', '进阶', '熟练', '专家', '大师'];
const GROWTH_BRACKETS = [4, 9, 19, 29, 30];

const FALLBACK_ACTIONS = [
  { id: 'idle', label: '待机', en: 'Idle', durations: [280, 110, 110, 140, 140, 320] },
  { id: 'running-right', label: '向右跑', en: 'Run right', durations: [120, 120, 120, 120, 120, 120, 220] },
  { id: 'running-left', label: '向左跑', en: 'Run left', durations: [120, 120, 120, 120, 120, 120, 220] },
  { id: 'waving', label: '挥手', en: 'Wave', durations: [140, 140, 140, 280] },
  { id: 'jumping', label: '跳跃', en: 'Jump', durations: [140, 140, 140, 140, 280] },
  { id: 'failed', label: '沮丧', en: 'Sad', durations: [140, 140, 140, 140, 140, 140, 140, 240] },
  { id: 'waiting', label: '等待', en: 'Wait', durations: [150, 150, 150, 150, 150, 260] },
  { id: 'running', label: '原地跑', en: 'Run', durations: [120, 120, 120, 120, 120, 220] },
  { id: 'review', label: '思考', en: 'Think', durations: [150, 150, 150, 150, 150, 280] }
];

function optionalRequire(id) {
  try {
    return require(id);
  } catch (err) {
    logger.debug('optional module unavailable: ' + id + ' (' + (err && err.code) + ')');
    return null;
  }
}

const electron = optionalRequire('electron');
const inlinePageModule = require('./lib/inline-page.js');
if (electron && electron.protocol && !electron.app.isReady()) inlinePageModule.registerScheme(electron);
const settingsHandlers = new Map();

let store = null;
let petWindow = null;
let roam = null;
let petLibrary = null;
let backupManager = null;
let activeImport = null;
let activeBackup = null;
let channelHealth = { state: 'connecting', reason: '', at: 0 };
const recentNotifications = [];
let playingAction = null;
let fullscreenWatch = null;
let pageView = null;
let trayHook = null;
let hotkeys = null;
let pageEntry = null;
let inputWatcher = null;
let pets = [];
let petsScanStamp = null;
let petsScanCache = null;
let petsScanHits = 0;
let petsScanRuns = 0;
let growth = null;
let growthModuleRef = null;
let growthModuleChecked = false;
let actionsCache = null;
let booted = false;
let teardownDone = false;
let lastStatePushAt = 0;
let processHooks = null;

function clampLabel(label) {
  if (typeof label !== 'string') return '';
  const text = label.trim();
  if (!text) return '';
  const chars = Array.from(text);
  return chars.length > INPUT_LABEL_MAX ? chars.slice(0, INPUT_LABEL_MAX).join('') : text;
}

function roundXp(value) {
  return Math.round(value * 1000) / 1000;
}

function fallbackXpForLevel(level) {
  if (!Number.isFinite(level) || level >= GROWTH_MAX_LEVEL) return 0;
  return 60 + (level - 1) * 20 + 8 * Math.pow(Math.max(0, level - 9), 2);
}

const FALLBACK_MAX_XP = (function () {
  let total = 0;
  for (let level = 1; level < GROWTH_MAX_LEVEL; level += 1) total += fallbackXpForLevel(level);
  return roundXp(total);
})();

function fallbackSnapshot(totalXp) {
  const safe = Number.isFinite(totalXp) ? totalXp : 0;
  let rest = Math.max(0, Math.min(FALLBACK_MAX_XP, safe));
  let level = 1;
  while (level < GROWTH_MAX_LEVEL && rest >= fallbackXpForLevel(level)) {
    rest = roundXp(rest - fallbackXpForLevel(level));
    level += 1;
  }
  const xpNext = roundXp(fallbackXpForLevel(level));
  const progress = xpNext > 0 ? Math.max(0, Math.min(1, rest / xpNext)) : 1;
  let titleIndex = GROWTH_TITLES.length - 1;
  for (let index = 0; index < GROWTH_BRACKETS.length; index += 1) {
    if (level <= GROWTH_BRACKETS[index]) {
      titleIndex = index;
      break;
    }
  }
  return {
    level,
    xp: roundXp(rest),
    xpNext,
    xpProgress: roundXp(progress),
    title: GROWTH_TITLES[titleIndex]
  };
}

function createFallbackGrowth(profile) {
  const source = profile && typeof profile === 'object' ? profile : {};
  const initialXp = Number.isFinite(source.totalXp) ? Math.max(0, Math.min(FALLBACK_MAX_XP, source.totalXp)) : 0;
  const state = {
    totalXp: roundXp(initialXp),
    lastAwardAt: Number.isFinite(source.lastAwardAt) && source.lastAwardAt >= 0 ? source.lastAwardAt : 0
  };
  return {
    fallback: true,
    get level() {
      return fallbackSnapshot(state.totalXp).level;
    },
    get title() {
      return fallbackSnapshot(state.totalXp).title;
    },
    addXp(amount, now) {
      const delta = Number.isFinite(amount) ? Math.max(0, amount) : 0;
      state.totalXp = roundXp(Math.min(FALLBACK_MAX_XP, state.totalXp + delta));
      state.lastAwardAt = Number.isFinite(now) ? now : Date.now();
      return fallbackSnapshot(state.totalXp);
    },
    snapshot() {
      return fallbackSnapshot(state.totalXp);
    },
    profile() {
      return { totalXp: state.totalXp, lastAwardAt: state.lastAwardAt, curveVersion: 'fallback-1' };
    }
  };
}

function pickActionList(source) {
  if (Array.isArray(source)) return source;
  if (!source || typeof source !== 'object') return null;
  const candidates = [source.ACTIONS, source.actions, source.list, source.default];
  for (let index = 0; index < candidates.length; index += 1) {
    if (Array.isArray(candidates[index])) return candidates[index];
  }
  return null;
}

function readField(holder, name) {
  return holder && typeof holder[name] === 'string' && holder[name] ? holder[name] : null;
}

function readLabel(entry, fallbackEntry, key) {
  const direct = readField(entry, key);
  if (direct) return direct;
  if (entry && entry.label) {
    if (key === 'zh') {
      const flat = readField(entry, 'label');
      if (flat) return flat;
    }
    const nested = readField(entry.label, key);
    if (nested) return nested;
  }
  const fallbackDirect = readField(fallbackEntry, key);
  if (fallbackDirect) return fallbackDirect;
  if (key === 'zh') {
    const fallbackFlat = readField(fallbackEntry, 'label');
    if (fallbackFlat) return fallbackFlat;
  }
  return '';
}

function readDurations(entry, fallbackEntry) {
  const direct = entry && Array.isArray(entry.durations) ? entry.durations : entry && Array.isArray(entry.frames) ? entry.frames : null;
  const source = direct && direct.length > 0 ? direct : fallbackEntry ? fallbackEntry.durations : [140];
  return source.filter((value) => Number.isFinite(value) && value > 0).map((value) => Math.round(value));
}

function normalizeActions(source) {
  const list = pickActionList(source);
  if (!list || list.length === 0) return null;
  const out = [];
  for (let index = 0; index < list.length; index += 1) {
    const entry = list[index] && typeof list[index] === 'object' ? list[index] : {};
    const fallbackEntry = FALLBACK_ACTIONS[index] || null;
    const id = typeof entry.id === 'string' && entry.id ? entry.id : fallbackEntry ? fallbackEntry.id : 'action-' + index;
    const durations = readDurations(entry, fallbackEntry);
    out.push({
      index,
      id,
      label: readLabel(entry, fallbackEntry, 'zh'),
      en: readLabel(entry, fallbackEntry, 'en'),
      durations: durations.length > 0 ? durations : [140]
    });
  }
  return out;
}

function getActions() {
  if (actionsCache) return actionsCache;
  const normalized = normalizeActions(optionalRequire('./shared/actions.js'));
  if (normalized) {
    actionsCache = normalized;
    logger.info('shared/actions.js loaded');
  } else {
    actionsCache = normalizeActions(FALLBACK_ACTIONS);
    logger.warn('shared/actions.js unavailable, using built-in action table');
  }
  return actionsCache;
}

function getGrowthSnapshot() {
  if (growth && typeof growth.snapshot === 'function') {
    try {
      const snapshot = growth.snapshot();
      if (snapshot && typeof snapshot === 'object') return snapshot;
    } catch (err) {
      logger.warn('growth.snapshot failed, using fallback snapshot', err);
    }
  }
  return fallbackSnapshot(0);
}

function getGrowthModule() {
  if (growthModuleChecked) return growthModuleRef;
  growthModuleChecked = true;
  const mod = optionalRequire('./lib/growth.js');
  growthModuleRef = mod && typeof mod.createGrowth === 'function' ? mod : null;
  return growthModuleRef;
}

function currentLocale() {
  return store ? store.getSettings().locale : 'zh';
}

function growthProfile() {
  if (!growth) return null;
  try {
    if (typeof growth.profile === 'function') return growth.profile();
    if (typeof growth.getProfile === 'function') return growth.getProfile();
    if (typeof growth.toJSON === 'function') return growth.toJSON();
    if (typeof growth.snapshot === 'function') {
      const snap = growth.snapshot();
      if (snap && typeof snap === 'object') {
        const out = {};
        if (Number.isFinite(snap.totalXp)) out.totalXp = snap.totalXp;
        if (Number.isFinite(snap.lastAwardAt)) out.lastAwardAt = snap.lastAwardAt;
        if (typeof snap.curveVersion === 'string' || Number.isFinite(snap.curveVersion)) out.curveVersion = snap.curveVersion;
        if (Object.keys(out).length > 0) return out;
      }
    }
  } catch (err) {
    logger.warn('growth profile read failed', err);
  }
  return null;
}

function buildGrowth(profile) {
  const mod = getGrowthModule();
  if (mod) {
    try {
      return mod.createGrowth(profile, currentLocale());
    } catch (err) {
      logger.warn('growth.createGrowth failed, using built-in curve', err);
    }
  }
  logger.warn('lib/growth.js unavailable, using built-in growth curve');
  return createFallbackGrowth(profile);
}

function findPet(id) {
  for (let index = 0; index < pets.length; index += 1) {
    if (pets[index].id === id) return pets[index];
  }
  return null;
}

function currentPetId() {
  if (!store) return '';
  return store.getSettings().petId || '';
}

function petNameFor(id) {
  if (!id) return '';
  const settings = store ? store.getSettings() : configModule.createDefaultSettings();
  const names = settings.petNames || {};
  if (typeof names[id] === 'string' && names[id]) return names[id];
  const pet = findPet(id);
  return pet ? pet.displayName : '';
}

function profileFor(id) {
  if (!id || !store) return null;
  const profiles = store.getSettings().growthProfiles || {};
  const profile = profiles[id];
  return profile && typeof profile === 'object' ? profile : null;
}

function saveProfile(id, profile) {
  if (!store || !id || !profile) return false;
  const settings = store.getSettings();
  const profiles = Object.assign({}, settings.growthProfiles);
  profiles[id] = profile;
  try {
    store.patch({ growthProfiles: profiles });
    return true;
  } catch (err) {
    logger.warn('save profile failed: ' + id, err);
    return false;
  }
}

function defaultProfile() {
  const mod = getGrowthModule();
  if (mod && typeof mod.DEFAULT_PROFILE === 'function') {
    try {
      return mod.DEFAULT_PROFILE();
    } catch (err) {
      logger.warn('DEFAULT_PROFILE failed', err);
    }
  }
  return { totalXp: 0, lastAwardAt: 0, curveVersion: 'fallback-1' };
}

function petSnapshotFor(id) {
  const profile = profileFor(id) || defaultProfile();
  const mod = getGrowthModule();
  if (mod && typeof mod.createGrowth === 'function') {
    try {
      return normalizeGrowthView(mod.createGrowth(profile, currentLocale()).snapshot());
    } catch (err) {
      logger.warn('pet snapshot failed: ' + id, err);
    }
  }
  return normalizeGrowthView(fallbackSnapshot(Number.isFinite(profile.totalXp) ? profile.totalXp : 0));
}

function ensureGrowth() {
  if (growth) return growth;
  const id = currentPetId();
  growth = buildGrowth(profileFor(id) || defaultProfile());
  return growth;
}

function rebuildGrowth() {
  const id = currentPetId();
  growth = buildGrowth(profileFor(id) || defaultProfile());
  return growth;
}

function persistGrowth() {
  const id = currentPetId();
  if (!id) return;
  const profile = growthProfile();
  if (!profile || typeof profile !== 'object') return;
  saveProfile(id, profile);
}

// A16: GET_STATE rescans the pets directory on every invoke. The stamp is the cheapest possible
// signature - the root directory's mtime plus every pet.json's mtime - so an untouched directory
// reuses the previous scan instead of re-reading every manifest on the main thread.
function petsScanSignature() {
  try {
    const root = petsModule.defaultPetsDir();
    const dirMs = fs.statSync(root).mtimeMs;
    const names = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const parts = [];
    for (let index = 0; index < names.length; index += 1) {
      const name = names[index];
      let fileMs = 0;
      try {
        fileMs = fs.statSync(path.join(root, name, 'pet.json')).mtimeMs;
      } catch (err) {
        fileMs = 0;
      }
      parts.push(name + ':' + fileMs);
    }
    return root + '|' + dirMs + '|' + parts.join(',');
  } catch (err) {
    return null;
  }
}

function scanPetsNow() {
  const signature = petsScanSignature();
  if (signature && signature === petsScanStamp && petsScanCache) {
    petsScanHits += 1;
    pets = petsScanCache;
    return pets;
  }
  let result = { pets: [], skipped: [] };
  try {
    result = petsModule.scanPets(petsModule.defaultPetsDir(), { logger });
  } catch (err) {
    logger.warn('scan pets failed', err);
  }
  petsScanRuns += 1;
  pets = result.pets;
  petsScanStamp = signature;
  petsScanCache = pets;
  if (pets.length === 0) logger.warn('no pets found in ' + petsModule.defaultPetsDir());
  else logger.info('pets loaded: ' + pets.map((pet) => pet.id).join(', '));
  return pets;
}

function resolvePetId() {
  if (!store || pets.length === 0) return '';
  const id = currentPetId();
  if (findPet(id)) return id;
  const fallback = pets[0].id;
  store.patch({ petId: fallback });
  logger.info('pet id resolved to ' + fallback);
  return fallback;
}

// 宠物删掉后它的成长档案会留在 settings.growthProfiles 里（删除弹窗承诺连等级一起删）。
// 每次刷新宠物列表后按真实 id 清扫一次；只有真剔掉东西才写盘 + 记一条，避免每次启动都 patch。
function pruneGrowthProfiles() {
  if (!store) return [];
  const ids = pets.map((pet) => pet.id);
  // 列表还没加载出来时不能按空列表清扫，否则会把所有档案当孤儿删光。
  if (ids.length === 0) return [];
  const settings = store.getSettings();
  const result = configModule.pruneProfiles(settings.growthProfiles || {}, ids);
  if (result.removed.length === 0) return [];
  try {
    store.patch({ growthProfiles: result.profiles });
    logger.info('pruned growth profiles: ' + result.removed.join(', '));
  } catch (err) {
    logger.warn('prune growth profiles failed', err);
    return [];
  }
  return result.removed;
}

// settings.petNames 与成长档案同源：删掉的宠物改过的名字也会留在设置里（删除弹窗同样承诺删名字）。
// 规则与 pruneGrowthProfiles 一致：列表空不动、只有真剔掉才写盘、两条日志分开记。
function prunePetNames() {
  if (!store) return [];
  const ids = pets.map((pet) => pet.id);
  if (ids.length === 0) return [];
  const settings = store.getSettings();
  const result = configModule.pruneNames(settings.petNames || {}, ids);
  if (result.removed.length === 0) return [];
  try {
    store.patch({ petNames: result.names });
    logger.info('pruned pet names: ' + result.removed.join(', '));
  } catch (err) {
    logger.warn('prune pet names failed', err);
    return [];
  }
  return result.removed;
}

function refreshPets() {
  scanPetsNow();
  resolvePetId();
  // A host upgrade can move or replace the artwork directory. Retain profiles
  // for temporarily missing packs; explicit deletion already removes its own data.
  return pets;
}

function selectPet(id, options) {
  if (!store) return null;
  const target = typeof id === 'string' ? findPet(id) : null;
  if (!target) {
    logger.debug('pet:select ignored: ' + id);
    return null;
  }
  if (currentPetId() !== target.id) {
    if (roam) roam.notifyInterrupt('select');
    playingAction = null;
    persistGrowth();
    store.patch({ petId: target.id });
    rebuildGrowth();
    logger.info('pet selected: ' + target.id);
  }
  if (options && options.visible === true) {
    const patch = { visible: true };
    if (getActions().some((action) => action.id === options.action)) patch.action = options.action;
    if (Number.isFinite(options.scale)) patch.scale = options.scale;
    store.patch(patch);
  }
  return pushState({ force: true });
}

function inputAvailable() {
  if (!inputWatcher) return false;
  try {
    return typeof inputWatcher.isAvailable === 'function' ? inputWatcher.isAvailable() === true : true;
  } catch (err) {
    logger.warn('input watcher isAvailable failed', err);
    return false;
  }
}

function primaryWorkArea() {
  try {
    const screen = electron && electron.screen;
    if (screen && typeof screen.getPrimaryDisplay === 'function') {
      const display = screen.getPrimaryDisplay();
      if (display && display.workArea) return display.workArea;
    }
  } catch (err) {
    logger.warn('screen.getPrimaryDisplay failed', err);
  }
  // A19: no display geometry means "this machine told us nothing about its screens", never a
  // made-up 1280x720 - callers pass null through and pet-window refuses to clamp against it.
  return null;
}

// The whole desktop, as the roam sees it. An empty array means "this machine did not tell us about
// its screens" - pet-roam then falls back to the single work area pet-window resolves, so a failed
// query costs roaming nothing more than losing the cross-screen hop.
function allWorkAreas() {
  try {
    const screen = electron && electron.screen;
    if (screen && typeof screen.getAllDisplays === 'function') {
      const displays = screen.getAllDisplays();
      if (Array.isArray(displays)) {
        const areas = displays
          .map((display) => (display ? display.workArea : null))
          .filter((area) => area && Number.isFinite(area.x) && Number.isFinite(area.y) &&
            Number.isFinite(area.width) && Number.isFinite(area.height) &&
            area.width > 0 && area.height > 0);
        if (areas.length > 0) return areas;
      }
    }
  } catch (err) {
    logger.warn('screen.getAllDisplays failed', err);
  }
  return [];
}

function hostWindowList() {
  const BrowserWindow = electron && electron.BrowserWindow;
  if (!BrowserWindow || typeof BrowserWindow.getAllWindows !== 'function') return [];
  try {
    const windows = BrowserWindow.getAllWindows();
    return Array.isArray(windows) ? windows : [];
  } catch (err) {
    logger.warn('BrowserWindow.getAllWindows failed', err);
    return [];
  }
}

function isUsableHostWindow(candidate) {
  if (!candidate || typeof candidate !== 'object') return false;
  try {
    if (typeof candidate.isDestroyed === 'function' && candidate.isDestroyed()) return false;
  } catch (err) {
    return false;
  }
  // The host tray is also a BrowserWindow. Never attach the full Friend page
  // to its small popup when settings are opened from the desktop/tray menu.
  try {
    const contents = candidate.webContents;
    if (contents && typeof contents.getURL === 'function' && /(?:^|\/)tray\.html(?:[?#]|$)/i.test(contents.getURL())) return false;
  } catch (err) {
    return false;
  }
  if (!candidate.contentView || typeof candidate.contentView.addChildView !== 'function') return false;
  let ownPetWindow = null;
  try {
    ownPetWindow = petWindow ? petWindow.getWindow() : null;
  } catch (err) {
    ownPetWindow = null;
  }
  return !ownPetWindow || candidate !== ownPetWindow;
}

function resolveHostWindow(preferred) {
  if (isUsableHostWindow(preferred)) return preferred;
  const windows = hostWindowList();
  const usable = [];
  for (let index = 0; index < windows.length; index += 1) {
    if (isUsableHostWindow(windows[index])) usable.push(windows[index]);
  }
  if (usable.length === 0) return null;
  for (let index = 0; index < usable.length; index += 1) {
    if (typeof usable[index].isFocused === 'function' && usable[index].isFocused()) return usable[index];
  }
  for (let index = 0; index < usable.length; index += 1) {
    if (typeof usable[index].isVisible === 'function' && usable[index].isVisible()) return usable[index];
  }
  return usable[0];
}

function revealHostWindow(target) {
  if (!target) return false;
  try {
    if (typeof target.isMinimized === 'function' && target.isMinimized() && typeof target.restore === 'function') {
      target.restore();
    }
    if (typeof target.isVisible === 'function' && !target.isVisible() && typeof target.show === 'function') {
      target.show();
    }
    if (typeof target.focus === 'function') target.focus();
    return true;
  } catch (err) {
    logger.warn('reveal host window failed', err);
    return false;
  }
}

function fallbackBounds() {
  const settings = store ? store.getSettings() : configModule.createDefaultSettings();
  const size = petWindowModule.computeSize(settings.scale);
  const area = primaryWorkArea();
  const position = settings.position
    ? petWindowModule.clampPosition(settings.position, size, area)
    : petWindowModule.defaultPosition(size, area);
  return { x: position.x, y: position.y, width: size.width, height: size.height };
}

function normalizeGrowthView(snapshot) {
  const src = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const fallbackView = fallbackSnapshot(Number.isFinite(src.totalXp) ? src.totalXp : 0);
  const level = Number.isFinite(src.level) ? src.level : fallbackView.level;
  const xp = Number.isFinite(src.xp) ? src.xp : fallbackView.xp;
  const xpNext = Number.isFinite(src.xpNext) ? src.xpNext : Number.isFinite(src.required) ? src.required : fallbackView.xpNext;
  const xpProgress = Number.isFinite(src.xpProgress) ? src.xpProgress : xpNext > 0 ? Math.max(0, Math.min(1, xp / xpNext)) : 1;
  const title = typeof src.title === 'string' && src.title ? src.title : fallbackView.title;
  return Object.assign({}, src, { level, xp, xpNext, xpProgress, title });
}

function petEntries(currentGrowth) {
  const activeId = currentPetId();
  const out = [];
  for (let index = 0; index < pets.length; index += 1) {
    const pet = pets[index];
    out.push({
      id: pet.id,
      displayName: pet.displayName,
      name: petNameFor(pet.id),
      atlasUrl: pet.atlasUrl,
      fallbackAtlasUrl: pet.fallbackAtlasUrl || null,
      heroUrl: typeof pet.heroUrl === 'string' && pet.heroUrl ? pet.heroUrl : null,
      growth: pet.id === activeId ? currentGrowth : petSnapshotFor(pet.id)
    });
  }
  return out;
}

// The page layer owns its own install status and may not expose status() yet: the field is null
// when it is missing, and a throwing probe can never take the whole state snapshot down.
function entryStatusView() {
  try {
    if (!pageEntry || typeof pageEntry.status !== 'function') return null;
    const value = pageEntry.status();
    return typeof value === 'undefined' ? null : value;
  } catch (err) {
    try {
      logger.warn('pageEntry.status failed', err);
    } catch (logErr) {
      // ignore
    }
    return null;
  }
}

function buildState() {
  const rawSettings = store ? store.getSettings() : configModule.createDefaultSettings();
  const settings = Object.assign({}, rawSettings, { petName: petNameFor(rawSettings.petId) });
  const view = normalizeGrowthView(getGrowthSnapshot());
  return {
    pluginVersion: PLUGIN_VERSION,
    buildInfo: BUILD_INFO,
    settings,
    playingAction,
    growth: view,
    actions: getActions(),
    bounds: petWindow ? petWindow.getBounds() : fallbackBounds(),
    // The renderer flips its bubble away from whichever work-area edge the window is hugging.
    edge: petWindow ? petWindow.getEdge() : 'none',
    // Null until the device bridge is up; the settings page hides every device row in that case.
    deviceCaps: deviceBridge ? deviceBridge.getCapabilities() : null,
    inputAvailable: inputAvailable(),
    entryStatus: entryStatusView(),
    pets: petEntries(view)
  };
}

// A3: the recovery path for an ipc handler that has already thrown must not throw again, so this
// snapshot is built from constants only - no store, no window, no growth profile.
function degradedState() {
  const out = {
    settings: {},
    petId: null,
    pets: [],
    entryStatus: null,
    growth: null,
    actions: [],
    bounds: { x: 0, y: 0, width: 0, height: 0 },
    edge: 'none',
    deviceCaps: null,
    inputAvailable: false,
    degraded: true
  };
  try {
    out.settings = configModule.createDefaultSettings();
  } catch (err) {
    out.settings = {};
  }
  try {
    out.growth = normalizeGrowthView(fallbackSnapshot(0));
  } catch (err) {
    out.growth = null;
  }
  return out;
}

function safeStateSnapshot() {
  try {
    return buildState();
  } catch (err) {
    try {
      logger.error('buildState failed, serving degraded state', err);
    } catch (logErr) {
      // ignore
    }
    return degradedState();
  }
}

function sendToPet(channel, payload) {
  if (!petWindow) return false;
  const win = petWindow.getWindow();
  if (!win) return false;
  try {
    if (win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload);
      return true;
    }
  } catch (err) {
    logger.warn('send to pet window failed: ' + channel, err);
  }
  return false;
}

function sendToSettings(channel, payload) {
  if (!pageView) return false;
  return pageView.send(channel, payload);
}

const PERF_FEATURE = ['off', 'on', 'degraded'];
// 补帧倍数化之后等效帧率 = 倍数 × 源帧率，实测 27~148，旧的 24/30/60 白名单会把真值压回 24。
const PERF_FPS_MAX = 240;
const PERF_HD = ['idle', 'preparing', 'ready', 'degraded'];

// 渲染进程上报 → 设置页：字段固定为契约里的五项（旧字段保留，新增 fps/hd/hdProgress）。
function normalizePerfStatus(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const fps = Number(payload.fps);
  const raw = Math.round(Number(payload.hdProgress));
  const progress = isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 0;
  const hd = PERF_HD.indexOf(payload.hd) >= 0 ? payload.hd : 'idle';
  return {
    sharp: PERF_FEATURE.indexOf(payload.sharp) >= 0 ? payload.sharp : 'off',
    interp: PERF_FEATURE.indexOf(payload.interp) >= 0 ? payload.interp : 'off',
    fps: isFinite(fps) && fps > 0 && fps <= PERF_FPS_MAX ? Math.round(fps) : 24,
    hd: hd,
    // 进度必须与状态自洽：ready 恒为 100，idle 恒为 0，preparing 用上报值。
    hdProgress: hd === 'ready' ? 100 : (hd === 'idle' ? 0 : progress)
  };
}

function relayPerfStatus(payload) {
  lastPerfStatus = normalizePerfStatus(payload);
  if (!pageView) {
    logger.warn('perf status dropped: settings page not created');
    return false;
  }
  try {
    return pageView.send(ipc.PERF, lastPerfStatus);
  } catch (err) {
    logger.warn('perf status relay failed', err);
    return false;
  }
}

let lastPerfStatus = null;
let hdCache = null;

// ---- 全屏静默（P0 轨道 D）：前台窗口铺满所在显示器时，漫游与 P2 以下播报暂停 ----
// 契约 §5/§7：quietFullscreen 为 false 时探测结果不参与任何门控（探测照跑，只是不生效）。
function isFullscreenSuppressed() {
  try {
    if (!fullscreenWatch) return false;
    const settings = store ? store.getSettings() : null;
    if (settings && settings.quietFullscreen === false) return false;
    return fullscreenWatch.isFullscreen() === true;
  } catch {
    return false;
  }
}

// ---- 设备桥：驱动状态/通知广播 + 配置文件兜底 → 归一化事件 → Friend ----
let deviceBridge = null;
let hostAudioBridge = null;

// 具名 handler 供移除使用：只摘自己这一个监听，绝不 removeAllListeners（'pet:debug' 仅本模块所有）。
function handleDeviceDebug(_event, payload) {
  if (deviceBridge) deviceBridge.ingestEvent(payload);
}

function handleDebugDevices() {
  return deviceBridge ? deviceBridge.state() : null;
}

// 验收调试通道（契约 §11）：只读回窗口/漫游/惯性/边缘/全屏，供 CDP 断言，不参与业务逻辑。
async function handleDebugWindow() {
  const out = { bounds: null, dragging: false, roaming: false, inertia: false, edge: null, fullscreen: false };
  try {
    if (petWindow) {
      out.bounds = petWindow.getBounds();
      out.dragging = petWindow.isDragging() === true;
      out.inertia = petWindow.hasInertia() === true;
      out.edge = petWindow.getEdge();
    }
    if (roam) out.roaming = roam.state().active === true;
    out.fullscreen = isFullscreenSuppressed();
  } catch (err) {
    out.error = String(err && err.message ? err.message : err);
  }
  return out;
}

function startDeviceBridge() {
  if (deviceBridge) return false;
  try {
    deviceBridge = deviceModule.createDeviceBridge({
      app: electron && electron.app ? electron.app : null,
      send: (channel, payload) => {
        // 全屏静默只拦 P2 及以下（一般播报/随机表演）；P0/P1 是用户操作结果，必须送达。
        const blocked = channel === ipc.NOTIFY && isFullscreenSuppressed() && Number(payload && payload.priority) >= 2;
        const sent = !blocked && sendToPet(channel, payload);
        if (channel === ipc.NOTIFY) {
          recentNotifications.push({ at: Date.now(), kind: payload.kind, deviceType: payload.device && payload.device.type, text: String(payload.text || '').slice(0, 100), delivered: !!sent, reason: blocked ? 'fullscreen' : sent ? '' : 'desktop-unavailable' });
          if (recentNotifications.length > 20) recentNotifications.shift();
        }
        return sent;
      },
      getSettings: () => (store ? store.getSettings() : {}),
      log: logger
    });
    deviceBridge.start();
  } catch (err) {
    deviceBridge = null;
    logger.warn('device bridge unavailable', err);
    return false;
  }
  try {
    const audio = optionalRequire('./lib/host-audio.js');
    if (audio && electron && electron.app && electron.BrowserWindow) {
      hostAudioBridge = audio.install({ electron, onMode: value => {
        if (deviceBridge) deviceBridge.ingestHostMode(value);
      } });
    }
  } catch (err) { logger.warn('audio response bridge unavailable', err); }
  try {
    // 验收调试通道（契约 §12）：payload 即契约第 3 节事件对象，生产代码不自动触发。
    if (electron && electron.ipcMain) {
      electron.ipcMain.removeListener('pet:debug', handleDeviceDebug);
      electron.ipcMain.on('pet:debug', handleDeviceDebug);
      electron.ipcMain.removeHandler('pet:debug-window');
      electron.ipcMain.handle('pet:debug-window', handleDebugWindow);
      electron.ipcMain.removeHandler('pet:debug-devices');
      electron.ipcMain.handle('pet:debug-devices', handleDebugDevices);
    }
  } catch (err) {
    logger.warn('device debug channel failed', err);
  }
  logger.info('device bridge started');
  return true;
}

function stopDeviceBridge() {
  if (hostAudioBridge) {
    try { hostAudioBridge.stop(); } catch (err) { logger.warn('audio response bridge stop failed', err); }
    hostAudioBridge = null;
  }
  // 先摘调试通道（即使 bridge 从未建起来也要摘），再释放 bridge。
  try {
    if (electron && electron.ipcMain) {
      electron.ipcMain.removeListener('pet:debug', handleDeviceDebug);
      electron.ipcMain.removeHandler('pet:debug-window');
      electron.ipcMain.removeHandler('pet:debug-devices');
    }
  } catch (err) {
    logger.warn('device debug channel detach failed', err);
  }
  if (!deviceBridge) return false;
  try {
    deviceBridge.stop();
  } catch (err) {
    logger.warn('device bridge stop failed', err);
  }
  deviceBridge = null;
  return true;
}

function pushState(options) {
  const force = !options || options.force === true;
  const now = Date.now();
  if (!force && now - lastStatePushAt < STATE_PUSH_MIN_MS) return null;
  lastStatePushAt = now;
  let state = null;
  try {
    state = buildState();
  } catch (err) {
    logger.error('buildState failed', err);
    return null;
  }
  if (petWindow) {
    try {
      petWindow.applyState(state);
    } catch (err) {
      logger.warn('petWindow.applyState failed', err);
    }
  }
  sendToPet(ipc.STATE, state);
  sendToSettings(ipc.STATE, state);
  return state;
}

function getVisible() {
  return store ? store.getSettings().visible === true : false;
}

function toggleVisible() {
  if (!store) return false;
  const next = !getVisible();
  store.patch({ visible: next });
  pushState({ force: true });
  return next;
}

function openSettings(hostWindow) {
  const target = resolveHostWindow(hostWindow);
  if (!target) {
    logger.warn('no host window available, pet settings page not opened');
    return null;
  }
  const opened = pageView ? pageView.open(target) : null;
  if (opened && pageEntry) {
    try {
      const pending = pageEntry.setHomeBar(true);
      // That call also hides the host's tab row, which moves the anchor the page starts at.
      if (pending && typeof pending.then === 'function') {
        pending.then(() => { if (pageView) pageView.fit(); }).catch(() => null);
      }
    } catch (err) {
      logger.warn('home bar injection failed', err);
    }
  }
  return opened;
}

function resetPosition() {
  if (!store) return null;
  if (roam) roam.notifyInterrupt('reset');
  const settings = store.getSettings();
  const size = petWindowModule.computeSize(settings.scale);
  const area = primaryWorkArea();
  if (!area) {
    // Nothing to reset onto: a fabricated corner is worse than leaving the window where it is.
    logger.warn('reset position skipped: no work area reported');
    return pushState({ force: true });
  }
  const target = petWindowModule.defaultPosition(size, area);
  store.patch({ position: { x: target.x, y: target.y } });
  return pushState({ force: true });
}

function applyPatch(patch) {
  if (!store) return buildState();
  const allowed = Object.keys(configModule.DEFAULT_SETTINGS).filter((key) => key !== 'position');
  const clean = {};
  if (patch && typeof patch === 'object') {
    for (let index = 0; index < allowed.length; index += 1) {
      const key = allowed[index];
      if (Object.prototype.hasOwnProperty.call(patch, key)) clean[key] = patch[key];
    }
  }
  if (patch && typeof patch === 'object' && Object.prototype.hasOwnProperty.call(patch, 'petName')) {
    const name = configModule.cleanName(patch.petName);
    const targetId = typeof patch.petNameId === 'string' ? patch.petNameId : currentPetId();
    if (name && findPet(targetId)) {
      clean.petNames = Object.assign({}, store.getSettings().petNames || {}, { [targetId]: name });
    }
  }
  // A delayed slider request must never resize a different or newly hidden pet.
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'scalePetId') &&
      (patch.scalePetId !== currentPetId() || !store.getSettings().visible)) {
    delete clean.scale;
  }
  if (Object.keys(clean).length > 0) {
    if (roam && (clean.visible === false ||
        (Object.prototype.hasOwnProperty.call(clean, 'scale') && clean.scale !== store.getSettings().scale) ||
        (clean.petId && clean.petId !== currentPetId()))) roam.notifyInterrupt('settings');
    store.patch(clean);
    if (Object.prototype.hasOwnProperty.call(clean, 'locale')) rebuildGrowth();
    if (Object.prototype.hasOwnProperty.call(clean, 'petId')) rebuildGrowth();
    if (Object.prototype.hasOwnProperty.call(clean, 'pageEntry') && pageEntry) pageEntry.refresh();
    if (Object.prototype.hasOwnProperty.call(clean, 'followInput') ||
        Object.prototype.hasOwnProperty.call(clean, 'showKeyHints')) syncInputWatcher();
    if (roam && Object.prototype.hasOwnProperty.call(clean, 'roam')) {
      if (clean.roam) {
        const action = playingAction && playingAction.action;
        if (action === 'running-left' || action === 'running-right') {
          roam.runDirection(action === 'running-left' ? 'left' : 'right');
        } else if (!store.getSettings().autoPlay) roam.forceNow();
      }
      else roam.notifyInterrupt('roam-off');
    }
  }
  return pushState({ force: true }) || buildState();
}

function closeSettings() {
  if (pageEntry) {
    try {
      pageEntry.setHomeBar(false);
    } catch (err) {
      logger.warn('home bar restore failed', err);
    }
  }
  if (!pageView) return false;
  return pageView.close();
}

function libraryFor() {
  if (!petLibrary) petLibrary = petLibraryModule.createLibrary({
    root: petsModule.defaultPetsDir(),
    validateImage: imageValidatorModule.createValidator(electron)
    /* 下载由 pet-library 内部统一处理：Chromium → Node → 系统 curl 三级兜底。 */
  });
  return petLibrary;
}

async function managePet(event, payload, removing) {
  // Only the local settings document may change the pet library.
  const expected = require('url').pathToFileURL(path.join(__dirname, 'renderer/settings/index.html')).href;
  if (!event || !event.sender || event.sender.getURL().split(/[?#]/)[0] !== expected) return { ok: false, error: 'unavailable' };
  let ownedImport = null;
  try {
    let result;
    let context;
    if (!removing) {
      if (activeImport) return { ok: false, error: 'busy' };
      activeImport = { controller: new AbortController(), sender: event.sender, id: String(payload && payload.requestId || ''), stage: '' };
      ownedImport = activeImport;
      const operation = activeImport;
      context = { signal: operation.controller.signal, onProgress: data => {
        operation.stage = data.stage;
        if (!event.sender.isDestroyed || !event.sender.isDestroyed()) event.sender.send(ipc.IMPORT_PROGRESS, { ...data, requestId: operation.id });
      } };
    }
    if (removing) {
      const target = findPet(payload && payload.id);
      if (!target) return { ok: false, error: 'not-found' };
      persistGrowth();
      const profile = store.getSettings();
      result = await libraryFor().remove(target, { name: profile.petNames[target.id] || target.displayName, growth: profile.growthProfiles[target.id] });
      const previous = store.getSettings();
      const names = { ...previous.petNames }, profiles = { ...previous.growthProfiles };
      delete names[target.id]; delete profiles[target.id];
      const patch = { petNames: names, growthProfiles: profiles };
      if (previous.petId === target.id) {
        if (roam) roam.notifyInterrupt('delete');
        const alternative = pets.find(pet => pet.id !== target.id);
        patch.petId = alternative ? alternative.id : '';
        patch.visible = !!alternative && previous.visible;
        patch.action = 'idle';
        playingAction = null;
      }
      store.patch(patch);
    } else if (payload && payload.method === 'folder') {
      const picked = await electron.dialog.showOpenDialog({ properties: ['openDirectory'] });
      if (picked.canceled || !picked.filePaths.length) return { ok: false, cancelled: true };
      result = await libraryFor().importFolder(picked.filePaths[0], context);
    } else if (payload && payload.method === 'command') {
      result = await libraryFor().importCommand(payload.command, context);
    } else return { ok: false, error: 'bad-command' };
    const before = currentPetId();
    petsScanStamp = null;
    refreshPets();
    if (removing || before !== currentPetId()) rebuildGrowth();
    return { ok: true, ...result, state: pushState({ force: true }) || buildState() };
  } catch (error) {
    if (error.code === 'cancelled') return { ok: false, cancelled: true };
    logger.warn('pet library operation failed', error, error && error.cause ? ('cause=' + (error.cause.code || error.cause.message)) : '');
    const codes = { EPERM: 'no-permission', EACCES: 'no-permission', ENOENT: 'not-found', EBUSY: 'busy', ENOSPC: 'no-space' };
    return { ok: false, error: codes[error.code] || error.code || 'unknown', id: error.id };
  } finally { if (ownedImport && activeImport === ownedImport) activeImport = null; }
}

function settingsSender(event) {
  const expected = require('url').pathToFileURL(path.join(__dirname, 'renderer/settings/index.html')).href;
  return !!(event && event.sender && event.sender.getURL().split(/[?#]/)[0] === expected);
}

function diagnostics() {
  const settings = store ? store.getSettings() : {};
  const raw = deviceBridge ? deviceBridge.state() : {};
  return { version: PLUGIN_VERSION, build: BUILD_INFO,
    channel: channelHealth, audio: hostAudioBridge && hostAudioBridge.state ? hostAudioBridge.state() : null,
    devices: raw.host && raw.host.devices ? raw.host.devices.map(d => ({ name: d.name, type: d.deviceType })) : [],
    lastMessageAt: raw.host ? raw.host.lastUpdateAt : 0,
    reasons: [!settings.deviceNotify && 'notifications-off', settings.quietMode && 'quiet', isFullscreenSuppressed() && 'fullscreen', !settings.bubbles && 'bubbles-off', (!settings.visible || settings.scale === 0) && 'hidden'].filter(Boolean),
    preferences: { keyboard: settings.notifyKeyboard, mouse: settings.notifyMouse, audio: settings.notifyHeadset, battery: settings.notifyBattery },
    recent: recentNotifications.slice(), adapter: raw.notifications || null, perf: lastPerfStatus };
}

async function manageTools(event, payload) {
  if (!settingsSender(event)) return { ok: false, error: 'unavailable' };
  try {
    if (!backupManager) backupManager = require('./lib/friend-backup.js').createBackupManager({ root: petsModule.defaultPetsDir(), validateImage: imageValidatorModule.createValidator(electron) });
    const action = payload && payload.action;
    if (action === 'trash-list') return { ok: true, items: await libraryFor().listTrash() };
    if (action === 'trash-restore') {
      const record = await libraryFor().restoreTrash(payload.token), old = store.getSettings();
      store.patch({ petNames: { ...old.petNames, [record.id]: record.name }, growthProfiles: { ...old.growthProfiles, ...(record.growth ? { [record.id]: record.growth } : {}) } });
      petsScanStamp = null; refreshPets(); rebuildGrowth();
      return { ok: true, state: pushState({ force: true }) || buildState() };
    }
    if (action === 'backup-export') {
      const picked = await electron.dialog.showSaveDialog({ defaultPath: 'Friends-' + new Date().toISOString().slice(0, 10) + '.friend-backup', filters: [{ name: 'Friend backup', extensions: ['friend-backup'] }] });
      if (picked.canceled || !picked.filePath) return { ok: false, cancelled: true };
      persistGrowth();
      return { ok: true, ...await backupManager.exportFile(picked.filePath, store.getSettings(), PLUGIN_VERSION) };
    }
    if (action === 'backup-prepare') {
      if (activeBackup) return { ok: false, error: 'busy' };
      const controller = new AbortController(); activeBackup = controller;
      try {
        const picked = await electron.dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Friend backup', extensions: ['friend-backup'] }] });
        if (picked.canceled || !picked.filePaths.length || controller.signal.aborted) return { ok: false, cancelled: true };
        return { ok: true, ...await backupManager.prepare(picked.filePaths[0], { signal: controller.signal }) };
      } finally { if (activeBackup === controller) activeBackup = null; }
    }
    if (action === 'backup-cancel') { if (activeBackup) activeBackup.abort(); else await backupManager.discard(); return { ok: true }; }
    if (action === 'backup-commit') {
      persistGrowth(); const previous = store.getSettings();
      const result = await backupManager.commit(payload.token, async restored => {
        try {
          store.patch({ ...restored, position: previous.position, petNames: { ...previous.petNames, ...restored.petNames }, growthProfiles: { ...previous.growthProfiles, ...restored.growthProfiles } });
          if (!store.flush()) throw Object.assign(new Error('settings save failed'), { code: 'no-permission' });
        } catch (error) { store.patch(previous); store.flush(); throw error; }
      });
      if (roam) roam.notifyInterrupt('restore');
      petsScanStamp = null; refreshPets(); playingAction = null; rebuildGrowth(); syncInputWatcher();
      if (pageEntry) { try { pageEntry.refresh(); } catch (error) { logger.warn('restored home entry refresh failed', error); } }
      return { ok: true, ...result, state: pushState({ force: true }) || buildState() };
    }
    if (action === 'diagnostics-export') {
      const picked = await electron.dialog.showSaveDialog({ defaultPath: 'Friend-diagnostics.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (picked.canceled || !picked.filePath) return { ok: false, cancelled: true };
      // Deliberately omit local paths, identifiers, accounts and arbitrary logs.
      const report = diagnostics(); report.recent = report.recent.map(({ at, kind, deviceType, delivered, reason }) => ({ at, kind, deviceType, delivered, reason }));
      await fs.promises.writeFile(picked.filePath, JSON.stringify(report, null, 2)); return { ok: true };
    }
    return { ok: false, error: 'bad-command' };
  } catch (error) { if (error.code === 'cancelled') return { ok: false, cancelled: true }; logger.warn('Friend management failed', error); return { ok: false, error: error.code || 'unknown' }; }
}

function playAction(payload) {
  if (payload && payload.petId && payload.petId !== currentPetId()) return false;
  const action = payload && typeof payload.action === 'string' ? payload.action : null;
  if (!action) return false;
  // End the previous route before delivering the new manual pose. Reversing a
  // running action must reverse the route too; its old end event must arrive first.
  if (roam && roam.state().active) roam.notifyInterrupt('manual-action');
  const once = payload && payload.once === true;
  if (!once) playingAction = { petId: currentPetId(), action };
  if (store && !once) store.patch({ action });
  const sent = sendToPet(ipc.PLAY, { action, once });
  if (!once) pushState({ force: true });
  return sent;
}

function awardInteraction() {
  if (!growth || typeof growth.addXp !== 'function') return;
  const before = Number.isFinite(growth.level) ? growth.level : null;
  let awarded = true;
  try {
    awarded = growth.addXp(GROWTH_AWARD, Date.now());
  } catch (err) {
    logger.warn('growth.addXp failed', err);
    return;
  }
  if (awarded === false) return;
  persistGrowth();
  const after = Number.isFinite(growth.level) ? growth.level : null;
  if (before !== null && after !== null && after > before) {
    const mod = getGrowthModule();
    const duration = mod && Number.isFinite(mod.LEVELUP_MS) ? mod.LEVELUP_MS : LEVEL_UP_FALLBACK_MS;
    sendToPet(ipc.LEVELUP, { level: after, until: Date.now() + duration });
  }
  pushState();
}

function growthLevel() {
  const view = normalizeGrowthView(getGrowthSnapshot());
  return Number.isFinite(view.level) && view.level > 0 ? view.level : 1;
}

function levelUpDuration() {
  const mod = getGrowthModule();
  return mod && Number.isFinite(mod.LEVELUP_MS) ? mod.LEVELUP_MS : LEVEL_UP_FALLBACK_MS;
}

function emitLevelUp(level) {
  const payload = { level, until: Date.now() + levelUpDuration() };
  sendToPet(ipc.LEVELUP, payload);
  logger.info('preview levelup level=' + level);
  return payload;
}

function previewLevelUp(payload) {
  if (!petWindow || !petWindow.isVisible()) return null;
  if (payload && payload.petId && payload.petId !== currentPetId()) return null;
  const level = Math.min(GROWTH_MAX_LEVEL, growthLevel() + 1);
  const effect = emitLevelUp(level);
  return { level: effect.level, delayed: false, until: effect.until };
}

function followInputEnabled() {
  try {
    const settings = store ? store.getSettings() : configModule.createDefaultSettings();
    return settings.followInput !== false;
  } catch (err) {
    return true;
  }
}

function keyHintsEnabled() {
  try {
    const settings = store ? store.getSettings() : configModule.createDefaultSettings();
    return settings.showKeyHints !== false;
  } catch (err) {
    return true;
  }
}

// 按键提示和跟随输入是两件事：任一需要就必须采样，否则关掉跟随输入会连带打死按键气泡。
function inputWanted() {
  return followInputEnabled() || keyHintsEnabled();
}

function forwardInput(label, at, kind) {
  // A8: 采样只在 followInput 或 showKeyHints 需要时发生；经验仍然只跟 followInput 走。
  if (!inputWanted()) return;
  const safeLabel = clampLabel(label);
  if (!safeLabel) return;
  if (followInputEnabled()) awardInteraction();
  sendToPet(ipc.INPUT, { label: safeLabel, at: Number.isFinite(at) ? at : Date.now(), kind });
}

function forwardMove(dx, dy) {
  if (!Number.isFinite(dx)) return;
  // A8: same gate as forwardInput, and it cannot throw: this runs inside the watcher's 30ms timer,
  // where an exception would escape into the host's process hooks.
  if (!followInputEnabled()) return;
  if (Math.abs(dx) < MOVE_MIN_PX) return;
  sendToPet(ipc.INPUT, {
    kind: 'move',
    dx: Math.round(dx),
    dy: Number.isFinite(dy) ? Math.round(dy) : 0
  });
}

function startInputWatcher() {
  const mod = optionalRequire('./lib/input.js');
  if (!mod || typeof mod.createInputWatcher !== 'function') {
    logger.warn('lib/input.js unavailable, input watching disabled');
    return null;
  }
  let watcher = null;
  try {
    watcher = mod.createInputWatcher({
      onKey: (label, at) => forwardInput(label, at, 'key'),
      onMouseDown: (label, at) => forwardInput(label, at, 'mouse'),
      onMouseMove: (dx, dy) => forwardMove(dx, dy)
    });
    // A8: with followInput off the 30ms koffi poll never starts. The watcher object is kept so
    // availability still reports honestly and flipping the setting back on needs no reboot.
    if (watcher && typeof watcher.start === 'function' && inputWanted()) watcher.start();
  } catch (err) {
    logger.warn('input watcher failed to start', err);
    return null;
  }
  let available = false;
  try {
    available = !!(watcher && typeof watcher.isAvailable === 'function' && watcher.isAvailable());
  } catch (err) {
    logger.warn('input watcher isAvailable failed at start', err);
  }
  logger.info('input watcher ready, running=' + inputWanted() + ', followInput=' + followInputEnabled() +
    ', keyHints=' + keyHintsEnabled() + ', available=' + available);
  return watcher;
}

// A8: applyPatch calls this when followInput or showKeyHints flips - nothing wants input, park the loop.
function syncInputWatcher() {
  if (!inputWanted()) {
    if (!inputWatcher) return false;
    try {
      if (typeof inputWatcher.stop === 'function') inputWatcher.stop();
    } catch (err) {
      logger.warn('input watcher stop failed', err);
      return false;
    }
    logger.info('input watcher stopped: followInput and key hints both off');
    return false;
  }
  if (!inputWatcher) {
    if (!booted) return false;
    inputWatcher = startInputWatcher();
    return inputWatcher !== null;
  }
  try {
    if (typeof inputWatcher.start === 'function') inputWatcher.start();
  } catch (err) {
    logger.warn('input watcher restart failed', err);
    return false;
  }
  return true;
}

const DISPLAY_EVENTS = ['display-added', 'display-removed', 'display-metrics-changed'];
let displayEventsBound = false;

function handleDisplayChange() {
  logger.info('display topology changed, re-clamping windows');
  pushState({ force: true });
  if (pageView) {
    try {
      pageView.fit();
    } catch (err) {
      logger.warn('page view refit failed', err);
    }
  }
}

function subscribeDisplayEvents() {
  const screen = electron && electron.screen;
  if (!screen || typeof screen.on !== 'function' || displayEventsBound) return false;
  displayEventsBound = true;
  for (let index = 0; index < DISPLAY_EVENTS.length; index += 1) {
    try {
      screen.on(DISPLAY_EVENTS[index], handleDisplayChange);
    } catch (err) {
      logger.warn('subscribe ' + DISPLAY_EVENTS[index] + ' failed', err);
    }
  }
  return true;
}

function unsubscribeDisplayEvents() {
  const screen = electron && electron.screen;
  if (!screen || typeof screen.removeListener !== 'function' || !displayEventsBound) return;
  displayEventsBound = false;
  for (let index = 0; index < DISPLAY_EVENTS.length; index += 1) {
    try {
      screen.removeListener(DISPLAY_EVENTS[index], handleDisplayChange);
    } catch (err) {
      logger.warn('unsubscribe ' + DISPLAY_EVENTS[index] + ' failed', err);
    }
  }
}

function registerIpc() {
  if (!electron || !electron.ipcMain) {
    logger.warn('ipcMain unavailable, IPC disabled');
    return false;
  }
  const ipcMain = electron.ipcMain;

  // A3: every invoke has to settle. A handler that throws - or returns a promise that rejects -
  // falls back to a snapshot that cannot throw, so the renderer never sees a rejected invoke.
  function handle(channel, handler, onError) {
    const recover = typeof onError === 'function' ? onError : safeStateSnapshot;
    settingsHandlers.set(channel, async (event,payload) => { try { return await handler(event,payload); } catch (_) { return recover(); } });
    try {
      ipcMain.handle(channel, async (event, payload) => {
        try {
          return await handler(event, payload);
        } catch (err) {
          logger.error('ipc handle threw: ' + channel, err);
          return recover();
        }
      });
    } catch (err) {
      logger.warn('ipcMain.handle failed: ' + channel, err);
    }
  }

  function on(channel, handler) {
    try {
      ipcMain.on(channel, (event, payload) => {
        try {
          handler(event, payload);
        } catch (err) {
          logger.error('ipc listener threw: ' + channel, err);
        }
      });
    } catch (err) {
      logger.warn('ipcMain.on failed: ' + channel, err);
    }
  }

  function replyState(event) {
    try {
      if (event && event.sender && !event.sender.isDestroyed()) event.sender.send(ipc.STATE, buildState());
    } catch (err) {
      logger.warn('reply state failed', err);
    }
  }

  handle(ipc.GET_STATE, () => {
    const previousId = currentPetId();
    refreshPets();
    if (previousId !== currentPetId()) rebuildGrowth();
    return buildState();
  });
  handle(ipc.UPDATE, (event, patch) => applyPatch(patch));
  handle(ipc.RESET_POSITION, () => resetPosition() || buildState());
  handle(ipc.CLOSE, () => closeSettings());
  handle(ipc.PLAY, (event, payload) => playAction(payload));
  handle(ipc.PREVIEW_LEVELUP, (event, payload) => previewLevelUp(payload));
  handle(ipc.SELECT, (event, payload) => selectPet(payload && payload.id, payload));
  handle(ipc.DELETE, (event, payload) => managePet(event, payload, true), () => ({ ok: false, error: 'unknown' }));
  handle(ipc.IMPORT, (event, payload) => managePet(event, payload, false), () => ({ ok: false, error: 'unknown' }));
  handle(ipc.IMPORT_CANCEL, (event, payload) => {
    if (!settingsSender(event) || !activeImport || activeImport.sender !== event.sender || activeImport.id !== String(payload && payload.requestId || '')) return { ok: false };
    if (activeImport.stage === 'installing') return { ok: false, finishing: true };
    activeImport.controller.abort(); return { ok: true };
  });
  handle(ipc.MANAGE, manageTools, () => ({ ok: false, error: 'unknown' }));
  handle(ipc.DIAGNOSTICS, event => settingsSender(event) ? { ok: true, data: diagnostics() } : { ok: false });
  handle(ipc.RECONNECT, event => {
    if (!settingsSender(event)) return { ok: false };
    channelHealth = { state: 'connecting', reason: '', at: Date.now() };
    sendToPet(ipc.RECONNECT); return { ok: true };
  });
  handle(ipc.QUALITY_RETRY, event => settingsSender(event) && sendToPet(ipc.QUALITY_RETRY));

  on(ipc.GET_STATE, (event) => replyState(event));
  on(ipc.UPDATE, (event, patch) => {
    applyPatch(patch);
    replyState(event);
  });
  on(ipc.RESET_POSITION, (event) => {
    resetPosition();
    replyState(event);
  });
  on(ipc.CLOSE, () => closeSettings());
  on(ipc.PLAY, (event, payload) => playAction(payload));
  on(ipc.PREVIEW_LEVELUP, (event, payload) => previewLevelUp(payload));
  on(ipc.SELECT, (event, payload) => {
    selectPet(payload && payload.id, payload);
  });

  on(ipc.READY, (event) => replyState(event));
  on(ipc.HOST_STATE, (event, payload) => {
    const win = petWindow && petWindow.getWindow();
    if (win && event.sender === win.webContents && deviceBridge) deviceBridge.ingestHostState(payload);
  });
  on(ipc.CHANNEL_STATUS, (event, payload) => {
    const win = petWindow && petWindow.getWindow();
    if (!win || event.sender !== win.webContents || !payload || !['connecting', 'connected', 'retrying', 'failed', 'disconnected'].includes(payload.state)) return;
    channelHealth = { state: payload.state, reason: payload.reason === 'initial-read' ? payload.reason : '', at: Date.now() };
  });
  on(ipc.ACTION_CURRENT, (event, payload) => {
    const win = petWindow && petWindow.getWindow();
    if (!win || !event || event.sender !== win.webContents || !payload || payload.petId !== currentPetId()) return;
    if (!getActions().some(action => action.id === payload.action)) return;
    const changed = !playingAction || playingAction.petId !== payload.petId || playingAction.action !== payload.action;
    playingAction = { petId: payload.petId, action: payload.action };
    if (roam) {
      const directional = payload.action === 'running-left' || payload.action === 'running-right';
      const direction = payload.action === 'running-left' ? 'left' : 'right';
      const active = roam.state();
      // All action sources count, including hover, keyboard and device feedback.
      if (active.active && (!directional || active.dir !== direction)) roam.notifyInterrupt(directional ? 'direction' : 'action');
      if (directional && payload.kind !== 'roam' && payload.kind !== 'follow' && payload.source !== 'drag') {
        // No forced minimum: the walk keeps its design speed (90px/s), so the run lasts
        // distance/90s instead of being stretched into a 20s crawl (docs/P0-CONTRACT.md 「7 漫游规格」:101).
        roam.runDirection(payload.action === 'running-left' ? 'left' : 'right');
      }
    }
    if (changed) pushState();
  });
  on(ipc.DRAG_START, () => {
    // The pointer owns the window from here: any roam in flight stops before its next 16ms step.
    if (roam) roam.notifyInterrupt('drag');
    if (petWindow) petWindow.beginDrag();
  });
  on(ipc.DRAG_MOVE, (event, payload) => {
    if (!petWindow || !payload) return;
    petWindow.moveBy(payload.dx, payload.dy);
  });
  on(ipc.DRAG_END, (event, payload) => {
    if (!petWindow) return;
    petWindow.endDrag(payload);
    pushState({ force: true });
  });
  on(ipc.CONTEXT, () => openSettings());
  on(ipc.ACTION_DONE, (event, payload) => {
    logger.debug('action done: ' + (payload && payload.action));
  });
  handle(ipc.HD_CACHE, (event, payload) => {
    const request = payload && typeof payload === 'object' ? payload : {};
    if (!hdCache) return { url: null, ok: false, bytes: 0 };
    if (request.action === 'get') return hdCache.get(request.key);
    if (request.action === 'put') return hdCache.put(request.key, request.dataUrl);
    if (request.action === 'drop') return hdCache.drop(request.key);
    logger.warn('hd cache: unknown action ' + request.action);
    return { ok: false };
  }, () => ({ ok: false, url: null, bytes: 0 }));
  on(ipc.PERF, (event, payload) => relayPerfStatus(payload));

  logger.info('ipc channels registered');
  return true;
}

function boot() {
  if (booted) return false;
  booted = true;
  if (!electron || !electron.app) {
    logger.warn('electron unavailable, pet-hub stays idle');
    return false;
  }
  logger.attach(loggerModule.defaultFilePath(electron));
  inlinePageModule.installProtocol(electron);
  const filePath = configModule.defaultFilePath(electron);
  store = configModule.createStore(filePath, { logger });
  const loaded = store.load();
  logger.info('store loaded: ' + filePath + ' visible=' + loaded.settings.visible + ' petId=' + loaded.settings.petId);
  try {
    hdCache = hdCacheModule.create({ userData: electron.app.getPath('userData'), logger: logger });
    logger.info('hd cache dir: ' + hdCache.stats().dir);
  } catch (err) {
    hdCache = null;
    logger.warn('hd cache unavailable', err);
  }
  scanPetsNow();
  resolvePetId();
  // Missing packs after a host upgrade keep their names and growth for reimport.
  ensureGrowth();
  petWindow = petWindowModule.createPetWindow({
    electron,
    store,
    logger,
    // The release slide settles asynchronously; refresh bounds/edge once it stops.
    onDragSettled: () => {
      pushState({ force: true });
    },
    onReady: () => {
      sendToPet(ipc.STATE, buildState());
    }
  });
  try {
    fullscreenWatch = fullscreenWatchModule.createFullscreenWatch({
      log: { warn: (line) => logger.warn(line) }
    });
    fullscreenWatch.start();
  } catch (err) {
    fullscreenWatch = null;
    logger.warn('fullscreen watch unavailable', err);
  }
  roam = petRoamModule.createRoam({
    actionDriven: true,
    getAction: () => playingAction && playingAction.action,
    // Walk length comes from the distance at 90px/s; no fixed minimum duration.
    getWindow: () => (petWindow ? petWindow.getWindow() : null),
    getWorkAreaFor: () => (petWindow ? petWindow.getWorkArea() : null),
    getAllAreas: allWorkAreas,
    getSettings: () => (store ? store.getSettings() : {}),
    isBlocked: () => {
      if (!petWindow) return false;
      const dragging = petWindow.isDragging() === true;
      const sliding = typeof petWindow.hasInertia === 'function' && petWindow.hasInertia() === true;
      return dragging || sliding;
    },
    isSuppressed: () => isFullscreenSuppressed(),
    onRoam: (payload) => {
      const active = payload && payload.active === true;
      if (petWindow) {
        // A11: a roam that stopped because the pointer took the window must not persist the spot
        // it stopped at - the drag owns the position until it settles.
        const held = petWindow.isDragging() === true ||
          (typeof petWindow.hasInertia === 'function' && petWindow.hasInertia() === true);
        petWindow.setRoaming(active, { persist: !held });
      }
      sendToPet(ipc.ROAM, payload);
      if (!active) pushState({ force: true });
    },
    log: (level, message, error) => {
      const sink = logger[level] || logger.info;
      if (typeof sink === 'function') sink('[pet-roam] ' + message, error);
    }
  });
  roam.start();
  startDeviceBridge();
  pageView = pageViewModule.createPageView({
    onClose: () => {
      if (pageEntry) pageEntry.setHomeBar(false).catch((err) => logger.warn('host navigation restore failed', err));
    },
    electron,
    logger,
    resolveHostWindow,
    showHostWindow: revealHostWindow,
    onShow: () => {
      pushState({ force: true });
      if (lastPerfStatus) relayPerfStatus(lastPerfStatus);
    }
  });
  pageView = inlinePageModule.createInlinePage({ fallback: pageView, getTransitionPet: () => { const next=safeStateSnapshot();const pet=next.pets.find(p=>p.id===next.settings.petId)||next.pets[0];return {atlasUrl:pet&&pet.atlasUrl,fallbackAtlasUrl:pet&&pet.fallbackAtlasUrl,locale:next.settings.locale}; }, dispatch: (channel,event,payload) => { const handler=settingsHandlers.get(channel); if (!handler) throw Error('unsupported channel'); return handler(event,payload); }, onClose: () => {
    if(activeImport&&activeImport.stage!=='installing')activeImport.controller.abort();
    if(activeBackup)activeBackup.abort();
    if(backupManager)backupManager.discard().catch(()=>{});
    if(pageEntry)pageEntry.setHomeBar(false).catch(()=>{});
  } });
  trayHook = trayModule.installTrayHook({
    electron,
    logger,
    getVisible,
    toggleVisible,
    openSettings,
    resetPosition
  });
  hotkeys = hotkeyModule.registerHotkeys({
    electron,
    logger,
    toggleVisible,
    openSettings
  });
  registerIpc();
  subscribeDisplayEvents();
  pageEntry = pageEntryModule.install({
    electron,
    logger,
    openSettings,
    closeSettings,
    isEnabled: () => (store ? store.getSettings().pageEntry !== false : true),
    // The page is a native view stacked above the shell, so it hides while the shell draws a
    // tooltip or menu over it and comes back as soon as that layer is gone. setVisible already
    // ignores the call when no view is attached, so no extra open-state guard here.
    onOverlay: (covered) => {
      if (!pageView) return;
      try {
        pageView.setVisible(covered !== true);
      } catch (err) {
        logger.warn('overlay visibility switch failed', err);
      }
    },
    // Only real interactive layers (menus, dialogs, drawers) push the page away now; header
    // tooltips are redrawn by the page itself so hovering an icon never makes it disappear.
    onHostTip: (payload) => {
      if (!pageView) return;
      try {
        pageView.send(ipc.HOST_TIP, payload || null);
      } catch (err) {
        logger.warn('host tip relay failed', err);
      }
    }
  });
  logger.info('page entry installed, existing windows=' + pageEntry.attachedCount());
  inputWatcher = startInputWatcher();
  pushState({ force: true });
  logger.info('pet-hub booted');
  return true;
}

function teardown() {
  if (teardownDone) return;
  teardownDone = true;
  removeProcessHooks();
  unsubscribeDisplayEvents();
  stopDeviceBridge();
  if (pageEntry) {
    try {
      pageEntry.dispose();
    } catch (err) {
      logger.warn('page entry dispose failed', err);
    }
    pageEntry = null;
  }
  if (hotkeys) {
    try {
      hotkeys.dispose();
    } catch (err) {
      logger.warn('hotkey dispose failed', err);
    }
    hotkeys = null;
  }
  if (inputWatcher && typeof inputWatcher.stop === 'function') {
    try {
      inputWatcher.stop();
    } catch (err) {
      logger.warn('input watcher stop failed', err);
    }
  }
  inputWatcher = null;
  if (fullscreenWatch) {
    try {
      fullscreenWatch.stop();
    } catch (err) {
      logger.warn('fullscreen watch stop failed', err);
    }
    fullscreenWatch = null;
  }
  if (roam) {
    try {
      roam.stop();
    } catch (err) {
      logger.warn('roam stop failed', err);
    }
    roam = null;
  }
  if (petWindow) {
    try {
      petWindow.destroy();
    } catch (err) {
      logger.warn('pet window destroy failed', err);
    }
    petWindow = null;
  }
  if (pageView) {
    try {
      pageView.dispose();
    } catch (err) {
      logger.warn('page view dispose failed', err);
    }
    pageView = null;
  }
  if (store) {
    try {
      persistGrowth();
    } catch (err) {
      logger.warn('persist growth failed', err);
    }
    try {
      store.dispose();
    } catch (err) {
      logger.warn('store dispose failed', err);
    }
    store = null;
  }
  logger.info('pet-hub shutdown');
  logger.flush();
}

function logProcessEvent(message, detail) {
  try {
    logger.error(message, detail);
  } catch (logErr) {
    // Logging must never be the reason a crash happens.
  }
}

// A9: these hooks are a host fallback, not a safety net the plugin adds on top of the host. They
// are installed only when the host has no listener of its own, and they log and then get out of
// the way: as the only listener they unhook themselves and rethrow, so Node's - or the host's -
// crash semantics stay intact instead of the plugin silently keeping a broken host alive.
// teardown() removes whatever the plugin installed.
function removeProcessHooks() {
  if (!processHooks) return false;
  const hooks = processHooks;
  processHooks = null;
  try {
    if (hooks.uncaught) process.removeListener('uncaughtException', hooks.uncaught);
    if (hooks.rejection) process.removeListener('unhandledRejection', hooks.rejection);
  } catch (err) {
    logger.warn('process hook removal failed', err);
    return false;
  }
  return true;
}

function installProcessFallbackHooks() {
  if (processHooks) return false;
  const hooks = { uncaught: null, rejection: null };
  if (process.listenerCount('uncaughtException') === 0) {
    hooks.uncaught = (err) => {
      const hostOwns = process.listenerCount('uncaughtException') > 1;
      logProcessEvent(hostOwns ? 'uncaughtException (host listener present, plugin logs only)' : 'uncaughtException (plugin fallback, rethrowing)', err);
      if (hostOwns) return;
      removeProcessHooks();
      throw err;
    };
    try {
      process.on('uncaughtException', hooks.uncaught);
    } catch (err) {
      hooks.uncaught = null;
      logger.warn('uncaughtException hook failed', err);
    }
  }
  if (process.listenerCount('unhandledRejection') === 0) {
    hooks.rejection = (reason) => {
      const hostOwns = process.listenerCount('unhandledRejection') > 1;
      logProcessEvent(hostOwns ? 'unhandledRejection (host listener present, plugin logs only)' : 'unhandledRejection (plugin fallback, rethrowing)', reason);
      if (hostOwns) return;
      removeProcessHooks();
      throw reason instanceof Error ? reason : new Error('unhandledRejection: ' + String(reason));
    };
    try {
      process.on('unhandledRejection', hooks.rejection);
    } catch (err) {
      hooks.rejection = null;
      logger.warn('unhandledRejection hook failed', err);
    }
  }
  if (!hooks.uncaught && !hooks.rejection) return false;
  processHooks = hooks;
  logger.info('process fallback hooks installed: ' +
    (hooks.uncaught ? 'uncaughtException' : 'unhandledRejection only'));
  return true;
}

function installEarlyHooks() {
  installProcessFallbackHooks();
  if (!electron || !electron.app) return;
  try {
    electron.app.on('before-quit', () => {
      try {
        teardown();
      } catch (err) {
        logger.error('teardown failed', err);
      }
    });
  } catch (err) {
    logger.warn('before-quit hook failed', err);
  }
  try {
    if (electron.Tray && electron.Menu) {
      trayHook = trayModule.installTrayHook({
        electron,
        logger,
        getVisible,
        toggleVisible,
        openSettings,
        resetPosition
      });
    }
  } catch (err) {
    logger.warn('early tray hook install failed', err);
  }
  try {
    if (typeof electron.app.whenReady === 'function') {
      const ready = electron.app.whenReady();
      if (ready && typeof ready.then === 'function') {
        ready
          .then(() => {
            try {
              boot();
            } catch (err) {
              logger.error('boot failed', err);
            }
          })
          .catch((err) => logger.error('whenReady rejected', err));
      }
    }
  } catch (err) {
    logger.error('whenReady unavailable, pet-hub stays idle', err);
  }
}

try {
  installEarlyHooks();
} catch (err) {
  try {
    logger.error('pet-hub init failed', err);
  } catch (logErr) {}
}

module.exports = {
  ipc,
  config: configModule,
  logger,
  buildState,
  pushState,
  boot,
  teardown,
  toggleVisible,
  openSettings,
  resetPosition,
  playAction,
  awardInteraction,
  previewLevelUp,
  selectPet,
  refreshPets,
  handleDisplayChange,
  fallbackBounds,
  isElectronAvailable: () => !!electron,
  debug: {
    FALLBACK_ACTIONS,
    FALLBACK_MAX_XP,
    fallbackSnapshot,
    fallbackXpForLevel,
    createFallbackGrowth,
    normalizeActions,
    clampLabel,
    degradedState,
    safeStateSnapshot,
    petsScanStats: () => ({ runs: petsScanRuns, hits: petsScanHits, stamp: petsScanStamp })
  }
};
