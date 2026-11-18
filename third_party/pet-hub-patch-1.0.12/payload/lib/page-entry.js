'use strict';

const crypto = require('crypto');
const friendSvg = require('fs').readFileSync(require('path').join(__dirname,'../renderer/settings/assets/friends.svg'),'utf8');
const FRIEND_ICON_PATHS = Array.from(friendSvg.matchAll(/<path\s+([^>]+)>/g),match=>({ d:(match[1].match(/\bd="([^"]+)"/)||[])[1], fill:(match[1].match(/\bfill="([^"]+)"/)||[])[1]||'currentColor' })).filter(shape=>shape.d);

const ENTRY_ATTR = 'data-mchose-pet-entry';
const PET_ICON_ATTR = 'data-mchose-pet-icon';
const PET_ICON_SELECTOR = '[' + PET_ICON_ATTR + ']';
const ICON_SELECTOR = '.mc-tabs__item-icon, du-icon';
const ICON_VIEW_BOX = '0 0 1024 1024';
const CAT_EYES_FILL = '#1296db';
const CAT_PATH_EYES = 'M649.3128125 441.7990625c0 19.29375-15.6796875 34.9846875-34.9846875 34.9846875-19.303125 0-34.981875-15.6909375-34.981875-34.9846875 0-19.303125 15.6796875-34.993125 34.981875-34.993125 19.305 0 34.9846875 15.69 34.9846875 34.993125M474.3921875 441.7990625c0 19.29375-15.6909375 34.9846875-34.993125 34.9846875-19.29375 0-34.9846875-15.6909375-34.9846875-34.9846875 0-19.303125 15.6909375-34.993125 34.9846875-34.993125 19.303125 0 34.993125 15.69 34.993125 34.993125';
const CAT_PATH_BODY = 'M789.2590625 931.585625c-57.890625 0-104.9625-47.083125-104.9625-104.9625 0-19.305-15.6796875-34.9734375-34.9846875-34.9734375-19.3134375 0-34.9846875 15.6684375-34.9846875 34.9734375 0 57.879375-47.083125 104.9625-104.9625 104.9625-57.868125 0-104.95125-47.083125-104.95125-104.9625 0-19.305-15.6703125-34.9734375-34.9846875-34.9734375-19.305 0-34.9734375 15.6684375-34.9734375 34.9734375 0 57.879375-47.083125 104.9625-104.9625 104.9625-57.8709375 0-104.953125-47.083125-104.953125-104.9625 0-19.3359375 15.64875-34.9734375 34.9846875-34.9734375 19.3378125 0 34.9846875 15.6375 34.9846875 34.9734375 0 19.29375 15.6796875 34.995 34.9846875 34.995 19.3134375 0 34.9846875-15.70125 34.9846875-34.995 0-57.868125 47.083125-104.95125 104.95125-104.95125 57.879375 0 104.9625 47.083125 104.9625 104.95125 0 19.29375 15.6684375 34.995 34.9734375 34.995 19.31625 0 34.9846875-15.70125 34.9846875-34.995 0-57.868125 47.083125-104.95125 104.9625-104.95125 57.8709375 0 104.953125 47.083125 104.953125 104.95125 0 19.29375 15.6796875 34.995 34.993125 34.995 19.29375 0 34.9734375-15.70125 34.9734375-34.995V476.7828125c0-173.6296875-141.2371875-314.866875-314.866875-314.866875-173.6184375 0-314.855625 141.2371875-314.855625 314.866875v201.1603125c0 19.3359375-15.646875 34.9846875-34.9846875 34.9846875-19.3359375 0-34.9846875-15.64875-34.9846875-34.9846875V476.7828125c0-212.2059375 172.6734375-384.8334375 384.825-384.8334375 212.173125 0 384.8353125 172.6275 384.8353125 384.8334375v349.8403125c0.0009375 57.879375-47.0709375 104.9625-104.941875 104.9625';
const ENTRY_TEXT = 'Friends';
const OPEN_TOKEN = '__MCHOSE_PET_OPEN__';
const MISS_TOKEN = '__MCHOSE_PET_ENTRY_MISS__';
const CLOSE_TOKEN = '__MCHOSE_PET_CLOSE__';
const HOME_TOKEN = '__MCHOSE_PET_HOME__';
const BAR_ATTR = 'data-mchose-pet-homebar';
const BAR_CLASS = 'mchose-pet-home';
const BAR_STYLE_ID = 'mchose-pet-home-style';
const CHROME_CLASS = 'mchose-pet-chrome-off';
const CHROME_STYLE_ID = 'mchose-pet-chrome-style';
const POPUP_ON_TOKEN = '__MCHOSE_PET_POPUP_ON__';
const POPUP_OFF_TOKEN = '__MCHOSE_PET_POPUP_OFF__';
const POPUP_SELECTOR = '.el-popper, .el-tooltip__popper, .el-dropdown__popper, .el-popover, [role="tooltip"], .el-overlay, .el-message-box, .el-dialog, .el-drawer';
const POPUP_POLL_MS = 120;
const TIP_ON_TOKEN = '__MCHOSE_PET_TIP_ON__';
const TIP_OFF_TOKEN = '__MCHOSE_PET_TIP_OFF__';
const TIP_ATTR = 'data-mchose-pet-tip';
const TIP_STYLE_ID = 'mchose-pet-tip-style';
const TIP_CLASS = 'mchose-pet-tip-mirror';
const BAR_LABEL = '返回主页';
const NAV_ATTR = 'data-mchose-pet-nav';
const TABS_SELECTOR = '.el-tabs, .app-header__primary-group';
const TAB_ID = 'tab-mall';
const TAB_TEXTS = ['官方商城', '神光同步', '云端社区'];
const ITEM_SELECTOR = '.el-tabs__item, .app-header__primary-group > span';
const TEXT_SELECTOR = '.mc-tabs__item-text, span:not([slot])';
const ENTRY_SELECTOR = '[' + ENTRY_ATTR + ']';
const LEGACY_TAGS = ['div', 'span', 'a', 'li', 'button'];
const STRIP_ATTRIBUTES = ['id', 'aria-controls', 'data-track', 'tabindex', 'href', 'data-href', 'onclick'];
const TOP_PROTOCOLS = ['mchose-renderer:', 'http:', 'https:'];
const REMOTE_HOSTS = ['mchose.com.cn', 'maicong.cn'];
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1'];
const RETRY_INTERVAL_MS = 500;
const RETRY_MAX_MS = 60000;
const HEAL_DEBOUNCE_MS = 300;
const HEAL_MIN_DELAY_MS = 1000;
const HEAL_MAX_DELAY_MS = 5000;
const HEAL_BACKOFF = 1.5;
const HEAL_ATTEMPT_LIMIT = 5;
// A burst of load/frame-load/navigate/dom-ready events for one window is merged into one leading run
// plus one trailing run; a record whose attempt ended in give-up waits out the backoff before the next
// event may inject again. Both are floors on real injections, not on logging.
const KICK_MERGE_MS = 250;
const KICK_GIVE_UP_BACKOFF_MS = 5000;
const UI_MIN_WIDTH = 400;
const NON_UI_BASENAMES = ['tray.html'];
const URL_LOG_LIMIT = 32;
const FRAME_STATUS_INJECTED = 'injected';
const FRAME_STATUS_PRESENT = 'present';
const FRAME_STATUS_MISS = 'miss';
const ORIGIN_TOKEN = '__MCHOSE_PET_ORIGIN__';
const ORIGIN_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/[^\/\s]+$/i;

// The host page the entry is mounted on is not ours: every selector and every piece of copy we
// rely on is host-build specific and belongs in one place. When the host ships a new build, bump
// `version` and fix the entries that broke; pageEntry.status() reports the profile that failed.
const HOST_PROFILE = Object.freeze({
  version: 2,
  entryAttr: ENTRY_ATTR,
  entrySelector: ENTRY_SELECTOR,
  petIconAttr: PET_ICON_ATTR,
  petIconSelector: PET_ICON_SELECTOR,
  iconSelector: ICON_SELECTOR,
  iconViewBox: '64 64 896 896',
  // Header bar: the home entry is mounted into the header's left slot.
  headerSelector: '.app-header, .header.flex.flex-sb',
  headerFallbackSelector: '.header',
  headerLeftSelector: '.app-header__left, .left',
  headerBackClass: 'back',
  headerActionSelector: '.header-action, .app-header__utility-action',
  headerActionClass: 'header-action',
  // The host's tab strip is the template the pet entry is cloned from.
  tabsSelector: TABS_SELECTOR,
  itemSelector: ITEM_SELECTOR,
  textSelector: TEXT_SELECTOR,
  tabTexts: TAB_TEXTS,
  entryText: ENTRY_TEXT,
  barLabel: BAR_LABEL,
  // Layers the host draws on top of the inline page.
  tooltipSelector: '.el-tooltip, .el-tooltip__popper, [role="tooltip"]',
  popupSelector: POPUP_SELECTOR
});

// One nonce per injection generation: an injected script has to present it for the main process
// to trust a token line, so a stray console.log or a foreign frame cannot drive the page.
function createNonce() {
  try {
    return crypto.randomBytes(12).toString('hex');
  } catch (error) {
    return 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
}

// A custom scheme is a tuple origin in Chromium (mchose-renderer://app), which URL.origin cannot
// express, so the scheme/host pair is spelled out by hand. Returns '' when nothing is knowable.
function originOf(rawUrl) {
  const parsed = parseUrl(rawUrl);
  if (!parsed) return '';
  const protocol = String(parsed.protocol || '').toLowerCase();
  if (protocol === 'mchose-renderer:') {
    const host = String(parsed.host || '').toLowerCase();
    return host ? 'mchose-renderer://' + host : '';
  }
  if (protocol === 'file:') return 'file://';
  if (protocol !== 'http:' && protocol !== 'https:') return '';
  return ORIGIN_PATTERN.test(String(parsed.origin || '')) ? parsed.origin : '';
}

function parseUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) return null;
  try {
    return new URL(rawUrl);
  } catch (error) {
    return null;
  }
}

function isLocalHost(host) {
  for (let index = 0; index < LOCAL_HOSTS.length; index += 1) {
    if (host === LOCAL_HOSTS[index]) return true;
  }
  return false;
}

function isRemoteHost(host) {
  for (let index = 0; index < REMOTE_HOSTS.length; index += 1) {
    const domain = REMOTE_HOSTS[index];
    if (host === domain || host.endsWith('.' + domain)) return true;
  }
  return false;
}

function isTopLevelUrl(rawUrl) {
  const parsed = parseUrl(rawUrl);
  if (!parsed) return false;
  const protocol = String(parsed.protocol || '').toLowerCase();
  if (protocol === 'mchose-renderer:') return true;
  if (TOP_PROTOCOLS.indexOf(protocol) < 0) return false;
  const host = String(parsed.hostname || '').toLowerCase();
  if (!host) return false;
  return isLocalHost(host) || isRemoteHost(host);
}

function isFrameTargetUrl(rawUrl) {
  const parsed = parseUrl(rawUrl);
  if (!parsed) return false;
  const protocol = String(parsed.protocol || '').toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') return false;
  const host = String(parsed.hostname || '').toLowerCase();
  if (!host) return false;
  // Only the host's own origins are targets. A path hint such as /custompage/ used to admit any
  // https origin that happened to serve that route, which handed the injection surface to the
  // whole internet; the real host iframe is https://www.mchose.com.cn and passes on host alone.
  return isLocalHost(host) || isRemoteHost(host);
}

function isAppShellUrl(rawUrl) {
  const parsed = parseUrl(rawUrl);
  if (!parsed) return false;
  return String(parsed.protocol || '').toLowerCase() === 'mchose-renderer:';
}

function frameTree(root) {
  const out = [];
  if (!root) return out;
  let subtree = null;
  try {
    subtree = root.framesInSubtree;
  } catch (error) {
    subtree = null;
  }
  if (Array.isArray(subtree) && subtree.length > 0) {
    for (let index = 0; index < subtree.length; index += 1) {
      if (subtree[index] && out.indexOf(subtree[index]) < 0) out.push(subtree[index]);
    }
    return out;
  }
  const stack = [root];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame || out.indexOf(frame) >= 0) continue;
    out.push(frame);
    let children = null;
    try {
      children = frame.frames;
    } catch (error) {
      children = null;
    }
    if (Array.isArray(children)) {
      for (let index = 0; index < children.length; index += 1) stack.push(children[index]);
    }
  }
  return out;
}

function frameUrl(frame) {
  if (!frame) return '';
  try {
    return typeof frame.url === 'string' ? frame.url : '';
  } catch (error) {
    return '';
  }
}

// The bridge relays a frame's click to the main process, and the frame presents the nonce *it* was
// injected with. Shell and frame are injected generations apart, so the bridge has to trust the live
// history, not only the generation that happens to be current when the shell was last injected.
function bridgeNonces(opts) {
  const out = [];
  const add = (value) => {
    if (typeof value !== 'string' || !value) return;
    if (out.indexOf(value) >= 0) return;
    out.push(value);
  };
  add(typeof opts.nonce === 'string' ? opts.nonce : '');
  const history = Array.isArray(opts.nonces) ? opts.nonces : [];
  for (let index = 0; index < history.length; index += 1) add(history[index]);
  return out;
}

