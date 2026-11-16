'use strict';
/* M HUB wallpaper independent bootstrap: load the plugins before the untouched official archive.
   入口路径遵循官方 app 目录结构（resources\app\out\main\index.js），
   这样其他 M HUB 插件仍能识别该安装。 */
(function () {
  const path = require('path');
  const fs = require('fs');
  const os = require('os');
  const originalAsar = path.join(
    process.resourcesPath,
    'app.mhub-wallpaper-original.asar'
  );
  /* 目录版安装没有 app.asar，安装器会把官方入口保存为 index.official.js。 */
  const officialEntry = path.join(__dirname, 'index.official.js');
  const original = fs.existsSync(originalAsar) ? originalAsar : officialEntry;

  const dataDir = path.join(
    process.env.APPDATA || os.homedir(),
    'MCHOSEHUB',
    'wallpaper-hub'
  );
  const logFile = path.join(dataDir, 'bootstrap.log');

  function log(kind, message) {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      try {
        if (fs.statSync(logFile).size > 256 * 1024) {
          fs.renameSync(logFile, logFile + '.1');
        }
      } catch (_) {}
      fs.appendFileSync(
        logFile,
        new Date().toISOString() + ' [' + kind + '] ' + message + '\n'
      );
    } catch (_) {}
  }

  log(
    'boot',
    JSON.stringify({
      resources: process.resourcesPath,
      appPath: process.execPath,
      original: original,
      originalExists: fs.existsSync(original)
    })
  );

  try {
    const electron = require('electron');
    if (electron.app && typeof electron.app.setAppPath === 'function') {
      electron.app.setAppPath(original);
    }
  } catch (error) {
    log('electron', error && error.stack || error);
  }

  /* 加载顺序：启动页保护/壁纸 → 歌词 → 仪表板 → 官方宿主。 */
  const plugins = [
    ['plugin', '../../pet-hub/index.js'],
    ['lyric', '../../lyric-bridge/index.js'],
    ['sysdeck', '../../sysdeck/index.js']
  ];
  for (const item of plugins) {
    try {
      require(item[1]);
      log(item[0] + '-ok', 'loaded');
    } catch (error) {
      log(item[0], error && error.stack || error);
    }
  }

  try {
    require(original);
    log('host-ok', 'host archive loaded');
  } catch (error) {
    log('host', error && error.stack || error);
    throw error;
  }
})();
