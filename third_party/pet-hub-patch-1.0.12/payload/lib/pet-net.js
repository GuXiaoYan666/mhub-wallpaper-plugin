'use strict';

/* 用 Electron 的 net 模块实现一个最小 fetch 适配层。
   pet-download.js 的 fetch 分支只需要：status / headers.get / body.getReader。
   走 Chromium 网络栈可以自动跟随系统代理与系统证书设置，
   避免部分用户用 Node https 直连时一直报 network。 */

let net = null;
try {
  const electron = require('electron');
  net = electron && electron.net ? electron.net : null;
} catch (e) { net = null; }

function fetchLike(url, options = {}) {
  if (!net || typeof net.request !== 'function') {
    return Promise.reject(new Error('electron net unavailable'));
  }
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = net.request({ method: options.method || 'GET', url: url, redirect: 'follow' });
    } catch (e) { reject(e); return; }
    const headers = options.headers || {};
    Object.keys(headers).forEach(function (key) {
      try { req.setHeader(key, headers[key]); } catch (e) { /* ignore */ }
    });
    const signal = options.signal;
    let aborted = false;
    function abort() {
      aborted = true;
      try { req.abort(); } catch (e) { /* ignore */ }
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    }
    if (signal) {
      if (signal.aborted) { abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
    }
    req.on('response', function (res) {
      const chunks = [];
      let ended = false;
      let failure = null;
      let wake = null;
      function pump() {
        if (!wake) return;
        const fn = wake;
        wake = null;
        fn();
      }
      res.on('data', function (chunk) {
        if (aborted) return;
        chunks.push(Buffer.from(chunk));
        pump();
      });
      res.on('end', function () { ended = true; pump(); });
      res.on('error', function (e) { failure = e; pump(); });
      const reader = {
        read: function () {
          if (failure) return Promise.reject(failure);
          if (chunks.length) return Promise.resolve({ done: false, value: new Uint8Array(chunks.shift()) });
          if (ended) return Promise.resolve({ done: true });
          return new Promise(function (next) { wake = next; });
        },
        cancel: function () {
          try { req.abort(); } catch (e) { /* ignore */ }
          ended = true;
          return Promise.resolve();
        },
        releaseLock: function () { /* no-op */ }
      };
      resolve({
        status: res.statusCode,
        headers: {
          get: function (name) {
            const value = res.headers[String(name).toLowerCase()];
            return Array.isArray(value) ? value[0] : (value === undefined ? null : value);
          }
        },
        body: {
          getReader: function () { return reader; },
          cancel: reader.cancel
        }
      });
    });
    req.on('error', reject);
    try { req.end(); } catch (e) { reject(e); }
  });
}

module.exports = { available: !!(net && typeof net.request === 'function'), fetchLike: fetchLike };