function buildConfig(options) {
  const opts = options || {};
  const openToken = typeof opts.openToken === 'string' && opts.openToken ? opts.openToken : OPEN_TOKEN;
  const missToken = typeof opts.missToken === 'string' && opts.missToken ? opts.missToken : MISS_TOKEN;
  const closeToken = typeof opts.closeToken === 'string' && opts.closeToken ? opts.closeToken : CLOSE_TOKEN;
  return {
    // Which host profile this injection was built against, so a miss can name the profile that
    // stopped matching instead of only saying that something is missing.
    profileVersion: HOST_PROFILE.version,
    nonce: typeof opts.nonce === 'string' ? opts.nonce : '',
    // The current nonce first, then every generation still trusted: the relay accepts any of them but
    // stamps the line it forwards with `nonce`, so the main process keeps exactly one live stamp.
    nonces: bridgeNonces(opts),
    originToken: ORIGIN_TOKEN,
    // The origin of the document that owns the target frame, derived from that page's url. Empty
    // means nothing can be addressed (an opaque file: origin): the frame then only logs its token
    // and posts nothing, rather than posting to a wildcard target.
    targetOrigin: typeof opts.targetOrigin === 'string' ? opts.targetOrigin : '',
    // The bridge relays these from a frame and nothing else.
    frameTokens: [openToken, missToken, closeToken],
    entryAttr: HOST_PROFILE.entryAttr,
    entrySelector: HOST_PROFILE.entrySelector,
    iconSelector: typeof opts.iconSelector === 'string' && opts.iconSelector ? opts.iconSelector : HOST_PROFILE.iconSelector,
    petIconAttr: HOST_PROFILE.petIconAttr,
    petIconSelector: HOST_PROFILE.petIconSelector,
    iconPaths: FRIEND_ICON_PATHS,
    iconViewBox: typeof opts.iconViewBox === 'string' && opts.iconViewBox ? opts.iconViewBox : HOST_PROFILE.iconViewBox,
    bodyPath: typeof opts.bodyPath === 'string' && opts.bodyPath ? opts.bodyPath : CAT_PATH_BODY,
    eyesPath: typeof opts.eyesPath === 'string' && opts.eyesPath ? opts.eyesPath : CAT_PATH_EYES,
    eyesFill: typeof opts.eyesFill === 'string' && opts.eyesFill ? opts.eyesFill : CAT_EYES_FILL,
    entryText: typeof opts.entryText === 'string' && opts.entryText ? opts.entryText : HOST_PROFILE.entryText,
    openToken,
    missToken,
    closeToken,
    navAttr: typeof opts.navAttr === 'string' && opts.navAttr ? opts.navAttr : NAV_ATTR,
    headerSelector: HOST_PROFILE.headerSelector,
    headerFallbackSelector: HOST_PROFILE.headerFallbackSelector,
    headerLeftSelector: HOST_PROFILE.headerLeftSelector,
    headerBackClass: HOST_PROFILE.headerBackClass,
    headerActionSelector: HOST_PROFILE.headerActionSelector,
    headerActionClass: HOST_PROFILE.headerActionClass,
    tooltipSelector: HOST_PROFILE.tooltipSelector,
    frameSelector: typeof opts.frameSelector === 'string' && opts.frameSelector ? opts.frameSelector : 'iframe',
    tabsSelector: typeof opts.tabsSelector === 'string' && opts.tabsSelector ? opts.tabsSelector : HOST_PROFILE.tabsSelector,
    tabId: typeof opts.tabId === 'string' && opts.tabId ? opts.tabId : TAB_ID,
    tabTexts: Array.isArray(opts.tabTexts) && opts.tabTexts.length > 0 ? opts.tabTexts.slice() : HOST_PROFILE.tabTexts.slice(),
    itemSelector: typeof opts.itemSelector === 'string' && opts.itemSelector ? opts.itemSelector : HOST_PROFILE.itemSelector,
    textSelector: typeof opts.textSelector === 'string' && opts.textSelector ? opts.textSelector : HOST_PROFILE.textSelector,
    legacyTags: Array.isArray(opts.legacyTags) && opts.legacyTags.length > 0 ? opts.legacyTags.slice() : LEGACY_TAGS.slice(),
    stripAttributes: Array.isArray(opts.stripAttributes) ? opts.stripAttributes.slice() : STRIP_ATTRIBUTES.slice(),
    retryIntervalMs: Number.isFinite(opts.retryIntervalMs) && opts.retryIntervalMs > 0 ? opts.retryIntervalMs : RETRY_INTERVAL_MS,
    retryMaxMs: Number.isFinite(opts.retryMaxMs) && opts.retryMaxMs > 0 ? opts.retryMaxMs : RETRY_MAX_MS,
    healDebounceMs: Number.isFinite(opts.healDebounceMs) && opts.healDebounceMs > 0 ? opts.healDebounceMs : HEAL_DEBOUNCE_MS,
    statusInjected: FRAME_STATUS_INJECTED,
    statusPresent: FRAME_STATUS_PRESENT,
    statusMiss: FRAME_STATUS_MISS
  };
}

function injectedBridgeMain(CFG) {
  try {
    var state = window.__mchosePetBridgeState;
    if (!state) {
      state = { nonce: '', tokens: [], nonces: [], handler: null, listening: false };
      window.__mchosePetBridgeState = state;
    }
    // Later injections write into these same arrays: reassigning them would leave a handler that is
    // still attached looking at a snapshot of the generations that existed when it was installed.
    if (!state.nonces || typeof state.nonces.length !== 'number') state.nonces = [];
    if (!state.tokens || typeof state.tokens.length !== 'number') state.tokens = [];
    state.nonce = typeof CFG.nonce === 'string' ? CFG.nonce : '';
    var incomingTokens = CFG.frameTokens && CFG.frameTokens.length ? CFG.frameTokens : [];
    state.tokens.length = 0;
    for (var tokenIndex = 0; tokenIndex < incomingTokens.length; tokenIndex += 1) {
      if (typeof incomingTokens[tokenIndex] === 'string' && incomingTokens[tokenIndex]) state.tokens.push(incomingTokens[tokenIndex]);
    }
    // A frame that posts a click was injected at a different moment than this document, so the only
    // nonce it can present is the one it was given then. Accepting the live history keeps that click
    // working; the line still leaves with the live nonce, which is the stamp the main process accepts.
    var incomingNonces = [];
    if (CFG.nonces && typeof CFG.nonces.length === 'number') {
      for (var index = 0; index < CFG.nonces.length; index += 1) {
        if (typeof CFG.nonces[index] === 'string' && CFG.nonces[index]) incomingNonces.push(CFG.nonces[index]);
      }
    }
    if (incomingNonces.length === 0 && state.nonce) incomingNonces.push(state.nonce);
    state.nonces.length = 0;
    for (var nonceIndex = 0; nonceIndex < incomingNonces.length; nonceIndex += 1) {
      if (state.nonces.indexOf(incomingNonces[nonceIndex]) < 0) state.nonces.push(incomingNonces[nonceIndex]);
    }
    // A handler outlives the injection that installed it, so nothing may be read from this closure:
    // the state is re-read on every call and the generation that answers a click is the live one.
    function liveState() {
      var live = null;
      try { live = window.__mchosePetBridgeState; } catch (error) { live = null; }
      return live && typeof live === 'object' ? live : state;
    }
    function liveList(list, fallback) {
      return list && typeof list.length === 'number' ? list : fallback;
    }
    function acceptsNonce(value) {
      if (typeof value !== 'string' || !value) return false;
      var live = liveState();
      var list = liveList(live && live.nonces, state.nonces);
      for (var at = 0; at < list.length; at += 1) {
        if (value === list[at]) return true;
      }
      return false;
    }
    // window.frames only enumerates direct children, and a frame nested one level deeper is still
    // part of this page, so the source check rejects this window and its opener and leaves the
    // nonce as the real authenticator.
    function fromFrame(source) {
      if (!source || source === window) return false;
      var opener = null;
      try { opener = window.opener; } catch (error) { opener = null; }
      return !(opener && source === opener);
    }
    function relay(data) {
      if (!data || typeof data !== 'object') return;
      var live = liveState();
      // The stamp must be the live nonce: a stale one, or none at all, is rejected by the main
      // process, so there would be nothing useful to relay.
      var stamp = typeof live.nonce === 'string' ? live.nonce : '';
      if (!stamp || !acceptsNonce(data.nonce)) return;
      var token = typeof data.token === 'string' ? data.token : '';
      if (!token) return;
      var tokens = liveList(live && live.tokens, state.tokens);
      if (tokens.indexOf(token) < 0) return;
      var payload = typeof data.payload === 'string' ? data.payload : '';
      try { console.log(stamp + ' ' + token + payload); } catch (error) {}
    }
    // Exactly one listener per window, and it is always the newest one: a handler that is merely left
    // in place keeps answering with whatever it was given, and two live handlers would relay every
    // click twice.
    if (state.handler) {
      try { window.removeEventListener('message', state.handler, false); } catch (error) {}
      state.handler = null;
      state.listening = false;
    }
    var handler = function (event) {
      try {
        if (!event || !fromFrame(event.source)) return;
        relay(event.data);
      } catch (error) {}
    };
    try {
      window.addEventListener('message', handler, false);
    } catch (error) {
      // A handler that is recorded but not attached is worse than none: every later injection would
      // see state.handler set and skip installing a working listener.
      state.handler = null;
      state.listening = false;
      return false;
    }
    state.handler = handler;
    state.listening = true;
    window.__mchosePetBridgeInstalled = true;
    // A custom scheme's origin cannot be derived from the URL by the main process, so the shell is
    // the one that says what its own origin is, on a line that carries the nonce like every other.
    try {
      var origin = window.location && typeof window.location.origin === 'string' ? window.location.origin : '';
      if (origin && origin !== 'null') console.log(state.nonce + ' ' + CFG.originToken + origin);
    } catch (error) {}
    return true;
  } catch (error) {
    return false;
  }
}

