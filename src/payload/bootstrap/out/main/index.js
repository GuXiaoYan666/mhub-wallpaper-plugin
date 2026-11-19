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
  const lockFile = path.join(dataDir, 'stack.lock');
  const LOCK_TTL = 60000;

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

  function readLock() {
    try {
      return JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    } catch (_) {
      return null;
    }
  }

  function writeLock() {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(
        lockFile,
        JSON.stringify({ pid: process.pid, exe: process.execPath, at: Date.now() })
      );
    } catch (_) {}
  }

  function alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return !!(error && error.code === 'EPERM');
    }
  }

  /* 同一时间只允许一套插件组件运行，避免重复启动。 */
  function acquire() {
    const owner = readLock();
    if (
      owner && owner.pid && owner.pid !== process.pid && alive(owner.pid) &&
      typeof owner.at === 'number' && Date.now() - owner.at < LOCK_TTL
    ) {
      return false;
    }
    writeLock();
    const timer = setInterval(writeLock, 15000);
    if (timer.unref) timer.unref();
    process.on('exit', function () {
      try {
        const current = readLock();
        if (current && current.pid === process.pid) fs.unlinkSync(lockFile);
      } catch (_) {}
    });
    return true;
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

  /* 加载顺序：启动页保护/壁纸 → 完整桌宠 → 歌词 → sysdeck → 官方宿主。 */
  if (acquire()) {
    const plugins = [
      ['wallpaper', '../../wallpaper-hub/index.js'],
      ['pet', '../../pet-hub/index.js'],
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
  } else {
    log('stack', 'another host owns the wallpaper stack, skip plugins');
  }

  try {
    require(original);
    log('host-ok', 'host archive loaded');
  } catch (error) {
    log('host', error && error.stack || error);
    throw error;
  }
})();
