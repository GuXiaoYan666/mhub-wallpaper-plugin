'use strict';

const { ipcRenderer } = require('electron');
const IPC = require('../../lib/ipc.js');
const i18n = require('./i18n.js');
// Resource IO stays in the main process; this page owns interaction only.
const petManage = window.petManage;

const ACTION_IDS = ['idle', 'running-right', 'running-left', 'waving', 'jumping', 'failed', 'waiting', 'running', 'review'];
const TOGGLE_KEYS = ['followInput', 'showKeyHints', 'showLevel', 'autoPlay', 'alwaysOnTop', 'clickThrough', 'sharpRender', 'smartInterp'];
const PERF_STATUS_FIELDS = { sharpRender: 'sharp', smartInterp: 'interp' };
// 补帧档位＝源帧率的整数倍（×2/×3/×4）：固定目标帧率与源帧时长对不齐会让插值格数抖动，
// 出现果冻感。老配置只存了 smartInterpFps，按 24→×2 / 30→×3 / 60→×4 折算。
const INTERP_MULT_OPTIONS = [2, 3, 4];
const DEFAULT_INTERP_MULT = 3;
const LEGACY_INTERP_FPS_MULT = { 24: 2, 30: 3, 60: 4 };

// 设置页右栏的声明式行表：分组标题 + 行（bool / choice）全由它生成，
// 新增开关只需在这里加一条，DOM 与 i18n 取键都跟着走。第一组就是原来的 8 个显示开关，
// TOGGLE_KEYS 原样保留（外部代码可能引用，前 8 项顺序不可变）。
const BUBBLE_MS_OPTIONS = [2500, 3500, 5000];
const BUBBLE_MS_DEFAULT = 3500;

// 页签 4 的从属行：主开关 deviceNotify 打开时才出现，缩进 + 紧凑高度（.toggle.is-sub）。
const DEPENDENT_OF = {
  groundShadow: 'characterLighting',
  lightStrength: 'characterLighting',
  notifyKeyboard: 'deviceNotify',
  notifyMouse: 'deviceNotify',
  notifyHeadset: 'deviceNotify',
  notifyBattery: 'deviceNotify'
};

// 自解释的行不渲染第二行说明（行高 49px -> 32px）；需要解释的只留一句话短句。
const NO_DESC_KEYS = ['showKeyHints', 'showLevel', 'alwaysOnTop', 'clickThrough', 'deviceNotify'];
const DESKTOP_TAB_KEYS = ['followInput', 'showKeyHints', 'showLevel', 'autoPlay', 'alwaysOnTop', 'clickThrough'];

function boolRow(key, tab) {
  return {
    key: key,
    labelKey: key,
    descKey: DEPENDENT_OF[key] || NO_DESC_KEYS.indexOf(key) >= 0 ? null : key + 'Desc',
    kind: 'bool',
    tab: tab || 'desktop',
    parent: DEPENDENT_OF[key] || null
  };
}

// 顶部页签：一次只显示一组的行，省掉原来的「显示设置」标题行，让每组一屏放得下。
const TAB_IDS = ['fun', 'desktop', 'device', 'quality'];
let activeTab = TAB_IDS[0];
let visibleRowKeys = [];
const tabViews = { list: null, buttons: [] };

const ROW_GROUPS = [
  // 界面语言：唯一一个字符串取值的选择行，放在桌面页签最前面。
  {
    id: 'language',
    titleKey: 'locale',
    tab: 'desktop',
    suppressTitle: true,
    rows: [
      {
        key: 'locale',
        labelKey: 'locale',
        kind: 'choice',
        tab: 'desktop',
        options: i18n.LOCALES,
        optionKeys: { zh: 'localeZh', en: 'localeEn' },
        defaultValue: i18n.DEFAULT_LOCALE
      }
    ]
  },
  // 顶上是页签，分组标题让位给页签标签；只剩 device 那组还在页签内当分节小标题（caption）。
  {
    id: 'display',
    titleKey: 'displayGroupTitle',
    tab: 'desktop',
    suppressTitle: true,
    rows: TOGGLE_KEYS.filter(key => key !== 'smartInterp').map(function (key) {
      return boolRow(key, DESKTOP_TAB_KEYS.indexOf(key) >= 0 ? 'desktop' : 'quality');
    })
  },
  {
    id: 'lighting', titleKey: 'tabQuality', tab: 'quality', suppressTitle: true,
    rows: [boolRow('characterLighting', 'quality'),
      { key: 'lightStrength', labelKey: 'lightStrength', kind: 'choice', tab: 'quality', parent: 'characterLighting',
        options: [20, 40, 65], optionKeys: { 20: 'lightSoft', 40: 'lightNatural', 65: 'lightBright' }, defaultValue: 40 },
      boolRow('groundShadow', 'quality')]
  },
  { id: 'motionQuality', titleKey: 'tabQuality', tab: 'quality', suppressTitle: true, rows: [boolRow('smartInterp', 'quality')] },
  {
    id: 'fun',
    titleKey: 'funGroupTitle',
    tab: 'fun',
    rows: [
      boolRow('roam', 'fun'),
      boolRow('touchFeedback', 'fun'),
      boolRow('dragPhysics', 'fun'),
      boolRow('bubbles', 'fun'),
      {
        key: 'bubbleMs',
        labelKey: 'bubbleMs',
        descKey: 'bubbleMsDesc',
        kind: 'choice',
        tab: 'fun',
        options: BUBBLE_MS_OPTIONS,
        optionKeyPrefix: 'bubbleMs',
        defaultValue: BUBBLE_MS_DEFAULT
      }
    ]
  },
  {
    id: 'quiet',
    titleKey: 'quietGroupTitle',
    tab: 'device',
    suppressTitle: true,
    rows: [boolRow('quietMode', 'device'), boolRow('quietFullscreen', 'device')]
  },
  {
    id: 'device',
    titleKey: 'deviceGroupTitle',
    tab: 'device',
    caption: true,
    rows: [boolRow('deviceNotify', 'device'), boolRow('notifyKeyboard', 'device'), boolRow('notifyMouse', 'device'), boolRow('notifyHeadset', 'device'), boolRow('notifyBattery', 'device')]
  }
];

// 契约 §10：某设备的能力全是 D 级时，它的播报开关整行隐藏，组尾留一行说明。
const CAPABILITY_ROWS = { keyboard: 'notifyKeyboard', mouse: 'notifyMouse', headset: 'notifyHeadset' };
const HD_STATES = ['idle', 'preparing', 'ready', 'degraded'];
const perfStatus = { sharp: '', interp: '', fps: 0, hd: '', hdProgress: 0 };
const REQUIRED_CHANNELS = ['STATE', 'GET_STATE', 'UPDATE', 'PLAY', 'RESET_POSITION', 'SELECT'];
// 兜底图集：renderer/pet/assets/pet-aby.webp 已随 D08 删除，指向 pets 下的真实资源。
const FALLBACK_ATLAS_URL = '../../pets/yorha-sit-2b/spritesheet.webp';
const FRAME_W = 192;
const FRAME_H = 208;
const ATLAS_COLS = 8;
const ATLAS_ROWS = 9;
const DEFAULT_FRAME_MS = 140;
const LEVELUP_COOLDOWN_MS = 800;
const NAME_MAX = 20;
const SCALE_MIN = 0;
const SCALE_MAX = 150;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const HERO_MIN_HEIGHT = 300;
const HERO_NAME_RATIO = 0.22;
const HERO_NAME_FLOOR = 68;
const HERO_NAME_MIN = 24;
const PREVIEW_FOLLOW_MS = 400;
const PREVIEW_AUTO_MIN_MS = window.PetActions.AUTO_MIN_MS;
const PREVIEW_AUTO_RANGE_MS = window.PetActions.AUTO_MAX_MS - PREVIEW_AUTO_MIN_MS;

const I18N_TARGETS = [
  ['data-i18n', function (node, value) { node.textContent = value; }],
  ['data-i18n-title', function (node, value) { node.title = value; }],
  ['data-i18n-aria', function (node, value) { node.setAttribute('aria-label', value); }],
  ['data-i18n-placeholder', function (node, value) { node.placeholder = value; }]
];

const els = {
  app: document.getElementById('app'),
  emptyState: document.getElementById('emptyState'),
  emptyTitle: document.getElementById('emptyTitle'),
  emptyHint: document.getElementById('emptyHint'),
  reloadBtn: document.getElementById('reloadBtn'),
  actionHint: document.getElementById('actionHint'),
  petList: document.getElementById('petList'),
  petListEmpty: document.getElementById('petListEmpty'),
  hero: document.getElementById('hero'),
  heroPhoto: document.getElementById('heroPhoto'),
  heroFallback: document.getElementById('heroFallback'),
  heroWatermark: document.getElementById('heroWatermark'),
  heroReplayBtn: document.getElementById('heroReplayBtn'),
  heroZoomBtn: document.getElementById('heroZoomBtn'),
  previewCanvas: document.getElementById('previewCanvas'),
  petAvatar: document.getElementById('petAvatar'),
  petName: document.getElementById('petName'),
  renameBtn: document.getElementById('renameBtn'),
  titleBadge: document.getElementById('titleBadge'),
  xpValue: document.getElementById('xpValue'),
  xpNext: document.getElementById('xpNext'),
  levelValue: document.getElementById('levelValue'),
  xpTrack: document.getElementById('xpTrack'),
  xpBar: document.getElementById('xpBar'),
  scaleRange: document.getElementById('scaleRange'),
  scaleValue: document.getElementById('scaleValue'),
  sizeHint: document.getElementById('sizeHint'),
  previewLevelBtn: document.getElementById('previewLevelBtn'),
  notice: document.getElementById('notice'),
  toggleVisibleBtn: document.getElementById('toggleVisibleBtn'),
  visibilityLabel: document.getElementById('visibilityLabel'),
  actionGrid: document.getElementById('actionGrid'),
  togglesWrap: document.getElementById('togglesWrap'),
  toggles: document.getElementById('toggles'),
  entryNote: document.getElementById('entryStatusNote'),
  settingsTabs: document.getElementById('settingsTabs'),
  resetBtn: document.getElementById('resetBtn'),
  pluginInfo: document.getElementById('pluginInfo'),
  nameDialogTitle: document.getElementById('nameDialogTitle'),
  nameDialog: document.getElementById('nameDialog'),
  nameForm: document.getElementById('nameForm'),
  nameInput: document.getElementById('nameInput'),
  nameError: document.getElementById('nameError'),
  nameSaveBtn: document.getElementById('nameSaveBtn'),
  nameCancelBtn: document.getElementById('nameCancelBtn'),
  petImportBtn: document.getElementById('petImportBtn'),
  petImportDialog: document.getElementById('petImportDialog'),
  petImportCloseBtn: document.getElementById('petImportCloseBtn'),
  petFolderBtn: document.getElementById('petFolderBtn'),
  petNpxInput: document.getElementById('petNpxInput'),
  petNpxBtn: document.getElementById('petNpxBtn'),
  petImportLog: document.getElementById('petImportLog'),
  petImportError: document.getElementById('petImportError'),
  petDeleteDialog: document.getElementById('petDeleteDialog'),
  petDeleteHint: document.getElementById('petDeleteHint'),
  petDeleteError: document.getElementById('petDeleteError'),
  petDeleteCancelBtn: document.getElementById('petDeleteCancelBtn'),
  petDeleteConfirmBtn: document.getElementById('petDeleteConfirmBtn')
};

const views = {
  pets: new Map(),
  actions: new Map(),
  toggles: new Map(),
  choices: new Map(),
  groups: [],
  capsHint: null,
  interpFps: null
};

let state = null;
let translator = i18n.createTranslator('zh');
let busy = false;
let nameSaving = false;
let levelUpCooldown = false;
let selectedPetId = null;
let lastPreviewAction = null;
let previewRow = 0;
let rafId = 0;
let atlasReady = false;
let atlasFailed = false;
let previewScale = 100;
let sizeFieldInvalid = false;
let busyFocusBefore = null;
let busyFocusTarget = null;
const previewScales = new Map();
let scaleSyncPending = null;
let scaleSyncActive = null;
let loading = true;
let previewActionId = null;
let namePetId = null;
let nameReturnFocus = null;
let zoomFade = null;
let previewContextId = null;
let previewRestingAction = null;
let previewTransientAction = null;
let previewTransientKind = null;
let previewInteractionTimer = null;
let previewAutoTimer = null;
let previewPointerX = null;
let previewBaseSnapshot = null;
let previewAutoEnabled = null;
let deviceCaps = null;
// 删除 / 导入的临时状态：同一时刻只允许一行处于长按删除态，弹窗也只开一个。
let armedRow = null;
let armedPetId = null;
let deletePetId = null;
let deleteReturnFocus = null;
let importReturnFocus = null;
let importBusy = false;
let importRequestId = '', importClosePending = false;
let deleteBusy = false;

