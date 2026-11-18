(function (factory) {
  const api = factory();
  if (typeof window !== 'undefined') window.PetQuality = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(function () {
  'use strict';
  function options(settings) {
    const s = settings || {};
    const strength = [20, 40, 65].indexOf(Number(s.lightStrength)) >= 0 ? Number(s.lightStrength) : 40;
    return { sharp: s.sharpRender === true, light: s.characterLighting === true, strength: strength };
  }
  function signature(settings) {
    const o = options(settings);
    return (o.sharp ? 's1' : 's0') + (o.light ? '-l' + o.strength : '-l0');
  }
  // Work in native sprite pixels, once per atlas/frame, never in the display loop.
  // Keep alpha unchanged: transparent padding must remain transparent, not a box.
  function enhance(src, w, h, settings) {
    const o = options(settings), out = new Uint8ClampedArray(src);
    if (!o.sharp && !o.light) return out;
    const power = o.strength / 100;
    const warmTint = [1, 0.87, 0.68], coolTint = [0.38, 0.69, 1];
    const aAt = (xx, yy) => xx < 0 || xx >= w || yy < 0 || yy >= h ? 0 : src[(yy * w + xx) * 4 + 3] / 255;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4, alpha = src[p + 3];
      if (!alpha) continue;
      const left = (y * w + Math.max(0, x - 1)) * 4;
      const right = (y * w + Math.min(w - 1, x + 1)) * 4;
      const up = (Math.max(0, y - 1) * w + x) * 4;
      const down = (Math.min(h - 1, y + 1) * w + x) * 4;
      const inner = Math.min(alpha, src[left + 3], src[right + 3], src[up + 3], src[down + 3]) > 224;
      const key = o.light ? Math.max(0, alpha / 255 - (aAt(x - 2, y) + aAt(x, y - 2)) / 2) : 0;
      const rim = o.light ? Math.max(0, alpha / 255 - aAt(x + 2, y + 1)) : 0;
      const diffuse = o.light ? Math.max(0, 1 - Math.hypot((x / w - 0.30) / 0.95, (y / h - 0.15) / 1.2)) : 0;
      for (let c = 0; c < 3; c++) {
        let value = src[p + c];
        if (o.sharp && inner) {
          const average = (src[left + c] + src[right + c] + src[up + c] + src[down + c]) / 4;
          value += Math.max(-16, Math.min(16, (value - average) * 0.46));
        }
        if (o.light) {
          // Warm upper-left key and restrained cool rim. Use available headroom
          // instead of adding white, preserving white hair and dark outlines.
          const top = Math.max(0, 1 - y / h);
          const warm = power * (0.12 * diffuse + 0.025 * top + 0.38 * key) * warmTint[c];
          const cool = power * 0.30 * rim * coolTint[c];
          value = value * (1 - power * 0.018 * (y / h)) + (255 - value) * Math.min(0.32, warm + cool);
        }
        out[p + c] = Math.round(value);
      }
    }
    return out;
  }
  // Reconstruct diagonal corners at 2x before final device-pixel resampling.
  // Every reconstructed pixel comes from the same frame's local palette;
  // alpha participates in comparisons so transparent gutters cannot leak in.
  function refineEdges(src, w, h) {
    const dw = w * 2, out = new Uint8ClampedArray(dw * h * 2 * 4);
    function equal(a, b) {
      if (src[a + 3] < 8 && src[b + 3] < 8) return true;
      return Math.abs(src[a + 3] - src[b + 3]) < 18 && Math.abs(src[a] - src[b]) < 18 &&
        Math.abs(src[a + 1] - src[b + 1]) < 18 && Math.abs(src[a + 2] - src[b + 2]) < 18;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const e = (y * w + x) * 4, b = (Math.max(0, y - 1) * w + x) * 4;
      const d = (y * w + Math.max(0, x - 1)) * 4, f = (y * w + Math.min(w - 1, x + 1)) * 4;
      const g = (Math.min(h - 1, y + 1) * w + x) * 4;
      const corner = !equal(b, g) && !equal(d, f);
      const a0 = corner && equal(d, b) ? d : e, a1 = corner && equal(b, f) ? f : e;
      const a2 = corner && equal(d, g) ? d : e, a3 = corner && equal(g, f) ? f : e;
      const p = ((y * 2) * dw + x * 2) * 4;
      for (let c = 0; c < 4; c++) { out[p + c] = src[a0 + c]; out[p + 4 + c] = src[a1 + c]; out[p + dw * 4 + c] = src[a2 + c]; out[p + dw * 4 + 4 + c] = src[a3 + c]; }
    }
    return { data: out, width: dw, height: h * 2 };
  }
  function bounds(data, w, h) {
    let left = w, right = -1, top = h, bottom = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (data[(y * w + x) * 4 + 3] > 32) {
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
    return right < left ? null : { left, right, top, bottom, width: right - left + 1 };
  }
  function createBoundsCache() {
    let source = null, canvas = null, context = null;
    const cache = new Map();
    return function (image, col, row) {
      if (!image || typeof document === 'undefined') return null;
      if (source !== image) { source = image; cache.clear(); }
      const key = row + ':' + col;
      if (cache.has(key)) return cache.get(key);
      try {
        if (!canvas) { canvas = document.createElement('canvas'); canvas.width = 192; canvas.height = 208; context = canvas.getContext('2d', { willReadFrequently: true }); }
        if (!context) return null;
        context.clearRect(0, 0, 192, 208);
        const scale = [1, 2, 4].find(n => (image.naturalWidth || image.width) === 1536 * n && (image.naturalHeight || image.height) === 1872 * n) || 1;
        context.drawImage(image, col * 192 * scale, row * 208 * scale, 192 * scale, 208 * scale, 0, 0, 192, 208);
        const value = bounds(context.getImageData(0, 0, 192, 208).data, 192, 208);
        if (cache.size >= 72) cache.delete(cache.keys().next().value);
        cache.set(key, value); return value;
      } catch (_) { return null; }
    };
  }
  function drawShadow(ctx, current, base, settings, offset, jump) {
    if (!ctx || !current || !base || !settings.characterLighting || settings.groundShadow === false) return;
    const lift = Math.max(0, base.bottom - current.bottom) + Math.max(0, Number(jump) || 0);
    const grounded = Math.max(0.25, 1 - lift / 110);
    const width = Math.max(14, Math.min(47, base.width * 0.31)) * (0.65 + grounded * 0.35);
    const y = Math.min(202, base.bottom + 3) + (offset || 0);
    ctx.save();
    ctx.translate((base.left + base.right) / 2, y);
    ctx.scale(width, 4.5);
    const fill = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    fill.addColorStop(0, 'rgba(24,32,48,' + (0.23 * grounded).toFixed(3) + ')');
    fill.addColorStop(0.5, 'rgba(24,32,48,' + (0.12 * grounded).toFixed(3) + ')');
    fill.addColorStop(1, 'rgba(24,32,48,0)');
    ctx.fillStyle = fill; ctx.fillRect(-1, -1, 2, 2); ctx.restore();
  }
  return { options, signature, enhance, refineEdges, bounds, createBoundsCache, drawShadow };
});
