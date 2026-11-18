'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const DIR_NAME = 'hd-cache';
const MAX_ENTRIES = 3;
const MAX_BYTES = 96 * 1024 * 1024;
// dataUrl 字符串长度上限：主进程解 base64 是同步的，先按长度拒掉超图集，别为它分配几十 MB。
const MAX_DATA_URL_BYTES = 32 * 1024 * 1024;
const PNG_PREFIX = 'data:image/png;base64,';
const SUFFIX = '.png';
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,95}$/;

function isValidKey(key) {
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) return false;
  return key.indexOf('..') < 0;
}

function decodePng(dataUrl) {
  if (typeof dataUrl !== 'string' || dataUrl.slice(0, PNG_PREFIX.length) !== PNG_PREFIX) return null;
  try {
    const bytes = Buffer.from(dataUrl.slice(PNG_PREFIX.length), 'base64');
    return bytes.length ? bytes : null;
  } catch (err) {
    return null;
  }
}

// 高清图集缓存：<userData>/hd-cache/<key>.png，LRU 3 条 + 96MB 上限。
function create(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const userData = typeof opts.userData === 'string' ? opts.userData : '';
  const logger = opts.logger || null;

  function log(level, message, err) {
    if (!logger || typeof logger[level] !== 'function') return;
    try {
      if (err === undefined) logger[level]('[hd-cache] ' + message);
      else logger[level]('[hd-cache] ' + message, err);
    } catch (e) {
      // 日志失败不能影响缓存读写
    }
  }

  function root() {
    return userData ? path.join(userData, DIR_NAME) : '';
  }

  function fileOf(key) {
    const dir = root();
    return dir ? path.join(dir, key + SUFFIX) : '';
  }

  function ensureRoot() {
    const dir = root();
    if (!dir) {
      log('warn', 'userData path unavailable');
      return false;
    }
    try {
      fs.mkdirSync(dir, { recursive: true });
      return true;
    } catch (err) {
      log('warn', 'mkdir failed: ' + dir, err);
      return false;
    }
  }

  // 目录里只有本模块写下的 <key>.png，mtime 即最近使用时间（命中时会刷新）。
  function entries() {
    const dir = root();
    if (!dir) return [];
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (err) {
      return [];
    }
    const list = [];
    for (let i = 0; i < names.length; i += 1) {
      const name = names[i];
      if (!name.endsWith(SUFFIX)) continue;
      const file = path.join(dir, name);
      try {
        const stat = fs.statSync(file);
        if (!stat.isFile()) continue;
        list.push({ file: file, key: name.slice(0, -SUFFIX.length), bytes: stat.size, usedAt: stat.mtimeMs });
      } catch (err) {
        // 并发删除：跳过即可
      }
    }
    list.sort(function (a, b) {
      return a.usedAt - b.usedAt;
    });
    return list;
  }

  // 超限先删最久未用；刚写进去的那一份永远保留。
  function evict(keepFile) {
    const list = entries();
    let total = list.reduce(function (sum, entry) {
      return sum + entry.bytes;
    }, 0);
    const removed = [];
    while (list.length > MAX_ENTRIES || total > MAX_BYTES) {
      let index = -1;
      for (let i = 0; i < list.length; i += 1) {
        if (list[i].file !== keepFile) {
          index = i;
          break;
        }
      }
      if (index < 0) break;
      const victim = list.splice(index, 1)[0];
      try {
        fs.unlinkSync(victim.file);
        total -= victim.bytes;
        removed.push(victim.key);
      } catch (err) {
        log('warn', 'evict failed: ' + victim.key, err);
        break;
      }
    }
    if (total > MAX_BYTES) log('warn', 'hd cache still over byte budget: ' + total);
    if (removed.length) log('info', 'evicted ' + removed.join(','));
    return removed;
  }

  // 统一契约：三处都返回 { ok, ... }；get 命中还带 url/bytes（渲染层读 ack.url，不能改字段名）。
  function get(key) {
    if (!isValidKey(key)) {
      // 坏键必须留痕：静默拒绝曾让"生产侧的键一直不合法"藏了整轮，日志里一条都没有。
      log('warn', 'bad-key rejected: ' + String(key).slice(0, 64));
      return { ok: false, url: null, bytes: 0 };
    }
    const file = fileOf(key);
    if (!file) return { ok: false, url: null, bytes: 0 };
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (err) {
      return { ok: false, url: null, bytes: 0 };
    }
    if (!stat.isFile() || !stat.size) return { ok: false, url: null, bytes: 0 };
    const now = new Date();
    try {
      fs.utimesSync(file, now, now);
    } catch (err) {
      log('warn', 'touch failed: ' + key, err);
    }
    log('info', 'hit ' + key + ' (' + stat.size + ' bytes)');
    return { ok: true, url: pathToFileURL(file).href, bytes: stat.size };
  }

  // 先写临时文件再改名：中途崩溃不会留下半张 PNG 被下次当命中读走；失败把临时文件删掉。
  function writeAtomic(file, bytes) {
    const temp = file + '.tmp';
    return fs.promises.writeFile(temp, bytes).then(
      function () {
        return fs.promises.rename(temp, file).catch(function (err) {
          return fs.promises.unlink(temp).catch(function () { return null; }).then(function () {
            throw err;
          });
        });
      },
      function (err) {
        return fs.promises.unlink(temp).catch(function () { return null; }).then(function () {
          throw err;
        });
      }
    );
  }

  // 异步落盘：主进程不再为一张 24MB 的图集同步阻塞。
  function put(key, dataUrl) {
    if (!isValidKey(key)) {
      log('warn', 'bad-key rejected: ' + String(key).slice(0, 64));
      return Promise.resolve({ ok: false, bytes: 0, reason: 'bad-key' });
    }
    if (typeof dataUrl !== 'string' || dataUrl.length > MAX_DATA_URL_BYTES) {
      log('warn', 'reject ' + key + ': dataUrl over ' + MAX_DATA_URL_BYTES + ' chars');
      return Promise.resolve({ ok: false, bytes: 0, reason: 'too-large' });
    }
    const bytes = decodePng(dataUrl);
    if (!bytes) return Promise.resolve({ ok: false, bytes: 0, reason: 'bad-payload' });
    if (!ensureRoot()) return Promise.resolve({ ok: false, bytes: 0, reason: 'no-dir' });
    const file = fileOf(key);
    return writeAtomic(file, bytes).then(
      function () {
        log('info', 'store ' + key + ' (' + bytes.length + ' bytes)');
        evict(file);
        return { ok: true, bytes: bytes.length };
      },
      function (err) {
        log('warn', 'write failed: ' + key, err);
        return { ok: false, bytes: 0, reason: 'write' };
      }
    );
  }

  function drop(key) {
    if (!isValidKey(key)) {
      log('warn', 'bad-key rejected: ' + String(key).slice(0, 64));
      return { ok: false, reason: 'bad-key' };
    }
    try {
      fs.unlinkSync(fileOf(key));
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err && err.code === 'ENOENT' ? 'missing' : 'unlink' };
    }
  }

  function stats() {
    const list = entries();
    return {
      dir: root(),
      entries: list.length,
      bytes: list.reduce(function (sum, entry) {
        return sum + entry.bytes;
      }, 0),
      keys: list.map(function (entry) {
        return entry.key;
      })
    };
  }

  return { get: get, put: put, drop: drop, stats: stats, evict: evict };
}

module.exports = {
  create: create,
  isValidKey: isValidKey,
  DIR_NAME: DIR_NAME,
  MAX_ENTRIES: MAX_ENTRIES,
  MAX_BYTES: MAX_BYTES,
  MAX_DATA_URL_BYTES: MAX_DATA_URL_BYTES
};
