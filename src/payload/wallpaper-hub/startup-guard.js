'use strict';
/* M HUB startup guard: keep the splash window alive until the page signals #done. */
(function () {
  var fs = require('fs');
  var path = require('path');
  var dataDir = path.join(
    process.env.APPDATA || '.',
    'MCHOSEHUB',
    'wallpaper-hub'
  );
  var logFile = path.join(dataDir, 'bootstrap.log');

  function shimLog(kind, error) {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.appendFileSync(
        logFile,
        new Date().toISOString() + ' [' + kind + '] ' +
          (error && error.stack || error) + '\n'
      );
    } catch (_) {}
  }

  try {
    var electron = require('electron');
    var BW = electron.BrowserWindow;
    if (BW && BW.prototype) {
      ['close', 'destroy', 'hide'].forEach(function (m) {
        var orig = BW.prototype[m];
        if (typeof orig !== 'function') return;
        BW.prototype[m] = function () {
          var url = '';
          var title = '';
          try {
            /* 插件主动清理上一次遗留的启动页窗口时直接放行。 */
            if (global.__mhubSplashForceClose === true) return orig.apply(this, arguments);
            /* 仅在自定义启动动画开启时拦截；关闭时完全沿用官方启动页的关闭节奏。 */
            if (global.__mhubSplashAnimation !== true) return orig.apply(this, arguments);
            var wc = this.webContents;
            url = wc && !wc.isDestroyed() ? wc.getURL() : '';
            title = this.getTitle ? String(this.getTitle() || '') : '';
            var finished =
              url.indexOf('#done') !== -1 || title.indexOf('#done') !== -1;
            if (
              url.indexOf('startup-loading.html') !== -1 &&
              !finished
            ) {
              /* 运行时挂载失败时不再拦截，避免空窗口一直盖在主界面上。 */
              if (global.__mhubSplashFailed === true) return orig.apply(this, arguments);
              /* 兜底：最长保护 90 秒，超时后一律放行。 */
              if (!this.__mhubSplashAt) this.__mhubSplashAt = Date.now();
              if (Date.now() - this.__mhubSplashAt > 90000) return orig.apply(this, arguments);
              if (!this.__mhubSplashBlocked) {
                this.__mhubSplashBlocked = true;
                shimLog('splash-hold', m + ' ' + url);
              }
              return;
            }
          } catch (e) {}
          return orig.apply(this, arguments);
        };
      });
    }
  } catch (e) {
    shimLog('splash-patch', e);
  }
})();