function injectedHomeBarMain(CFG) {
  var RT = window.__mchosePetHomeBar;
  if (!RT) {
    RT = { desired: false, observer: null, queued: false, onHash: null };
    window.__mchosePetHomeBar = RT;
  }
  RT.desired = CFG.on === true;
  RT.config = CFG;

  function ensureStyle() {
    if (!document.documentElement || document.getElementById(CFG.styleId)) return;
    var style = document.createElement('style');
    style.id = CFG.styleId;
    style.textContent = [
      'html.' + CFG.cls + ' .header .left > .company-wrapper{display:none!important}',
      '.' + CFG.cls + '-link{display:flex;align-items:center;-webkit-app-region:no-drag;cursor:pointer;color:rgb(21,21,21);}',
      '.' + CFG.cls + '-link > .header-back-icon{width:20px;height:20px;font-size:20px;line-height:20px;display:inline-flex;align-items:center;justify-content:center;color:rgb(21,21,21);}',
      '.' + CFG.cls + '-link > .name{margin-left:8px;font-size:16px;line-height:20px;color:rgb(21,21,21);}',
      '.' + CFG.cls + '-link:hover > .name{color:rgb(64,64,64);}'
      ,'html.' + CFG.cls + ' .app-header__primary-group{display:none!important}'
      ,'.app-header .' + CFG.cls + '-link{padding:14px 24px;border-radius:36px;background:rgba(255,255,255,.4);box-shadow:inset 0 1px 0 rgba(255,255,255,.7);gap:0;}'
      ,'html.' + CFG.cls + ' .app-header__left > :not([' + CFG.attr + ']){display:none!important}'
      ,'.app-header .' + CFG.cls + '-link{padding:0;background:none;box-shadow:none;gap:16px;cursor:default;}'
      ,'.app-header .' + CFG.cls + '-link .friend-title{margin:0;font:600 24px/1.4 MiSans,"Microsoft YaHei",sans-serif;color:rgba(0,0,0,.9);}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(style);
  }

  function headerLeft() {
    var header = Array.from(document.querySelectorAll(CFG.headerSelector)).find(node=>node.getClientRects().length&&getComputedStyle(node).visibility!=='hidden') || document.querySelector(CFG.headerFallbackSelector);
    if (!header) return null;
    return header.querySelector(CFG.headerLeftSelector);
  }

  function barNode() {
    return document.querySelector('[' + CFG.attr + ']');
  }

  function nativeBack(left) {
    var children = left && left.children ? left.children : [];
    for (var index = 0; index < children.length; index += 1) {
      var child = children[index];
      if (!child || child === barNode()) continue;
      if (child.classList && child.classList.contains(CFG.headerBackClass)) return true;
    }
    return false;
  }

  function drop() {
    var node = barNode();
    if (node && node.parentNode) node.parentNode.removeChild(node);
    try {
      if (document.documentElement) document.documentElement.classList.remove(CFG.cls);
    } catch (error) {}
  }

  function buildNode() {
    var node = document.createElement('div');
    var modern = !!document.querySelector('.app-header');
    node.setAttribute(CFG.attr, '1');
    node.className = 'left back flex flex-ac cursor ' + CFG.cls + '-link';
    node.setAttribute('role', 'button');
    node.setAttribute('tabindex', '0');
    node.setAttribute('aria-label', CFG.label);
    var icon = document.createElement('i');
    icon.className = 'header-back-icon mc-icon iconfont icon-home_linear';
    icon.setAttribute('aria-hidden', 'true');
    icon.style.cssText = 'width:20px;height:20px;font-size:20px;';
    var label = document.createElement('span');
    label.className = 'name';
    label.textContent = CFG.label;
    node.appendChild(icon);
    node.appendChild(label);
    if (modern) {
      node.removeAttribute('role');node.removeAttribute('tabindex');
      icon.remove();label.remove();
      icon=document.createElement('du-action-icon');icon.setAttribute('name','icon-arrow_left_linear');icon.setAttribute('label','返回');
      label=document.createElement('h1');label.className='friend-title';label.textContent='Friends';node.appendChild(icon);node.appendChild(label);
    }
    function activate(event) {
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }
      var live = RT.config;
      try { console.log(live.nonce + ' ' + live.token); } catch (error) {}
      try { window.postMessage({ nonce: live.nonce, token: live.token }, location.origin); } catch (error) {}
    }
    (modern ? icon : node).addEventListener('click', activate, false);
    if (!modern) node.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') activate(event);
    }, false);
    return node;
  }

  function apply() {
    if (!RT.desired) {
      drop();
      return 'off';
    }
    var left = headerLeft();
    if (!left) {
      drop();
      return 'hostless';
    }
    if (nativeBack(left)) {
      drop();
      return 'native-back';
    }
    var node = barNode();
    if (!node) node = buildNode();
    if (node.parentNode !== left) left.appendChild(node);
    try { document.documentElement.classList.add(CFG.cls); } catch (error) {}
    return 'on';
  }

  function schedule() {
    if (RT.queued) return;
    RT.queued = true;
    var fire = function () {
      RT.queued = false;
      try { apply(); } catch (error) {}
    };
    if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(fire);
    else window.setTimeout(fire, 16);
  }

  function watch() {
    if (RT.observer) return;
    if (typeof MutationObserver === 'function' && document.documentElement) {
      RT.observer = new MutationObserver(function () {
        if (!RT.desired) return;
        var present = barNode();
        var flagged = false;
        try { flagged = document.documentElement.classList.contains(CFG.cls); } catch (error) { flagged = false; }
        if (!present || !flagged) schedule();
      });
      try {
        RT.observer.observe(document.documentElement, { childList: true, subtree: true });
      } catch (error) {
        RT.observer = null;
      }
    }
    // Kept on the runtime record so the cleanup script can take it back off again.
    try {
      RT.onHash = schedule;
      window.addEventListener('hashchange', RT.onHash, false);
    } catch (error) {}
  }

  ensureStyle();
  watch();
  return apply();
}
function injectedFrameMain(CFG) {
  var RT = window.__mchosePetFrameRuntime;
  if (!RT) {
    RT = { observer: false, retrying: false, gaveUp: false };
    window.__mchosePetFrameRuntime = RT;
  }

  function compact(value) {
    return String(value == null ? '' : value).replace(/\s+/g, '');
  }

  function depthOf(node) {
    var depth = 0;
    var current = node;
    while (current && current.parentNode) {
      depth += 1;
      current = current.parentNode;
    }
    return depth;
  }

  function usable(node) {
    return !!node && !!node.parentNode && !!node.parentNode.children && node.parentNode.children.length >= 2;
  }

  // One token, two ways out. The frame cannot read the shell's origin, so the main process passes
  // it back in through CFG once the shell has reported it; until then the console line is the only
  // channel. Never '*' — a wildcard postMessage hands the token to whatever got embedded here.
  function emit(base, extra) {
    var text = typeof extra === 'string' && extra ? base + extra : base;
    try { console.log(CFG.nonce + ' ' + text); } catch (error) {}
    if (!CFG.targetOrigin) return;
    try {
      window.top.postMessage({
        nonce: CFG.nonce,
        token: base,
        payload: typeof extra === 'string' ? extra : ''
      }, CFG.targetOrigin);
    } catch (error) {}
  }

  function findEntry(template) {
    var nodes = document.querySelectorAll(CFG.entrySelector);
    var existing = null;
    for (var index = 0; index < nodes.length; index += 1) {
      var node = nodes[index];
      if (template && node.parentNode === template.parentNode && !existing) existing = node;
      else if (node.parentNode) node.parentNode.removeChild(node);
    }
    return existing;
  }

  function labelOf(node) {
    if (!node) return '';
    try {
      var labelNode = typeof node.querySelector === 'function' ? node.querySelector(CFG.textSelector) : null;
      if (labelNode) return compact(labelNode.textContent);
    } catch (error) {}
    return compact(node.textContent);
  }

  // Device configuration also has a "云端社区" button. Only the home navigation
  // strip with multiple known destinations may supply an entry template.
  function inHomeNavigation(node) {
    var strips = document.querySelectorAll(CFG.tabsSelector);
    for (var index = 0; index < strips.length; index += 1) {
      var strip = strips[index];
      var parent = node;
      while (parent && parent !== strip) parent = parent.parentNode;
      if (!parent) continue;
      var items = strip.querySelectorAll(CFG.itemSelector);
      var labels = [];
      for (var itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
        var label = labelOf(items[itemIndex]);
        if (CFG.tabTexts.indexOf(label) >= 0 && labels.indexOf(label) < 0) labels.push(label);
      }
      if (labels.length >= 2) return true;
    }
    return false;
  }

  function legacyPick() {
    var nodes = document.querySelectorAll(CFG.legacyTags.join(','));
    for (var order = 0; order < CFG.tabTexts.length; order += 1) {
      var want = CFG.tabTexts[order];
      var best = null;
      var bestDepth = Infinity;
      for (var index = 0; index < nodes.length; index += 1) {
        var node = nodes[index];
        if (!usable(node) || !inHomeNavigation(node)) continue;
        if (compact(node.textContent) !== want) continue;
        var depth = depthOf(node);
        if (depth < bestDepth) {
          bestDepth = depth;
          best = node;
        }
      }
      if (best) return best;
    }
    return null;
  }

  function pickTemplate() {
    try {
      var direct = document.getElementById(CFG.tabId);
      if (direct && usable(direct) && inHomeNavigation(direct)) return direct;
    } catch (error) {}
    var items = document.querySelectorAll(CFG.itemSelector);
    for (var order = 0; order < CFG.tabTexts.length; order += 1) {
      var want = CFG.tabTexts[order];
      for (var index = 0; index < items.length; index += 1) {
        var item = items[index];
        if (!usable(item) || !inHomeNavigation(item)) continue;
        if (labelOf(item) === want) return item;
      }
    }
    return legacyPick();
  }

  function setEntryText(node, textValue) {
    try {
      var labelNode = typeof node.querySelector === 'function' ? node.querySelector(CFG.textSelector) : null;
      if (labelNode) {
        if (compact(labelNode.textContent) !== textValue) labelNode.textContent = textValue;
        return true;
      }
    } catch (error) {}
    var walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null);
    var current = walker.nextNode();
    while (current) {
      if (compact(current.nodeValue)) {
        if (current.nodeValue !== textValue) current.nodeValue = textValue;
        return true;
      }
      current = walker.nextNode();
    }
    return false;
  }

  function scrub(node) {
    for (var index = 0; index < CFG.stripAttributes.length; index += 1) {
      var name = CFG.stripAttributes[index];
      try {
        if (node.hasAttribute && node.hasAttribute(name)) node.removeAttribute(name);
      } catch (error) {}
    }
    try {
      if (node.setAttribute) node.setAttribute('aria-selected', 'false');
    } catch (error) {}
    try {
      if (node.setAttribute) node.setAttribute(CFG.entryAttr, '1');
    } catch (error) {}
  }

  function makeSvgElement(tag) {
    try {
      if (typeof document.createElementNS === 'function') return document.createElementNS('http://www.w3.org/2000/svg', tag);
    } catch (error) {}
    return null;
  }

  function appendShape(parent, tag, attrs) {
    var node = makeSvgElement(tag);
    if (!node) return null;
    for (var key in attrs) {
      if (!Object.prototype.hasOwnProperty.call(attrs, key)) continue;
      try {
        node.setAttribute(key, attrs[key]);
      } catch (error) {}
    }
    parent.appendChild(node);
    return node;
  }

  function paintPetIcon(root) {
    var host = null;
    try {
      host = root && typeof root.querySelector === 'function' ? root.querySelector(CFG.iconSelector) : null;
    } catch (error) {
      host = null;
    }
    if (!host) return false;
    try {
      var fonts = host.querySelectorAll('i');
      for (var index = 0; index < fonts.length; index += 1) {
        var font = fonts[index];
        if (font && font.parentNode) font.parentNode.removeChild(font);
      }
    } catch (error) {}
    try {
      if (host.querySelector(CFG.petIconSelector)) return true;
    } catch (error) {}
    var svg = makeSvgElement('svg');
    if (!svg) return false;
    svg.setAttribute('viewBox', CFG.iconViewBox);
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('style', 'vertical-align:-0.15em;display:inline-block');
    svg.setAttribute(CFG.petIconAttr, '1');
    if(CFG.iconPaths&&CFG.iconPaths.length)CFG.iconPaths.forEach(shape=>appendShape(svg,'path',{d:shape.d,fill:shape.fill}));
    else {appendShape(svg, 'path', { d: CFG.eyesPath, fill: CFG.eyesFill });appendShape(svg, 'path', { d: CFG.bodyPath, fill: 'currentColor' });}
    host.appendChild(svg);
    return true;
  }

  function bindClick(node) {
    if (!node || node.__mchosePetBound) return;
    node.__mchosePetBound = true;
    var group = node.parentNode && node.parentNode.matches && node.parentNode.matches('.app-header__primary-group') ? node.parentNode : null;
    var target = group || node;
    if (group && group.__mchosePetBound) return;
    if (group) group.__mchosePetBound = true;
    target.addEventListener('click', function (event) {
      if (group && !event.composedPath().some(function (item) { return item === node || item.dataset && item.dataset.value === 'friends'; })) return;
      try {
        if (event) {
          if (event.preventDefault) event.preventDefault();
          if (event.stopPropagation) event.stopPropagation();
          if (event.stopImmediatePropagation) event.stopImmediatePropagation();
        }
      } catch (error) {}
      emit(CFG.openToken);
    }, true);
  }

  // The inline page is mounted inside the host window, so any move through the host's own tab
  // strip has to take it away. Every host tab except the pet entry posts the close token; the
  // marker attribute keeps the binding idempotent across re-injections, and the host's own click
  // still runs because nothing is cancelled here.
  function bindNav(node) {
    if (!node || typeof node.addEventListener !== 'function') return false;
    try {
      if (node.getAttribute && node.getAttribute(CFG.navAttr)) return false;
      if (node.setAttribute) node.setAttribute(CFG.navAttr, '1');
    } catch (error) {
      return false;
    }
    node.addEventListener('click', function () {
      emit(CFG.closeToken);
    }, true);
    return true;
  }

  function bindNavAll() {
    var items = null;
    try {
      items = document.querySelectorAll(CFG.itemSelector + ', .app-header__utility-action');
    } catch (error) {
      items = null;
    }
    if (!items) return 0;
    var bound = 0;
    for (var index = 0; index < items.length; index += 1) {
      var item = items[index];
      if (!item) continue;
      try {
        if (item.hasAttribute && item.hasAttribute(CFG.entryAttr)) continue;
      } catch (error) {}
      if (bindNav(item)) bound += 1;
    }
    return bound;
  }

  function inject() {
    var template = pickTemplate();
    var existing = findEntry(template);
    if (existing) {
      setEntryText(existing, CFG.entryText);
      paintPetIcon(existing);
      bindClick(existing);
      bindNavAll();
      return CFG.statusPresent;
    }
    if (!template || !template.parentNode) return '';
    var clone = template.cloneNode(true);
    scrub(clone);
    if (template.parentNode.matches && template.parentNode.matches('.app-header__primary-group')) {
      clone.removeAttribute('slot'); clone.setAttribute('value', 'friends');
      clone.setAttribute('aria-label', CFG.entryText); clone.setAttribute('title', CFG.entryText);
      clone.className = template.className;
    }
    setEntryText(clone, CFG.entryText);
    paintPetIcon(clone);
    template.parentNode.insertBefore(clone, template.nextSibling);
    bindClick(clone);
    bindNavAll();
    return CFG.statusInjected;
  }

  function installObserver() {
    if (RT.observer) return;
    if (typeof MutationObserver !== 'function' || !document.body) return;
    RT.observer = true;
    var pending = false;
    var flush = function () {
      pending = false;
      try {
        inject();
      } catch (error) {}
    };
    var schedule = function () {
      if (pending) return;
      pending = true;
      try {
        if (window.requestAnimationFrame) window.requestAnimationFrame(flush);
        else setTimeout(flush, CFG.healDebounceMs);
      } catch (error) {
        pending = false;
      }
    };
    var observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    window.__mchosePetFrameObserver = observer;
  }

  function startRetry() {
    if (RT.retrying) return;
    RT.retrying = true;
    var startedAt = Date.now();
    var tick = function () {
      var status = '';
      try {
        status = inject();
      } catch (error) {
        status = '';
      }
      if (status) {
        RT.retrying = false;
        installObserver();
        return;
      }
      if (Date.now() - startedAt >= CFG.retryMaxMs) {
        RT.retrying = false;
        if (!RT.gaveUp) {
          RT.gaveUp = true;
          // The miss itself is the only diagnostic the main process gets from out here, so it
          // carries what the profile looked for and how much of it is actually on the page.
          var seen = { profile: CFG.profileVersion, tabs: 0, items: 0 };
          try {
            seen.tabs = document.querySelectorAll(CFG.tabsSelector).length;
            seen.items = document.querySelectorAll(CFG.itemSelector).length;
          } catch (error) {}
          emit(CFG.missToken, JSON.stringify(seen));
        }
        return;
      }
      setTimeout(tick, CFG.retryIntervalMs);
    };
    tick();
  }

  var status = '';
  try {
    status = inject();
  } catch (error) {
    status = '';
  }
  try {
    installObserver();
  } catch (error) {}
  if (!status) startRetry();
  return status;
}

