'use strict';

const https = require('https');
const REDIRECTS = [301, 302, 303, 307, 308];
function error(code, url, status) {
  return Object.assign(new Error('pet download: ' + code + ' ' + url + (status ? ' HTTP ' + status : '')), { code, status });
}
function checked(url) {
  let address;
  try { address = new URL(url); } catch (_) { throw error('bad-source', String(url)); }
  if (address.protocol !== 'https:' || address.username || address.password) throw error('bad-source', address.href);
  return address;
}
function statusError(status, url) {
  return error(status === 404 ? 'pet-not-found' : status === 429 ? 'rate-limit' : status >= 500 ? 'source-unavailable' : 'network', url, status);
}
function createDownloader(options = {}) {
  const fetch = options.fetch;
  const idleMs = options.idleMs || 30000, totalMs = options.totalMs || 60000;
  async function once(url, limit, signal, progress) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal && signal.aborted) throw error('cancelled', url);
    if (signal) signal.addEventListener('abort', abort, { once: true });
    let idle, timedOut = false, request;
    const timeout = () => { timedOut = true; controller.abort(); if (request) request.destroy(error('timeout', url)); };
    const touch = () => { clearTimeout(idle); idle = setTimeout(timeout, idleMs); };
    const total = setTimeout(timeout, totalMs);
    touch();
    try {
      let address = checked(url);
      for (let redirects = 0; redirects <= 4; redirects++) {
        if (fetch) {
          const res = await fetch(address.href, { method: 'GET', redirect: 'manual', signal: controller.signal, headers: { Accept: '*/*', 'User-Agent': 'MCHOSE-Pet-Hub' } });
          touch();
          if (REDIRECTS.includes(res.status)) {
            const location = res.headers.get('location');
            if (res.body) await res.body.cancel();
            if (!location) throw error('bad-source', address.href);
            address = checked(new URL(location, address).href); continue;
          }
          if (res.status !== 200) { if (res.body) await res.body.cancel(); throw statusError(res.status, address.href); }
          const chunks = []; let bytes = 0;
          if (!res.body) throw error('network', address.href);
          const reader = res.body.getReader();
          try {
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) break;
              touch(); bytes += chunk.value.byteLength;
              if (progress) progress(bytes, Number(res.headers.get('content-length')) || 0);
              if (bytes > limit) throw error('too-large', address.href);
              chunks.push(Buffer.from(chunk.value));
            }
          } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
          return Buffer.concat(chunks);
        }
        const result = await new Promise((resolve, reject) => {
          request = https.get(address, { headers: { Accept: '*/*', 'User-Agent': 'MCHOSE-Pet-Hub' }, signal: controller.signal }, res => {
            touch();
            if (REDIRECTS.includes(res.statusCode)) { res.resume(); return resolve({ location: res.headers.location }); }
            if (res.statusCode !== 200) { res.resume(); return reject(statusError(res.statusCode, address.href)); }
            const chunks = []; let bytes = 0;
            res.on('data', chunk => { touch(); bytes += chunk.length; if (progress) progress(bytes, Number(res.headers['content-length']) || 0); if (bytes > limit) res.destroy(error('too-large', address.href)); else chunks.push(chunk); });
            res.on('end', () => resolve({ bytes: Buffer.concat(chunks) }));
            res.on('error', reject);
          });
          request.on('error', reject);
        });
        if (result.bytes) return result.bytes;
        if (!result.location) throw error('bad-source', address.href);
        address = checked(new URL(result.location, address).href);
      }
      throw error('bad-source', url);
    } catch (cause) {
      if (signal && signal.aborted) throw error('cancelled', url);
      if (timedOut) throw error('timeout', url);
      if (['bad-source', 'too-large', 'pet-not-found', 'rate-limit', 'source-unavailable', 'network'].includes(cause.code)) throw cause;
      throw Object.assign(error('network', url), { cause });
    } finally { clearTimeout(idle); clearTimeout(total); if (signal) signal.removeEventListener('abort', abort); }
  }
  return async function download(url, limit, context = {}) {
    for (let attempt = 0; ; attempt++) {
      try { return await once(url, limit, context.signal, context.onProgress); }
      catch (cause) {
        if (attempt >= 1 || !['timeout', 'network', 'rate-limit', 'source-unavailable'].includes(cause.code) || (cause.status && cause.status < 500 && cause.status !== 429)) throw cause;
        await new Promise((resolve, reject) => {
          const done = () => { if (context.signal) context.signal.removeEventListener('abort', cancel); resolve(); };
          const timer = setTimeout(done, options.retryMs ?? 900);
          const cancel = () => { clearTimeout(timer); context.signal.removeEventListener('abort', cancel); reject(error('cancelled', url)); };
          if (context.signal) { context.signal.addEventListener('abort', cancel, { once: true }); if (context.signal.aborted) cancel(); }
        });
      }
    }
  };
}
module.exports = { createDownloader, download: createDownloader() };
