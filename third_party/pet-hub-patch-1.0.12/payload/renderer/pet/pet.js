(function () {
  'use strict';

  const ACTIONS = window.PetActions;
  const IPC = require('../../lib/ipc.js');
  const ipc = require('electron').ipcRenderer;
  const hostChannel = (function () {
    try { return require('../../lib/host-channel.js'); } catch (_) { return null; }
  })();
  // pet-hd.js 已在 index.html 的 <script> 链里（排在 pet.js 之前），优先按 CommonJS 拿，
  // 拿不到（例如被裁剪的构建）再退到 window.PetHd。
  const petHdModule = (function () {
    try {
      return require('./pet-hd.js');
    } catch (err) {
      return window.PetHd || null;
    }
  })();

  const WIDTH = 192;
  const qualityModule = window.PetQuality || null;
  const qualityBounds = qualityModule ? qualityModule.createBoundsCache() : null;
  function drawCharacterShadow(target, jump) {
    if (!qualityModule || !qualityBounds || !atlas || settings.characterLighting !== true) return;
    const f = clampFrame(ACTIONS.frameFor(current, elapsed));
    qualityModule.drawShadow(target, qualityBounds(atlas, f.col, f.row), qualityBounds(atlas, 0, 0), settings, FRAME_Y, jump);
  }
  const HEIGHT = 328;
  const FRAME_HEIGHT = 208;
  const FRAME_Y = 96;
  const ALPHA_THRESHOLD = 8;
  const BUBBLE_TTL = 1100;
  const BUBBLE_LANES = 3;
  const BUBBLE_MAX = 3;
  // 两类气泡（情绪 + 键盘提示）共用这一条基线；用户反馈太靠上，从 32 下移到 42。
  const BUBBLE_BASE_Y = 42;
  const BADGE_FILL = '#1e1e1eeb';
  const BADGE_STROKE = '#ffffff';
  const BADGE_TEXT = '#ffffff';
  const BANNER_GRAD_TOP = '#2a2a2a';
  const BANNER_GRAD_BOTTOM = '#121212';
  const BANNER_STROKE = '#ffffff';
  const BANNER_TEXT = '#ffffff';
  const GLOW_INNER = '#ffffff70';
  const GLOW_MID = '#ffffff2e';
  const GLOW_OUTER = '#ffffff00';
  const RING_LIGHT = '#ffffff99';
  const RING_DARK = '#cfcfcfbb';
  const STAR_COLORS = ['#ffffff', '#e6e6e6', '#f5f5f5'];
  const JUMP_PX = 7;
  const JUMP_MS = 240;
  const LIFT_PX = 10;
  const LEVELUP_SPAN = 1200;
  const CLICK_MS = 250;
  const DRAG_PX = 3;
  // Desktop and preview share one random picker. Each automatic pose loops for 20–28s.
  const AUTO_MIN_MS = ACTIONS.AUTO_MIN_MS;
  const AUTO_MAX_MS = ACTIONS.AUTO_MAX_MS;
  const SLOW_FRAME_MS = 20;
  const SLOW_SPAN_MS = 1000;
  // R10：GL 上下文丢失是可重试事件——等浏览器 restored 的宽限期，超时才永久回落 2D。
  const LOST_GRACE_MS = 1500;
  // 补帧档位＝源帧率的整数倍（×2/×3/×4，来源 R14 智能补帧）。固定帧率时插值格数
  // 随源帧时长在 2/3 之间抖（round(fps×dur/1000)），时间轴对不齐会有果冻感；倍数下固定 mult 格。
  const INTERP_MULT = [2, 3, 4];
  const LEGACY_FPS_MULT = { 24: 2, 30: 3, 60: 4 };
  // R4：亮度缓存容量按整本图集的帧数算（ATLAS_ROWS×ATLAS_COLUMNS=72），旧上限 48 小于实际帧数，会整表 clear。
  const LUMA_CACHE_MAX = Math.max(1, (ACTIONS.ATLAS_ROWS || 9) * (ACTIONS.ATLAS_COLUMNS || 8));
  // R19：格子宽小于 32 时,高清重采样在视觉上没有收益，直接跳过 HD。
  const HD_MIN_CELL_W = 32;
  // 契约 §3/§6/§8/§9：调度交 PetBehavior，情绪气泡交 PetBubble；本文件只做消费与呈现。
  const PetBehavior = window.PetBehavior || null;
  const PetBubble = window.PetBubble || null;
  // 气泡视觉规格唯一来源是 pet-bubble.js 的 STYLE（index.html 保证它在 pet.js 之前加载）；
  // 缺失时宁可不画键盘提示气泡，也不在本文件另存一份数字。
  const BUBBLE_STYLE = PetBubble && PetBubble.STYLE ? PetBubble.STYLE : null;
  const AMBIENT = PetBehavior ? PetBehavior.AMBIENT_PRIORITY : 4;
  const SAMPLE_SPAN_MS = 120;
  const LIGHT_THROW = 220;
  const INERTIA_MS = 420;
const ROAM_FALLBACK_MS = 4000;
  // 契约 §12：趣味台词只属于渲染层，设备播报一律用主进程下发的 text。
  const PET_LINES = {
    zh: {
      waving: ['嗨～', '在呢在呢', '来啦'],
      jumping: ['跳一个！', '嘿咻', '别戳啦'],
      failed: ['我错了…', '手抖了一下', '哎哟'],
      hover: ['要摸我吗？', '轻轻的…', '嗯？'],
      roam: ['我去转转～', '溜达一圈', '看看那边'],
      idle: ['……', '发呆中']
    },
    en: {
      waving: ['Hi~', 'Here!', 'Hello'],
      jumping: ['Hop!', 'Boing', 'Hey!'],
      failed: ['Oops…', 'My bad', 'Ouch'],
      hover: ['Pet me?', 'So close', 'Hm?'],
      roam: ['Going for a walk', 'Just looking around', 'Be right back'],
      idle: ['...', 'Thinking']
    }
  };

  const canvas = document.getElementById('pet');
  const ctx = canvas.getContext('2d');
  let atlas = null;
  // R9：applyState 选中的宠物；为 null 表示"没有可用宠物"，HD 一律不建，保持在 2D。
  let activePet = null;
  let atlasUrl = '';
  let atlasLoading = '';
  let atlasFallbackFrom = '';
  let framesPerRow = null;
  let scanWarned = false;
  let pets = [];
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');

  const layout = { dpr: 1, scale: 0, bitmapW: 0, bitmapH: 0, k: 1, cssW: 0, cssH: 0, left: -1, dirty: true };
  const fx = { wantInterp: false, inst: null, degraded: false, failed: false, glowOn: false };
  let lostSince = 0;
  const hd = {
    want: false,
    status: 'idle',
    progress: 0,
    key: '',
    image: null,
    cellW: 0,
    cellH: 0,
    ready: false,
    building: false,
    failed: false,
    cacheHit: false,
    bytes: 0,
    // R2/R3/R19：降级或降档的原因，进 __petFxState 便于验收
    reason: '',
    // R14：构建期独立计时（ms）：总耗时、最慢分片、编码阻塞
    buildMs: 0,
    sliceMs: 0,
    encodeMs: 0
  };
  const reported = { sharp: null, interp: null, fps: null, hd: null, hdProgress: null, hdReason: null };
  const frameMs = [];
  const lumaCache = new Map();
  let glCanvas = null;
  let glowCanvas = null;
  let glowCtx = null;
  let lumaCanvas = null;
  let lumaCtx = null;
  let committedScale = 0;
  let targetScale = 100;
  let commitDue = false;
  let commitTimer = 0;
  let lastTransform = '';
  let flowKey = '';
  let flowData = null;
  let interpStep = 1;
  // 最近一个源帧的时长（ms），用来把倍数换算成设置页展示的等效帧率。
  let lastSourceMs = 100;
  let slowStart = 0;

  const settings = {
    visible: false,
    scale: 75,
    alwaysOnTop: true,
    clickThrough: false,
    autoPlay: true,
    followInput: true,
    showKeyHints: true,
    showLevel: true,
    petId: 'aby',
    petName: 'ranran',
    action: 'idle',
    position: null,
    locale: 'zh'
  };
  const growth = { level: 1 };

  const bubbles = {
    list: [],
    sequence: 0,
    add(label, at) {
      this.prune(at);
      this.list.push({ label: String(label).slice(0, 24), at: at, lane: (this.sequence++ % BUBBLE_LANES) - 1 });
      if (this.list.length > BUBBLE_MAX) this.list = this.list.slice(-BUBBLE_MAX);
    },
    prune(now) {
      const list = this.list;
      if (!list.length) return;
      // R16：原地压缩，避免每帧 filter 分配新数组；只剩空列表时才提前返回。
      let kept = 0;
      for (let i = 0; i < list.length; i++) {
        if (now - list[i].at < BUBBLE_TTL) list[kept++] = list[i];
      }
      if (kept !== list.length) list.length = kept;
    },
    clear() {
      this.list = [];
    },
    jumpOffset(now) {
      const last = this.list[this.list.length - 1];
      if (!last) return 0;
      return JUMP_PX * Math.sin(Math.min(1, Math.max(0, now - last.at) / JUMP_MS) * Math.PI);
    }
  };

  let current = 'idle';
  let elapsed = 0;
  let autoAction = 'idle';
  let autoNextAt = 0;
  // Completed random changes; blocked or disabled periods never advance this counter.
  let autoIndex = 0;
  let levelUpUntil = 0;
  let levelUpSpan = LEVELUP_SPAN;
  let levelUpLevel = 0;
  let lastTs = 0;
  let pointer = null;
  let readySent = false;

  // 契约 §3：动作切换统一入口。behavior 负责抢占/队列/ttl/回退，这里只提供 start 原语。
  const behavior = PetBehavior
    ? PetBehavior.create({
      start: start,
      baseAction: baseAction,
      durationOf: function (action) { return ACTIONS.durationOf(action); },
      onDone: onActionDone,
      onAction: onActionPlayed,
      now: function () { return performance.now(); },
      getSettings: function () { return settings; }
    })
    : null;
  const bubble = PetBubble
    ? PetBubble.create({
      getSettings: function () { return settings; },
      now: function () { return performance.now(); }
    })
    : null;
  const roam = { active: false, dir: '', until: 0 };
  const pointerSamples = [];
  let inertiaUntil = 0;
  let hoverInside = false;

  function request(event) {
    if (!behavior) {
      start(event && event.action, !!(event && event.oneShot));
      return { accepted: true, reason: 'no-behavior', bubbleOnly: false };
    }
    return behavior.request(event);
  }

  // 契约 §12：edge 拿不到时一律兜底 'none'（居中，不翻转）。
  function edgeOf() {
    const edge = settings && typeof settings.edge === 'string' ? settings.edge : '';
    return edge === 'top' || edge === 'left' || edge === 'right' ? edge : 'none';
  }

  function petLine(kind) {
    const table = PET_LINES[settings.locale === 'en' ? 'en' : 'zh'] || PET_LINES.zh;
    const list = table[kind] || table.idle || [];
    if (!list.length) return '';
    return list[Math.floor(Math.random() * list.length)];
  }

  function maybeLine(kind) {
    if (!bubble || settings.bubbles === false) return false;
    if (kind !== 'failed' && Math.random() > 0.5) return false;
    const text = petLine(kind);
    if (!text) return false;
    return bubble.show(text, { edge: edgeOf() });
  }

  function showEventBubble(text, at) {
    if (!bubble) return false;
    const clean = typeof text === 'string' ? text.trim() : '';
    if (!clean) return false;
    return bubble.show(clean, { edge: edgeOf(), now: at });
  }

  function onActionPlayed(action, meta) {
    send(IPC.ACTION_CURRENT, { action: action, petId: settings.petId, source: meta && meta.source, kind: meta && meta.kind });
    if (!meta || !meta.internal) return;
    if (meta.kind === 'burst') { maybeLine('failed'); return; }
    if (meta.kind === 'double') { maybeLine('jumping'); return; }
    if (meta.kind === 'click') { maybeLine('waving'); return; }
    if (meta.kind === 'hover') { maybeLine('hover'); }
  }

  function onActionDone(finished) {
    if (settings.autoPlay) {
      autoAction = 'idle';
      // deadline 还在未来就复用，不重新采样：否则一次性动作（waving/jumping/failed）播完会再排一次
      // 20–28s，两次动作"开始"之间变成两段叠加（实测出现过 44.5–49.3s 的空档）。
      const at = performance.now();
      if (!autoNextAt || autoNextAt <= at) autoNextAt = at + autoDelay();
    }
    send(IPC.ACTION_DONE, { action: finished });
  }

  function send(channel, payload) {
    try {
      ipc.send(channel, payload);
    } catch (err) {
      console.error('[pet] send failed', channel, err);
    }
  }

  function levelUpText(level) {
    const lv = level || growth.level || 1;
    return settings.locale === 'en' ? 'Level Up! Lv.' + lv : '升级！Lv.' + lv;
  }

  function baseAction() {
    if (settings.autoPlay) return autoAction;
    return ACTIONS.has(settings.action) ? settings.action : 'idle';
  }

  // 低层原语：只换帧。一次性动作的到期、回退与 ACTION_DONE 全部由 PetBehavior 负责。
  function start(action, oneShot) {
    current = ACTIONS.has(action) ? action : 'idle';
    elapsed = 0;
  }

  function autoDelay() {
    // Keep a full 20–28 seconds between automatic changes.
    return AUTO_MIN_MS + Math.random() * (AUTO_MAX_MS - AUTO_MIN_MS);
  }

  function pickAuto() {
    const action = ACTIONS.pickAuto(current);
    autoIndex += 1;
    return action;
  }

  function update(dt, now) {
    elapsed += dt;
    if (behavior) behavior.tick(now);

    if (settings.autoPlay && !motion.matches) {
      // 契约 §7/§8：漫游、拖拽惯性、跟手、一次性动作与排队事件期间不叠加自动动作。
      // Interrupted or blocked poses do not consume an automatic change.
      // R6：只用轻量 isLive()（{oneShot, queued}），不再每帧构造整份 state。
      const live = behavior ? behavior.isLive(now) : null;
      const blocked = !!(pointer && pointer.moved) || roam.active || now < inertiaUntil ||
        !!(live && (live.oneShot || live.queued.length > 0));
      if (!autoNextAt) {
        autoNextAt = now + autoDelay();
      } else if (now >= autoNextAt && !blocked) {
        autoAction = pickAuto();
        autoNextAt = now + autoDelay();
        request({ kind: 'auto', action: autoAction, priority: AMBIENT, source: 'auto', oneShot: false });
      }
    } else if (autoNextAt) {
      autoNextAt = 0;
    }

    if (roam.active && roam.until && now >= roam.until) endRoam('timeout');

  }

  function levelUpView(now, reduced) {
    const active = levelUpUntil > now;
    const span = levelUpSpan > 0 ? levelUpSpan : LEVELUP_SPAN;
    const progress = active ? Math.max(0, Math.min(1, 1 - (levelUpUntil - now) / span)) : 1;
    const lift = !reduced && active ? LIFT_PX * Math.max(0, Math.sin(Math.min(1, progress / 0.32) * Math.PI)) : 0;
    return { active: active, progress: reduced && active ? 0.4 : progress, lift: lift };
  }

  function drawLevelGlow(target, w, h, progress, reduced, inFront) {
    const alpha = inFront ? 1 : Math.min(1, progress / 0.1, (1 - progress) / 0.22);
    const cx = w / 2;
    const cy = 96 + 0.52 * (h - 120);
    const radius = Math.min(0.43 * w, 0.48 * (h - 120));
    target.save();
    target.beginPath();
    target.rect(0, 96, w, h - 120);
    target.clip();
    target.globalAlpha = Math.max(0, alpha);
    if (!inFront) {
      const glow = target.createRadialGradient(cx, cy, 0, cx, cy, 1.15 * radius);
      glow.addColorStop(0, GLOW_INNER);
      glow.addColorStop(0.6, GLOW_MID);
      glow.addColorStop(1, GLOW_OUTER);
      target.fillStyle = glow;
      target.fillRect(0, 96, w, h - 120);
      for (let ring = 0; ring < 2; ring += 1) {
        const scale = reduced ? 0.9 : 0.35 + 0.65 * Math.min(1, 2.8 * progress + 0.17 * ring);
        target.strokeStyle = ring ? RING_LIGHT : RING_DARK;
        target.lineWidth = ring ? 1 : 1.5;
        target.beginPath();
        target.ellipse(cx, cy, radius * scale, radius * scale * 0.85, 0, 0, 2 * Math.PI);
        target.stroke();
      }
      target.restore();
      return;
    }
    for (let i = 0; i < 12; i += 1) {
      const angle = i * 2 * Math.PI / 12 + (reduced ? 0 : 0.6 * progress);
      const dist = radius * (reduced ? 0.88 : 0.45 + 0.55 * Math.min(1, 2 * progress));
      const px = cx + Math.cos(angle) * dist;
      const py = cy + Math.sin(angle) * dist * 0.8 - (reduced ? 0 : 10 * progress);
      const size = 2 + i % 3;
      const wobble = reduced ? 1 : 0.65 + 0.35 * Math.sin(9 * progress + i);
      target.fillStyle = i % 3 === 0 ? STAR_COLORS[0] : i % 2 ? STAR_COLORS[1] : STAR_COLORS[2];
      target.save();
      target.translate(px, py);
      target.rotate(reduced ? 0 : progress * (i % 2 ? 1 : -1));
      target.beginPath();
      target.moveTo(0, -size * wobble);
      target.lineTo(0.4 * size, -0.4 * size);
      target.lineTo(size * wobble, 0);
      target.lineTo(0.4 * size, 0.4 * size);
      target.lineTo(0, size * wobble);
      target.lineTo(-0.4 * size, 0.4 * size);
      target.lineTo(-size * wobble, 0);
      target.lineTo(-0.4 * size, -0.4 * size);
      target.closePath();
      target.fill();
      target.restore();
    }
    target.restore();
  }

  function drawBubbles(target, list, now, reduced) {
    if (!BUBBLE_STYLE) return;
    const boxH = BUBBLE_STYLE.PAD_Y * 2 + BUBBLE_STYLE.LINE_H;
    target.save();
    target.font = BUBBLE_STYLE.FONT;
    target.textAlign = 'center';
    target.textBaseline = 'middle';
    for (let i = 0; i < list.length; i += 1) {
      const bubble = list[i];
      const age = Math.max(0, Math.min(1, (now - bubble.at) / BUBBLE_TTL));
      const bw = Math.min(180, Math.max(32, target.measureText(bubble.label).width + 2 * BUBBLE_STYLE.PAD_X + 8));
      const bx = Math.max(bw / 2 + 3, Math.min(189 - bw / 2, 96 + (reduced ? 0 : 20 * bubble.lane)));
      const by = reduced ? BUBBLE_STYLE.STATIC_Y : BUBBLE_STYLE.REST_Y - BUBBLE_STYLE.RISE_PX * age;
      target.globalAlpha = reduced ? 1 : Math.min(1, 2 * (1 - age));
      target.beginPath();
      target.roundRect(bx - bw / 2, by - boxH / 2, bw, boxH, BUBBLE_STYLE.RADIUS);
      target.fillStyle = BUBBLE_STYLE.FILL;
      target.fill();
      target.lineWidth = BUBBLE_STYLE.STROKE_W;
      target.strokeStyle = BUBBLE_STYLE.STROKE;
      target.stroke();
      target.fillStyle = BUBBLE_STYLE.TEXT;
      target.fillText(bubble.label, bx, by, bw - 2 * BUBBLE_STYLE.PAD_X);
    }
    target.restore();
  }

  function drawLevelBadge(target, level, showBadge, text, w, h, progress, reduced) {
    target.save();
    target.textAlign = 'center';
    target.textBaseline = 'middle';
    if (showBadge) {
      target.font = '600 12px MiSans, "PingFang SC", Helvetica, sans-serif, Arial, "Microsoft JhengHei", "Helvetica Neue", sans-serif';
      target.fillStyle = BADGE_FILL;
      target.beginPath();
      target.roundRect(w / 2 - 28, h - 23, 56, 21, 10);
      target.fill();
      if (text) {
        target.strokeStyle = BADGE_STROKE;
        target.lineWidth = 1;
        target.stroke();
      }
      target.fillStyle = BADGE_TEXT;
      target.fillText('Lv.' + level, w / 2, h - 12);
    }
    if (text) {
      target.font = 'bold 14px MiSans, "PingFang SC", Helvetica, sans-serif, Arial, "Microsoft JhengHei", "Helvetica Neue", sans-serif';
      const bw = Math.min(w - 6, target.measureText(text).width + 38);
      const grow = reduced ? 1 : 1 - Math.pow(1 - Math.min(1, progress / 0.16), 3);
      target.globalAlpha = reduced ? 1 : Math.min(grow, (1 - progress) / 0.18);
      target.translate(w / 2, 16);
      target.scale(0.88 + 0.12 * grow, 0.88 + 0.12 * grow);
      target.translate(-w / 2, -16);
      const fill = target.createLinearGradient(0, 2, 0, 29);
      fill.addColorStop(0, BANNER_GRAD_TOP);
      fill.addColorStop(1, BANNER_GRAD_BOTTOM);
      target.fillStyle = fill;
      target.strokeStyle = BANNER_STROKE;
      target.lineWidth = 1.5;
      target.beginPath();
      target.roundRect((w - bw) / 2, 2, bw, 27, 9);
      target.fill();
      target.stroke();
      target.fillStyle = BANNER_TEXT;
      target.fillText(text, w / 2, 16, bw - 32);
      for (let side = -1; side <= 1; side += 2) {
        const px = w / 2 + side * (bw / 2 - 9);
        target.beginPath();
        target.moveTo(px, 12);
        target.lineTo(px + 3, 16);
        target.lineTo(px, 20);
        target.lineTo(px - 3, 16);
        target.closePath();
        target.fill();
      }
    }
    target.restore();
  }

  function drawScenePlain(ts, reduced, view) {
    ctx.setTransform(layout.k, 0, 0, layout.k, 0, 0);
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    ctx.imageSmoothingEnabled = false;
    if (view.active) drawLevelGlow(ctx, WIDTH, HEIGHT, view.progress, reduced, false);

    const frame = clampFrame(ACTIONS.frameFor(current, reduced ? 0 : elapsed));
    const jump = view.active ? view.lift : reduced || !settings.followInput ? 0 : bubbles.jumpOffset(ts);
    drawCharacterShadow(ctx, jump);
    if (hd.ready && hd.image) {
      // 放大图集是按几何分桶建的（R3）：源格子是桶尺寸，目标仍是当前设备像素 1:1 的尺寸。
      const destW = layout.bitmapW || canvas.width;
      const destH = Math.max(1, Math.round(FRAME_HEIGHT * destW / WIDTH));
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(
        hd.image,
        frame.col * hd.cellW,
        frame.row * hd.cellH,
        hd.cellW,
        hd.cellH,
        0,
        Math.round((FRAME_Y - jump) * layout.k),
        destW,
        destH
      );
      ctx.restore();
    } else if (atlas && atlas.complete && atlas.naturalWidth > 0) {
      const scale = sourceScale(atlas);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(atlas, frame.x * scale, frame.y * scale, WIDTH * scale, FRAME_HEIGHT * scale, 0, FRAME_Y - jump, WIDTH, FRAME_HEIGHT);
    }
    // R5：升级光效只画一次——由 drawHud 统一画，这里不再重复叠一层。
    drawHud(ts, reduced, view, false);
  }

  function drawHud(ts, reduced, view, clear) {
    if (clear) {
      ctx.setTransform(layout.k, 0, 0, layout.k, 0, 0);
      ctx.clearRect(0, 0, WIDTH, HEIGHT);
      ctx.imageSmoothingEnabled = false;
    }
    if (view.active) drawLevelGlow(ctx, WIDTH, HEIGHT, view.progress, reduced, true);
    drawLevelBadge(ctx, growth.level, settings.showLevel !== false, view.active ? levelUpText(levelUpLevel) : '', WIDTH, HEIGHT, view.progress, reduced);
    // 契约 §9：情绪气泡画在最上层固定区；它占位时键盘提示气泡让位，两层气泡不打架。
    let bubbleShown = false;
    if (bubble) {
      ctx.save();
      // 与键盘提示气泡同一个基线，两类气泡出现的高度才一致。
      ctx.translate(0, BUBBLE_BASE_Y);
      bubbleShown = bubble.draw(ctx, ts, { reduced: reduced });
      ctx.restore();
    }
    if (!bubbleShown) {
      ctx.save();
      ctx.translate(0, BUBBLE_BASE_Y);
      drawBubbles(ctx, bubbles.list, ts, reduced);
      ctx.restore();
    }
  }

  function framePhase(action, elapsedMs) {
    const row = Math.max(0, ACTIONS.rowOf(action));
    const durations = ACTIONS[row].durations;
    const total = ACTIONS.durationOf(action);
    let rest = (typeof elapsedMs === 'number' && isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0) % total;
    let col = 0;
    while (col < durations.length - 1 && rest >= durations[col]) {
      rest -= durations[col];
      col += 1;
    }
    return { row: row, col: col, next: (col + 1) % durations.length, t: rest / durations[col] };
  }

  function clampCol(row, col) {
    if (!framesPerRow) return col;
    const count = framesPerRow[row];
    if (!(count > 0)) return 0;
    return col < count ? col : count - 1;
  }

  // R17：96×104 的缩图缓冲，帧判空（scanFrames）与亮度取样（framePixels）共用同一份。
  function ensureLumaSurface(w, h) {
    try {
      if (!lumaCanvas) {
        lumaCanvas = document.createElement('canvas');
        lumaCtx = lumaCanvas.getContext('2d', { willReadFrequently: true });
      }
      if (!lumaCtx) return null;
      if (lumaCanvas.width !== w || lumaCanvas.height !== h) {
        lumaCanvas.width = w;
        lumaCanvas.height = h;
      }
      return lumaCtx;
    } catch (err) {
      return null;
    }
  }

  function framePixels(row, col) {
    const key = row + ':' + col;
    if (lumaCache.has(key)) return lumaCache.get(key);
    let hit = null;
    try {
      const step = window.PetMotion.STEP;
      const w = Math.round(WIDTH / step);
      const h = Math.round(FRAME_HEIGHT / step);
      const surface = ensureLumaSurface(w, h);
      if (!surface) throw new Error('luma surface unavailable');
      surface.clearRect(0, 0, w, h);
      surface.imageSmoothingEnabled = true;
      const scale = sourceScale(atlas);
      surface.drawImage(atlas, col * WIDTH * scale, row * FRAME_HEIGHT * scale, WIDTH * scale, FRAME_HEIGHT * scale, 0, 0, w, h);
      hit = surface.getImageData(0, 0, w, h);
    } catch (err) {
      hit = null;
    }
    // R4：只淘汰最旧的一条，绝不整表 clear（整表清空会让下一帧全部重新 getImageData）。
    if (lumaCache.size >= LUMA_CACHE_MAX) {
      const oldest = lumaCache.keys().next();
      if (!oldest.done) lumaCache.delete(oldest.value);
    }
    lumaCache.set(key, hit);
    return hit;
  }

  // R4：只有换图集时才会一次性作废整张缓存（键按 row:col 命名，换了图集就全部失效），
  // 这条路径不在渲染循环里；渲染循环内一律走上面的单条 FIFO 淘汰。
  function resetLumaCache() {
    lumaCache.clear();
  }

  // R15：estimateGlobal 在 192×208 上不算便宜，而补帧只需要一条全局平移矢量，
  // 没必要每个源帧对都重估。按源帧序号每 FLOW_STRIDE(=2) 帧算一次，中间的对直接复用上一条结果。
  const FLOW_STRIDE = 2;
  let flowComputes = 0;
  let flowReuses = 0;

  function updateFlow(row, colA, colB) {
    const key = row + ':' + colA + ':' + colB;
    if (key === flowKey) return;
    if (!fx.inst) {
      flowKey = key;
      flowData = null;
      return;
    }
    if (colA === colB) {
      flowKey = key;
      flowData = null;
      fx.inst.setFlow(null);
      return;
    }
    // 落在没轮到的源帧上：沿用上一条光流（不重估、不丢数据）。
    if (flowData && (colA % FLOW_STRIDE) !== 0) {
      flowKey = key;
      flowReuses += 1;
      fx.inst.setFlow(flowData);
      return;
    }
    flowKey = key;
    flowData = null;
    const engine = window.PetMotion;
    const a = framePixels(row, colA);
    const b = framePixels(row, colB);
    if (!engine || !a || !b) {
      fx.inst.setFlow(null);
      return;
    }
    if (typeof engine.estimateGlobal !== 'function') {
      fx.inst.setFlow(null);
      return;
    }
    const estimate = engine.estimateGlobal(a.data, b.data, a.width, a.height);
    flowComputes += 1;
    flowData = estimate;
    fx.inst.setFlow(estimate);
  }

  function drawGlowLayer(reduced, view, ts) {
    if (!fx.inst) return;
    if (!view.active && !(settings.characterLighting === true && settings.groundShadow !== false)) {
      if (fx.glowOn) {
        fx.inst.setGlow(null);
        fx.glowOn = false;
      }
      return;
    }
    if (!glowCanvas) {
      glowCanvas = document.createElement('canvas');
      glowCtx = glowCanvas.getContext('2d');
    }
    if (glowCanvas.width !== layout.bitmapW || glowCanvas.height !== layout.bitmapH) {
      glowCanvas.width = layout.bitmapW;
      glowCanvas.height = layout.bitmapH;
    }
    glowCtx.setTransform(layout.k, 0, 0, layout.k, 0, 0);
    glowCtx.clearRect(0, 0, WIDTH, HEIGHT);
    glowCtx.imageSmoothingEnabled = false;
    drawCharacterShadow(glowCtx, view.active ? view.lift : reduced || !settings.followInput ? 0 : bubbles.jumpOffset(ts));
    if (view.active) drawLevelGlow(glowCtx, WIDTH, HEIGHT, view.progress, reduced, false);
    fx.inst.setGlow(glowCanvas);
    fx.glowOn = true;
  }

  function drawSceneGpu(ts, reduced, view) {
    drawHud(ts, reduced, view, true);
    drawGlowLayer(reduced, view, ts);
    let frameA = null;
    let frameB = null;
    let t = 0;
    const interp = featureState('interp') === 'on' && !reduced;
    const hdOn = hd.ready && hd.image;
    const cellW = hdOn ? hd.cellW : WIDTH * sourceScale(atlas);
    const cellH = hdOn ? hd.cellH : FRAME_HEIGHT * sourceScale(atlas);
    const engine = window.PetMotion;
    interpStep = 1;
    if (atlas && atlas.complete && atlas.naturalWidth > 0) {
      const phase = framePhase(current, reduced ? 0 : elapsed);
      const colA = clampCol(phase.row, phase.col);
      const colB = clampCol(phase.row, phase.next);
      frameA = { x: colA * cellW, y: phase.row * cellH };
      frameB = { x: colB * cellW, y: phase.row * cellH };
      if (interp && colA !== colB) {
        updateFlow(phase.row, colA, colB);
        // 倍数决定一个源帧区间里放几个插值状态：每个源帧固定 mult 格，格子数不再随源帧时长抖动。
        const durations = ACTIONS[phase.row].durations;
        lastSourceMs = durations[colA] || 100;
        interpStep = interpMult();
        t = flowData && engine && engine.quantizeT ? engine.quantizeT(phase.t, interpStep) : 0;
      }
    }
    const jump = view.active ? view.lift : reduced || !settings.followInput ? 0 : bubbles.jumpOffset(ts);
    fx.inst.render({
      frameA: frameA,
      frameB: frameB,
      t: t,
      jump: jump,
      interp: interp && t > 0,
      frameY: FRAME_Y,
      logicalW: WIDTH,
      logicalH: HEIGHT,
      frameW: cellW,
      frameH: cellH,
      logicalFrameH: FRAME_HEIGHT
    });
  }

  function render(ts) {
    const started = performance.now();
    const dt = lastTs ? Math.min(Math.max(0, ts - lastTs), 100) : 0;
    lastTs = ts;
    const reduced = motion.matches;
    if (!document.hidden) update(dt, ts);

    if (commitDue) {
      commitDue = false;
      committedScale = targetScale;
      layout.dirty = true;
      setStageTransform('none', false);
    }
    syncLayout();
    // 缩放/宠物变化会让缓存键失效：只在键真的变了时才重建。
    if (hd.want && activePet && !hd.building && hd.key !== hdKeyOf(currentPetId(), hdBucketGeometry(hdGeometry()))) syncHd();

    bubbles.prune(ts);
    if (bubble) bubble.prune(ts);
    const view = levelUpView(Date.now(), reduced);
    // R10：丢失先当可重试事件处理：宽限期内继续用 2D 画，等 restored 把 GL 层救回来。
    if (fx.inst && fx.inst.lost) {
      if (!lostSince) lostSince = ts;
      if (!fx.degraded && ts - lostSince > LOST_GRACE_MS) degradeNow();
    } else {
      lostSince = 0;
    }
    if (fx.inst && !fx.degraded && !fx.inst.lost) drawSceneGpu(ts, reduced, view);
    else drawScenePlain(ts, reduced, view);

    sampleFrame(started);
    requestAnimationFrame(render);
  }

  function scalePercent() {
    const raw = Number(settings.scale);
    // Rounded to whole percent so the sprite frame and the native window (lib/pet-window.js
    // computeSize) can never disagree by a pixel.
    return isFinite(raw) ? Math.round(Math.min(150, Math.max(0, raw))) : 100;
  }

  function setStageTransform(value, animate) {
    if (value === lastTransform) return;
    lastTransform = value;
    const transition = animate ? 'transform 180ms cubic-bezier(0.23, 1, 0.32, 1)' : 'none';
    canvas.style.transition = transition;
    canvas.style.transform = value;
    if (glCanvas) {
      glCanvas.style.transition = transition;
      glCanvas.style.transform = value;
    }
  }

  // 位图按真实显示尺寸重建：_k_ 个设备像素对应 1 个逻辑像素，
  // CSS 尺寸 = 位图尺寸 / dpr，因此静止时浏览器不再拉伸画布。
  function resizeBitmaps() {
    const dpr = window.devicePixelRatio || 1;
    const scale = committedScale || 100;
    const width = Math.max(1, Math.round(WIDTH * scale / 100 * dpr));
    const height = Math.max(1, Math.round(HEIGHT * scale / 100 * dpr));
    const cssW = width / dpr;
    const cssH = height / dpr;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    if (glCanvas) {
      glCanvas.style.width = cssW + 'px';
      glCanvas.style.height = cssH + 'px';
      if (fx.inst) fx.inst.setSize(width, height);
    }
    if (glowCanvas) {
      glowCanvas.width = width;
      glowCanvas.height = height;
    }
    layout.dpr = dpr;
    layout.scale = scale;
    layout.bitmapW = width;
    layout.bitmapH = height;
    layout.k = width / WIDTH;
    layout.cssW = cssW;
    layout.cssH = cssH;
    layout.dirty = false;
  }

  function syncLayout() {
    const dpr = window.devicePixelRatio || 1;
    if (layout.dirty || dpr !== layout.dpr || layout.scale !== (committedScale || 100)) resizeBitmaps();
    // 落在一个整设备像素上，避免合成器对画布做分数像素重采样。
    const left = Math.round((window.innerWidth - layout.cssW) / 2 * layout.dpr) / layout.dpr;
    if (left !== layout.left) {
      layout.left = left;
      const text = left + 'px';
      canvas.style.left = text;
      if (glCanvas) glCanvas.style.left = text;
    }
  }

  function applyScale(animate) {
    const next = scalePercent();
    if (!committedScale || !animate) {
      clearTimeout(commitTimer);
      commitTimer = 0;
      commitDue = false;
      targetScale = next;
      committedScale = next;
      layout.dirty = true;
      setStageTransform('none', false);
      resizeBitmaps();
      syncLayout();
      return;
    }
    targetScale = next;
    if (next === committedScale) {
      clearTimeout(commitTimer);
      commitTimer = 0;
      commitDue = false;
      setStageTransform('none', false);
      return;
    }
    // 180ms 内仍用 transform 缩放旧位图（与主进程窗口补间同步），结束后再换位图。
    setStageTransform('scale(' + (next / committedScale).toFixed(5) + ')', true);
    clearTimeout(commitTimer);
    commitTimer = setTimeout(function () {
      commitTimer = 0;
      commitDue = true;
    }, 260);
  }

  function onStageTransitionEnd(event) {
    if (event.target !== canvas) return;
    if (event.propertyName !== 'transform') return;
    if (!commitTimer) return;
    clearTimeout(commitTimer);
    commitTimer = 0;
    commitDue = true;
  }

  function featureState(kind) {
    // 测试钩子：window.__petForceDegrade 只用于验收时演练降级上报链路。
    if (window.__petForceDegrade === true) return 'degraded';
    if (kind === 'sharp') {
      if (settings.sharpRender !== true) return 'off';
      // 高清 v2：'on' = 正在用预计算放大图集；'degraded' = 预计算失败已回落。
      if (!hd.want) return 'off';
      if (hd.status === 'ready') return 'on';
      if (hd.status === 'degraded') return 'degraded';
      return 'off';
    }
    if (!fx.wantInterp) return 'off';
    if (fx.inst && !fx.degraded && !fx.failed) return 'on';
    return 'degraded';
  }

  function publishPerf() {
    const next = {
      sharp: featureState('sharp'),
      interp: featureState('interp'),
      fps: interpTargetFps(),
      hd: hd.status,
      hdProgress: hd.status === 'ready' ? 100 : hd.progress,
      hdReason: hd.reason || ''
    };
    if (reported.sharp === next.sharp && reported.interp === next.interp && reported.fps === next.fps
      && reported.hd === next.hd && reported.hdProgress === next.hdProgress
      && reported.hdReason === next.hdReason) return;
    reported.sharp = next.sharp;
    reported.interp = next.interp;
    reported.fps = next.fps;
    reported.hd = next.hd;
    reported.hdProgress = next.hdProgress;
    reported.hdReason = next.hdReason;
    send(IPC.PERF, next);
  }

  function ensureFx() {
    if (fx.inst || fx.degraded || fx.failed) return;
    if (window.__petForceDegrade === true) {
      fx.degraded = true;
      return;
    }
    const factory = window.PetFx;
    if (!factory) {
      fx.failed = true;
      return;
    }
    const element = document.createElement('canvas');
    element.id = 'pet-gl';
    element.setAttribute('aria-hidden', 'true');
    let instance = null;
    try {
      instance = factory.create(element);
    } catch (err) {
      instance = null;
    }
    if (!instance) {
      console.warn('[pet] gpu layer unavailable, staying on 2d');
      fx.failed = true;
      return;
    }
    glCanvas = element;
    document.body.insertBefore(element, canvas);
    fx.inst = instance;
    // R10：上下文恢复后复位降级结论，并把图集/光流重新推给重建出来的纹理。
    if (typeof instance.onRestore === 'function') {
      instance.onRestore(function () {
        lostSince = 0;
        fx.degraded = false;
        fx.failed = false;
        flowKey = '';
        flowData = null;
        if (hd.ready && hd.image) instance.setAtlas(hd.image);
        else if (atlas) instance.setAtlas(atlas);
        publishPerf();
      });
    }
    glCanvas.style.transform = canvas.style.transform;
    lastTransform = canvas.style.transform;
    resizeBitmaps();
    syncLayout();
    if (hd.ready && hd.image) instance.setAtlas(hd.image);
    else if (atlas) instance.setAtlas(atlas);
    flowKey = '';
  }

  function dropFx() {
    if (fx.inst) {
      try {
        fx.inst.dispose();
      } catch (err) {
        // 上下文已经丢失时 dispose 可能抛错，忽略即可。
      }
      fx.inst = null;
    }
    if (glCanvas && glCanvas.parentNode) glCanvas.parentNode.removeChild(glCanvas);
    glCanvas = null;
    fx.glowOn = false;
    flowKey = '';
    flowData = null;
  }

  function syncFx() {
    fx.wantInterp = settings.smartInterp === true;
    if (window.__petForceDegrade === true) {
      fx.degraded = true;
      dropFx();
      publishPerf();
      return;
    }
    // 补帧是唯一还需要 GPU 的能力：高清走 2D canvas，不再创建 GL 上下文。
    if (!fx.wantInterp) {
      dropFx();
      // 关掉补帧视为放弃本轮的降级结论：清掉失败记忆，下次打开时重新尝试建 GPU 层。
      fx.degraded = false;
      fx.failed = false;
      publishPerf();
      return;
    }
    ensureFx();
    publishPerf();
  }

  let hdBuildToken = 0;
  let hdRetryTimer = null, hdRetryKey = '', hdRetryAttempts = 0;
  function scheduleHdRecovery(key) {
    if (hdRetryKey !== key) { clearTimeout(hdRetryTimer); hdRetryTimer = null; hdRetryKey = key; hdRetryAttempts = 0; }
    if (hdRetryTimer || hdRetryAttempts >= 2) return;
    hdRetryAttempts++;
    hdRetryTimer = setTimeout(function () {
      hdRetryTimer = null;
      if (hd.key !== key || hd.status !== 'degraded') return;
      hd.key = ''; hd.failed = false; syncHd();
    }, 15000 * hdRetryAttempts);
  }
  function sourceScale(image) { return ACTIONS.sourceScale ? ACTIONS.sourceScale(image) : 1; }
  // R1：单条 base64 字符串超过 32MB 就不写缓存（IPC put 契约仍是 dataUrl 字符串不变，阈值由 lib/hd-cache 另一轨把关）。
  const HD_CACHE_MAX_CHARS = 32 * 1024 * 1024;
  let hdCacheSkip = false;
  // 因源图集/键在构建期间变化而跳过写缓存的次数：只留前几条痕迹，真机上不能刷屏。
  let hdStaleTrace = 0;
  // R14：构建分片预算 8ms（pet-hd 的 BUDGET_MS），单帧重采样超过 2 倍预算说明这台机器撑不住高清，计一次降级。
  const HD_SLICE_LIMIT_MS = 16;

  // R2：建图集之前要能问到纹理上限。真实上下文优先，其次 pet-fx 的探针（探针结果是缓存值）。
  function maxTextureLimit() {
    if (fx.inst && typeof fx.inst.maxTexture === 'function') {
      const live = fx.inst.maxTexture();
      if (live > 0) return live;
    }
    const factory = window.PetFx;
    if (factory && typeof factory.maxTexture === 'function') {
      const probed = factory.maxTexture();
      if (probed > 0) return probed;
    }
    return 0;
  }

  // R19 + R2：返回 '' 表示可以建；否则是不建的理由。
  // R19 看真实格子宽（小窗格建了也没用），R2 看真正要建的分桶图集尺寸。
  function hdSkipReason(geo, bucket) {
    if (!(geo.cellW >= HD_MIN_CELL_W)) return 'cell-too-small';
    const limit = maxTextureLimit();
    if (limit > 0) {
      const atlasW = ACTIONS.ATLAS_COLUMNS * bucket.cellW;
      const atlasH = ACTIONS.ATLAS_ROWS * bucket.cellH;
      if (atlasW > limit || atlasH > limit) return 'atlas-too-big';
    }
    return '';
  }

  function interpMult() {
    const raw = Number(settings.smartInterpMult);
    if (INTERP_MULT.indexOf(raw) >= 0) return raw;
    // 老配置只存了 smartInterpFps：沿用与 lib/config.js 一致的折算（24→×2 / 30→×3 / 60→×4）。
    return LEGACY_FPS_MULT[Math.round(Number(settings.smartInterpFps))] || INTERP_MULT[1];
  }

  // 上报给设置页的等效帧率＝倍数×源帧率，源帧率取最近一帧时长（未知按 100ms≈10fps）。
  function interpTargetFps() {
    const ms = lastSourceMs > 0 ? lastSourceMs : 100;
    return Math.round((interpMult() * 1000) / ms);
  }

  function currentPetId() {
    const pet = pickPet(pets, settings.petId);
    if (pet && pet.id) return String(pet.id);
    return settings.petId ? String(settings.petId) : 'default';
  }

  // 当前宠物要的图集地址。atlas 是异步载入的，只有 atlasUrl 等于它时 atlas 才是这只宠物的图素。
  function currentAtlasUrl() {
    const pet = pickPet(pets, settings.petId);
    if (pet && typeof pet.atlasUrl === 'string' && pet.atlasUrl) return pet.atlasUrl === atlasFallbackFrom && pet.fallbackAtlasUrl ? pet.fallbackAtlasUrl : pet.atlasUrl;
    return '';
  }

  // 图集是否已经换成当前宠物的。没换好就起高清构建，等于拿旧图素去配新宠物的键
  // （真机踩过：小猫的图素写进白月魁的键，之后一直命中，A 宠物显示成 B 的图集）。
  function atlasReadyForCurrentPet() {
    if (!atlas) return false;
    const want = currentAtlasUrl();
    return !want || atlasUrl === want;
  }

  function hdGeometry() {
    // 图集格子按帧尺寸放大：格子高度对应 208 逻辑像素，而不是整块 328 的舞台。
    const cellW = canvas.width;
    return {
      bw: canvas.width,
      bh: canvas.height,
      cellW: cellW,
      cellH: Math.max(1, Math.round(FRAME_HEIGHT * cellW / WIDTH))
    };
  }

  // R3（改口径：几何分桶，不用预设档）。滑块是 1% 步进任意整数，若用「scale ∈ 预设档」当判据，
  // 135% 这类档位永远建不出图集。改为把宽度量化到桶：同桶内拖动只改贴图显示尺寸（贴图仍是
  // 目标设备像素 1:1 绘制，不引入 CSS 缩放），只有跨桶才重建。
  // 桶宽 48：50%→150% 的格子宽是 96..288px，实测 32px 桶会重建 7 次（超出预期的 3–5），
  // 48px 桶落在 5 次（96/144/192/240/288），浪费上限 48px。见 _probe/t_hd_bucket.js。
  const HD_BUCKET_PX = 48;

  // §8.3（方案 PET-HD-RD-001）：命中键必须带算法/管线版本。重采样实现、预乘口径、NEAREST 中间层
  // 任何一处改动都会让旧图集与新画质对不上，旧缓存必须自然失效而不是继续被命中。改了 pet-hd.js 的
  // 重采样逻辑就把这个数字 +1（不写清理脚本：换键后旧文件靠 lib/hd-cache 的 LRU 自然淘汰）。
  const HD_PIPELINE_VERSION = 6;

  function bucketOf(value, step) {
    const size = Math.ceil(Math.max(0, Number(value) || 0) / step) * step;
    return Math.max(step, Math.round(size));
  }

  // 只量化宽度：格子高按同一比例由宽推出（与 frameHeight 一致），避免两个轴各自跨桶把重建次数翻倍。
  function hdBucketGeometry(geo) {
    const bw = bucketOf(geo.bw, HD_BUCKET_PX);
    const cellW = bw;
    return {
      bw: bw,
      bh: geo.bh,
      cellW: cellW,
      cellH: Math.max(1, Math.round(FRAME_HEIGHT * cellW / WIDTH))
    };
  }

  // R9：图集指纹（加载后尺寸）也进 key——同一只宠物换了图集、或换宠但外部尺寸相同，都能区分开。
  function hdKeyOf(petId, geo, image) {
    const src = image || atlas;
    const sig = src && src.naturalWidth > 0 ? src.naturalWidth + 'x' + src.naturalHeight : 'none';
    // R3：键只认分桶后的格子尺寸（桶内拖动不变），不能拼真实 bw/bh——那会每 1% 都换键、退回每次重建。
    // §8.3：末尾拼管线版本，重采样一改就换键，旧图集不再被命中。
    // 分隔符只用 - 与 x：lib/hd-cache.js 的 KEY_PATTERN 只允许 [A-Za-z0-9._@-]，键要塞进文件名，
    // 用 # 或 / 会被判 bad-key、缓存一条都写不进去（键必须在生产侧自证合法，不放宽 KEY_PATTERN）。
    return petId + '@' + geo.cellW + 'x' + geo.cellH + '-' + sig + '-v' + HD_PIPELINE_VERSION
      + '-' + (qualityModule ? qualityModule.signature(settings) : 's0-l0');
  }

  function hdCacheRequest(payload) {
    return new Promise(function (resolve) {
      let pending = null;
      try {
        pending = ipc.invoke(IPC.HD_CACHE, payload);
      } catch (err) {
        resolve(null);
        return;
      }
      if (!pending || typeof pending.then !== 'function') {
        resolve(null);
        return;
      }
      pending.then(function (result) {
        resolve(result && typeof result === 'object' ? result : null);
      }, function () {
        // 主进程没注册通道或缓存目录不可用：当作未命中，不影响高清本身可用。
        resolve(null);
      });
    });
  }

  function traceHdStale(key) {
    if (hdStaleTrace >= 5) return;
    hdStaleTrace += 1;
    // 正常一次切换最多留一条；短时间连续多条才是异常抖动。
    console.debug('[pet] hd cache write skipped: source/key changed during build key=' + key);
  }

  function dropHd() {
    hdBuildToken += 1;
    hd.key = '';
    hd.source = null;
    hd.image = null;
    hd.ready = false;
    hd.building = false;
    hd.failed = false;
    hd.cacheHit = false;
    hd.bytes = 0;
    hd.progress = 0;
    hd.status = 'idle';
    if (fx.inst && atlas) fx.inst.setAtlas(atlas);
  }

  function finishHd(token, key, result, geo) {
    if (token !== hdBuildToken || hd.key !== key) return;
    // 构建期间源图集被换掉了：这批像素属于旧宠物，装上去就是"A 显示成 B 的图集"。
    // 作废这次产物、退回 preparing，让 syncHd 用新图集新键重建。
    if (hd.source && atlas && hd.source !== atlas) {
      hd.image = null;
      hd.ready = false;
      hd.building = false;
      hd.status = 'preparing';
      hd.progress = 0;
      traceHdStale(key);
      publishPerf();
      return;
    }
    hd.image = result.image;
    hd.cellW = result.cellW || geo.cellW;
    hd.cellH = result.cellH || geo.cellH;
    hd.ready = true;
    hd.building = false;
    hd.failed = false;
    hd.status = 'ready';
    hd.reason = '';
    hd.progress = 100;
    hd.cacheHit = result.fromCache === true;
    hd.bytes = result.bytes || 0;
    // R14：构建期耗时从 pet-hd 的 payload 里带过来（缓存命中时为 0），单独计入降级判定。
    hd.buildMs = Number(result.buildMs) || 0;
    hd.sliceMs = Number(result.sliceMs) || 0;
    if (fx.inst) fx.inst.setAtlas(hd.image);
    if (fx.inst && fx.inst.atlasTooBig === true) {
      // 图集超出 GPU 纹理上限：不报 ready，回落运行时缩放，宠物必须仍然可见
      hd.image = null;
      hd.ready = false;
      hd.failed = true;
      hd.status = 'degraded';
      hd.progress = 100;
      hd.cellW = 0;
      hd.cellH = 0;
      fx.inst.setAtlas(atlas);
      flowKey = '';
      console.warn('[pet] hd atlas ' + geo.cellW + 'x' + geo.cellH
        + ' exceeds MAX_TEXTURE_SIZE, falling back to runtime scaling key=' + key);
      publishPerf();
      return;
    }
    if (hd.sliceMs > HD_SLICE_LIMIT_MS) {
      // R14：一片就超过两倍预算，说明这档尺寸在本机重采样不动——直接降级回落运行时缩放，别每帧硬扛。
      console.warn('[pet] hd build slice too slow, degrading', hd.sliceMs + 'ms', 'key=' + key);
      suspendHd(key, 'degraded', 'build-slow');
      scheduleHdRecovery(key);
      return;
    }
    clearTimeout(hdRetryTimer); hdRetryTimer = null; hdRetryKey = ''; hdRetryAttempts = 0;
    flowKey = '';
    console.info('[pet] hd atlas ' + (hd.cacheHit ? 'cache hit' : 'built')
      + ' cell=' + hd.cellW + 'x' + hd.cellH + ' key=' + key);
    publishPerf();
  }

  function failHd(token, key, err) {
    if (token !== hdBuildToken || hd.key !== key) return;
    hd.image = null;
    hd.source = atlas;
    hd.ready = false;
    hd.building = false;
    hd.failed = true;
    hd.status = 'degraded';
    hd.progress = 0;
    hd.cellW = 0;
    hd.cellH = 0;
    if (fx.inst && atlas) fx.inst.setAtlas(atlas);
    console.warn('[pet] hd atlas unavailable, keeping runtime scaling', err);
    scheduleHdRecovery(key);
    publishPerf();
  }

  function loadHdAtlas(url, geo, fromCache, bytes) {
    return new Promise(function (resolve, reject) {
      const image = new Image();
      image.onload = function () {
        resolve({ image: image, cellW: geo.cellW, cellH: geo.cellH, fromCache: fromCache, bytes: Number(bytes) > 0 ? Number(bytes) : 0 });
      };
      image.onerror = function () {
        reject(new Error('hd atlas decode failed'));
      };
      image.src = url;
    });
  }

  // R1：编码不能整块阻塞渲染线程。toBlob 把 PNG 编码交给浏览器（主线程单次阻塞≈0），
  // 再用 FileReader 异步读成 data URL；IPC put 契约仍是 dataUrl 字符串，不变。
  // 拿不到 toBlob/FileReader 时才退回 toDataURL，并把那次同步耗时记进 hd.encodeMs 供验收。
  function encodeAtlasDataUrl(element) {
    return new Promise(function (resolve) {
      const started = performance.now();
      const finish = function (value) {
        hd.encodeMs = Math.round(performance.now() - started);
        resolve(typeof value === 'string' ? value : '');
      };
      try {
        if (element && typeof element.toBlob === 'function' && typeof FileReader !== 'undefined') {
          element.toBlob(function (blob) {
            if (!blob) {
              finish('');
              return;
            }
            try {
              const reader = new FileReader();
              reader.onload = function () { finish(typeof reader.result === 'string' ? reader.result : ''); };
              reader.onerror = function () { finish(''); };
              reader.readAsDataURL(blob);
            } catch (err) {
              finish('');
            }
          }, 'image/png');
          return;
        }
      } catch (err) {
        // 落到下面的同步编码
      }
      let dataUrl = '';
      try {
        dataUrl = element.toDataURL('image/png');
      } catch (err) {
        dataUrl = '';
      }
      finish(dataUrl);
    });
  }

  function buildHdAtlas(key, geo, source) {
    const factory = petHdModule;
    if (!factory || typeof factory.create !== 'function') return Promise.reject(new Error('PetHd unavailable'));
    // 源图集由 startHd 钉住传进来：构建期间模块级 atlas 可能被换成另一只宠物的图素。
    const src = source || atlas;
    if (!src) return Promise.reject(new Error('source atlas unavailable'));
    const builder = factory.create();
    return builder.build({
      image: src,
      cellWidth: geo.cellW,
      columns: ACTIONS.ATLAS_COLUMNS,
      rows: ACTIONS.ATLAS_ROWS,
      quality: settings,
      isCancelled: function () { return hd.key !== key || atlas !== src; },
      onProgress: function (value) {
        if (hd.key !== key) return;
        const next = Math.max(1, Math.min(99, Math.round(value)));
        if (next === hd.progress) return;
        hd.progress = next;
        publishPerf();
      }
    }).then(function (result) {
      if (!result || !result.canvas) throw new Error('hd build produced nothing');
      const payload = {
        image: result.canvas,
        cellW: result.cellW,
        cellH: result.cellH,
        fromCache: false,
        bytes: 0,
        buildMs: Number(result.buildMs) || 0,
        sliceMs: Number(result.sliceMs) || 0
      };
      return encodeAtlasDataUrl(result.canvas).then(function (dataUrl) {
        // 写缓存前校验「键 ↔ 图素」的绑定：源图集已被换掉（atlas !== src）或键已被更新（hd.key !== key）时，
        // 这批像素不属于这个键，宁可这次不缓存，也不要把缓存污染成永久命中的错误图集。
        if (atlas !== src || hd.key !== key) {
          hdCacheSkip = true;
          traceHdStale(key);
          return payload;
        }
        if (!dataUrl) return payload;
        // R1：单条字符串超过 32MB 就不写缓存（阈值另一端由 lib/hd-cache 把关，这里只保证不把巨串塞进 IPC）。
        if (dataUrl.length > HD_CACHE_MAX_CHARS) {
          hdCacheSkip = true;
          console.warn('[pet] hd atlas dataUrl too large, skip cache write', dataUrl.length);
          return payload;
        }
        hdCacheSkip = false;
        return hdCacheRequest({ action: 'put', key: key, dataUrl: dataUrl }).then(function (ack) {
          payload.bytes = ack && Number(ack.bytes) > 0 ? Number(ack.bytes) : Math.round(dataUrl.length * 0.75);
          return payload;
        });
      });
    });
  }

  function startHd(key, geo) {
    hdBuildToken += 1;
    const token = hdBuildToken;
    // 钉住本次构建的源图集：图集是异步换的，跑的过程中换成另一只宠物时，
    // 那批像素属于旧宠物，绝不能配新键写进缓存。
    const source = atlas;
    const keepPrevious = hd.source === source && hd.ready && hd.image;
    const previousImage = keepPrevious ? hd.image : null;
    hd.key = key;
    hd.source = source;
    // Same-character adjustments keep the current material until the next one
    // is ready, avoiding a flash back to the untreated sprite while rebuilding.
    hd.image = previousImage;
    hd.ready = !!previousImage;
    hd.building = true;
    hd.failed = false;
    hd.cacheHit = false;
    hd.bytes = 0;
    hd.progress = 0;
    hd.status = 'preparing';
    hd.reason = '';
    publishPerf();
    hdCacheRequest({ action: 'get', key: key }).then(function (hit) {
      if (token !== hdBuildToken) return null;
      if (hit && typeof hit.url === 'string' && hit.url) return loadHdAtlas(hit.url, geo, true, hit.bytes);
      return buildHdAtlas(key, geo, source);
    }).then(function (result) {
      if (!result) return;
      finishHd(token, key, result, geo);
    }).catch(function (err) {
      failHd(token, key, err);
    });
  }

  // R2/R3/R19：清掉在跑的构建并把 HD 收成"不建"状态——不读缓存、不写缓存、不建图集。
  function suspendHd(key, status, reason) {
    hdBuildToken += 1;
    hd.key = key;
    hd.source = atlas;
    hd.image = null;
    hd.ready = false;
    hd.building = false;
    hd.failed = false;
    hd.cellW = 0;
    hd.cellH = 0;
    hd.progress = 0;
    hd.cacheHit = false;
    hd.bytes = 0;
    hd.status = status;
    hd.reason = reason;
    if (fx.inst && atlas) fx.inst.setAtlas(atlas);
    publishPerf();
  }

  function syncHd() {
    const want = (settings.sharpRender === true || settings.characterLighting === true) && !!activePet;
    hd.want = want;
    if (!want) {
      if (hd.status !== 'idle' || hd.ready || hd.building || hd.image) {
        dropHd();
        publishPerf();
      }
      return;
    }
    // 图集还没载入、或还没换成当前宠物的：此刻起构建就是「旧图素配新键」，宁可等这一次。
    // useAtlas 载入完成会再调 syncHd，渲染循环也会在键不一致时补调，所以直接返回不会卡死。
    if (!atlasReadyForCurrentPet()) {
      // 手上的高清图属于旧图素：先收回，别让它继续以 ready 状态顶着（等新图集载入再重建）。
      if (hd.ready || hd.image) {
        hd.image = null;
        hd.ready = false;
        if (fx.inst) fx.inst.setAtlas(atlas);
      }
      if (hd.status !== 'preparing' || hd.progress !== 0) {
        hd.status = 'preparing';
        hd.progress = 0;
        publishPerf();
      }
      return;
    }
    const geo = hdGeometry();
    const bucket = hdBucketGeometry(geo);
    const key = hdKeyOf(currentPetId(), bucket);
    // 键相同且源图集没换过：已建好、建失败、或已判过降级/降档的系统不再重复触发。
    // R3：同桶内拖动滑块时 bw 分桶不变 -> 键不变 -> 这里直接返回，贴图保持 ready，只由绘制改变显示尺寸。
    if (hd.key === key && hd.source === atlas
      && (hd.building || hd.ready || hd.failed || hd.status === 'degraded' || hd.status === 'runtime')) return;
    // R2/R19：这一档根本不该建（cell 太小、图集超 GPU 上限）时，连缓存都不读不写，直接落 degraded。
    const skipReason = hdSkipReason(geo, bucket);
    if (skipReason) {
      suspendHd(key, 'degraded', skipReason);
      return;
    }
    if (hd.image) {
      hd.image = null;
      hd.ready = false;
      if (fx.inst) fx.inst.setAtlas(atlas);
    }
    startHd(key, bucket);
  }

  function degradeNow() {
    if (fx.degraded) return;
    slowStart = 0;
    console.warn('[pet] gpu path over budget, falling back to 2d');
    fx.degraded = true;
    dropFx();
    publishPerf();
  }

  function sampleFrame(started) {
    const ms = performance.now() - started;
    frameMs.push(ms);
    if (frameMs.length > 120) frameMs.shift();
    // 高清预计算在渲染线程分片跑，它的耗时不算补帧超预算，避免误降级。
    if (!fx.inst || fx.degraded || hd.building) {
      slowStart = 0;
      return;
    }
    if (ms > SLOW_FRAME_MS) {
      if (!slowStart) slowStart = started;
      else if (started - slowStart >= SLOW_SPAN_MS) degradeNow();
    } else {
      slowStart = 0;
    }
  }

  function percentile(list, ratio) {
    if (!list.length) return 0;
    const sorted = list.slice().sort(function (a, b) { return a - b; });
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
  }

  window.__petFxState = function () {
    return {
      sharp: featureState('sharp'),
      interp: featureState('interp'),
      fps: interpTargetFps(),
      interpMult: interpMult(),
      hd: hd.status,
      hdProgress: hd.status === 'ready' ? 100 : hd.progress,
      hdSource: hd.ready ? 'precomputed' : 'runtime',
      hdCell: hd.ready ? [hd.cellW, hd.cellH] : null,
      hdKey: hd.key || '',
      hdVersion: HD_PIPELINE_VERSION,
      hdCacheHit: hd.cacheHit,
      hdBytes: hd.bytes,
      // R2/R3/R19：跳过/降档原因与上限预判结果（字段只增不删）
      hdReason: hd.reason || '',
      hdCacheSkip: hdCacheSkip,
      // R14：构建期独立计时（总耗时 / 最慢分片 / 编码阻塞），用于验收降级判定
      hdBuildMs: hd.buildMs,
      hdSliceMs: hd.sliceMs,
      hdEncodeMs: hd.encodeMs,
      // R18：几何与分桶（真实设备像素 vs 建图集用的桶尺寸）
      hdGeometry: hdGeometry(),
      hdBucket: hdBucketGeometry(hdGeometry()),
      maxTexture: maxTextureLimit(),
      atlasTooBig: !!(fx.inst && fx.inst.atlasTooBig),
      interpStep: interpStep,
      gpu: !!fx.inst && !fx.degraded,
      degraded: fx.degraded,
      // R10：上下文丢失/恢复的可观测状态（字段只增不删）
      glLost: !!(fx.inst && fx.inst.lost),
      glRestores: fx.inst && typeof fx.inst.restores === 'number' ? fx.inst.restores : 0,
      forced: window.__petForceDegrade === true,
      scale: committedScale,
      bitmap: [canvas.width, canvas.height],
      css: [canvas.style.width, canvas.style.height],
      transform: getComputedStyle(canvas).transform,
      frames: frameMs.length,
      p95: Math.round(percentile(frameMs, 0.95) * 100) / 100,
      // R15：光流重估次数与复用次数（字段只增不删）
      flowComputes: flowComputes,
      flowReuses: flowReuses,
      flow: flowData ? [flowData.cols, flowData.rows] : null,
      shift: flowData && flowData.shift ? flowData.shift.slice() : null,
      confMin: flowData && typeof flowData.confMin === 'number' ? flowData.confMin : null
    };
  };

  // R18：纯函数入口（只读，不改变运行路径），给探针在 node/浏览器里直接断言
  // 取帧、升级光效、缩放、几何分桶与缓存键的行为。
  window.__petInternals = {
    framePhase: framePhase,
    levelUpView: levelUpView,
    scalePercent: scalePercent,
    hdGeometry: hdGeometry,
    hdKeyOf: hdKeyOf
  };

  // Read-only random-playback diagnostics; keep the existing debug entry point.
  // 与 __petFxState 分开挂：那边是渲染/HD 的字段契约，别把演出状态混进去。
  window.__petAutoSequence = function () {
    const at = performance.now();
    return {
      index: autoIndex,
      mode: 'random',
      actions: ACTIONS.AUTO_ACTIONS.slice(),
      current: autoAction,
      playing: current,
      nextInMs: autoNextAt ? Math.max(0, Math.round(autoNextAt - at)) : 0,
      minMs: AUTO_MIN_MS,
      maxMs: AUTO_MAX_MS
    };
  };

  window.__petBehaviorState = function () {
    const at = performance.now();
    const s = behavior ? behavior.state(at) : null;
    const b = bubble ? bubble.state(at) : null;
    const cooldown = s && s.cooldown ? s.cooldown : { hover: 0, burst: 0 };
    return {
      current: s ? s.current : current,
      queued: s ? s.queued.slice() : [],
      lastEvent: s ? s.lastEvent : null,
      roam: { active: roam.active, dir: roam.dir, until: roam.until, leftMs: roam.until ? Math.max(0, Math.round(roam.until - at)) : 0 },
      busy: !!(s && s.busy),
      cooldown: { hover: cooldown.hover || 0, burst: cooldown.burst || 0, inertia: Math.max(0, Math.round(inertiaUntil - at)) },
      hoverAt: s ? s.hoverAt : 0,
      bubble: {
        visible: !!(b && b.visible),
        text: b ? b.text : '',
        edge: b ? b.edge : edgeOf(),
        lines: b && b.lines ? b.lines.slice() : [],
        leftMs: b ? b.left : 0
      },
      priority: s ? s.priority : AMBIENT,
      base: s ? s.base : 'idle',
      oneShot: s ? s.oneShot : '',
      oneShotLeft: s ? s.oneShotLeft : 0
    };
  };

  function pickPet(list, petId) {
    if (!Array.isArray(list)) return null;
    let fallback = null;
    for (let i = 0; i < list.length; i += 1) {
      const pet = list[i];
      if (!pet || typeof pet.atlasUrl !== 'string' || !pet.atlasUrl) continue;
      if (!fallback) fallback = pet;
      if (pet.id === petId) return pet;
    }
    return fallback;
  }

  function scanFrames(image) {
    try {
      const sheetWidth = image.naturalWidth;
      const sheetHeight = image.naturalHeight;
      if (!(sheetWidth > 0) || !(sheetHeight > 0)) throw new Error('atlas size unavailable');
      // R17：逐帧判空改成在 96×104 缩图上做——原来把整张 1536×1872 图集读成 11.5MB ImageData 再扫 287 万像素。
      const step = (window.PetMotion && window.PetMotion.STEP) || 2;
      const w = Math.round(WIDTH / step);
      const h = Math.round(FRAME_HEIGHT / step);
      const surface = ensureLumaSurface(w, h);
      if (!surface) throw new Error('2d context unavailable');
      const counts = [];
      for (let row = 0; row < ACTIONS.ATLAS_ROWS; row += 1) {
        let count = 0;
        for (let col = 0; col < ACTIONS.ATLAS_COLUMNS; col += 1) {
          const scale = sourceScale(image);
          const x0 = col * ACTIONS.FRAME_WIDTH * scale;
          const y0 = row * ACTIONS.FRAME_HEIGHT * scale;
          if (x0 + ACTIONS.FRAME_WIDTH * scale > sheetWidth || y0 + ACTIONS.FRAME_HEIGHT * scale > sheetHeight) break;
          surface.clearRect(0, 0, w, h);
          surface.imageSmoothingEnabled = true;
          surface.drawImage(image, x0, y0, ACTIONS.FRAME_WIDTH * scale, ACTIONS.FRAME_HEIGHT * scale, 0, 0, w, h);
          const probe = surface.getImageData(0, 0, w, h);
          if (!probe || !probe.data) throw new Error('ImageData unavailable');
          const data = probe.data;
          let opaque = false;
          for (let i = 3; i < data.length; i += 4) {
            if (data[i] > ALPHA_THRESHOLD) {
              opaque = true;
              break;
            }
          }
          if (opaque) count = col + 1;
        }
        counts.push(count);
      }
      console.info('[pet] atlas frames per row: [' + counts.join(',') + ']');
      return counts;
    } catch (err) {
      if (!scanWarned) {
        scanWarned = true;
        console.warn('[pet] frame scan unavailable, frames are not clamped', err);
      }
      return null;
    }
  }

  function clampFrame(frame) {
    if (!framesPerRow) return frame;
    const count = framesPerRow[frame.row];
    if (!(count > 0)) return { row: frame.row, col: 0, x: 0, y: frame.y };
    if (frame.col < count) return frame;
    const col = count - 1;
    return { row: frame.row, col: col, x: ACTIONS.FRAME_WIDTH * col, y: frame.y };
  }

  function readAtlasBytes(url) {
    try {
      return require('fs').readFileSync(require('url').fileURLToPath(url));
    } catch (err) {
      return null;
    }
  }

  function createBlobUrl(bytes) {
    try {
      return URL.createObjectURL(new Blob([bytes], { type: 'image/webp' }));
    } catch (err) {
      return '';
    }
  }

  function releaseSource(blobUrl) {
    if (!blobUrl) return;
    try {
      URL.revokeObjectURL(blobUrl);
    } catch (err) {
      return;
    }
  }

  function useAtlas(url) {
    if (!url || url === atlasUrl || url === atlasLoading) return;
    atlasLoading = url;
    const bytes = readAtlasBytes(url);
    const blobUrl = bytes ? createBlobUrl(bytes) : '';
    const steps = [];
    if (blobUrl) steps.push('blob');
    if (bytes) steps.push('data');
    steps.push('raw');
    const image = new Image();
    let step = 0;
    const sourceOf = function (kind) {
      if (kind === 'blob') return blobUrl;
      if (kind === 'data') return 'data:image/webp;base64,' + bytes.toString('base64');
      return url;
    };
    const assign = function () {
      image.src = sourceOf(steps[step]);
    };
    image.onload = function () {
      releaseSource(blobUrl);
      if (atlasLoading !== url) return;
      atlasLoading = '';
      atlasUrl = url;
      framesPerRow = scanFrames(image);
      atlas = image;
      resetLumaCache();
      flowKey = '';
      flowData = null;
      if (fx.inst) fx.inst.setAtlas(image);
      // 换了源图集：高清图集必须按新图重建（同键也不会命中内存里的旧画布）。
      syncHd();
    };
    image.onerror = function () {
      step += 1;
      if (step < steps.length) {
        assign();
        return;
      }
      releaseSource(blobUrl);
      if (atlasLoading !== url) return;
      atlasLoading = '';
      console.error('[pet] atlas load failed', url);
      const pet = pickPet(pets, settings.petId);
      if (pet && pet.fallbackAtlasUrl && pet.fallbackAtlasUrl !== url) { atlasFallbackFrom = url; useAtlas(pet.fallbackAtlasUrl); }
    };
    assign();
  }

  function currentPetName() {
    const pet = pickPet(pets, settings.petId);
    if (pet && pet.name) return String(pet.name);
    return settings.petName || '';
  }

  function applyState(next) {
    if (!next || typeof next !== 'object') return;
    const prevAuto = settings.autoPlay;
    const prevAction = settings.action;
    if (next.settings && typeof next.settings === 'object') {
      Object.keys(next.settings).forEach(function (key) {
        if (next.settings[key] !== undefined) settings[key] = next.settings[key];
      });
    }
    if (next.growth && typeof next.growth === 'object') {
      const level = Number(next.growth.level);
      if (isFinite(level) && level > 0) growth.level = Math.floor(level);
    }
    if (Array.isArray(next.pets)) pets = next.pets;
    const pet = pickPet(pets, settings.petId);
    activePet = pet || null;
    if (pet) {
      useAtlas(currentAtlasUrl());
    } else {
      // R9：一只可用宠物都没有时不动 atlas，显式告警并放弃 HD，继续按 2D 路径画。
      console.warn('[pet] no pet with atlas available, HD disabled and keep 2D rendering');
      dropHd();
    }
    if (!settings.showKeyHints) bubbles.clear();
    applyScale(true);
    syncFx();
    syncHd();
    const petName = currentPetName();
    canvas.setAttribute('aria-label', petName ? 'Friend ' + petName : 'Friend');

    if (bubble) bubble.setEdge(edgeOf());

    const autoChanged = settings.autoPlay !== prevAuto;
    if (autoChanged) {
      autoAction = 'idle';
      autoNextAt = 0;
    }
    // 契约 §3：用户发起配置的结果按 P1 走调度，不再直接改 current。
    if (autoChanged || (!settings.autoPlay && settings.action !== prevAction)) {
      request({ kind: 'state', action: baseAction(), priority: 1, source: 'settings' });
    }
  }

  function onInput(msg) {
    if (!msg || typeof msg !== 'object') return;
    const now = performance.now();
    if (msg.kind === 'move' || msg.kind === 'mouse-move' || msg.kind === 'mousemove') {
      // Mouse-follow belongs to the settings preview. Global cursor motion must
      // not replace the desktop's automatic pose or interrupt its actual route.
      return;
    }
    if (msg.kind === 'clear' || !msg.label) {
      bubbles.clear();
      return;
    }
    if (!settings.showKeyHints || document.hidden) return;
    bubbles.add(msg.label, now);
  }

  function onPlay(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (settings.autoPlay) { autoAction = msg.action; autoNextAt = performance.now() + autoDelay(); }
    request({ kind: 'play', action: msg.action, priority: 1, oneShot: !!msg.once, source: 'main' });
  }

  function onLevelUp(msg) {
    if (!msg || typeof msg !== 'object') return;
    const now = Date.now();
    const until = Number(msg.until);
    const level = Number(msg.level);
    levelUpUntil = isFinite(until) && until > now ? until : now + LEVELUP_SPAN;
    levelUpSpan = Math.max(200, Math.min(6000, levelUpUntil - now));
    if (isFinite(level) && level > 0) levelUpLevel = Math.floor(level);
    if (!levelUpLevel) levelUpLevel = growth.level;
  }

  const NOTIFY_ACTIONS = {
    battery: 'failed',
    charging: 'review',
    dpi: 'waiting',
    mode: 'review',
    profile: 'review',
    rgb: 'review',
    level: 'review',
    device: 'waiting',
    connect: 'waving',
    disconnect: 'failed'
  };

  function notifyAction(msg) {
    const raw = msg && typeof msg.action === 'string' ? msg.action : '';
    if (raw && ACTIONS.has(raw)) return raw;
    const kind = msg && typeof msg.kind === 'string' ? msg.kind : '';
    if (NOTIFY_ACTIONS[kind]) return NOTIFY_ACTIONS[kind];
    return msg && msg.critical === true ? 'failed' : 'waving';
  }

  // 契约 §3：主进程事件对象 -> request -> 动作 + 气泡。
  function onNotify(msg) {
    if (!msg || typeof msg !== 'object') return;
    const at = performance.now();
    const action = notifyAction(msg);
    const oneShot = msg.oneShot === undefined
      ? !!(PetBehavior ? PetBehavior.isOneShot(action) : true)
      : !!msg.oneShot;
    const result = request({
      id: typeof msg.id === 'string' ? msg.id : '',
      kind: typeof msg.kind === 'string' && msg.kind ? msg.kind : 'notify',
      action: action,
      priority: msg.priority === undefined ? 2 : Number(msg.priority),
      oneShot: oneShot,
      critical: msg.critical === true,
      ttlMs: Number(msg.ttlMs),
      source: 'main'
    });
    // 契约 §12：设备播报只用主进程下发的 text，不做翻译。
    const text = typeof msg.text === 'string' ? msg.text.trim() : '';
    // 诊断：真实按键/注入的每一次 notify 都留痕（含气泡是否接受、当时窗口可见性）。
    let shown = false;
    if (!text) {
      logNotify({ at: at, kind: msg.kind, text: '', accepted: !!(result && result.accepted), reason: result && (result.reason || result.result), shown: false });
      return;
    }
    if (result && result.accepted) shown = showEventBubble(text, at) !== false;
    logNotify({
      at: at,
      kind: typeof msg.kind === 'string' ? msg.kind : '',
      action: action,
      priority: msg.priority === undefined ? 2 : Number(msg.priority),
      text: text,
      accepted: !!(result && result.accepted),
      reason: result && (result.reason || result.result),
      shown: shown,
      hidden: document.hidden === true,
      visibility: document.visibilityState
    });
  }

  function logNotify(entry) {
    let list = window.__petNotifies;
    if (!Array.isArray(list)) {
      list = [];
      window.__petNotifies = list;
    }
    list.push(entry);
    if (list.length > 24) list.shift();
  }

  function onRoam(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.active === false) {
      endRoam('main', msg.preserveAction === true || !!(pointer && pointer.moved));
      return;
    }
    if (pointer && pointer.moved) return;
    const rawDir = msg.dir !== undefined ? msg.dir : msg.dx;
    const dir = rawDir === 'left' || Number(rawDir) < 0 ? 'left' : 'right';
    const durationMs = Number(msg.durationMs);
    const at = performance.now();
    // 契约 §7：主进程没给 durationMs 也要兜底收尾，绝不留下永久原地跑。
    const span = isFinite(durationMs) && durationMs > 0 ? Math.max(120, durationMs) : ROAM_FALLBACK_MS;
    roam.active = true;
    roam.dir = dir;
    roam.until = at + span;
    request({
      kind: 'roam',
      action: dir === 'left' ? 'running-left' : 'running-right',
      priority: AMBIENT,
      transient: true,
      durationMs: span,
      source: 'main'
    });
    maybeLine('roam');
  }

  // 契约 §7：漫游结束必须回 idle，禁止原地跑。
  function endRoam(reason, preserveAction) {
    if (!roam.active) return;
    roam.active = false;
    roam.dir = '';
    roam.until = 0;
    if (preserveAction || (current !== 'running-left' && current !== 'running-right')) return;
    if (settings.autoPlay) { autoAction = 'idle'; autoNextAt = performance.now() + autoDelay(); }
    request({ kind: 'roam-end', action: 'idle', priority: AMBIENT, transient: true, source: 'main', reason: reason });
  }

  function onPointerDown(event) {
    if (event.button !== 0 || settings.clickThrough) return;
    event.preventDefault();
    // 契约 §6：按下即撤销悬停布防，拖拽期间不再冒出悬停挥手。
    if (!pointer && hoverInside) onHoverOut(performance.now());
    pointer = {
      sx: event.screenX,
      sy: event.screenY,
      lastSX: event.screenX,
      lastSY: event.screenY,
      directionX: event.screenX,
      dragAction: '',
      at: performance.now(),
      moved: false
    };
    pointerSamples.length = 0;
    noteSample(event, pointer.at);
  }

  // 契约 §8：只保留最近 120ms 的位移样本，用于松手时的 {vx,vy}。
  function noteSample(event, at) {
    if (!event || typeof event.screenX !== 'number' || typeof event.screenY !== 'number') return;
    pointerSamples.push({ x: event.screenX, y: event.screenY, at: at });
    while (pointerSamples.length > 2 && at - pointerSamples[0].at > SAMPLE_SPAN_MS) pointerSamples.shift();
  }

  function throwVelocity() {
    // 拿不到样本（少于 2 个点）一律传 0，主进程按轻放处理。
    if (pointerSamples.length < 2) return { vx: 0, vy: 0 };
    const first = pointerSamples[0];
    const last = pointerSamples[pointerSamples.length - 1];
    const span = last.at - first.at;
    if (!(span > 0)) return { vx: 0, vy: 0 };
    return {
      vx: Math.round(((last.x - first.x) * 1000) / span),
      vy: Math.round(((last.y - first.y) * 1000) / span)
    };
  }

  function setBusy(value) {
    if (behavior) behavior.setBusy(value);
  }

  function onPointerMove(event) {
    const at = performance.now();
    if (!pointer) {
      if (!hoverInside) onHoverIn(at);
      return;
    }
    noteSample(event, at);
    const dx = event.screenX - pointer.lastSX;
    const dy = event.screenY - pointer.lastSY;
    pointer.lastSX = event.screenX;
    pointer.lastSY = event.screenY;
    if (!pointer.moved) {
      if (Math.abs(event.screenX - pointer.sx) <= DRAG_PX && Math.abs(event.screenY - pointer.sy) <= DRAG_PX) return;
      pointer.moved = true;
      setBusy(true);
      send(IPC.DRAG_START);
    }
    const directionDx = event.screenX - pointer.directionX;
    if (Math.abs(directionDx) > DRAG_PX) {
      pointer.directionX = event.screenX;
      const action = directionDx < 0 ? 'running-left' : 'running-right';
      if (pointer.dragAction !== action) {
        pointer.dragAction = action;
        request({ kind: 'drag', action: action, priority: 0, transient: true, oneShot: false, source: 'drag' });
      }
    }
    if (dx || dy) send(IPC.DRAG_MOVE, { dx: dx, dy: dy });
  }

  function finishDragFeedback() {
    // Reset the drag pose before draining queued feedback; never leave a stationary run.
    request({ kind: 'drag-end', action: 'idle', priority: 0, transient: true, oneShot: false, source: 'drag' });
    if (settings.autoPlay) {
      autoAction = 'idle';
      if (autoNextAt <= performance.now()) autoNextAt = performance.now() + autoDelay();
    }
    setBusy(false);
  }

  function onPointerUp(event) {
    if (!pointer) return;
    const at = performance.now();
    const dragged = pointer.moved;
    const held = at - pointer.at;
    pointer = null;
    noteSample(event, at);
    if (dragged) {
      const velocity = throwVelocity();
      const speed = Math.sqrt(velocity.vx * velocity.vx + velocity.vy * velocity.vy);
      inertiaUntil = speed >= LIGHT_THROW ? at + INERTIA_MS : 0;
      pointerSamples.length = 0;
      finishDragFeedback();
      send(IPC.DRAG_END, { vx: velocity.vx, vy: velocity.vy });
      return;
    }
    pointerSamples.length = 0;
    // 契约 §5：touchFeedback 关闭时点击反馈整体不生效，在入口早退（与 clickThrough 同层，拖拽不受影响）。
    if (settings.clickThrough || settings.touchFeedback === false || event.button !== 0 || held >= CLICK_MS) return;
    // 契约 §6：单击=waving（双击窗口后结算）、双击=jumping、4s 内第 5 次=failed，全部在 behavior 内。
    if (behavior) behavior.click(at);
    else request({ kind: 'click-fallback', action: 'jumping', priority: 1, oneShot: true, internal: true });
  }

  function onPointerCancel() {
    if (!pointer) return;
    const dragged = pointer.moved;
    pointer = null;
    pointerSamples.length = 0;
    if (dragged) {
      finishDragFeedback();
      send(IPC.DRAG_END, { vx: 0, vy: 0 });
    }
  }

  // 契约 §6：悬停 >=600ms 播一次 waving（同一悬停只一次、移出后冷却），计时与冷却都在 behavior 里。
  function onHoverIn(at) {
    if (settings.clickThrough || settings.touchFeedback === false || hoverInside) return;
    hoverInside = true;
    if (!pointer && behavior) behavior.hover(true, at);
  }

  function onHoverOut(at) {
    if (!hoverInside) return;
    hoverInside = false;
    if (behavior) behavior.hover(false, at);
  }

  function onPointerOver() {
    onHoverIn(performance.now());
  }

  function onPointerOut(event) {
    // 只有真正离开窗口（relatedTarget 为空）才算移出，避免窗口内元素切换反复布防。
    if (event && event.relatedTarget) return;
    onHoverOut(performance.now());
  }

  function onContextMenu(event) {
    event.preventDefault();
    send(IPC.CONTEXT);
  }

  function prevent(event) {
    event.preventDefault();
  }

  function sendReady() {
    if (readySent) return;
    readySent = true;
    send(IPC.READY);
  }

  ipc.on(IPC.STATE, function (event, next) {
    applyState(next);
  });
  ipc.on(IPC.QUALITY_RETRY, function () {
    clearTimeout(hdRetryTimer); hdRetryTimer = null; hdRetryKey = ''; hdRetryAttempts = 0;
    dropHd(); fx.failed = false; fx.degraded = false; syncHd(); syncFx();
  });
  ipc.on(IPC.INPUT, function (event, payload) {
    onInput(payload);
  });
  ipc.on(IPC.PLAY, function (event, payload) {
    onPlay(payload);
  });
  ipc.on(IPC.LEVELUP, function (event, payload) {
    onLevelUp(payload);
  });
  ipc.on(IPC.NOTIFY, function (event, payload) {
    onNotify(payload);
  });
  ipc.on(IPC.ROAM, function (event, payload) {
    onRoam(payload);
  });

  // ---- 宿主 store 广播：DPI 切换只有这一条数据路径（宿主没有 ipc 通道） ----
  // 只转发 id -> HTML，解析留在主进程，那边能脱机测。
  function pickHtmlMap(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    Object.keys(raw).forEach(function (id) {
      const html = raw[id];
      if (typeof html === 'string' && html) out[id] = html;
    });
    return out;
  }

  function onStoreChange(event, payload) {
    const change = payload && typeof payload === 'object' ? payload.changeData : null;
    if (!change || typeof change !== 'object') return;
    // watchAllStore 会广播所有 key，只有这个 key 带宿主通知内容。
    if (change.key !== 'tipsWindowHtmlMap') return;
    send(IPC.PET_TIP, { value: pickHtmlMap(change.value), oldValue: pickHtmlMap(change.oldValue) });
  }

  let hostTipWarned = false;

  // 订阅失败只 warn 一次：DPI 播报静默失效即可，不能影响桌宠其他行为。
  function warnHostTip(err) {
    if (hostTipWarned) return;
    hostTipWarned = true;
    console.warn('[pet] host tip subscribe failed', err);
  }

  function subscribeHostTips() {
    if (hostChannel) {
      const subscription = hostChannel.subscribe({
        ipc: ipc,
        onDevices: function (data) { send(IPC.HOST_STATE, data); },
        onTips: function (data) { send(IPC.PET_TIP, data); },
        onStatus: function (data) { send(IPC.CHANNEL_STATUS, data); },
        warn: warnHostTip
      });
      ipc.on(IPC.RECONNECT, function () { subscription.reconnect(); });
      window.addEventListener('beforeunload', function () { subscription.stop(); clearTimeout(hdRetryTimer); });
      return;
    }
    // 先挂监听再订阅：invoke 返回后立刻到达的第一次变更才不会漏。
    try {
      ipc.on('storeChange', onStoreChange);
    } catch (err) {
      warnHostTip(err);
      return;
    }
    let pending = null;
    try {
      pending = ipc.invoke('watchAllStore');
    } catch (err) {
      warnHostTip(err);
      return;
    }
    if (pending && typeof pending.then === 'function') {
      pending.then(function (res) {
        if (!res || res.success !== true) warnHostTip('watchAllStore rejected by host');
      }).catch(warnHostTip);
    }
  }

  subscribeHostTips();

  window.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerCancel);
  window.addEventListener('pointerover', onPointerOver);
  window.addEventListener('pointerout', onPointerOut);
  window.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('dragstart', prevent);
  window.addEventListener('selectstart', prevent);
  document.addEventListener('visibilitychange', function () {
    lastTs = 0;
    if (document.hidden) {
      bubbles.clear();
      if (bubble) bubble.clear();
    }
  });
  motion.addEventListener('change', function () {
    lastTs = 0;
  });
  canvas.addEventListener('transitionend', onStageTransitionEnd);

  sendReady();

  applyScale(false);
  requestAnimationFrame(render);
})();
