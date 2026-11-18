'use strict';

const DEFAULT_ACCELERATORS = {
  toggleVisible: 'Ctrl+Alt+P',
  openSettings: 'Ctrl+Alt+O'
};

function registerHotkeys(ctx) {
  const config = ctx || {};
  const electron = config.electron || {};
  const globalShortcut = electron.globalShortcut;
  const logger = config.logger || null;
  const accelerators = Object.assign({}, DEFAULT_ACCELERATORS, config.accelerators || {});
  const registered = [];
  let disposed = false;

  function log(level, message, error) {
    if (!logger) return;
    try {
      const sink = logger[level] || logger.info;
      if (typeof sink === 'function') sink('[hotkey] ' + message, error);
    } catch (err) {
      return;
    }
  }

  if (!globalShortcut || typeof globalShortcut.register !== 'function') {
    log('warn', 'globalShortcut unavailable, hotkeys disabled');
    return {
      registered: [],
      dispose: () => {},
      isRegistered: () => false
    };
  }

  function register(accelerator, name) {
    if (!accelerator) return false;
    const handler = config[name];
    if (typeof handler !== 'function') {
      log('warn', 'no handler for ' + name + ', skipped');
      return false;
    }
    try {
      const ok = globalShortcut.register(accelerator, () => {
        try {
          handler();
        } catch (err) {
          log('error', name + ' handler threw', err);
        }
      });
      if (ok) {
        registered.push(accelerator);
        log('info', 'registered ' + accelerator + ' -> ' + name);
        return true;
      }
      log('warn', 'register rejected (already taken?): ' + accelerator + ' -> ' + name);
      return false;
    } catch (err) {
      log('warn', 'register threw: ' + accelerator + ' -> ' + name, err);
      return false;
    }
  }

  register(accelerators.toggleVisible, 'toggleVisible');
  register(accelerators.openSettings, 'openSettings');

  function dispose() {
    if (disposed) return;
    disposed = true;
    while (registered.length > 0) {
      const accelerator = registered.pop();
      try {
        globalShortcut.unregister(accelerator);
      } catch (err) {
        log('warn', 'unregister failed: ' + accelerator, err);
      }
    }
  }

  function isRegistered(accelerator) {
    if (registered.indexOf(accelerator) < 0) return false;
    try {
      return typeof globalShortcut.isRegistered === 'function' ? globalShortcut.isRegistered(accelerator) === true : true;
    } catch (err) {
      log('warn', 'isRegistered failed: ' + accelerator, err);
      return false;
    }
  }

  return {
    registered: registered.slice(),
    accelerators: Object.assign({}, accelerators),
    dispose,
    isRegistered
  };
}

module.exports = {
  DEFAULT_ACCELERATORS,
  registerHotkeys
};
