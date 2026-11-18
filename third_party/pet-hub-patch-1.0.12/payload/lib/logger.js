'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_BYTES = 1024 * 1024;
const BUFFER_LIMIT = 200;
const DEBUG_FLUSH_MS = 250;
const LEVELS = ['debug', 'info', 'warn', 'error'];

// 目录只 mkdir 一次：每条日志都 statSync+mkdirSync 是热路径上的多余系统调用（A17）。
const readyDirs = new Set();
// 进程退出时统一把这些 logger 的缓冲刷出去，监听器本身只注册一次。
const liveFlushers = new Set();
let exitHooked = false;

function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  process.on('exit', function () {
    liveFlushers.forEach(function (flusher) {
      try {
        flusher();
      } catch (err) {
        return;
      }
    });
  });
}

function isFunction(value) {
  return typeof value === 'function';
}

function safeString(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Error) {
    const head = value.name && value.message ? value.name + ': ' + value.message : String(value.message || value.name || 'Error');
    const stack = typeof value.stack === 'string' ? value.stack : '';
    const frames = stack.split('\n').slice(1, 4).join(' | ');
    return frames ? head + ' :: ' + frames : head;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  try {
    return JSON.stringify(value);
  } catch (err) {
    return String(value);
  }
}

function formatLine(level, tag, args) {
  const parts = [];
  for (let index = 0; index < args.length; index += 1) {
    const text = safeString(args[index]);
    if (text) parts.push(text);
  }
  const stamp = new Date().toISOString();
  return '[' + stamp + '] [' + level + '] [' + tag + '] ' + parts.join(' ') + '\n';
}

function defaultFilePath(electron) {
  let dir = process.cwd();
  try {
    if (electron && electron.app && isFunction(electron.app.getPath)) {
      dir = electron.app.getPath('userData') || dir;
    }
  } catch (err) {
    dir = process.cwd();
  }
  return path.join(dir, 'pet-hub.log');
}

function rotatePath(filePath) {
  const rotated = filePath.replace(/\.log$/i, '.old.log');
  return rotated === filePath ? filePath + '.old.log' : rotated;
}

function createLogger(options) {
  const opts = options || {};
  const tag = typeof opts.tag === 'string' && opts.tag ? opts.tag : 'pet-hub';
  const maxBytes = Number.isFinite(opts.maxBytes) && opts.maxBytes > 0 ? opts.maxBytes : DEFAULT_MAX_BYTES;
  const toConsole = opts.console === false ? false : true;
  const debugEnabled = opts.debug === true || process.env.PET_HUB_DEBUG === '1';
  const buffer = [];
  let filePath = typeof opts.filePath === 'string' && opts.filePath ? opts.filePath : null;
  let fileSize = null;
  // debug 环形缓冲：满了覆盖最旧一条，攒够一批或 250ms 到点再落盘。
  const ring = new Array(BUFFER_LIMIT);
  let ringHead = 0;
  let ringSize = 0;
  let ringDropped = 0;
  let flushTimer = null;

  function logInternal(message) {
    try {
      console.warn('[logger] ' + message);
    } catch (err) {
      return;
    }
  }

  function ensureSize() {
    if (fileSize !== null) return;
    try {
      fileSize = fs.statSync(filePath).size;
    } catch (err) {
      fileSize = 0;
    }
  }

  function rotate() {
    const rotated = rotatePath(filePath);
    try {
      if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
    } catch (err) {
      logInternal('rotate cleanup failed: ' + safeString(err));
    }
    try {
      fs.renameSync(filePath, rotated);
    } catch (err) {
      logInternal('rotate rename failed: ' + safeString(err));
    }
    fileSize = 0;
  }

  function append(line) {
    if (!filePath) return;
    try {
      const bytes = Buffer.byteLength(line, 'utf8');
      ensureSize();
      if (fileSize + bytes > maxBytes) rotate();
      const dir = path.dirname(filePath);
      if (!readyDirs.has(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        readyDirs.add(dir);
      }
      fs.appendFileSync(filePath, line, 'utf8');
      fileSize += bytes;
    } catch (err) {
      readyDirs.delete(path.dirname(filePath));
      fileSize = null;
      logInternal('append failed: ' + safeString(err));
    }
  }

  function ringPush(line) {
    if (ringSize < BUFFER_LIMIT) {
      ring[(ringHead + ringSize) % BUFFER_LIMIT] = line;
      ringSize += 1;
      return;
    }
    ring[ringHead] = line;
    ringHead = (ringHead + 1) % BUFFER_LIMIT;
    ringDropped += 1;
  }

  function ringTake() {
    if (ringSize === 0) return [];
    const out = new Array(ringSize);
    for (let index = 0; index < ringSize; index += 1) out[index] = ring[(ringHead + index) % BUFFER_LIMIT];
    ring.fill(undefined);
    ringHead = 0;
    ringSize = 0;
    return out;
  }

  function scheduleFlush() {
    if (flushTimer !== null) return;
    flushTimer = setTimeout(function () {
      flushTimer = null;
      drainDebug();
    }, DEBUG_FLUSH_MS);
    if (flushTimer && isFunction(flushTimer.unref)) flushTimer.unref();
  }

  function clearFlushTimer() {
    if (flushTimer === null) return;
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  function drainDebug() {
    const pending = ringTake();
    clearFlushTimer();
    if (ringDropped > 0) {
      const dropped = ringDropped;
      ringDropped = 0;
      pending.unshift(formatLine('warn', tag, ['dropped ' + dropped + ' debug lines: ring buffer full']));
    }
    for (let index = 0; index < pending.length; index += 1) append(pending[index]);
  }

  function drain() {
    if (!filePath || buffer.length === 0) return;
    const pending = buffer.splice(0, buffer.length);
    for (let index = 0; index < pending.length; index += 1) append(pending[index]);
  }

  function emit(level, args) {
    const line = formatLine(level, tag, args);
    if (toConsole) {
      try {
        const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
        sink(line.replace(/\n$/, ''));
      } catch (err) {
        logInternal('console write failed');
      }
    }
    if (!filePath) {
      if (buffer.length < BUFFER_LIMIT) buffer.push(line);
      return;
    }
    if (level === 'debug') {
      ringPush(line);
      scheduleFlush();
      return;
    }
    // info/warn/error 同步落盘；先把排队中的 debug 冲掉，避免文件里时序颠倒。
    drainDebug();
    append(line);
  }

  const logger = {
    tag,
    debug: function () {
      if (debugEnabled) emit('debug', arguments);
    },
    info: function () {
      emit('info', arguments);
    },
    warn: function () {
      emit('warn', arguments);
    },
    error: function () {
      emit('error', arguments);
    },
    getFilePath: function () {
      return filePath;
    },
    attach: function (nextPath) {
      if (typeof nextPath !== 'string' || !nextPath) return filePath;
      filePath = nextPath;
      fileSize = null;
      drain();
      drainDebug();
      return filePath;
    },
    flush: function () {
      drainDebug();
      drain();
      return filePath;
    },
    child: function (childTag) {
      const suffix = typeof childTag === 'string' && childTag ? childTag : 'child';
      return createLogger({
        tag: tag + ':' + suffix,
        filePath: filePath,
        maxBytes,
        console: toConsole,
        debug: debugEnabled
      });
    },
    levels: LEVELS.slice()
  };

  liveFlushers.add(logger.flush);
  hookExit();
  return logger;
}

module.exports = {
  DEFAULT_MAX_BYTES,
  LEVELS,
  createLogger,
  defaultFilePath,
  rotatePath,
  safeString
};