// Runs in the app shell: the inline page is a native view stacked above the shell's own document,
// so any tooltip or menu the shell draws below the header would be painted underneath it. The
// watcher reports that overlap and stops reporting the moment the layer is gone again.
function injectedPopupMain(CFG) {
  try {
    // A DOM-embedded Friend page shares the host's layer tree. Native coachmarks
    // and popovers render above it directly; no tooltip mirror is needed.
    if (document.querySelector('du-action-icon')) return false;
    var root = document.documentElement;
    if (!root) return false;
    var previous = window.__mchosePetPopupWatch;
    if (previous && previous.timer) clearInterval(previous.timer);
    var stale = document.querySelectorAll('[' + CFG.tipAttr + ']');
    for (var staleIndex = 0; staleIndex < stale.length; staleIndex += 1) {
      var staleNode = stale[staleIndex];
      if (staleNode && typeof staleNode.removeAttribute === 'function') staleNode.removeAttribute(CFG.tipAttr);
    }
    if (!document.getElementById(CFG.styleId)) {
      if (!document.head) return false;
      var style = document.createElement('style');
      style.id = CFG.styleId;
      // Declarative, not polled: a tooltip that the host shows right after a scan would otherwise
      // paint its top 4px in the header strip above the inline page until the next poll.
      style.textContent = '[' + CFG.tipAttr + ']{visibility:hidden!important}' +
        'html.' + CFG.cls + ' .mc-header-popper,html.' + CFG.cls + ' .el-tooltip__popper,html.' + CFG.cls + ' [role="tooltip"]{visibility:hidden!important}';
      document.head.appendChild(style);
    }
    var state = { version: 2, on: false, tip: null, tipKey: '', enabled: CFG.enabled === true, timer: 0 };
    // This watcher is the one place that reports from a 120ms loop, so its lines carry the nonce:
    // a console line without it is dropped in the main process instead of driving the page.
    function report(text) {
      try { console.log(CFG.nonce + ' ' + text); } catch (error) {}
    }
    function floor() {
      var bar = document.querySelector(CFG.headerSelector) || document.querySelector(CFG.headerFallbackSelector);
      if (!bar || typeof bar.getBoundingClientRect !== 'function') return 0;
      var rect = bar.getBoundingClientRect();
      return rect && typeof rect.bottom === 'number' && isFinite(rect.bottom) ? rect.bottom : 0;
    }
    // A marked tooltip is hidden by our own stylesheet, so its computed visibility says nothing
    // about the host still showing it: the mark itself is the one thing to ignore when measuring.
    function over(el, limit) {
      if (typeof el.getBoundingClientRect !== 'function') return false;
      if (el.style && el.style.display === 'none') return false;
      var style = getComputedStyle(el);
      if (!style || style.display === 'none') return false;
      if (!isTip(el)) {
        if (style.visibility === 'hidden') return false;
        var opacity = Number(style.opacity);
        if (isFinite(opacity) && opacity <= 0.05) return false;
      }
      var rect = el.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      if (rect.bottom <= limit || rect.right <= 0 || rect.left >= window.innerWidth) return false;
      return true;
    }
    function isTip(el) {
      if (!el || typeof el.matches !== 'function') return false;
      return el.matches(CFG.tooltipSelector);
    }
    function clearMarks() {
      var marked = document.querySelectorAll('[' + CFG.tipAttr + ']');
      for (var index = 0; index < marked.length; index += 1) {
        var node = marked[index];
        if (node && typeof node.removeAttribute === 'function') node.removeAttribute(CFG.tipAttr);
      }
    }
    function clearTip() {
      state.tip = null;
      if (!state.tipKey) return;
      state.tipKey = '';
      report(CFG.tipOffToken);
    }
    function reportTip(el) {
      var rect = el.getBoundingClientRect();
      var text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) {
        clearTip();
        return;
      }
      var key = text + '|' + Math.round(rect.left);
      var changed = key !== state.tipKey;
      state.tip = el;
      if (!changed) return;
      state.tipKey = key;
      report(CFG.tipOnToken + JSON.stringify({ text: text.slice(0, 80), x: Math.round(rect.left + rect.width / 2) }));
    }
    // Several header tooltips are on screen at once while the pointer travels between icons. Every
    // one of them has to stay hidden, not just the mirrored one, otherwise the unmarked ones paint
    // their top edge in the sliver of window above the inline page.
    function pickTip(visible) {
      if (!visible.length) return null;
      var host = null;
      try {
        host = document.querySelector(CFG.headerActionSelector + ':hover') ||
          document.querySelector(CFG.headerActionSelector + ':hover *');
      } catch (error) {
        host = null;
      }
      while (host && host !== document.body && !(host.classList && host.classList.contains(CFG.headerActionClass))) {
        host = host.parentElement;
      }
      if (host && typeof host.getAttribute === 'function') {
        var describedBy = host.getAttribute('aria-describedby');
        var popper = describedBy ? document.getElementById(describedBy) : null;
        if (popper && visible.indexOf(popper) >= 0) return popper;
      }
      if (state.tip && visible.indexOf(state.tip) >= 0) return state.tip;
      return null;
    }
    function setLayer(hit) {
      if (hit === state.on) return;
      state.on = hit;
      report(hit ? CFG.onToken : CFG.offToken);
    }
    // Mirroring is off while an interactive layer is up: that layer has to be visible and the
    // inline page steps aside for it anyway.
    function applyClass() {
      if (!root) return false;
      var want = state.enabled && !state.on;
      if (want) root.classList.add(CFG.cls);
      else root.classList.remove(CFG.cls);
      return want;
    }
    function scan() {
      if (!state.enabled) {
        clearMarks();
        clearTip();
        setLayer(false);
        applyClass();
        return;
      }
      var limit = floor();
      var nodes = document.querySelectorAll(CFG.selector);
      var layer = false;
      var visible = [];
      for (var index = 0; index < nodes.length; index += 1) {
        var node = nodes[index];
        if (!over(node, limit)) {
          if (node.hasAttribute && node.hasAttribute(CFG.tipAttr)) node.removeAttribute(CFG.tipAttr);
          continue;
        }
        if (!isTip(node)) {
          layer = true;
          continue;
        }
        visible.push(node);
        if (!node.hasAttribute(CFG.tipAttr) && typeof node.setAttribute === 'function') node.setAttribute(CFG.tipAttr, '1');
      }
      var tip = pickTip(visible);
      if (tip) reportTip(tip);
      else clearTip();
      setLayer(layer);
      applyClass();
    }
    applyClass();
    state.timer = setInterval(scan, CFG.interval);
    window.__mchosePetPopupWatch = state;
    scan();
    return true;
  } catch (error) {
    return false;
  }
}

// Runs in the host's content frame: while the inline page is open the host's own tab row is
// switched off there instead of merely painted over, so the top of the page is free of host chrome.
function injectedChromeMain(CFG) {
  try {
    var root = document.documentElement;
    if (!root) return false;
    if (!document.getElementById(CFG.styleId)) {
      if (!document.head) return false;
      var style = document.createElement('style');
      style.id = CFG.styleId;
      style.textContent = 'html.' + CFG.cls + ' .connect-device-content__toolbar{display:none!important}';
      document.head.appendChild(style);
    }
    if (CFG.on) root.classList.add(CFG.cls);
    else root.classList.remove(CFG.cls);
    return root.classList.contains(CFG.cls);
  } catch (error) {
    return false;
  }
}

// Runs in the app shell when the entry is switched off. Everything the shell-side injections
// installed has to come back off: the 120ms watcher, the tooltip marks and stylesheet, the home
// bar, its observer and listeners, the chrome class and the message bridge. Removing the entry
// node alone (removedFrameMain) leaves all of that running in a page nobody is looking at.
function injectedCleanupMain(CFG) {
  try {
    var removed = 0;
    function drop(node) {
      if (node && node.parentNode) {
        node.parentNode.removeChild(node);
        removed += 1;
      }
    }
    var watcher = window.__mchosePetPopupWatch;
    if (watcher) {
      if (watcher.timer) {
        try { clearInterval(watcher.timer); } catch (error) {}
      }
      window.__mchosePetPopupWatch = null;
      removed += 1;
    }
    var bridge = window.__mchosePetBridgeState;
    if (bridge) {
      if (bridge.handler) {
        try { window.removeEventListener('message', bridge.handler, false); } catch (error) {}
      }
      window.__mchosePetBridgeState = null;
      removed += 1;
    }
    window.__mchosePetBridgeInstalled = false;
    var bar = window.__mchosePetHomeBar;
    if (bar) {
      if (bar.observer && typeof bar.observer.disconnect === 'function') {
        try { bar.observer.disconnect(); } catch (error) {}
      }
      if (typeof bar.onHash === 'function') {
        try { window.removeEventListener('hashchange', bar.onHash, false); } catch (error) {}
      }
      window.__mchosePetHomeBar = null;
      removed += 1;
    }
    var marked = null;
    try { marked = document.querySelectorAll('[' + CFG.tipAttr + ']'); } catch (error) { marked = null; }
    for (var index = 0; marked && index < marked.length; index += 1) {
      var node = marked[index];
      if (node && typeof node.removeAttribute === 'function') {
        node.removeAttribute(CFG.tipAttr);
        removed += 1;
      }
    }
    var barNode = null;
    try { barNode = document.querySelector('[' + CFG.barAttr + ']'); } catch (error) { barNode = null; }
    drop(barNode);
    var styleIds = [CFG.tipStyleId, CFG.barStyleId, CFG.chromeStyleId];
    for (var styleIndex = 0; styleIndex < styleIds.length; styleIndex += 1) {
      drop(document.getElementById(styleIds[styleIndex]));
    }
    var classes = [CFG.tipCls, CFG.barCls, CFG.chromeCls];
    var root = document.documentElement;
    if (root && root.classList) {
      for (var classIndex = 0; classIndex < classes.length; classIndex += 1) {
        if (root.classList.contains(classes[classIndex])) {
          root.classList.remove(classes[classIndex]);
          removed += 1;
        }
      }
    }
    var observer = window.__mchosePetFrameObserver;
    if (observer && typeof observer.disconnect === 'function') {
      try { observer.disconnect(); } catch (error) {}
      window.__mchosePetFrameObserver = null;
      removed += 1;
    }
    try { delete window.__mchosePetFrameRuntime; } catch (error) {}
    return removed;
  } catch (error) {
    return -1;
  }
}

function removedFrameMain(CFG) {
  try {
    var nodes = document.querySelectorAll(CFG.entrySelector);
    for (var index = 0; index < nodes.length; index += 1) {
      var node = nodes[index];
      if (node && node.parentNode) node.parentNode.removeChild(node);
    }
    var observer = window.__mchosePetFrameObserver;
    if (observer && typeof observer.disconnect === 'function') observer.disconnect();
    window.__mchosePetFrameObserver = null;
    delete window.__mchosePetFrameRuntime;
    return true;
  } catch (error) {
    return false;
  }
}

// Runs in the host window's top-level frame only: the page's first <iframe> marks the top of
// the host content area, which is exactly where the inline settings page has to start. A
// routed sub-frame or a tab element drifts with the app's own navigation, the top-level
// iframe does not.
function injectedContentTopMain(CFG) {
  try {
    var frame = document.querySelector(CFG.frameSelector);
    if (!frame || typeof frame.getBoundingClientRect !== 'function') {
      var modernHeader = document.querySelector('.app-header');
      if (!modernHeader) return null;
      return { top: modernHeader.getBoundingClientRect().bottom, width: window.innerWidth, header: modernHeader.getBoundingClientRect().bottom };
    }
    var rect = frame.getBoundingClientRect();
    var width = window.innerWidth;
    if (!rect || typeof rect.top !== 'number' || !isFinite(rect.top)) return null;
    if (typeof width !== 'number' || !isFinite(width) || width <= 0) return null;
    // The header bar is the floor: the frame also starts at 0 and a hidden tab row measures 0,
    // so without it the page would cover the header the user needs in order to leave again.
    var bar = document.querySelector(CFG.headerSelector) || document.querySelector(CFG.headerFallbackSelector);
    var headerBottom = 0;
    if (bar && typeof bar.getBoundingClientRect === 'function') {
      var headerRect = bar.getBoundingClientRect();
      if (headerRect && typeof headerRect.bottom === 'number' && isFinite(headerRect.bottom) && headerRect.bottom > 0) {
        headerBottom = headerRect.bottom;
      }
    }
    return { top: rect.top, width: width, header: headerBottom };
  } catch (error) {
    return null;
  }
}

// Runs in the host content frame the top-level <iframe> loads: the host's own tab row lives in
// that document, so the inline page starts below the tab row's bottom edge instead of under the
// iframe's top edge. Only a rect is read here; nothing navigates or moves the host.
function injectedTabsBottomMain(CFG) {
  try {
    var tabs = document.querySelector(CFG.tabsSelector);
    if (!tabs || typeof tabs.getBoundingClientRect !== 'function') return null;
    var rect = tabs.getBoundingClientRect();
    if (!rect || typeof rect.bottom !== 'number' || !isFinite(rect.bottom)) return null;
    return { tabs: rect.bottom };
  } catch (error) {
    return null;
  }
}

// Heal gate 2: a frame that is too narrow or hidden (tray.html and friends) can never host the
// entry, so it is probed once per injection generation before any script is injected.
function injectedUiProbeMain() {
  try {
    var width = window.innerWidth;
    return {
      width: typeof width === 'number' && isFinite(width) ? width : 0,
      visibility: typeof document.visibilityState === 'string' ? document.visibilityState : ''
    };
  } catch (error) {
    return null;
  }
}

function wrapFactory(factory, config, fallbackValue) {
  let fallback = 'false';
  if (typeof fallbackValue === 'string') fallback = fallbackValue;
  else if (fallbackValue) fallback = 'true';
  return '(function(){try{return (' + factory.toString() + ')(' + JSON.stringify(config) + ');}catch(error){return ' + fallback + ';}})();';
}

function buildBridgeScript(options) {
  return wrapFactory(injectedBridgeMain, buildConfig(options), false);
}

function buildHomeBarScript(options) {
  const on = options === true || (options && options.on === true);
  return wrapFactory(injectedHomeBarMain, {
    on,
    token: HOME_TOKEN,
    nonce: options && typeof options.nonce === 'string' ? options.nonce : '',
    label: BAR_LABEL,
    attr: BAR_ATTR,
    cls: BAR_CLASS,
    styleId: BAR_STYLE_ID,
    headerSelector: HOST_PROFILE.headerSelector,
    headerFallbackSelector: HOST_PROFILE.headerFallbackSelector,
    headerLeftSelector: HOST_PROFILE.headerLeftSelector,
    headerBackClass: HOST_PROFILE.headerBackClass
  }, false);
}

function buildChromeScript(options) {
  const on = options === true || (options && options.on === true);
  return wrapFactory(injectedChromeMain, { on, cls: CHROME_CLASS, styleId: CHROME_STYLE_ID }, false);
}

