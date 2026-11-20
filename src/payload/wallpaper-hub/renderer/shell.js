(function () {
  'use strict';

  var VERSION = '4.1';
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
    nativeBlur: 0, nativeBrightness: 50, deviceBlur: 12
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
    welcomeName: 'Jay',
    accessLevel: '03',
    accent: '#1f63ff',
    glitchA: '#ff3b30',
    glitchB: '#2971b8',
    stages: { intro: true, setup: true, steps: true, welcome: true }
  };
  var DEFAULT_HOTKEYS = { next: 'Alt+Right', prev: 'Alt+Left', random: 'Alt+R', toggle: 'Alt+P', preview: '' };

  var state = {
    version: VERSION,
    author: '顾小颜',
    items: [],
    libraries: [],
    favorites: [],
    recent: [],
    rotation: { enabled: false, intervalMinutes: 30, scope: 'all', lastRunAt: 0 },
    scenePerformance: { preset: 'balanced', fps: 30, renderDpr: 1, videoTexScale: 0.75, pauseWhenHidden: true },
    bgId: '',
    enabled: false,
    overlayOfficial: false,
    beautify: Object.assign({}, DEFAULT_BEAUTIFY),
    props: {},
    splash: Object.assign({}, DEFAULT_SPLASH),
    hotkeys: Object.assign({}, DEFAULT_HOTKEYS),
    hotkeyErrors: [],
    error: null
  };
  var mediaInfo = null;
  var sceneSession = null;
  var sceneGeneration = 0;
  var sceneRuntimeRequested = false;
  var THUMB_CACHE_LIMIT = 32;
  var THUMB_CACHE_CHAR_LIMIT = 8 * 1024 * 1024;
  var THUMB_ASKED_LIMIT = 128;
  var thumbCache = new Map();
  var thumbCacheChars = 0;
  var thumbAsked = new Map();
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

  function cachedThumb(id) {
    if (!thumbCache.has(id)) return '';
    var value = thumbCache.get(id);
    thumbCache.delete(id);
    thumbCache.set(id, value);
    return value;
  }

  function markThumbAsked(id) {
    if (thumbAsked.has(id)) return false;
    if (thumbAsked.size >= THUMB_ASKED_LIMIT) thumbAsked.delete(thumbAsked.keys().next().value);
    thumbAsked.set(id, true);
    return true;
  }

  function storeThumb(id, dataUrl) {
    if (thumbCache.has(id)) {
      thumbCacheChars -= thumbCache.get(id).length;
      thumbCache.delete(id);
    }
    if (!dataUrl || dataUrl.length > THUMB_CACHE_CHAR_LIMIT) return;
    thumbCache.set(id, dataUrl);
    thumbCacheChars += dataUrl.length;
    while (thumbCache.size > THUMB_CACHE_LIMIT || thumbCacheChars > THUMB_CACHE_CHAR_LIMIT) {
      var oldest = thumbCache.keys().next().value;
      var value = thumbCache.get(oldest) || '';
      thumbCache.delete(oldest);
      thumbCacheChars -= value.length;
    }
  }

  // ---------- 主题 ----------

  function luminance(rgb) {
    var m = String(rgb || '').match(/[\d.]+/g);
    if (!m || m.length < 3) return null;
    var a = m.length > 3 ? Number(m[3]) : 1;
    if (!(a > 0.15)) return null;
    return 0.2126 * Number(m[0]) + 0.7152 * Number(m[1]) + 0.0722 * Number(m[2]);
  }

  function explicitTheme(node) {
    if (!node || !node.getAttribute) return '';
    var attrs = ['data-theme', 'theme', 'data-mode', 'data-color-scheme'];
    for (var i = 0; i < attrs.length; i++) {
      var value = String(node.getAttribute(attrs[i]) || '').toLowerCase();
      if (/(^|[-_\s])(dark|light)([-_\s]|$)/.test(value)) return value.indexOf('dark') !== -1 ? 'dark' : 'light';
    }
    var cls = String(node.className && node.className.baseVal !== undefined ? node.className.baseVal : node.className || '').toLowerCase();
    if (/(^|[-_\s])(dark|light)([-_\s]|$)/.test(cls)) return cls.indexOf('dark') !== -1 ? 'dark' : 'light';
    return '';
  }

  function detectTheme() {
    /* M HUB 不同版本会在 html / body / #app 上切换 data-theme、dark class 或
       theme-setting-tabs.value。优先读取显式标记，避免透明背景导致亮度误判。 */
    var roots = [document.documentElement, document.body, document.querySelector('#app')];
    for (var r = 0; r < roots.length; r++) {
      var marked = explicitTheme(roots[r]);
      if (marked) return marked;
    }
    var seg = document.querySelector('.theme-setting-tabs');
    var segValue = seg && String(seg.getAttribute('value') || seg.value || '').toLowerCase();
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

  function syncControlTheme() {
    var theme = detectTheme();
    var accent = accentColor();
    appliedTheme = theme;
    var cards = [panel, splashPanel];
    for (var i = 0; i < cards.length; i++) {
      if (!cards[i] || !cards[i].isConnected) continue;
      cards[i].setAttribute('data-wp-theme', theme);
      try { cards[i].style.setProperty('--wp-accent', accent); } catch (e) { /* ignore */ }
    }
    return theme;
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
    return document.querySelector('.app-background') ||
      document.querySelector('.wallpaper-background');
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
    el.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:-1;';

    var media = document.createElement('div');
    media.className = 'mhub-wp-bg__media';
    /* 不常驻 will-change：静态壁纸无需一直占用一张全屏 GPU 纹理。 */
    media.style.cssText = 'position:absolute;inset:0;transform-origin:center;';

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

  function releaseBgNode() {
    destroyScene();
    var old = bgNode;
    bgNode = null;
    if (!old) return;
    try {
      if (old.tagName === 'VIDEO') {
        old.pause();
        old.removeAttribute('src');
        old.removeAttribute('poster');
        /* 主动触发媒体资源释放，仅 removeChild 可能让解码器/网络缓存多存活一段时间。 */
        old.load();
      } else if (old.tagName === 'IMG') {
        old.removeAttribute('src');
      }
    } catch (e) { /* ignore */ }
    if (old.parentNode) old.parentNode.removeChild(old);
  }

  function destroyScene() {
    sceneGeneration++;
    var old = sceneSession;
    sceneSession = null;
    if (old) {
      try { old.destroy(); } catch (e) { /* ignore */ }
    }
  }

  function syncSceneVisibility() {
    if (!sceneSession) return;
    var performance = mediaInfo && mediaInfo.performance || {};
    sceneSession.setPaused(!!document.hidden && performance.pauseWhenHidden !== false);
  }

  var sceneState = { phase: 'idle', message: '', detail: null };

  function scenePhaseLabel(phase) {
    var labels = {
      'preflight-project': '校验项目配置',
      'preflight-pkg': '校验场景资源包',
      mount: '初始化 WebWallGL',
      ready: 'WebWallGL 已就绪',
      error: '场景加载失败'
    };
    return labels[phase] || '准备场景渲染器';
  }

  function updateSceneStatus() {
    if (!panel || !panel.__refs || !panel.__refs.playback) return;
    var node = panel.__refs.playback.sceneStatus;
    if (!node) return;
    var isScene = !!(mediaInfo && (mediaInfo.kind === 'scene' || mediaInfo.kind === 'web') && mediaInfo.sceneBase);
    node.style.display = isScene ? '' : 'none';
    if (!isScene) return;
    node.textContent = sceneState.message || '场景加载中';
    node.setAttribute('data-scene-phase', sceneState.phase || 'idle');
  }

  function setSceneStatus(phase, message, detail) {
    sceneState = { phase: phase || 'idle', message: String(message || ''), detail: detail || null };
    updateSceneStatus();
  }

  function mountScene(media) {
    destroyScene();
    if (!mediaInfo || !mediaInfo.sceneBase) {
      setSceneStatus('error', '已回退静态预览 · 场景资源地址为空');
      return;
    }
    if (!window.__mhubWpScene) {
      setSceneStatus('runtime', '场景加载中 · 正在加载渲染器');
      if (!sceneRuntimeRequested) {
        sceneRuntimeRequested = true;
        uplink({ t: 'sceneRuntimeNeeded', payload: { id: mediaInfo.id } });
      }
      return;
    }
    sceneRuntimeRequested = false;
    var host = document.createElement('div');
    host.className = 'mhub-wp-bg__scene';
    media.appendChild(host);
    var token = ++sceneGeneration;
    var currentId = mediaInfo.id;
    setSceneStatus('preflight-project', '场景加载中 · 校验项目配置');
    var session = window.__mhubWpScene.mount(host, mediaInfo, {
      status: function (phase, detail) {
        if (token !== sceneGeneration) return;
        setSceneStatus(phase, '场景加载中 · ' + scenePhaseLabel(phase), detail);
      },
      ready: function () {
        if (token !== sceneGeneration || !mediaInfo || mediaInfo.id !== currentId) return;
        setSceneStatus('ready', '动态渲染中 · WebWallGL 已就绪');
        uplink({ t: 'sceneStatus', payload: { level: 'info', phase: 'ready', id: currentId, message: currentId + ': WebWallGL ready，动态渲染中' } });
        if (bgNode && bgNode.tagName === 'IMG') bgNode.style.visibility = 'hidden';
      },
      error: function (message, phase, detail) {
        if (token !== sceneGeneration) return;
        sceneSession = null;
        if (bgNode && bgNode.tagName === 'IMG') bgNode.style.visibility = 'visible';
        var label = scenePhaseLabel(phase);
        var reason = String(message || '未知错误').slice(0, 160);
        setSceneStatus('error', '已回退静态预览 · ' + label + '：' + reason, detail);
        uplink({ t: 'sceneStatus', payload: {
          level: 'error', phase: phase || 'mount', id: currentId,
          url: detail && detail.url || '', status: detail && detail.status,
          message: currentId + ': [' + (phase || 'mount') + '] ' + reason + '；已回退静态预览'
        } });
      },
      diagnostic: function (message, level) {
        if (level === 'warn') uplink({ t: 'sceneStatus', payload: { level: 'warn', id: currentId, message: currentId + ': ' + message } });
      }
    });
    sceneSession = session && !session.destroyed ? session : null;
    if (sceneSession) {
      sceneSession.setFit(currentCrop().fit);
      syncSceneVisibility();
    }
  }

  function syncVideoVisibility() {
    syncSceneVisibility();
    if (!bgNode || bgNode.tagName !== 'VIDEO') return;
    try {
      if (document.hidden) bgNode.pause();
      else {
        var p = bgNode.play();
        if (p && typeof p.catch === 'function') p.catch(function () { /* wait for gesture */ });
      }
    } catch (e) { /* ignore */ }
  }

  function ensureBgState() {
    var active = !!(state.enabled && state.bgId && mediaInfo && mediaInfo.id === state.bgId);
    var host = bgHost();
    try {
      document.documentElement.classList.toggle('mhub-wp-on', !!active);
      /* 覆盖开关只影响官方前景层，不改变壁纸本身的启停。 */
      document.documentElement.classList.toggle('mhub-wp-cover', !!active && !!state.overlayOfficial);
    } catch (e) { /* ignore */ }
    if (!active || !host) {
      hideOfficial(false);
      releaseBgNode();
      if (bgEl && bgEl.parentNode) bgEl.parentNode.removeChild(bgEl);
      bgEl = null;
      bgKey = '';
      return;
    }
    if (!bgEl || !bgEl.parentNode || bgEl.parentElement !== host) {
      releaseBgNode();
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
      releaseBgNode();
      media.textContent = '';
      if (mediaInfo.kind === 'video' && mediaInfo.video) {
        var video = document.createElement('video');
        video.src = mediaInfo.video;
        video.muted = true;
        video.loop = true;
        video.autoplay = true;
        video.preload = 'metadata';
        video.setAttribute('playsinline', '');
        video.setAttribute('muted', '');
        video.setAttribute('disablepictureinpicture', '');
        video.disableRemotePlayback = true;
        video.style.cssText = 'width:100%;height:100%;display:block;object-fit:cover;';
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
        syncVideoVisibility();
      } else {
        useImage(media);
        if ((mediaInfo.kind === 'scene' || mediaInfo.kind === 'web') && mediaInfo.sceneBase) mountScene(media);
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
    releaseBgNode();
    media.textContent = '';
    media.style.background = '#05070c';
    if (!mediaInfo || !mediaInfo.image) return;
    media.style.background = '';
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

  /* 设备详情页的背景会更亮、文字更多，适当追加模糊让设置内容更清楚；
     模糊度由控制面板的「设备页模糊」滑块决定，离开设备页自动还原。 */
  function isDevicePage() {
    try { return !!document.querySelector('.device-detail-layout'); } catch (e) { return false; }
  }

  function effBlur() {
    var b = state.beautify;
    var device = isDevicePage() ? (Number(b.deviceBlur) || 0) : 0;
    return clamp((Number(b.blur) || 0) + (Number(b.nativeBlur) || 0) + device, 0, 80);
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
    if (sceneSession) sceneSession.setFit(fit);
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

    if (b.fit === 'tile' && mediaInfo && mediaInfo.image && mediaInfo.kind !== 'scene' && mediaInfo.kind !== 'web') {
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
      meta.input.addEventListener('wheel', wheelScroll, { passive: false });
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
    input.addEventListener('wheel', wheelScroll, { passive: false });
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

  function sourceLabel(source) {
    if (source === 'wegame') return 'WeGame';
    if (source === 'manual') return '自定义';
    return 'Steam';
  }

  function buildLibrarySection() {
    var sec = el('div', 'mhub-wp-library');
    var head = el('div', 'mhub-wp-section-head');
    head.appendChild(el('div', 'mhub-wp-section-title', '壁纸来源'));
    var actions = el('div', 'mhub-wp-section-actions');
    var filter = document.createElement('select');
    filter.className = 'mhub-wp-select mhub-wp-source-filter';
    [['all', '全部来源'], ['steam', 'Steam'], ['wegame', 'WeGame'], ['manual', '自定义']].forEach(function (pair) {
      var option = document.createElement('option');
      option.value = pair[0];
      option.textContent = pair[1];
      filter.appendChild(option);
    });
    filter.addEventListener('change', function () {
      panel.__libraryFilter = filter.value;
      panelSig = '';
      renderPanel();
    });
    var rescan = el('button', 'mhub-wp-btn mhub-wp-btn--ghost', '重扫');
    rescan.type = 'button';
    rescan.addEventListener('click', function () { uplink({ t: 'refresh' }); });
    var add = el('button', 'mhub-wp-btn', '添加壁纸库');
    add.type = 'button';
    add.addEventListener('click', function () { uplink({ t: 'libraryChoose' }); });
    actions.appendChild(filter);
    actions.appendChild(rescan);
    actions.appendChild(add);
    head.appendChild(actions);
    sec.appendChild(head);
    var result = el('div', 'mhub-wp-library-result', '');
    sec.appendChild(result);
    var list = el('div', 'mhub-wp-library-list');
    sec.appendChild(list);
    sec.appendChild(el('div', 'mhub-wp-section-hint', '支持 Steam、WeGame 和手动目录；移除自定义来源只删除配置，不删除磁盘壁纸。'));
    return { row: sec, list: list, result: result, filter: filter };
  }

  function renderLibraries() {
    if (!panel || !panel.__refs || !panel.__refs.library) return;
    var refs = panel.__refs.library;
    var libraries = Array.isArray(state.libraries) ? state.libraries : [];
    var sig = libraries.map(function (lib) {
      return [lib.id, lib.enabled, lib.count, lib.truncated, lib.path].join(':');
    }).join('|');
    if (refs.list.__sig === sig) return;
    refs.list.__sig = sig;
    refs.list.textContent = '';
    if (!libraries.length) {
      refs.list.appendChild(el('div', 'mhub-wp-library-empty', '尚未检测到壁纸来源，可点击“添加壁纸库”手动选择。'));
      return;
    }
    libraries.forEach(function (lib) {
      var row = el('div', 'mhub-wp-library-row' + (lib.enabled ? '' : ' is-disabled'));
      var info = el('div', 'mhub-wp-library-info');
      var title = el('div', 'mhub-wp-library-title');
      title.appendChild(el('span', 'mhub-wp-library-source', sourceLabel(lib.source)));
      title.appendChild(el('span', 'mhub-wp-library-name', lib.label || lib.path));
      title.appendChild(el('span', 'mhub-wp-library-count', (lib.count || 0) + ' 项' + (lib.truncated ? ' · 已达扫描上限' : '')));
      info.appendChild(title);
      info.appendChild(el('div', 'mhub-wp-library-path', lib.path));
      info.title = lib.path;
      row.appendChild(info);
      var actions = el('div', 'mhub-wp-library-actions');
      var toggle = el('button', 'mhub-wp-btn mhub-wp-btn--ghost', lib.enabled ? '停用' : '启用');
      toggle.type = 'button';
      toggle.addEventListener('click', function () {
        uplink({ t: 'libraryUpdate', payload: { id: lib.id, enabled: !lib.enabled } });
      });
      actions.appendChild(toggle);
      if (lib.source === 'manual') {
        var remove = el('button', 'mhub-wp-btn mhub-wp-btn--danger', '移除');
        remove.type = 'button';
        remove.addEventListener('click', function () {
          if (!window.confirm('仅从 M HUB 移除此壁纸库配置？磁盘中的壁纸不会被删除。')) return;
          uplink({ t: 'libraryUpdate', payload: { id: lib.id, remove: true } });
        });
        actions.appendChild(remove);
      }
      row.appendChild(actions);
      refs.list.appendChild(row);
    });
  }

  function buildPlaybackSection() {
    var sec = el('div', 'mhub-wp-playback');
    var head = el('div', 'mhub-wp-section-head');
    head.appendChild(el('div', 'mhub-wp-section-title', '播放与场景性能'));
    sec.appendChild(head);
    var grid = el('div', 'mhub-wp-playback-grid');

    function selectRow(label, values, changed) {
      var row = el('label', 'mhub-wp-playback-row');
      row.appendChild(el('span', '', label));
      var input = document.createElement('select');
      input.className = 'mhub-wp-select';
      values.forEach(function (pair) {
        var option = document.createElement('option');
        option.value = pair[0];
        option.textContent = pair[1];
        input.appendChild(option);
      });
      input.addEventListener('change', function () { changed(input.value); });
      row.appendChild(input);
      grid.appendChild(row);
      return input;
    }

    var interval = selectRow('随机轮换间隔', [['5', '5 分钟'], ['15', '15 分钟'], ['30', '30 分钟'], ['60', '1 小时'], ['120', '2 小时']], function (value) {
      uplink({ t: 'rotation', payload: { intervalMinutes: Number(value) } });
    });
    var scope = selectRow('轮换范围', [['all', '全部壁纸'], ['favorites', '仅收藏']], function (value) {
      uplink({ t: 'rotation', payload: { scope: value } });
    });
    var performance = selectRow('场景性能档位', [['saver', '节能 · 15 FPS'], ['balanced', '均衡 · 30 FPS'], ['quality', '高画质 · 60 FPS']], function (value) {
      uplink({ t: 'scenePerformance', payload: { preset: value } });
    });

    function toggleRow(label, changed) {
      var row = el('label', 'mhub-wp-playback-toggle');
      var input = document.createElement('input');
      input.type = 'checkbox';
      input.addEventListener('change', function () { changed(input.checked); });
      row.appendChild(input);
      row.appendChild(el('span', 'mhub-wp-switch__track'));
      row.appendChild(el('span', '', label));
      grid.appendChild(row);
      return input;
    }

    var rotation = toggleRow('启用定时随机轮换', function (checked) {
      uplink({ t: 'rotation', payload: { enabled: checked } });
    });
    var pauseHidden = toggleRow('窗口隐藏时暂停场景', function (checked) {
      uplink({ t: 'scenePerformance', payload: { pauseWhenHidden: checked } });
    });
    var overlayOfficial = toggleRow('覆盖官方前景层（隐藏设备图标与名称）', function (checked) {
      state.overlayOfficial = checked;
      ensureBgState();
      uplink({ t: 'overlayOfficial', payload: { enabled: checked } });
    });
    overlayOfficial.id = 'mhub-wp-overlay-official';
    sec.appendChild(grid);
    var sceneStatus = el('div', 'mhub-wp-section-hint mhub-wp-scene-status', '');
    sceneStatus.style.display = 'none';
    sec.appendChild(sceneStatus);
    sec.appendChild(el('div', 'mhub-wp-section-hint', '默认保留官方设备图标、名称与电量；开启「覆盖官方前景层」后仅显示壁纸。场景由本地 WebWallGL 渲染，无法初始化的项目会保留静态预览。'));
    return { row: sec, interval: interval, scope: scope, performance: performance, rotation: rotation, pauseHidden: pauseHidden, overlayOfficial: overlayOfficial, sceneStatus: sceneStatus };
  }

  /* ---------- 场景属性（Wallpaper Engine project.json → general.properties） ---------- */
  var propsSig = '';
  var propsCache = { id: '', list: null };

  function propState(item) { return (state.props && state.props[item.id]) || {}; }

  function propSaved(item, prop) {
    var saved = propState(item);
    return saved[prop.key] !== undefined ? saved[prop.key] : prop.value;
  }

  function colorToHex(value) {
    var parts = Array.isArray(value) ? value : String(value == null ? '' : value).replace(/,/g, ' ').trim().split(/\s+/);
    if (!parts || parts.length < 3) return '#ffffff';
    var nums = parts.slice(0, 3).map(Number);
    if (nums.some(function (n) { return !isFinite(n); })) return '#ffffff';
    if (nums.some(function (n) { return n > 1; })) nums = nums.map(function (n) { return n / 255; });
    var hex = '#';
    for (var i = 0; i < 3; i++) {
      var v = Math.round(clamp(nums[i], 0, 1) * 255).toString(16);
      hex += v.length < 2 ? '0' + v : v;
    }
    return hex;
  }

  function hexToColor(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return '1 1 1';
    var n = parseInt(m[1], 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
      .map(function (v) { return String(Math.round(v * 1000) / 1000); }).join(' ');
  }

  function sendProp(item, key, value) {
    if (!item || !state.props) return;
    var next = Object.assign({}, propState(item));
    next[key] = value;
    state.props[item.id] = next;
    uplink({ t: 'props', payload: { id: item.id, values: next } });
  }

  function buildPropRow(item, prop, store) {
    var row = el('div', '');
    row.style.cssText = 'display:flex;align-items:center;gap:10px;min-height:30px;';
    var label = el('span', '', prop.label || prop.key);
    label.style.cssText = 'flex:1;font-size:12px;opacity:.72;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    row.appendChild(label);
    var kind = prop.type;
    var value = propSaved(item, prop);
    if (kind === 'slider') {
      var min = Number.isFinite(Number(prop.min)) ? Number(prop.min) : 0;
      var max = Number.isFinite(Number(prop.max)) ? Number(prop.max) : 1;
      var step = Number(prop.step) > 0 ? Number(prop.step) : (max - min) / 100;
      var range = document.createElement('input');
      range.type = 'range';
      range.min = String(min); range.max = String(max); range.step = String(step);
      range.value = String(Number(value) || min);
      range.style.cssText = 'width:140px;accent-color:#4c8dff;';
      var val = el('span', '', range.value);
      val.style.cssText = 'width:48px;text-align:right;font-size:11px;opacity:.6;font-variant-numeric:tabular-nums;';
      range.addEventListener('input', function () {
        var v = Number(range.value);
        val.textContent = String(v);
        sendProp(item, prop.key, v);
      });
      row.appendChild(range);
      row.appendChild(val);
      store[prop.key] = { kind: 'slider', input: range, val: val };
    } else if (kind === 'color') {
      var color = document.createElement('input');
      color.type = 'color';
      color.value = colorToHex(value);
      color.style.cssText = 'width:44px;height:22px;padding:0;border:none;background:transparent;cursor:pointer;';
      color.addEventListener('input', function () { sendProp(item, prop.key, hexToColor(color.value)); });
      row.appendChild(color);
      store[prop.key] = { kind: 'color', input: color };
    } else if (kind === 'bool') {
      var check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = !!value;
      check.style.cssText = 'width:16px;height:16px;accent-color:#4c8dff;cursor:pointer;';
      check.addEventListener('change', function () { sendProp(item, prop.key, !!check.checked); });
      row.appendChild(check);
      store[prop.key] = { kind: 'bool', input: check };
    } else if (kind === 'combo' && Array.isArray(prop.options) && prop.options.length) {
      var sel = document.createElement('select');
      sel.style.cssText = 'max-width:180px;height:24px;border-radius:6px;font-size:11px;background:rgba(255,255,255,.06);color:inherit;border:1px solid rgba(255,255,255,.12);';
      prop.options.forEach(function (option, index) {
        var opt = document.createElement('option');
        var value = option && typeof option === 'object' ? option.value : String(index);
        var label = option && typeof option === 'object' ? option.label : String(option);
        opt.value = String(value);
        opt.textContent = String(label);
        sel.appendChild(opt);
      });
      sel.value = value === undefined || value === null ? String(prop.options[0] && prop.options[0].value !== undefined ? prop.options[0].value : 0) : String(value);
      if (!sel.value && prop.options.length) sel.selectedIndex = 0;
      sel.addEventListener('change', function () { sendProp(item, prop.key, sel.value); });
      row.appendChild(sel);
      store[prop.key] = { kind: 'combo', input: sel };
    } else if (kind === 'text') {
      row.appendChild(el('span', '', String(value == null ? '' : value)));
    } else {
      var text = document.createElement('input');
      text.type = 'text';
      text.value = String(value == null ? '' : value);
      text.style.cssText = 'width:150px;height:24px;padding:0 8px;border-radius:6px;font-size:11px;background:rgba(255,255,255,.06);color:inherit;border:1px solid rgba(255,255,255,.12);';
      text.addEventListener('change', function () { sendProp(item, prop.key, text.value); });
      row.appendChild(text);
      store[prop.key] = { kind: 'text', input: text };
    }
    return row;
  }

  function renderPropsSection(item) {
    if (!panel || !panel.__refs || !panel.__refs.propsBox) return;
    var box = panel.__refs.propsBox;
    var list = item && Array.isArray(item.props) && (item.kind === 'scene' || item.kind === 'web') ? item.props : null;
    if (list && list.length) {
      propsCache = { id: item.id, list: list };
    } else if (item && propsCache.id === item.id && propsCache.list && propsCache.list.length) {
      /* 从主题设置退出再进入时 item.props 可能被重扫清空，用上次缓存兜底，避免属性面板消失 */
      list = propsCache.list;
    }
    if (!list || !list.length) {
      box.style.display = 'none';
      propsSig = '';
      box.innerHTML = '';
      return;
    }
    box.style.display = '';
    var sig = item.id + '|' + list.map(function (p) { return p.key + ':' + p.type; }).join(',');
    if (sig !== propsSig) {
      propsSig = sig;
      box.innerHTML = '';
      var head = el('div', '', '场景属性 · ' + (item.title || ''));
      head.style.cssText = 'font-size:12px;font-weight:600;letter-spacing:.5px;opacity:.85;margin-bottom:8px;';
      box.appendChild(head);
      box.__inputs = {};
      for (var i = 0; i < list.length; i++) box.appendChild(buildPropRow(item, list[i], box.__inputs));
    }
    var inputs = box.__inputs || {};
    for (var j = 0; j < list.length; j++) {
      var prop = list[j];
      var meta = inputs[prop.key];
      if (!meta) continue;
      var value = propSaved(item, prop);
      if (meta.kind === 'slider') {
        if (document.activeElement !== meta.input) meta.input.value = String(Number(value) || Number(prop.min) || 0);
        meta.val.textContent = String(meta.input.value);
      } else if (meta.kind === 'color') {
        if (document.activeElement !== meta.input) meta.input.value = colorToHex(value);
      } else if (meta.kind === 'bool') {
        meta.input.checked = !!value;
      } else if (meta.kind === 'combo') {
        if (document.activeElement !== meta.input) meta.input.value = String(value);
      } else if (meta.kind === 'text') {
        if (document.activeElement !== meta.input) meta.input.value = String(value == null ? '' : value);
      }
    }
  }

  function renderPlayback() {
    if (!panel || !panel.__refs || !panel.__refs.playback) return;
    var refs = panel.__refs.playback;
    var rotation = state.rotation || {};
    var performance = state.scenePerformance || {};
    refs.rotation.checked = !!rotation.enabled;
    refs.pauseHidden.checked = performance.pauseWhenHidden !== false;
    refs.overlayOfficial.checked = !!state.overlayOfficial;
    if (document.activeElement !== refs.interval) refs.interval.value = String(rotation.intervalMinutes || 30);
    if (document.activeElement !== refs.scope) refs.scope.value = rotation.scope === 'favorites' ? 'favorites' : 'all';
    if (document.activeElement !== refs.performance) refs.performance.value = performance.preset || 'balanced';
    updateSceneStatus();
  }

  window.__mhubWpLibraryResult = function (result) {
    if (!panel || !panel.__refs || !panel.__refs.library) return;
    var node = panel.__refs.library.result;
    node.textContent = result && result.message || '';
    node.setAttribute('data-ok', result && result.ok ? '1' : '0');
    clearTimeout(node.__timer);
    node.__timer = setTimeout(function () { node.textContent = ''; }, 5000);
  };

  function buildPanel() {
    var sec = el('section', 'mhub-wp-card');
    sec.id = 'mhub-wp-panel';
    sec.setAttribute('data-mhub-wp', '1');

    var head = el('div', 'mhub-wp-head');
    var brand = el('div', 'mhub-wp-brand');
    var mark = el('div', 'mhub-wp-mark');
    mark.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8.6" cy="9" r="1.7"/><path d="M21 15.4 16.2 11 7 20"/></svg>';
    var titles = el('div', 'mhub-wp-titles');
    titles.appendChild(el('h3', 'mhub-wp-title', 'M HUB 壁纸 · v' + VERSION));
    titles.appendChild(el('p', 'mhub-wp-sub', '作者：顾小颜 · Wallpaper Engine 本地库 · 仅改变 M HUB 界面背景'));
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
      slider('设备页模糊', 'deviceBlur', 0, 60, 1, ' px'),
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

    /* 场景壁纸自定义属性（对应 Wallpaper Engine 项目里的常规属性） */
    var propsBox = el('div', 'mhub-wp-props');
    propsBox.id = 'mhub-wp-props';
    propsBox.style.cssText = 'display:none;margin:2px 0 12px;padding:10px 12px;border-radius:10px;' +
      'background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.07);';
    sec.appendChild(propsBox);

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

    var library = buildLibrarySection();
    sec.appendChild(library.row);
    var playback = buildPlaybackSection();
    sec.appendChild(playback.row);

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
      grid: grid, switchInput: switchInput, controls: controls, sels: sels, hotkeys: hkRefs,
      library: library, playback: playback, propsBox: propsBox
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
    input.addEventListener('wheel', wheelScroll, { passive: false });
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
      /* 动画类型会决定六幕专属设置是否显示，必须整块重建而不是只同步数值 */
      if (key === 'mode') rebuildSplashPanel();
      else renderSplashPanel();
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

  /* 分阶段开关：直接读写 state.splash.stages[key]，不走扁平 data-sp-key 循环 */
  function spStageSwitch(label, stage) {
    var row = el('label', 'mhub-sp-switch');
    var input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('data-sp-stage', stage);
    input.addEventListener('change', function () {
      if (!state.splash.stages || typeof state.splash.stages !== 'object')
        state.splash.stages = { intro: true, setup: true, steps: true, welcome: true };
      state.splash.stages[stage] = input.checked;
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
    var altMode = state.splash.mode && state.splash.mode !== 'mhub';
    var sec = el('section', 'mhub-wp-card');
    sec.id = 'mhub-splash-panel';
    sec.setAttribute('data-mhub-wp', '1');

    var head = el('div', 'mhub-wp-head');
    var brand = el('div', 'mhub-wp-brand');
    var mark = el('div', 'mhub-wp-mark');
    mark.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3M12 18v3M4.2 7.5l2.6 1.5M17.2 15l2.6 1.5M4.2 16.5l2.6-1.5M17.2 9l2.6-1.5"/><circle cx="12" cy="12" r="3.2"/></svg>';
    var titles = el('div', 'mhub-wp-titles');
    titles.appendChild(el('h3', 'mhub-wp-title', 'M HUB 启动页'));
    titles.appendChild(el('p', 'mhub-wp-sub', altMode
      ? '视频 / 图片 / 液态玻璃动画 · 实时调参'
      : '六幕授权序列 · 液态玻璃 · 真声音效 · 实时调参'));
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
    var mode = spSelect('启动动画类型', 'mode', [
      ['mhub', 'M HUB 原生 · 六幕授权'],
      ['moon', '月下持剑少女 · 线稿上色'],
      ['gallery', '图片开场 · 相册式'],
      ['dragon', '龙娘 · 1080P'],
      ['ios', '手写欢迎 · welcome']
    ]);
    refs.selects.push(mode);
    body.appendChild(mode.row);
    if (state.splash.mode === 'ios') {
      var wname = spText('手写名字（welcome 之后）', 'welcomeName', 'Jay');
      (refs.texts = refs.texts || []).push(wname);
      body.appendChild(wname.row);
    }
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

    /* 仅「M HUB 原生六幕」使用的设置：切到视频/图片/iOS 模式时整组隐藏 */
    var sixOnly = [confirm.row];

    /* 分阶段开关：可单独关闭任意段落 */
    var stageGroup = spGroup('分阶段动画控制');
    body.appendChild(stageGroup);
    sixOnly.push(stageGroup);
    var stageIntro = spStageSwitch('黑幕与洗白（序幕）', 'intro');
    var stageSetup = spStageSwitch('品牌块 / 进度条（底板）', 'setup');
    var stageSteps = spStageSwitch('五步访问授权', 'steps');
    var stageWelcome = spStageSwitch('欢迎访问 M HUB 终幕', 'welcome');
    refs.switches.push(stageIntro, stageSetup, stageSteps, stageWelcome);
    body.appendChild(stageIntro.row);
    body.appendChild(stageSetup.row);
    body.appendChild(stageSteps.row);
    body.appendChild(stageWelcome.row);
    sixOnly.push(stageIntro.row, stageSetup.row, stageSteps.row, stageWelcome.row);

    /* 音效 */
    var sfxGroup = spGroup(altMode ? '视频音量' : '界面音效');
    body.appendChild(sfxGroup);
    var sfx = spSwitch(altMode ? '播放视频声音' : '界面音效', 'sfx');
    var sfxVol = spSlider('音量', 'sfxVolume', 0, 100, 1, ' %');
    refs.switches.push(sfx);
    refs.sliders.push(sfxVol);
    body.appendChild(sfx.row);
    body.appendChild(sfxVol.row);

    /* 语音 */
    var voiceGroup = spGroup('语音播报');
    body.appendChild(voiceGroup);
    sixOnly.push(voiceGroup);
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
    sixOnly.push(voice.row, vSource.row, vVol.row, vRate.row, vPitch.row);

    /* 视觉 */
    var lookGroup = spGroup('视觉与身份');
    body.appendChild(lookGroup);
    sixOnly.push(lookGroup);
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
    sixOnly.push(accent.row, glitchA.row, glitchB.row, idName.row, idCode.row, idLevel.row);

    /* 六幕专属设置整体隐藏（面板头部与音效文案已按模式切换） */
    for (var si = 0; si < sixOnly.length; si++) sixOnly[si].hidden = altMode;
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

  function rebuildSplashPanel() {
    var old = splashPanel;
    if (!old || !old.isConnected) { renderSplashPanel(); return; }
    var fresh = buildSplashPanel();
    if (old.parentNode) old.parentNode.replaceChild(fresh, old);
    renderSplashPanel();
  }

  function renderSplashPanel() {
    if (!splashPanel || !splashPanel.isConnected) return;
    var r = splashPanel.__refs;
    if (!r) return;
    var theme = syncControlTheme();
    splashPanel.setAttribute('data-wp-theme', theme);

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
      var stg = sw.input.getAttribute('data-sp-stage');
      if (wk) sw.input.checked = !!s[wk];
      else if (stg) {
        var st = s.stages || {};
        sw.input.checked = st[stg] !== false;
      }
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

  /* 滚轮经过滑块时只滚动页面：沿事件路径找到真正的滚动容器再接管。
     找不到就让浏览器默认处理，避免像以前那样无条件 preventDefault 后
     官方页面（尤其是自定义导入壁纸的主题设置）反而「划不动」。 */
  function wheelTarget(ev) {
    var path = ev.composedPath ? ev.composedPath() : [];
    for (var i = 0; i < path.length; i++) {
      var node = path[i];
      if (!node || node.nodeType !== 1) continue;
      var cs;
      try { cs = getComputedStyle(node); } catch (e) { continue; }
      var oy = cs.overflowY;
      if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && node.scrollHeight - node.clientHeight > 2) return node;
    }
    return null;
  }

  function wheelScroll(ev) {
    var target = wheelTarget(ev);
    if (!target) return;
    ev.preventDefault();
    target.scrollTop += ev.deltaY;
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
      /* 壁纸层压到宿主内容之下：只替换官方壁纸素材，不再隐藏设备图标、名称、电量等前景层。 */
      'html.mhub-wp-on #mhub-wp-bg{z-index:-1 !important;}',
      'html.mhub-wp-on .app-background,html.mhub-wp-on .wallpaper-background{background-color:transparent !important;background-image:none !important;}',
      /* 仅在壁纸生效时彻底隐藏官方壁纸容器，跟着路由重建也不会重新露出来。 */
      'html.mhub-wp-on .wallpaper-background:not(:has(#mhub-wp-bg)){display:none !important;}',
      'html.mhub-wp-on .wallpaper-background__scenes,html.mhub-wp-on .wallpaper-background__plane,' +
        'html.mhub-wp-on .wallpaper-background__media{display:none !important;}',
      'html.mhub-wp-on .app-background>img,html.mhub-wp-on .app-background>video,' +
        'html.mhub-wp-on .app-background>canvas{display:none !important;}',
      /* 「覆盖官方前景层」开关：仅用户主动开启时，才隐藏宿主下除插件壁纸外的所有直接子层。
         默认关闭，保证设备图标与名称等官方信息完整可见。 */
      'html.mhub-wp-on.mhub-wp-cover .app-background>:not(#mhub-wp-bg),' +
        'html.mhub-wp-on.mhub-wp-cover .wallpaper-background>:not(#mhub-wp-bg){display:none !important;}',
      'html.mhub-wp-on.mhub-wp-cover .wallpaper-background:not(:has(#mhub-wp-bg)){display:none !important;}',
      /* 官方在卡片 hover 时重建的纯背景 div 仍然需要隐藏，否则会盖住壁纸。 */
      'html.mhub-wp-on .app-background>div[class*="background"]:not(#mhub-wp-bg):not(:has(*)),' +
        'html.mhub-wp-on .app-background>div[class*="-bg"]:not(#mhub-wp-bg):not(:has(*)){display:none !important;}',
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
      '.mhub-wp-library,.mhub-wp-playback{margin:12px 0;padding:12px;border:1px solid var(--wp-line);border-radius:11px;background:var(--wp-hover);}',
      '.mhub-wp-section-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:8px;}',
      '.mhub-wp-section-title{font-size:12px;font-weight:650;color:var(--wp-fg);}',
      '.mhub-wp-section-actions{display:flex;align-items:center;gap:7px;flex-wrap:wrap;}',
      '.mhub-wp-source-filter{width:112px;height:28px;}',
      '.mhub-wp-section-hint{margin-top:8px;font-size:11px;line-height:1.6;color:var(--wp-sub);opacity:.78;}',
      '.mhub-wp-library-result:empty{display:none;}',
      '.mhub-wp-library-result{margin:0 0 8px;padding:7px 9px;border-radius:7px;background:rgba(70,170,110,.12);color:#75d99c;font-size:11px;}',
      '.mhub-wp-library-result[data-ok="0"]{background:rgba(255,100,100,.1);color:#ff9d9d;}',
      '.mhub-wp-library-list{display:flex;flex-direction:column;gap:6px;max-height:190px;overflow-y:auto;}',
      '.mhub-wp-library-row{display:flex;align-items:center;gap:10px;padding:8px 9px;border:1px solid var(--wp-line);border-radius:8px;background:var(--wp-fill);}',
      '.mhub-wp-library-row.is-disabled{opacity:.55;}',
      '.mhub-wp-library-info{flex:1;min-width:0;}',
      '.mhub-wp-library-title{display:flex;align-items:center;gap:7px;min-width:0;}',
      '.mhub-wp-library-source{flex:none;padding:0 5px;border-radius:4px;background:var(--wp-hover);color:var(--wp-accent);font-size:10px;}',
      '.mhub-wp-library-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--wp-fg);}',
      '.mhub-wp-library-count{flex:none;font-size:10px;color:var(--wp-sub);}',
      '.mhub-wp-library-path{margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;color:var(--wp-sub);}',
      '.mhub-wp-library-actions{display:flex;gap:6px;flex:none;}',
      '.mhub-wp-library-actions .mhub-wp-btn{height:25px;padding:0 9px;font-size:11px;}',
      '.mhub-wp-library-empty{padding:12px;text-align:center;color:var(--wp-sub);font-size:11px;}',
      '.mhub-wp-btn--danger{color:#ff9d9d;border-color:rgba(255,100,100,.28);}',
      '.mhub-wp-playback-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:8px 16px;}',
      '.mhub-wp-playback-row{display:grid;grid-template-columns:1fr 128px;align-items:center;gap:10px;min-height:30px;font-size:12px;color:var(--wp-sub);}',
      '.mhub-wp-playback-toggle{display:flex;align-items:center;gap:8px;min-height:30px;cursor:pointer;font-size:12px;color:var(--wp-fg);}',
      '.mhub-wp-playback-toggle input{position:absolute;opacity:0;width:0;height:0;}',
      '.mhub-wp-playback-toggle input:checked + .mhub-wp-switch__track{background:var(--wp-accent);}',
      '.mhub-wp-playback-toggle input:checked + .mhub-wp-switch__track::after{transform:translateX(16px);}',
      '.mhub-wp-favorite{position:absolute;z-index:2;top:6px;right:6px;height:22px;padding:0 7px;border:1px solid rgba(255,255,255,.2);border-radius:6px;background:rgba(8,12,20,.7);color:#fff;font:10px/20px "Segoe UI","Microsoft YaHei",sans-serif;cursor:pointer;opacity:.82;}',
      '.mhub-wp-favorite.is-favorite{background:var(--wp-accent);border-color:transparent;opacity:1;}',
      '.mhub-wp-item:focus-visible .mhub-wp-thumb{outline:2px solid var(--wp-accent);outline-offset:2px;}',
      '.mhub-wp-thumb.is-empty::before{content:"无静态预览";position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--wp-sub);font-size:11px;}',
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

    syncControlTheme();

    var cur = currentItem();
    var statusText;
    if (!state.bgId) statusText = '当前：使用 M HUB 官方背景';
    else if (!state.enabled) statusText = '当前：已暂停 M HUB 壁纸（' + (cur ? cur.title : '未知') + '）';
    else statusText = '当前：' + (cur ? cur.title : '已删除的壁纸') + ' · 仅作用于 M HUB 界面' +
      (cur && (cur.kind === 'scene' || cur.kind === 'web') ? ' · 优先实时渲染，失败时回退静态预览' : '');
    refs.status.textContent = statusText;
    refs.switchInput.checked = !!state.enabled;
    refs.switchInput.disabled = !state.bgId;
    renderHotkeyRows(refs.hotkeys);
    renderLibraries();
    renderPlayback();
    renderPropsSection(cur);
    refs.library.filter.value = panel.__libraryFilter || 'all';

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
    var libraryFilter = panel.__libraryFilter || 'all';
    var favorites = Array.isArray(state.favorites) ? state.favorites : [];
    var recent = Array.isArray(state.recent) ? state.recent : [];
    var list = [];
    for (var i = 0; i < state.items.length; i++) {
      var it = state.items[i];
      if (libraryFilter !== 'all' && it.source !== libraryFilter) continue;
      if (filter === 'favorites' && favorites.indexOf(it.id) < 0) continue;
      else if (filter === 'recent' && recent.indexOf(it.id) < 0) continue;
      else if (filter !== 'all' && filter !== 'favorites' && filter !== 'recent' && it.type !== filter) continue;
      if (q && String(it.title).toLowerCase().indexOf(q) < 0) continue;
      list.push(it);
    }
    if (filter === 'recent') {
      list.sort(function (a, b) { return recent.indexOf(a.id) - recent.indexOf(b.id); });
    }

    var counts = { all: state.items.length, favorites: 0, recent: 0 };
    for (var n = 0; n < state.items.length; n++) {
      var type = state.items[n].type || 'other';
      counts[type] = (counts[type] || 0) + 1;
      if (favorites.indexOf(state.items[n].id) >= 0) counts.favorites++;
      if (recent.indexOf(state.items[n].id) >= 0) counts.recent++;
    }
    var defs = [['all', '全部'], ['favorites', '收藏'], ['recent', '最近'], ['scene', '场景'], ['video', '视频'], ['web', '网页'], ['application', '应用']];
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
    var card = document.createElement('div');
    card.className = 'mhub-wp-item' + (item.id === state.bgId ? ' is-current' : '');
    card.setAttribute('data-id', item.id);
    card.setAttribute('role', 'button');
    card.tabIndex = 0;
    card.title = item.title + ' · ' + sourceLabel(item.source);

    var thumb = el('span', 'mhub-wp-thumb');
    var img = document.createElement('img');
    img.alt = item.title;
    img.decoding = 'async';
    img.loading = 'lazy';
    img.setAttribute('data-wp-thumb', item.id);
    img.addEventListener('load', function () { img.classList.add('loaded'); });
    img.addEventListener('error', function () {
      var cached = cachedThumb(item.id);
      if (cached && img.src !== cached) { img.src = cached; return; }
      if (!markThumbAsked(item.id)) return;
      uplink({ t: 'thumb', payload: { id: item.id } });
    });
    var initialThumb = cachedThumb(item.id);
    if (initialThumb) img.src = initialThumb;
    else if (item.thumb || item.preview) img.setAttribute('data-src', item.thumb || item.preview);
    else { img.style.display = 'none'; thumb.classList.add('is-empty'); }
    thumb.appendChild(img);
    thumb.appendChild(el('span', 'mhub-wp-kind', item.typeLabel || '壁纸'));
    var use = el('span', 'mhub-wp-use', item.id === state.bgId ? '使用中' : '使用');
    thumb.appendChild(use);
    var isFavorite = state.favorites.indexOf(item.id) >= 0;
    var favorite = el('button', 'mhub-wp-favorite' + (isFavorite ? ' is-favorite' : ''), isFavorite ? '已收藏' : '收藏');
    favorite.type = 'button';
    favorite.setAttribute('aria-pressed', isFavorite ? 'true' : 'false');
    favorite.addEventListener('click', function (event) {
      event.stopPropagation();
      var index = state.favorites.indexOf(item.id);
      var next = index < 0;
      if (next) state.favorites.push(item.id);
      else state.favorites.splice(index, 1);
      uplink({ t: 'favorite', payload: { id: item.id, favorite: next } });
      panelSig = '';
      renderPanel();
    });
    thumb.appendChild(favorite);

    card.appendChild(thumb);
    card.appendChild(el('span', 'mhub-wp-item__name', item.title));
    card.appendChild(el('span', 'mhub-wp-item__meta', sourceLabel(item.source) + ' · ' + ((item.tags && item.tags.length ? item.tags.join(' · ') : item.typeLabel) || '壁纸')));

    function activate() {
      state.bgId = item.id;
      state.enabled = true;
      mediaInfo = null;
      panelSig = '';
      uplink({ t: 'set', payload: { id: item.id } });
      renderPanel();
      ensureBgState();
    }
    card.addEventListener('click', activate);
    card.addEventListener('keydown', function (event) {
      if (event.target !== card || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      activate();
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
    state.version = data.version || VERSION;
    state.author = data.author || '顾小颜';
    state.items = Array.isArray(data.items) ? data.items : [];
    state.libraries = Array.isArray(data.libraries) ? data.libraries : [];
    state.favorites = Array.isArray(data.favorites) ? data.favorites.slice() : [];
    state.recent = Array.isArray(data.recent) ? data.recent.slice() : [];
    if (data.rotation && typeof data.rotation === 'object') {
      state.rotation = Object.assign({ enabled: false, intervalMinutes: 30, scope: 'all', lastRunAt: 0 }, data.rotation);
    }
    if (data.scenePerformance && typeof data.scenePerformance === 'object') {
      state.scenePerformance = Object.assign({ preset: 'balanced', fps: 30, renderDpr: 1, videoTexScale: 0.75, pauseWhenHidden: true }, data.scenePerformance);
    }
    state.bgId = data.bgId || '';
    state.enabled = !!data.enabled;
    state.overlayOfficial = !!data.overlayOfficial;
    state.error = data.error || null;
    if (data.beautify && typeof data.beautify === 'object' && Date.now() - lastEditAt > 900) {
      for (var k in DEFAULT_BEAUTIFY) {
        if (data.beautify[k] !== undefined) state.beautify[k] = data.beautify[k];
      }
    }
    if (data.props && typeof data.props === 'object') state.props = data.props;
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
    var previous = mediaInfo;
    var same = !!(previous && info && previous.id === info.id && previous.kind === info.kind && previous.sceneBase === info.sceneBase);
    mediaInfo = info && (info.image || info.video || info.sceneBase) ? info : null;
    if (!same) {
      bgKey = '';
      sceneRuntimeRequested = false;
      destroyScene();
    } else if (sceneSession && info) {
      sceneSession.setPerformance(info.performance);
      sceneSession.setFit(currentCrop().fit);
      if (info.props) sceneSession.setProperties(info.props);
      syncSceneVisibility();
    }
    ensureBgState();
    if (panel && panel.isConnected) renderPanel();
  };

  window.__mhubWpSceneRuntimeReady = function () {
    sceneRuntimeRequested = false;
    var isScene = !!(mediaInfo && (mediaInfo.kind === 'scene' || mediaInfo.kind === 'web') && mediaInfo.sceneBase);
    if (!window.__mhubWpScene || !isScene || !state.enabled || state.bgId !== mediaInfo.id || sceneSession) return false;
    var media = bgEl && bgEl.querySelector('.mhub-wp-bg__media');
    if (!media) return false;
    mountScene(media);
    return true;
  };

  window.__mhubWpSceneRuntimeError = function (message) {
    sceneRuntimeRequested = false;
    if (mediaInfo && (mediaInfo.kind === 'scene' || mediaInfo.kind === 'web')) {
      setSceneStatus('error', '已回退静态预览 · 渲染器加载失败：' + String(message || '未知错误').slice(0, 120));
    }
  };

  window.__mhubWpThumb = function (id, dataUrl) {
    if (!id || !dataUrl) return;
    storeThumb(id, dataUrl);
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
  var syncTimer = null;
  var selfTestTimer = null;

  function queueSync() {
    if (syncQueued) return;
    syncQueued = true;
    syncTimer = setTimeout(function () {
      syncTimer = null;
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
      observer = new MutationObserver(function () {
        /* 深色/浅色切换只改 class 或 data-theme，不会增删 DOM；
           先立即换卡片配色，再按原逻辑同步页面结构。 */
        try { syncControlTheme(); } catch (e) { /* ignore */ }
        queueSync();
      });
      var themeAttrs = ['class', 'data-theme', 'theme', 'data-mode', 'data-color-scheme', 'value'];
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: themeAttrs });
      observer.observe(document.documentElement, { attributes: true, attributeFilter: themeAttrs });
    }
    /* 路由切换（hash / history）后立刻重新对齐背景，避免闪回官方壁纸。 */
    window.addEventListener('hashchange', queueSync);
    window.addEventListener('popstate', queueSync);
    document.addEventListener('visibilitychange', syncVideoVisibility);
    listeners.push([window, 'hashchange', queueSync, false]);
    listeners.push([window, 'popstate', queueSync, false]);
    listeners.push([document, 'visibilitychange', syncVideoVisibility, false]);
    uplink({ t: 'ready' });
    selfTestTimer = setTimeout(function () {
      selfTestTimer = null;
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
    if (syncTimer) clearTimeout(syncTimer);
    if (selfTestTimer) clearTimeout(selfTestTimer);
    if (saveTimer) clearTimeout(saveTimer);
    if (splashSaveTimer) clearTimeout(splashSaveTimer);
    syncTimer = null;
    selfTestTimer = null;
    syncQueued = false;
    sceneRuntimeRequested = false;
    thumbCache.clear();
    thumbAsked.clear();
    thumbCacheChars = 0;
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
    hideOfficial(false);
    releaseBgNode();
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
    memoryInfo: function () {
      return {
        thumbEntries: thumbCache.size,
        thumbChars: thumbCacheChars,
        thumbAsked: thumbAsked.size,
        sceneRuntimeLoaded: !!window.__mhubWpScene,
        sceneActive: window.__mhubWpScene ? window.__mhubWpScene.activeCount() : 0,
        backgroundNodes: bgEl ? bgEl.querySelectorAll('img,video,canvas').length : 0
      };
    },
    state: function () { return state; }
  };
})();
