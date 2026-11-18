'use strict';

const ROOT_ID = 'pet-hub-tray';
const SUB_IDS = {
  toggle: ROOT_ID + '-toggle',
  settings: ROOT_ID + '-settings',
  reset: ROOT_ID + '-reset'
};

let current = null;

function installTrayHook(ctx) {
  const config = ctx || {};
  const electron = config.electron || {};
  const Tray = electron.Tray;
  const Menu = electron.Menu;
  const MenuItem = electron.MenuItem;
  const logger = config.logger || null;

  function log(level, message, error) {
    if (!logger) return;
    try {
      const sink = logger[level] || logger.info;
      if (typeof sink === 'function') sink('[tray] ' + message, error);
    } catch (err) {
      return;
    }
  }

  function call(name, fallback) {
    const fn = config[name];
    if (typeof fn !== 'function') return fallback;
    try {
      return fn();
    } catch (err) {
      log('warn', name + ' callback threw', err);
      return fallback;
    }
  }

  if (current && current.installed) return current;

  const canWrap = !!Tray && !!Tray.prototype && typeof Tray.prototype.setContextMenu === 'function' && !!Menu && typeof Menu.buildFromTemplate === 'function';
  if (!canWrap) {
    log('warn', 'Tray/Menu unavailable, tray integration disabled');
    const disabled = {
      installed: false,
      dispose: () => {},
      refresh: () => {},
      buildRootItem: () => null
    };
    return disabled;
  }

  const originalBuild = Menu.buildFromTemplate;
  const originalSet = Tray.prototype.setContextMenu;
  const templates = new WeakMap();
  let lastTray = null;
  let lastMenu = null;
  let disposed = false;

  function buildSubmenuTemplate() {
    const visible = call('getVisible', false) === true;
    return [
      { id: SUB_IDS.toggle, label: visible ? '隐藏 Friend' : '显示 Friend', click: () => { call('toggleVisible', null); } },
      { id: SUB_IDS.settings, label: 'Friend 设置', click: () => { call('openSettings', null); } },
      { type: 'separator' },
      { id: SUB_IDS.reset, label: '重置位置', click: () => { call('resetPosition', null); } }
    ];
  }

  function buildRootItem() {
    return { id: ROOT_ID, label: 'Friend', submenu: buildSubmenuTemplate() };
  }

  function decorate(template) {
    const items = Array.isArray(template) ? template : [];
    const rest = items.filter((item) => !(item && item.id === ROOT_ID));
    return [buildRootItem(), { type: 'separator' }].concat(rest);
  }

  function buildTracked(template) {
    const menu = originalBuild.call(Menu, template);
    try {
      if (menu && Array.isArray(template)) templates.set(menu, template);
    } catch (err) {
      log('debug', 'template tracking failed', err);
    }
    return menu;
  }

  function wrappedBuild(template) {
    return buildTracked(template);
  }

  function setContextMenu(menu) {
    lastTray = this;
    lastMenu = menu;
    try {
      const template = menu ? templates.get(menu) : null;
      if (template) {
        const next = wrappedBuild(decorate(template));
        return originalSet.call(this, next);
      }
      if (menu && Array.isArray(menu.items) && typeof MenuItem === 'function') {
        const first = menu.items[0];
        if (first && first.id === ROOT_ID) return originalSet.call(this, menu);
        if (typeof menu.insert === 'function') {
          menu.insert(0, new MenuItem(buildRootItem()));
          return originalSet.call(this, menu);
        }
      }
      return originalSet.call(this, menu);
    } catch (err) {
      log('warn', 'decorate context menu failed, falling back to host menu', err);
      try {
        return originalSet.call(this, menu);
      } catch (innerErr) {
        log('error', 'setContextMenu failed', innerErr);
        return undefined;
      }
    }
  }

  function refresh() {
    if (disposed || !lastTray || !lastMenu) return;
    try {
      setContextMenu.call(lastTray, lastMenu);
    } catch (err) {
      log('warn', 'refresh tray menu failed', err);
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    try {
      if (Menu.buildFromTemplate === wrappedBuild) Menu.buildFromTemplate = originalBuild;
    } catch (err) {
      log('warn', 'restore Menu.buildFromTemplate failed', err);
    }
    try {
      if (Tray.prototype.setContextMenu === setContextMenu) Tray.prototype.setContextMenu = originalSet;
    } catch (err) {
      log('warn', 'restore Tray.prototype.setContextMenu failed', err);
    }
    lastTray = null;
    lastMenu = null;
    current = null;
  }

  Menu.buildFromTemplate = wrappedBuild;
  Tray.prototype.setContextMenu = setContextMenu;
  Object.defineProperty(setContextMenu, 'petHubInstalled', { value: true, enumerable: false });

  current = {
    installed: true,
    ROOT_ID,
    SUB_IDS,
    buildRootItem,
    decorate,
    dispose,
    refresh
  };
  log('info', 'tray context menu hook installed');
  return current;
}

module.exports = {
  ROOT_ID,
  SUB_IDS,
  installTrayHook
};