function buildPopupScript(options) {
  return wrapFactory(injectedPopupMain, {
    selector: options && typeof options.selector === 'string' && options.selector ? options.selector : POPUP_SELECTOR,
    interval: options && Number.isFinite(options.interval) && options.interval > 0 ? options.interval : POPUP_POLL_MS,
    onToken: POPUP_ON_TOKEN,
    offToken: POPUP_OFF_TOKEN,
    tipOnToken: TIP_ON_TOKEN,
    tipOffToken: TIP_OFF_TOKEN,
    tipAttr: TIP_ATTR,
    cls: TIP_CLASS,
    styleId: TIP_STYLE_ID,
    nonce: options && typeof options.nonce === 'string' ? options.nonce : '',
    headerSelector: HOST_PROFILE.headerSelector,
    headerFallbackSelector: HOST_PROFILE.headerFallbackSelector,
    headerActionSelector: HOST_PROFILE.headerActionSelector,
    headerActionClass: HOST_PROFILE.headerActionClass,
    tooltipSelector: HOST_PROFILE.tooltipSelector,
    enabled: options && options.enabled === true
  }, false);
}

// The teardown half of A4: ids, attributes and classes the shell-side injections own, so the
// cleanup script can be built from the same profile rather than a second copy of the literals.
function buildCleanupScript() {
  return wrapFactory(injectedCleanupMain, {
    entrySelector: HOST_PROFILE.entrySelector,
    tipAttr: TIP_ATTR,
    barAttr: BAR_ATTR,
    tipStyleId: TIP_STYLE_ID,
    barStyleId: BAR_STYLE_ID,
    chromeStyleId: CHROME_STYLE_ID,
    tipCls: TIP_CLASS,
    barCls: BAR_CLASS,
    chromeCls: CHROME_CLASS
  }, false);
}

function buildFrameScript(options) {
  return wrapFactory(injectedFrameMain, buildConfig(options), JSON.stringify(FRAME_STATUS_MISS));
}

function buildRemoveScript(options) {
  return wrapFactory(removedFrameMain, buildConfig(options), false);
}

function buildMeasureScript() {
  return wrapFactory(injectedContentTopMain, {
    frameSelector: 'iframe',
    headerSelector: HOST_PROFILE.headerSelector,
    headerFallbackSelector: HOST_PROFILE.headerFallbackSelector
  }, 'null');
}

function buildTabsScript() {
  return wrapFactory(injectedTabsBottomMain, { tabsSelector: HOST_PROFILE.tabsSelector }, 'null');
}

function buildUiProbeScript() {
  return wrapFactory(injectedUiProbeMain, {}, 'null');
}

function scanForToken(value, depth, token) {
  if (depth > 3 || value === null || value === undefined) return false;
  if (typeof value === 'string') return value.indexOf(token) >= 0;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (scanForToken(value[index], depth + 1, token)) return true;
    }
    return false;
  }
  if (typeof value === 'object') {
    const nested = [value.message, value.text, value.msg, value.details];
    for (let index = 0; index < nested.length; index += 1) {
      if (scanForToken(nested[index], depth + 1, token)) return true;
    }
  }
  return false;
}

function matchOpenToken(input) {
  return scanForToken(input, 0, OPEN_TOKEN);
}

function matchMissToken(input) {
  return scanForToken(input, 0, MISS_TOKEN);
}

function matchCloseToken(input) {
  return scanForToken(input, 0, CLOSE_TOKEN);
}

function matchHomeToken(input) {
  return scanForToken(input, 0, HOME_TOKEN);
}

// The tooltip report carries its text and centre x behind the token, so the inline page can draw
// the same bubble in the strip of host chrome the native view covers.
function tokenPayload(value, depth, token) {
  if (depth > 3 || value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const at = value.indexOf(token);
    return at >= 0 ? value.slice(at + token.length) : null;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = tokenPayload(value[index], depth + 1, token);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof value === 'object') {
    const nested = [value.message, value.text, value.msg, value.details];
    for (let index = 0; index < nested.length; index += 1) {
      const found = tokenPayload(nested[index], depth + 1, token);
      if (found !== null) return found;
    }
  }
  return null;
}

function matchTipOnToken(input) {
  const raw = tokenPayload(input, 0, TIP_ON_TOKEN);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const text = typeof parsed.text === 'string' ? parsed.text.slice(0, 80) : '';
    if (!text) return null;
    return { text, x: Number.isFinite(parsed.x) ? Math.round(parsed.x) : 0 };
  } catch (error) {
    return null;
  }
}

function matchTipOffToken(input) {
  return scanForToken(input, 0, TIP_OFF_TOKEN);
}

function matchPopupOnToken(input) {
  return scanForToken(input, 0, POPUP_ON_TOKEN);
}

function matchPopupOffToken(input) {
  return scanForToken(input, 0, POPUP_OFF_TOKEN);
}

// Every line an injected script writes carries the nonce of the generation that wrote it, and the
// main process reads only lines that still do. The nonce is stripped on the way through, so the
// token helpers below keep seeing exactly the text they have always seen.
function withNonce(input, nonce, depth) {
  const expected = typeof nonce === 'string' ? nonce : '';
  if (!expected) return null;
  const level = Number.isFinite(depth) ? depth : 0;
  if (level > 3 || input === null || input === undefined) return null;
  if (typeof input === 'string') {
    let text = input;
    if (text.indexOf(expected) < 0) return null;
    while (text.indexOf(expected) >= 0) text = text.split(expected + ' ').join('').split(expected).join('');
    return text;
  }
  if (Array.isArray(input)) {
    const out = [];
    let found = false;
    for (let index = 0; index < input.length; index += 1) {
      const cleaned = withNonce(input[index], expected, level + 1);
      out.push(cleaned === null ? input[index] : cleaned);
      if (cleaned !== null) found = true;
    }
    return found ? out : null;
  }
  if (typeof input === 'object') {
    const fields = ['message', 'text', 'msg', 'details'];
    let copy = null;
    for (let index = 0; index < fields.length; index += 1) {
      const key = fields[index];
      const cleaned = withNonce(input[key], expected, level + 1);
      if (cleaned === null) continue;
      if (!copy) copy = Object.assign({}, input);
      copy[key] = cleaned;
    }
    return copy;
  }
  return null;
}

// The app shell reports its own origin on the nonce channel, because a custom scheme does not
// serialize into the shape the main process could have guessed.
function matchOriginToken(input) {
  const raw = tokenPayload(input, 0, ORIGIN_TOKEN);
  if (typeof raw !== 'string') return '';
  const origin = raw.trim();
  return ORIGIN_PATTERN.test(origin) ? origin : '';
}

// A miss is the one report that says which host profile stopped matching, so it carries counts
// instead of only the token.
function matchMissDetail(input) {
  const raw = tokenPayload(input, 0, MISS_TOKEN);
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      profile: Number.isFinite(parsed.profile) ? parsed.profile : 0,
      tabs: Number.isFinite(parsed.tabs) ? parsed.tabs : 0,
      items: Number.isFinite(parsed.items) ? parsed.items : 0
    };
  } catch (error) {
    return null;
  }
}

function normalizeMeasureResult(value) {
  if (!value || typeof value !== 'object') return null;
  const top = Number.isFinite(value.top) ? value.top : null;
  if (top === null) return null;
  return {
    top,
    width: Number.isFinite(value.width) && value.width > 0 ? value.width : 0,
    header: Number.isFinite(value.header) && value.header > 0 ? value.header : 0
  };
}

function normalizeTabsResult(value) {
  if (!value || typeof value !== 'object') return null;
  const tabs = Number.isFinite(value.tabs) ? value.tabs : null;
  if (tabs === null) return null;
  return { tabs };
}

// iframeTop lives in the top-level document and the tab row's bottom inside the content frame;
// both are CSS px at the same zoom, so they add directly. The header bottom is the floor: the tab
// row measures 0 once it is hidden for the inline page. The single DIP conversion happens once
// afterwards in page-view with contentBounds.width / innerWidth.
function combineAnchor(bar, tabs) {
  if (!bar || !Number.isFinite(bar.top)) return null;
  const extra = tabs && Number.isFinite(tabs.tabs) ? tabs.tabs : 0;
  const header = Number.isFinite(bar.header) ? bar.header : 0;
  return {
    top: Math.max(header, bar.top + extra),
    width: Number.isFinite(bar.width) && bar.width > 0 ? bar.width : 0,
    path: tabs && Number.isFinite(tabs.tabs) ? 'tabs' : 'bar'
  };
}

function frameBasename(rawUrl) {
  const parsed = parseUrl(rawUrl);
  if (!parsed) return '';
  const path = String(parsed.pathname || '');
  const cut = path.lastIndexOf('/');
  return (cut >= 0 ? path.slice(cut + 1) : path).toLowerCase();
}

function isNonUiFrameUrl(rawUrl) {
  const base = frameBasename(rawUrl);
  if (!base) return false;
  for (let index = 0; index < NON_UI_BASENAMES.length; index += 1) {
    if (base === NON_UI_BASENAMES[index]) return true;
  }
  return false;
}

// Heal gate 2 verdict. Unknown probes never block: an older caller or a frame that cannot run
// the probe must not lose the entry, only a frame that positively reports a non-UI shape does.
function uiGateVerdict(value) {
  if (!value || typeof value !== 'object') return 'unknown';
  const width = Number.isFinite(value.width) ? value.width : 0;
  const visibility = typeof value.visibility === 'string' ? value.visibility : '';
  if (width > 0 && width < UI_MIN_WIDTH) return 'blocked';
  if (visibility && visibility !== 'visible') return 'blocked';
  return 'ok';
}

// 1s, 1.5s, 2.25s, 3.4s, capped at 5s.
function healDelayFor(failures, minMs, maxMs) {
  const min = Number.isFinite(minMs) && minMs > 0 ? minMs : HEAL_MIN_DELAY_MS;
  const max = Number.isFinite(maxMs) && maxMs > 0 ? maxMs : HEAL_MAX_DELAY_MS;
  const step = Math.max(0, (Number.isFinite(failures) ? failures : 1) - 1);
  return Math.round(Math.min(max, min * Math.pow(HEAL_BACKOFF, step)));
}

function measureContentTop(contents) {
  let mainFrame = null;
  try {
    mainFrame = contents ? contents.mainFrame : null;
  } catch (error) {
    mainFrame = null;
  }
  if (!mainFrame || typeof mainFrame.executeJavaScript !== 'function') return Promise.resolve(null);
  let pending = null;
  try {
    pending = mainFrame.executeJavaScript(buildMeasureScript(), true);
  } catch (error) {
    return Promise.resolve(null);
  }
  return Promise.resolve(pending)
    .then((value) => normalizeMeasureResult(value))
    .catch(() => null);
}

function tabsFrameOf(contents) {
  let root = null;
  try {
    root = contents ? contents.mainFrame : null;
  } catch (error) {
    root = null;
  }
  if (!root) return null;
  const frames = frameTree(root);
  const hasRemoteContent = frames.some(frame => isFrameTargetUrl(frameUrl(frame)) && !isNonUiFrameUrl(frameUrl(frame)));
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    const url = frameUrl(frame);
    if ((!isFrameTargetUrl(url) && !(isAppShellUrl(url) && !hasRemoteContent)) || isNonUiFrameUrl(url)) continue;
    if (typeof frame.executeJavaScript !== 'function') continue;
    return frame;
  }
  return null;
}

function measureFrame(frame, script) {
  if (!frame || typeof frame.executeJavaScript !== 'function') return Promise.resolve(null);
  let pending = null;
  try {
    pending = frame.executeJavaScript(script, true);
  } catch (error) {
    return Promise.resolve(null);
  }
  return Promise.resolve(pending).catch(() => null);
}

// Anchor of the host's visible chrome: the top-level iframe marks where the host chrome ends,
// and the host tab row inside the content frame adds its bottom edge on top of that.
function measureHostAnchor(contents) {
  return measureContentTop(contents).then((bar) => {
    if (!bar) return null;
    const frame = tabsFrameOf(contents);
    if (!frame) return combineAnchor(bar, null);
    return measureFrame(frame, buildTabsScript())
      .then((value) => combineAnchor(bar, normalizeTabsResult(value)))
      .catch(() => combineAnchor(bar, null));
  });
}

// Previous name, same implementation: kept so callers written against it keep working.
const measureTabStripTop = measureContentTop;

