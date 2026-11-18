'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const DEFAULT_SPRITESHEET = 'spritesheet.webp';
const DEFAULT_HERO = 'hero.webp';
const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

function defaultPetsDir() {
  return path.join(__dirname, '..', 'pets');
}

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch (err) {
    return false;
  }
}

// D18：宠物包的 spritesheet 字段有两个写法，`spritesheet` 优先，`spritesheetPath` 作别名兜底。
function sheetNameFor(meta) {
  if (typeof meta.spritesheet === 'string' && meta.spritesheet.trim()) return meta.spritesheet.trim();
  if (typeof meta.spritesheetPath === 'string' && meta.spritesheetPath.trim()) return meta.spritesheetPath.trim();
  return DEFAULT_SPRITESHEET;
}

function isInsideDir(dirPath, name) {
  const root = path.resolve(dirPath);
  const resolved = path.resolve(root, name);
  const relative = path.relative(root, resolved);
  if (!relative || path.isAbsolute(relative)) return false;
  return relative.split(/[\\/]/)[0] !== '..';
}

function resolveHeroUrl(petDir, declared, id, log) {
  const name = typeof declared === 'string' && declared.trim() ? declared.trim() : DEFAULT_HERO;
  const root = path.resolve(petDir);
  const resolved = path.resolve(root, name);
  const relative = path.relative(root, resolved);
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/)[0] === '..') {
    log('debug', 'hero for ' + id + ' is outside pet dir: ' + name);
    return null;
  }
  if (!isFile(resolved)) {
    log('debug', 'hero for ' + id + ' missing: ' + name);
    return null;
  }
  return pathToFileURL(resolved).href;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return null;
  }
}

function scanPets(dirPath, options) {
  const opts = options || {};
  const logger = opts.logger || null;
  const root = typeof dirPath === 'string' && dirPath ? dirPath : defaultPetsDir();
  const pets = [];
  const skipped = [];
  const seen = Object.create(null);

  function log(level, message) {
    if (!logger) return;
    try {
      const sink = logger[level] || logger.info;
      if (typeof sink === 'function') sink('[pets] ' + message);
    } catch (err) {
      return;
    }
  }

  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    log('warn', 'pets directory unreadable: ' + root);
    return { root, pets, skipped };
  }

  const dirs = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name).sort();

  for (let index = 0; index < dirs.length; index += 1) {
    const dirName = dirs[index];
    const jsonPath = path.join(root, dirName, 'pet.json');
    if (!isFile(jsonPath)) {
      skipped.push({ id: dirName, reason: 'missing pet.json' });
      log('warn', 'skip ' + dirName + ': missing pet.json');
      continue;
    }
    const meta = readJson(jsonPath);
    if (!meta || typeof meta !== 'object') {
      skipped.push({ id: dirName, reason: 'invalid pet.json' });
      log('warn', 'skip ' + dirName + ': invalid pet.json');
      continue;
    }
    const declared = typeof meta.id === 'string' ? meta.id.trim() : '';
    const id = ID_PATTERN.test(declared) ? declared : dirName;
    if (!ID_PATTERN.test(id)) {
      skipped.push({ id: dirName, reason: 'invalid id' });
      log('warn', 'skip ' + dirName + ': invalid id');
      continue;
    }
    if (seen[id]) {
      skipped.push({ id, reason: 'duplicate id' });
      log('warn', 'skip ' + dirName + ': duplicate id ' + id);
      continue;
    }
    const sheetName = sheetNameFor(meta);
    const petDir = path.join(root, dirName);
    const atlasPath = path.join(petDir, sheetName);
    if (!isInsideDir(petDir, sheetName) || !isFile(atlasPath)) {
      skipped.push({ id, reason: 'missing spritesheet' });
      log('warn', 'skip ' + id + ': missing ' + sheetName);
      continue;
    }
    let preferred = atlasPath;
    const high = meta.spritesheetHD;
    if (high && [2, 4].includes(high.scale) && typeof high.path === 'string' && isInsideDir(petDir, high.path)) {
      const candidate = path.join(petDir, high.path);
      try {
        const actual = fs.realpathSync(candidate);
        if (isInsideDir(petDir, path.relative(petDir, actual)) && fs.statSync(actual).size <= 32 * 1024 * 1024) {
          const file = fs.openSync(actual, 'r'), header = Buffer.alloc(65536);
          let read; try { read = fs.readSync(file, header, 0, header.length, 0); } finally { fs.closeSync(file); }
          const size = require('./image-size.js').imageSize(header.subarray(0, read));
          // WebP RIFF length can exceed the header probe: use declared scale as
          // the safe candidate; the decoder still verifies it before rendering.
          if ((size && size.width === 1536 * high.scale && size.height === 1872 * high.scale) || (header.toString('ascii', 8, 12) === 'WEBP')) preferred = actual;
        }
      } catch (_) {}
    }
    const displayName = typeof meta.displayName === 'string' && meta.displayName.trim() ? meta.displayName.trim() : id;
    const heroUrl = resolveHeroUrl(path.join(root, dirName), meta.hero, id, log);
    seen[id] = true;
    pets.push({
      id,
      displayName,
      atlasPath: preferred,
      atlasUrl: pathToFileURL(preferred).href,
      fallbackAtlasUrl: preferred !== atlasPath ? pathToFileURL(atlasPath).href : null,
      heroUrl,
      dirName
    });
  }

  return { root, pets, skipped };
}

module.exports = {
  DEFAULT_SPRITESHEET,
  DEFAULT_HERO,
  ID_PATTERN,
  defaultPetsDir,
  scanPets
};
