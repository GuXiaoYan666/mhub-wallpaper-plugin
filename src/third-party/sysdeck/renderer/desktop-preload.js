'use strict';
// 桌面悬浮窗的预加载：只暴露快照接收与上行通道。
const { contextBridge, ipcRenderer } = require('electron');

try {
  contextBridge.exposeInMainWorld('sysdeckDesktop', {
    onSnapshot: function (fn) {
      ipcRenderer.on('sysdeck:snapshot', function (_e, snap) {
        try { if (typeof fn === 'function') fn(snap); } catch (_) { /* ignore */ }
      });
    },
    send: function (msg) {
      try { ipcRenderer.send('sysdeck:uplink', msg); } catch (_) { /* ignore */ }
    },
    ready: function () {
      try { ipcRenderer.send('sysdeck:ready'); } catch (_) { /* ignore */ }
    }
  });
} catch (_) { /* ignore */ }
