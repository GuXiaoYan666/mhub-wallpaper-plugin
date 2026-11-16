'use strict';
// 统一路径解析 —— 除安装目录外不得出现硬编码盘符。
// 允许测试用环境变量隔离：SYSDECK_STATE_DIR / SYSDECK_LOG_FILE。

const os = require('os');
const path = require('path');

const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const ROOT = path.join(APPDATA, 'MCHOSEHUB');
const DATA_DIR = process.env.SYSDECK_STATE_DIR || path.join(ROOT, 'sysdeck');
const LOG_FILE = process.env.SYSDECK_LOG_FILE || path.join(ROOT, 'sysdeck.log');

module.exports = {
  APPDATA: APPDATA,
  ROOT: ROOT,
  DATA_DIR: DATA_DIR,
  LOG_FILE: LOG_FILE,
  MIRROR_LOG_FILE: path.join(DATA_DIR, 'sysdeck.log'),
  CONFIG_FILE: path.join(DATA_DIR, 'config.json'),
  STATUS_FILE: path.join(DATA_DIR, 'status.json'),
  WEATHER_CACHE_FILE: path.join(DATA_DIR, 'weather.json')
};
