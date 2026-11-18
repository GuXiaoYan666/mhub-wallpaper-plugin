'use strict';

const sourceModule = require('./device-source.js');
const eventsModule = require('./device-events.js');

// 能力分级（docs/P0-CONTRACT.md 第 10/12 节）：A 可写入并确认 / B 可回读订阅 /
// C 只可发送无法确认 / D 不支持。B 表示接收驱动已有广播，不代表打开或轮询硬件。
// 具体板载、电量、连接数据以驱动实际提供的字段为准；灯光/EQ 保留文件回读兜底。
const CAPABILITIES = Object.freeze({
  keyboard: Object.freeze({ profile: 'B', dpi: 'D', rgb: 'A', battery: 'B', connection: 'B' }),
  mouse: Object.freeze({ profile: 'B', dpi: 'B', rgb: 'A', battery: 'B', connection: 'B' }),
  headset: Object.freeze({ eq: 'A', mic: 'B', volume: 'B', battery: 'B', connection: 'B' }),
  speaker: Object.freeze({ eq: 'A', volume: 'B', battery: 'B', connection: 'B' })
});

function getCapabilities() {
  return {
    keyboard: Object.assign({}, CAPABILITIES.keyboard),
    mouse: Object.assign({}, CAPABILITIES.mouse),
    headset: Object.assign({}, CAPABILITIES.headset),
    speaker: Object.assign({}, CAPABILITIES.speaker)
  };
}

function normaliseLog(log) {
  const sink = log || {};
  const pick = (level) => (typeof sink[level] === 'function' ? sink[level].bind(sink) : () => {});
  return { debug: pick('debug'), info: pick('info'), warn: pick('warn'), error: pick('error') };
}

function createDeviceBridge(deps) {
  const opts = deps || {};
  const app = opts.app || null;
  const send = typeof opts.send === 'function' ? opts.send : () => false;
  const getSettings = typeof opts.getSettings === 'function' ? opts.getSettings : () => ({});
  const log = normaliseLog(opts.log);
  let source = null;
  let adapter = null;
  let running = false;
  let dir = null;

  function start() {
    if (running) return false;
    dir = sourceModule.resolveConfigDir(app);
    adapter = eventsModule.createAdapter({ getSettings: getSettings, send: send, log: opts.log });
    source = sourceModule.createConfigSource({
      dir: dir,
      log: opts.log,
      onChange: (changes) => adapter.ingest(changes)
    });
    running = true;
    try {
      source.start();
    } catch (err) {
      log.warn('device source start failed', err);
    }
    log.info('device bridge started, config dir=' + String(dir || '(none)'));
    return true;
  }

  function stop() {
    if (!running) return false;
    running = false;
    if (source) {
      try {
        source.stop();
      } catch (err) {
        log.warn('device source stop failed', err);
      }
      source = null;
    }
    if (adapter) {
      try {
        adapter.dispose();
      } catch (err) {
        log.warn('device adapter dispose failed', err);
      }
      adapter = null;
    }
    log.info('device bridge stopped');
    return true;
  }

  function ingestEvent(payload) {
    if (!adapter) {
      log.warn('device event dropped: bridge not started');
      return null;
    }
    return adapter.ingestEvent(payload);
  }

  function ingestHostState(payload) {
    return adapter ? adapter.ingestHostState(payload) : 0;
  }

  function state() {
    return {
      running: running,
      dir: dir,
      source: source ? source.state() : null,
      host: adapter ? adapter.hostState() : null,
      pending: adapter ? adapter.pendingCount() : 0,
      delivered: adapter ? adapter.deliverCount() : 0,
      notifications: adapter ? adapter.diagnostics() : null,
      timers: adapter ? adapter.timerCount() : 0
    };
  }

  return {
    start: start,
    stop: stop,
    getCapabilities: getCapabilities,
    ingestEvent: ingestEvent,
    ingestHostState: ingestHostState,
    ingestHostMode: payload => adapter ? adapter.ingestHostMode(payload) : false,
    // 诊断用：验收脚本据此确认 stop() 后计时器清零（不入 GET_STATE）。
    state: state
  };
}

module.exports = {
  CAPABILITIES,
  getCapabilities,
  createDeviceBridge
};
