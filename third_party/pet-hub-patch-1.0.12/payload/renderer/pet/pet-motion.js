(function (factory) {
  const api = factory();
  if (typeof window !== 'undefined') window.PetMotion = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(function () {
  'use strict';

  // 运动估计：相邻两张图集帧的块匹配，取高置信块中位数得到整只宠物的单一平移。
  // 纯函数模块，不碰 DOM，可在 node 下直接单测。
  const STEP = 2;        // 灰度网格 = 图集像素 / 2
  const BLOCK = 8;       // 匹配块 = BLOCK 个网格单元 = 16 图集像素
  const SAMPLE = 2;      // 块内取样步长（网格单元）
  const SEARCH = 4;      // 搜索半径（网格单元）= ±8 图集像素
  const PENALTY = 2;     // 每单位位移的代价，平坦区因此归零
  const GAIN = 80;       // 归零代价上升多少才算「该方向被证据支持」（约 5 灰阶/样本）
  const FLOW_MAX = 32;   // 位移编码上限（图集像素）
  const CONF_MIN = 0.55; // 低于此置信度的像素不做全局平移，退回 mix(A, B, t)
  const SHIFT_MAX = 8;   // 全局位移上限（图集像素），先夹这里再进编码

  function gridOf(pixels, width, height) {
    const grid = new Float32Array(width * height);
    for (let i = 0, p = 0; i < grid.length; i += 1, p += 4) {
      const alpha = pixels[p + 3];
      if (!alpha) continue;
      grid[i] = (0.299 * pixels[p] + 0.587 * pixels[p + 1] + 0.114 * pixels[p + 2]) * (alpha / 255);
    }
    return grid;
  }

  function cost(a, b, width, height, x0, y0, dx, dy) {
    let sum = 0;
    for (let sy = 0; sy < BLOCK; sy += SAMPLE) {
      const y = y0 + sy;
      const ty = y + dy;
      if (ty < 0 || ty >= height) return -1;
      const rowA = y * width;
      const rowB = ty * width;
      for (let sx = 0; sx < BLOCK; sx += SAMPLE) {
        const x = x0 + sx;
        const tx = x + dx;
        if (tx < 0 || tx >= width) return -1;
        const d = a[rowA + x] - b[rowB + tx];
        sum += d < 0 ? -d : d;
      }
    }
    return sum;
  }

  // 某个方向的位移是否真的被证据支持：把该方向归零后代价上升多少。
  // 平坦块（归零后代价不变）返回 0，不参与中位数。
  function strength(centre, zeroed) {
    if (!(centre >= 0) || !(zeroed >= 0)) return 0;
    const delta = zeroed - centre;
    if (delta <= 0) return 0;
    return delta >= GAIN ? 1 : delta / GAIN;
  }

  function refine(centre, left, right) {
    if (!(left >= 0) || !(right >= 0) || !(centre >= 0)) return 0;
    const den = left - 2 * centre + right;
    if (!(den > 1e-4)) return 0;
    const offset = 0.5 * (left - right) / den;
    if (offset > 0.5) return 0.5;
    if (offset < -0.5) return -0.5;
    return offset;
  }

  function match(a, b, width, height, cols, rows) {
    const dx = new Float32Array(cols * rows);
    const dy = new Float32Array(cols * rows);
    const wx = new Float32Array(cols * rows);
    const wy = new Float32Array(cols * rows);
    for (let cy = 0; cy < rows; cy += 1) {
      for (let cx = 0; cx < cols; cx += 1) {
        const x0 = cx * BLOCK;
        const y0 = cy * BLOCK;
        let best = cost(a, b, width, height, x0, y0, 0, 0);
        if (best < 0) best = Infinity;
        let mx = 0;
        let my = 0;
        for (let sy = -SEARCH; sy <= SEARCH; sy += 1) {
          for (let sx = -SEARCH; sx <= SEARCH; sx += 1) {
            if (!sx && !sy) continue;
            const raw = cost(a, b, width, height, x0, y0, sx, sy);
            if (raw < 0) continue;
            const total = raw + PENALTY * (Math.abs(sx) + Math.abs(sy));
            if (total < best) {
              best = total;
              mx = sx;
              my = sy;
            }
          }
        }
        const centre = cost(a, b, width, height, x0, y0, mx, my);
        const xl = cost(a, b, width, height, x0, y0, mx - 1, my);
        const xr = cost(a, b, width, height, x0, y0, mx + 1, my);
        const yu = cost(a, b, width, height, x0, y0, mx, my - 1);
        const yd = cost(a, b, width, height, x0, y0, mx, my + 1);
        // 亚像素细化用「带代价项」的采样值：精确匹配时左右对称，不会凭空产生半个像素。
        // 整数位移已精确对齐（centre=0）时不做拟合，否则邻域代价的轻微不对称会被
        // 当成真实的半像素运动，静止画面因此抖动。
        const scored = function (cx, cy, raw) {
          return raw < 0 ? raw : raw + PENALTY * (Math.abs(cx) + Math.abs(cy));
        };
        const centreScored = scored(mx, my, centre);
        const exact = centre <= 0.5;
        let fx = mx;
        let fy = my;
        if (!exact && mx > -SEARCH && mx < SEARCH) {
          fx += refine(centreScored, scored(mx - 1, my, xl), scored(mx + 1, my, xr));
        }
        if (!exact && my > -SEARCH && my < SEARCH) {
          fy += refine(centreScored, scored(mx, my - 1, yu), scored(mx, my + 1, yd));
        }
        const index = cy * cols + cx;
        dx[index] = fx * STEP;
        dy[index] = fy * STEP;
        // 只把该方向归零、另一方向保留：得到的代价差就是该方向的证据强度。
        wx[index] = mx ? strength(centre, cost(a, b, width, height, x0, y0, 0, my)) : 0;
        wy[index] = my ? strength(centre, cost(a, b, width, height, x0, y0, mx, 0)) : 0;
      }
    }
    return { cols: cols, rows: rows, dx: dx, dy: dy, wx: wx, wy: wy };
  }

  function median(values) {
    if (!values.length) return 0;
    const sorted = values.slice().sort(function (a, b) { return a - b; });
    const half = sorted.length >> 1;
    if (sorted.length % 2) return sorted[half];
    return 0.5 * (sorted[half - 1] + sorted[half]);
  }

  function clampShift(value) {
    const limit = Math.min(SHIFT_MAX, FLOW_MAX);
    if (!isFinite(value)) return 0;
    if (value > limit) return limit;
    if (value < -limit) return -limit;
    return value;
  }

  // 全局平移 + 置信度门控：
  // 1) 块匹配得到每块 (dx, dy, wx, wy)；
  // 2) 水平位移取 wx >= CONF_MIN 的块的中位数，竖直位移取 wy >= CONF_MIN 的块的中位数；
  // 3) 单一 (dx, dy) 夹到 ±8px 交给整只宠物，每块置信度写进门控贴图。
  function estimateGlobal(pixelsA, pixelsB, width, height) {
    if (!pixelsA || !pixelsB || !(width > 0) || !(height > 0)) return null;
    if (pixelsA.length < width * height * 4 || pixelsB.length < width * height * 4) return null;
    const cols = Math.ceil(width / BLOCK);
    const rows = Math.ceil(height / BLOCK);
    const a = gridOf(pixelsA, width, height);
    const b = gridOf(pixelsB, width, height);
    const field = match(a, b, width, height, cols, rows);
    const count = cols * rows;
    const xs = [];
    const ys = [];
    for (let i = 0; i < count; i += 1) {
      if (field.wx[i] >= CONF_MIN) xs.push(field.dx[i]);
      if (field.wy[i] >= CONF_MIN) ys.push(field.dy[i]);
    }
    const shiftX = clampShift(xs.length ? median(xs) : 0);
    const shiftY = clampShift(ys.length ? median(ys) : 0);
    const conf = new Uint8Array(count * 4);
    for (let i = 0; i < count; i += 1) {
      // 单块置信度取两个方向证据的较大值：纯水平或纯竖直的运动都能通过门控。
      const value = Math.round(Math.min(1, Math.max(field.wx[i], field.wy[i])) * 255);
      conf[i * 4] = value;
      conf[i * 4 + 1] = value;
      conf[i * 4 + 2] = value;
      conf[i * 4 + 3] = 255;
    }
    return {
      cols: cols,
      rows: rows,
      block: BLOCK * STEP,
      max: FLOW_MAX,
      shift: [shiftX, shiftY],
      conf: conf,
      confMin: CONF_MIN,
      support: { x: xs.length, y: ys.length, blocks: count }
    };
  }

  // 目标帧率 → 一个源帧区间内输出多少个插值状态
  function interpSteps(fps, frameMs) {
    const rate = fps > 0 ? fps : 24;
    const dur = frameMs > 0 ? frameMs : 0;
    if (!dur) return 1;
    const steps = Math.round((rate * dur) / 1000);
    return steps > 1 ? steps : 1;
  }

  // 把连续 t 量化到 steps 个等间隔格子，同一格返回同一个 t（不重复重绘同一个插值）
  function quantizeT(t, steps) {
    const count = steps > 1 ? steps : 1;
    const clamped = t > 0 ? (t < 1 ? t : 1) : 0;
    if (count === 1) return 0;
    const index = Math.floor(clamped * count);
    return (index >= count ? count - 1 : index) / count;
  }

  return {
    STEP: STEP,
    BLOCK: BLOCK,
    SEARCH: SEARCH,
    FLOW_MAX: FLOW_MAX,
    CONF_MIN: CONF_MIN,
    SHIFT_MAX: SHIFT_MAX,
    gridOf: gridOf,
    match: match,
    median: median,
    estimateGlobal: estimateGlobal,
    interpSteps: interpSteps,
    quantizeT: quantizeT
  };
});