const MOTION_EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';
const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
const localFeedback = new Map();
let feedbackEpoch = 0;

// One-off feedback belongs to the initiating pointer action, never a state refresh.
function playLocalFeedback(node, transform, duration, epoch) {
  if (!node || !node.isConnected || !node.getClientRects().length || epoch !== feedbackEpoch || typeof node.animate !== 'function') return;
  const previous = localFeedback.get(node);
  if (previous) previous.cancel();
  const animation = node.animate(reducedMotion()
    ? [{ opacity: 0.9 }, { opacity: 1 }]
    : [{ transform: transform, opacity: 1 }, { transform: 'none', opacity: 1 }],
  { duration: reducedMotion() ? 80 : duration, easing: MOTION_EASE_OUT });
  localFeedback.set(node, animation);
  const release = function () { if (localFeedback.get(node) === animation) localFeedback.delete(node); };
  animation.finished.then(release, release);
}

function stopLocalFeedback() {
  feedbackEpoch++;
  localFeedback.forEach(animation => animation.cancel());
  localFeedback.clear();
  views.pets.forEach(row => row.classList.remove('has-delete-motion'));
}

let atlasSource = '';
let atlas = null;
const previewCtx = els.previewCanvas ? els.previewCanvas.getContext('2d') : null;
const quality = window.PetQuality || null;
const previewBounds = quality ? quality.createBoundsCache() : null;
let previewQuality = null, previewQualityKey = '', previewQualityToken = 0, previewQualityStatus = 'original';
let comparingOriginal = false, lastPreviewCol = 0, compareCol = 0, compareRow = 0;
let previewDisplayWidth = FRAME_W;
const atlasFallbacks = new Map();
const qualityUI = {};

function renderQualityControls() {
  if (!qualityUI.compare) return;
  qualityUI.row.hidden = activeTab !== 'quality' || !selectedPet();
  qualityUI.compare.textContent = t(comparingOriginal ? 'qualityOriginal' : 'qualityCompare');
  qualityUI.compare.setAttribute('aria-pressed', comparingOriginal ? 'true' : 'false');
  qualityUI.compare.disabled = loading || busy || !selectedPet() || previewScale === 0 || previewQualityStatus !== 'ready';
  qualityUI.retry.setAttribute('aria-label', t('qualityRetry'));
  qualityUI.status.textContent = t(previewQualityStatus === 'ready' && petIsShown() && perfStatus.hd === 'degraded' ? 'qualityDesktopFallback'
    : previewQualityStatus === 'preparing' ? 'qualityPreparing'
    : previewQualityStatus === 'failed' ? 'qualityFailed' : previewQualityStatus === 'ready' ? 'qualitySynced' : 'qualityOriginalHint');
  qualityUI.retry.hidden = previewQualityStatus !== 'failed' && !(petIsShown() && perfStatus.hd === 'degraded');
  qualityUI.status.hidden = previewQualityStatus !== 'preparing' && previewQualityStatus !== 'failed' && !(petIsShown() && perfStatus.hd === 'degraded');
}

function initQualityControls() {
  const row = document.createElement('div'); row.className = 'quality-tools';
  const compare = document.createElement('button'); compare.id = 'qualityCompareBtn'; compare.type = 'button'; compare.className = 'ghost-button';
  const status = document.createElement('p'); status.id = 'qualityPreviewStatus'; status.className = 'toggle-note'; status.setAttribute('role', 'status');
  const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'quality-retry'; retry.textContent = '↻'; retry.setAttribute('aria-label', t('qualityRetry'));
  compare.setAttribute('aria-describedby', status.id);
  Object.assign(qualityUI, { row, compare, status, retry });
  function setCompare(value) {
    if (value && compare.disabled) return;
    if (value && !comparingOriginal) { compareCol = lastPreviewCol; compareRow = previewRow; }
    comparingOriginal = value; renderQualityControls(); drawPreview(compareCol);
  }
  compare.addEventListener('pointerdown', e => { if (e.button !== 0) return; e.preventDefault(); compare.focus(); compare.setPointerCapture(e.pointerId); setCompare(true); });
  ['pointerup', 'pointercancel', 'lostpointercapture', 'blur'].forEach(name => compare.addEventListener(name, () => setCompare(false)));
  compare.addEventListener('keydown', e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setCompare(true); } });
  window.addEventListener('keyup', e => { if (e.key === ' ' || e.key === 'Enter') setCompare(false); });
  window.addEventListener('blur', () => setCompare(false));
  retry.addEventListener('click', async () => {
    previewQualityKey = ''; drawPreview(lastPreviewCol);
    if (petIsShown() && IPC.QUALITY_RETRY) { try { await ipcRenderer.invoke(IPC.QUALITY_RETRY); } catch (_) { showNotice(t('qualityFailed')); } }
  });
  row.append(compare, retry, status); els.hero.appendChild(row);
  window.addEventListener('beforeunload', () => { previewQualityToken++; });
}

function ensurePreviewQuality() {
  if (!quality || !window.PetHd || !atlasReady || !atlas) return;
  const s = currentSettings(), enabled = s.sharpRender === true || s.characterLighting === true;
  const width = Math.ceil(Math.max(FRAME_W * pixelRatio, previewDisplayWidth * pixelRatio) / 48) * 48;
  const key = atlasSource + ':' + width + ':' + quality.signature(s);
  if (key === previewQualityKey) return;
  previewQualityKey = key; const token = ++previewQualityToken;
  const source = atlas;
  if (!previewQuality || previewQuality.source !== source) previewQuality = null;
  if (!enabled) { previewQuality = null; previewQualityStatus = 'original'; renderQualityControls(); return; }
  previewQualityStatus = 'preparing'; renderQualityControls();
  window.PetHd.create().build({ image: atlas, cellWidth: width, columns: ATLAS_COLS, rows: ATLAS_ROWS,
    quality: s, isCancelled: () => token !== previewQualityToken
  }).then(result => {
    if (token !== previewQualityToken) return;
    previewQuality = Object.assign(result, { source }); previewQualityStatus = 'ready'; renderQualityControls(); drawPreview(lastPreviewCol);
  }).catch(() => {
    if (token !== previewQualityToken) return;
    previewQuality = null; previewQualityStatus = 'failed'; renderQualityControls(); drawPreview(lastPreviewCol);
  });
}
const pixelRatio = Math.max(1, Math.min(3, Number(window.devicePixelRatio) || 1));

function t(key, vars) {
  return translator(key, vars);
}

function currentSettings() {
  return (state && state.settings) || {};
}

function currentPets() {
  const list = state && Array.isArray(state.pets) ? state.pets : [];
  return list.filter(function (pet) { return pet && pet.id; });
}

function currentPet() {
  const pets = currentPets();
  const id = currentSettings().petId;
  return pets.filter(function (pet) { return pet.id === id; })[0] || pets[0] || null;
}

function petFocusId() {
  const pets = currentPets();
  const has = function (id) { return pets.some(function (pet) { return pet.id === id; }); };
  if (has(selectedPetId)) return selectedPetId;
  const petId = currentSettings().petId;
  if (has(petId)) return petId;
  return pets[0] ? pets[0].id : null;
}

function selectedPet() {
  const chosen = currentPets().filter(function (pet) { return pet.id === petFocusId(); })[0];
  return chosen || currentPet();
}

function syncSelection(prevPetId) {
  const pets = currentPets();
  const has = function (id) { return pets.some(function (pet) { return pet.id === id; }); };
  const petId = currentSettings().petId;
  if (!selectedPetId || !has(selectedPetId)) {
    selectedPetId = has(petId) ? petId : (pets[0] ? pets[0].id : null);
    return;
  }
  if (prevPetId !== petId && selectedPetId === prevPetId && has(petId)) selectedPetId = petId;
}

function currentGrowth() {
  const pet = selectedPet();
  if (pet && pet.growth && typeof pet.growth === 'object') return pet.growth;
  return {};
}

function basePreviewAction() {
  return previewActionId || String(currentSettings().action || 'idle');
}

function previewAction() {
  return previewTransientAction || previewRestingAction || basePreviewAction();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function patchState(patch) {
  const base = state || {};
  const settings = Object.assign({}, base.settings || {}, patch);
  return Object.assign({}, base, { settings: settings });
}

function xpPercent(growth) {
  const progress = Number(growth.xpProgress);
  if (Number.isFinite(progress)) return clamp(progress * 100, 0, 100);
  const xp = Number(growth.xp);
  const next = Number(growth.xpNext);
  if (Number.isFinite(xp) && Number.isFinite(next) && next > 0) return clamp((xp / next) * 100, 0, 100);
  return 0;
}

function petName(pet) {
  const fallback = String(currentSettings().petName || '');
  if (!pet) return '';
  const name = pet.name || pet.displayName;
  return name ? String(name) : fallback;
}

function petAtlasUrl(pet) {
  return pet && typeof pet.atlasUrl === 'string' && pet.atlasUrl ? atlasFallbacks.get(pet.atlasUrl) || pet.atlasUrl : FALLBACK_ATLAS_URL;
}

function currentAtlasUrl() {
  const pet = selectedPet();
  return pet ? petAtlasUrl(pet) : '';
}

function heroUrlOf(pet) {
  return pet && typeof pet.heroUrl === 'string' ? pet.heroUrl : '';
}

function applyAvatar(node, url) {
  if (!node) return;
  node.style.backgroundRepeat = 'no-repeat';
  node.style.backgroundImage = url ? 'url("' + url + '")' : 'none';
  node.style.backgroundSize = (ATLAS_COLS * 100) + '% ' + (ATLAS_ROWS * 100) + '%';
  node.style.backgroundPosition = '0% 0%';
}

function applyAtlasFrame(node, url, row) {
  if (!node) return;
  node.style.backgroundRepeat = 'no-repeat';
  node.style.backgroundImage = url ? 'url("' + url + '")' : 'none';
  node.style.backgroundSize = (ATLAS_COLS * 100) + '% ' + (ATLAS_ROWS * 100) + '%';
  const offset = ATLAS_ROWS > 1 ? (row / (ATLAS_ROWS - 1)) * 100 : 0;
  node.style.backgroundPosition = '0% ' + offset + '%';
}

function renderPetList() {
  const pets = currentPets();
  const petId = currentSettings().petId;
  const showing = Boolean(currentSettings().visible);
  const focusedId = petFocusId();
  els.petListEmpty.hidden = pets.length > 0;
  views.pets.forEach(function (row, id) {
    if (pets.some(function (pet) { return pet.id === id; })) return;
    row.remove();
    views.pets.delete(id);
  });
  pets.forEach(function (pet, index) {
    let row = views.pets.get(pet.id);
    if (!row) {
      row = document.createElement('div');
      row.className = 'pet-item';
      const choose = document.createElement('button');
      choose.type = 'button';
      choose.className = 'pet-item-select';
      choose.setAttribute('aria-keyshortcuts', 'Delete');
      row.appendChild(choose);
      choose.addEventListener('keydown', function (event) {
        if (event.key === 'Delete') { event.preventDefault(); armPetRow(row, pet.id); row.querySelector('.pet-item-delete').focus(); }
      });
      row.dataset.petId = pet.id;

      const avatar = document.createElement('span');
      avatar.className = 'pet-item-avatar';
      avatar.setAttribute('aria-hidden', 'true');
      row.appendChild(avatar);

      const copy = document.createElement('span');
      copy.className = 'pet-item-copy';

      const name = document.createElement('span');
      name.className = 'pet-item-name';
      copy.appendChild(name);

      const meta = document.createElement('span');
      meta.className = 'pet-item-meta';
      const levelText = document.createElement('span');
      levelText.className = 'pet-item-level';
      meta.appendChild(levelText);
      const badge = document.createElement('span');
      badge.className = 'pet-item-badge';
      meta.appendChild(badge);
      copy.appendChild(meta);
      row.appendChild(copy);

      const star = document.createElement('span');
      star.className = 'pet-item-star';
      star.setAttribute('aria-hidden', 'true');
      star.innerHTML = '<i class="mc-icon iconfont icon-bookmark_char" aria-hidden="true"></i>';
      row.appendChild(star);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'pet-item-delete';
      remove.setAttribute('tabindex', '-1');
      remove.innerHTML = '<i class="mc-icon iconfont icon-delete_linear" aria-hidden="true"></i><span></span>';
      remove.addEventListener('click', function (event) {
        event.stopPropagation();
        event.preventDefault();
        openPetDeleteDialog(pet.id, event.detail > 0);
      });
      row.appendChild(remove);
      attachLongPress(row, pet.id);
      row.addEventListener('click', function (event) {
        if (row.classList.contains('is-armed')) {
          event.preventDefault();
          return;
        }
        selectPet(pet.id);
      });
      views.pets.set(pet.id, row);
    }
    applyAvatar(row.querySelector('.pet-item-avatar'), petAtlasUrl(pet));
    const label = t('petListRow', { name: petName(pet) });
    row.querySelector('.pet-item-name').textContent = label;
    row.title = label + ' · ' + t('petManageHint');
    row.querySelector('.pet-item-select').setAttribute('aria-label', label);
    row.querySelector('.pet-item-select').setAttribute('aria-describedby', 'petManageHint');
    row.querySelector('.pet-item-delete').setAttribute('aria-label', t('petDeleteNamed', { name: petName(pet) }));
    const removeBtn = row.querySelector('.pet-item-delete span');
    if (removeBtn) removeBtn.textContent = t('petDelete');
    const level = pet.growth ? Number(pet.growth.level) : NaN;
    row.querySelector('.pet-item-level').textContent = t('petLevelShort', { level: Number.isFinite(level) ? level : 1 });
    const badge = row.querySelector('.pet-item-badge');
    badge.hidden = !(showing && pet.id === petId);
    badge.textContent = t('petShowing');
    const selected = pet.id === focusedId;
    row.classList.toggle('active', selected);
    row.querySelector('.pet-item-select').setAttribute('aria-pressed', selected ? 'true' : 'false');
    if (els.petList.children[index] !== row) els.petList.insertBefore(row, els.petList.children[index] || null);
  });
}

function selectPet(id) {
  if (!state) return;
  if (!currentPets().some(function (pet) { return pet.id === id; })) return;
  selectedPetId = id;
  previewActionId = null;
  renderAll();
}

function applyStaticText() {
  translator = i18n.createTranslator(currentSettings().locale);
  document.documentElement.lang = i18n.normalizeLocale(currentSettings().locale);
  I18N_TARGETS.forEach(function (entry) {
    document.querySelectorAll('[' + entry[0] + ']').forEach(function (node) {
      entry[1](node, t(node.getAttribute(entry[0])));
    });
  });
}

function buildActionGrid() {
  els.actionGrid.textContent = '';
  views.actions.clear();
  ACTION_IDS.forEach(function (id) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'action-tile';
    button.dataset.action = id;
    const frame = document.createElement('span');
    frame.className = 'action-tile-frame';
    frame.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'action-tile-label';
    button.appendChild(frame);
    button.appendChild(label);
    button.addEventListener('click', function () { playAction(id); });
    views.actions.set(id, { button: button, frame: frame, label: label });
    els.actionGrid.appendChild(button);
  });
}

