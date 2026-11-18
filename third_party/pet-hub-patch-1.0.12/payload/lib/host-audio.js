'use strict';

const crypto = require('crypto');
const PREFIX = '__MCHOSE_FRIEND_AUDIO__';
const MODES = ['音乐模式', '游戏模式', '电影模式'];

// Mirror the response already decoded by MHUB's K20 driver. Do not open a HID
// handle, send a command, or treat an optimistic mode-card click as confirmation.
function rendererBridge(token, prefix) {
  const key = '__mchoseFriendAudioBridge';
  if (window[key] && window[key].token === token) { window[key].seed(); return; }
  if (window[key]) window[key].stop();
  const original = console.log;
  function device() {
    const query = location.hash.split('?')[1] || '';
    const product = new URLSearchParams(query).get('productKey');
    if (/^MCHOSE K20 (?:GT|PRO)$/.test(product || '')) return product;
    // New MHUB uses /audio/* without the legacy productKey query.
    if (!/^#\/audio\//.test(location.hash)) return null;
    const header = document.querySelector('.app-header');
    const label = header && String(header.textContent || '').match(/\bK20\s+(GT|PRO)\b/i);
    return label ? 'MCHOSE K20 ' + label[1].toUpperCase() : null;
  }
  function report(value, initial) {
    const product = device();
    if (!product || !Number.isInteger(value) || value < 0 || value > 2) return;
    original.call(console, prefix + token + ' ' + JSON.stringify({ product, mode: value, initial: initial === true }));
    if (typeof window.postMessage === 'function') window.postMessage({ friendAudio: token, product, mode: value, initial: initial === true }, location.origin);
  }
  function seed() {
    if (!/\/audio_mode(?:\?|$)/.test(location.hash)) return;
    const active = document.querySelector('.box-item .box.active');
    const label = active && active.parentElement.querySelector('.name');
    const text = label && label.textContent.trim();
    const labels = ['音乐模式', '游戏模式', '电影模式'];
    const english = ['Music mode', 'Game mode', 'Movie mode'];
    const value = labels.indexOf(text);
    const fallback = english.findIndex(name => name.toLowerCase() === String(text || '').toLowerCase());
    if (value >= 0 || fallback >= 0) report(value >= 0 ? value : fallback, true);
  }
  function wrapped() {
    // These are the driver's decoded initial state and actual input response.
    // Preserve all original logging arguments and its return value.
    try {
      const label = arguments[0], data = arguments[1];
      // Prefer the decoded response shape to translated/debug label strings.
      // Outgoing setEqModeState logs are scalar values and cannot match this.
      if (data && typeof data === 'object' && data.type === 'eqMode') report(data.data, false);
      else if (data && typeof data === 'object' && Object.prototype.hasOwnProperty.call(data, 'eqModeState')) report(data.eqModeState, true);
    } catch (_) {}
    return original.apply(this, arguments);
  }
  console.log = wrapped;
  window[key] = { token, seed, stop() {
    if (console.log === wrapped) console.log = original;
    delete window[key];
  } };
  seed();
}

function buildScript(token) { return '(' + rendererBridge.toString() + ')(' + JSON.stringify(token) + ',' + JSON.stringify(PREFIX) + ')'; }
const CLEANUP = "if(window.__mchoseFriendAudioBridge)window.__mchoseFriendAudioBridge.stop();";

function install(options) {
  const { electron, onMode } = options;
  const records = new Map(), last = new Map();
  let injected = 0, lastResponseAt = 0, lastError = false;
  let stopped = false;
  function attach(win) {
    const contents = win && win.webContents;
    if (!contents || typeof contents.on !== 'function' || records.has(contents)) return;
    const token = crypto.randomBytes(16).toString('hex');
    function inject() {
      if (stopped || contents.isDestroyed()) return;
      // Audio settings are rendered in the native MHUB shell, not its tray or
      // an arbitrary web page. No account/store content is inspected.
      if (!/^mchose-renderer:\/\/app\//i.test(contents.getURL())) return;
      if (typeof contents.executeJavaScriptInIsolatedWorld === 'function') {
        const code = '(' + function (token, prefix) {
          if (window.__friendAudioTransport) window.removeEventListener('message', window.__friendAudioTransport);
          window.__friendAudioTransport = event => {
            const value = event.data;
            if (event.source !== window || !value || value.friendAudio !== token || !/^MCHOSE K20 (?:GT|PRO)$/.test(value.product) || !Number.isInteger(value.mode) || value.mode < 0 || value.mode > 2) return;
            console.log(prefix + token + ' ' + JSON.stringify({ product: value.product, mode: value.mode, initial: value.initial === true }));
          };
          window.addEventListener('message', window.__friendAudioTransport);
        }.toString() + ')(' + JSON.stringify(token) + ',' + JSON.stringify(PREFIX) + ')';
        Promise.resolve(contents.executeJavaScriptInIsolatedWorld(1000, [{ code }])).catch(() => { lastError = true; });
      }
      Promise.resolve(contents.executeJavaScript(buildScript(token))).then(() => { injected++; lastError = false; }).catch(() => { lastError = true; });
    }
    function consoleMessage(event, _level, message) {
      const text = typeof message === 'string' ? message : event && event.message;
      const start = PREFIX + token + ' ';
      if (stopped || typeof text !== 'string' || !text.startsWith(start)) return;
      try {
        const value = JSON.parse(text.slice(start.length));
        if (!/^MCHOSE K20 (?:GT|PRO)$/.test(value.product) || !Number.isInteger(value.mode) || !MODES[value.mode]) return;
        const previous = last.get(value.product);
        lastResponseAt = Date.now();
        last.set(value.product, value.mode);
        if (value.initial === true || previous === value.mode) return;
        onMode({ product: value.product, mode: value.mode, text: '音效模式：' + MODES[value.mode] });
      } catch (_) {}
    }
    const names = ['dom-ready', 'did-finish-load', 'did-navigate-in-page'];
    const destroyed = () => { records.delete(contents); };
    names.forEach(name => contents.on(name, inject));
    contents.on('console-message', consoleMessage);
    contents.once('destroyed', destroyed);
    records.set(contents, { names, inject, consoleMessage, destroyed });
    inject();
  }
  function created(_event, win) { attach(win); }
  electron.app.on('browser-window-created', created);
  electron.BrowserWindow.getAllWindows().forEach(attach);
  return { state() { return { mode: 'structured-with-fallback', fallback: 'decoded-response', supportedProducts: ['K20 GT', 'K20 PRO'], injected: injected > 0, failed: lastError, lastResponseAt }; }, stop() {
    if (stopped) return;
    stopped = true;
    electron.app.removeListener('browser-window-created', created);
    records.forEach((record, contents) => {
      record.names.forEach(name => contents.removeListener(name, record.inject));
      contents.removeListener('destroyed', record.destroyed);
      contents.removeListener('console-message', record.consoleMessage);
      if (!contents.isDestroyed()) Promise.resolve(contents.executeJavaScript(CLEANUP)).catch(() => {});
      if (!contents.isDestroyed() && typeof contents.executeJavaScriptInIsolatedWorld === 'function') Promise.resolve(contents.executeJavaScriptInIsolatedWorld(1000, [{ code: 'if(window.__friendAudioTransport){window.removeEventListener("message",window.__friendAudioTransport);delete window.__friendAudioTransport;}' }])).catch(() => {});
    });
    records.clear(); last.clear();
  } };
}

module.exports = { install, buildScript, PREFIX };
