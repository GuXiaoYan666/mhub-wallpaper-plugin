(function (factory) {
  const api = factory();
  if (typeof window !== 'undefined') window.PetHd = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(function () {
  'use strict';

  // Processed artwork is resampled from native pixels once with premultiplied-alpha Lanczos-3.
  // Keep the explicit unprocessed/pixel-art utility path available to existing callers.
  // 纯计算部分（重采样）不碰 DOM，可在 node 下直接验证；create() 才需要 2D canvas。
  const FRAME_WIDTH = 192;
  const FRAME_HEIGHT = 208;
  const LANCZOS_A = 3;
  const TAPS = LANCZOS_A * 2;
  const NEAREST_MAX = 4;
  // R14：分片预算 14ms -> 8ms（一帧之内还要留出绘制与合成的时间）。
  const BUDGET_MS = 8;
  const quality = (function () {
    if (typeof window !== 'undefined' && window.PetQuality) return window.PetQuality;
    try { if (typeof require === 'function') return require('../../shared/quality.js'); } catch (_) {}
    return typeof window !== 'undefined' ? window.PetQuality : null;
  })();

  function lanczos3(x) {
    const ax = x < 0 ? -x : x;
    if (ax < 1e-8) return 1;
    if (ax >= LANCZOS_A) return 0;
    const px = Math.PI * ax;
    return (LANCZOS_A * Math.sin(px) * Math.sin(px / LANCZOS_A)) / (px * px);
  }

  // 一维权重表：目标像素 i 的中心落在 (i + 0.5) * srcLen/dstLen - 0.5，
  // 取中心两侧各 LANCZOS_A 个源像素（固定 6 taps），越界索引夹到边缘。
  function axisTable(srcLen, dstLen) {
    const ratio = srcLen / dstLen;
    const index = new Int32Array(dstLen * TAPS);
    const weight = new Float32Array(dstLen * TAPS);
    for (let i = 0; i < dstLen; i += 1) {
      const centre = (i + 0.5) * ratio - 0.5;
      const first = Math.floor(centre) - LANCZOS_A + 1;
      let sum = 0;
      const base = i * TAPS;
      for (let t = 0; t < TAPS; t += 1) {
        const pos = first + t;
        const w = lanczos3(pos - centre);
        index[base + t] = pos < 0 ? 0 : (pos >= srcLen ? srcLen - 1 : pos);
        weight[base + t] = w;
        sum += w;
      }
      if (sum !== 0) {
        for (let t = 0; t < TAPS; t += 1) weight[base + t] /= sum;
      }
    }
    return { index: index, weight: weight };
  }

  // R8：同一次构建里所有帧的重采样尺寸完全相同，权重表（2 张 Int32 + 2 张 Float32）与
  // 中间/输出缓冲提到 build 作用域按几何建一次并逐帧复用，不再每帧重新分配十几 MB 临时数组。
  function makeResampler(sw, sh, dw, dh) {
    const horizontal = axisTable(sw, dw);
    const hIndex = horizontal.index;
    const hWeight = horizontal.weight;
    const vertical = axisTable(sh, dh);
    const vIndex = vertical.index;
    const vWeight = vertical.weight;
    const mid = new Float32Array(dw * sh * 4);
    const out = new Uint8ClampedArray(dw * dh * 4);
    const stride = dw * 4;
    return function run(src) {
      if (!src || src.length < sw * sh * 4) return null;
      for (let y = 0; y < sh; y += 1) {
        const srcRow = y * sw * 4;
        const midRow = y * dw * 4;
        for (let x = 0; x < dw; x += 1) {
          let r = 0;
          let g = 0;
          let b = 0;
          let a = 0;
          const base = x * TAPS;
          for (let t = 0; t < TAPS; t += 1) {
            const w = hWeight[base + t];
            if (w === 0) continue;
            const p = srcRow + hIndex[base + t] * 4;
            const alpha = src[p + 3];
            if (!alpha) continue;
            const k = (w * alpha) / 255;
            r += src[p] * k;
            g += src[p + 1] * k;
            b += src[p + 2] * k;
            a += alpha * w;
          }
          const o = midRow + x * 4;
          mid[o] = r;
          mid[o + 1] = g;
          mid[o + 2] = b;
          mid[o + 3] = a;
        }
      }
      for (let x = 0; x < dw; x += 1) {
        const col = x * 4;
        for (let y = 0; y < dh; y += 1) {
          let r = 0;
          let g = 0;
          let b = 0;
          let a = 0;
          const base = y * TAPS;
          for (let t = 0; t < TAPS; t += 1) {
            const w = vWeight[base + t];
            if (w === 0) continue;
            const p = vIndex[base + t] * stride + col;
            const alpha = mid[p + 3];
            if (!alpha) continue;
            r += mid[p] * w;
            g += mid[p + 1] * w;
            b += mid[p + 2] * w;
            a += alpha * w;
          }
          const o = y * stride + col;
          if (!(a > 0)) {
            out[o] = 0;
            out[o + 1] = 0;
            out[o + 2] = 0;
            out[o + 3] = 0;
            continue;
          }
          const inv = 255 / a;
          out[o] = Math.round(r * inv);
          out[o + 1] = Math.round(g * inv);
          out[o + 2] = Math.round(b * inv);
          out[o + 3] = Math.round(a);
        }
      }
      return { data: out, width: dw, height: dh };
    };
  }

  // 单帧一次性重采样（测试/外部调用用）：尺寸校验后走同一套复用实现。
  function resample(src, sw, sh, dw, dh) {
    if (!src || !(sw > 0) || !(sh > 0) || !(dw > 0) || !(dh > 0)) return null;
    if (src.length < sw * sh * 4) return null;
    return makeResampler(sw, sh, dw, dh)(src);
  }
  function nearestFactor(width) {
    const factor = Math.ceil((Number(width) || 0) / FRAME_WIDTH);
    if (!(factor >= 1)) return 1;
    return factor > NEAREST_MAX ? NEAREST_MAX : factor;
  }

  // 高清帧高：与帧宽保持同一缩放比，避免运行时再纵向拉伸
  function frameHeight(width) {
    return Math.max(1, Math.round((FRAME_HEIGHT * (Number(width) || 0)) / FRAME_WIDTH));
  }

  function create(options) {
    const opts = options && typeof options === 'object' ? options : {};
    const budget = typeof opts.budgetMs === 'number' && opts.budgetMs > 0 ? opts.budgetMs : BUDGET_MS;
    // R18：画布工厂可注入（node 下用桩就能逐像素验重采样），不传时仍走 document。
    function createCanvas() {
      if (typeof opts.createCanvas === 'function') return opts.createCanvas();
      if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
      return document.createElement('canvas');
    }

    function build(request) {
      const req = request && typeof request === 'object' ? request : {};
      const image = req.image;
      const columns = Math.max(1, Math.round(Number(req.columns) || 1));
      const rows = Math.max(1, Math.round(Number(req.rows) || 1));
      const cellW = Math.max(0, Math.round(Number(req.cellWidth) || 0));
      if (!createCanvas()) return Promise.reject(new Error('canvas factory unavailable'));
      const srcW = image ? (image.naturalWidth || image.width || 0) : 0;
      const srcH = image ? (image.naturalHeight || image.height || 0) : 0;
      if (!(srcW > 0) || !(srcH > 0)) {
        return Promise.reject(new Error('source atlas unavailable'));
      }
      if (!(cellW > 0)) return Promise.reject(new Error('cell width unavailable'));

      const cellH = frameHeight(cellW);
      const sourceScale = [1, 2, 4].find(n => srcW === 1536 * n && srcH === 1872 * n) || 1;
      // Preserve genuine high-resolution pixels instead of shrinking to 192px
      // and upscaling them again. Palette-based reconstruction is an explicit pixel-art opt-in.
      const sourceW = FRAME_WIDTH * sourceScale, sourceH = FRAME_HEIGHT * sourceScale;
      const edgeRefine = sourceScale === 1 && req.pixelArt === true && req.quality && req.quality.sharpRender === true && quality;
      const factor = edgeRefine ? 2 : req.quality ? 1 : nearestFactor(cellW);
      const midW = sourceScale > 1 ? Math.min(sourceW, Math.max(cellW, FRAME_WIDTH)) : FRAME_WIDTH * factor;
      const midH = frameHeight(midW);
      const mid = createCanvas();
      if (!mid) return Promise.reject(new Error('mid canvas unavailable'));
      mid.width = midW;
      mid.height = midH;
      const midCtx = mid.getContext('2d', { willReadFrequently: true });
      const atlas = createCanvas();
      if (!atlas) return Promise.reject(new Error('atlas canvas unavailable'));
      atlas.width = cellW * columns;
      atlas.height = cellH * rows;
      const atlasCtx = atlas.getContext('2d');
      if (!midCtx || !atlasCtx) return Promise.reject(new Error('2d context unavailable'));
      // 第一级就是要 NEAREST，别让浏览器偷偷用双线性。
      midCtx.imageSmoothingEnabled = false;
      atlasCtx.imageSmoothingEnabled = false;

      const total = columns * rows;
      const native = req.quality && quality ? createCanvas() : null;
      let nativeCtx = null;
      if (native) { native.width = midW; native.height = midH; nativeCtx = native.getContext('2d', { willReadFrequently: true }); }
      // R8：一次构建只建一次重采样器（权重表 + 中间/输出缓冲），逐帧复用。
      let resampler = null;
      return new Promise(function (resolve, reject) {
        let done = 0;
        let failure = null;
        // R14：构建期单独计时——总构建耗时与最慢分片都带回去，交给渲染层判定是否降级。
        let buildMs = 0;
        let sliceMs = 0;
        function tick() {
          if (typeof req.isCancelled === 'function' && req.isCancelled()) { reject(new Error('quality build cancelled')); return; }
          const started = Date.now();
          try {
            while (done < total) {
              const row = Math.floor(done / columns);
              const col = done % columns;
              const sx = col * sourceW;
              const sy = row * sourceH;
              // 图集比 8x9 网格小：缺的格子留空，不当作错误
              if (sx + sourceW > srcW || sy + sourceH > srcH) {
                done += 1;
                continue;
              }
              midCtx.clearRect(0, 0, midW, midH);
              let midData;
              if (nativeCtx) {
                const nw = sourceScale === 1 ? FRAME_WIDTH : midW, nh = sourceScale === 1 ? FRAME_HEIGHT : midH;
                nativeCtx.clearRect(0, 0, midW, midH);
                nativeCtx.imageSmoothingEnabled = sourceScale > 1;
                nativeCtx.imageSmoothingQuality = 'high';
                nativeCtx.drawImage(image, sx, sy, sourceW, sourceH, 0, 0, nw, nh);
                const pixels = nativeCtx.getImageData(0, 0, nw, nh);
                pixels.data.set(quality.enhance(pixels.data, nw, nh, req.quality));
                if (edgeRefine) midData = quality.refineEdges(pixels.data, nw, nh);
                else {
                  nativeCtx.putImageData(pixels, 0, 0);
                  midCtx.drawImage(native, 0, 0, nw, nh, 0, 0, midW, midH);
                }
              } else { midCtx.imageSmoothingEnabled = sourceScale > 1; midCtx.imageSmoothingQuality = 'high'; midCtx.drawImage(image, sx, sy, sourceW, sourceH, 0, 0, midW, midH); }
              if (!midData) midData = midCtx.getImageData(0, 0, midW, midH);
              if (!resampler) resampler = makeResampler(midW, midH, cellW, cellH);
              const out = resampler(midData.data);
              if (!out) throw new Error('resample failed');
              atlasCtx.putImageData(new ImageData(out.data, out.width, out.height), col * cellW, row * cellH);
              done += 1;
              if (typeof req.onProgress === 'function') req.onProgress((done / total) * 100);
              if (Date.now() - started >= budget) break;
            }
          } catch (err) {
            failure = err;
          }
          const spent = Date.now() - started;
          buildMs += spent;
          if (spent > sliceMs) sliceMs = spent;
          if (failure) {
            reject(failure);
            return;
          }
          if (done < total) {
            setTimeout(tick, 0);
            return;
          }
          resolve({
            canvas: atlas,
            cellW: cellW,
            cellH: cellH,
            columns: columns,
            rows: rows,
            frames: total,
            factor: factor,
            budgetMs: budget,
            buildMs: buildMs,
            sliceMs: sliceMs
          });
        }
        setTimeout(tick, 0);
      });
    }

    return { build: build };
  }

  return {
    FRAME_WIDTH: FRAME_WIDTH,
    FRAME_HEIGHT: FRAME_HEIGHT,
    LANCZOS_A: LANCZOS_A,
    TAPS: TAPS,
    NEAREST_MAX: NEAREST_MAX,
    lanczos3: lanczos3,
    axisTable: axisTable,
    resample: resample,
    nearestFactor: nearestFactor,
    frameHeight: frameHeight,
    create: create
  };
});