function buildToggles() {
  els.toggles.textContent = '';
  views.toggles.clear();
  views.choices.clear();
  views.groups = [];
  views.capsHint = null;
  ROW_GROUPS.forEach(function (group) {
    const title = document.createElement('div');
    title.className = 'toggle-group-title';
    title.id = 'toggleGroup-' + group.id;
    title.dataset.group = group.id;
    title.dataset.tab = group.tab || TAB_IDS[0];
    title.classList.toggle('is-caption', Boolean(group.caption));
    if (group.suppressTitle) title.classList.add('is-suppressed');
    els.toggles.appendChild(title);
    views.groups.push({ node: title, titleKey: group.titleKey, tab: group.tab || TAB_IDS[0] });
    group.rows.forEach(function (row) {
      if (row.kind === 'choice') buildChoiceRow(row);
      else buildBoolRow(row);
    });
    if (group.id === 'device') buildCapsHint();
  });
}

function buildBoolRow(spec) {
  const key = spec.key;
  const row = document.createElement('label');
  row.className = 'toggle';
  row.dataset.key = key;
  row.dataset.tab = spec.tab || TAB_IDS[0];
  row.classList.toggle('is-sub', Boolean(spec.parent));
  const copy = document.createElement('div');
  copy.className = 'toggle-copy';
  const label = document.createElement('span');
  label.className = 'toggle-label';
  label.id = 'toggle-' + key + '-label';
  // 自解释的行不渲染第二行说明：少一行字，行高从 49px 降到 32px。
  const hasDesc = Boolean(spec.descKey);
  let desc = null;
  let descText = null;
  let bar = null;
  let barFill = null;
  if (hasDesc) {
    desc = document.createElement('span');
    desc.className = 'toggle-desc';
    desc.id = 'toggle-' + key + '-desc';
    descText = document.createElement('span');
    descText.className = 'toggle-desc-text';
    desc.appendChild(descText);
    if (key === 'sharpRender') {
      bar = document.createElement('span');
      bar.className = 'toggle-progress';
      bar.setAttribute('aria-hidden', 'true');
      barFill = document.createElement('span');
      barFill.className = 'toggle-progress-fill';
      bar.appendChild(barFill);
      desc.appendChild(bar);
    }
  }
  copy.appendChild(label);
  if (desc) copy.appendChild(desc);
  const switchWrap = document.createElement('span');
  switchWrap.className = 'switch';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.id = 'toggle-' + key;
  row.htmlFor = input.id;
  input.setAttribute('aria-labelledby', label.id);
  if (desc) input.setAttribute('aria-describedby', desc.id);
  const track = document.createElement('span');
  track.className = 'track';
  switchWrap.appendChild(input);
  switchWrap.appendChild(track);
  row.appendChild(copy);
  row.appendChild(switchWrap);
  let pointerToggle = false;
  input.addEventListener('click', function (event) { pointerToggle = event.detail > 0; });
  input.addEventListener('change', async function () {
    if (key === 'deviceNotify') syncTogglesVisibility();
    const patch = {};
    patch[key] = input.checked;
    const reveal = key === 'smartInterp' && input.checked && pointerToggle && !currentSettings().smartInterp;
    const epoch = feedbackEpoch;
    pointerToggle = false;
    const saved = await request(patch);
    if (saved && reveal && activeTab === 'quality' && currentSettings().smartInterp) {
      playLocalFeedback(views.interpFps.row, 'translateY(-3px)', 160, epoch);
    }
  });
  views.toggles.set(key, {
    input: input,
    label: label,
    desc: desc,
    text: descText,
    bar: bar,
    barFill: barFill,
    row: row,
    labelKey: spec.labelKey,
    descKey: spec.descKey,
    tab: spec.tab || TAB_IDS[0],
    parent: spec.parent || null
  });
  els.toggles.appendChild(row);
  if (key === 'smartInterp') buildInterpFpsRow(row);
}

// 选择行（目前只有气泡时长）：与「目标帧率」同构，一行文字 + 右对齐分段控件。
function buildChoiceRow(spec) {
  const row = document.createElement('div');
  row.className = 'toggle-fps toggle-choice';
  row.classList.toggle('is-sub', Boolean(spec.parent));
  row.id = 'toggle-' + spec.key + 'Row';
  row.dataset.key = spec.key;
  row.dataset.tab = spec.tab || TAB_IDS[0];
  const copy = document.createElement('div');
  copy.className = 'toggle-copy';
  const label = document.createElement('span');
  label.className = 'toggle-fps-label';
  label.id = 'toggle-' + spec.key + '-label';
  copy.appendChild(label);
  // 选择行也能带一句说明（气泡停留时长就靠这条补回原本文案）。
  let desc = null;
  let descText = null;
  if (spec.descKey) {
    desc = document.createElement('span');
    desc.className = 'toggle-desc';
    desc.id = 'toggle-' + spec.key + '-desc';
    descText = document.createElement('span');
    descText.className = 'toggle-desc-text';
    desc.appendChild(descText);
    copy.appendChild(desc);
  }
  const group = document.createElement('div');
  group.className = 'segmented';
  group.id = 'toggle-' + spec.key + 'Group';
  group.setAttribute('role', 'radiogroup');
  const buttons = spec.options.map(function (value) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'segmented-item';
    button.dataset.value = String(value);
    button.id = 'toggle-' + spec.key + '-' + value;
    button.setAttribute('role', 'radio');
    button.addEventListener('click', function () { selectChoice(spec.key, value); });
    group.appendChild(button);
    return button;
  });
  group.addEventListener('keydown', function (event) {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const from = Math.max(0, spec.options.indexOf(choiceValue(spec)));
    const next = spec.options[(from + step + spec.options.length) % spec.options.length];
    selectChoice(spec.key, next);
    const target = buttons[spec.options.indexOf(next)];
    if (target && typeof target.focus === 'function') target.focus();
  });
  if (desc) group.setAttribute('aria-describedby', desc.id);
  row.appendChild(copy);
  row.appendChild(group);
  views.choices.set(spec.key, { row: row, label: label, desc: desc, text: descText, group: group, buttons: buttons, spec: spec });
  els.toggles.appendChild(row);
}

// 能力全是 D 级时组尾那行说明：默认折叠，收到能力表后由 renderDeviceCaps 决定是否露出。
function buildCapsHint() {
  const hint = document.createElement('p');
  hint.className = 'toggle-note';
  hint.id = 'deviceCapsHint';
  hint.hidden = true;
  hint.dataset.tab = 'device';
  els.toggles.appendChild(hint);
  views.capsHint = hint;
}

// 补帧开启后在其下方展开一行「补帧倍数」分段控件（×2/×3/×4）：它不是第 9 个开关，只是补帧的档位。
function buildInterpFpsRow(afterRow) {
  if (!afterRow) return;
  const row = document.createElement('div');
  row.className = 'toggle-fps';
  row.id = 'interpFpsRow';
  row.hidden = true;
  row.dataset.tab = 'quality';
  const label = document.createElement('span');
  label.className = 'toggle-fps-label';
  label.id = 'interpFpsLabel';
  const group = document.createElement('div');
  group.className = 'segmented';
  group.id = 'interpFpsGroup';
  group.setAttribute('role', 'radiogroup');
  const buttons = INTERP_MULT_OPTIONS.map(function (mult) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'segmented-item';
    button.dataset.mult = String(mult);
    button.id = 'interpMult-' + mult + 'x';
    button.setAttribute('role', 'radio');
    button.textContent = '×' + mult;
    button.addEventListener('click', function () { selectInterpMult(mult); });
    group.appendChild(button);
    return button;
  });
  group.addEventListener('keydown', function (event) {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const list = INTERP_MULT_OPTIONS;
    const from = Math.max(0, list.indexOf(interpMultValue()));
    const next = list[(from + step + list.length) % list.length];
    selectInterpMult(next);
    const target = buttons[list.indexOf(next)];
    if (target && typeof target.focus === 'function') target.focus();
  });
  row.appendChild(label);
  row.appendChild(group);
  afterRow.parentNode.insertBefore(row, afterRow.nextSibling);
  views.interpFps = { row: row, label: label, group: group, buttons: buttons };
}

// 补帧档位：配置是唯一事实来源；老配置只有 smartInterpFps，折算成倍数后再退回默认 ×3。
function interpMultValue() {
  const value = currentSettings().smartInterpMult;
  if (INTERP_MULT_OPTIONS.indexOf(value) >= 0) return value;
  const legacy = LEGACY_INTERP_FPS_MULT[Math.round(Number(currentSettings().smartInterpFps))];
  if (INTERP_MULT_OPTIONS.indexOf(legacy) >= 0) return legacy;
  return DEFAULT_INTERP_MULT;
}

function selectInterpMult(mult) {
  if (INTERP_MULT_OPTIONS.indexOf(mult) < 0) return;
  if (mult === interpMultValue()) return;
  if (busy || loading || !state) return;
  const patch = { smartInterpMult: mult };
  request(patch, document.getElementById('interpMult-' + mult + 'x'));
}

// ---------- 顶部页签 ----------
// 4 个页签一次只显示一组的行，节点自己的 data-tab 决定它属于哪个页签。
// 隐藏统一走类名（is-tab-hidden / is-row-hidden），hidden 属性只留给设备能力表，
// 这样 __settingsRowSnapshot 里的 hidden 语义（能力隐藏）保持不变。
function tabOfNode(node) {
  if (!node || !node.dataset) return '';
  return String(node.dataset.tab || '');
}

function tabKeys(tab) {
  const keys = [];
  ROW_GROUPS.forEach(function (group) {
    group.rows.forEach(function (spec) {
      if ((spec.tab || TAB_IDS[0]) === tab) keys.push(spec.key);
    });
  });
  return keys;
}

function dependentOpen(key) {
  const parent = DEPENDENT_OF[key];
  if (!parent) return true;
  const view = views.toggles.get(parent);
  return Boolean(view && view.input && view.input.checked);
}

