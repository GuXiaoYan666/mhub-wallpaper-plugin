'use strict';
/* 统一的 JSON 网络请求：优先走 Electron 的 net 模块（使用 Chromium 网络栈，
   跟随系统代理与证书设置），拿不到时退回 Node https。
   部分用户开了系统代理或 HTTPS 拦截，直接 https.get 会一律失败，
   表现为「在线歌词服务不可用」。 */
const https = require('https');
const MAX_BODY = 2 * 1024 * 1024;
const DEFAULT_UA = 'LyricBridge/1.3.10 (MCHOSE K20 GT lyric bridge)';

let electronNet = null;
try {
  const electron = require('electron');
  electronNet = electron && electron.net ? electron.net : null;
} catch (e) { electronNet = null; }

function parseJson(text) {
  return JSON.parse(text);
}

function viaElectron(url, timeoutMs, headers) {
  return new Promise(function (resolve, reject) {
    let settled = false;
    let timer = null;
    let req = null;
    function done(err, value) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) reject(err); else resolve(value);
    }
    try {
      req = electronNet.request({ method: 'GET', url: url, redirect: 'follow' });
    } catch (e) {
      done(e);
      return;
    }
    try {
      Object.keys(headers).forEach(function (key) { req.setHeader(key, headers[key]); });
    } catch (e) { /* ignore */ }
    timer = setTimeout(function () { try { req.abort(); } catch (e) { /* ignore */ } done(new Error('timeout')); }, timeoutMs);
    req.on('response', function (res) {
      if (res.statusCode === 404) { done(null, null); return; }
      if (res.statusCode < 200 || res.statusCode >= 300) { done(new Error('HTTP ' + res.statusCode)); return; }
      const chunks = [];
      let size = 0;
      res.on('data', function (chunk) {
        size += chunk.length;
        if (size > MAX_BODY) { try { req.abort(); } catch (e) { /* ignore */ } done(new Error('response too large')); return; }
        chunks.push(chunk);
      });
      res.on('end', function () {
        try { done(null, parseJson(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { done(e); }
      });
      res.on('error', function (e) { done(e); });
    });
    req.on('error', function (e) { done(e); });
    try { req.end(); } catch (e) { done(e); }
  });
}

function viaHttps(url, timeoutMs, headers) {
  return new Promise(function (resolve, reject) {
    let settled = false;
    function done(err, value) {
      if (settled) return;
      settled = true;
      if (err) reject(err); else resolve(value);
    }
    let req;
    try {
      req = https.get(url, { headers: headers }, function (res) {
        if (res.statusCode === 404) { res.resume(); done(null, null); return; }
        if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); done(new Error('HTTP ' + res.statusCode)); return; }
        const chunks = [];
        let size = 0;
        res.on('data', function (chunk) {
          size += chunk.length;
          if (size > MAX_BODY) { req.destroy(new Error('response too large')); return; }
          chunks.push(chunk);
        });
        res.on('end', function () {
          try { done(null, parseJson(Buffer.concat(chunks).toString('utf8'))); }
          catch (e) { done(e); }
        });
        res.on('error', function (e) { done(e); });
      });
    } catch (e) { done(e); return; }
    req.setTimeout(timeoutMs, function () { req.destroy(new Error('timeout')); });
    req.on('error', function (e) { done(e); });
  });
}

function requestJson(url, timeoutMs, headers) {
  const merged = Object.assign({ 'User-Agent': DEFAULT_UA, 'Accept': 'application/json' }, headers || {});
  if (electronNet && typeof electronNet.request === 'function') {
    return viaElectron(url, timeoutMs, merged).catch(function (error) {
      /* 主进程未 ready 时 net 会抛错，退回 https 再试一次。 */
      if (/net module can only be used after app is ready/i.test(String(error && error.message))) {
        return viaHttps(url, timeoutMs, merged);
      }
      throw error;
    });
  }
  return viaHttps(url, timeoutMs, merged);
}

module.exports = { requestJson: requestJson };
