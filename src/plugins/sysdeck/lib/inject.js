'use strict';
// 页面注入器：把 renderer/host.js（必需）和 renderer/panel.js（必需）拼成一个自包含载荷。
// 同一载荷里 host 与 panel 各自 try/catch —— panel.js 抛错绝不能影响 host 通道。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const HOST_FILE = path.join(RENDERER_DIR, 'host.js');
const PANEL_FILE = path.join(RENDERER_DIR, 'panel.js');

const TAIL = 'try{if(window.__mcDeckHost&&typeof window.__mcDeckHost.ready==="function")window.__mcDeckHost.ready();}catch(e){}';

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
  // 独立 IIFE + try/catch：任何一个文件出错都只记日志，不阻断另一个。
  const guard = 'try{console.dir("[mc-deck]"+JSON.stringify({t:"error",where:' + JSON.stringify(name) + ',message:String((e&&e.message)||e)}));}catch(_){}';
  return '(function(){try{\n' + code + '\n}catch(e){' + guard + '}})();';
}

function build(logger) {
  const host = readFileSafe(HOST_FILE);
  if (!host || !host.text.trim()) {
    if (logger) logger.error('inject: host.js missing or empty -> ' + HOST_FILE);
    return { ok: false, error: { code: 'HOST_MISSING', message: HOST_FILE }, payload: '', hash: '' };
  }
  const panel = readFileSafe(PANEL_FILE);
  if (!panel || !panel.text.trim()) {
    if (logger) logger.error('inject: panel.js missing or empty -> ' + PANEL_FILE);
    return { ok: false, error: { code: 'PANEL_MISSING', message: PANEL_FILE }, payload: '', hash: '' };
  }
  const parts = [wrap(host.text, 'host')];
  parts.push(wrap(panel.text, 'panel'));
  parts.push(TAIL);
  const payload = parts.join('\n');

  const h = crypto.createHash('sha1');
  h.update(payload);
  h.update('|' + String(host.mtimeMs) + '|' + String(host.size));
  h.update('|' + String(panel.mtimeMs) + '|' + String(panel.size));

  return {
    ok: true,
    payload: payload,
    hash: h.digest('hex').slice(0, 16),
    hostBytes: host.size,
    panelBytes: panel.size,
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
      if (logger) logger.info('inject payload changed: ' + current.hash + ' -> ' + next.hash + ' (' + next.bytes + ' bytes)');
      current = next;
    }
    return current;
  }

  return {
    get: function () { return refresh(false); },
    force: function () { return refresh(true); },
    hash: function () { return current.hash; },
    info: function () { return { hash: current.hash, hostBytes: current.hostBytes, panelBytes: current.panelBytes, bytes: current.bytes }; }
  };
}

module.exports = {
  build: build,
  createInjector: createInjector,
  HOST_FILE: HOST_FILE,
  PANEL_FILE: PANEL_FILE,
  RENDERER_DIR: RENDERER_DIR
};