function syncTogglesVisibility() {
  const box = els.toggles;
  if (!box || !box.children) return [];
  const nodes = box.children;
  let firstSeen = false;
  const shown = [];
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    const tab = tabOfNode(node);
    if (!tab) continue;
    const key = node.dataset ? String(node.dataset.key || '') : '';
    const offTab = tab !== activeTab;
    const capsHidden = node.hidden === true;
    const depHidden = Boolean(key) && !dependentOpen(key);
    const visible = !capsHidden && !depHidden;
    node.classList.toggle('is-tab-hidden', offTab);
    node.classList.toggle('is-row-hidden', depHidden && !capsHidden);
    node.classList.toggle('is-first', visible && !firstSeen);
    if (!offTab && visible) {
      firstSeen = true;
      if (key) shown.push(key);
    }
  }
  visibleRowKeys = shown;
  renderQualityControls();
  return shown;
}

function tabButton(id) {
  for (let i = 0; i < tabViews.buttons.length; i += 1) {
    const button = tabViews.buttons[i];
    if (button.dataset && button.dataset.tab === id) return button;
  }
  return null;
}

function focusTab(id) {
  const button = tabButton(id);
  if (button && typeof button.focus === 'function') button.focus();
}

function setActiveTab(id, options) {
  const next = TAB_IDS.indexOf(id) >= 0 ? id : TAB_IDS[0];
  activeTab = next;
  tabViews.buttons.forEach(function (button) {
    const on = Boolean(button.dataset) && button.dataset.tab === activeTab;
    button.setAttribute('aria-selected', on ? 'true' : 'false');
    button.tabIndex = on ? 0 : -1;
    button.classList.toggle('is-active', on);
  });
  if (els.toggles && els.toggles.setAttribute) els.toggles.setAttribute('aria-labelledby', 'tab-' + activeTab);
  renderEntryStatus();
  syncTogglesVisibility();
  syncTogglesScroll();
  if (options && options.focus) focusTab(activeTab);
}

function onTabKeydown(event) {
  if (!event || !event.key) return;
  const from = Math.max(0, TAB_IDS.indexOf(activeTab));
  let next = '';
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = TAB_IDS[(from + 1) % TAB_IDS.length];
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = TAB_IDS[(from - 1 + TAB_IDS.length) % TAB_IDS.length];
  else if (event.key === 'Home') next = TAB_IDS[0];
  else if (event.key === 'End') next = TAB_IDS[TAB_IDS.length - 1];
  if (!next) return;
  if (typeof event.preventDefault === 'function') event.preventDefault();
  setActiveTab(next, { focus: true });
}

// 当前页签可见行的内容高度（px）：从第一个可见节点顶边量到最后一个可见节点底边。
function tabsContentHeight() {
  const box = els.toggles;
  if (!box || !box.children || typeof box.getBoundingClientRect !== 'function') return 0;
  const nodes = box.children;
  let top = 0;
  let bottom = 0;
  let seen = false;
  for (let i = 0; i < nodes.length; i += 1) {
    if (!tabOfNode(nodes[i])) continue;
    const rect = nodes[i].getBoundingClientRect();
    if (!rect || !(rect.height > 0)) continue;
    if (!seen) {
      top = rect.top;
      seen = true;
    }
    bottom = rect.bottom;
  }
  return seen ? Math.round((bottom - top) * 100) / 100 : 0;
}

function initTabs() {
  const list = els.settingsTabs;
  if (!list) return;
  tabViews.list = list;
  tabViews.buttons = typeof list.querySelectorAll === 'function'
    ? Array.prototype.slice.call(list.querySelectorAll('[role="tab"]'))
    : [];
  tabViews.buttons.forEach(function (button) {
    button.addEventListener('click', function () {
      if (button.dataset) setActiveTab(button.dataset.tab);
    });
  });
  if (typeof list.addEventListener === 'function') list.addEventListener('keydown', onTabKeydown);
  setActiveTab(activeTab);
}

function renderInterpFps() {
  const view = views.interpFps;
  if (!view) return;
  view.row.hidden = !Boolean(currentSettings().smartInterp);
  // 行标签只写倍数语义：等效帧率随源帧时长在 27~148 之间浮动，拼进标签会逐动作跳数字，故不显示。
  view.label.textContent = t('interpFps');
  const active = interpMultValue();
  view.buttons.forEach(function (button) {
    const selected = Number(button.dataset.mult) === active;
    button.setAttribute('aria-checked', selected ? 'true' : 'false');
    button.tabIndex = selected ? 0 : -1;
    button.setAttribute('aria-label', '×' + button.dataset.mult);
  });
  view.group.setAttribute('aria-label', t('interpFpsGroup'));
}

function heroNameTier(name) {
  const length = Array.from(String(name == null ? '' : name)).length;
  if (length <= 3) return 128;
  if (length <= 5) return 92;
  return 68;
}

function heroNameSizeFor(name, heroHeight) {
  const height = Number(heroHeight) > 0 ? Number(heroHeight) : HERO_MIN_HEIGHT;
  const scaled = Math.round(height * HERO_NAME_RATIO);
  return Math.max(HERO_NAME_FLOOR, Math.min(heroNameTier(name), scaled));
}

function setHeroVar(prop, value) {
  const style = els.hero && els.hero.style;
  if (!style) return;
  if (typeof style.setProperty === 'function') style.setProperty(prop, value);
  else style[prop] = value;
}

function fitHeroName(size) {
  const mark = els.heroWatermark;
  const width = Number(els.hero && els.hero.clientWidth) || 0;
  const measured = Number(mark && mark.scrollWidth) || 0;
  const limit = width * 0.92;
  if (!limit || !measured || measured <= limit + 1) return size;
  return Math.max(HERO_NAME_MIN, Math.floor((size * limit) / measured));
}

function applyHeroMetrics() {
  const name = els.heroWatermark ? els.heroWatermark.textContent : '';
  const height = Number(els.hero && els.hero.clientHeight) || HERO_MIN_HEIGHT;
  const base = heroNameSizeFor(name, height);
  setHeroVar('--hero-name-size', base + 'px');
  const fitted = fitHeroName(base);
  if (fitted !== base) setHeroVar('--hero-name-size', fitted + 'px');
}

function setToggleWrapVar(name, value) {
  const style = els.togglesWrap && els.togglesWrap.style;
  if (!style) return;
  if (typeof style.setProperty === 'function') {
    if (typeof style.getPropertyValue === 'function' && style.getPropertyValue(name) === value) return;
    style.setProperty(name, value);
    return;
  }
  if (style[name] === value) return;
  style[name] = value;
}

function setScrollable(wrap, on) {
  const list = wrap.classList;
  const has = typeof list.contains === 'function' ? list.contains('is-scrollable') : false;
  if (on === has) return;
  if (on) list.add('is-scrollable');
  else list.remove('is-scrollable');
}

function syncTogglesScroll() {
  const wrap = els.togglesWrap, box = els.toggles;
  if (!wrap || !wrap.classList || !box) return;
  // CSS owns the full remaining panel height. Only actual content overflow
  // determines scrolling; never snap the viewport to measured child rows.
  setToggleWrapVar('--toggles-fit', '');
  setToggleWrapVar('--toggles-fade', '0px');
  setScrollable(wrap, box.scrollHeight > box.clientHeight + 1);
}

let layoutPending = 0;
let sizeWatcher = null;

// The inline page lives in a WebContentsView: the host may fit/refit the view before the page
// finishes loading, and window resize alone misses those transitions. Observe the wrap, its
// panel and the row container so any size change re-snaps the clamp to whole rows.
function watchToggleSizes() {
  if (typeof ResizeObserver !== 'function' || sizeWatcher) return;
  const wrap = els.togglesWrap;
  if (!wrap) return;
  sizeWatcher = new ResizeObserver(function () { onLayoutChange(); });
  [wrap, wrap.parentElement, els.toggles, els.hero].forEach(function (el) {
    if (el) sizeWatcher.observe(el);
  });
}