function install(ctx) {
  const config = ctx || {};
  const electron = config.electron || {};
  const app = electron.app;
  const logger = config.logger || null;
  const openSettings = typeof config.openSettings === 'function' ? config.openSettings : null;
  const closeSettings = typeof config.closeSettings === 'function' ? config.closeSettings : null;
  const isEnabled = typeof config.isEnabled === 'function' ? config.isEnabled : () => true;
  const onOverlay = typeof config.onOverlay === 'function' ? config.onOverlay : null;
  const onHostTip = typeof config.onHostTip === 'function' ? config.onHostTip : null;
  const retryIntervalMs = Number.isFinite(config.retryIntervalMs) && config.retryIntervalMs > 0 ? config.retryIntervalMs : RETRY_INTERVAL_MS;
  const retryMaxMs = Number.isFinite(config.retryMaxMs) && config.retryMaxMs > 0 ? config.retryMaxMs : RETRY_MAX_MS;
  const healMinDelayMs = Number.isFinite(config.healMinDelayMs) && config.healMinDelayMs > 0 ? config.healMinDelayMs : HEAL_MIN_DELAY_MS;
  const healMaxDelayMs = Number.isFinite(config.healMaxDelayMs) && config.healMaxDelayMs > 0 ? config.healMaxDelayMs : HEAL_MAX_DELAY_MS;
  const healAttemptLimit = Number.isFinite(config.healAttemptLimit) && config.healAttemptLimit > 0 ? config.healAttemptLimit : HEAL_ATTEMPT_LIMIT;
  const kickMergeMs = Number.isFinite(config.kickMergeMs) && config.kickMergeMs > 0 ? config.kickMergeMs : KICK_MERGE_MS;
  const kickGiveUpBackoffMs = Number.isFinite(config.kickGiveUpBackoffMs) && config.kickGiveUpBackoffMs >= 0
    ? config.kickGiveUpBackoffMs
    : KICK_GIVE_UP_BACKOFF_MS;
  // Every injection generation gets its own nonce and the last few stay valid: a document injected a
  // moment before the rotation still holds the older value, and rotation must never silence it.
  // The shell and the frames it hosts are injected at their own moments, and a window that never
  // settles rotates generation after generation (tray.html is kicked on every load/frame-load event),
  // so six was not enough on the real machine: a frame still holding a nonce eight rotations old had
  // its click dropped. 24 generations span far more than any observed window of re-injection.
  const nonceFactory = typeof config.nonceFactory === 'function' ? config.nonceFactory : createNonce;
  const nonceHistoryLimit = 24;
  const tokenDedupeMs = 400;
  // An origin report arrives again with every injection; re-injecting on each one rotates nothing
  // but still costs a script run, so one origin-triggered kick per record per second is enough.
  const originKickMinMs = typeof config.originKickMinMs === 'number' && config.originKickMinMs >= 0
    ? config.originKickMinMs
    : 1000;
  // successes is cumulative for the process; generationSuccesses only counts the page loaded now,
  // so a selector change after a host update still ends as selectors-miss.
  const stats = { attempts: 0, successes: 0, generationSuccesses: 0, missExhausted: false, lastMissDetail: null };
  const seenTokens = new Map();
  let nonce = '';
  const nonceHistory = [];
  let shellOrigin = '';
  let lastEnabled = null;
  function rememberNonce(value) {
    const at = nonceHistory.indexOf(value);
    if (at >= 0) nonceHistory.splice(at, 1);
    nonceHistory.unshift(value);
    if (nonceHistory.length > nonceHistoryLimit) nonceHistory.length = nonceHistoryLimit;
  }
  function rotateNonce() {
    nonce = String(nonceFactory() || '');
    if (nonce) rememberNonce(nonce);
    return nonce;
  }
  rotateNonce();
  // Injected frames can only post to the shell once its origin is known, which is what the shell's
  // own report is for; until then their nonce-checked console line is the channel that works.
  function frameOptions(targetOrigin) {
    return {
      retryIntervalMs,
      retryMaxMs,
      nonce,
      // Every generation the bridge may still accept, current first; the frame presents the nonce it
      // was injected with, which is not necessarily the one this injection hands out.
      nonces: nonceHistory.slice(),
      targetOrigin: typeof targetOrigin === 'string' ? targetOrigin : shellOrigin
    };
  }
  // The postMessage target is the origin of the document that owns the frame - its window.top - and
  // that origin follows from the page's own URL (a standard custom scheme is scheme plus host).
  // Deriving it beats a handshake, because a handshake between two windows is exactly what let each
  // one overwrite the other's origin. A file: page has an opaque origin nothing can be addressed to,
  // so it keeps the console channel alone.
  function targetOriginOf(rawUrl) {
    const derived = originOf(rawUrl);
    return derived && derived !== 'file://' ? derived : '';
  }
  function frameTargetOrigin(frame) {
    let topUrl = '';
    try {
      topUrl = frame && frame.top && typeof frame.top.url === 'string' ? frame.top.url : '';
      if (!topUrl && frame && typeof frame.url === 'string') topUrl = frame.url;
    } catch (err) {
      topUrl = '';
    }
    return targetOriginOf(topUrl);
  }
  const now = typeof config.now === 'function' ? config.now : () => Date.now();
  const setTimer = typeof config.setTimeout === 'function' ? config.setTimeout : (handler, ms) => setTimeout(handler, ms);
  const clearTimer = typeof config.clearTimeout === 'function' ? config.clearTimeout : (handle) => clearTimeout(handle);
  const records = new Map();
  const anonymousKeys = new WeakMap();
  const frameStates = new WeakMap();
  const retryTimers = new Set();
  let disposed = false;
  let fallbackId = 0;

  function log(level, message, error) {
    if (!logger) return;
    try {
      const sink = logger[level] || logger.info;
      if (typeof sink === 'function') sink('[page-entry] ' + message, error);
    } catch (err) {
      return;
    }
  }

  function keyFor(contents) {
    if (contents.id !== undefined && contents.id !== null) return 'id:' + contents.id;
    let key = anonymousKeys.get(contents);
    if (!key) {
      fallbackId += 1;
      key = 'anon:' + fallbackId;
      anonymousKeys.set(contents, key);
    }
    return key;
  }

  function safeUrl(contents) {
    try {
      return typeof contents.getURL === 'function' ? contents.getURL() : '';
    } catch (err) {
      return '';
    }
  }

  function isGone(contents) {
    try {
      return typeof contents.isDestroyed === 'function' && contents.isDestroyed() === true;
    } catch (err) {
      return true;
    }
  }

  function targetFramesOf(root) {
    const out = [];
    const frames = frameTree(root);
    const hasRemoteContent = frames.some(frame => isFrameTargetUrl(frameUrl(frame)) && !isNonUiFrameUrl(frameUrl(frame)));
    for (let index = 0; index < frames.length; index += 1) {
      const url = frameUrl(frames[index]);
      if (!url) continue;
      if (!isFrameTargetUrl(url) && !(isAppShellUrl(url) && !hasRemoteContent)) continue;
      // Heal gate 1 (no IPC): a non-UI page such as tray.html is never injected into.
      if (isNonUiFrameUrl(url)) continue;
      out.push(frames[index]);
    }
    return out;
  }

  function targetFrames(contents) {
    let mainFrame = null;
    try {
      mainFrame = contents.mainFrame;
    } catch (err) {
      mainFrame = null;
    }
    return targetFramesOf(mainFrame);
  }

  function frameFromConsoleArgs(args) {
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (!arg || typeof arg !== 'object') continue;
      let candidate = null;
      try {
        candidate = arg.frame || null;
      } catch (err) {
        candidate = null;
      }
      if (!candidate) continue;
      const url = frameUrl(candidate);
      if (url && isFrameTargetUrl(url)) return candidate;
    }
    return null;
  }

  // Which document printed the line, without frameFromConsoleArgs' URL filter: the app shell runs on
  // a custom scheme that no target-URL rule accepts, and it is exactly the report that matters.
  function reportedFrame(args) {
    const list = Array.isArray(args) ? args : [args];
    for (let index = 0; index < list.length; index += 1) {
      const arg = list[index];
      if (!arg || typeof arg !== 'object') continue;
      let candidate = null;
      try {
        candidate = arg.frame || null;
      } catch (err) {
        candidate = null;
      }
      if (candidate) return candidate;
    }
    return null;
  }

  function frameFromFrameCreated(details) {
    if (!details || typeof details !== 'object') return null;
    let candidate = null;
    try {
      candidate = details.frame || null;
    } catch (err) {
      candidate = null;
    }
    if (!candidate && typeof details.executeJavaScript === 'function') candidate = details;
    return candidate;
  }

  function missTargets(contents, args) {
    const preferred = frameFromConsoleArgs(args);
    if (preferred) {
      const narrowed = targetFramesOf(preferred);
      if (narrowed.length > 0) return narrowed;
    }
    return targetFrames(contents);
  }

  function runScript(target, script) {
    if (!target || typeof target.executeJavaScript !== 'function') return Promise.resolve(null);
    try {
      const result = target.executeJavaScript(script, true);
      if (result && typeof result.then === 'function') return result;
      return Promise.resolve(result);
    } catch (err) {
      log('debug', 'executeJavaScript threw', err);
      return Promise.resolve(null);
    }
  }

  // The host header is real DOM inside the app shell page, so the entry bar is injected there
  // instead of into the remote iframe: the shell owns the logo it has to hide.
  function emitHomeBar(contents, visible) {
    if (!contents || isGone(contents)) return Promise.resolve(null);
    if (!isAppShellUrl(safeUrl(contents))) return Promise.resolve(null);
    return runScript(contents, buildHomeBarScript({ on: visible === true, nonce })).catch((error) => {
      log('debug', 'home bar injection failed', error);
      return null;
    });
  }

  // The tab row belongs to the host's content frame, so it is switched off there for as long as
  // the inline page is open; whose frame reports rect 0 while hidden is why the anchor floors at
  // the header bar measured in the app shell.
  function notifyOverlay(covered) {
    if (!onOverlay) return;
    try {
      onOverlay(covered === true);
    } catch (error) {
      log('warn', 'overlay callback failed', error);
    }
  }

  // Tooltips are not worth pushing the whole page away for, so the watcher hides the shell's own
  // bubble and hands its text over; the page draws it instead and the layout never moves.
  function notifyHostTip(payload) {
    if (!onHostTip) return;
    try {
      onHostTip(payload && typeof payload.text === 'string' ? payload : null);
    } catch (error) {
      log('warn', 'host tip callback failed', error);
    }
  }

  function emitPopupWatcher(contents, enabled) {
    if (!contents || isGone(contents)) return Promise.resolve(null);
    if (!isAppShellUrl(safeUrl(contents))) return Promise.resolve(null);
    return runScript(contents, buildPopupScript({ enabled: enabled === true, nonce })).catch((error) => {
      log('debug', 'popup watcher injection failed', error);
      return null;
    });
  }

  function emitChrome(contents, hidden) {
    if (!contents || isGone(contents)) return Promise.resolve(null);
    const frames = targetFrames(contents);
    if (frames.length === 0) return Promise.resolve(null);
    const script = buildChromeScript({ on: hidden === true });
    return Promise.all(
      frames.map((frame) => runScript(frame, script).catch((error) => {
        log('debug', 'host chrome toggle failed', error);
        return null;
      }))
    );
  }

  function setHomeBar(visible) {
    const on = visible === true;
    const tasks = [];
    records.forEach((record) => {
      record.barOn = on;
      record.chromeOn = on;
      tasks.push(emitHomeBar(record.contents, on));
      tasks.push(emitChrome(record.contents, on));
      tasks.push(emitPopupWatcher(record.contents, on));
    });
    if (!on) notifyHostTip(null);
    if (tasks.length === 0) return Promise.resolve([]);
    return Promise.all(tasks);
  }

  function frameState(frame) {
    let state = frameStates.get(frame);
    if (!state) {
      state = {
        generation: 0,
        healFailures: 0,
        healExhausted: false,
        healTimer: null,
        uiVerdict: null,
        seen: new Set(),
        seenOrder: []
      };
      frameStates.set(frame, state);
    }
    return state;
  }

  // A new generation (load finished, dom ready, frame created) is the only thing that restores a
  // spent heal budget: nothing is retried forever.
  function resetHeal(frame) {
    const state = frameState(frame);
    state.generation += 1;
    state.healFailures = 0;
    state.healExhausted = false;
    state.uiVerdict = null;
    if (state.healTimer) {
      clearTimer(state.healTimer);
      retryTimers.delete(state.healTimer);
      state.healTimer = null;
    }
    return state;
  }

  function rememberUrl(state, url) {
    if (state.seen.has(url)) return;
    state.seen.add(url);
    state.seenOrder.push(url);
    while (state.seenOrder.length > URL_LOG_LIMIT) state.seen.delete(state.seenOrder.shift());
  }

  function normalizeStatus(value) {
    if (value === FRAME_STATUS_INJECTED || value === FRAME_STATUS_PRESENT) return value;
    if (value === true) return FRAME_STATUS_INJECTED;
    return FRAME_STATUS_MISS;
  }

  function noteInjection(frame, url, status, reason) {
    const state = frameState(frame);
    if (status === FRAME_STATUS_PRESENT) {
      log('debug', 'entry already present in frame ' + (url || '(empty)') + ' (' + reason + ')');
      return;
    }
    if (status !== FRAME_STATUS_INJECTED) return;
    if (state.seen.has(url)) {
      log('debug', 're-injected into frame ' + (url || '(empty)') + ' (' + reason + ')');
      return;
    }
    rememberUrl(state, url);
    log('info', 'injected into frame ' + (url || '(empty)') + ' (' + reason + ')');
  }

  function injectFrame(frame, reason) {
    const url = frameUrl(frame);
    return runScript(frame, buildFrameScript(frameOptions(frameTargetOrigin(frame)))).then((value) => {
      const status = normalizeStatus(value);
      const state = frameState(frame);
      if (status === FRAME_STATUS_MISS) {
        log('debug', 'frame injection failed: ' + (url || '(empty)') + ' (' + reason + ')');
        return { frame, url, status, state };
      }
      noteInjection(frame, url, status, reason);
      return { frame, url, status, state };
    });
  }

  // Heal gate 2 applied to both paths (attach and re-inject): a frame that reports a hidden or
  // too narrow viewport never receives the entry script.
  function injectGated(frame, reason) {
    const state = frameState(frame);
    return probeHeal(frame, state).then((verdict) => {
      if (verdict === 'blocked') {
        log('debug', 'skip non-ui frame ' + (frameUrl(frame) || '(empty)') + ' (' + reason + ')');
        return { frame, url: frameUrl(frame), status: 'skipped', state };
      }
      return injectFrame(frame, reason);
    });
  }

  function attempt(contents, reason) {
    const label = reason || 'load';
    stats.attempts += 1;
    const tasks = [];
    const topUrl = safeUrl(contents);
    if (isTopLevelUrl(topUrl)) {
      // Modern production pages mute the main-world console. A separate world
      // relays only our nonce-authenticated UI tokens through its own console.
      if (typeof contents.executeJavaScriptInIsolatedWorld === 'function') {
        const transport = '(' + function (nonces, tokens) {
          const key = '__friendTransport';
          if (window[key]) window.removeEventListener('message', window[key]);
          window[key] = function (event) {
            const data = event.data;
            if (event.source !== window || !data || !nonces.includes(data.nonce) || !tokens.includes(data.token)) return;
            console.log(data.nonce + ' ' + data.token + (typeof data.payload === 'string' ? data.payload : ''));
          };
          window.addEventListener('message', window[key]);
        }.toString() + ')(' + JSON.stringify(nonceHistory) + ',' + JSON.stringify([OPEN_TOKEN, CLOSE_TOKEN, HOME_TOKEN, MISS_TOKEN]) + ')';
        tasks.push(Promise.resolve(contents.executeJavaScriptInIsolatedWorld(999, [{ code: transport }])).catch(error => log('debug', 'isolated transport unavailable', error)));
      }
      tasks.push(
        runScript(contents, buildBridgeScript(frameOptions(targetOriginOf(topUrl))))
          .then(() => null)
          .catch((error) => {
            log('debug', 'bridge injection failed', error);
            return null;
          })
      );
    }
    const record = records.get(keyFor(contents));
    if (record && record.barOn === true) tasks.push(emitHomeBar(contents, true));
    tasks.push(emitPopupWatcher(contents, !!(record && record.barOn === true)));
    if (record && record.chromeOn === true) tasks.push(emitChrome(contents, true));
    const frames = targetFrames(contents);
    for (let index = 0; index < frames.length; index += 1) {
      tasks.push(
        injectGated(frames[index], label).catch((error) => {
          log('debug', 'frame injection failed', error);
          return null;
        })
      );
    }
    const targets = frames.map((frame) => frameUrl(frame));
    if (tasks.length === 0) return Promise.resolve({ ok: false, targets });
    return Promise.all(tasks).then((results) => {
      let ok = false;
      for (let index = 0; index < results.length; index += 1) {
        const item = results[index];
        if (item && (item.status === FRAME_STATUS_INJECTED || item.status === FRAME_STATUS_PRESENT)) ok = true;
      }
      if (ok) {
        stats.successes += 1;
        stats.generationSuccesses += 1;
        stats.missExhausted = false;
      }
      return { ok, targets };
    });
  }

  function stopTimer(record) {
    if (record.timer) {
      clearTimer(record.timer);
      record.timer = null;
    }
  }

  function stopHealTimer(frame) {
    const state = frameState(frame);
    if (!state.healTimer) return false;
    clearTimer(state.healTimer);
    retryTimers.delete(state.healTimer);
    state.healTimer = null;
    return true;
  }

  function scheduleHeal(frame, wait, reason) {
    const handle = setTimer(() => {
      retryTimers.delete(handle);
      const state = frameState(frame);
      if (state.healTimer === handle) state.healTimer = null;
      if (disposed || !isEnabled()) return;
      healFrame(frame, reason).catch(() => null);
    }, Math.max(0, wait));
    if (handle && typeof handle.unref === 'function') handle.unref();
    retryTimers.add(handle);
    return handle;
  }

  // A window that never settles (tray.html is kicked by ~18 load/frame-load/navigate/dom-ready events
  // a second) used to restart the whole injection on every event, so it was re-injected 18 times a
  // second and logged the same give-up 18 times a second. A burst is merged instead: the leading event
  // injects at once and the rest collapse into a single trailing run. Nothing is muted - fewer
  // injections actually happen.
  function stopKickTimer(record) {
    if (!record.kickPending && !record.kickTimer) return false;
    if (record.kickTimer) {
      clearTimer(record.kickTimer);
      retryTimers.delete(record.kickTimer);
    }
    record.kickTimer = null;
    record.kickPending = false;
    return true;
  }

  // How long this event has to wait: the rest of the merge window, or the rest of the backoff a
  // previous give-up left behind, whichever ends later.
  function kickWait(record, at) {
    let wait = 0;
    if (record.kickAt >= 0 && at - record.kickAt < kickMergeMs) wait = kickMergeMs - (at - record.kickAt);
    if (record.giveUpAt >= 0) {
      const backoff = record.giveUpAt + kickGiveUpBackoffMs - at;
      if (backoff > wait) wait = backoff;
    }
    return wait;
  }

  function kick(contents, reason) {
    if (disposed || !isEnabled()) return;
    const record = records.get(keyFor(contents));
    if (!record) return;
    const topUrl = safeUrl(contents);
    if (!isTopLevelUrl(topUrl)) {
      stopTimer(record);
      log('debug', 'skip non-host window ' + (topUrl || '(empty)'));
      return;
    }
    const wait = kickWait(record, now());
    if (wait > 0) {
      // The newest event describes the newest document state, so its reason is the one the trailing
      // run uses; one pending run per record is enough however many events arrive.
      record.kickReason = reason;
      // kickPending, not the timer handle: a stubbed setTimeout may hand back a falsy id, and a
      // record that is already waiting for its trailing run must not queue a second one.
      if (!record.kickPending) {
        record.kickPending = true;
        const handle = setTimer(() => {
          retryTimers.delete(handle);
          record.kickTimer = null;
          record.kickPending = false;
          if (disposed || !isEnabled()) return;
          const pending = record.kickReason || 'load';
          record.kickReason = '';
          runKick(record, pending);
        }, wait);
        if (handle && typeof handle.unref === 'function') handle.unref();
        retryTimers.add(handle);
        record.kickTimer = handle;
      }
      return;
    }
    stopKickTimer(record);
    runKick(record, reason);
  }

  function runKick(record, reason) {
    const contents = record.contents;
    const topUrl = safeUrl(contents);
    stopTimer(record);
    record.kickAt = now();
    // A reload starts a new generation and an explicit refresh restarts the feature, so both open a
    // new retry budget and clear a backoff the previous generation left behind. Every other event
    // shares the budget the record already has: a give-up has to stay reachable while a storm keeps
    // kicking, otherwise the backoff below could never apply.
    const fresh = reason === 'load' || reason === 'refresh' || record.deadline <= 0;
    if (fresh) record.giveUpAt = -1;
    if (reason === 'load' && isAppShellUrl(topUrl)) {
      rotateNonce();
      // A reload is a new generation: success on the previous page says nothing about this one.
      stats.generationSuccesses = 0;
      stats.missExhausted = false;
    }
    if (reason === 'load' || reason === 'dom-ready') {
      const reloaded = targetFrames(contents);
      for (let index = 0; index < reloaded.length; index += 1) resetHeal(reloaded[index]);
    }
    if (fresh) record.deadline = now() + retryMaxMs;
    const tick = () => {
      record.timer = null;
      if (disposed || !isEnabled()) return;
      try {
        if (typeof contents.isDestroyed === 'function' && contents.isDestroyed()) return;
      } catch (err) {
        return;
      }
      attempt(contents, reason)
        .then((result) => {
          if (disposed || !isEnabled()) return;
          if (result.ok) {
            record.targets = result.targets;
            record.deadline = 0;
            record.giveUpAt = -1;
            return;
          }
          if (now() >= record.deadline) {
            // Every kick before this one is now throttled for kickGiveUpBackoffMs: a document that
            // keeps emitting load events must not be re-injected at the rate of its own events.
            record.giveUpAt = now();
            const label = result.targets.length > 0 ? result.targets.join(' , ') : topUrl;
            const shell = isAppShellUrl(topUrl);
            log(shell ? 'warn' : 'debug', 'give up ' + (label || 'unknown target') + ' (' + reason + ')');
            // Nothing has ever landed in this generation: that is the host-entry mismatch the
            // settings page has to be able to show, not a transient retry that is still running.
            if (shell && stats.generationSuccesses === 0) stats.missExhausted = true;
            return;
          }
          record.timer = setTimer(tick, retryIntervalMs);
          if (record.timer && typeof record.timer.unref === 'function') record.timer.unref();
        })
        .catch((error) => {
          log('debug', 'injection tick failed', error);
        });
    };
    tick();
  }

  // A console line counts only when it carries a nonce this process handed to an injection; the
  // nonce is stripped off so the token helpers keep seeing the text they have always seen. Any nonce
  // of the last few generations is enough, so re-injection never silences a document that is still
  // running. A degraded factory that yields no nonce at all falls back to the plain text scan.
  function acceptConsole(args) {
    const list = Array.isArray(args) ? args : [args];
    if (!nonce) return list.slice();
    for (let index = 0; index < nonceHistory.length; index += 1) {
      const hit = withNonce(list, nonceHistory[index], 0);
      if (hit) return hit;
    }
    return null;
  }

  // Both channels (the bridge's postMessage relay and the frame's own console line) can deliver
  // the same click, so the same token is acted on once within a short window.
  function duplicateToken(kind) {
    const at = now();
    const last = seenTokens.get(kind);
    seenTokens.set(kind, at);
    return typeof last === 'number' && at - last < tokenDedupeMs;
  }

  // The injected bridge reports the origin of the document it runs in, so the shell and everything
  // it embeds all report themselves. Only the top document may own the target origin: an iframe's
  // origin overwrote the shell's, the pair never settled and the two re-injected each other forever.
  function isShellOriginReport(record, frame, origin) {
    if (!record || !record.contents) return false;
    const topUrl = safeUrl(record.contents);
    // Only an app shell window owns the shell origin. A content window reporting its own https origin
    // used to overwrite it, and the two windows then re-injected each other every few milliseconds.
    if (!isAppShellUrl(topUrl)) return false;
    const main = record.contents.mainFrame || null;
    if (frame && main && frame !== main) return false;
    const derived = originOf(topUrl);
    // A file: shell has no tuple origin to compare against, so frame identity has to decide there.
    if (derived && derived !== 'file://') return derived === origin;
    return Boolean(frame && main && frame === main);
  }

  // The app shell is the only side that can say what its own origin is, so a frame starts posting to
  // the top window only after this line arrives; until then its nonce-checked console line is the
  // channel that works. One origin-triggered re-injection per record per second may follow.
  function noteShellOrigin(record, origin, frame) {
    if (!origin) return;
    if (!isShellOriginReport(record, frame, origin)) {
      log('debug', 'ignored origin report from another document ' + origin);
      return;
    }
    if (record.shellOrigin === origin && shellOrigin === origin) return;
    record.shellOrigin = origin;
    shellOrigin = origin;
    const at = now();
    if (record.originKickAt >= 0 && at - record.originKickAt < originKickMinMs) {
      log('debug', 'shell origin ' + origin + ' reported again within ' + originKickMinMs + 'ms, not re-injecting');
      return;
    }
    record.originKickAt = at;
    log('info', 'app shell origin ' + origin);
    kick(record.contents, 'origin');
  }

  function handleConsole(record, args) {
    // Nothing is acted on unless the line still carries the nonce of a live injection generation:
    // the host page can print the token itself, and a foreign frame cannot know the nonce.
    const verified = acceptConsole(args);
    if (!verified) {
      log('debug', 'console line without a live nonce ignored');
      return;
    }
    const reportedOrigin = matchOriginToken(verified);
    if (reportedOrigin) {
      noteShellOrigin(record, reportedOrigin, reportedFrame(args));
      return;
    }
    args = verified;
    if (matchHomeToken(args)) {
      if (duplicateToken('home')) return;
      seenTokens.delete('open');
      log('info', 'home entry clicked, closing the inline page');
      if (closeSettings) {
        try {
          closeSettings();
        } catch (err) {
          log('error', 'closeSettings failed', err);
        }
      }
      setHomeBar(false);
      return;
    }
    if (matchCloseToken(args)) {
      if (duplicateToken('close')) return;
      seenTokens.delete('open');
      log('info', 'host tab clicked, closing the inline page');
      if (closeSettings) {
        try {
          closeSettings();
        } catch (err) {
          log('error', 'closeSettings failed', err);
        }
      }
      return;
    }
    const tipPayload = matchTipOnToken(args);
    if (tipPayload) {
      notifyHostTip(tipPayload);
      return;
    }
    if (matchTipOffToken(args)) {
      notifyHostTip(null);
      return;
    }
    if (matchPopupOnToken(args)) {
      notifyOverlay(true);
      return;
    }
    if (matchPopupOffToken(args)) {
      notifyOverlay(false);
      return;
    }
    if (matchOpenToken(args)) {
      if (duplicateToken('open')) return;
      seenTokens.delete('home');
      seenTokens.delete('close');
      log('info', 'page entry clicked, opening settings');
      if (openSettings) {
        try {
          openSettings();
        } catch (err) {
          log('error', 'openSettings failed', err);
        }
      }
      return;
    }
    if (!matchMissToken(args)) return;
    const missDetail = matchMissDetail(args);
    if (missDetail) {
      stats.lastMissDetail = missDetail;
      log('warn', 'entry miss against host profile v' + missDetail.profile + ': ' + missDetail.tabs + ' tab strip(s), ' + missDetail.items + ' tab item(s) on the page');
    }
    if (record.missLogged) {
      log('debug', 'page reported entry miss (repeat)');
    } else {
      record.missLogged = true;
      log('info', 'page reported entry miss (frame could not locate tabs), re-injecting');
    }
    recoverMiss(record, 'miss');
  }

  function probeHeal(frame, state) {
    if (state.uiVerdict) return Promise.resolve(state.uiVerdict);
    return runScript(frame, buildUiProbeScript())
      .then((value) => {
        const verdict = uiGateVerdict(value);
        state.uiVerdict = verdict;
        return verdict;
      })
      .catch(() => 'unknown');
  }

  function healFrame(frame, reason) {
    const url = frameUrl(frame);
    const state = frameState(frame);
    if (state.healExhausted || state.healFailures >= healAttemptLimit) {
      return Promise.resolve({ frame, url, status: 'exhausted', state });
    }
    return injectGated(frame, reason)
      .then((result) => {
        if (!result || result.status === 'skipped' || result.status === 'exhausted') return result;
        const status = result.status;
        if (status !== FRAME_STATUS_MISS) {
          state.healFailures = 0;
          if (status === FRAME_STATUS_PRESENT) {
            log('info', 'entry already present in frame ' + (url || '(empty)') + ', no re-inject needed (' + reason + ')');
          } else {
            log('info', 're-injected missing entry into frame ' + (url || '(empty)') + ' (' + reason + ')');
          }
          return { frame, url, status, state };
        }
        state.healFailures += 1;
        if (state.healFailures >= healAttemptLimit) {
          state.healExhausted = true;
          if (stats.generationSuccesses === 0) stats.missExhausted = true;
          log('warn', 'gave up re-injecting frame ' + (url || '(empty)') + ' after ' + state.healFailures + ' attempts, waiting for the frame to reload (' + reason + ')');
          return { frame, url, status, state };
        }
        const delay = healDelayFor(state.healFailures, healMinDelayMs, healMaxDelayMs);
        log('debug', 're-inject attempt ' + state.healFailures + '/' + healAttemptLimit + ' failed for frame ' + (url || '(empty)') + ', retrying in ' + delay + 'ms');
        state.healTimer = scheduleHeal(frame, delay, reason);
        return { frame, url, status, state };
      })
      .catch((error) => {
        state.healFailures += 1;
        log('debug', 're-inject threw for frame ' + (url || '(empty)'), error);
        return { frame, url, status: FRAME_STATUS_MISS, state };
      });
  }

  function recoverMiss(record, reason) {
    if (disposed || !isEnabled()) return 0;
    const contents = record.contents;
    if (isGone(contents)) return 0;
    const frames = missTargets(contents, record.consoleArgs || []);
    if (frames.length === 0) {
      if (record.missWarned) {
        log('debug', 'entry miss with no injectable frame (' + reason + ')');
      } else {
        record.missWarned = true;
        log('warn', 'entry miss with no injectable frame (' + reason + ')');
      }
      return 0;
    }
    let started = 0;
    for (let index = 0; index < frames.length; index += 1) {
      const frame = frames[index];
      const state = frameState(frame);
      if (state.healExhausted) {
        log('debug', 're-inject budget spent for frame ' + frameUrl(frame) + ' until it reloads');
        continue;
      }
      if (state.healTimer) {
        log('debug', 're-inject already scheduled for frame ' + frameUrl(frame) + ' (' + state.healFailures + '/' + healAttemptLimit + ')');
        continue;
      }
      if (record.healFrames) record.healFrames.add(frame);
      started += 1;
      healFrame(frame, reason).catch(() => null);
    }
    return started;
  }

  function onFrameCreated(record, details) {
    if (disposed || !isEnabled()) return;
    const contents = record.contents;
    if (isGone(contents)) return;
    const frame = frameFromFrameCreated(details);
    const url = frameUrl(frame);
    if (frame && url && isFrameTargetUrl(url)) {
      if (isNonUiFrameUrl(url)) {
        log('debug', 'skip non-ui frame ' + url + ' (frame-created)');
        return;
      }
      resetHeal(frame);
      injectFrame(frame, 'frame-created').catch(() => null);
      return;
    }
    kick(contents, 'frame-created');
  }

  function detachRecord(record) {
    const contents = record.contents;
    stopTimer(record);
    stopKickTimer(record);
    if (record.healFrames) {
      record.healFrames.forEach((frame) => stopHealTimer(frame));
      record.healFrames.clear();
    }
    if (!contents || typeof contents.removeListener !== 'function') return;
    const bindings = record.bindings || [];
    record.bindings = [];
    for (let index = 0; index < bindings.length; index += 1) {
      try {
        contents.removeListener(bindings[index][0], bindings[index][1]);
      } catch (err) {
        log('debug', 'detach listeners failed', err);
      }
    }
    try {
      contents.removeListener('destroyed', record.onDestroyed);
    } catch (err) {
      log('debug', 'detach listeners failed', err);
    }
  }

  function attach(contents) {
    if (disposed || !contents || typeof contents.on !== 'function') return false;
    const type = typeof contents.getType === 'function' ? contents.getType() : 'window';
    if (type !== 'window') return false;
    const key = keyFor(contents);
    if (records.has(key)) return false;
    const record = {
      contents,
      timer: null,
      healFrames: new Set(),
      missLogged: false,
      missWarned: false,
      deadline: 0,
      kickAt: -1,
      kickTimer: null,
      kickPending: false,
      kickReason: '',
      giveUpAt: -1,
      targets: [],
      consoleArgs: [],
      barOn: false,
      chromeOn: false,
      shellOrigin: '',
      originKickAt: -1,
      bindings: [],
      onLoad: () => kick(contents, 'load'),
      onDomReady: () => kick(contents, 'dom-ready'),
      onNavigate: () => kick(contents, 'navigate'),
      onFrameLoad: () => kick(contents, 'frame-load'),
      onFrameCreated: function (_event, details) {
        onFrameCreated(record, details);
      },
      onConsole: function () {
        const args = Array.prototype.slice.call(arguments);
        record.consoleArgs = args;
        handleConsole(record, args);
      },
      onDestroyed: () => {
        const current = records.get(key);
        if (!current) return;
        detachRecord(current);
        records.delete(key);
      }
    };
    records.set(key, record);
    const bindings = [
      ['did-finish-load', record.onLoad],
      ['dom-ready', record.onDomReady],
      ['did-navigate', record.onNavigate],
      ['did-navigate-in-page', record.onNavigate],
      ['did-frame-finish-load', record.onFrameLoad],
      ['did-frame-navigate', record.onFrameLoad],
      ['frame-created', record.onFrameCreated],
      ['console-message', record.onConsole]
    ];
    try {
      for (let index = 0; index < bindings.length; index += 1) {
        contents.on(bindings[index][0], bindings[index][1]);
        record.bindings.push(bindings[index]);
      }
      contents.once('destroyed', record.onDestroyed);
    } catch (err) {
      detachRecord(record);
      records.delete(key);
      log('warn', 'attach listeners failed', err);
      return false;
    }
    let loading = false;
    try {
      loading = typeof contents.isLoading === 'function' ? contents.isLoading() : false;
    } catch (err) {
      loading = false;
    }
    if (!loading) kick(contents, 'attach');
    return true;
  }

  function onWebContentsCreated(_event, contents) {
    attach(contents);
  }

  function onWindowFocus(_event, window) {
    if (disposed || !isEnabled()) return;
    const contents = window && window.webContents;
    if (!contents || !isAppShellUrl(safeUrl(contents))) return;
    const record = records.get(keyFor(contents));
    if (!record) return;
    // Background startup can finish loading while the page is hidden. A focus
    // transition invalidates that cached visibility verdict, without spending
    // another retry budget on an unchanged visible page or a tray document.
    const blocked = targetFrames(contents).filter(frame => frameState(frame).uiVerdict === 'blocked');
    if (!blocked.length) return;
    blocked.forEach(resetHeal);
    record.deadline = 0;
    record.giveUpAt = -1;
    kick(contents, 'visible');
  }

  if (app && typeof app.on === 'function') {
    try {
      app.on('web-contents-created', onWebContentsCreated);
      app.on('browser-window-focus', onWindowFocus);
    } catch (err) {
      log('warn', 'subscribe web-contents-created failed', err);
    }
  }

  function scanExistingWindows() {
    const BrowserWindow = electron.BrowserWindow;
    if (!BrowserWindow || typeof BrowserWindow.getAllWindows !== 'function') return 0;
    let count = 0;
    try {
      const windows = BrowserWindow.getAllWindows() || [];
      for (let index = 0; index < windows.length; index += 1) {
        const window = windows[index];
        const contents = window && window.webContents;
        if (contents && attach(contents)) count += 1;
      }
    } catch (err) {
      log('warn', 'scan existing windows failed', err);
    }
    return count;
  }

  // Switching the entry off has to put the page back the way it was found: the 120ms watcher, the
  // tip marks and their stylesheet, the home bar with its observer and listener, the chrome class
  // and the message bridge all belong to the feature. Removing the entry node inside the frames
  // alone leaves every one of those running in a page the feature no longer owns.
  function rollback(record) {
    const contents = record.contents;
    if (!isGone(contents) && typeof contents.executeJavaScriptInIsolatedWorld === 'function') Promise.resolve(contents.executeJavaScriptInIsolatedWorld(999, [{ code: 'if(window.__friendTransport){window.removeEventListener("message",window.__friendTransport);delete window.__friendTransport;}' }])).catch(() => {});
    const frames = targetFrames(contents);
    stopTimer(record);
    stopKickTimer(record);
    record.kickAt = -1;
    record.kickPending = false;
    record.kickReason = '';
    record.giveUpAt = -1;
    record.barOn = false;
    record.chromeOn = false;
    record.shellOrigin = '';
    record.originKickAt = -1;
    record.targets = [];
    record.deadline = 0;
    record.missLogged = false;
    record.missWarned = false;
    if (record.healFrames) {
      record.healFrames.forEach((frame) => stopHealTimer(frame));
      record.healFrames.clear();
    }
    shellOrigin = '';
    if (isGone(contents)) return 0;
    let count = 0;
    runScript(contents, buildCleanupScript())
      .then(() => null)
      .catch(() => null);
    count += 1;
    for (let index = 0; index < frames.length; index += 1) {
      runScript(frames[index], buildRemoveScript(frameOptions()))
        .then(() => null)
        .catch(() => null);
      runScript(frames[index], buildChromeScript({ on: false }))
        .then(() => null)
        .catch(() => null);
      // The frame runtime is gone after this, so the next generation must start with a fresh
      // retry budget instead of inheriting an exhausted one.
      resetHeal(frames[index]);
      count += 1;
    }
    return count;
  }

  // What index.js reads for buildState.entryStatus, and what the settings page turns into its
  // "host entry mismatch" notice, so it never throws and always names a reason.
  function status() {
    try {
      const attempts = stats.attempts;
      if (!isEnabled()) return { ok: false, reason: 'disabled', attempts };
      if (stats.generationSuccesses > 0 && !stats.missExhausted) return { ok: true, reason: '', attempts };
      if (stats.missExhausted) return { ok: false, reason: 'selectors-miss', attempts };
      if (attempts === 0) return { ok: false, reason: 'idle', attempts };
      return { ok: false, reason: 'pending', attempts };
    } catch (error) {
      return { ok: false, reason: 'error', attempts: 0 };
    }
  }

  function refresh() {
    let count = 0;
    const enabled = isEnabled();
    if (enabled !== lastEnabled) {
      lastEnabled = enabled;
      stats.attempts = 0;
      stats.successes = 0;
      stats.generationSuccesses = 0;
      stats.missExhausted = false;
      stats.lastMissDetail = null;
      seenTokens.clear();
    }
    if (!enabled) {
      // The inline page and the host's mirrored tooltip cannot outlive the entry that drives them.
      notifyOverlay(false);
      notifyHostTip(null);
    } else {
      rotateNonce();
    }
    records.forEach((record) => {
      if (enabled) {
        kick(record.contents, 'refresh');
        count += 1;
        return;
      }
      count += rollback(record);
    });
    return count;
  }

  const scanned = scanExistingWindows();
  log('info', 'installed, existing windows=' + scanned);

  function dispose() {
    if (disposed) return;
    disposed = true;
    try {
      if (app && typeof app.removeListener === 'function') app.removeListener('web-contents-created', onWebContentsCreated);
      if (app && typeof app.removeListener === 'function') app.removeListener('browser-window-focus', onWindowFocus);
    } catch (err) {
      log('warn', 'unsubscribe web-contents-created failed', err);
    }
    records.forEach((record) => detachRecord(record));
    records.clear();
    retryTimers.forEach((handle) => clearTimer(handle));
    retryTimers.clear();
  }

  return {
    dispose,
    refresh,
    scanExistingWindows,
    targetFrames,
    attempt,
    status,
    setHomeBar,
    attachedCount: () => records.size,
    isEnabled
  };
}

