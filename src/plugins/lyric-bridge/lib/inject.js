'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const HOST_FILE = path.join(RENDERER_DIR, 'host.js');
const UI_FILE = path.join(RENDERER_DIR, 'ui.js');
const DEVICE_FILE = path.join(RENDERER_DIR, 'device.js');
const PLAYER_FILE = path.join(RENDERER_DIR, 'player.js');
const TAIL = 'try{if(window.__mcBridgeHost&&typeof window.__mcBridgeHost.ready==="function")window.__mcBridgeHost.ready();}catch(e){}';
function readFileSafe(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    return { text: fs.readFileSync(file, 'utf8'), mtimeMs: st.mtimeMs, size: st.size };
  } catch (e) {
    return null;
  }
}
function wrap(code, name) {
  const guard = 'try{console.log("[mc-bridge]"+JSON.stringify({t:"error",where:' + JSON.stringify(name) + ',message:String((e&&e.message)||e)}));}catch(_){}';
  return '(function(){try{\n' + code + '\n}catch(e){' + guard + '}})();';
}
function build(logger) {
  const host = readFileSafe(HOST_FILE);
  if (!host || !host.text.trim()) {
    if (logger) logger.error('inject: host.js missing or empty -> ' + HOST_FILE);
    return { ok: false, error: { code: 'HOST_MISSING', message: HOST_FILE }, payload: '', hash: '', hasUi: false };
  }
  const ui = readFileSafe(UI_FILE);
  const device = readFileSafe(DEVICE_FILE);
  if (!device || !device.text.trim()) return { ok: false, error: { code: 'DEVICE_MISSING', message: DEVICE_FILE }, payload: '', hash: '', hasUi: false };
  const parts = [wrap(host.text, 'host')];
  parts.push(wrap(device.text, 'device'));
  if (ui && ui.text.trim()) parts.push(wrap(ui.text, 'ui'));
  const player = readFileSafe(PLAYER_FILE);
  if (player && player.text.trim()) parts.push(wrap(player.text, 'player'));
  parts.push(TAIL);
  const payload = parts.join('\n');
  const h = crypto.createHash('sha1');
  h.update(payload);
  h.update('|' + String(host.mtimeMs) + '|' + String(host.size));
  h.update('|' + (ui ? String(ui.mtimeMs) + '|' + String(ui.size) : 'no-ui'));
  h.update('|' + String(device.mtimeMs) + '|' + String(device.size));
  h.update('|' + (player ? String(player.mtimeMs) + '|' + String(player.size) : 'no-player'));
  return {
    ok: true,
    payload: payload,
    hash: h.digest('hex').slice(0, 16),
    hasUi: !!(ui && ui.text.trim()),
    hostBytes: host.size,
    uiBytes: ui ? ui.size : 0,
    hostMtimeMs: host.mtimeMs,
    uiMtimeMs: ui ? ui.mtimeMs : 0,
    bytes: Buffer.byteLength(payload)
  };
}
function createInjector(options) {
  const opts = options || {};
  const logger = opts.logger || null;
  const refreshMs = opts.refreshMs || 2000;
  let current = build(logger);
  let lastCheck = 0;
  function refresh(force) {
    const now = Date.now();
    if (!force && now - lastCheck < refreshMs) return current;
    lastCheck = now;
    const next = build(logger);
    if (!next.ok) return current;
    if (next.hash !== current.hash) {
      if (logger) logger.info('inject payload changed: ' + current.hash + ' -> ' + next.hash + ' (ui=' + next.hasUi + ', ' + next.bytes + ' bytes)');
      current = next;
    }
    return current;
  }
  return {
    get: function () { return refresh(false); },
    force: function () { return refresh(true); },
    hash: function () { return current.hash; },
    info: function () { return { hash: current.hash, hasUi: current.hasUi, hostBytes: current.hostBytes, uiBytes: current.uiBytes, bytes: current.bytes }; }
  };
}
module.exports = {
  build: build,
  createInjector: createInjector,
  HOST_FILE: HOST_FILE,
  UI_FILE: UI_FILE,
  RENDERER_DIR: RENDERER_DIR
};