// CSS flex sizing responds immediately to host/window resizes. ResizeObserver
// refreshes only derived indicators and preview geometry, without a fit timer.
function onLayoutChange() {
  if (layoutPending) return;
  layoutPending = 1;
  const flush = function () {
    if (!layoutPending) return;
    layoutPending = 0;
    applyHeroMetrics();
    syncTogglesScroll();
    syncPreviewZoom(false);
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
  else {
    flush();
    return;
  }
  if (typeof setTimeout === 'function') setTimeout(flush, 60);
}

function renderPet() {
  const pet = selectedPet();
  const name = petName(pet);
  if (els.petName) {
    els.petName.textContent = name;
    els.petName.title = name;
  }
  applyAvatar(els.petAvatar, pet ? petAtlasUrl(pet) : '');
  document.querySelector('.info-card').hidden = !pet;
  els.previewCanvas.hidden = !pet;
  document.querySelector('.hero-stage').hidden = !pet;
  document.querySelector('.hero-tools').hidden = !pet;
  els.emptyState.hidden = Boolean(pet);
  els.emptyTitle.textContent = t(loading ? 'loadingPets' : state ? 'petListEmpty' : 'readErrorTitle');
  els.emptyHint.textContent = t(loading ? 'loadingPetsHint' : state ? 'emptyPetsHint' : 'readErrorHint');
  els.reloadBtn.hidden = loading;
  if (!pet) {
    stopPreview();
    lastPreviewAction = null;
    if (previewCtx) previewCtx.clearRect(0, 0, FRAME_W, FRAME_H);
  }
  renderHero(pet);
}

function renderHero(pet) {
  const url = heroUrlOf(pet);
  const hasImage = Boolean(url);
  els.hero.classList.toggle('has-image', hasImage);
  els.hero.classList.toggle('is-fallback', !hasImage);
  els.heroPhoto.style.backgroundImage = hasImage ? 'url("' + url + '")' : 'none';
  els.heroWatermark.textContent = petName(pet);
  applyHeroMetrics();
}

function renderGrowth() {
  const growth = currentGrowth();
  const level = Number(growth.level);
  const xp = Number(growth.xp);
  const next = Number(growth.xpNext);
  els.levelValue.textContent = String(Number.isFinite(level) ? level : 1);
  els.xpValue.textContent = String(Number.isFinite(xp) ? xp : 0);
  els.xpNext.textContent = String(Number.isFinite(next) ? next : 0);
  const percent = xpPercent(growth);
  els.xpBar.style.width = percent.toFixed(1) + '%';
  els.xpTrack.setAttribute('aria-valuenow', percent.toFixed(1));
  els.titleBadge.textContent = String(growth.title || '');
}

function petIsShown() {
  const settings = currentSettings();
  const visible = Boolean(settings.visible);
  const focus = petFocusId();
  if (!focus) return false;
  return visible && settings.petId === focus;
}

function renderVisibility() {
  const shown = petIsShown();
  els.visibilityLabel.textContent = !selectedPet() ? t('noPetAction') : shown ? t('hide') : t('show');
  els.toggleVisibleBtn.classList.toggle('is-shown', shown);
}

function renderActions() {
  els.actionHint.textContent = t(petIsShown() ? 'actionHint' : 'actionPreviewHint');
  const url = currentAtlasUrl();
  ACTION_IDS.forEach(function (id, row) {
    const tile = views.actions.get(id);
    if (!tile) return;
    const label = t('actionLabels.' + id);
    tile.label.textContent = label;
    applyAtlasFrame(tile.frame, url, row);
    tile.button.setAttribute('aria-label', t('playAction', { name: label }));
  });
  syncPreviewActionHighlight();
}

function syncPreviewActionHighlight() {
  const active = previewAction();
  views.actions.forEach(function (tile, id) {
    const selected = id === active;
    tile.button.classList.toggle('active', selected);
    tile.button.setAttribute('aria-pressed', selected ? 'true' : 'false');
  });
}

function clampScale(value) {
  const raw = Number(value);
  return Math.round(clamp(Number.isFinite(raw) ? raw : 100, SCALE_MIN, SCALE_MAX));
}

function renderScale() {
  const id = petFocusId();
  const syncing = (scaleSyncActive && scaleSyncActive.petId === id) || (scaleSyncPending && scaleSyncPending.petId === id);
  if (petIsShown() && !syncing && Number.isFinite(currentSettings().scale)) {
    previewScale = clampScale(currentSettings().scale);
  } else {
    previewScale = previewScales.has(id) ? clampScale(previewScales.get(id)) : 100;
  }
  previewScales.set(id, previewScale);
  els.scaleRange.value = String(previewScale);
  if (document.activeElement !== els.scaleValue) {
    els.scaleValue.value = String(previewScale);
    sizeScaleFieldWidth();
  }
  els.scaleRange.setAttribute('aria-valuetext', t('sizeValue', { value: previewScale }));
  renderSizeHint();
}

function renderSizeHint() {
  els.scaleValue.setAttribute('aria-invalid', sizeFieldInvalid ? 'true' : 'false');
  els.sizeHint.classList.toggle('is-error', sizeFieldInvalid);
  const text = t(sizeFieldInvalid ? 'sizeInputInvalid' : petIsShown() ? 'sizeHintDesktop' : 'sizeHintPreview');
  if (els.sizeHint.textContent !== text) els.sizeHint.textContent = text;
}

function toggleDegraded(key) {
  const field = PERF_STATUS_FIELDS[key];
  if (!field || perfStatus[field] !== 'degraded') return false;
  return Boolean(currentSettings()[key]);
}

function clampPercent(value) {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

function applyToggleDesc(view, key) {
  if (!view.desc || !view.text) return;
  if (key === 'sharpRender') {
    applySharpDesc(view);
    return;
  }
  if (key === 'characterLighting' && currentSettings().characterLighting && perfStatus.hd === 'degraded') {
    view.text.textContent = t('perfDegraded'); view.desc.classList.add('is-degraded'); return;
  }
  const degraded = toggleDegraded(key);
  view.text.textContent = t(degraded ? 'perfDegraded' : view.descKey);
  view.desc.classList.toggle('is-degraded', degraded);
}

// 高清开启后副标题位置变成状态：preparing 是细进度条 + 百分比，ready 报已启用，
// degraded 沿用红色降级样式；未开启（或还没上报）保持原文案，行高始终不变。
function applySharpDesc(view) {
  const enabled = Boolean(currentSettings().sharpRender);
  const hd = enabled ? perfStatus.hd : '';
  const preparing = hd === 'preparing';
  const progress = preparing ? perfStatus.hdProgress : 0;
  let key = 'sharpRenderDesc';
  if (hd === 'degraded') key = 'perfDegraded';
  else if (hd === 'ready') key = 'hdReady';
  else if (preparing) key = 'hdPreparing';
  view.text.textContent = t(key, preparing ? { percent: progress } : undefined);
  if (enabled && hd !== 'degraded' && !preparing && atlasReady) {
    const scale = window.PetActions.sourceScale(atlas);
    view.text.textContent = scale > 1 ? t('qualitySourceHD', { scale }) : t('qualitySourceBase');
  }
  view.desc.classList.toggle('is-degraded', hd === 'degraded');
  view.desc.classList.toggle('has-progress', preparing);
  if (view.bar) view.bar.setAttribute('aria-hidden', 'true');
  if (view.barFill) view.barFill.style.width = (preparing ? progress : 0) + '%';
}

function applyPerfStatus(payload) {
  const next = { sharp: '', interp: '', fps: 0, hd: '', hdProgress: 0 };
  if (payload && typeof payload === 'object') {
    if (typeof payload.sharp === 'string') next.sharp = payload.sharp;
    if (typeof payload.interp === 'string') next.interp = payload.interp;
    // 生效帧率现在由倍数×源帧率算出（例如 ×3×10fps=30），不再是 24/30/60 白名单。
    const reportedFps = Number(payload.fps);
    if (isFinite(reportedFps) && reportedFps > 0 && reportedFps <= 240) next.fps = Math.round(reportedFps);
    if (HD_STATES.indexOf(payload.hd) >= 0) next.hd = payload.hd;
    if (next.hd === 'preparing') next.hdProgress = clampPercent(payload.hdProgress);
  }
  const changed = next.sharp !== perfStatus.sharp || next.interp !== perfStatus.interp ||
    next.fps !== perfStatus.fps || next.hd !== perfStatus.hd || next.hdProgress !== perfStatus.hdProgress;
  if (!changed) return false;
  perfStatus.sharp = next.sharp;
  perfStatus.interp = next.interp;
  perfStatus.fps = next.fps;
  perfStatus.hd = next.hd;
  perfStatus.hdProgress = next.hdProgress;
  views.toggles.forEach(function (view, key) {
    applyToggleDesc(view, key);
  });
  renderInterpFps();
  return true;
}

// 选择行的取值：配置是唯一事实来源，缺失或非本行选项时退回表里的默认档。
function choiceValue(spec) {
  const raw = currentSettings()[spec.key];
  const text = raw === undefined || raw === null ? '' : String(raw);
  const index = spec.options.map(String).indexOf(text);
  return index >= 0 ? spec.options[index] : spec.defaultValue;
}

function selectChoice(key, value) {
  const view = views.choices.get(key);
  if (!view || view.spec.options.map(String).indexOf(String(value)) < 0) return;
  if (busy || loading || !state) return;
  if (String(choiceValue(view.spec)) === String(value)) return;
  const patch = {};
  patch[key] = value;
  const target = view.buttons.find(function (button) { return button.dataset.value === String(value); });
  request(patch, target);
}

function renderChoiceRows() {
  views.choices.forEach(function (view) {
    view.label.textContent = t(view.spec.labelKey);
    view.group.setAttribute('aria-label', t(view.spec.labelKey));
    if (view.desc && view.text) view.text.textContent = t(view.spec.descKey);
    const active = choiceValue(view.spec);
    view.buttons.forEach(function (button) {
      // 选项值可以是数字（气泡时长）也可以是字符串（语言），一律按 options 反查原值。
      const index = view.spec.options.map(String).indexOf(button.dataset.value);
      const value = index >= 0 ? view.spec.options[index] : button.dataset.value;
      const optionKey = view.spec.optionKeys && view.spec.optionKeys[String(value)]
        ? view.spec.optionKeys[String(value)]
        : view.spec.optionKeyPrefix + value;
      button.textContent = t(optionKey);
      const selected = String(value) === String(active);
      button.setAttribute('aria-checked', selected ? 'true' : 'false');
      button.tabIndex = selected ? 0 : -1;
    });
  });
}

// 契约 §10：某设备所有能力都是 D 级时，它的播报行不出现。
// deviceCaps 缺失或字段异常一律不隐藏（防御式，宁可多显示一个开关）。
function capabilityHiddenKeys(caps) {
  const hidden = [];
  if (!caps || typeof caps !== 'object') return hidden;
  Object.keys(CAPABILITY_ROWS).forEach(function (device) {
    const entry = caps[device];
    if (!entry || typeof entry !== 'object') return;
    const audio = device === 'headset' && caps.speaker && typeof caps.speaker === 'object' ? caps.speaker : {};
    const levels = Object.values(entry).concat(Object.values(audio)).map(function (value) {
      return value === undefined || value === null ? '' : String(value).trim().toUpperCase();
    });
    if (!levels.length) return;
    const unsupported = levels.every(function (level) { return level === 'D'; });
    if (unsupported) hidden.push(CAPABILITY_ROWS[device]);
  });
  return hidden;
}

function renderDeviceCaps() {
  const hidden = capabilityHiddenKeys(deviceCaps);
  Object.keys(CAPABILITY_ROWS).forEach(function (device) {
    const key = CAPABILITY_ROWS[device];
    const view = views.toggles.get(key);
    if (!view) return;
    const off = hidden.indexOf(key) >= 0;
    view.row.hidden = off;
    view.row.classList.toggle('is-unsupported', off);
  });
  const hint = views.capsHint;
  if (!hint) return;
  hint.textContent = t('deviceCapsUnsupported');
  hint.hidden = hidden.length === 0;
}

// 交叉项：GET_STATE 的 entryStatus 报告这次启动的桌面挂载结果，
// 只有明确失败（ok === false）才在「桌面」页签顶部留一条警告，null 或 ok 不占高度。
function renderEntryStatus() {
  const note = els.entryNote;
  if (!note) return;
  const status = state && state.entryStatus;
  const failed = Boolean(status && typeof status === 'object' && status.ok === false && ['selectors-miss', 'error'].includes(status.reason));
  const show = failed && activeTab === 'desktop';
  note.hidden = !show;
  if (!show) {
    note.textContent = '';
    return;
  }
  const rawReason = typeof status.reason === 'string' ? status.reason.trim() : '';
  const attempts = Number(status.attempts);
  note.textContent = t('entryStatusWarn', {
    reason: rawReason || t('entryStatusUnknownReason'),
    attempts: Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 0
  });
}

function renderToggles() {
  const settings = currentSettings();
  views.groups.forEach(function (view) {
    view.node.textContent = t(view.titleKey);
  });
  views.toggles.forEach(function (view, key) {
    view.input.checked = Boolean(settings[key]);
    view.label.textContent = t(view.labelKey);
    applyToggleDesc(view, key);
  });
  renderChoiceRows();
  renderInterpFps();
  renderDeviceCaps();
  renderQualityControls();
  renderEntryStatus();
  syncTogglesVisibility();
  syncTogglesScroll();
}

function renderDisabled() {
  renderQualityControls();
  const unavailable = loading || !state || !selectedPet();
  const disabled = busy || unavailable;
  // Pending IO blocks duplicate input without dimming the entire interface.
  const disable = function (node, unavailable) {
    if (!node) return;
    const pending = busy && !unavailable;
    node.classList.toggle('is-saving', pending);
    if (node === els.scaleRange) {
      // Native range controls turn gray when disabled. Inert blocks pointer and
      // keyboard input for a pending save while keeping the blue track stable.
      node.inert = pending;
      node.setAttribute('aria-disabled', busy || unavailable ? 'true' : 'false');
      node.disabled = unavailable;
    } else node.disabled = busy || unavailable;
  };
  els.app.setAttribute('aria-busy', busy || loading ? 'true' : 'false');
  disable(els.toggleVisibleBtn, unavailable);
  disable(els.resetBtn, unavailable);
  disable(els.renameBtn, unavailable);
  disable(els.previewLevelBtn, unavailable || levelUpCooldown || !petIsShown());
  disable(els.scaleRange, unavailable);
  disable(els.scaleValue, unavailable);
  disable(els.heroZoomBtn, unavailable);
  const zoomLabel = t(els.hero.classList.contains('is-zoomed') ? 'heroToolZoomOut' : 'heroToolZoom');
  els.heroZoomBtn.setAttribute('aria-label', zoomLabel);
  els.heroZoomBtn.title = zoomLabel;
  els.heroReplayBtn.title = t('heroToolReplay');
  disable(els.heroReplayBtn, unavailable);
  els.reloadBtn.disabled = loading;
  views.pets.forEach(function (row) { row.querySelectorAll('button').forEach(function (button) { disable(button, loading || !state); }); });
  disable(els.petImportBtn, loading || !state);
  views.actions.forEach(function (view) { disable(view.button, unavailable); });
  views.toggles.forEach(function (view) { disable(view.input, unavailable); });
  if (views.interpFps) {
    views.interpFps.buttons.forEach(function (button) { disable(button, unavailable); });
  }
  views.choices.forEach(function (view) {
    view.buttons.forEach(function (button) { disable(button, unavailable); });
  });
  const interactive = !disabled && previewScale > 0 && Boolean(currentSettings().followInput);
  els.previewCanvas.tabIndex = interactive ? 0 : -1;
  els.previewCanvas.setAttribute('role', interactive ? 'button' : 'img');
  els.previewCanvas.setAttribute('aria-label', t(interactive ? 'interactivePreview' : 'preview'));
}

function framesFor(action) {
  const list = state && Array.isArray(state.actions) ? state.actions : [];
  const entry = list.find(function (item) { return item && item.id === action; });
  const durations = entry && Array.isArray(entry.durations) ? entry.durations.filter(function (value) {
    return Number.isFinite(value) && value > 0;
  }) : [];
  return durations.length ? durations : [DEFAULT_FRAME_MS, DEFAULT_FRAME_MS, DEFAULT_FRAME_MS, DEFAULT_FRAME_MS];
}

function frameAt(durations, elapsed) {
  const total = durations.reduce(function (sum, value) { return sum + value; }, 0);
  let rest = total > 0 ? elapsed % total : 0;
  for (let index = 0; index < durations.length; index += 1) {
    if (rest < durations[index]) return index;
    rest -= durations[index];
  }
  return durations.length - 1;
}

function drawPreview(col) {
  if (!previewCtx) return;
  if (comparingOriginal) col = compareCol;
  const row = comparingOriginal ? compareRow : previewRow;
  lastPreviewCol = col;
  const wanted = Math.max(1, Math.round(Math.max(FRAME_W * pixelRatio, previewDisplayWidth * pixelRatio)));
  if (els.previewCanvas.width !== wanted) { els.previewCanvas.width = wanted; els.previewCanvas.height = Math.round(wanted * FRAME_H / FRAME_W); }
  previewCtx.setTransform(wanted / FRAME_W, 0, 0, els.previewCanvas.height / FRAME_H, 0, 0);
  previewCtx.imageSmoothingEnabled = true;
  previewCtx.imageSmoothingQuality = 'high';
  previewCtx.clearRect(0, 0, FRAME_W, FRAME_H);
  if (!atlasReady || !atlas) return;
  ensurePreviewQuality();
  if (!comparingOriginal && quality && previewBounds) quality.drawShadow(previewCtx,
    previewBounds(atlas, col, row), previewBounds(atlas, 0, 0), currentSettings(), 0, 0);
  const enhanced = !comparingOriginal && previewQuality;
  els.previewCanvas.dataset.quality = comparingOriginal ? 'original' : enhanced ? 'enhanced' : 'original';
  if (enhanced) previewCtx.drawImage(enhanced.canvas, enhanced.cellW * col, enhanced.cellH * row, enhanced.cellW, enhanced.cellH, 0, 0, FRAME_W, FRAME_H);
  else {
    const scale = window.PetActions.sourceScale(atlas);
    previewCtx.imageSmoothingEnabled = true; previewCtx.imageSmoothingQuality = 'high';
    previewCtx.drawImage(atlas, FRAME_W * col * scale, FRAME_H * row * scale, FRAME_W * scale, FRAME_H * scale, 0, 0, FRAME_W, FRAME_H);
  }
}

function reducedMotion() {
  return motionPreference.matches;
}

function stopPreview() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
}

function startPreview(actionId) {
  const action = String(actionId || previewAction());
  const row = ACTION_IDS.indexOf(action);
  previewRow = row < 0 ? 0 : row;
  lastPreviewAction = action;
  els.previewCanvas.dataset.action = action;
  syncPreviewActionHighlight();
  stopPreview();
  if (!selectedPet() || !atlasReady || previewScale === 0 || reducedMotion() || document.hidden) {
    drawPreview(0);
    return;
  }
  const durations = framesFor(action);
  const start = performance.now();
  drawPreview(0);
  function step(now) {
    // Some hosts deliver media-query changes late; the loop must also honor the live preference.
    if (reducedMotion() || document.hidden || !selectedPet() || previewScale === 0) {
      rafId = 0;
      return;
    }
    drawPreview(frameAt(durations, now - start));
    rafId = requestAnimationFrame(step);
  }
  rafId = requestAnimationFrame(step);
}

function syncPreview() {
  const pet = selectedPet();
  if (!pet) {
    clearTimeout(previewAutoTimer);
    previewAutoTimer = null;
    clearPreviewInteraction(false);
    previewContextId = null;
    previewRestingAction = null;
    return;
  }
  const base = basePreviewAction();
  const auto = Boolean(currentSettings().autoPlay);
  const changedPet = previewContextId !== pet.id;
  const changedBase = previewBaseSnapshot !== base;
  const changedAuto = previewAutoEnabled !== auto;
  if (changedPet) {
    clearPreviewInteraction(false);
    previewRestingAction = base;
  } else if (changedBase || (changedAuto && !auto)) {
    previewRestingAction = base;
  }
  if (!currentSettings().followInput && previewTransientAction) clearPreviewInteraction(false);
  previewContextId = pet.id;
  previewBaseSnapshot = base;
  previewAutoEnabled = auto;
  if (petIsShown() && state.playingAction && state.playingAction.petId === pet.id) {
    clearTimeout(previewAutoTimer);
    previewAutoTimer = null;
    previewRestingAction = state.playingAction.action;
  }
  ensureAtlas(currentAtlasUrl());
  const action = previewAction();
  if (previewScale === 0) stopPreview();
  else if (action !== lastPreviewAction || (!rafId && atlasReady && !reducedMotion() && !document.hidden)) startPreview(action);
  if (changedPet || changedBase || changedAuto || !previewAutoTimer) schedulePreviewAuto();
}

function schedulePreviewAuto() {
  clearTimeout(previewAutoTimer);
  previewAutoTimer = null;
  if (!selectedPet() || loading || !currentSettings().autoPlay || previewTransientAction || reducedMotion() || document.hidden) return;
  // A shown pet supplies its actual action; do not run a competing preview clock.
  if (petIsShown() && state.playingAction && state.playingAction.petId === petFocusId()) return;
  previewAutoTimer = setTimeout(function () {
    previewAutoTimer = null;
    if (!selectedPet() || !currentSettings().autoPlay || previewTransientAction || reducedMotion() || document.hidden) return;
    if (petIsShown() && state.playingAction && state.playingAction.petId === petFocusId()) return;
    previewRestingAction = window.PetActions.pickAuto(previewAction());
    startPreview(previewRestingAction);
    schedulePreviewAuto();
  }, PREVIEW_AUTO_MIN_MS + Math.random() * PREVIEW_AUTO_RANGE_MS);
}

function clearPreviewInteraction(restore) {
  clearTimeout(previewInteractionTimer);
  previewInteractionTimer = null;
  previewTransientAction = null;
  previewTransientKind = null;
  previewPointerX = null;
  if (restore && selectedPet()) {
    startPreview(previewAction());
    schedulePreviewAuto();
  }
}

function canInteractWithPreview() {
  return Boolean(selectedPet() && previewScale > 0 && currentSettings().followInput && !loading && !busy && !document.hidden && !els.app.inert);
}

function playPreviewInteraction(action, kind) {
  if (!canInteractWithPreview()) return;
  clearTimeout(previewAutoTimer);
  previewAutoTimer = null;
  clearTimeout(previewInteractionTimer);
  const changed = previewTransientAction !== action;
  previewTransientAction = action;
  previewTransientKind = kind;
  if (changed || kind === 'once') startPreview(action);
  const duration = kind === 'follow' ? PREVIEW_FOLLOW_MS : framesFor(action).reduce(function (sum, value) { return sum + value; }, 0);
  previewInteractionTimer = setTimeout(function () { clearPreviewInteraction(true); }, duration);
}

function onPreviewPointerMove(event) {
  if (!canInteractWithPreview() || (event.pointerType && event.pointerType !== 'mouse')) return;
  if (event.target.closest('.hero-tools, .quality-tools')) {
    previewPointerX = null;
    return;
  }
  const bounds = els.hero.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) return;
  const previous = previewPointerX;
  previewPointerX = event.clientX;
  if (previous === null || Math.abs(event.clientX - previous) < 2 || previewTransientKind === 'once') return;
  playPreviewInteraction(event.clientX > previous ? 'running-right' : 'running-left', 'follow');
}

