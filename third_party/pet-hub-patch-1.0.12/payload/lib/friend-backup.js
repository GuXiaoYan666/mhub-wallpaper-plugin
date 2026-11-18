'use strict';

const fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');
const { promisify } = require('util');
const { scanPets, ID_PATTERN } = require('./pets.js');
const { createLibrary, inside, MAX_IMAGE_BYTES } = require('./pet-library.js');
const config = require('./config.js');
const gzip = promisify(zlib.gzip), gunzip = promisify(zlib.gunzip);
const MAX_BACKUP = 256 * 1024 * 1024, MAX_COMPRESSED = 128 * 1024 * 1024;
const FORMAT = 'MCHOSE_FRIEND_BACKUP';
function fail(code) { throw Object.assign(new Error(code), { code }); }
function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function safeName(name) { return typeof name === 'string' && name.length <= 160 && !name.includes('\\') && !name.includes(':') && !name.startsWith('/') && name.split('/').every(part => part && part !== '.' && part !== '..'); }

function createBackupManager(options) {
  const root = path.resolve(options.root);
  let pending = null, busy = false;
  async function exclusive(fn) { if (busy) fail('busy'); busy = true; try { return await fn(); } finally { busy = false; } }
  async function discard() {
    if (pending) { const old = pending; pending = null; if (inside(root, old.stage)) await fs.promises.rm(old.stage, { recursive: true, force: true }); }
  }
  return {
    exportFile(file, settings, version) { return exclusive(async () => {
      const entries = []; let total = 0;
      for (const pet of scanPets(root).pets) {
        const folder = path.join(root, pet.dirName), metaBytes = await fs.promises.readFile(path.join(folder, 'pet.json'));
        if (metaBytes.length > 128 * 1024) fail('too-large');
        const meta = JSON.parse(metaBytes), names = ['pet.json', meta.spritesheet || meta.spritesheetPath || 'spritesheet.webp'];
        if (meta.spritesheetHD) names.push(meta.spritesheetHD.path);
        if (meta.hero) names.push(meta.hero); else if (fs.existsSync(path.join(folder, 'hero.webp'))) names.push('hero.webp');
        const files = {};
        for (const name of new Set(names)) {
          if (!safeName(name)) fail('bad-path');
          const actual = await fs.promises.realpath(path.join(folder, name));
          if (!inside(folder, actual)) fail('bad-path');
          const stat = await fs.promises.stat(actual);
          if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) fail('too-large');
          total += stat.size; if (total > MAX_BACKUP / 1.4) fail('too-large');
          const bytes = await fs.promises.readFile(actual);
          files[name] = { sha256: digest(bytes), data: bytes.toString('base64') };
        }
        entries.push({ id: pet.id, files });
      }
      if (entries.length > 100) fail('too-large');
      const json = Buffer.from(JSON.stringify({ format: FORMAT, version: 1, pluginVersion: version, createdAt: new Date().toISOString(), settings: config.cleanSettings(settings), entries }));
      if (json.length > MAX_BACKUP) fail('too-large');
      const bytes = await gzip(json);
      if (bytes.length > MAX_COMPRESSED) fail('too-large');
      const temp = file + '.' + crypto.randomBytes(5).toString('hex') + '.tmp';
      try { await fs.promises.writeFile(temp, bytes, { flag: 'wx' }); await fs.promises.rename(temp, file); }
      finally { await fs.promises.unlink(temp).catch(() => {}); }
      return { count: entries.length, bytes: bytes.length };
    }); },
    prepare(file, context) { return exclusive(async () => {
      const check = () => { if (context && context.signal && context.signal.aborted) fail('cancelled'); };
      check();
      await discard();
      const stat = await fs.promises.stat(file); if (!stat.isFile() || stat.size > MAX_COMPRESSED) fail('too-large');
      let data; try { data = JSON.parse(await gunzip(await fs.promises.readFile(file), { maxOutputLength: MAX_BACKUP })); } catch (_) { fail('bad-backup'); }
      check();
      if (!data || data.format !== FORMAT || data.version !== 1 || !Array.isArray(data.entries) || data.entries.length > 100 || !data.settings || typeof data.settings !== 'object' || Array.isArray(data.settings)) fail('bad-backup');
      await fs.promises.mkdir(root, { recursive: true });
      const stage = await fs.promises.mkdtemp(path.join(root, '.restore-'));
      try {
        const validated = path.join(stage, 'validated'), incoming = path.join(stage, 'incoming');
        const lib = createLibrary({ root: validated, validateImage: options.validateImage });
        const ids = new Set();
        for (const entry of data.entries) {
          check();
          if (!entry || !ID_PATTERN.test(entry.id) || ids.has(entry.id) || !entry.files || typeof entry.files !== 'object' || Object.keys(entry.files).length > 8) fail('bad-backup');
          ids.add(entry.id); const folder = path.join(incoming, entry.id);
          for (const [name, asset] of Object.entries(entry.files)) {
            if (!safeName(name) || !asset || typeof asset.data !== 'string' || asset.data.length > MAX_IMAGE_BYTES * 1.4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(asset.data)) fail('bad-backup');
            const bytes = Buffer.from(asset.data, 'base64');
            if (bytes.length > MAX_IMAGE_BYTES || digest(bytes) !== asset.sha256) fail('bad-backup');
            const target = path.join(folder, name); await fs.promises.mkdir(path.dirname(target), { recursive: true }); await fs.promises.writeFile(target, bytes, { flag: 'wx' });
          }
          const meta = JSON.parse(await fs.promises.readFile(path.join(folder, 'pet.json'), 'utf8'));
          if (meta.id !== entry.id) fail('bad-backup');
          await lib.importFolder(folder, context);
        }
        const current = scanPets(root).pets, present = new Set(current.map(pet => pet.id));
        const token = crypto.randomBytes(12).toString('hex');
        check();
        pending = { token, stage, validated, ids: Array.from(ids), settings: config.cleanSettings(data.settings) };
        return { token, count: ids.size, added: Array.from(ids).filter(id => !present.has(id) && !fs.existsSync(path.join(root, id))).length, kept: Array.from(ids).filter(id => present.has(id) || fs.existsSync(path.join(root, id))).length };
      } catch (error) { await fs.promises.rm(stage, { recursive: true, force: true }); throw error; }
    }); },
    commit(token, applySettings) { return exclusive(async () => {
      if (!pending || token !== pending.token) fail('bad-backup');
      const item = pending, moved = [], existing = new Set(scanPets(root).pets.map(pet => pet.id));
      try {
        for (const id of item.ids) {
          if (existing.has(id) || fs.existsSync(path.join(root, id))) continue;
          await fs.promises.rename(path.join(item.validated, id), path.join(root, id)); moved.push(id);
        }
        await applySettings(item.settings);
      } catch (error) {
        for (const id of moved.reverse()) await fs.promises.rename(path.join(root, id), path.join(item.validated, id));
        throw error;
      }
      await discard(); return { added: moved.length, kept: item.ids.length - moved.length };
    }); },
    discard: () => exclusive(discard)
  };
}
module.exports = { createBackupManager, FORMAT, MAX_BACKUP, safeName };
