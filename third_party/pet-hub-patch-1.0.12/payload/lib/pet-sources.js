'use strict';

// Channel adapters mirror the published installers. Only pet assets are copied.
const { ID_PATTERN } = require('./pets.js');
const JSON_LIMIT = 128 * 1024;
function invalid(code = 'bad-source') { throw Object.assign(new Error(code), { code }); }
function json(bytes) {
  try {
    const value = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch (_) { /* report a recoverable source error below */ }
  invalid();
}
function assetUrl(value) {
  let url;
  try { url = new URL(value); } catch (_) { invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) invalid();
  return url.href;
}
function relative(value) {
  if (typeof value !== 'string' || value.length > 240 || !value.split('/').every(part => /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(part))) invalid();
  return value.split('/').map(encodeURIComponent).join('/');
}
function extension(name) {
  const ext = require('path').extname(name).toLowerCase();
  if (!['.webp', '.png', '.jpg', '.jpeg', '.gif'].includes(ext)) invalid('bad-image');
  return ext;
}
async function resolveSource(parsed, fetchBytes) {
  if (parsed.provider === 'codex-pet-installer') {
    const base = 'https://codex-pet.org/api/pets/' + encodeURIComponent(parsed.slug) + '/files/';
    return { fallbackId: parsed.slug, manifestUrl: base + 'pet.json', sheet: () => ({ url: base + 'spritesheet.webp', extension: '.webp' }), asset: name => ({ url: base + relative(name), extension: extension(name) }) };
  }
  if (parsed.provider === 'clipets') {
    const resolved = json(await fetchBytes('https://clipets.com/api/resolve/' + encodeURIComponent(parsed.slug), JSON_LIMIT));
    if (typeof resolved.folder !== 'string' || !ID_PATTERN.test(resolved.folder) || !resolved.files || typeof resolved.files !== 'object') invalid();
    const manifestUrl = assetUrl(resolved.files['pet.json']);
    return {
      fallbackId: resolved.folder, manifestUrl,
      asset: name => ({ url: assetUrl(resolved.files[name]), extension: extension(name) }),
      sheet(meta) {
        const name = meta.spritesheet || meta.spritesheetPath || 'spritesheet.webp';
        return { url: assetUrl(resolved.files[name]), extension: extension(name) };
      }
    };
  }
  if (parsed.provider === 'petscodex') {
    const base = 'https://raw.githubusercontent.com/mn8821236/petscodex/main/';
    const catalog = json(await fetchBytes(base + 'catalog.json', 4 * 1024 * 1024));
    if (!Array.isArray(catalog.pets)) invalid();
    const pet = catalog.pets.find(p => p && (p.id === parsed.slug || p.path === parsed.slug));
    if (!pet) invalid('pet-not-found');
    const folder = relative(pet.path || pet.id);
    return {
      fallbackId: pet.id, manifestUrl: base + folder + '/pet.json',
      asset: name => ({ url: base + folder + '/' + relative(name), extension: extension(name) }),
      sheet(meta) {
        const name = meta.spritesheet || meta.spritesheetPath || 'spritesheet.webp';
        return { url: base + folder + '/' + relative(name), extension: extension(name) };
      }
    };
  }
  invalid('unknown-package');
}
module.exports = { resolveSource };