function onPreviewLeave() {
  previewPointerX = null;
  if (previewTransientAction) clearPreviewInteraction(true);
}

function onPreviewClick(event) {
  if (event.button !== 0 || event.target.closest('button, input, a, .hero-tools')) return;
  playPreviewInteraction(event.detail > 1 ? 'jumping' : 'waving', 'once');
}

function renderAll() {
  applyStaticText();
  if (els.pluginInfo) els.pluginInfo.textContent = t('pluginInfo', { version: state && state.pluginVersion || '—' });
  renderPetList();
  renderPet();
  renderGrowth();
  renderVisibility();
  renderActions();
  renderScale();
  renderToggles();
  renderDisabled();
  syncPreview();
  syncPreviewZoom(false);
  reportPageReady();
}

function reportPageReady() {
  if (!window.FriendEntrance || loading || (selectedPet() && currentAtlasUrl() && !atlasReady && !atlasFailed)) return;
  window.FriendEntrance.ready(atlasReady ? els.previewCanvas : null);
}

function applyState(next) {
  if (!next || typeof next !== 'object') return;
  const prevPetId = state && state.settings ? state.settings.petId : null;
  state = next;
  deviceCaps = next.deviceCaps && typeof next.deviceCaps === 'object' ? next.deviceCaps : null;
  syncSelection(prevPetId);
  if (prevPetId !== next.settings.petId) previewActionId = null;
  renderAll();
}

function setBusy(value, focusTarget) {
  if (value && !busy) {
    busyFocusBefore = document.activeElement;
    busyFocusTarget = focusTarget || busyFocusBefore;
  }
  busy = value;
  renderDisabled();
  if (!value) {
    const target = busyFocusTarget;
    const current = document.activeElement;
    if (target && target.isConnected && !target.disabled && target.getClientRects().length &&
        !els.app.inert && (current === document.body || current === busyFocusBefore)) {
      target.focus({ preventScroll: true });
    }
    busyFocusBefore = null;
    busyFocusTarget = null;
  }
}

function hideNotice() {
  els.notice.hidden = true;
  els.notice.textContent = '';
}

function showNotice(message, retryable) {
  clearTimeout(noticeTimer);
  els.notice.classList.remove('is-success');
  els.notice.setAttribute('role', 'alert');
  els.notice.hidden = false;
  els.notice.textContent = message;
  if (!retryable) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = t('retry');
  button.addEventListener('click', function () {
    hideNotice();
    if (typeof retryable === 'function') retryable();
    else loadState();
  });
  els.notice.appendChild(button);
}

function missingChannels() {
  return REQUIRED_CHANNELS.filter(function (name) { return typeof IPC[name] !== 'string'; });
}

async function request(patch, focusTarget) {
  if (busy || !state) return;
  setBusy(true, focusTarget);
  hideNotice();
  try {
    const next = await ipcRenderer.invoke(IPC.UPDATE, patch);
    if (!next || !next.settings) throw new Error('invalid state');
    applyState(next);
    return true;
  } catch (error) {
    renderAll();
    if (focusTarget && focusTarget.getAttribute('role') === 'radio') {
      const group = focusTarget.closest('[role="radiogroup"]');
      busyFocusTarget = group ? group.querySelector('[aria-checked="true"]') : focusTarget;
    }
    showNotice(t('settingsSaveError'), function () { request(patch, focusTarget); });
  } finally {
    setBusy(false);
  }
}

function onScaleInput() {
  sizeFieldInvalid = false;
  els.scaleValue.value = els.scaleRange.value;
  sizeScaleFieldWidth();
  commitScale(els.scaleRange.value);
}

function onScaleValueInput() {
  const draft = els.scaleValue.value.trim();
  const value = Number(draft);
  sizeFieldInvalid = draft === '' || !Number.isInteger(value) || value < SCALE_MIN || value > SCALE_MAX;
  sizeScaleFieldWidth();
  renderSizeHint();
  if (sizeFieldInvalid) return;
  commitScale(value);
}

// Keeps the pill tight around 1-3 digits instead of leaving a fixed gap before the % sign.
function sizeScaleFieldWidth() {
  const length = Math.max(2, Math.min(6, String(els.scaleValue.value || '').length));
  els.scaleValue.style.width = length + 'ch';
}

function syncScaleValueField() {
  sizeFieldInvalid = false;
  els.scaleValue.value = String(previewScale);
  sizeScaleFieldWidth();
  renderSizeHint();
}

function commitScale(raw) {
  const next = clampScale(Number(raw));
  const changed = next !== previewScale;
  previewScale = next;
  previewScales.set(petFocusId(), previewScale);
  hideNotice();
  if (petIsShown()) {
    scaleSyncPending = { petId: petFocusId(), value: previewScale };
    flushScaleSync();
  }
  renderScale();
  renderDisabled();
  // Dragging is direct manipulation: update without a trailing zoom transition.
  syncPreviewZoom(false);
  if (!changed) return;
  if (previewScale === 0) {
    clearPreviewInteraction(false);
    startPreview(previewAction());
  } else if (!rafId) {
    startPreview(previewAction());
  }
}

async function flushScaleSync() {
  if (scaleSyncActive || !scaleSyncPending) return;
  const job = scaleSyncPending;
  scaleSyncPending = null;
  if (!petIsShown() || petFocusId() !== job.petId) {
    renderAll();
    return;
  }
  scaleSyncActive = job;
  try {
    const next = await ipcRenderer.invoke(IPC.UPDATE, { scale: job.value, scalePetId: job.petId });
    if (!next || !next.settings) throw new Error('invalid state');
    applyState(next);
  } catch (error) {
    showNotice(t('sizeSaveError'), function () {
      if (!petIsShown() || petFocusId() !== job.petId) return;
      scaleSyncPending = job;
      hideNotice();
      flushScaleSync();
    });
  } finally {
    scaleSyncActive = null;
    if (scaleSyncPending) flushScaleSync();
    else renderAll();
  }
}

async function playAction(action) {
  if (!selectedPet() || busy || loading || typeof IPC.PLAY !== 'string') return;
  hideNotice();
  previewActionId = action;
  clearPreviewInteraction(false);
  previewRestingAction = action;
  startPreview(action);
  renderActions();
  schedulePreviewAuto();
  if (!petIsShown()) return;
  setBusy(true);
  try {
    const next = await ipcRenderer.invoke(IPC.PLAY, { action, once: false, petId: petFocusId() });
    if (next !== true) throw new Error('action rejected');
  } catch (error) {
    showNotice(t('actionError'), function () { playAction(action); });
  } finally {
    setBusy(false);
  }
}

function replayCurrent() {
  playAction(previewAction());
}

