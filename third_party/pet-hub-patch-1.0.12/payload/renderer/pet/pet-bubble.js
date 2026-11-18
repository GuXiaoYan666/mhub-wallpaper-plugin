(function (factory) {
  const api = factory();
  if (typeof window !== 'undefined') {
    const prior = window.PetBubble && window.PetBubble.__test;
    window.PetBubble = api;
    // 只读测试钩子：node 侧用最小 window 沙箱即可验证断行，不必起 canvas。
    api.__test = Object.assign({}, prior && typeof prior === 'object' ? prior : null, {
      wrap: api.wrap,
      measureChar: api.estimateWidth,
      MAX_CHARS: api.MAX_CHARS
    });
  }
  if (typeof module === 'object' && module.exports) module.exports = api;
})(function () {
  'use strict';

  // 契约 §9：画在现有 canvas 顶部固定区（不占焦点、不改变窗口尺寸、不影响点击热区）。
  // 视觉规格唯一来源：键盘提示气泡（pet.js drawBubbles）与情绪/设备播报气泡共用这一份数字，
  // pet.js 直接读 PetBubble.STYLE，不在自己那边另存一份。
  const STYLE = Object.freeze({
    FONT_SIZE: 14,
    // 与驱动页同一套字体栈（驱动 body computed 原串），画布同样吃系统已装的 MiSans。
    FONT: 'bold 14px MiSans, "PingFang SC", Helvetica, sans-serif, Arial, "Microsoft JhengHei", "Helvetica Neue", sans-serif',
    LINE_H: 18,
    PAD_X: 6,
    PAD_Y: 4,
    RADIUS: 8,
    STROKE_W: 1.5,
    FILL: '#ffffff',
    STROKE: '#1e1e1e',
    TEXT: '#1e1e1e',
    REST_Y: 48,
    RISE_PX: 31,
    STATIC_Y: 32
  });
  const WIDTH = 192;
  const FONT = STYLE.FONT;
  const LINE_H = STYLE.LINE_H;
  const MAX_LINES = 3;
  const MAX_CHARS = 14;
  const PAD_X = STYLE.PAD_X;
  const PAD_Y = STYLE.PAD_Y;
  const RADIUS = STYLE.RADIUS;
  const MAX_BOX = 184;
  const INWARD_PX = 16;
  const DEFAULT_MS = 3500;
  const MAX_MS = 15000;
  const FILL = STYLE.FILL;
  const STROKE = STYLE.STROKE;
  const TEXT = STYLE.TEXT;
  // 没有 2d 上下文时的字宽估算（只服务 node 单测与 measureText 缺失的兜底）：
  // 固定 12/7/4，不随 FONT_SIZE 走；真实断行按目标 canvas 的 measureText。
  const EST_WIDE = 12;
  const EST_NARROW = 7;
  const EST_SPACE = 4;
  const EDGES = ['top', 'left', 'right', 'none'];

  function normalizeEdge(edge) {
    const value = String(edge == null ? '' : edge).toLowerCase();
    return EDGES.indexOf(value) >= 0 ? value : 'none';
  }

  function clampMs(value) {
    const raw = Number(value);
    if (!isFinite(raw) || raw <= 0) return DEFAULT_MS;
    return Math.max(300, Math.min(MAX_MS, Math.round(raw)));
  }

  function cleanText(text) {
    return String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, 240);
  }

  // 没有 2d 上下文（node 单测）时按全角 12 / 半角 7 估算，保证换行逻辑可独立验证。
  function estimateWidth(ch) {
    const code = typeof ch === 'string' ? ch.codePointAt(0) : 0;
    if (!code) return 0;
    const wide = (code >= 0x1100 && code <= 0x115f)
      || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6);
    if (wide) return EST_WIDE;
    if (ch === ' ') return EST_SPACE;
    return EST_NARROW;
  }

  function widthOf(chars, measure) {
    let total = 0;
    for (let i = 0; i < chars.length; i += 1) total += measure(chars[i]);
    return total;
  }

  function ellipsize(chars, measure, maxWidth) {
    const kept = chars.slice(0, MAX_CHARS);
    while (kept.length && (kept.length >= MAX_CHARS || widthOf(kept, measure) + measure('…') > maxWidth)) {
      kept.pop();
    }
    return kept.join('') + '…';
  }

  // 词元切分：CJK（含全角标点）逐字成词元；连续的非 CJK、非空格字符（字母/数字/#/./:/%/·/-/+/_ 等）
  // 视为不可分割的整体；连续空格单独成词元。
  const CJK_RANGES = [
    [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
    [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff],
    [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6]
  ];

  function isCJK(ch) {
    const code = typeof ch === 'string' ? ch.codePointAt(0) : 0;
    if (!code) return false;
    for (let i = 0; i < CJK_RANGES.length; i += 1) {
      if (code >= CJK_RANGES[i][0] && code <= CJK_RANGES[i][1]) return true;
    }
    return false;
  }

  function isBlank(ch) {
    return ch === ' ';
  }

  function tokenize(content) {
    const chars = Array.from(content);
    const tokens = [];
    let i = 0;
    while (i < chars.length) {
      let j = i + 1;
      if (isBlank(chars[i])) {
        while (j < chars.length && isBlank(chars[j])) j += 1;
      } else if (!isCJK(chars[i])) {
        while (j < chars.length && !isBlank(chars[j]) && !isCJK(chars[j])) j += 1;
      }
      tokens.push(chars.slice(i, j).join(''));
      i = j;
    }
    return tokens;
  }

  function wrap(text, measure) {
    const content = cleanText(text);
    if (!content) return [];
    const maxWidth = MAX_BOX - 2 * PAD_X;
    const tokens = tokenize(content);
    const lines = [];
    let line = '';
    let width = 0;
    let count = 0;

    function flush() {
      lines.push(line.replace(/ +$/, ''));
      line = '';
      width = 0;
      count = 0;
    }

    tokens.forEach(function (token) {
      const blank = isBlank(token.charAt(0));
      if (blank && !count) return; // 行首空格不占位
      const chars = Array.from(token);
      const tokenWidth = widthOf(chars, measure);
      if (count && (width + tokenWidth > maxWidth || count + chars.length > MAX_CHARS)) flush();
      if (blank && !count) return; // 换行后落到行首的空格同样跳过
      if (width + tokenWidth <= maxWidth && count + chars.length <= MAX_CHARS) {
        line += token;
        width += tokenWidth;
        count += chars.length;
        return;
      }
      // 空行且词元自身超宽：唯一允许按字符硬切的场景。
      chars.forEach(function (ch) {
        const chWidth = measure(ch);
        if (count && (width + chWidth > maxWidth || count + 1 > MAX_CHARS)) flush();
        line += ch;
        width += chWidth;
        count += 1;
      });
    });
    if (count) flush();
    if (lines.length <= MAX_LINES) return lines.slice(0, MAX_LINES);
    const kept = lines.slice(0, MAX_LINES);
    kept[MAX_LINES - 1] = ellipsize(Array.from(kept[MAX_LINES - 1]), measure, maxWidth);
    return kept;
  }

  // 单行 = PAD_Y*2 + LINE_H（与键盘提示气泡同一个算式），多行只是行数增加。
  function heightOf(lines) {
    return Math.max(LINE_H, lines.length * LINE_H) + 2 * PAD_Y;
  }

  // 与键盘提示气泡同一套上浮：底部基准 REST_Y，按寿命进度上浮 RISE_PX；reduced 时停在 STATIC_Y。
  function centerYOf(progress, reduced) {
    if (reduced) return STYLE.STATIC_Y;
    return STYLE.REST_Y - STYLE.RISE_PX * progress;
  }

  // progress 只影响纵向位置，横向仍只由 edge 与文本宽度决定。
  // R7：cachedMax 由调用方（entry）预先算好，传入时跳过逐行重测，draw 只读不量。
  function layoutOf(edge, lines, measure, progress, reduced, cachedMax) {
    let maxLine = isFinite(cachedMax) && cachedMax > 0 ? cachedMax : 0;
    if (!(maxLine > 0)) {
      for (let i = 0; i < lines.length; i += 1) {
        const width = widthOf(Array.from(lines[i]), measure);
        if (width > maxLine) maxLine = width;
      }
    }
    const boxW = Math.min(MAX_BOX, Math.max(28, Math.ceil(maxLine) + 2 * PAD_X));
    const boxH = heightOf(lines);
    // 契约 §9 的边缘翻转：贴近屏幕左/右侧沿时把气泡整体往窗口内侧挪。
    const shift = edge === 'left' ? INWARD_PX : edge === 'right' ? -INWARD_PX : 0;
    let left = WIDTH / 2 + shift - boxW / 2;
    left = Math.max(2, Math.min(WIDTH - 2 - boxW, left));
    const p = isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
    const cy = centerYOf(p, !!reduced);
    return { x: left, y: cy - boxH / 2, w: boxW, h: boxH, cy: cy, edge: edge };
  }

  function create(options) {
    const deps = options || {};
    const settingsOf = typeof deps.getSettings === 'function' ? deps.getSettings : function () { return {}; };
    const clock = typeof deps.now === 'function' ? deps.now : function () { return 0; };

    const model = { entry: null, edge: 'none', shown: 0 };

    function nowOf(value) {
      if (typeof value === 'number' && isFinite(value)) return value;
      const at = Number(clock());
      return isFinite(at) ? at : 0;
    }

    function enabled() {
      const settings = settingsOf();
      return !settings || settings.bubbles !== false;
    }

    function durationMs() {
      const settings = settingsOf() || {};
      return clampMs(settings.bubbleMs);
    }

    function clear() {
      model.entry = null;
      return false;
    }

    function prune(at) {
      if (model.entry && at >= model.entry.until) model.entry = null;
      return !!model.entry;
    }

    function setEdge(edge) {
      model.edge = normalizeEdge(edge);
      if (model.entry) model.entry.edge = model.edge;
      return model.edge;
    }

    function show(text, opts) {
      const settings = opts || {};
      const clean = cleanText(text);
      if (!clean) {
        clear();
        return false;
      }
      if (!enabled()) {
        clear();
        return false;
      }
      const at = nowOf(settings.now);
      const ms = clampMs(settings.ms != null ? settings.ms : durationMs());
      const edge = settings.edge != null ? normalizeEdge(settings.edge) : model.edge;
      model.entry = { text: clean, at: at, until: at + ms, edge: edge, lines: null, maxLine: 0 };
      model.shown += 1;
      return true;
    }

    function linesFor(entry, measure) {
      if (!entry.lines) {
        entry.lines = wrap(entry.text, measure);
        // R7：最宽行只在换行那一次量出来存进 entry，之后每帧只读。
        let maxLine = 0;
        for (let i = 0; i < entry.lines.length; i += 1) {
          const width = widthOf(Array.from(entry.lines[i]), measure);
          if (width > maxLine) maxLine = width;
        }
        entry.maxLine = maxLine;
      }
      return entry.lines;
    }

    function state(value) {
      const at = nowOf(value);
      prune(at);
      const entry = model.entry;
      return {
        visible: !!entry,
        text: entry ? entry.text : '',
        edge: entry ? entry.edge : model.edge,
        at: entry ? entry.at : 0,
        until: entry ? entry.until : 0,
        left: entry ? Math.max(0, Math.round(entry.until - at)) : 0,
        lines: entry && entry.lines ? entry.lines.slice() : [],
        shown: model.shown
      };
    }

    // 返回 true 表示这一帧由情绪气泡占位，键盘提示气泡让位（情绪气泡优先）。
    function draw(target, at, opts) {
      if (!target || typeof target.beginPath !== 'function') return false;
      const now = nowOf(at);
      prune(now);
      const entry = model.entry;
      if (!entry) return false;
      if (!enabled()) return false;
      if (typeof target.measureText === 'function') {
        try {
          target.font = FONT;
        } catch (err) {
          return false;
        }
      }
      const measure = typeof target.measureText === 'function'
        ? function (ch) {
          const width = target.measureText(ch).width;
          return isFinite(width) && width > 0 ? width : estimateWidth(ch);
        }
        : estimateWidth;
      const lines = linesFor(entry, measure);
      if (!lines.length) return false;
      const reduced = !!(opts && opts.reduced);
      // 寿命进度 p∈[0,1]；透明度口径与键盘提示气泡一致：min(1, 2*(1-p))。
      const span = Math.max(1, entry.until - entry.at);
      const progress = Math.max(0, Math.min(1, (now - entry.at) / span));
      const alpha = reduced ? 1 : Math.min(1, 2 * (1 - progress));
      const box = layoutOf(entry.edge, lines, measure, progress, reduced, entry.maxLine);

      target.save();
      target.globalAlpha = alpha;
      target.font = FONT;
      target.textAlign = 'center';
      target.textBaseline = 'middle';
      // 纯圆角矩形，无尖角尾巴：一次 roundRect、fill、stroke。
      target.beginPath();
      target.roundRect(box.x, box.y, box.w, box.h, RADIUS);
      target.fillStyle = FILL;
      target.fill();
      target.lineWidth = STYLE.STROKE_W;
      target.strokeStyle = STROKE;
      target.stroke();
      target.fillStyle = TEXT;
      for (let i = 0; i < lines.length; i += 1) {
        target.fillText(lines[i], box.x + box.w / 2, box.y + PAD_Y + LINE_H * i + LINE_H / 2);
      }
      target.restore();
      return true;
    }

    return {
      show: show,
      clear: clear,
      prune: prune,
      state: state,
      draw: draw,
      setEdge: setEdge,
      edge: function () { return model.edge; },
      visible: function (value) { return prune(nowOf(value)); },
      layout: function (value) {
        const at = nowOf(value);
        prune(at);
        if (!model.entry) return null;
        return layoutOf(model.entry.edge, linesFor(model.entry, estimateWidth), estimateWidth, 0, false);
      }
    };
  }

  return {
    create: create,
    wrap: wrap,
    layoutOf: layoutOf,
    normalizeEdge: normalizeEdge,
    estimateWidth: estimateWidth,
    STYLE: STYLE,
    MAX_LINES: MAX_LINES,
    MAX_CHARS: MAX_CHARS,
    LINE_H: STYLE.LINE_H,
    FONT_SIZE: STYLE.FONT_SIZE,
    DEFAULT_MS: DEFAULT_MS
  };
});