module.exports = {
  ENTRY_ATTR,
  PET_ICON_ATTR,
  PET_ICON_SELECTOR,
  ICON_VIEW_BOX,
  CAT_EYES_FILL,
  CAT_PATH_EYES,
  CAT_PATH_BODY,
  ICON_SELECTOR,
  ENTRY_TEXT,
  OPEN_TOKEN,
  MISS_TOKEN,
  CLOSE_TOKEN,
  HOME_TOKEN,
  BAR_ATTR,
  BAR_CLASS,
  BAR_STYLE_ID,
  CHROME_CLASS,
  CHROME_STYLE_ID,
  POPUP_ON_TOKEN,
  POPUP_OFF_TOKEN,
  TIP_ON_TOKEN,
  TIP_OFF_TOKEN,
  TIP_ATTR,
  TIP_CLASS,
  POPUP_SELECTOR,
  BAR_LABEL,
  NAV_ATTR,
  TABS_SELECTOR,
  TAB_ID,
  TAB_TEXTS,
  ITEM_SELECTOR,
  TEXT_SELECTOR,
  RETRY_INTERVAL_MS,
  RETRY_MAX_MS,
  HEAL_MIN_DELAY_MS,
  HEAL_MAX_DELAY_MS,
  HEAL_BACKOFF,
  HEAL_ATTEMPT_LIMIT,
  KICK_MERGE_MS,
  KICK_GIVE_UP_BACKOFF_MS,
  UI_MIN_WIDTH,
  NON_UI_BASENAMES,
  FRAME_STATUS_INJECTED,
  FRAME_STATUS_PRESENT,
  FRAME_STATUS_MISS,
  isTopLevelUrl,
  isFrameTargetUrl,
  isAppShellUrl,
  isRemoteUrl: isTopLevelUrl,
  frameTree,
  frameUrl,
  buildConfig,
  buildBridgeScript,
  buildHomeBarScript,
  injectedHomeBarMain,
  buildChromeScript,
  injectedChromeMain,
  buildPopupScript,
  injectedPopupMain,
  buildFrameScript,
  buildInjectionScript: buildFrameScript,
  buildRemoveScript,
  buildMeasureScript,
  buildTabsScript,
  buildUiProbeScript,
  measureContentTop,
  measureHostAnchor,
  normalizeTabsResult,
  combineAnchor,
  measureTabStripTop,
  frameBasename,
  isNonUiFrameUrl,
  uiGateVerdict,
  healDelayFor,
  matchOpenToken,
  matchPopupOnToken,
  matchPopupOffToken,
  matchTipOnToken,
  matchTipOffToken,
  matchMissToken,
  matchCloseToken,
  matchOriginToken,
  matchMissDetail,
  withNonce,
  ORIGIN_TOKEN,
  HOST_PROFILE,
  createNonce,
  originOf,
  buildCleanupScript,
  injectedCleanupMain,
  install
};
