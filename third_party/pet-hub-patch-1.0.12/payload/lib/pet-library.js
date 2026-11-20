'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ID_PATTERN } = require('./pets.js');
const { parseNpxCommand } = require('../renderer/settings/pets-manage.js');
const { resolveSource } = require('./pet-sources.js');
const petDownload = require('./pet-download.js');
const petNet = require('./pet-net.js');
const { downloadWithCurl } = require('./pet-curl.js');
/* 优先用 Chromium 网络栈；失败时退回 Node https；仍失败再交给系统 curl。 */
const primaryDownload = petNet.available ? petDownload.createDownloader({ fetch: petNet.fetchLike }) : null;
const nodeDownload = petDownload.download;
async function download(url, limit, context) {
  if (!primaryDownload) {
    try { return await nodeDownload(url, limit, context); }
    catch (error) {
      if (!error || (error.code !== 'network' && error.code !== 'timeout')) throw error;
      return downloadWithCurl(url, limit, context);
    }
  }
  try {
    return await primaryDownload(url, limit, context);
  } catch (error) {
    if (!error || (error.code !== 'network' && error.code !== 'timeout')) throw error;
    try {
      return await nodeDownload(url, limit, context);
    } catch (second) {
      if (!second || (second.code !== 'network' && second.code !== 'timeout')) throw second;
      return downloadWithCurl(url, limit, context);
    }
  }
}

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_JSON_BYTES = 128 * 1024;
function fail(code, id) { const error = new Error(code); error.code = code; error.id = id; throw error; }
function inside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return !!rel && !path.isAbsolute(rel) && rel.split(path.sep)[0] !== '..';
}
function createLibrary(options) {
  const root = path.resolve(options.root);
  const fetchBytes = options.download || download;
  const validateImage = options.validateImage || require('./image-validator.js').validateImageFully;
  const trash = path.join(root, '.trash');
  let busy = false;
  async function exclusive(task) {
    if (busy) fail('busy');
    busy = true;
    try { return await task(); } finally { busy = false; }
  }
  function destination(id) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) fail('bad-id');
    const target = path.resolve(root, id);
    if (!inside(root, target)) fail('bad-path');
    return target;
  }
  function metadata(bytes, fallback) {
    let meta;
    try { meta = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); } catch (_) { fail('bad-manifest'); }
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) fail('bad-manifest');
    const id = typeof meta.id === 'string' ? meta.id.trim() : fallback;
    destination(id);
    return { ...meta, id };
  }
  async function readAsset(folder, relative, limit) {
    if (typeof relative !== 'string' || !relative || !inside(folder, path.resolve(folder, relative))) fail('bad-path');
    const target = await fs.promises.realpath(path.resolve(folder, relative));
    if (!inside(folder, target)) fail('bad-path');
    const stat = await fs.promises.stat(target);
    if (!stat.isFile()) fail('not-folder');
    if (stat.size > limit) fail('too-large');
    return fs.promises.readFile(target);
  }
  function check(context) { if (context && context.signal && context.signal.aborted) fail('cancelled'); }
  function progress(context, stage, bytes, total) { if (context && context.onProgress) context.onProgress({ stage, bytes: bytes || 0, total: total || 0 }); }
  async function commit(meta, sheet, extension, hero, high, context) {
    check(context); progress(context, 'validating');
    if (!sheet.length || sheet.length > MAX_IMAGE_BYTES || !await validateImage(sheet)) fail('bad-image');
    if (hero && (!hero.length || !await validateImage(hero, true))) fail('bad-image');
    if (high && (!high.bytes.length || !await validateImage(high.bytes))) fail('bad-image');
    check(context);
    const target = destination(meta.id);
    if (fs.existsSync(target)) fail('exists', meta.id);
    await fs.promises.mkdir(root, { recursive: true });
    const stage = await fs.promises.mkdtemp(path.join(root, '.import-'));
    try {
      const sheetName = 'spritesheet' + extension;
      const normalized = { ...meta, spritesheet: sheetName, spritesheetPath: sheetName };
      delete normalized.hero;
      delete normalized.spritesheetHD;
      if (hero && hero.length) {
        normalized.hero = 'hero.webp';
        await fs.promises.writeFile(path.join(stage, 'hero.webp'), hero, { flag: 'wx' });
      }
      if (high) {
        normalized.spritesheetHD = { path: 'spritesheet-hd' + high.extension, scale: high.scale };
        await fs.promises.writeFile(path.join(stage, normalized.spritesheetHD.path), high.bytes, { flag: 'wx' });
      }
      await fs.promises.writeFile(path.join(stage, 'pet.json'), JSON.stringify(normalized, null, 2), { flag: 'wx' });
      await fs.promises.writeFile(path.join(stage, sheetName), sheet, { flag: 'wx' });
      // Never overwrite an existing pack, including a competing import.
      check(context); progress(context, 'installing');
      if (fs.existsSync(target)) fail('exists', meta.id);
      await fs.promises.rename(stage, target);
      return { id: meta.id, name: String(meta.displayName || meta.id) };
    } finally {
      if (inside(root, stage)) await fs.promises.rm(stage, { recursive: true, force: true });
    }
  }
  return {
    importFolder(folder, context) {
      return exclusive(async () => {
        check(context); progress(context, 'reading');
        const actual = await fs.promises.realpath(folder);
        if (!(await fs.promises.stat(actual)).isDirectory()) fail('not-folder');
        const meta = metadata(await readAsset(actual, 'pet.json', MAX_JSON_BYTES), path.basename(actual));
        const sheetName = meta.spritesheet || meta.spritesheetPath || 'spritesheet.webp';
        const extension = path.extname(sheetName).toLowerCase();
        if (!['.webp', '.png', '.jpg', '.jpeg', '.gif'].includes(extension)) fail('bad-image');
        const sheet = await readAsset(actual, sheetName, MAX_IMAGE_BYTES);
        let hero = null;
        if (meta.hero || fs.existsSync(path.join(actual, 'hero.webp'))) hero = await readAsset(actual, meta.hero || 'hero.webp', MAX_IMAGE_BYTES);
        let high = null;
        if (meta.spritesheetHD) {
          const spec = meta.spritesheetHD;
          if (!spec || typeof spec.path !== 'string' || ![2, 4].includes(spec.scale)) fail('bad-image');
          const ext = path.extname(spec.path).toLowerCase();
          if (!['.webp', '.png', '.jpg', '.jpeg'].includes(ext)) fail('bad-image');
          const bytes = await readAsset(actual, spec.path, MAX_IMAGE_BYTES);
          const size = require('./image-size.js').imageSize(bytes);
          if (!size || size.width !== 1536 * spec.scale || size.height !== 1872 * spec.scale) fail('bad-image');
          high = { bytes, extension: ext, scale: spec.scale };
        }
        return commit(meta, sheet, extension, hero, high, context);
      });
    },
    importCommand(command, context) {
      return exclusive(async () => {
        check(context); progress(context, 'resolving');
        const fetch = (url, limit) => fetchBytes(url, limit, { signal: context && context.signal, onProgress: (bytes, total) => progress(context, 'downloading', bytes, total) });
        const parsed = parseNpxCommand(command);
        if (!parsed.ok) fail(parsed.error);
        const source = await resolveSource(parsed, fetch);
        check(context); progress(context, 'metadata');
        const meta = metadata(await fetch(source.manifestUrl, MAX_JSON_BYTES), source.fallbackId);
        if (fs.existsSync(destination(meta.id))) fail('exists', meta.id);
        const asset = source.sheet(meta);
        progress(context, 'downloading');
        const sheet = await fetch(asset.url, MAX_IMAGE_BYTES);
        let high = null;
        if (meta.spritesheetHD) {
          const spec = meta.spritesheetHD;
          if (!spec || ![2, 4].includes(spec.scale) || typeof spec.path !== 'string') fail('bad-image');
          const remote = source.asset(spec.path), bytes = await fetch(remote.url, MAX_IMAGE_BYTES);
          const size = require('./image-size.js').imageSize(bytes);
          if (!size || size.width !== 1536 * spec.scale || size.height !== 1872 * spec.scale) fail('bad-image');
          high = { bytes, extension: remote.extension, scale: spec.scale };
        }
        return commit(meta, sheet, asset.extension, null, high, context);
      });
    },
    remove(pet, profile) {
      return exclusive(async () => {
        if (!pet || !ID_PATTERN.test(pet.id) || !ID_PATTERN.test(pet.dirName)) fail('bad-id');
        const target = destination(pet.dirName);
        const actualRoot = await fs.promises.realpath(root);
        const actualTarget = await fs.promises.realpath(target);
        if (!inside(actualRoot, actualTarget) || (await fs.promises.lstat(target)).isSymbolicLink()) fail('bad-path');
        // Keep the complete pack and its name/growth together until restored.
        await fs.promises.mkdir(trash, { recursive: true });
        if (!inside(actualRoot, await fs.promises.realpath(trash))) fail('bad-path');
        const token = crypto.randomBytes(8).toString('hex'), retired = path.join(trash, token);
        await fs.promises.mkdir(retired);
        const record = { token, id: pet.id, dirName: pet.dirName, name: String((profile && profile.name) || pet.displayName || pet.id).slice(0, 80), growth: profile && profile.growth || null, deletedAt: Date.now() };
        try {
          await fs.promises.writeFile(path.join(retired, 'record.json'), JSON.stringify(record), { flag: 'wx' });
          await fs.promises.rename(target, path.join(retired, 'pack'));
        } catch (error) { await fs.promises.rm(retired, { recursive: true, force: true }); throw error; }
        return { id: pet.id, token };
      });
    },
    async listTrash() {
      const entries = await fs.promises.readdir(trash, { withFileTypes: true }).catch(() => []), result = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || !/^[a-f0-9]{16}$/.test(entry.name)) continue;
        try { const data = JSON.parse(await fs.promises.readFile(path.join(trash, entry.name, 'record.json'), 'utf8')); if (ID_PATTERN.test(data.id) && ID_PATTERN.test(data.dirName)) result.push({ ...data, token: entry.name }); } catch (_) {}
      }
      return result.sort((a, b) => b.deletedAt - a.deletedAt);
    },
    restoreTrash(token) {
      return exclusive(async () => {
        if (typeof token !== 'string' || !/^[a-f0-9]{16}$/.test(token)) fail('bad-id');
        const retired = path.join(trash, token), actualRoot = await fs.promises.realpath(root);
        if (!inside(actualRoot, await fs.promises.realpath(retired))) fail('bad-path');
        const record = JSON.parse(await fs.promises.readFile(path.join(retired, 'record.json'), 'utf8'));
        const target = destination(record.dirName);
        if (!ID_PATTERN.test(record.id)) fail('bad-id');
        if (fs.existsSync(target) || require('./pets.js').scanPets(root).pets.some(pet => pet.id === record.id)) fail('exists', record.id);
        const pack = await fs.promises.realpath(path.join(retired, 'pack'));
        if (!inside(retired, pack)) fail('bad-path');
        await fs.promises.rename(pack, target);
        await fs.promises.rm(retired, { recursive: true, force: true }).catch(() => {});
        return record;
      });
    }
  };
}
module.exports = { createLibrary, download, inside, MAX_IMAGE_BYTES };
