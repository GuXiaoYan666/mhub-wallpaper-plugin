(function () {
  'use strict';

  var VERSION = '3.3.7';
  var PREFIX = '[mhub-wp]';
  var existing = window.__mhubWallpaper;
  if (existing && existing.version === VERSION) {
    try { existing.heal(); } catch (e) { /* ignore */ }
    return;
  }
  if (existing && typeof existing.dispose === 'function') {
    try { existing.dispose(); } catch (e) { /* ignore */ }
  }

  // ---------- 状态 ----------

  var DEFAULT_BEAUTIFY = {
    blur: 0, brightness: 100, dim: 0, saturation: 100,
    scale: 100, fit: 'cover', posX: 50, posY: 50, motion: 'none', speed: 1,
    nativeBlur: 0, nativeBrightness: 50
  };
  var DEFAULT_SPLASH = {
    enabled: true,
    bgMode: 'follow',
    bgId: '',
    bgColor: '#05070c',
    bgBlur: 0,
    bgBrightness: 100,
    bgDim: 12,
    bgSaturation: 100,
    bgScale: 100,
    theme: 'auto',
    glass: true,
    glassOpacity: 55,
    glassBlur: 18,
    glassSaturate: 160,
    glassBackdropBlur: 0,
    speed: 1,
    requireInteraction: true,
    allowSkip: true,
    startMaximized: false,
    sfx: true,
    sfxVolume: 50,
    voice: true,
    voiceSource: 'asset',
    voiceVolume: 90,
    voiceRate: 0.9,
    voicePitch: 0.9,
    identityName: 'MCHOSE USER',
    identityId: 'MCHOSE-01',
    accessLevel: '03',
    accent: '#1f63ff',
    glitchA: '#ff3b30',
    glitchB: '#2971b8'
  };
  var DEFAULT_HOTKEYS = { next: 'Alt+Right', prev: 'Alt+Left', random: 'Alt+R', toggle: 'Alt+P', preview: '' };

  var state = {
    items: [],
    bgId: '',
    enabled: false,
    beautify: Object.assign({}, DEFAULT_BEAUTIFY),
    splash: Object.assign({}, DEFAULT_SPLASH),
    hotkeys: Object.assign({}, DEFAULT_HOTKEYS),
    hotkeyErrors: [],
    error: null
  };
  var mediaInfo = null;
  var thumbCache = {};
  var thumbAsked = {};
  var panel = null;
  var splashPanel = null;
  var panelSig = '';
  var bgEl = null;
  var bgKey = '';
  var bgNode = null;
  var appliedTheme = '';
  var listeners = [];
  var mouseHandler = null;

  function uplink(msg) {
    try { (console.dir || console.log).call(console, PREFIX + JSON.stringify(msg)); } catch (e) { /* ignore */ }
  }

  function on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    listeners.push([target, type, fn, opts]);
  }

  function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }

  // ---------- 主题 ----------

  function luminance(rgb) {
    var m = String(rgb || '').match(/[\d.]+/g);
    if (!m || m.length < 3) return null;
    var a = m.length > 3 ? Number(m[3]) : 1;
    if (!(a > 0.15)) return null;
    return 0.2126 * Number(m[0]) + 0.7152 * Number(m[1]) + 0.0722 * Number(m[2]);
  }

  function detectTheme() {
    var attr = '';
    try {
      attr = document.documentElement.getAttribute('data-theme') ||
        (document.body && document.body.getAttribute('data-theme')) || '';
    } catch (e) { /* ignore */ }
    if (attr === 'light' || attr === 'dark') return attr;
    var seg = document.querySelector('.theme-setting-tabs');
    var segValue = seg && seg.getAttribute('value');
    if (segValue === 'light' || segValue === 'dark') return segValue;
    var candidates = [document.body, document.querySelector('#app'), document.documentElement];
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      if (!el) continue;
      var lum = luminance(getComputedStyle(el).backgroundColor);
      if (lum !== null) return lum < 145 ? 'dark' : 'light';
    }
    return 'dark';
  }

  function accentColor() {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue('--el-color-primary').trim();
      if (/^#|^rgb/.test(v)) return v;
    } catch (e) { /* ignore */ }
    return '#2f6bff';
  }

  // ---------- 背景层 ----------

  function bgHost() {
    return document.querySelector('.app-background') || document.querySelector('.wallpaper-background');
  }

  function scenesEl() {
    return document.querySelector('.wallpaper-background__scenes') ||
      document.querySelector('.wallpaper-background__plane');
  }

  function hideOfficial(active) {
    var sc = scenesEl();
    if (sc) {
      if (active) {
        if (sc.getAttribute('data-mhub-wp-display') === null) {
          sc.setAttribute('data-mhub-wp-display', sc.style.display || '');
        }
        if (sc.style.display !== 'none') sc.style.display = 'none';
        var vids = sc.querySelectorAll('video');
        for (var i = 0; i < vids.length; i++) {
          var v = vids[i];
          if (!v.paused) {
            v.setAttribute('data-mhub-wp-playing', '1');
            try { v.pause(); } catch (e) { /* ignore */ }
          }
        }
      } else {
        var prev = sc.getAttribute('data-mhub-wp-display');
        if (prev !== null) {
          sc.style.display = prev;
          sc.removeAttribute('data-mhub-wp-display');
        }
        var outs = sc.querySelectorAll('video[data-mhub-wp-playing]');
        for (var j = 0; j < outs.length; j++) {
          outs[j].removeAttribute('data-mhub-wp-playing');
          try {
            var p = outs[j].play();
            if (p && typeof p.catch === 'function') p.catch(function () { /* ignore */ });
          } catch (e) { /* ignore */ }
        }
      }
      return;
    }
    var list = document.querySelectorAll('.wallpaper-background__media');
    for (var k = 0; k < list.length; k++) {
      if (active) list[k].style.opacity = '0';
      else if (list[k].getAttribute('data-mhub-wp-hidden')) list[k].style.opacity = '';
      if (active) list[k].setAttribute('data-mhub-wp-hidden', '1');
      else list[k].removeAttribute('data-mhub-wp-hidden');
    }
  }

  function buildBg() {
    var el = document.createElement('div');
    el.id = 'mhub-wp-bg';
    el.setAttribute('data-mhub-wp', '1');
    el.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:0;';

    var media = document.createElement('div');
    media.className = 'mhub-wp-bg__media';
    media.style.cssText = 'position:absolute;inset:0;transform-origin:center;will-change:transform;backface-visibility:hidden;';

    /* 「适应」时用同一张图的放大模糊版垫底，避免出现黑边 */
    var back = document.createElement('div');
    back.className = 'mhub-wp-bg__back';
    back.style.cssText = 'position:absolute;inset:-6%;background-size:cover;background-position:center;' +
      'filter:blur(46px) brightness(.72) saturate(1.08);opacity:0;transition:opacity .45s ease;pointer-events:none;';

    var tint = document.createElement('div');
    tint.className = 'mhub-wp-bg__tint';
    tint.style.cssText = 'position:absolute;inset:0;pointer-events:none;background:#000;opacity:0;';

    el.appendChild(back);
    el.appendChild(media);
    el.appendChild(tint);
    return el;
  }

  function ensureBgState() {
    var active = !!(state.enabled && state.bgId && mediaInfo && mediaInfo.id === state.bgId);
    var host = bgHost();
    try {
      document.documentElement.classList.toggle('mhub-wp-on', !!active);
    } catch (e) { /* ignore */ }
    if (!active || !host) {
      hideOfficial(false);
      if (bgEl && bgEl.parentNode) bgEl.parentNode.removeChild(bgEl);
      bgEl = null;
      bgNode = null;
      bgKey = '';
      return;
    }
    if (!bgEl || !bgEl.parentNode || bgEl.parentElement !== host) {
      if (bgEl && bgEl.parentNode) bgEl.parentNode.removeChild(bgEl);
      bgEl = buildBg();
      /* 插到最前面，保证永远在页面内容之下；并强制整层不参与命中测试。 */
      if (host.firstChild) host.insertBefore(bgEl, host.firstChild);
      else host.appendChild(bgEl);
      bgKey = '';
    } else if (host.firstElementChild !== bgEl) {
      /* 路由切换时官方可能重建/重排背景节点，重新压回最底层。 */
      try { host.insertBefore(bgEl, host.firstChild); } catch (e) { /* ignore */ }
    }
    hideOfficial(true);

    var key = mediaInfo.id + '|' + mediaInfo.kind;
    var media = bgEl.querySelector('.mhub-wp-bg__media');
    if (key !== bgKey) {
      bgKey = key;
      media.textContent = '';
      bgNode = null;
      if (mediaInfo.kind === 'video' && mediaInfo.video) {
        var video = document.createElement('video');
        video.src = mediaInfo.video;
        video.muted = true;
        video.loop = true;
        video.autoplay = true;
        video.preload = 'auto';
        video.setAttribute('playsinline', '');
        video.setAttribute('muted', '');
        video.setAttribute('disablepictureinpicture', '');
        video.style.cssText = 'width:100%;height:100%;display:block;object-fit:cover;transform:translateZ(0);';
        video.poster = mediaInfo.image;
        video.addEventListener('error', function () {
          if (bgNode === video) useImage(media);
        });
        var tryPlay = function () {
          var p = video.play();
          if (p && typeof p.catch === 'function') p.catch(function () { /* wait for gesture */ });
        };
        tryPlay();
        video.addEventListener('loadeddata', tryPlay);
        media.appendChild(video);
        bgNode = video;
      } else {
        useImage(media);
      }
    }
    applyBgStyles();
  }

  /* 场景壁纸（scene.pkg）只有 1024px 左右的 preview 图，铺满 2K 屏必然放大发糊。
     用一个温和的 3×3 卷积做锐化，弥补放大后的细节损失。 */
  function ensureSharpenFilter() {
    if (document.getElementById('mhub-wp-sharpen-def')) return;
    var wrap = document.createElement('div');
    wrap.id = 'mhub-wp-sharpen-def';
    wrap.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;';
    wrap.innerHTML = '<svg width="0" height="0" aria-hidden="true">' +
      '<filter id="mhubWpSharpen" color-interpolation-filters="sRGB">' +
      '<feConvolveMatrix order="3" preserveAlpha="true" edgeMode="duplicate" ' +
      'kernelMatrix="0 -0.3 0 -0.3 2.2 -0.3 0 -0.3 0" />' +
      '</filter></svg>';
    document.body.appendChild(wrap);
  }

  function useImage(media) {
    if (!mediaInfo || !mediaInfo.image) return;
    media.textContent = '';
    ensureSharpenFilter();
    var img = document.createElement('img');
    img.alt = '';
    img.decoding = 'async';
    img.src = mediaInfo.image;
    img.style.cssText = 'width:100%;height:100%;display:block;object-fit:cover;filter:url(#mhubWpSharpen);';
    media.appendChild(img);
    bgNode = img;
    applyBgStyles();
  }

  function effBlur() {
    var b = state.beautify;
    return clamp((Number(b.blur) || 0) + (Number(b.nativeBlur) || 0), 0, 60);
  }

  function effBrightness() {
    var b = state.beautify;
    var native = b.nativeBrightness === undefined ? 50 : Number(b.nativeBrightness);
    return clamp((Number(b.brightness) || 100) * (0.5 + native / 100), 10, 300);
  }

  function currentCrop() {
    var b = state.beautify;
    var fit = b.fit === 'tile' ? 'cover' : b.fit;
    /* 画面位置：拖动预览小窗或滑杆调整裁切区域 */
    var posX = (b.posX === undefined ? 50 : Number(b.posX));
    var posY = (b.posY === undefined ? 50 : Number(b.posY));
    if (!isFinite(posX)) posX = 50;
    if (!isFinite(posY)) posY = 50;
    return {
      fit: fit,
      posX: Math.min(100, Math.max(0, posX)),
      posY: Math.min(100, Math.max(0, posY))
    };
  }

  function applyBgStyles() {
    if (!bgEl) return;
    var b = state.beautify;
    var media = bgEl.querySelector('.mhub-wp-bg__media');
    var tint = bgEl.querySelector('.mhub-wp-bg__tint');
    if (!media || !tint) return;

    var parts = [];
    var blur = effBlur();
    var brightness = Math.round(effBrightness());
    if (blur > 0) parts.push('blur(' + blur + 'px)');
    if (brightness !== 100) parts.push('brightness(' + brightness + '%)');
    if (Number(b.saturation) !== 100) parts.push('saturate(' + b.saturation + '%)');
    media.style.filter = parts.length ? parts.join(' ') : 'none';

    var crop = currentCrop();
    var fit = crop.fit;
    var position = crop.posX + '% ' + crop.posY + '%';
    if (bgNode && bgNode.tagName === 'IMG') {
      bgNode.style.objectFit = fit;
      bgNode.style.objectPosition = position;
    }
    if (bgNode && bgNode.tagName === 'VIDEO') {
      bgNode.style.objectFit = fit;
      bgNode.style.objectPosition = position;
    }

    /* 「适应」= 完整显示：图片按 contain 摆放，空出来的部分用同图模糊填充 */
    var back = bgEl.querySelector('.mhub-wp-bg__back');
    if (back) {
      var containMode = b.fit === 'contain' && mediaInfo && !!mediaInfo.image;
      if (containMode) back.style.backgroundImage = 'url("' + mediaInfo.image + '")';
      back.style.opacity = containMode ? '1' : '0';
    }

    if (b.fit === 'tile' && mediaInfo && mediaInfo.image) {
      media.style.backgroundImage = 'url("' + mediaInfo.image + '")';
      media.style.backgroundRepeat = 'repeat';
      media.style.backgroundSize = (b.scale / 100 * 100) + '% auto';
      if (bgNode) bgNode.style.display = 'none';
    } else {
      media.style.backgroundImage = 'none';
      if (bgNode) bgNode.style.display = '';
    }

    tint.style.opacity = String(b.dim / 100);

    media.style.setProperty('--wp-scale', String(b.scale / 100));
    var speed = clamp(Number(b.speed) || 1, 0.3, 3);

    if (mouseHandler) { window.removeEventListener('mousemove', mouseHandler); mouseHandler = null; }
    media.style.animation = 'none';
    media.style.transform = 'scale(' + (b.scale / 100) + ')';

    if (b.motion === 'kenburns') {
      media.style.animationDuration = (26 / speed) + 's';
      media.style.animation = 'mhubWpKen ' + (26 / speed) + 's ease-in-out infinite alternate';
    } else if (b.motion === 'breathe') {
      media.style.animation = 'mhubWpBreathe ' + (12 / speed) + 's ease-in-out infinite';
    } else if (b.motion === 'parallax') {
      mouseHandler = function (ev) {
        var cx = (ev.clientX / Math.max(1, window.innerWidth) - 0.5) * -16;
        var cy = (ev.clientY / Math.max(1, window.innerHeight) - 0.5) * -16;
        media.style.transform = 'scale(' + (b.scale / 100) + ') translate3d(' + cx + 'px,' + cy + 'px,0)';
      };
      window.addEventListener('mousemove', mouseHandler, { passive: true });
    }
  }

  // ---------- 官方主题滑块联动 ----------

  var nativeCtl = [];

  function paintNative(meta, v) {
    var pct = Math.round(v) + '%';
    if (meta.valueEl) meta.valueEl.textContent = pct;
    try { meta.slider.setAttribute('value', String(v)); } catch (e) { /* ignore */ }
    var ratio = clamp((v - meta.min) / Math.max(1, meta.max - meta.min), 0, 1);
    try { meta.slider.style.setProperty('--du-slider-ratio', String(ratio)); } catch (e) { /* ignore */ }
    try {
      var sr = meta.slider.shadowRoot;
      var wrap = sr && sr.querySelector('.du-slider');
      if (wrap) wrap.style.setProperty('--du-slider-ratio', String(ratio));
    } catch (e) { /* ignore */ }
  }

  function nativeValue() {
    var b = state.beautify;
    if (this.isBlur) return clamp(Number(b.nativeBlur) || 0, this.min, this.max);
    return clamp(b.nativeBrightness === undefined ? 50 : Number(b.nativeBrightness), this.min, this.max);
  }

  function syncNativeControls() {
    for (var i = 0; i < nativeCtl.length; i++) {
      var meta = nativeCtl[i];
      if (!meta.row.isConnected) continue;
      var v = nativeValue.call(meta);
      if (document.activeElement !== meta.input) meta.input.value = String(v);
      paintNative(meta, v);
    }
  }

  /* 官方页面重新挂载时会把「壁纸亮度」重置为 50，这里持续纠回上次保存值 */
  var nativeObserver = null;

  function enforceNative() {
    if (!nativeCtl.length) return;
    var drift = false;
    for (var i = 0; i < nativeCtl.length; i++) {
      var meta = nativeCtl[i];
      if (!meta.row.isConnected) continue;
      var v = nativeValue.call(meta);
      var shown = Math.round(v) + '%';
      if (meta.valueEl && meta.valueEl.textContent !== shown) meta.valueEl.textContent = shown;
      var attr = Number(meta.slider.getAttribute('value'));
      if (!isFinite(attr) || Math.abs(attr - v) > 0.5) {
        paintNative(meta, v);
        drift = true;
      }
      if (document.activeElement !== meta.input && Number(meta.input.value) !== v) meta.input.value = String(v);
    }
    if (drift) ensureBgState();
  }

  function observeNative(meta) {
    if (!('MutationObserver' in window)) return;
    if (!nativeObserver) {
      nativeObserver = new MutationObserver(function () {
        var now = Date.now();
        if (now - nativeEnforceAt < 200) return;
        nativeEnforceAt = now;
        try { enforceNative(); } catch (e) { /* ignore */ }
      });
    }
    nativeObserver.observe(meta.slider, { attributes: true, attributeFilter: ['value'] });
    if (meta.valueEl) {
      nativeObserver.observe(meta.valueEl, { childList: true, characterData: true, subtree: true });
    }
  }

  var nativeEnforceAt = 0;

  var nativeGuardTimer = null;
  function startNativeGuard() {
    if (nativeGuardTimer) return;
    nativeGuardTimer = setInterval(function () {
      try { enforceNative(); } catch (e) { /* ignore */ }
    }, 700);
  }

  function ensureNativeSliders() {
    var rows = document.querySelectorAll('.theme-setting-slider');
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var label = String((row.querySelector('.theme-setting-slider__label') || {}).textContent || '');
      var isBlur = label.indexOf('壁纸模糊度') >= 0;
      var isBright = label.indexOf('壁纸亮度') >= 0;
      if (!isBlur && !isBright) continue;
      if (row.querySelector('.mhub-wp-native')) continue;
      var control = row.querySelector('.theme-setting-slider__control');
      var slider = row.querySelector('du-slider');
      if (!control || !slider) continue;
      var min = Number(slider.getAttribute('min'));
      var max = Number(slider.getAttribute('max'));
      if (!isFinite(min)) min = 0;
      if (!isFinite(max) || max <= 0) max = isBlur ? 50 : 100;
      var meta = {
        row: row,
        slider: slider,
        valueEl: row.querySelector('.theme-setting-slider__value'),
        isBlur: isBlur,
        min: min,
        max: max,
        input: document.createElement('input')
      };
      meta.input.type = 'range';
      meta.input.className = 'mhub-wp-native';
      meta.input.min = String(min);
      meta.input.max = String(max);
      meta.input.step = '1';
      meta.input.setAttribute('aria-label', label);
      var v0 = nativeValue.call(meta);
      meta.input.value = String(v0);
      meta.input.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer;z-index:3;';
      control.style.position = 'relative';
      meta.input.addEventListener('input', function (m) {
        return function () {
          var v = Number(m.input.value);
          if (m.isBlur) state.beautify.nativeBlur = v;
          else state.beautify.nativeBrightness = v;
          paintNative(m, v);
          ensureBgState();
          scheduleSave();
        };
      }(meta));
      /* 滚轮经过滑块时只滚动页面，不改数值 */
      meta.input.addEventListener('wheel', function (ev) {
        ev.preventDefault();
        scrollCardBy(ev.deltaY);
      }, { passive: false });
      control.appendChild(meta.input);
      nativeCtl.push(meta);
      paintNative(meta, v0);
      observeNative(meta);
    }
  }

  // ---------- 面板 ----------

  var KEYWORDS = ['壁纸模糊度', '壁纸亮度', '我的壁纸', '官方壁纸'];

  function findSlot() {
    var ws = document.querySelector('.wallpaper-settings');
    if (ws && ws.parentElement) return ws;
    return findAnchor();
  }

  function findAnchor() {
    var nodes = document.querySelectorAll('body *');
    var hits = [];
    for (var i = 0; i < nodes.length; i++) {
      var e = nodes[i];
      if (e.children.length) continue;
      if (e.closest && e.closest('#mhub-wp-panel')) continue;
      var t = (e.textContent || '').trim();
      if (!t || t.length > 16) continue;
      for (var k = 0; k < KEYWORDS.length; k++) {
        if (t.indexOf(KEYWORDS[k]) >= 0) { hits.push([k, e]); break; }
      }
    }
    if (!hits.length) return null;
    hits.sort(function (a, b) { return a[0] - b[0]; });
    return groupOf(hits[0][1]);
  }

  function groupOf(leaf) {
    var node = leaf;
    var best = leaf.parentElement;
    var vh = window.innerHeight || 800;
    for (var i = 0; i < 7 && node && node.parentElement; i++) {
      var p = node.parentElement;
      var r = p.getBoundingClientRect();
      var cs = getComputedStyle(p);
      var rounded = parseFloat(cs.borderRadius) > 0;
      var named = /card|panel|group|section|box|item|block/i.test(String(p.className || ''));
      if (r.width > 520 && r.height > 54 && r.height < vh * 0.82 && (rounded || named)) {
        best = p;
        break;
      }
      node = p;
    }
    return best;
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  var COLLAPSE_KEY = 'mhubWpCollapse:';

  function readCollapsed(key) {
    try { return localStorage.getItem(COLLAPSE_KEY + key) === '1'; } catch (e) { return false; }
  }

  /* 把面板正文折叠到 mhub-wp-body 中，并加收起按钮；状态记在 localStorage */
  function attachCollapse(sec, head, key, host) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mhub-wp-collapse';
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';

    var wrap = el('div', 'mhub-wp-body');
    var kids = Array.prototype.slice.call(sec.children);
    for (var i = 0; i < kids.length; i++) {
      if (kids[i] !== head) wrap.appendChild(kids[i]);
    }
    sec.appendChild(wrap);

    function paint() {
      var collapsed = sec.classList.contains('is-collapsed');
      btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      btn.title = collapsed ? '展开' : '收起';
    }

    if (readCollapsed(key)) sec.classList.add('is-collapsed');
    paint();
    btn.addEventListener('click', function () {
      var next = !sec.classList.contains('is-collapsed');
      sec.classList.toggle('is-collapsed', next);
      try { localStorage.setItem(COLLAPSE_KEY + key, next ? '1' : '0'); } catch (e) { /* ignore */ }
      paint();
    });
    (host || head).appendChild(btn);
  }

  function slider(label, key, min, max, step, unit) {
    var row = el('div', 'mhub-wp-ctl');
    var head = el('div', 'mhub-wp-ctl__head');
    head.appendChild(el('span', 'mhub-wp-ctl__label', label));
    var val = el('span', 'mhub-wp-ctl__val', '');
    head.appendChild(val);
    var input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.setAttribute('data-wp-key', key);
    input.setAttribute('data-wp-unit', unit || '');
    var sync = function () {
      var n = Number(input.value);
      state.beautify[key] = n;
      val.textContent = n + (unit || '');
      ensureBgState();
      scheduleSave();
    };
    input.addEventListener('input', sync);
    input.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      scrollCardBy(ev.deltaY);
    }, { passive: false });
    row.appendChild(head);
    row.appendChild(input);
    return { row: row, input: input, val: val };
  }

  function select(label, key, options) {
    var row = el('div', 'mhub-wp-ctl');
    var head = el('div', 'mhub-wp-ctl__head');
    head.appendChild(el('span', 'mhub-wp-ctl__label', label));
    var sel = document.createElement('select');
    sel.className = 'mhub-wp-select';
    sel.setAttribute('data-wp-key', key);
    for (var i = 0; i < options.length; i++) {
      var opt = document.createElement('option');
      opt.value = options[i][0];
      opt.textContent = options[i][1];
      sel.appendChild(opt);
    }
    sel.addEventListener('change', function () {
      state.beautify[key] = sel.value;
      ensureBgState();
      scheduleSave();
    });
    row.appendChild(head);
    row.appendChild(sel);
    return { row: row, input: sel };
  }

  /* ---- 快捷键录制 ---- */
  var recording = null;

  function accelFromEvent(ev) {
    var mods = [];
    if (ev.ctrlKey) mods.push('Ctrl');
    if (ev.altKey) mods.push('Alt');
    if (ev.shiftKey) mods.push('Shift');
    if (ev.metaKey) mods.push('Super');
    if (!mods.length) return '';
    var key = ev.key;
    if (!key || /^(Control|Alt|Shift|Meta)$/.test(key)) return '';
    var named = {
      ' ': 'Space', 'ArrowLeft': 'Left', 'ArrowRight': 'Right', 'ArrowUp': 'Up', 'ArrowDown': 'Down',
      'Escape': 'Escape', 'Enter': 'Enter', 'Tab': 'Tab', 'Backspace': 'Backspace', 'Delete': 'Delete'
    };
    var k = named[key] || (key.length === 1 ? key.toUpperCase() : key);
    if (!/^([A-Z0-9]|F([1-9]|1[0-9]|2[0-4])|Left|Right|Up|Down|Space|Enter|Escape|Tab|Backspace|Delete)$/.test(k)) return '';
    return mods.join('+') + '+' + k;
  }

  function stopRecording() {
    if (!recording) return;
    document.removeEventListener('keydown', recording.handler, true);
    recording = null;
  }

  function recordHotkey(action, chip) {
    stopRecording();
    chip.textContent = '按下组合键…';
    var handler = function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.key === 'Escape') {
        stopRecording();
        renderPanel();
        return;
      }
      if (ev.key === 'Backspace' || ev.key === 'Delete') {
        stopRecording();
        var empty = {};
        empty[action] = '';
        uplink({ t: 'hotkeys', payload: empty });
        chip.textContent = '未设置';
        return;
      }
      var accel = accelFromEvent(ev);
      if (!accel) {
        chip.textContent = '需带修饰键';
        return;
      }
      stopRecording();
      var payload = {};
      payload[action] = accel;
      uplink({ t: 'hotkeys', payload: payload });
      chip.textContent = accel;
    };
    recording = { handler: handler };
    document.addEventListener('keydown', handler, true);
  }

  function renderHotkeyRows(refs) {
    if (!refs || !refs.length) return;
    for (var i = 0; i < refs.length; i++) {
      var r = refs[i];
      if (recording) continue;
      var accel = state.hotkeys[r.action] || '';
      r.chip.textContent = accel || '未设置';
      var err = null;
      for (var k = 0; k < (state.hotkeyErrors || []).length; k++) {
        if (state.hotkeyErrors[k].action === r.action) { err = state.hotkeyErrors[k]; break; }
      }
      r.chip.style.borderColor = err ? 'rgba(255,92,92,.65)' : 'rgba(255,255,255,.12)';
      r.chip.style.color = err ? '#ffb4b4' : '#dbe4f4';
      r.chip.title = err
        ? (err.reason === 'occupied' ? '该组合已被其他程序占用' : (err.reason === 'duplicate' ? '与其他动作重复' : '注册失败'))
        : '';
    }
  }

  var saveTimer = null;
  var lastEditAt = 0;
  function scheduleSave() {
    lastEditAt = Date.now();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      var patch = Object.assign({ enabled: state.enabled }, state.beautify);
      uplink({ t: 'beautify', payload: patch });
    }, 180);
  }

  function buildPanel() {
    var sec = el('section', 'mhub-wp-card');
    sec.id = 'mhub-wp-panel';
    sec.setAttribute('data-mhub-wp', '1');

    var head = el('div', 'mhub-wp-head');
    var brand = el('div', 'mhub-wp-brand');
    var mark = el('div', 'mhub-wp-mark');
    mark.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8.6" cy="9" r="1.7"/><path d="M21 15.4 16.2 11 7 20"/></svg>';
    var titles = el('div', 'mhub-wp-titles');
    titles.appendChild(el('h3', 'mhub-wp-title', 'M HUB 壁纸'));
    titles.appendChild(el('p', 'mhub-wp-sub', 'Wallpaper Engine 本地库 · 仅改变 M HUB 界面背景 · 快捷键见下方'));
    brand.appendChild(mark);
    brand.appendChild(titles);

    var switchWrap = el('label', 'mhub-wp-switch');
    var switchInput = document.createElement('input');
    switchInput.type = 'checkbox';
    switchInput.id = 'mhub-wp-enabled';
    switchInput.addEventListener('change', function () {
      state.enabled = switchInput.checked && !!state.bgId;
      ensureBgState();
      renderPanel();
      scheduleSave();
    });
    switchWrap.appendChild(switchInput);
    switchWrap.appendChild(el('span', 'mhub-wp-switch__track'));
    switchWrap.appendChild(el('span', 'mhub-wp-switch__text', '启用'));

    head.appendChild(brand);
    var headActions = el('div', 'mhub-wp-actions');
    headActions.appendChild(switchWrap);
    head.appendChild(headActions);
    sec.appendChild(head);

    var status = el('div', 'mhub-wp-status', '');
    status.id = 'mhub-wp-status';
    sec.appendChild(status);

    var ctl = el('div', 'mhub-wp-ctls');
    var controls = [
      slider('水平位置', 'posX', 0, 100, 1, ' %'),
      slider('垂直位置', 'posY', 0, 100, 1, ' %'),
      slider('模糊', 'blur', 0, 60, 1, ' px'),
      slider('亮度', 'brightness', 20, 180, 1, ' %'),
      slider('暗化', 'dim', 0, 90, 1, ' %'),
      slider('饱和度', 'saturation', 0, 220, 1, ' %'),
      slider('缩放', 'scale', 100, 160, 1, ' %'),
      slider('动效速度', 'speed', 0.3, 3, 0.1, ' ×')
    ];
    var sels = [
      select('填充', 'fit', [['cover', '覆盖'], ['contain', '适应（完整显示）'], ['fill', '拉伸（会变形）'], ['tile', '平铺']]),
      select('动效', 'motion', [['none', '无'], ['kenburns', '缓慢缩放'], ['breathe', '呼吸'], ['parallax', '视差']])
    ];
    for (var i = 0; i < controls.length; i++) ctl.appendChild(controls[i].row);
    for (var j = 0; j < sels.length; j++) ctl.appendChild(sels[j].row);
    sec.appendChild(ctl);

    /* ---- 自定义快捷键 ---- */
    var hkSec = el('div', 'mhub-wp-keys');
    hkSec.style.cssText = 'margin:2px 0 12px;padding:10px 12px;border-radius:10px;' +
      'background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.07);';
    var hkHead = el('div', '', '快捷键（全局生效）');
    hkHead.style.cssText = 'font-size:12px;font-weight:600;letter-spacing:.5px;opacity:.85;margin-bottom:6px;';
    hkSec.appendChild(hkHead);
    var hkDesc = el('div', '', '点击右侧按键后按下组合键即可修改，Esc 取消，Delete 清除');
    hkDesc.style.cssText = 'font-size:11px;opacity:.4;margin-bottom:8px;';
    hkSec.appendChild(hkDesc);

    var HK_ACTIONS = [
      ['prev', '上一张壁纸'],
      ['next', '下一张壁纸'],
      ['random', '随机壁纸'],
      ['toggle', '暂停 / 恢复壁纸'],
      ['preview', '打开裁剪预览']
    ];
    var hkRefs = [];
    for (var hi = 0; hi < HK_ACTIONS.length; hi++) {
      (function (action, label) {
        var row = el('div', '');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;height:30px;';
        var name = el('span', '', label);
        name.style.cssText = 'flex:1;font-size:12px;opacity:.72;';
        var chip = document.createElement('button');
        chip.type = 'button';
        chip.style.cssText = 'min-width:108px;height:24px;padding:0 10px;border-radius:7px;cursor:pointer;' +
          'font-size:11px;letter-spacing:.3px;color:#dbe4f4;background:rgba(255,255,255,.07);' +
          'border:1px solid rgba(255,255,255,.12);font-family:inherit;';
        chip.addEventListener('click', function () { recordHotkey(action, chip); });
        var reset = document.createElement('button');
        reset.type = 'button';
        reset.textContent = '默认';
        reset.style.cssText = 'height:24px;padding:0 8px;border-radius:7px;cursor:pointer;font-size:11px;' +
          'color:#9fb0c8;background:transparent;border:1px solid rgba(255,255,255,.10);font-family:inherit;';
        reset.addEventListener('click', function () {
          var p = {};
          p[action] = DEFAULT_HOTKEYS[action];
          uplink({ t: 'hotkeys', payload: p });
        });
        row.appendChild(name);
        row.appendChild(chip);
        row.appendChild(reset);
        hkSec.appendChild(row);
        hkRefs.push({ action: action, chip: chip });
      })(HK_ACTIONS[hi][0], HK_ACTIONS[hi][1]);
    }
    sec.appendChild(hkSec);

    var toolbar = el('div', 'mhub-wp-toolbar');
    var search = document.createElement('input');
    search.type = 'text';
    search.className = 'mhub-wp-search';
    search.placeholder = '搜索本地壁纸…';
    search.addEventListener('input', function () {
      panelSig = '';
      renderPanel();
    });
    var chips = el('div', 'mhub-wp-chips');
    var previewBtn = el('button', 'mhub-wp-btn mhub-wp-btn--ghost', '裁剪预览');
    previewBtn.type = 'button';
    previewBtn.addEventListener('click', function () {
      uplink({ t: 'preview', payload: { open: true } });
    });
    var refresh = el('button', 'mhub-wp-btn mhub-wp-btn--ghost', '刷新');
    refresh.type = 'button';
    refresh.addEventListener('click', function () { uplink({ t: 'refresh' }); });
    var reset = el('button', 'mhub-wp-btn mhub-wp-btn--ghost', '恢复官方背景');
    reset.type = 'button';
    reset.addEventListener('click', function () {
      state.bgId = '';
      state.enabled = false;
      mediaInfo = null;
      ensureBgState();
      renderPanel();
      uplink({ t: 'reset' });
    });
    var count = el('span', 'mhub-wp-count', '');
    toolbar.appendChild(search);
    toolbar.appendChild(chips);
    toolbar.appendChild(count);
    toolbar.appendChild(previewBtn);
    toolbar.appendChild(refresh);
    toolbar.appendChild(reset);
    sec.appendChild(toolbar);

    var grid = el('div', 'mhub-wp-grid');
    grid.id = 'mhub-wp-grid';
    sec.appendChild(grid);

    var foot = el('div', 'mhub-wp-foot');
    var resetBeauty = el('button', 'mhub-wp-link', '重置美化');
    resetBeauty.type = 'button';
    resetBeauty.addEventListener('click', function () {
      for (var key in DEFAULT_BEAUTIFY) state.beautify[key] = DEFAULT_BEAUTIFY[key];
      ensureBgState();
      panelSig = '';
      renderPanel();
      scheduleSave();
    });
    foot.appendChild(resetBeauty);
    foot.appendChild(el('span', 'mhub-wp-foot__hint', '顶部「壁纸模糊度 / 壁纸亮度」对当前壁纸同样生效；壁纸只应用到 M HUB 界面，不会修改 Windows 桌面壁纸。'));
    sec.appendChild(foot);

    attachCollapse(sec, head, 'wallpaper', headActions);

    panel = sec;
    panel.__refs = {
      status: status, search: search, chips: chips, count: count,
      grid: grid, switchInput: switchInput, controls: controls, sels: sels, hotkeys: hkRefs
    };
    panelSig = '';
    return sec;
  }

  // ---------- 启动页控制面板 ----------

  var splashSaveTimer = null;
  var lastSplashEditAt = 0;

  function saveSplash() {
    lastSplashEditAt = Date.now();
    clearTimeout(splashSaveTimer);
    splashSaveTimer = setTimeout(function () {
      uplink({ t: 'splash', payload: state.splash });
    }, 180);
  }

  function spSlider(label, key, min, max, step, unit) {
    var row = el('div', 'mhub-wp-ctl');
    var head = el('div', 'mhub-wp-ctl__head');
    head.appendChild(el('span', 'mhub-wp-ctl__label', label));
    var val = el('span', 'mhub-wp-ctl__val', '');
    head.appendChild(val);
    var input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.setAttribute('data-sp-key', key);
    input.setAttribute('data-sp-unit', unit || '');
    input.addEventListener('input', function () {
      var n = Number(input.value);
      state.splash[key] = n;
      val.textContent = n + (unit || '');
      saveSplash();
    });
    input.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      scrollCardBy(ev.deltaY);
    }, { passive: false });
    row.appendChild(head);
    row.appendChild(input);
    return { row: row, input: input, val: val };
  }

  function spSelect(label, key, options) {
    var row = el('div', 'mhub-wp-ctl');
    var head = el('div', 'mhub-wp-ctl__head');
    head.appendChild(el('span', 'mhub-wp-ctl__label', label));
    var sel = document.createElement('select');
    sel.className = 'mhub-wp-select';
    sel.setAttribute('data-sp-key', key);
    for (var i = 0; i < options.length; i++) {
      var opt = document.createElement('option');
      opt.value = options[i][0];
      opt.textContent = options[i][1];
      sel.appendChild(opt);
    }
    sel.addEventListener('change', function () {
      state.splash[key] = sel.value;
      saveSplash();
      renderSplashPanel();
    });
    row.appendChild(head);
    row.appendChild(sel);
    return { row: row, input: sel };
  }

  function spSwitch(label, key) {
    var row = el('label', 'mhub-sp-switch');
    var input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('data-sp-key', key);
    input.addEventListener('change', function () {
      state.splash[key] = input.checked;
      saveSplash();
    });
    row.appendChild(input);
    row.appendChild(el('span', 'mhub-sp-switch__track'));
    row.appendChild(el('span', 'mhub-sp-switch__text', label));
    return { row: row, input: input };
  }

  function spColor(label, key) {
    var row = el('div', 'mhub-wp-ctl');
    var head = el('div', 'mhub-wp-ctl__head');
    head.appendChild(el('span', 'mhub-wp-ctl__label', label));
    var input = document.createElement('input');
    input.type = 'color';
    input.className = 'mhub-sp-color';
    input.setAttribute('data-sp-key', key);
    input.addEventListener('input', function () {
      state.splash[key] = input.value;
      saveSplash();
    });
    row.appendChild(head);
    row.appendChild(input);
    return { row: row, input: input };
  }

  function spText(label, key, placeholder) {
    var row = el('div', 'mhub-wp-ctl');
    var head = el('div', 'mhub-wp-ctl__head');
    head.appendChild(el('span', 'mhub-wp-ctl__label', label));
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'mhub-wp-search mhub-sp-text';
    input.placeholder = placeholder || '';
    input.setAttribute('data-sp-key', key);
    input.addEventListener('input', function () {
      state.splash[key] = input.value;
      saveSplash();
    });
    row.appendChild(head);
    row.appendChild(input);
    return { row: row, input: input };
  }

  function spGroup(text) {
    return el('div', 'mhub-sp-group', text);
  }

  function buildSplashPanel() {
    var sec = el('section', 'mhub-wp-card');
    sec.id = 'mhub-splash-panel';
    sec.setAttribute('data-mhub-wp', '1');

    var head = el('div', 'mhub-wp-head');
    var brand = el('div', 'mhub-wp-brand');
    var mark = el('div', 'mhub-wp-mark');
    mark.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3M12 18v3M4.2 7.5l2.6 1.5M17.2 15l2.6 1.5M4.2 16.5l2.6-1.5M17.2 9l2.6-1.5"/><circle cx="12" cy="12" r="3.2"/></svg>';
    var titles = el('div', 'mhub-wp-titles');
    titles.appendChild(el('h3', 'mhub-wp-title', 'M HUB 启动页'));
    titles.appendChild(el('p', 'mhub-wp-sub', '六幕授权序列 · 液态玻璃 · 真声音效 · 实时调参'));
    brand.appendChild(mark);
    brand.appendChild(titles);

    var switchWrap = el('label', 'mhub-wp-switch');
    var switchInput = document.createElement('input');
    switchInput.type = 'checkbox';
    switchInput.id = 'mhub-sp-enabled';
    switchInput.addEventListener('change', function () {
      state.splash.enabled = switchInput.checked;
      saveSplash();
    });
    switchWrap.appendChild(switchInput);
    switchWrap.appendChild(el('span', 'mhub-wp-switch__track'));
    switchWrap.appendChild(el('span', 'mhub-wp-switch__text', '启用'));
    head.appendChild(brand);
    var headActions = el('div', 'mhub-wp-actions');
    headActions.appendChild(switchWrap);
    head.appendChild(headActions);
    sec.appendChild(head);

    var hint = el('p', 'mhub-sp-hint', '调整后下一次启动生效；点「预览启动页」可立即查看效果，预览窗口会在终幕结束后自动关闭。');
    sec.appendChild(hint);

    var body = el('div', 'mhub-wp-ctls mhub-sp-body');
    var refs = { sliders: [], selects: [], switches: [], colors: [], texts: [] };

    /* 背景 */
    body.appendChild(spGroup('启动页背景'));
    var bgMode = spSelect('背景来源', 'bgMode', [
      ['follow', '跟随 M HUB 壁纸'],
      ['custom', '指定壁纸'],
      ['color', '纯色'],
      ['off', '不铺背景（默认底板）']
    ]);
    var bgPick = el('div', 'mhub-wp-ctl');
    var bgPickHead = el('div', 'mhub-wp-ctl__head');
    bgPickHead.appendChild(el('span', 'mhub-wp-ctl__label', '选择壁纸'));
    var bgSelect = document.createElement('select');
    bgSelect.className = 'mhub-wp-select';
    bgSelect.setAttribute('data-sp-key', 'bgId');
    bgSelect.addEventListener('change', function () {
      state.splash.bgId = bgSelect.value;
      saveSplash();
    });
    bgPick.appendChild(bgPickHead);
    bgPick.appendChild(bgSelect);
    var bgColor = spColor('背景底色', 'bgColor');
    var bgBlur = spSlider('背景模糊', 'bgBlur', 0, 60, 1, ' px');
    var bgBright = spSlider('背景亮度', 'bgBrightness', 20, 180, 1, ' %');
    var bgDim = spSlider('背景暗化', 'bgDim', 0, 90, 1, ' %');
    var bgSat = spSlider('背景饱和度', 'bgSaturation', 0, 220, 1, ' %');
    var bgScale = spSlider('背景缩放', 'bgScale', 100, 160, 1, ' %');
    refs.selects.push(bgMode);
    refs.colors.push(bgColor);
    refs.sliders.push(bgBlur, bgBright, bgDim, bgSat, bgScale);
    body.appendChild(bgMode.row);
    body.appendChild(bgPick);
    body.appendChild(bgColor.row);
    body.appendChild(bgBlur.row);
    body.appendChild(bgBright.row);
    body.appendChild(bgDim.row);
    body.appendChild(bgSat.row);
    body.appendChild(bgScale.row);

    /* 液态玻璃 */
    body.appendChild(spGroup('液态玻璃'));
    var glass = spSwitch('液态玻璃（半透明磨砂底板）', 'glass');
    var gOpacity = spSlider('玻璃不透明度', 'glassOpacity', 15, 95, 1, ' %');
    var gBlur = spSlider('磨砂模糊', 'glassBlur', 0, 60, 1, ' px');
    var gSat = spSlider('玻璃饱和度', 'glassSaturate', 100, 200, 1, ' %');
    var gBack = spSlider('背景模糊', 'glassBackdropBlur', 0, 80, 1, ' px');
    refs.switches.push(glass);
    refs.sliders.push(gOpacity, gBlur, gSat, gBack);
    body.appendChild(glass.row);
    body.appendChild(gOpacity.row);
    body.appendChild(gBlur.row);
    body.appendChild(gSat.row);
    body.appendChild(gBack.row);

    /* 动画 */
    body.appendChild(spGroup('动画与交互'));
    var theme = spSelect('主题', 'theme', [['auto', '跟随应用'], ['light', '浅色'], ['dark', '深色']]);
    var speed = spSlider('动画速度', 'speed', 0.35, 3, 0.05, ' ×');
    var confirm = spSwitch('第 1、2 步等待确认', 'requireInteraction');
    var skip = spSwitch('允许跳过（SKIP / Esc）', 'allowSkip');
    var startMax = spSwitch('启动时默认最大化', 'startMaximized');
    refs.selects.push(theme);
    refs.switches.push(confirm, skip, startMax);
    refs.sliders.push(speed);
    body.appendChild(theme.row);
    body.appendChild(speed.row);
    body.appendChild(confirm.row);
    body.appendChild(skip.row);
    body.appendChild(startMax.row);

    /* 音效 */
    body.appendChild(spGroup('界面音效'));
    var sfx = spSwitch('界面音效', 'sfx');
    var sfxVol = spSlider('音效音量', 'sfxVolume', 0, 100, 1, ' %');
    refs.switches.push(sfx);
    refs.sliders.push(sfxVol);
    body.appendChild(sfx.row);
    body.appendChild(sfxVol.row);

    /* 语音 */
    body.appendChild(spGroup('语音播报'));
    var voice = spSwitch('语音播报', 'voice');
    var vSource = spSelect('语音来源', 'voiceSource', [['asset', '真声素材'], ['tts', '系统合成']]);
    var vVol = spSlider('语音音量', 'voiceVolume', 0, 100, 1, ' %');
    var vRate = spSlider('语速', 'voiceRate', 0.5, 1.5, 0.01, ' ×');
    var vPitch = spSlider('音调', 'voicePitch', 0.5, 1.5, 0.01, ' ×');
    refs.switches.push(voice);
    refs.selects.push(vSource);
    refs.sliders.push(vVol, vRate, vPitch);
    body.appendChild(voice.row);
    body.appendChild(vSource.row);
    body.appendChild(vVol.row);
    body.appendChild(vRate.row);
    body.appendChild(vPitch.row);

    /* 视觉 */
    body.appendChild(spGroup('视觉与身份'));
    var accent = spColor('强调色', 'accent');
    var glitchA = spColor('故障色 A', 'glitchA');
    var glitchB = spColor('故障色 B', 'glitchB');
    var idName = spText('身份名称', 'identityName', 'MCHOSE USER');
    var idCode = spText('设备编号', 'identityId', 'MCHOSE-01');
    var idLevel = spText('权限等级', 'accessLevel', '03');
    refs.colors.push(accent, glitchA, glitchB);
    refs.texts.push(idName, idCode, idLevel);
    body.appendChild(accent.row);
    body.appendChild(glitchA.row);
    body.appendChild(glitchB.row);
    body.appendChild(idName.row);
    body.appendChild(idCode.row);
    body.appendChild(idLevel.row);

    sec.appendChild(body);

    var actions = el('div', 'mhub-sp-actions');
    var preview = el('button', 'mhub-wp-btn', '预览启动页');
    preview.type = 'button';
    preview.addEventListener('click', function () { uplink({ t: 'splashPreview' }); });
    var reset = el('button', 'mhub-wp-btn mhub-wp-btn--ghost', '重置启动页设置');
    reset.type = 'button';
    reset.addEventListener('click', function () {
      state.splash = Object.assign({}, DEFAULT_SPLASH);
      saveSplash();
      renderSplashPanel();
    });
    actions.appendChild(preview);
    actions.appendChild(reset);
    sec.appendChild(actions);

    var foot = el('div', 'mhub-wp-foot');
    foot.appendChild(el('span', 'mhub-wp-foot__hint', '启动页设置保存在本地，不会联网；背景壁纸不会修改 Windows 桌面。'));
    sec.appendChild(foot);

    attachCollapse(sec, head, 'splash', headActions);

    splashPanel = sec;
    splashPanel.__refs = {
      switchInput: switchInput, bgMode: bgMode, bgPick: bgPick, bgSelect: bgSelect, bgColor: bgColor,
      body: body, glass: glass, voice: voice, refs: refs
    };
    splashPanel.__sig = '';
    return sec;
  }

  function renderSplashPanel() {
    if (!splashPanel || !splashPanel.isConnected) return;
    var r = splashPanel.__refs;
    if (!r) return;
    var theme = detectTheme();
    splashPanel.setAttribute('data-wp-theme', theme);
    try { splashPanel.style.setProperty('--wp-accent', accentColor()); } catch (e) { /* ignore */ }

    var s = state.splash;
    r.switchInput.checked = !!s.enabled;
    if (document.activeElement !== r.bgMode.input) r.bgMode.input.value = String(s.bgMode);
    r.bgPick.hidden = s.bgMode !== 'custom';
    r.bgColor.row.hidden = s.bgMode === 'off';

    var itemSig = state.items.map(function (x) { return x.id; }).join(',') + '|' + s.bgId;
    if (splashPanel.__sig !== itemSig) {
      splashPanel.__sig = itemSig;
      r.bgSelect.textContent = '';
      var ph = document.createElement('option');
      ph.value = '';
      ph.textContent = '（选择一张壁纸）';
      r.bgSelect.appendChild(ph);
      for (var i = 0; i < state.items.length; i++) {
        var op = document.createElement('option');
        op.value = state.items[i].id;
        op.textContent = state.items[i].title;
        r.bgSelect.appendChild(op);
      }
    }
    if (document.activeElement !== r.bgSelect) r.bgSelect.value = String(s.bgId || '');
    if (document.activeElement !== r.bgColor.input) r.bgColor.input.value = String(s.bgColor || '#05070c');

    var refs = r.refs;
    for (var a = 0; a < refs.sliders.length; a++) {
      var sl = refs.sliders[a];
      var key = sl.input.getAttribute('data-sp-key');
      var unit = sl.input.getAttribute('data-sp-unit') || '';
      if (document.activeElement !== sl.input) sl.input.value = String(s[key]);
      sl.val.textContent = s[key] + unit;
    }
    for (var b = 0; b < refs.selects.length; b++) {
      var se = refs.selects[b];
      var sk = se.input.getAttribute('data-sp-key');
      if (document.activeElement !== se.input) se.input.value = String(s[sk]);
    }
    for (var c = 0; c < refs.switches.length; c++) {
      var sw = refs.switches[c];
      var wk = sw.input.getAttribute('data-sp-key');
      sw.input.checked = !!s[wk];
    }
    for (var d = 0; d < refs.colors.length; d++) {
      var co = refs.colors[d];
      var ck = co.input.getAttribute('data-sp-key');
      if (document.activeElement !== co.input) co.input.value = String(s[ck] || '#000000');
    }
    for (var e = 0; e < refs.texts.length; e++) {
      var tx = refs.texts[e];
      var tk = tx.input.getAttribute('data-sp-key');
      if (document.activeElement !== tx.input) tx.input.value = String(s[tk] || '');
    }

    var glassOn = !!s.glass;
    refs.sliders.forEach(function (sl) {
      var k = sl.input.getAttribute('data-sp-key');
      if (k === 'glassOpacity' || k === 'glassBlur' || k === 'glassSaturate' || k === 'glassBackdropBlur') {
        sl.row.style.opacity = glassOn ? '' : '.45';
        sl.row.style.pointerEvents = glassOn ? '' : 'none';
      }
      if (k === 'voiceVolume' || k === 'voiceRate' || k === 'voicePitch') {
        var on = !!s.voice;
        sl.row.style.opacity = on ? '' : '.45';
        sl.row.style.pointerEvents = on ? '' : 'none';
      }
    });
    for (var f = 0; f < refs.selects.length; f++) {
      if (refs.selects[f].input.getAttribute('data-sp-key') === 'voiceSource') {
        refs.selects[f].row.style.opacity = s.voice ? '' : '.45';
        refs.selects[f].row.style.pointerEvents = s.voice ? '' : 'none';
      }
    }
  }

  function scrollCardBy(dy) {
    var card = document.querySelector('.theme-setting-panel--wallpaper');
    var wrap = card && card.shadowRoot && card.shadowRoot.querySelector('.du-card');
    if (wrap) wrap.scrollTop += dy;
  }

  function ensureCardScroll() {
    var card = document.querySelector('.theme-setting-panel--wallpaper');
    if (!card || !card.shadowRoot) return;
    var sr = card.shadowRoot;
    if (sr.querySelector('style[data-mhub-scroll]')) return;
    var st = document.createElement('style');
    st.setAttribute('data-mhub-scroll', '1');
    st.textContent = '.du-card{overflow-y:auto !important;overflow-x:hidden !important;overscroll-behavior:contain;}' +
      '.du-card__body{display:block !important;height:auto !important;min-height:100%;}' +
      '.du-card__content{display:block !important;position:static !important;height:auto !important;}' +
      '.du-card::-webkit-scrollbar{width:8px;}' +
      '.du-card::-webkit-scrollbar-thumb{background:rgba(140,150,170,.42);border-radius:4px;}' +
      '.du-card::-webkit-scrollbar-track{background:transparent;}';
    sr.appendChild(st);
  }

  function ensureStyle() {
    if (document.getElementById('mhub-wp-css')) return;
    var st = document.createElement('style');
    st.id = 'mhub-wp-css';
    st.textContent = [
      '#mhub-wp-bg,#mhub-wp-bg *{pointer-events:none !important;}',
      /* 仅在壁纸生效时彻底隐藏官方壁纸容器，跟着路由重建也不会重新露出来。 */
      'html.mhub-wp-on .wallpaper-background:not(:has(#mhub-wp-bg)){display:none !important;}',
      'html.mhub-wp-on .wallpaper-background__scenes,html.mhub-wp-on .wallpaper-background__plane,' +
        'html.mhub-wp-on .wallpaper-background__media{display:none !important;}',
      'html.mhub-wp-on .app-background>img,html.mhub-wp-on .app-background>video,' +
        'html.mhub-wp-on .app-background>canvas{display:none !important;}',
      '@keyframes mhubWpKen{from{transform:scale(var(--wp-scale,1))}to{transform:scale(calc(var(--wp-scale,1) * 1.08))}}',
      '@keyframes mhubWpBreathe{0%,100%{opacity:1}50%{opacity:.86}}',
      '.mhub-wp-card{--wp-fg:#eef3fb;--wp-sub:#adb9cc;--wp-line:rgba(255,255,255,.13);--wp-fill:rgba(11,15,24,.56);--wp-hover:rgba(255,255,255,.09);--wp-accent:' + accentColor() + ';box-sizing:border-box;width:100%;margin:4px 0 20px;padding:18px 18px 16px;border:1px solid var(--wp-line);border-radius:14px;background:var(--wp-fill);-webkit-backdrop-filter:blur(18px) saturate(125%);backdrop-filter:blur(18px) saturate(125%);box-shadow:0 10px 30px rgba(0,0,0,.18);color:var(--wp-fg);font:13px/1.5 "Segoe UI","Microsoft YaHei",sans-serif;}',
      '.mhub-wp-card[data-wp-theme="light"]{--wp-fg:#1b2433;--wp-sub:#5c6879;--wp-line:rgba(16,26,48,.12);--wp-fill:rgba(255,255,255,.7);--wp-hover:rgba(16,26,48,.07);}',
      '.mhub-wp-card *{box-sizing:border-box;}',
      '.mhub-wp-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;}',
      '.mhub-wp-brand{display:flex;align-items:center;gap:11px;min-width:0;}',
      '.mhub-wp-mark{width:34px;height:34px;border-radius:10px;display:flex;align-items:center;justify-content:center;background:rgba(47,107,255,.14);background:color-mix(in srgb,var(--wp-accent) 14%,transparent);color:var(--wp-accent);flex:none;}',
      '.mhub-wp-mark svg{width:18px;height:18px;}',
      '.mhub-wp-title{margin:0;font-size:14px;font-weight:650;letter-spacing:.2px;color:var(--wp-fg);}',
      '.mhub-wp-sub{margin:2px 0 0;font-size:12px;color:var(--wp-sub);}',
      '.mhub-wp-switch{display:inline-flex;align-items:center;gap:8px;cursor:pointer;user-select:none;flex:none;}',
      '.mhub-wp-switch input{position:absolute;opacity:0;width:0;height:0;}',
      '.mhub-wp-switch__track{width:38px;height:22px;border-radius:999px;background:rgba(140,150,170,.35);position:relative;transition:background .18s ease;}',
      '.mhub-wp-switch__track::after{content:"";position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;transition:transform .18s cubic-bezier(.3,.7,.4,1);box-shadow:0 1px 3px rgba(0,0,0,.25);}',
      '.mhub-wp-switch input:checked + .mhub-wp-switch__track{background:var(--wp-accent);}',
      '.mhub-wp-switch input:checked + .mhub-wp-switch__track::after{transform:translateX(16px);}',
      '.mhub-wp-switch__text{font-size:12px;color:var(--wp-sub);}',
      '.mhub-wp-status{margin:10px 0 0;padding:8px 11px;border-radius:9px;background:var(--wp-hover);color:var(--wp-sub);font-size:12px;}',
      '.mhub-wp-ctls{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px 18px;margin-top:12px;}',
      '.mhub-wp-ctl{min-width:0;}',
      '.mhub-wp-ctl__head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:2px;}',
      '.mhub-wp-ctl__label{font-size:12px;color:var(--wp-sub);}',
      '.mhub-wp-ctl__val{font-size:12px;color:var(--wp-fg);opacity:.85;font-variant-numeric:tabular-nums;}',
      '.mhub-wp-ctl input[type=range]{width:100%;height:18px;accent-color:var(--wp-accent);cursor:pointer;}',
      '.mhub-wp-select{width:100%;height:28px;border-radius:8px;border:1px solid var(--wp-line);background:transparent;color:var(--wp-fg);padding:0 8px;font:inherit;font-size:12px;outline:none;cursor:pointer;}',
      '.mhub-wp-select option{color:#1d2635;}',
      '.mhub-wp-toolbar{display:flex;align-items:center;gap:8px;margin-top:16px;flex-wrap:wrap;}',
      '.mhub-wp-search{flex:1 1 160px;min-width:120px;height:30px;border-radius:9px;border:1px solid var(--wp-line);background:var(--wp-hover);color:var(--wp-fg);padding:0 10px;font:inherit;font-size:12px;outline:none;}',
      '.mhub-wp-search::placeholder{color:var(--wp-sub);opacity:.75;}',
      '.mhub-wp-search:focus{border-color:var(--wp-accent);}',
      '.mhub-wp-chips{display:flex;gap:6px;flex-wrap:wrap;}',
      '.mhub-wp-chip{height:26px;padding:0 10px;border-radius:999px;border:1px solid var(--wp-line);background:transparent;color:var(--wp-sub);font:inherit;font-size:12px;cursor:pointer;}',
      '.mhub-wp-chip.on{background:rgba(47,107,255,.16);border-color:rgba(47,107,255,.45);background:color-mix(in srgb,var(--wp-accent) 16%,transparent);border-color:color-mix(in srgb,var(--wp-accent) 45%,transparent);color:var(--wp-accent);font-weight:600;}',
      '.mhub-wp-count{font-size:12px;color:var(--wp-sub);}',
      '.mhub-wp-btn{height:28px;padding:0 12px;border-radius:8px;border:1px solid var(--wp-line);background:transparent;color:var(--wp-fg);font:inherit;font-size:12px;cursor:pointer;transition:background .15s ease,border-color .15s ease;}',
      '.mhub-wp-btn:hover{background:var(--wp-hover);}',
      '.mhub-wp-btn--ghost{color:var(--wp-sub);}',
      '.mhub-wp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(158px,1fr));gap:10px;margin-top:12px;max-height:306px;overflow-y:auto;padding:2px 2px 6px;}',
      '.mhub-wp-grid::-webkit-scrollbar{width:8px;}',
      '.mhub-wp-grid::-webkit-scrollbar-thumb{background:rgba(140,150,170,.35);border-radius:4px;}',
      '.mhub-wp-item{position:relative;display:flex;flex-direction:column;gap:6px;padding:0;border:0;background:transparent;color:var(--wp-fg);text-align:left;cursor:pointer;font:inherit;min-width:0;}',
      '.mhub-wp-thumb{position:relative;width:100%;aspect-ratio:16/9;border-radius:9px;overflow:hidden;background:rgba(130,140,160,.14);border:1px solid transparent;transition:border-color .15s ease,transform .15s ease;}',
      '.mhub-wp-thumb img{width:100%;height:100%;object-fit:cover;display:block;opacity:0;transition:opacity .25s ease;}',
      '.mhub-wp-thumb img.loaded{opacity:1;}',
      '.mhub-wp-item:hover .mhub-wp-thumb{border-color:rgba(47,107,255,.5);border-color:color-mix(in srgb,var(--wp-accent) 50%,transparent);transform:translateY(-1px);}',
      '.mhub-wp-item.is-current .mhub-wp-thumb{border-color:var(--wp-accent);box-shadow:0 0 0 2px rgba(47,107,255,.28);box-shadow:0 0 0 2px color-mix(in srgb,var(--wp-accent) 28%,transparent);}',
      '.mhub-wp-item__name{display:block;width:100%;min-width:0;font-size:12px;color:var(--wp-fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.mhub-wp-item__meta{display:block;width:100%;min-width:0;font-size:11px;color:var(--wp-sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.mhub-wp-kind{position:absolute;left:6px;bottom:6px;padding:1px 6px;border-radius:5px;background:rgba(8,12,20,.62);color:#eef2fa;font-size:10px;letter-spacing:.2px;backdrop-filter:blur(4px);}',
      '.mhub-wp-use{position:absolute;right:6px;bottom:6px;height:22px;padding:0 8px;border-radius:6px;border:0;background:var(--wp-accent);color:#fff;font:600 11px/22px "Segoe UI","Microsoft YaHei",sans-serif;opacity:0;transform:translateY(2px);transition:opacity .15s ease,transform .15s ease;cursor:pointer;}',
      '.mhub-wp-item:hover .mhub-wp-use{opacity:1;transform:none;}',
      '.mhub-wp-item.is-current .mhub-wp-use{opacity:1;transform:none;background:rgba(70,80,100,.7);}',
      '.mhub-wp-empty{grid-column:1/-1;padding:26px 12px;text-align:center;color:var(--wp-sub);font-size:12px;}',
      '.mhub-sp-group{grid-column:1/-1;margin:16px 0 2px;padding-top:2px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--wp-sub);opacity:.85;}',
      '.mhub-sp-body{margin-top:4px;}',
      '.mhub-sp-hint{margin:10px 0 0;font-size:12px;color:var(--wp-sub);}',
      '.mhub-sp-switch{display:flex;align-items:center;gap:9px;min-height:30px;cursor:pointer;user-select:none;}',
      '.mhub-sp-switch input{position:absolute;opacity:0;width:0;height:0;}',
      '.mhub-sp-switch__track{width:34px;height:20px;border-radius:999px;background:rgba(140,150,170,.35);position:relative;transition:background .18s ease;flex:none;}',
      '.mhub-sp-switch__track::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .18s cubic-bezier(.3,.7,.4,1);box-shadow:0 1px 3px rgba(0,0,0,.25);}',
      '.mhub-sp-switch input:checked + .mhub-sp-switch__track{background:var(--wp-accent);}',
      '.mhub-sp-switch input:checked + .mhub-sp-switch__track::after{transform:translateX(14px);}',
      '.mhub-sp-switch__text{font-size:12px;color:var(--wp-fg);opacity:.9;}',
      '.mhub-sp-color{width:100%;height:28px;padding:2px;border-radius:8px;border:1px solid var(--wp-line);background:var(--wp-hover);cursor:pointer;}',
      '.mhub-sp-text{height:28px;}',
      '.mhub-sp-actions{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;}',
      '.mhub-wp-foot{display:flex;align-items:center;gap:10px;margin-top:10px;font-size:11px;color:var(--wp-sub);opacity:.9;}',
      '.mhub-wp-foot__hint{opacity:.85;}',
      '.mhub-wp-link{border:0;background:transparent;color:var(--wp-accent);font:inherit;font-size:11px;cursor:pointer;padding:0;text-decoration:underline;text-underline-offset:2px;opacity:.9;}',
      '.mhub-wp-link:hover{opacity:1;}',
      '.mhub-wp-actions{display:flex;align-items:center;gap:10px;flex:none;}',
      '.mhub-wp-collapse{width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;padding:0;border-radius:8px;border:1px solid var(--wp-line);background:transparent;color:var(--wp-sub);cursor:pointer;transition:background .15s ease,color .15s ease;}',
      '.mhub-wp-collapse:hover{background:var(--wp-hover);color:var(--wp-fg);}',
      '.mhub-wp-collapse svg{width:14px;height:14px;transition:transform .22s ease;}',
      '.mhub-wp-card.is-collapsed .mhub-wp-collapse svg{transform:rotate(-90deg);}',
      '.mhub-wp-card.is-collapsed .mhub-wp-body{display:none;}'
    ].join('\n');
    document.head.appendChild(st);
  }

  function currentItem() {
    for (var i = 0; i < state.items.length; i++) if (state.items[i].id === state.bgId) return state.items[i];
    return null;
  }

  function renderPanel() {
    if (!panel || !panel.isConnected) return;
    var refs = panel.__refs;
    if (!refs) return;

    var theme = detectTheme();
    if (theme !== appliedTheme) {
      appliedTheme = theme;
      panel.setAttribute('data-wp-theme', theme);
      try {
        panel.style.setProperty('--wp-accent', accentColor());
      } catch (e) { /* ignore */ }
    }

    var cur = currentItem();
    var statusText;
    if (!state.bgId) statusText = '当前：使用 M HUB 官方背景';
    else if (!state.enabled) statusText = '当前：已暂停 M HUB 壁纸（' + (cur ? cur.title : '未知') + '）';
    else statusText = '当前：' + (cur ? cur.title : '已删除的壁纸') + ' · 仅作用于 M HUB 界面' +
      (cur && cur.kind !== 'video' ? ' · 场景壁纸只有约 1K 预览图，放大会偏糊（视频壁纸更清晰）' : '');
    refs.status.textContent = statusText;
    refs.switchInput.checked = !!state.enabled;
    refs.switchInput.disabled = !state.bgId;
    renderHotkeyRows(refs.hotkeys);

    for (var c = 0; c < refs.controls.length; c++) {
      var pair = refs.controls[c];
      var key = pair.input.getAttribute('data-wp-key');
      var unit = pair.input.getAttribute('data-wp-unit') || '';
      if (document.activeElement !== pair.input) pair.input.value = String(state.beautify[key]);
      pair.val.textContent = state.beautify[key] + unit;
    }
    for (var s = 0; s < refs.sels.length; s++) {
      var selPair = refs.sels[s];
      var sKey = selPair.input.getAttribute('data-wp-key');
      if (document.activeElement !== selPair.input) selPair.input.value = String(state.beautify[sKey]);
    }

    var q = String(refs.search.value || '').trim().toLowerCase();
    var filter = panel.__filter || 'all';
    var list = [];
    for (var i = 0; i < state.items.length; i++) {
      var it = state.items[i];
      if (filter !== 'all' && it.type !== filter) continue;
      if (q && String(it.title).toLowerCase().indexOf(q) < 0) continue;
      list.push(it);
    }

    var counts = { all: state.items.length };
    for (var n = 0; n < state.items.length; n++) {
      var type = state.items[n].type || 'other';
      counts[type] = (counts[type] || 0) + 1;
    }
    var defs = [['all', '全部'], ['scene', '场景'], ['video', '视频'], ['web', '网页'], ['application', '应用']];
    var chipSig = defs.map(function (d) { return d[0] + ':' + (counts[d[0]] || 0); }).join(',') + '|' + filter;
    if (refs.chips.__sig !== chipSig) {
      refs.chips.__sig = chipSig;
      refs.chips.textContent = '';
      for (var d = 0; d < defs.length; d++) {
        var t = defs[d][0];
        if (t !== 'all' && !counts[t]) continue;
        (function (key) {
          var chip = el('button', 'mhub-wp-chip' + (filter === key ? ' on' : ''), defs[d][1] + ' ' + (counts[key] || 0));
          chip.type = 'button';
          chip.addEventListener('click', function () {
            panel.__filter = key;
            panelSig = '';
            renderPanel();
          });
          refs.chips.appendChild(chip);
        })(t);
      }
    }
    refs.count.textContent = list.length === state.items.length ? state.items.length + ' 个' : list.length + ' / ' + state.items.length + ' 个';

    var sig = list.map(function (x) { return x.id; }).join(',') + '|' + state.bgId + '|' + (state.error ? '1' : '0');
    if (sig !== panelSig) {
      panelSig = sig;
      refs.grid.textContent = '';
      if (!list.length) {
        refs.grid.appendChild(el('div', 'mhub-wp-empty', state.error ? '未检测到 Wallpaper Engine 本地壁纸' : '没有匹配的壁纸'));
      } else {
        var frag = document.createDocumentFragment();
        for (var k = 0; k < list.length; k++) frag.appendChild(makeItem(list[k]));
        refs.grid.appendChild(frag);
        observeThumbs(refs.grid);
      }
    }
    var cards = refs.grid.querySelectorAll('.mhub-wp-item');
    for (var m = 0; m < cards.length; m++) {
      var isCur = cards[m].getAttribute('data-id') === state.bgId;
      cards[m].classList.toggle('is-current', isCur);
      var btn = cards[m].querySelector('.mhub-wp-use');
      if (btn) btn.textContent = isCur ? (state.enabled ? '使用中' : '已暂停') : '使用';
    }
  }

  function makeItem(item) {
    var card = document.createElement('button');
    card.type = 'button';
    card.className = 'mhub-wp-item' + (item.id === state.bgId ? ' is-current' : '');
    card.setAttribute('data-id', item.id);
    card.title = item.title;

    var thumb = el('span', 'mhub-wp-thumb');
    var img = document.createElement('img');
    img.alt = item.title;
    img.decoding = 'async';
    img.setAttribute('data-wp-thumb', item.id);
    img.addEventListener('load', function () { img.classList.add('loaded'); });
    img.addEventListener('error', function () {
      if (thumbCache[item.id]) { img.src = thumbCache[item.id]; return; }
      if (thumbAsked[item.id]) return;
      thumbAsked[item.id] = true;
      uplink({ t: 'thumb', payload: { id: item.id } });
    });
    if (thumbCache[item.id]) img.src = thumbCache[item.id];
    else img.setAttribute('data-src', item.preview);
    thumb.appendChild(img);
    thumb.appendChild(el('span', 'mhub-wp-kind', item.typeLabel || '壁纸'));
    var use = el('span', 'mhub-wp-use', item.id === state.bgId ? '使用中' : '使用');
    thumb.appendChild(use);

    card.appendChild(thumb);
    card.appendChild(el('span', 'mhub-wp-item__name', item.title));
    card.appendChild(el('span', 'mhub-wp-item__meta', (item.tags && item.tags.length ? item.tags.join(' · ') : item.typeLabel) || '壁纸'));

    card.addEventListener('click', function () {
      state.bgId = item.id;
      state.enabled = true;
      mediaInfo = null;
      panelSig = '';
      uplink({ t: 'set', payload: { id: item.id } });
      renderPanel();
      ensureBgState();
    });
    return card;
  }

  var thumbObserver = null;
  function observeThumbs(host) {
    if (!('IntersectionObserver' in window)) {
      var imgs = host.querySelectorAll('img[data-src]');
      for (var i = 0; i < imgs.length; i++) { imgs[i].src = imgs[i].getAttribute('data-src'); imgs[i].removeAttribute('data-src'); }
      return;
    }
    if (!thumbObserver) {
      thumbObserver = new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
          var en = entries[i];
          if (!en.isIntersecting) continue;
          var img = en.target;
          var src = img.getAttribute('data-src');
          if (src) { img.src = src; img.removeAttribute('data-src'); }
          thumbObserver.unobserve(img);
        }
      }, { root: null, rootMargin: '300px 0px' });
    }
    var nodes = host.querySelectorAll('img[data-src]');
    for (var j = 0; j < nodes.length; j++) thumbObserver.observe(nodes[j]);
  }

  // ---------- 页面同步 ----------

  function syncPage() {
    ensureStyle();
    var slot = findSlot();
    if (!slot) {
      if (panel && !panel.isConnected) panel = null;
      if (splashPanel && !splashPanel.isConnected) splashPanel = null;
      return;
    }
    if (!panel) buildPanel();
    if (panel.previousElementSibling !== slot) {
      slot.insertAdjacentElement('afterend', panel);
    }
    if (!splashPanel) buildSplashPanel();
    if (splashPanel.previousElementSibling !== panel) {
      panel.insertAdjacentElement('afterend', splashPanel);
    }
    ensureCardScroll();
    ensureNativeSliders();
    syncNativeControls();
    enforceNative();
    startNativeGuard();
    renderPanel();
    renderSplashPanel();
  }

  function syncBackground() {
    ensureBgState();
  }

  // ---------- 下行接口 ----------

  window.__mhubWpReceive = function (data) {
    if (!data) return;
    state.items = Array.isArray(data.items) ? data.items : [];
    state.bgId = data.bgId || '';
    state.enabled = !!data.enabled;
    state.error = data.error || null;
    if (data.beautify && typeof data.beautify === 'object' && Date.now() - lastEditAt > 900) {
      for (var k in DEFAULT_BEAUTIFY) {
        if (data.beautify[k] !== undefined) state.beautify[k] = data.beautify[k];
      }
    }
    if (data.splash && typeof data.splash === 'object' && Date.now() - lastSplashEditAt > 900) {
      for (var sk in DEFAULT_SPLASH) {
        if (data.splash[sk] !== undefined) state.splash[sk] = data.splash[sk];
      }
    }
    if (data.hotkeys && typeof data.hotkeys === 'object') {
      for (var hk in DEFAULT_HOTKEYS) {
        if (typeof data.hotkeys[hk] === 'string') state.hotkeys[hk] = data.hotkeys[hk];
      }
    }
    if (Array.isArray(data.hotkeyErrors)) state.hotkeyErrors = data.hotkeyErrors;
    panelSig = '';
    if (state.bgId && (!mediaInfo || mediaInfo.id !== state.bgId)) uplink({ t: 'thumb', payload: { id: state.bgId } });
    syncBackground();
    if (panel && panel.isConnected) renderPanel();
    renderSplashPanel();
    syncNativeControls();
  };

  window.__mhubWpMedia = function (info) {
    mediaInfo = info && info.image ? info : null;
    bgKey = '';
    ensureBgState();
    if (panel && panel.isConnected) renderPanel();
  };

  window.__mhubWpThumb = function (id, dataUrl) {
    if (!id || !dataUrl) return;
    thumbCache[id] = dataUrl;
    var nodes = document.querySelectorAll('img[data-wp-thumb="' + String(id).replace(/"/g, '\\"') + '"]');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].src = dataUrl;
      nodes[i].removeAttribute('data-src');
    }
  };

  // ---------- 生命周期 ----------

  var timer = null;
  var observer = null;
  var syncQueued = false;

  function queueSync() {
    if (syncQueued) return;
    syncQueued = true;
    setTimeout(function () {
      syncQueued = false;
      try { syncPage(); } catch (e) { /* ignore */ }
      try { syncBackground(); } catch (e) { /* ignore */ }
    }, 220);
  }

  function start() {
    syncPage();
    syncBackground();
    timer = setInterval(function () {
      try { syncPage(); } catch (e) { /* ignore */ }
      try { syncBackground(); } catch (e) { /* ignore */ }
    }, 900);
    if ('MutationObserver' in window) {
      observer = new MutationObserver(queueSync);
      observer.observe(document.body, { childList: true, subtree: true });
    }
    /* 路由切换（hash / history）后立刻重新对齐背景，避免闪回官方壁纸。 */
    window.addEventListener('hashchange', queueSync);
    window.addEventListener('popstate', queueSync);
    listeners.push([window, 'hashchange', queueSync, false]);
    listeners.push([window, 'popstate', queueSync, false]);
    uplink({ t: 'ready' });
    setTimeout(function () {
      var first = state.items[0];
      if (!first) { uplink({ t: 'selftest', items: 0, plane: !!bgHost() }); return; }
      var probe = new Image();
      probe.onload = function () { uplink({ t: 'selftest', items: state.items.length, theme: detectTheme(), plane: !!bgHost(), anchor: !!findAnchor(), proto: 'ok' }); };
      probe.onerror = function () { uplink({ t: 'selftest', items: state.items.length, theme: detectTheme(), plane: !!bgHost(), anchor: !!findAnchor(), proto: 'fail' }); };
      probe.src = first.preview;
    }, 1200);
  }

  function dispose() {
    if (timer) clearInterval(timer);
    if (nativeGuardTimer) clearInterval(nativeGuardTimer);
    if (nativeObserver) nativeObserver.disconnect();
    if (observer) observer.disconnect();
    if (thumbObserver) thumbObserver.disconnect();
    if (mouseHandler) window.removeEventListener('mousemove', mouseHandler);
    for (var i = 0; i < listeners.length; i++) {
      var l = listeners[i];
      try { l[0].removeEventListener(l[1], l[2], l[3]); } catch (e) { /* ignore */ }
    }
    listeners.length = 0;
    hideOfficialMedia(false);
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
    if (splashPanel && splashPanel.parentNode) splashPanel.parentNode.removeChild(splashPanel);
    if (bgEl && bgEl.parentNode) bgEl.parentNode.removeChild(bgEl);
    var css = document.getElementById('mhub-wp-css');
    if (css && css.parentNode) css.parentNode.removeChild(css);
    var nat = document.querySelectorAll('.mhub-wp-native');
    for (var n = 0; n < nat.length; n++) if (nat[n].parentNode) nat[n].parentNode.removeChild(nat[n]);
    nativeCtl.length = 0;
    var old = document.querySelectorAll('[data-mhub-wp-entry],#mhub-wp-float,#mhub-wp-layer');
    for (var j = 0; j < old.length; j++) if (old[j].parentNode) old[j].parentNode.removeChild(old[j]);
    var wcard = document.querySelector('.theme-setting-panel--wallpaper');
    if (wcard && wcard.shadowRoot) {
      var sst = wcard.shadowRoot.querySelector('style[data-mhub-scroll]');
      if (sst && sst.parentNode) sst.parentNode.removeChild(sst);
    }
    panel = null;
    splashPanel = null;
    bgEl = null;
    bgNode = null;
    bgKey = '';
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  window.__mhubWallpaper = {
    version: VERSION,
    heal: function () { try { syncPage(); syncBackground(); } catch (e) { /* ignore */ } },
    dispose: dispose,
    open: function () { try { location.hash = '#/setting'; } catch (e) { /* ignore */ } return true; },
    isOpen: function () { return !!(panel && panel.isConnected); },
    state: function () { return state; }
  };
})();