function syncPreviewZoom(pointer) {
  if (!selectedPet() || !els.hero.clientWidth || !els.hero.clientHeight) return;
  const canvas = els.previewCanvas;
  const style = getComputedStyle(canvas.parentElement);
  const width = els.hero.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const height = els.hero.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  const fit = Math.max(0.01, Math.min(width / FRAME_W, height / FRAME_H));
  // Reserve room for the slider's full range so it remains proportional at every size.
  const base = els.hero.classList.contains('is-zoomed') ? fit / (SCALE_MAX / 100) : Math.min(1, fit / (SCALE_MAX / 100));
  const scale = base * previewScale / 100;
  previewDisplayWidth = FRAME_W * scale;
  const transform = 'scale(' + scale.toFixed(4) + ')';
  if (canvas.style.transform === transform) return;
  if (zoomFade) {
    zoomFade.cancel();
    zoomFade = null;
  }
  canvas.dataset.motion = pointer && !reducedMotion() ? 'pointer' : 'none';
  canvas.style.transform = transform;
  if (pointer && reducedMotion()) {
    zoomFade = canvas.animate([{ opacity: 0.94 }, { opacity: 1 }], { duration: 60, easing: MOTION_EASE_OUT });
  }
}

function toggleZoom(event) {
  const pointer = Boolean(event && event.detail > 0);
  if (!pointer) {
    els.previewCanvas.dataset.motion = 'none';
    if (zoomFade) {
      zoomFade.cancel();
      zoomFade = null;
    }
  }
  const zoomed = !els.hero.classList.contains('is-zoomed');
  els.hero.classList.toggle('is-zoomed', zoomed);
  els.heroZoomBtn.setAttribute('aria-pressed', zoomed ? 'true' : 'false');
  const label = t(zoomed ? 'heroToolZoomOut' : 'heroToolZoom');
  els.heroZoomBtn.setAttribute('aria-label', label);
  els.heroZoomBtn.title = label;
  syncPreviewZoom(pointer);
}

async function resetPosition() {
  if (busy || !state) return;
  setBusy(true);
  hideNotice();
  try {
    const next = await ipcRenderer.invoke(IPC.RESET_POSITION);
    if (!next || !next.settings) throw new Error('invalid state');
    applyState(next);
  } catch (error) {
    renderAll();
    showNotice(t('resetError'), resetPosition);
  } finally {
    setBusy(false);
  }
}

function previewLevelUp() {
  if (levelUpCooldown || !state || !petIsShown()) return;
  if (typeof IPC.PREVIEW_LEVELUP !== 'string') {
    showNotice(t('connectionError'), true);
    return;
  }
  levelUpCooldown = true;
  renderDisabled();
  ipcRenderer.send(IPC.PREVIEW_LEVELUP, { petId: petFocusId() });
  setTimeout(function () {
    levelUpCooldown = false;
    renderDisabled();
  }, LEVELUP_COOLDOWN_MS);
}

async function loadState() {
  if (loading && state) return;
  loading = true;
  hideNotice();
  renderAll();
  if (missingChannels().length) {
    loading = false;
    renderAll();
    showNotice(t('connectionError'), false);
    return;
  }
  try {
    const next = await ipcRenderer.invoke(IPC.GET_STATE);
    if (!next || !next.settings) throw new Error('invalid state');
    applyState(next);
  } catch (error) {
    showNotice(t('connectionError'), true);
  } finally {
    loading = false;
    renderAll();
  }
}

// ---------- 宠物删除（长按 520ms 显示删除 → 二次确认） ----------

// 长按判定：按下后 520ms 未抬起即进入删除态；中途移动超过 8px、抬起或移出都取消。
function attachLongPress(row, id) {
  let timer = 0;
  let originX = 0;
  let originY = 0;
  const stop = function () {
    if (timer) {
      window.clearTimeout(timer);
      timer = 0;
    }
  };
  row.addEventListener('pointerdown', function (event) {
    if (busy || loading || !state) return;
    if (typeof event.button === 'number' && event.button > 0) return;
    stop();
    originX = Number(event.clientX) || 0;
    originY = Number(event.clientY) || 0;
    timer = window.setTimeout(function () {
      timer = 0;
      if (!row.isConnected || busy || loading) return;
      armPetRow(row, id, true);
    }, petManage.LONG_PRESS_MS);
  });
  row.addEventListener('pointerup', stop);
  row.addEventListener('pointercancel', stop);
  row.addEventListener('pointerleave', stop);
  row.addEventListener('pointermove', function (event) {
    if (!timer) return;
    const dx = Math.abs((Number(event.clientX) || 0) - originX);
    const dy = Math.abs((Number(event.clientY) || 0) - originY);
    if (dx > petManage.MOVE_TOLERANCE_PX || dy > petManage.MOVE_TOLERANCE_PX) stop();
  });
}

function armPetRow(row, id, pointer) {
  if (armedRow === row) return;
  disarmPetRow(pointer);
  armedRow = row;
  armedPetId = id;
  row.classList.toggle('has-delete-motion', Boolean(pointer));
  // Establish the hidden local start position before revealing the button.
  if (pointer) getComputedStyle(row.querySelector('.pet-item-delete')).transform;
  row.classList.add('is-armed');
  row.querySelector('.pet-item-delete').tabIndex = 0;
}

function disarmPetRow(pointer) {
  if (armedRow && armedRow.classList.contains('is-armed')) {
    if (!pointer) armedRow.classList.remove('has-delete-motion');
    if (document.activeElement === armedRow.querySelector('.pet-item-delete')) armedRow.querySelector('.pet-item-select').focus();
    armedRow.classList.remove('is-armed');
    armedRow.querySelector('.pet-item-delete').tabIndex = -1;
  }
  armedRow = null;
  armedPetId = null;
}

function openPetDeleteDialog(id, pointer) {
  if (busy || loading || !state) return;
  const pet = currentPets().filter(function (item) { return item.id === id; })[0];
  if (!pet) return;
  deleteReturnFocus = views.pets.get(id).querySelector('.pet-item-select');
  disarmPetRow(pointer);
  deletePetId = id;
  els.petDeleteError.hidden = true;
  els.petDeleteError.textContent = '';
  els.petDeleteHint.textContent = t('petDeleteHint', { name: petName(pet) });
  els.petDeleteDialog.setAttribute('data-open', '');
  els.app.inert = true;
  els.petDeleteCancelBtn.focus();
}

function closePetDeleteDialog() {
  if (!deletePetId || deleteBusy) return;
  els.petDeleteDialog.removeAttribute('data-open');
  els.app.inert = false;
  deletePetId = null;
  els.petDeleteConfirmBtn.disabled = false;
  const target = deleteReturnFocus;
  deleteReturnFocus = null;
  if (target && target.isConnected) target.focus();
  else els.petImportBtn.focus();
}

async function confirmPetDelete() {
  if (!deletePetId || deleteBusy) return;
  const id = deletePetId;
  const pet = currentPets().find(item => item.id === id);
  deleteBusy = true;
  els.petDeleteConfirmBtn.disabled = true;
  els.petDeleteCancelBtn.disabled = true;
  els.petDeleteError.hidden = true;
  try {
    const result = await ipcRenderer.invoke(IPC.DELETE, { id });
    if (!result || !result.ok) throw { code: result && result.error };
    applyState(result.state);
    deleteBusy = false;
    closePetDeleteDialog();
    const next = views.pets.get(petFocusId());
    (next ? next.querySelector('.pet-item-select') : els.petImportBtn).focus();
    flashNotice(t('petDeleted', { name: pet ? petName(pet) : id }));
  } catch (error) {
    els.petDeleteError.textContent = manageError('petDeleteError_', error.code);
    els.petDeleteError.hidden = false;
  } finally {
    deleteBusy = false;
    els.petDeleteConfirmBtn.disabled = false;
    els.petDeleteCancelBtn.disabled = false;
  }
}

function manageError(prefix, code) {
  const key = prefix + (code || 'unknown');
  return i18n.DICTS[i18n.normalizeLocale(currentSettings().locale)][key] ? t(key) : t(prefix + 'unknown');
}

let noticeTimer = null;
function flashNotice(message) {
  clearTimeout(noticeTimer);
  showNotice(message, false);
  els.notice.classList.add('is-success');
  els.notice.setAttribute('role', 'status');
  noticeTimer = window.setTimeout(hideNotice, 4000);
}

function showPetImportError(message) {
  els.petImportError.textContent = message;
  els.petImportError.hidden = false;
}

function openPetImportDialog() {
  if (busy || loading) return;
  disarmPetRow();
  importReturnFocus = document.activeElement;
  els.petImportError.hidden = true;
  els.petImportError.textContent = '';
  els.petImportLog.hidden = true;
  els.petImportLog.textContent = '';
  els.petNpxInput.value = '';
  els.petImportDialog.setAttribute('data-open', '');
  els.app.inert = true;
  els.petFolderBtn.focus();
}

function closePetImportDialog() {
  if (!els.petImportDialog.hasAttribute('data-open')) return;
  if (importBusy) {
    if (importClosePending) return;
    importClosePending = true; els.petImportCloseBtn.disabled = true; els.petImportLog.textContent = t('importCancelling');
    ipcRenderer.invoke(IPC.IMPORT_CANCEL, { requestId: importRequestId }).then(result => {
      if (!result || !result.ok) { importClosePending = false; els.petImportCloseBtn.disabled = false; }
    }).catch(() => { importClosePending = false; els.petImportCloseBtn.disabled = false; showPetImportError(t('petImportError_unknown')); });
    return;
  }
  els.petImportDialog.removeAttribute('data-open');
  els.app.inert = false;
  const target = importReturnFocus;
  importReturnFocus = null;
  if (target && target.isConnected) target.focus();
}

async function importPet(method, pointer) {
  if (importBusy) return;
  const epoch = feedbackEpoch;
  const previousIds = new Set(currentPets().map(pet => pet.id));
  const command = els.petNpxInput.value;
  if (method === 'command') {
    const parsed = petManage.parseNpxCommand(command);
    if (!parsed.ok) return showPetImportError(manageError('petImportError_', parsed.error === 'empty' ? 'empty-command' : parsed.error));
  }
  importBusy = true;
  importClosePending = false; importRequestId = Date.now().toString(36) + Math.random().toString(36).slice(2);
  els.petImportError.hidden = true;
  els.petImportLog.hidden = false;
  els.petImportLog.textContent = t(method === 'folder' ? 'petImportChoosing' : 'petImportDownloading');
  els.petNpxBtn.setAttribute('aria-busy', 'true');
  [els.petNpxBtn, els.petFolderBtn, els.petNpxInput].forEach(node => { node.disabled = true; });
  els.petImportCloseBtn.disabled = false; els.petImportCloseBtn.textContent = t('importCancel');
  try {
    const result = await ipcRenderer.invoke(IPC.IMPORT, { method, command, requestId: importRequestId });
    if (result && result.cancelled) {
      els.petImportLog.hidden = false; els.petImportLog.textContent = t('importCancelled');
      return;
    }
    if (!result || !result.ok) {
      const error = result && result.error;
      showPetImportError(error === 'exists' ? t('petImportExists', { id: result.id || '' }) : manageError('petImportError_', error));
      els.petImportLog.hidden = true;
      return;
    }
    applyState(result.state);
    selectPet(result.id);
    importBusy = false;
    closePetImportDialog();
    flashNotice(t('petImported', { name: result.name || result.id }));
    if (pointer && !previousIds.has(result.id)) revealImportedPet(result.id, epoch);
  } catch (error) {
    showPetImportError(t('petImportError_unknown'));
    els.petImportLog.hidden = true;
  } finally {
    importBusy = false;
    els.petNpxBtn.removeAttribute('aria-busy');
    [els.petNpxBtn, els.petFolderBtn, els.petNpxInput, els.petImportCloseBtn].forEach(node => { node.disabled = false; });
    els.petImportCloseBtn.textContent = t('petImportDone');
    if (importClosePending) { importClosePending = false; closePetImportDialog(); }
    if (els.petImportDialog.hasAttribute('data-open')) (method === 'command' ? els.petNpxInput : els.petFolderBtn).focus();
  }
}

async function revealImportedPet(id, epoch) {
  // Let the closing dialog clear the card before its one-time entry feedback.
  const animations = typeof els.petImportDialog.getAnimations === 'function'
    ? els.petImportDialog.getAnimations({ subtree: true }) : [];
  await Promise.allSettled(animations.map(animation => animation.finished));
  if (epoch !== feedbackEpoch || els.petImportDialog.hasAttribute('data-open')) return;
  const row = views.pets.get(id);
  if (!row || !row.isConnected) return;
  row.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  playLocalFeedback(row, 'translateY(6px) scale(0.98)', 200, epoch);
}

