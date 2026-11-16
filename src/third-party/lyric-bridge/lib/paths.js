'use strict';
const os = require('os');
const path = require('path');
const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const ROOT = path.join(APPDATA, 'MCHOSEHUB');
const DATA_DIR = process.env.LYRIC_BRIDGE_STATE_DIR || path.join(ROOT, 'lyric-bridge');
const LOG_FILE = process.env.LYRIC_BRIDGE_LOG_FILE || path.join(ROOT, 'lyric-bridge.log');
module.exports = {
  APPDATA: APPDATA,
  ROOT: ROOT,
  DATA_DIR: DATA_DIR,
  LOG_FILE: LOG_FILE,
  MIRROR_LOG_FILE: path.join(DATA_DIR, 'lyric-bridge.log'),
  CONFIG_FILE: path.join(DATA_DIR, 'config.json'),
  STATUS_FILE: path.join(DATA_DIR, 'status.json'),
  SODA_FILE: path.join(DATA_DIR, 'soda-lyrics.json'),
  LYRICS_DIR: path.join(DATA_DIR, 'lyrics'),
  ICON_DIR: path.join(DATA_DIR, 'cache', 'icons'),
  BACKUP_DIR: path.join(DATA_DIR, '.backup')
};