function trapManageFocus(event, dialog) {
  if (event.key !== 'Tab') return;
  const nodes = [...dialog.querySelectorAll('button,input')].filter(node => !node.disabled && node.getClientRects().length);
  if (!nodes.length) { event.preventDefault(); return; }
  const first = nodes[0], last = nodes[nodes.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

function bindPetManageEvents() {
  ipcRenderer.on(IPC.IMPORT_PROGRESS, (_event, data) => {
    if (!importBusy || !data || data.requestId !== importRequestId || importClosePending) return;
    const stage = ['reading', 'resolving', 'metadata', 'downloading', 'validating', 'installing'].includes(data.stage) ? data.stage : 'downloading';
    const percent = data.total > 0 ? ' ' + Math.min(100, Math.round(data.bytes / data.total * 100)) + '%' : '';
    els.petImportLog.textContent = t('importStage_' + stage) + percent;
  });
  els.petImportBtn.addEventListener('click', openPetImportDialog);
  els.petFolderBtn.addEventListener('click', event => importPet('folder', event.detail > 0));
  els.petNpxBtn.addEventListener('click', event => importPet('command', event.detail > 0));
  els.petNpxInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); importPet('command'); }
  });
  els.petImportCloseBtn.addEventListener('click', closePetImportDialog);
  els.petDeleteCancelBtn.addEventListener('click', closePetDeleteDialog);
  els.petDeleteConfirmBtn.addEventListener('click', confirmPetDelete);
  els.petImportDialog.addEventListener('mousedown', event => {
    if (event.target === els.petImportDialog) closePetImportDialog();
  });
  els.petDeleteDialog.addEventListener('mousedown', event => {
    if (event.target === els.petDeleteDialog) closePetDeleteDialog();
  });
  document.addEventListener('pointerdown', event => {
    if (armedRow && !armedRow.contains(event.target)) disarmPetRow(true);
  });
  document.addEventListener('keydown', event => {
    stopLocalFeedback();
    const dialog = els.petImportDialog.hasAttribute('data-open') ? els.petImportDialog : els.petDeleteDialog.hasAttribute('data-open') ? els.petDeleteDialog : null;
    if (dialog) {
      trapManageFocus(event, dialog);
      if (event.key === 'Escape') { event.preventDefault(); dialog === els.petImportDialog ? closePetImportDialog() : closePetDeleteDialog(); }
    } else if (event.key === 'Escape' && armedRow) { event.preventDefault(); disarmPetRow(); }
  });
}

function openNameDialog() {
  const pet = selectedPet();
  if (!pet || busy || loading) return;
  namePetId = pet.id;
  nameReturnFocus = document.activeElement;
  els.nameError.hidden = true;
  els.nameError.textContent = '';
  const target = petName(pet);
  els.nameDialogTitle.textContent = target ? t('namePetTitleFor', { name: target }) : t('namePetTitle');
  els.nameInput.value = target;
  els.nameInput.removeAttribute('aria-invalid');
  els.nameDialog.setAttribute('data-open', '');
  els.app.inert = true;
  els.nameInput.focus();
  if (typeof els.nameInput.select === 'function') els.nameInput.select();
}

function closeNameDialog() {
  if (nameSaving) return;
  els.nameDialog.removeAttribute('data-open');
  els.app.inert = false;
  namePetId = null;
  if (nameReturnFocus && nameReturnFocus.isConnected) nameReturnFocus.focus();
  else els.renameBtn.focus();
}

async function submitName() {
  if (nameSaving) return;
  const raw = String(els.nameInput.value || '');
  const value = raw.normalize('NFC').trim();
  const length = Array.from(value).length;
  if (length < 1 || length > NAME_MAX || CONTROL_CHARS.test(value)) {
    els.nameError.hidden = false;
    els.nameError.textContent = t('invalidName');
    els.nameInput.setAttribute('aria-invalid', 'true');
    els.nameInput.focus();
    return;
  }
  nameSaving = true;
  els.nameError.hidden = true;
  els.nameSaveBtn.disabled = true;
  els.nameSaveBtn.textContent = t('savingName');
  try {
    const next = await ipcRenderer.invoke(IPC.UPDATE, { petName: value, petNameId: namePetId });
    const renamed = next && Array.isArray(next.pets) && next.pets.find(function (pet) { return pet.id === namePetId; });
    if (!next || !next.settings || !renamed || renamed.name !== value) throw new Error('rename not saved');
    applyState(next);
    nameSaving = false;
    closeNameDialog();
  } catch (error) {
    els.nameError.hidden = false;
    els.nameError.textContent = t('nameSaveError');
  } finally {
    nameSaving = false;
    els.nameSaveBtn.disabled = false;
    els.nameSaveBtn.textContent = t('saveName');
  }
}

async function toggleVisible() {
  if (busy || loading || !selectedPet()) return;
  if (petIsShown()) {
    await request({ visible: false });
    return;
  }
  const target = petFocusId();
  setBusy(true);
  hideNotice();
  try {
    const next = await ipcRenderer.invoke(IPC.SELECT, { id: target, visible: true, action: previewAction(), scale: previewScale });
    if (!next || !next.settings || next.settings.petId !== target || !next.settings.visible) throw new Error('pet not shown');
    applyState(next);
  } catch (error) {
    showNotice(t('showPetError'), toggleVisible);
  } finally {
    setBusy(false);
  }
}

function bindEvents() {
  els.hero.addEventListener('pointermove', onPreviewPointerMove);
  els.hero.addEventListener('pointerleave', onPreviewLeave);
  els.hero.addEventListener('click', onPreviewClick);
  els.previewCanvas.addEventListener('keydown', function (event) {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
    playPreviewInteraction(event.key === ' ' ? 'jumping' : 'waving', 'once');
  });
  els.reloadBtn.addEventListener('click', loadState);
  els.toggleVisibleBtn.addEventListener('click', toggleVisible);
  els.resetBtn.addEventListener('click', resetPosition);
  els.previewLevelBtn.addEventListener('click', previewLevelUp);
  els.renameBtn.addEventListener('click', openNameDialog);
  els.heroZoomBtn.addEventListener('click', toggleZoom);
  els.heroReplayBtn.addEventListener('click', replayCurrent);
  els.scaleRange.addEventListener('input', onScaleInput);
  els.scaleValue.addEventListener('input', onScaleValueInput);
  els.scaleValue.addEventListener('blur', syncScaleValueField);
  els.scaleValue.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      syncScaleValueField();
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (!sizeFieldInvalid) syncScaleValueField();
  });
  els.nameCancelBtn.addEventListener('click', closeNameDialog);
  els.nameForm.addEventListener('submit', function (event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    submitName();
  });
  els.nameDialog.addEventListener('mousedown', function (event) {
    if (event.target === els.nameDialog) closeNameDialog();
  });
  bindPetManageEvents();
  document.addEventListener('keydown', function (event) {
    if (!els.nameDialog.hasAttribute('data-open')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeNameDialog();
    }
    if (event.key === 'Tab') {
      const controls = Array.from(els.nameForm.querySelectorAll('input, button')).filter(function (node) { return !node.disabled; });
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });
  if (typeof window !== 'undefined' && window && typeof window.addEventListener === 'function') {
    window.addEventListener('resize', onLayoutChange);
    window.addEventListener('blur', onPreviewLeave);
    watchToggleSizes();
  }
  motionPreference.addEventListener('change', function () {
    stopLocalFeedback();
    if (zoomFade) {
      zoomFade.cancel();
      zoomFade = null;
    }
    els.previewCanvas.dataset.motion = 'none';
    syncPreviewZoom(false);
    if (selectedPet()) startPreview(previewAction());
    schedulePreviewAuto();
  });
  document.addEventListener('visibilitychange', function () {
    onPreviewLeave();
    if (document.hidden) stopPreview();
    else if (selectedPet()) startPreview(previewAction());
    schedulePreviewAuto();
  });
  ipcRenderer.on(IPC.STATE, function (event, next) {
    if (next && next.settings) applyState(next);
  });
  if (typeof IPC.HOST_TIP === 'string') {
    ipcRenderer.on(IPC.HOST_TIP, function (event, payload) {
      showHostTip(payload);
    });
  }
  if (typeof IPC.PERF === 'string') {
    ipcRenderer.on(IPC.PERF, function (event, payload) {
      applyPerfStatus(payload);
    });
  }
}

function showHostTip(payload) {
  const tip = document.getElementById('hostTip');
  const label = document.getElementById('hostTipText');
  if (!tip || !label) return;
  const text = payload && typeof payload.text === 'string' ? payload.text : '';
  if (!text) {
    tip.removeAttribute('data-visible');
    return;
  }
  label.textContent = text;
  tip.setAttribute('data-visible', '');
  const width = tip.offsetWidth;
  const centre = Number.isFinite(payload.x) ? payload.x : 0;
  const limit = Math.max(8, window.innerWidth - width - 8);
  tip.style.left = Math.round(Math.min(Math.max(centre - width / 2, 8), limit)) + 'px';
}

function ensureAtlas(url) {
  if (!url) {
    atlasSource = '';
    atlasReady = false;
    return;
  }
  if (url === atlasSource) return;
  atlasSource = url;
  atlasReady = false;
  atlasFailed = false;
  const image = new Image();
  atlas = image;
  image.onload = function () {
    if (atlas !== image) return;
    atlasReady = true;
    renderToggles();
    lastPreviewAction = null;
    if (state) startPreview(previewAction());
    else drawPreview(0);
    reportPageReady();
  };
  image.onerror = function () {
    if (atlas !== image) return;
    atlasReady = false;
    atlasSource = '';
    const pet = selectedPet();
    if (pet && pet.atlasUrl === url && pet.fallbackAtlasUrl) {
      atlasFallbacks.set(url, pet.fallbackAtlasUrl); ensureAtlas(pet.fallbackAtlasUrl); return;
    }
    showNotice(t('imageLoadError'), function () { ensureAtlas(currentAtlasUrl()); });
    atlasFailed = true;
    reportPageReady();
  };
  image.src = url;
}

function initPreviewCanvas() {
  els.previewCanvas.width = FRAME_W * pixelRatio;
  els.previewCanvas.height = FRAME_H * pixelRatio;
  if (previewCtx) {
    previewCtx.imageSmoothingEnabled = false;
    previewCtx.scale(pixelRatio, pixelRatio);
  }
  ensureAtlas(currentAtlasUrl());
}

// 测试钩子：行表是纯数据、能力表应用是纯函数入口，自测脚本据此断言，不必驱动整个页面。
window.__settingsRowGroups = ROW_GROUPS;
window.__settingsBuildRows = buildToggles;
window.__settingsApplyDeviceCaps = function (caps) {
  deviceCaps = caps && typeof caps === 'object' ? caps : null;
  renderDeviceCaps();
  syncTogglesVisibility();
  syncTogglesScroll();
  return capabilityHiddenKeys(deviceCaps);
};
window.__settingsTabs = function () {
  // 逐个页签量一遍内容高度：切过去 -> 量可见行 -> 切回来。
  const panels = {};
  const restore = activeTab;
  TAB_IDS.forEach(function (id) {
    activeTab = id;
    syncTogglesVisibility();
    panels[id] = { rows: tabKeys(id), height: tabsContentHeight() };
  });
  activeTab = restore;
  syncTogglesVisibility();
  syncTogglesScroll();
  return {
    ids: TAB_IDS.slice(),
    activeId: restore,
    panels: panels,
    container: {
      height: Number(els.toggles && els.toggles.clientHeight) || 0,
      wrap: Number(els.togglesWrap && els.togglesWrap.clientHeight) || 0
    }
  };
};
window.__settingsRowSnapshot = function () {
  const rows = [];
  ROW_GROUPS.forEach(function (group) {
    group.rows.forEach(function (spec) {
      const view = views.toggles.get(spec.key) || views.choices.get(spec.key);
      rows.push({
        key: spec.key,
        group: group.id,
        kind: spec.kind,
        tab: spec.tab || TAB_IDS[0],
        hidden: Boolean(view && view.row && view.row.hidden),
        visible: visibleRowKeys.indexOf(spec.key) >= 0
      });
    });
  });
  return {
    rows: rows,
    activeTab: activeTab,
    capsHint: views.capsHint ? { visible: !views.capsHint.hidden, text: String(views.capsHint.textContent || '') } : null
  };
};

buildActionGrid();
buildToggles();
initQualityControls();
initTabs();
initPreviewCanvas();
bindEvents();
renderAll();
loadState();
if (window.PetManagement) { window.PetManagement.init({ ipc: ipcRenderer, IPC, t, getState: () => state, applyState, notify: flashNotice }); syncTogglesVisibility(); syncTogglesScroll(); }
