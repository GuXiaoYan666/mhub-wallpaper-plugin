/* ============================================================================
 * M HUB (MCHOSE) — 启动动画运行时
 * ----------------------------------------------------------------------------
 * 时间线、序列节奏、交互规则与音效触发点沿用 dsh-startup-screen：
 *   黑幕 K 标 → 过曝洗白 → 技术档案底板 → 六步访问授权 → 色散揭幕
 *   第 1、2 步等按钮 / Enter / Space；其余步骤等台词念完自动推进。
 *
 * 与 Electron 的接口：
 *   window.dismissStartup(fadeMs) -> Promise
 *     等 line-6 播完 +500ms，淡出后 resolve；SKIP / Esc 立即淡出并 resolve；
 *     20s 硬看门狗兜底，保证不会挂住主进程。
 * ========================================================================== */
(function () {
  'use strict'

  /* 同一窗口只允许存在一份动画实例。主进程可能重复注入本脚本，
     重复实例会同时播两套时间线（声音叠加、窗口被其中一份提前关掉）。 */
  if (window.__MHUB_SPLASH_BOOTED) return
  window.__MHUB_SPLASH_BOOTED = 1

  var root = document.getElementById('startup-root')
  if (!root) return

  /* ── 配置：主进程在 dom-ready 注入 window.__MHUBSplashConfig ───────────── */
  var DEFAULTS = {
    enabled: true,
    theme: 'auto',            // auto = 跟随应用主题；light / dark 强制
    glass: true,
    glassOpacity: 55,
    glassBlur: 18,
    glassSaturate: 160,
    glassBackdropBlur: 0,
    speed: 1,
    requireInteraction: true,
    allowSkip: true,
    sfx: true,
    sfxVolume: 50,
    voice: true,
    voiceSource: 'asset',     // asset = 真声素材 / tts = 系统合成
    voiceVolume: 90,
    voiceRate: 0.9,
    voicePitch: 0.9,
    welcomeName: 'GXY',
    identityName: 'MCHOSE USER',
    identityId: 'MCHOSE-01',
    accessLevel: '03',
    mode: 'mhub',             // mhub=原生六幕 / moon=月下少女 / gallery=图片开场 / dragon=龙娘
    accent: '',
    glitchA: '',
    glitchB: '',
    /* 分阶段开关：可单独关闭任意段落；全部 false 时直接进入 welcome 终幕。 */
    stages: { intro: true, setup: true, steps: true, welcome: true }
  }

  function num(value, min, max, fallback) {
    var n = Number(value)
    if (!isFinite(n)) n = fallback
    return Math.min(max, Math.max(min, n))
  }

  function readConfig(raw) {
    var src = raw && typeof raw === 'object' ? raw : (window.__MHUBSplashConfig || {})
    var out = {}
    for (var k in DEFAULTS) out[k] = DEFAULTS[k]
    for (var k2 in src) {
      if (Object.prototype.hasOwnProperty.call(src, k2) && src[k2] !== undefined && src[k2] !== null) out[k2] = src[k2]
    }
    out.speed = num(out.speed, 0.35, 3, 1)
    out.glassOpacity = num(out.glassOpacity, 15, 95, 55) / 100
    out.glassBlur = num(out.glassBlur, 0, 60, 18)
    out.glassSaturate = num(out.glassSaturate, 100, 200, 160)
    out.glassBackdropBlur = num(out.glassBackdropBlur, 0, 80, 0)
    out.sfxVolume = num(out.sfxVolume, 0, 100, 50)
    out.voiceVolume = num(out.voiceVolume, 0, 100, 90)
    out.voiceRate = num(out.voiceRate, 0.5, 1.5, 0.9)
    out.voicePitch = num(out.voicePitch, 0.5, 1.5, 0.9)
    out.theme = /^(auto|light|dark)$/.test(String(out.theme)) ? String(out.theme) : 'auto'
    out.voiceSource = out.voiceSource === 'tts' ? 'tts' : 'asset'
    out.mode = ['moon', 'gallery', 'dragon', 'ios', 'launcher'].indexOf(String(out.mode)) >= 0 ? String(out.mode) : 'mhub'
    out.glass = !!out.glass
    out.enabled = out.enabled !== false
    out.sfx = !!out.sfx
    out.voice = !!out.voice
    out.requireInteraction = !!out.requireInteraction
    out.allowSkip = !!out.allowSkip
    /* stages：用户可能只覆盖部分键，缺失的补回 true（默认全开）。 */
    var defStages = DEFAULTS.stages
    var userStages = (out.stages && typeof out.stages === 'object') ? out.stages : {}
    out.stages = {
      intro: userStages.intro !== false,
      setup: userStages.setup !== false,
      steps: userStages.steps !== false,
      welcome: userStages.welcome !== false
    }
    return out
  }

  var C = readConfig()

  /* ── 其他动画类型：视频 / 图片开场 ─────────────────────────────────────
     这几套沿用原项目素材与时间线，只叠加 M HUB 品牌层，不再走六幕授权序列。 */
  if (C.mode !== 'mhub') {
    startAltMode(C)
    return
  }

  function startAltMode(cfg) {
    var base = window.__MHUB_SPLASH_ASSETS || ''
    /* 其他动画只保留自己的声音：清掉宿主页面遗留的媒体节点，
       并把可能还在念的语音（六幕授权台词）一起掐掉。 */
    try { if (window.speechSynthesis) window.speechSynthesis.cancel() } catch (e) {}
    try {
      var stale = document.querySelectorAll('audio,video')
      for (var si = 0; si < stale.length; si++) {
        try { stale[si].pause() } catch (e) {}
        try { if (stale[si].parentNode) stale[si].parentNode.removeChild(stale[si]) } catch (e) {}
      }
    } catch (e) { /* noop */ }
    /* 视频/图片/iOS 模式独立计时器集合：六幕的 timers 在外层函数靠后声明，
       这里若直接共用会是 undefined，iOS 模式一推就抛 TypeError 导致启动动画直接白屏退出。 */
    var timers = []
    if (root) root.style.display = 'none'

    var style = document.createElement('style')
    style.textContent =
      '.dsu-alt{position:fixed;inset:0;z-index:9999;background:#05070c;overflow:hidden;opacity:1;' +
      'transition:opacity .6s ease;font-family:"Segoe UI",system-ui,sans-serif}' +
      '.dsu-alt-stage{position:absolute;inset:0}' +
      '.dsu-alt-video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:#05070c}' +
      '.dsu-alt-frame{position:absolute;inset:0;width:100%;height:100%;border:0;background:#05070c}' +
      '.dsu-alt-brand{position:absolute;left:48px;top:40px;display:flex;align-items:center;gap:14px;pointer-events:none;' +
      'color:rgba(255,255,255,.9);text-shadow:0 2px 18px rgba(0,0,0,.55);opacity:0;transform:translateY(-8px);' +
      'transition:opacity .8s ease .3s,transform .8s ease .3s;z-index:3}' +
      '.dsu-alt-brand svg{width:34px;height:27px;fill:currentColor}' +
      '.dsu-alt-brand b{font-size:20px;letter-spacing:.24em;font-weight:600}' +
      '.dsu-alt-brand span{font-size:10px;letter-spacing:.34em;opacity:.6}' +
      '.dsu-alt.in .dsu-alt-brand{opacity:1;transform:none}' +
      '.dsu-alt-skip{position:absolute;right:36px;bottom:32px;z-index:4;padding:9px 18px;border-radius:999px;' +
      'border:1px solid rgba(255,255,255,.35);background:rgba(8,10,16,.35);color:rgba(255,255,255,.85);' +
      'font-size:12px;letter-spacing:.18em;cursor:pointer;backdrop-filter:blur(10px)}' +
      '.dsu-alt-skip:hover{border-color:rgba(255,255,255,.7);color:#fff}' +
      /* ── iOS 26 开机动画：复刻参考视频 boot 观感 ── */
      '.dsu-ios{background:#080a14}' +
      '.dsu-ios-bg{position:absolute;inset:0;z-index:0;overflow:hidden;background:radial-gradient(120% 100% at 50% 50%,#1e2856 0%,#0e1232 50%,#04050f 100%);transition:opacity 1.2s ease}' +
      '.dsu-ios-bg img,.dsu-ios-bg video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0;' +
      'filter:brightness(.18) blur(48px) saturate(.6) contrast(1.1);' +
      'transition:opacity 1.6s cubic-bezier(.2,.7,.2,1),filter 2.4s cubic-bezier(.2,.7,.2,1);will-change:opacity,filter}' +
      '.dsu-ios.ready .dsu-ios-bg img,.dsu-ios.ready .dsu-ios-bg video{opacity:.92;filter:brightness(.22) blur(32px) saturate(.5) contrast(1.05)}' +
      '.dsu-ios-bg-color{position:absolute;inset:0;background:radial-gradient(120% 100% at 50% 42%,#3a4aa0 0%,#1e2560 40%,#0a0d24 100%);opacity:0;transition:opacity 1.6s ease}' +
      '.dsu-ios.ready .dsu-ios-bg-color{opacity:1}' +
      '.dsu-ios-stage{position:absolute;inset:0;z-index:2;display:flex;align-items:center;justify-content:center}' +
      '.dsu-ios-center{position:relative;width:100%;height:100%;display:flex;align-items:center;justify-content:center}' +
      '.dsu-ios-mark{width:156px;height:120px;opacity:0;transform:scale(.85);transition:opacity 1.1s ease,transform 1.4s cubic-bezier(.16,.8,.24,1);filter:none}' +
      '.dsu-ios.in .dsu-ios-mark{opacity:1;transform:none}' +
      '.dsu-ios-mark.morph-out{opacity:0;transform:scale(1.15);filter:blur(20px);transition:opacity .6s ease,transform .6s ease,filter .6s ease}' +
      '.dsu-ios-word{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%) scale(1);margin:0;padding:0;white-space:nowrap;text-align:center;' +
      'font-family:"SF Pro Rounded","PingFang SC","Microsoft YaHei UI","Microsoft YaHei",-apple-system,BlinkMacSystemFont,system-ui,sans-serif;' +
      'font-weight:300;letter-spacing:.01em;line-height:1;font-size:clamp(52px,12vw,156px);' +
      'color:#ffffff;opacity:0;filter:blur(18px);will-change:opacity,filter,transform;pointer-events:none;text-shadow:0 2px 4px rgba(0,0,0,.25)}' +
      '.dsu-ios-word.morph-in{opacity:1;filter:blur(0);transition:opacity .7s ease .06s,filter .7s cubic-bezier(.2,.7,.2,1) .06s,transform .7s cubic-bezier(.2,.7,.2,1) .06s}' +
      '.dsu-ios-word.morph-out{opacity:0;filter:blur(20px);transform:translate(-50%,-50%) scale(1.1);transition:opacity .65s ease,filter .65s ease,transform .65s cubic-bezier(.2,.7,.2,1)}' +
      '.dsu-ios-status{position:absolute;left:0;right:0;top:0;z-index:3;display:flex;justify-content:space-between;align-items:center;padding:22px 36px 0;' +
      'color:rgba(255,255,255,.95);font-family:-apple-system,"SF Pro Text",system-ui,sans-serif;font-size:15px;font-weight:600;letter-spacing:.01em;' +
      'opacity:0;transition:opacity 1.2s ease .4s;pointer-events:none}' +
      '.dsu-ios.in .dsu-ios-status{opacity:1}' +
      '.dsu-ios-status .right{display:flex;align-items:center;gap:10px;font-size:13px;font-weight:500}' +
      '.dsu-ios-battery{width:26px;height:13px;border:1.5px solid rgba(255,255,255,.9);border-radius:3.5px;position:relative;padding:1.5px;box-sizing:border-box;display:inline-block;vertical-align:middle}' +
      '.dsu-ios-battery::after{content:"";position:absolute;right:-3.5px;top:3.5px;width:2px;height:5px;background:rgba(255,255,255,.9);border-radius:0 1.5px 1.5px 0}' +
      '.dsu-ios-battery i{display:block;height:100%;width:78%;background:rgba(255,255,255,.92);border-radius:1px}' +
      '.dsu-ios-homebar{position:absolute;left:50%;bottom:20px;transform:translateX(-50%);z-index:3;width:140px;height:5px;border-radius:99px;' +
      'background:rgba(255,255,255,.95);opacity:0;transition:opacity 1.2s ease .5s;pointer-events:none}' +
      '.dsu-ios.in .dsu-ios-homebar{opacity:1}' +
      '.dsu-ios.dsu-ios-finish .dsu-ios-stage,.dsu-ios.dsu-ios-finish .dsu-ios-status,.dsu-ios.dsu-ios-finish .dsu-ios-homebar{opacity:0;transition:opacity .7s ease}' +
      '.dsu-ios.dsu-ios-finish .dsu-ios-bg img,.dsu-ios.dsu-ios-finish .dsu-ios-bg video{filter:brightness(.1) blur(24px);transition:filter .8s ease}' +
      '.dsu-ios .dsu-alt-brand{display:none}'
      /* 龙娘视频内部已烧录 M HUB 品牌（按钮 / 图标 / 侧栏），不再叠加角标避免遮挡 UI */
      '.dsu-alt-dragon .dsu-alt-brand{display:none}'
    document.head.appendChild(style)

    var wrap = document.createElement('div')
    wrap.className = 'dsu-alt dsu-alt-' + cfg.mode
    var stage = document.createElement('div')
    stage.className = 'dsu-alt-stage'
    wrap.appendChild(stage)

    var brand = document.createElement('div')
    brand.className = 'dsu-alt-brand'
    brand.innerHTML = '<svg viewBox="0 0 745 576" aria-hidden="true"><use href="#kmark"></use></svg>' +
      '<b>M HUB</b><span>MCHOSE · CONTROL CENTER</span>'
    wrap.appendChild(brand)

    var skip = document.createElement('button')
    skip.type = 'button'
    skip.className = 'dsu-alt-skip'
    skip.textContent = 'SKIP ›'
    wrap.appendChild(skip)

    document.body.appendChild(wrap)
    requestAnimationFrame(function () { wrap.classList.add('in') })

    var PREF = '[mhub-wp]'
    var done = false
    var timer = 0
    var startedAtAlt = Date.now()
    var MIN_ALT_PLAY = 3500   /* 主应用可能在主窗口 ready-to-show 时就调 dismissStartup，
                                给自定义动画至少 3.5s 不被外部关闭的保护窗口
                                （K 标 1.7s + 第一个词变形 1.35s，保护到变形稳定） */
    /* 视频模式拿到真实时长后，把保护窗口延长到整段视频播完，
       否则主窗口一就绪 dismissStartup 就会把 14s 的龙娘视频提前切掉。 */
    var altMinPlay = MIN_ALT_PLAY

    /* 拦截原生 window.close()——如果主应用直接 win.close() 会走这里 */
    var realClose = window.close.bind(window)
    window.close = function () {
      var since = Date.now() - startedAtAlt
      try { console.log(PREF + JSON.stringify({ t: 'close-called', since: since, stack: (new Error()).stack })) } catch (e) {}
      if (!done && since < altMinPlay) {
        /* 保护窗口内：阻止 window.close()，延迟到保护期过后 */
        var delay = altMinPlay - since + 100
        try { console.log(PREF + JSON.stringify({ t: 'close-blocked', delay: delay })) } catch (e) {}
        setTimeout(realClose, delay)
        return
      }
      try { console.log(PREF + JSON.stringify({ t: 'close-allowed', since: since })) } catch (e) {}
      realClose()
    }

    function finish(fadeMs) {
      if (done) return
      done = true
      clearTimeout(timer)
      try { console.log(PREF + JSON.stringify({ t: 'finish-called', since: Date.now() - startedAtAlt, fade: fadeMs })) } catch (e) {}
      /* ★ 放行主进程 close 拦截：告诉主进程动画播完了，可以让 splash 窗口关闭 */
      try { console.log(PREF + JSON.stringify({ t: 'splashAllowClose' })); } catch (e) {}
      var fade = Math.max(240, Number(fadeMs) || 600)
      try { location.hash = 'done' } catch (e) {}
      try { document.title = 'M HUB #done' } catch (e) {}
      wrap.style.transitionTimingFunction = 'cubic-bezier(.4,0,.2,1)'
      wrap.style.transitionDuration = fade + 'ms'
      wrap.style.opacity = '0'
      setTimeout(function () {
        try { console.log(PREF + JSON.stringify({ t: 'calling-realClose', since: Date.now() - startedAtAlt })); } catch (e) {}
        try { realClose() } catch (e) {}
      }, fade + 80)
    }
    function dismissAltSafely(fadeMs, source) {
      var delay = Math.max(0, Math.max(MIN_ALT_PLAY, altMinPlay) - (Date.now() - startedAtAlt))
      try { console.log(PREF + JSON.stringify({ t: 'dismiss-request', source: source || '', delay: delay, since: Date.now() - startedAtAlt })) } catch (e) {}
      if (delay > 0) {
        setTimeout(function () { finish(Number(fadeMs) || 600) }, delay)
      } else {
        finish(Number(fadeMs) || 600)
      }
    }
    window.__mhubForceDone = function () { finish(420) }
    window.dismissStartup = function (fadeMs) {
      dismissAltSafely(fadeMs, 'runtime')
      return Promise.resolve()
    }
    var queued = window.__startupDismissQueue || []
    window.__startupDismissQueue = []
    try { console.log(PREF + JSON.stringify({ t: 'altmode-started', queueLen: queued.length, mode: cfg.mode })) } catch (e) {}
    queued.forEach(function (item) {
      dismissAltSafely(item.fadeMs, 'queued')
      item.resolve()
    })

    requestAnimationFrame(function () { if (cfg.allowSkip) skip.hidden = false })
    skip.hidden = !cfg.allowSkip
    skip.addEventListener('click', function () { finish(420) })
    document.addEventListener('keydown', function (e) {
      if (!cfg.allowSkip) return
      if (e.key === 'Escape' || e.key === 'Esc') finish(420)
    })

    var speed = Math.max(0.5, Number(cfg.speed) || 1)

    /* ────────────────────────────────────────────────────────────────────────
       iOS 18「Welcome」流线开机动画（复刻 iPhone / iPad 首次开机）
       一条彩色流线：勾勒 Welcome <名字> → 流向右中位置勾勒 MCHOSE K 标
       → 从圆形图标中心隧道式放大 → 进入应用
       ──────────────────────────────────────────────────────────────────────── */
    if (cfg.mode === 'ios') {
      iosWelcomeBranch()
      return
    }
    if (cfg.mode === 'launcher') {
      launcherBranch()
      return
    }

    function iosWelcomeBranch() {
      var T = Math.max(0.5, Number(cfg.speed) || 1)
      var NS = 'http://www.w3.org/2000/svg'
      wrap.classList.add('iosv')

      /* ── 样式：iOS 18 毛玻璃（模糊 + 乳白薄雾，不使用液态玻璃的高光折射） ── */
      var css = document.createElement('style')
      css.textContent = [
        '.dsu-alt.iosv{background:#07080d}' +
        '.dsu-iosv-bg{position:absolute;inset:-5%;z-index:0;overflow:hidden}' +
        '.dsu-iosv-bg img,.dsu-iosv-bg video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;' +
        'filter:blur(38px) saturate(128%) brightness(.45);opacity:0;transition:opacity 1.2s ease,filter 2s ease;will-change:opacity,filter}' +
        '.iosv.ready .dsu-iosv-bg img,.iosv.ready .dsu-iosv-bg video{opacity:1;filter:blur(26px) saturate(136%) brightness(.5)}' +
        '.dsu-iosv-bg-fallback{position:absolute;inset:0;background:radial-gradient(120% 110% at 50% 28%,#48548f 0%,#232a52 44%,#0a0c18 100%)}' +
        '.dsu-iosv-frost{position:absolute;inset:0;z-index:2;pointer-events:none;opacity:0;transition:opacity 1.5s ease;' +
        'background:linear-gradient(158deg,rgba(255,255,255,.14) 0%,rgba(255,255,255,.055) 34%,rgba(255,255,255,.02) 66%,rgba(255,255,255,.07) 100%);' +
        'backdrop-filter:blur(34px) saturate(115%);-webkit-backdrop-filter:blur(34px) saturate(115%)}' +
        '.iosv.ready .dsu-iosv-frost{opacity:1}' +
        '.dsu-iosv-veil{position:absolute;inset:0;z-index:2;pointer-events:none;' +
        'background:radial-gradient(120% 100% at 50% 34%,rgba(4,6,12,.55) 0%,rgba(3,4,9,.72) 58%,rgba(1,2,5,.9) 100%)}' +
        '.dsu-iosv-svg{position:absolute;inset:0;z-index:4;width:100%;height:100%;display:block}' +
        '#iosvWorld{transform-box:view-box;transform-origin:1120px 445px;will-change:transform}' +
        '#iosvWord,#iosvK,#iosvRing,#iosvLink,#iosvTunnel{fill:none;stroke:url(#iosvStroke);stroke-linecap:round;stroke-linejoin:round;' +
        'vector-effect:non-scaling-stroke}' +
        '#iosvWordIn path,#iosvK path{fill:none;stroke:url(#iosvStroke);stroke-linecap:round;stroke-linejoin:round;vector-effect:non-scaling-stroke}' +
        '#iosvWordIn path{stroke-width:3}' +
        '#iosvK path{stroke-width:2.6}' +
        '#iosvLink{stroke-width:2.8}' +
        '#iosvRing{transform-box:view-box;transform-origin:1120px 445px}' +
        '#iosvRing circle{fill:none;stroke:url(#iosvStroke);stroke-width:1.5;vector-effect:non-scaling-stroke}' +
        '#iosvTunnel circle{fill:none;stroke:url(#iosvStroke);stroke-width:1.2;vector-effect:non-scaling-stroke}' +
        '.dsu-iosv-flash{position:absolute;inset:0;z-index:6;pointer-events:none;opacity:0;' +
        'background:radial-gradient(82% 82% at 70% 49%,#ffffff 0%,rgba(255,255,255,.99) 46%,rgba(255,255,255,.94) 78%,rgba(255,255,255,.86) 100%)}' +
        '.iosv .dsu-alt-brand{display:none}'
      ].join('')
      document.head.appendChild(css)

      /* ── 背景：当前驱动壁纸（模糊 + 毛玻璃） ── */
      var bg = document.createElement('div')
      bg.className = 'dsu-iosv-bg'
      var wp = cfg.wpBg
      if (wp && wp.kind === 'video' && wp.url) {
        var bv = document.createElement('video')
        bv.src = wp.url; bv.muted = true; bv.loop = true; bv.autoplay = true; bv.playsInline = true
        if (wp.poster) bv.poster = wp.poster
        bg.appendChild(bv)
        try { bv.play().catch(function () {}) } catch (e) {}
      } else if (wp && wp.kind === 'image' && wp.url) {
        var bi = document.createElement('img')
        bi.src = wp.url; bi.alt = ''
        bg.appendChild(bi)
      } else {
        var bf = document.createElement('div')
        bf.className = 'dsu-iosv-bg-fallback'
        bg.appendChild(bf)
      }
      wrap.appendChild(bg)
      var frost = document.createElement('div'); frost.className = 'dsu-iosv-frost'; wrap.appendChild(frost)
      var veil = document.createElement('div'); veil.className = 'dsu-iosv-veil'; wrap.appendChild(veil)

      /* ── SVG 画布 ── */
      var svg = document.createElementNS(NS, 'svg')
      svg.setAttribute('class', 'dsu-iosv-svg')
      svg.setAttribute('viewBox', '0 0 1600 900')
      svg.setAttribute('preserveAspectRatio', 'xMidYMid slice')
      var STOP = '<stop offset="0" stop-color="#64D2FF"/><stop offset=".16" stop-color="#0A84FF"/>' +
        '<stop offset=".34" stop-color="#5E5CE6"/><stop offset=".5" stop-color="#BF5AF2"/>' +
        '<stop offset=".64" stop-color="#FF2D55"/><stop offset=".78" stop-color="#FF9F0A"/>' +
        '<stop offset=".9" stop-color="#FFD60A"/><stop offset="1" stop-color="#30D158"/>'
      var KMARK = '<path d="M275 0 L260 10 L2 270 L0 430 L5 436 L12 438 L13 438 L21 434 L435 20 L438 8 L431 0 Z"/>' +
        '<path d="M582 0 L568 9 L302 275 L298 284 L298 293 L303 303 L572 571 L581 576 L737 576 L744 569 L743 559 L531 348 L474 290 L474 286 L744 16 L745 8 L737 0 Z"/>' +
        '<path d="M227 358 L214 363 L18 559 L16 568 L23 576 L180 576 L188 572 L304 456 L310 442 L306 427 L244 364 L230 358 Z"/>'
      svg.innerHTML =
        '<defs>' +
        '<linearGradient id="iosvStroke" x1="0" y1="0" x2="1" y2="1">' + STOP + '</linearGradient>' +
        '<linearGradient id="iosvFill" x1="0" y1="0" x2="1" y2="0">' + STOP + '</linearGradient>' +
        '<filter id="iosvGlowWord" x="-30%" y="-60%" width="160%" height="220%">' +
        '<feGaussianBlur stdDeviation="46" result="b"/>' +
        '<feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>' +
        '<filter id="iosvGlowK" x="-40%" y="-40%" width="180%" height="180%">' +
        '<feGaussianBlur stdDeviation="9" result="b"/>' +
        '<feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>' +
        '</defs>' +
        '<g id="iosvWorld">' +
        '<g id="iosvWord" filter="url(#iosvGlowWord)"><g id="iosvWordIn"></g></g>' +
        '<path id="iosvLink" d=""/>' +
        '<g id="iosvK" opacity="0" filter="url(#iosvGlowK)" transform="translate(1120 445) scale(.434) translate(-372.5 -288)">' + KMARK + '</g>' +
        '<g id="iosvTunnel" opacity="0"><circle cx="1120" cy="445" r="150"/><circle cx="1120" cy="445" r="210"/>' +
        '<circle cx="1120" cy="445" r="285"/><circle cx="1120" cy="445" r="360"/></g>' +
        '<g id="iosvRing" opacity="0"><circle cx="1120" cy="445" r="188"/><circle cx="1120" cy="445" r="218"/></g>' +
        '</g>'
      wrap.appendChild(svg)
      var flash = document.createElement('div'); flash.className = 'dsu-iosv-flash'; wrap.appendChild(flash)

      var world = svg.querySelector('#iosvWorld')
      var wordOuter = svg.querySelector('#iosvWord')
      var wordG = svg.querySelector('#iosvWordIn')
      var link = svg.querySelector('#iosvLink')
      var kG = svg.querySelector('#iosvK')
      var ringG = svg.querySelector('#iosvRing')
      var tunnelG = svg.querySelector('#iosvTunnel')

      var name = String(cfg.welcomeName || 'GXY').replace(/\s+/g, ' ').trim().slice(0, 18)
      var text = ('Welcome ' + name).trim()

      /* 字形轮廓数据按需加载（仅 welcome 动画使用） */
      function loadGlyphs(done) {
        if (window.__MHUB_WELCOME_GLYPHS) { done(); return }
        var gs = document.createElement('script')
        gs.src = (window.__MHUB_SPLASH_ASSETS || './startup-assets/') + 'welcome-glyphs.js'
        gs.onload = function () { done() }
        gs.onerror = function () { done() }
        document.head.appendChild(gs)
      }
      loadGlyphs(function () {

      /* ── 用字形轮廓数据搭建文字（每个字母一条 path，轮廓按字体顺序勾勒） ── */
      var G = window.__MHUB_WELCOME_GLYPHS || null
      var glyphPaths = []
      var cursor = 0
      var missing = 0
      if (G && G.glyphs) {
        for (var ci = 0; ci < text.length; ci++) {
          var ch = text.charAt(ci)
          var g = G.glyphs[ch]
          if (!g && ch === ' ') g = { a: G.units * 0.25, d: '' }
          if (!g) { missing++; g = G.glyphs['?'] }
          if (!g) continue
          if (g.d) {
            var p = document.createElementNS(NS, 'path')
            p.setAttribute('d', g.d)
            p.setAttribute('transform', 'translate(' + cursor + ' 0)')
            p.setAttribute('fill-rule', 'evenodd')
            p.__ox = cursor
            wordG.appendChild(p)
            glyphPaths.push(p)
          }
          cursor += g.a
        }
      }

      var fallbackWord = false
      var cxu = 0, cyu = 0
      if (!glyphPaths.length || missing > 0) {
        fallbackWord = true
        while (wordG.firstChild) wordG.removeChild(wordG.firstChild)
        var tEl = document.createElementNS(NS, 'text')
        tEl.setAttribute('x', '0'); tEl.setAttribute('y', '0')
        tEl.setAttribute('text-anchor', 'middle')
        tEl.setAttribute('font-family', '"Segoe Script","Snell Roundhand","Brush Script MT","PingFang SC","Microsoft YaHei",cursive')
        tEl.setAttribute('font-size', '168')
        tEl.setAttribute('fill', 'url(#iosvFill)')
        tEl.setAttribute('opacity', '0')
        tEl.textContent = text
        wordG.appendChild(tEl)
        wordG.setAttribute('transform', 'translate(800 486)')
      } else {
        var bb = wordG.getBBox()
        var s = Math.min(bb.width ? 1160 / bb.width : 1, bb.height ? 236 / bb.height : 1)
        if (!isFinite(s) || s <= 0) s = 0.1
        cxu = bb.x + bb.width / 2
        cyu = bb.y + bb.height / 2
        wordG.setAttribute('transform',
          'translate(800 450) scale(' + s + ' ' + (-s) + ') translate(' + (-cxu) + ' ' + (-cyu) + ')')
        wordG.__scale = s
      }

      /* ── 书写节奏：按屏幕像素长度换算，速度贴近苹果原生 ── */
      var wordScale = wordG.__scale || 0.1
      var segs = glyphPaths.map(function (p) {
        var len = 0
        try { len = p.getTotalLength() || 0 } catch (e) { len = 0 }
        var a = null, b = null
        try { a = p.getPointAtLength(0); b = p.getPointAtLength(len) } catch (e) { a = b = null }
        var ox = p.__ox || 0
        return {
          el: p, len: len,
          sx: a ? a.x + ox : 0, sy: a ? a.y : 0,
          ex: b ? b.x + ox : 0, ey: b ? b.y : 0
        }
      }).filter(function (it) { return it.len > 0.5 })

      var totalPx = 0
      for (var si = 0; si < segs.length; si++) totalPx += segs[si].len * wordScale
      var wordSec = Math.max(3.2, Math.min(4.3, totalPx / 400))
      var pxPerSec = totalPx / wordSec

      var t0 = 0.4
      var t = t0
      var prevSeg = null
      for (var gi = 0; gi < segs.length; gi++) {
        var seg = segs[gi]
        var el = seg.el
        var gx = seg.sx - (prevSeg ? prevSeg.ex : seg.sx)
        var gy = seg.sy - (prevSeg ? prevSeg.ey : seg.sy)
        var jumpPx = Math.hypot(gx, gy) * wordScale
        /* 上一笔的收笔到下一笔起笔之间用短线连起来；太远的自然提笔，避免长斜线穿过画面 */
        if (prevSeg && jumpPx > 1 && jumpPx < 50) {
          var bridge = document.createElementNS(NS, 'path')
          bridge.setAttribute('d', 'M' + prevSeg.ex + ' ' + prevSeg.ey + ' L' + seg.sx + ' ' + seg.sy)
          bridge.style.stroke = 'url(#iosvStroke)'
          bridge.style.strokeWidth = '2'
          bridge.style.fill = 'none'
          bridge.setAttribute('vector-effect', 'non-scaling-stroke')
          wordG.appendChild(bridge)
          var bLen = bridge.getTotalLength()
          bridge.style.strokeDasharray = (bLen + 1) + ' ' + (bLen + 1)
          bridge.style.strokeDashoffset = bLen + 1
          var bDur = Math.max(30, (jumpPx / pxPerSec) * 1000)
          bridge.animate([{ strokeDashoffset: bLen + 1 }, { strokeDashoffset: 0 }],
            { duration: bDur, delay: t * 1000, easing: 'linear', fill: 'forwards' })
          t += jumpPx / pxPerSec
        }
        el.style.strokeDasharray = (seg.len + 1) + ' ' + (seg.len + 1)
        el.style.strokeDashoffset = seg.len + 1
        var dur = Math.max(60, (seg.len * wordScale / pxPerSec) * 1000)
        el.animate([{ strokeDashoffset: seg.len + 1 }, { strokeDashoffset: 0 }],
          { duration: dur, delay: t * 1000, easing: 'linear', fill: 'forwards' })
        t += dur / 1000
        /* 每一笔落墨后立刻补同色填充，形成苹果那种彩色实心字 */
        el.style.fill = 'url(#iosvFill)'
        el.style.fillOpacity = '0'
        el.animate([{ fillOpacity: 0 }, { fillOpacity: .92 }],
          { duration: 460, delay: t * 1000, easing: 'ease', fill: 'forwards' })
        prevSeg = seg
      }
      var wordEnd = t

      if (fallbackWord) {
        var ft = wordG.firstChild
        if (ft) ft.animate([{ opacity: 0 }, { opacity: .95 }], { duration: 1400, delay: 400, easing: 'ease', fill: 'forwards' })
        wordEnd = 1.9
      }

      /* ── 转场：文字左移淡出，流线转向右中位置画 K 标 ── */
      var kPaths = Array.prototype.slice.call(kG.querySelectorAll('path'))
      var lastSeg = segs.length ? segs[segs.length - 1] : null
      var wSX = lastSeg ? 800 + wordScale * (lastSeg.ex - cxu) : 720
      var wSY = lastSeg ? 450 - wordScale * (lastSeg.ey - cyu) : 480
      /* 从文字收笔处找 K 标最近的一笔起笔点，保证流线自然接上 */
      var kOrder = []
      var kStartIndex = 0
      var kBest = Infinity
      for (var kj = 0; kj < kPaths.length; kj++) {
        var kp0 = null
        try { kp0 = kPaths[kj].getPointAtLength(0) } catch (e) { kp0 = { x: 275, y: 0 } }
        var kwx = 1120 + 0.434 * (kp0.x - 372.5)
        var kwy = 445 + 0.434 * (kp0.y - 288)
        kOrder.push({ p: kPaths[kj], x: kwx, y: kwy })
        var kdd = Math.hypot(kwx - wSX, kwy - wSY)
        if (kdd < kBest) { kBest = kdd; kStartIndex = kj }
      }
      kOrder = kOrder.slice(kStartIndex).concat(kOrder.slice(0, kStartIndex))
      var kSX = kOrder[0].x
      var kSY = kOrder[0].y
      var linkD = 'M' + wSX + ' ' + wSY +
        ' C' + (wSX - 44) + ' ' + (wSY - 44) +
        ' ' + (kSX + 36) + ' ' + (kSY - 16) +
        ' ' + kSX + ' ' + kSY
      link.setAttribute('d', linkD)
      var linkLen = 0
      try { linkLen = link.getTotalLength() } catch (e) { linkLen = 220 }
      link.style.strokeDasharray = (linkLen + 1) + ' ' + (linkLen + 1)
      link.style.strokeDashoffset = linkLen + 1
      link.style.opacity = '1'
      link.animate([{ strokeDashoffset: linkLen + 1 }, { strokeDashoffset: 0 }],
        { duration: 520, delay: (wordEnd - 0.06) * 1000, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' })

      wordOuter.animate(
        [{ opacity: 1, transform: 'translateX(0px)' }, { opacity: 0, transform: 'translateX(-230px)' }],
        { duration: 1450, delay: (wordEnd + 0.02) * 1000, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' })

      /* K 标：从最近的一笔开始顺序描出，速度略快于文字 */
      var kStart = wordEnd + 0.3
      var kt = kStart
      for (var ki = 0; ki < kOrder.length; ki++) {
        var kp = kOrder[ki].p
        var kl = 0
        try { kl = kp.getTotalLength() } catch (e) { kl = 300 }
        kp.style.strokeDasharray = (kl + 1) + ' ' + (kl + 1)
        kp.style.strokeDashoffset = kl + 1
        /* K 标组缩放 0.434：按屏幕像素控制书写速度 */
        var kdur = Math.max(180, Math.min(720, (kl * 0.434 / 1400) * 1000))
        kp.animate([{ strokeDashoffset: kl + 1 }, { strokeDashoffset: 0 }],
          { duration: kdur, delay: kt * 1000, easing: 'cubic-bezier(.45,.05,.3,1)', fill: 'forwards' })
        kt += kdur / 1000
      }
      var kEnd = kt + 0.06
      kG.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, delay: kStart * 1000, easing: 'ease', fill: 'forwards' })
      /* 引线完成使命后淡出，避免 K 标旁边留一根飘线 */
      link.animate([{ opacity: 1 }, { opacity: 0 }],
        { duration: 560, delay: Math.max(0, kEnd - 0.18) * 1000, easing: 'ease', fill: 'forwards' })

      /* 圆形图标描边 */
      var ringCircles = Array.prototype.slice.call(ringG.querySelectorAll('circle'))
      var rt = kEnd + 0.06
      ringG.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: rt * 1000, easing: 'ease', fill: 'forwards' })
      for (var ri = 0; ri < ringCircles.length; ri++) {
        var rc = ringCircles[ri]
        var rl = 0
        try { rl = rc.getTotalLength() } catch (e) { rl = 1200 }
        if (ri) {
          rc.style.strokeDasharray = '3 11'
          rc.style.opacity = '0'
          rc.animate([{ opacity: 0 }, { opacity: .85 }],
            { duration: 480, delay: rt * 1000, easing: 'ease', fill: 'forwards' })
        } else {
          rc.style.strokeDasharray = (rl + 1) + ' ' + (rl + 1)
          rc.style.strokeDashoffset = rl + 1
          rc.animate([{ strokeDashoffset: rl + 1 }, { strokeDashoffset: 0 }],
            { duration: 520, delay: rt * 1000, easing: 'cubic-bezier(.35,0,.2,1)', fill: 'forwards' })
        }
      }
      var tunnelStart = rt + 0.46

      /* 隧道：从圆形图标中心放大整幅线条，白色光晕收束进应用 */
      var tunnelMs = 1400
      world.animate(
        [{ transform: 'scale(1)' }, { transform: 'scale(1.35)', offset: .18 }, { transform: 'scale(16)' }],
        { duration: tunnelMs, delay: tunnelStart * 1000, easing: 'cubic-bezier(.55,.02,.35,1)', fill: 'forwards' })
      tunnelG.animate([{ opacity: 0 }, { opacity: .85 }, { opacity: 0 }],
        { duration: tunnelMs, delay: tunnelStart * 1000, easing: 'ease-in', fill: 'forwards' })
      ringG.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(1.9)' }],
        { duration: tunnelMs * .8, delay: (tunnelStart + .1) * 1000, easing: 'ease-in', fill: 'forwards' })
      flash.animate([{ opacity: 0 }, { opacity: 0 }, { opacity: 1 }],
        { duration: tunnelMs, delay: tunnelStart * 1000, easing: 'cubic-bezier(.6,0,.6,1)', fill: 'forwards' })

      /* 倍速：WAAPI 的 playbackRate 会同时缩放延迟和时长 */
      if (Math.abs(T - 1) > 0.001) {
        try {
          document.getAnimations().forEach(function (anim) { anim.playbackRate = 1 / T })
        } catch (e) { /* ignore */ }
      }

      /* 保护窗口：整段动画播完前不允许主进程提前收窗 */
      var totalMs = (tunnelStart + tunnelMs / 1000 + 0.18) * 1000 * T
      altMinPlay = Math.max(altMinPlay, Math.round(totalMs) + 300)

      requestAnimationFrame(function () { wrap.classList.add('ready') })
      /* 录制 MP4 时不让自动收窗打断逐帧渲染 */
      if (!window.__MHUB_SPLASH_RECORD) timer = setTimeout(function () { finish(680) }, totalMs + 260)
      })
    }

    /* ────────────────────────────────────────────────────────────────────────
       缎带书写开机动画（移植自 github.com/AnsonZhang0129/gpt-launcher）
       一条彩虹缎带：书写 Welcome <名字> → 流向右方 → 编织成 M HUB K 标
       → 呼吸两次 → 镜头从六角光圈穿入 → 淡出进入主界面。
       画布透明，背景叠当前驱动壁纸（模糊 + 暗角），与 ios 分支一致。
       ──────────────────────────────────────────────────────────────────────── */
    function launcherBranch() {
      var T = Math.max(0.5, Number(cfg.speed) || 1)
      wrap.classList.add('launcher')

      /* 样式：透明画布叠在模糊壁纸 + 暗角遮罩之上 */
      var css = document.createElement('style')
      css.textContent = [
        '.dsu-alt.launcher{background:#05060c}',
        '.dsu-launcher-bg{position:absolute;inset:-6%;z-index:0;overflow:hidden}',
        '.dsu-launcher-bg img,.dsu-launcher-bg video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;',
        'filter:blur(40px) saturate(128%) brightness(.46) contrast(1.06);opacity:0;transition:opacity 1.1s ease,filter 1.8s ease;will-change:opacity,filter}',
        '.launcher.ready .dsu-launcher-bg img,.launcher.ready .dsu-launcher-bg video{opacity:1;filter:blur(28px) saturate(136%) brightness(.52) contrast(1.06)}',
        '.dsu-launcher-bg-fallback{position:absolute;inset:0;background:radial-gradient(120% 110% at 50% 30%,#3a4376 0%,#1b2042 46%,#07080f 100%)}',
        '.dsu-launcher-veil{position:absolute;inset:0;z-index:2;pointer-events:none;',
        'background:radial-gradient(120% 100% at 50% 36%,rgba(4,6,14,.5) 0%,rgba(3,4,10,.74) 56%,rgba(1,2,5,.92) 100%)}',
        '.dsu-launcher-host{position:absolute;inset:0;z-index:3}',
        '.dsu-launcher-host canvas{display:block;width:100%;height:100%}',
        '.launcher .dsu-alt-brand{display:none}'
      ].join('')
      document.head.appendChild(css)

      /* 背景：当前驱动壁纸（模糊 + 暗角），与 ios 分支一致 */
      var bg = document.createElement('div')
      bg.className = 'dsu-launcher-bg'
      var wp = cfg.wpBg
      if (wp && wp.kind === 'video' && wp.url) {
        var bv = document.createElement('video')
        bv.src = wp.url; bv.muted = true; bv.loop = true; bv.autoplay = true; bv.playsInline = true
        if (wp.poster) bv.poster = wp.poster
        bg.appendChild(bv)
        try { bv.play().catch(function () {}) } catch (e) {}
      } else if (wp && wp.kind === 'image' && wp.url) {
        var bi = document.createElement('img')
        bi.src = wp.url; bi.alt = ''
        bg.appendChild(bi)
      } else {
        var bf = document.createElement('div')
        bf.className = 'dsu-launcher-bg-fallback'
        bg.appendChild(bf)
      }
      wrap.appendChild(bg)
      var veil = document.createElement('div'); veil.className = 'dsu-launcher-veil'; wrap.appendChild(veil)

      /* 动画宿主：缎带 bundle（Three.js）在此容器内创建 #stage + canvas */
      var host = document.createElement('div')
      host.className = 'dsu-launcher-host'
      wrap.appendChild(host)

      requestAnimationFrame(function () { wrap.classList.add('ready') })

      var finDone = false
      function finishLauncher(fadeMs) {
        if (finDone) return
        finDone = true
        finish(typeof fadeMs === 'number' ? fadeMs : 900)
      }

      var assetBase = window.__MHUB_SPLASH_ASSETS || './startup-assets/'
      var s = document.createElement('script')
      s.src = assetBase + 'modes/launcher/launcher.bundle.js'
      s.onload = function () {
        try {
          if (typeof window.__mhubLauncher !== 'function') { finishLauncher(420); return }
          /* 动画总时长 ~21s（书写 9s + 连接/编织 3.6s + 呼吸 6s + 进入 2.15s），
             速度滑块按 T 缩放；保护窗口至少覆盖到进入开始，避免主窗口提前切走。 */
          altMinPlay = Math.max(altMinPlay, Math.round(20500 / T) + 400)
          window.__mhubLauncher({
            container: host,
            name: cfg.welcomeName,
            speed: T,
            onFinish: function (fadeMs) { finishLauncher(fadeMs) }
          })
        } catch (e) {
          try { console.log('[mhub-wp] launcher error: ' + (e && e.message)) } catch (_) {}
          finishLauncher(420)
        }
      }
      s.onerror = function () { finishLauncher(420) }
      document.head.appendChild(s)

      /* 兜底：32s 仍未结束则强制收窗，避免 WebGL 异常时卡死 */
      timer = setTimeout(function () { finishLauncher(700) }, Math.round(32000 / T))
    }

    if (cfg.mode === 'gallery') {
      var frame = document.createElement('iframe')
      frame.className = 'dsu-alt-frame'
      /* 图片开场：同款 Codex 启动序列，画面自动替换成当前驱动壁纸 */
      var gsrc = base + 'modes/gallery/index.html?embedded=1'
      var gwp = cfg.wpBg
      var gimg = gwp ? (gwp.kind === 'image' ? gwp.url : (gwp.kind === 'video' ? (gwp.poster || '') : '')) : ''
      if (gimg) gsrc += '&wp=' + encodeURIComponent(gimg)
      gsrc += '&name=' + encodeURIComponent(String(cfg.welcomeName || 'GXY'))
      frame.src = gsrc
      stage.appendChild(frame)
      /* 动画主体 12 秒；壁纸要现场生成线稿，末尾多留一点余量 */
      timer = setTimeout(function () { finish(700) }, Math.round(15000 / speed))
      return
    }

    var video = document.createElement('video')
    video.className = 'dsu-alt-video'
    video.src = base + 'modes/' + cfg.mode + '/' + (cfg.mode === 'moon' ? 'intro.mp4' : 'startup.mp4')
    video.autoplay = true
    video.playsInline = true
    video.preload = 'auto'
    video.volume = cfg.sfx ? Math.min(1, Math.max(0, Number(cfg.sfxVolume) || 50) / 100) : 0
    stage.appendChild(video)
    /* 视频最后一帧已经是主界面：末尾多停一拍再慢淡出，避免"啪"一下跳进主窗口。 */
    video.addEventListener('ended', function () { setTimeout(function () { finish(1500) }, 260) })
    video.addEventListener('error', function () { finish(320) })
    /* 视频时长已知后延长保护窗口，让整段动画播完再交还主窗口 */
    video.addEventListener('loadedmetadata', function () {
      var d = Number(video.duration)
      if (isFinite(d) && d > 0) altMinPlay = Math.max(MIN_ALT_PLAY, Math.round(d * 1000 / speed) + 800)
    })
    timer = setTimeout(function () { finish(700) }, Math.round(30000 / speed))
    try {
      var played = video.play()
      if (played && typeof played.catch === 'function') {
        played.catch(function () {
          video.muted = true
          try { video.play() } catch (e) {}
        })
      }
    } catch (e) {}
  }

  var $ = function (id) { return document.getElementById(id) }
  var ui = {
    plate: $('plate'), watermark: $('watermark'), vignette: $('vignette'),
    black: $('black'), blackInner: $('blackInner'), blackEn: $('blackEn'),
    sweep: $('sweep'), wash: $('wash'), flash: $('flash'),
    bloom: $('bloom'), streak: $('streak'),
    brand: $('brand'), meta: $('meta'), meta2: $('meta2'), slats: $('slats'),
    center: $('center'), status: $('status'), statusZh: $('statusZh'),
    subEn: $('subEn'), rule: $('rule'), caret: $('caret'), logo: $('logo'),
    idline: $('idline'), reticle: $('reticle'), hex: $('hex'), voice: $('voice'),
    welcome: $('welcome'), w1: $('w1'), w2: $('w2'), w3: $('w3'), w4: $('w4'),
    action: $('action'), btn: $('btn'), btnZh: $('btnZh'), btnEn: $('btnEn'),
    hint: $('hint'), card: $('card'), skip: $('skip'),
    foot: $('foot'), subZh: $('subZh'), subEn2: $('subEn2'),
    progress: $('progress'), bar: $('progressBar'), stepcount: $('stepcount'),
    frame: $('frame'), scanline: $('scanline'), audioBank: $('audioBank')
  }
  var slats = Array.prototype.slice.call(root.querySelectorAll('.dsu-slat'))

  /* ── 窗口按钮：最小化 / 最大化 / 关闭 ─────────────────────────────────── */
  function splashWinCmd(action) {
    try { console.dir('[mhub-wp]' + JSON.stringify({ t: 'splashWin', payload: { action: action } })) } catch (e) {}
  }

  function mountWindowBar() {
    if (document.getElementById('mhub-win-ctl')) return
    var css = document.createElement('style')
    css.id = 'mhub-win-ctl-css'
    css.textContent =
      '#mhub-win-ctl{position:fixed;top:10px;right:12px;z-index:2147483600;display:flex;gap:6px;opacity:0;transition:opacity .4s ease .25s;-webkit-app-region:no-drag;}' +
      '#mhub-win-ctl.is-on{opacity:1;}' +
      '#mhub-win-ctl button{width:30px;height:26px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:1px solid rgba(150,180,230,.22);border-radius:7px;background:rgba(10,16,26,.4);color:rgba(228,238,252,.82);cursor:pointer;transition:background .16s ease,color .16s ease,border-color .16s ease;-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);}' +
      '#mhub-win-ctl button:hover{background:rgba(120,160,255,.24);border-color:rgba(140,180,255,.5);color:#fff;}' +
      '#mhub-win-ctl button[data-act="close"]:hover{background:rgba(222,60,60,.8);border-color:rgba(255,120,120,.65);}' +
      '#mhub-win-ctl svg{width:13px;height:13px;display:block;}'
    document.head.appendChild(css)

    var ICON = {
      min: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/></svg>',
      max: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="5.5" y="5.5" width="13" height="13" rx="2.5"/></svg>',
      restore: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="4.5" y="8.5" width="11" height="11" rx="2.5"/><path d="M8.5 8.5V6.5A2 2 0 0 1 10.5 4.5h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-2"/></svg>',
      close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6.5 6.5 11 11M17.5 6.5l-11 11"/></svg>'
    }

    var bar = document.createElement('div')
    bar.id = 'mhub-win-ctl'

    function mk(act, title, html) {
      var b = document.createElement('button')
      b.type = 'button'
      b.setAttribute('data-act', act)
      b.title = title
      b.setAttribute('aria-label', title)
      b.innerHTML = html
      bar.appendChild(b)
      return b
    }

    var minBtn = mk('minimize', '最小化', ICON.min)
    var maxBtn = mk('maximize', '最大化', ICON.max)
    var closeBtn = mk('close', '关闭', ICON.close)
    var maxed = false

    minBtn.addEventListener('click', function (e) {
      e.stopPropagation()
      splashWinCmd('minimize')
    })
    maxBtn.addEventListener('click', function (e) {
      e.stopPropagation()
      maxed = !maxed
      splashWinCmd(maxed ? 'maximize' : 'unmaximize')
      maxBtn.innerHTML = maxed ? ICON.restore : ICON.max
      maxBtn.title = maxed ? '还原' : '最大化'
      maxBtn.setAttribute('aria-label', maxBtn.title)
    })
    closeBtn.addEventListener('click', function (e) {
      e.stopPropagation()
      try { requestSkip() } catch (err) {}
    })

    document.body.appendChild(bar)
    setTimeout(function () { bar.classList.add('is-on') }, 60)
  }

  mountWindowBar()

  var startedAt = performance.now()
  var timers = []
  var waiters = []
  var skipped = false
  var finished = false
  var hexTimer = null
  var clockTimer = null
  var welcomeDone = false
  var welcomeEndedAt = 0
  var welcomeCbs = []
  var leavePromise = null
  var dismissPromise = null
  var dismissResolve = null
  var dismissFade = 560

  /* ── 主题 / 配色 / 液态玻璃 ───────────────────────────────────────────── */
  var GLASS_CSS = [
    '#startup-root.dsu-glass{background:transparent !important;}',
    '#startup-root.dsu-glass .dsu-backdrop{position:absolute;inset:0;z-index:0;pointer-events:none;background:transparent;-webkit-backdrop-filter:blur(var(--dsu-backdrop-blur,0px)) saturate(var(--dsu-glass-sat,160%));backdrop-filter:blur(var(--dsu-backdrop-blur,0px)) saturate(var(--dsu-glass-sat,160%));}',
    '#startup-root.dsu-glass .dsu-plate{background:radial-gradient(120% 90% at 78% 12%,rgba(255,255,255,calc(.72 * var(--dsu-glass-alpha,.7))) 0%,rgba(255,255,255,0) 58%),linear-gradient(168deg,rgba(240,246,253,calc(var(--dsu-glass-alpha,.7) + .1)) 0%,rgba(233,240,249,calc(var(--dsu-glass-alpha,.7) + .02)) 42%,rgba(227,235,246,var(--dsu-glass-alpha,.7)) 100%);-webkit-backdrop-filter:blur(var(--dsu-glass-blur,22px)) saturate(var(--dsu-glass-sat,160%));backdrop-filter:blur(var(--dsu-glass-blur,22px)) saturate(var(--dsu-glass-sat,160%));}',
    'html.theme-dark #startup-root.dsu-glass .dsu-plate{background:radial-gradient(120% 90% at 78% 12%,rgba(255,255,255,calc(.1 * var(--dsu-glass-alpha,.7))) 0%,rgba(255,255,255,0) 55%),linear-gradient(168deg,rgba(18,24,34,calc(var(--dsu-glass-alpha,.7) + .05)) 0%,rgba(11,16,24,var(--dsu-glass-alpha,.7)) 42%,rgba(7,11,18,var(--dsu-glass-alpha,.7)) 100%);}',
    '#startup-root.dsu-glass .dsu-black{background:rgba(4,6,10,calc(var(--dsu-glass-alpha,.7) * .96)) !important;-webkit-backdrop-filter:blur(var(--dsu-glass-blur,22px)) saturate(var(--dsu-glass-sat,160%));backdrop-filter:blur(var(--dsu-glass-blur,22px)) saturate(var(--dsu-glass-sat,160%));}',
    '#startup-root.dsu-glass::after{content:"";position:fixed;inset:-12%;z-index:60;pointer-events:none;background:linear-gradient(112deg,rgba(255,255,255,.16) 0%,rgba(255,255,255,0) 34%,rgba(255,255,255,0) 66%,rgba(255,255,255,.09) 100%);mix-blend-mode:screen;opacity:calc(.25 + .55 * var(--dsu-glass-alpha,.7));animation:dsuGlassDrift 12s ease-in-out infinite alternate;}',
    '@keyframes dsuGlassDrift{from{transform:translate3d(-2.4%,-1.2%,0) scale(1.04);}to{transform:translate3d(2.4%,1.2%,0) scale(1.08);}}',
    '@media (prefers-reduced-motion:reduce){#startup-root.dsu-glass::after{animation:none;}}'
  ].join('\n')

  var glassStyleEl = null
  var glassBackdropEl = null

  function ensureGlassStyle() {
    if (glassStyleEl && glassStyleEl.parentNode) return
    glassStyleEl = document.createElement('style')
    glassStyleEl.id = 'mhub-splash-glass'
    glassStyleEl.textContent = GLASS_CSS
    document.head.appendChild(glassStyleEl)
  }

  function applyTheme() {
    if (C.theme === 'dark' || C.theme === 'light') {
      var de = document.documentElement
      de.classList.remove('theme-light', 'theme-dark')
      de.classList.add('theme-' + C.theme)
    }
    var dark = document.documentElement.classList.contains('theme-dark')
    root.classList.toggle('dsu-dark', dark)
    if (C.accent) root.style.setProperty('--dsu-accent', C.accent)
    if (C.glitchA) root.style.setProperty('--dsu-glitch-a', C.glitchA)
    if (C.glitchB) root.style.setProperty('--dsu-glitch-b', C.glitchB)
    root.style.setProperty('--dsu-speed', String(C.speed))
  }

  function applyGlass() {
    if (!C.glass) {
      root.classList.remove('dsu-glass')
      if (glassBackdropEl && glassBackdropEl.parentNode) glassBackdropEl.parentNode.removeChild(glassBackdropEl)
      glassBackdropEl = null
      return
    }
    ensureGlassStyle()
    root.classList.add('dsu-glass')
    root.style.setProperty('--dsu-glass-alpha', String(C.glassOpacity))
    root.style.setProperty('--dsu-glass-blur', C.glassBlur + 'px')
    root.style.setProperty('--dsu-glass-sat', C.glassSaturate + '%')
    root.style.setProperty('--dsu-backdrop-blur', C.glassBackdropBlur + 'px')
    if (!glassBackdropEl || !glassBackdropEl.parentNode) {
      glassBackdropEl = document.createElement('div')
      glassBackdropEl.className = 'dsu-backdrop'
      var plate = ui.plate
      if (plate && plate.parentNode === root) root.insertBefore(glassBackdropEl, plate)
      else root.insertBefore(glassBackdropEl, root.firstChild)
    }
  }

  applyTheme()
  applyGlass()

  /* 主进程可在任意时刻下发新配置（设置页实时预览） */
  window.__MHUBApplySplashConfig = function (next) {
    C = readConfig(next || window.__MHUBSplashConfig)
    if (!C.enabled) {
      try { requestSkip() } catch (e) { /* noop */ }
      return C
    }
    applyTheme()
    applyGlass()
    return C
  }

  /* ── 通用工具 ─────────────────────────────────────────────────────────── */
  function ms(base) { return Math.round(base / C.speed) }

  function wait(base) {
    return new Promise(function (resolve) {
      if (skipped) { resolve(); return }
      var done = false
      function fin() {
        if (done) return
        done = true
        var i = waiters.indexOf(fin)
        if (i >= 0) waiters.splice(i, 1)
        resolve()
      }
      var t = setTimeout(fin, Math.max(0, ms(base)))
      timers.push(t)
      waiters.push(fin)
    })
  }

  function releaseAll() {
    for (var i = 0; i < timers.length; i++) clearTimeout(timers[i])
    timers.length = 0
    var list = waiters.slice()
    waiters.length = 0
    for (var j = 0; j < list.length; j++) { try { list[j]() } catch (e) { /* noop */ } }
    /* 跳过阶段时也可能挂着 hexTimer / clockTimer：一并清掉 */
    stopHex()
    if (hexTimer) { clearInterval(hexTimer); hexTimer = null }
    if (clockTimer) { clearInterval(clockTimer); clockTimer = null }
    /* 释放 WebAudio 上下文：AudioContext.close() 会停止所有节点并释放底层资源 */
    if (actx && typeof actx.close === 'function') {
      try { var _ = actx.close(); } catch (e) { /* ignore */ }
      actx = null
    }
  }

  function setIn(node, on) {
    if (!node) return
    node.classList.toggle('dsu-in', !!on)
  }

  function setProgress(p) {
    var pct = Math.max(0, Math.min(1, p))
    ui.bar.style.width = Math.round(pct * 100) + '%'
  }

  function setSlats(active) {
    for (var i = 0; i < slats.length; i++) {
      var idx = i + 1
      slats[i].classList.toggle('dsu-on', idx === active)
      slats[i].classList.toggle('dsu-past', idx < active)
    }
  }

  function sweepLine() {
    if (!ui.scanline) return
    ui.scanline.classList.remove('dsu-go')
    void ui.scanline.offsetWidth
    ui.scanline.classList.add('dsu-go')
  }

  function paintClock() {
    if (!ui.meta2) return
    var d = new Date()
    var pad = function (n) { return (n < 10 ? '0' : '') + n }
    ui.meta2.textContent = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
  }

  function setSubtitle(zh, en) {
    ui.subZh.classList.remove('dsu-in')
    ui.subEn2.classList.remove('dsu-in')
    setTimeout(function () {
      ui.subZh.textContent = zh || ''
      ui.subEn2.textContent = en || ''
      ui.subZh.classList.add('dsu-in')
      if (en) ui.subEn2.classList.add('dsu-in')
    }, 140)
  }

  function setStepCount(i, code) {
    ui.stepcount.textContent = '[ ' + String(i).padStart(2, '0') + ' / 06 ] ' + code
  }

  function typeIn(host, text, stagger) {
    host.textContent = ''
    var frag = document.createDocumentFragment()
    var n = 0
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i)
      if (ch === ' ') {
        frag.appendChild(document.createTextNode('\u00a0'))
        continue
      }
      var s = document.createElement('span')
      s.className = 'dsu-ch'
      s.textContent = ch
      s.style.transitionDelay = Math.round(n * stagger) + 'ms'
      frag.appendChild(s)
      n++
    }
    host.appendChild(frag)
  }

  /* ── 音频载体：按需加载被启用阶段需要的素材，减少首屏内存占用 ──────── */
  var S = C.stages
  var FILES = {}
  if (C.sfx) {
    if (S.steps) { FILES['sfx-tick'] = 'sfx-tick.mp3'; FILES['sfx-ticks-run'] = 'sfx-ticks-run.mp3' }
  }
  if (C.voice) {
    if (S.steps) {
      FILES['line-1'] = 'line-1.mp3'; FILES['line-2'] = 'line-2.mp3';
      FILES['line-3'] = 'line-3.mp3'; FILES['line-4'] = 'line-4.mp3';
      FILES['line-5'] = 'line-5.mp3'
    }
    if (S.welcome) FILES['line-6'] = 'line-6.mp3'
  }
  var bank = {}
  Object.keys(FILES).forEach(function (key) {
    try {
      var a = document.createElement('audio')
      /* 被跳过的段落对应的音频不 preload，等用到时浏览器自己按需加载，节省首屏内存 */
      a.preload = 'metadata'
      a.src = (window.__MHUB_SPLASH_ASSETS || './startup-assets/') + FILES[key]
      a.setAttribute('data-audio', key)
      ui.audioBank.appendChild(a)
      bank[key] = a
    } catch (e) { /* 单个素材失败不影响流程 */ }
  })

  function playSfx(key, vol) {
    if (!C.sfx) return false
    var a = bank[key]
    if (!a) return false
    try {
      a.pause()
      a.currentTime = 0
      var gain = (vol == null ? 0.5 : vol) * (C.sfxVolume / 50)
      a.volume = Math.max(0.01, Math.min(1, gain))
      var p = a.play()
      if (p && p.catch) p.catch(function () {})
      return true
    } catch (e) { return false }
  }

  /* 参考片里的低频起势 / 扫频 / 和声钟没有对应素材，沿用 WebAudio 现场合成。
     失败一律静默降级，绝不影响动画。 */
  var actx = null
  function ac() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext
      if (!AC) return null
      if (!actx) actx = new AC()
      if (actx.state === 'suspended' && typeof actx.resume === 'function') actx.resume()
      return actx
    } catch (e) { return null }
  }
  function tone(freq, dur, type, gain, delay, glideTo) {
    var c = ac(); if (!c) return
    try {
      var t0 = c.currentTime + (delay || 0)
      var o = c.createOscillator(), g = c.createGain()
      o.type = type || 'sine'
      o.frequency.setValueAtTime(freq, t0)
      if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t0 + dur)
      g.gain.setValueAtTime(0.0001, t0)
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain == null ? 0.03 : gain), t0 + Math.min(0.02, dur * 0.3))
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
      o.connect(g); g.connect(c.destination)
      o.start(t0); o.stop(t0 + dur + 0.03)
    } catch (e) { /* noop */ }
  }
  function noise(dur, gain) {
    var c = ac(); if (!c) return
    try {
      var n = Math.floor(c.sampleRate * dur)
      var buf = c.createBuffer(1, n, c.sampleRate)
      var d = buf.getChannelData(0)
      for (var i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n)
      var src = c.createBufferSource(); src.buffer = buf
      var f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1500; f.Q.value = 0.6
      var g = c.createGain(); g.gain.value = Math.max(0.0002, gain == null ? 0.03 : gain)
      src.connect(f); f.connect(g); g.connect(c.destination)
      src.start()
    } catch (e) { /* noop */ }
  }

  var Sfx = {
    rise: function () { tone(220, 1.1, 'sine', 0.032, 0, 990) },
    sweep: function () { noise(0.75, 0.035) },
    step: function () { if (!playSfx('sfx-tick', 0.6)) { tone(880, 0.05, 'sine', 0.05); tone(1320, 0.07, 'sine', 0.028, 0.045) } },
    confirm: function () {
      if (!playSfx('sfx-tick', 0.85)) { tone(660, 0.09, 'triangle', 0.07); tone(990, 0.17, 'triangle', 0.055, 0.085) }
      setTimeout(function () { playSfx('sfx-tick', 0.5) }, 95)
    },
    tickRun: function () { playSfx('sfx-ticks-run', 0.5) },
    chime: function () {
      tone(659.25, 0.9, 'sine', 0.055)
      tone(830.61, 0.9, 'sine', 0.04, 0.09)
      tone(987.77, 1.3, 'sine', 0.045, 0.18)
    }
  }

  /* ── 语音：优先真声素材，播放失败回落到 speechSynthesis（中文台词）─── */
  var Voice = (function () {
    var currentStop = null
    var canceled = false

    function setMeter(on) {
      if (ui.voice) ui.voice.classList.toggle('dsu-on', !!on)
    }

    function estimateTTS(text) {
      var chars = String(text || '').replace(/\s/g, '').length
      return Math.max(900, Math.round(chars * 150) + 600)
    }

    function tts(text) {
      return new Promise(function (resolve) {
        var t0 = performance.now()
        if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) {
          setTimeout(function () { resolve(performance.now() - t0) }, 260)
          return
        }
        try {
          var synth = window.speechSynthesis
          synth.cancel()
          var u = new window.SpeechSynthesisUtterance(String(text || ''))
          u.lang = 'zh-CN'
          u.rate = C.voiceRate
          u.pitch = C.voicePitch
          u.volume = Math.max(0, Math.min(1, C.voiceVolume / 100))
          var list = synth.getVoices ? (synth.getVoices() || []) : []
          for (var i = 0; i < list.length; i++) {
            if (/^zh/i.test(list[i].lang || '')) { u.voice = list[i]; break }
          }
          var done = false
          var to = 0
          function fin() {
            if (done) return
            done = true
            clearTimeout(to)
            setMeter(false)
            resolve(performance.now() - t0)
          }
          u.onend = fin
          u.onerror = fin
          to = setTimeout(fin, estimateTTS(text) + 1400)
          setMeter(true)
          synth.speak(u)
        } catch (e) {
          setMeter(false)
          resolve(performance.now() - t0)
        }
      })
    }

    /** 念第 index+1 句；返回实际耗时(ms)。素材不可用时用中文 TTS 兜底。 */
    function line(index, zhText) {
      if (!C.voice) return Promise.resolve(0)
      if (C.voiceSource === 'tts') return tts(zhText)
      var key = 'line-' + (index + 1)
      var a = bank[key]
      var t0 = performance.now()
      return new Promise(function (resolve) {
        if (!a) { tts(zhText).then(resolve); return }
        var done = false
        var fellBack = false
        var to = 0
        function cleanup() {
          clearTimeout(to)
          a.removeEventListener('ended', onEnd)
          a.removeEventListener('error', onErr)
          if (currentStop === fin) currentStop = null
        }
        function fin() {
          if (done) return
          done = true
          cleanup()
          setMeter(false)
          resolve(performance.now() - t0)
        }
        function fallback() {
          if (done || fellBack) return
          fellBack = true
          clearTimeout(to)
          try { a.pause() } catch (e) {}
          setMeter(false)
          tts(zhText).then(fin)
        }
        function onEnd() { fin() }
        function onErr() { fallback() }

        a.addEventListener('ended', onEnd)
        a.addEventListener('error', onErr)
        currentStop = fin
        setMeter(true)
        var dur = (isFinite(a.duration) && a.duration > 0) ? a.duration * 1000 : 4000
        to = setTimeout(fin, dur + 2500)
        try { a.pause() } catch (e) {}
        try { if (a.readyState > 0) a.currentTime = 0 } catch (e) {}
        try { a.volume = Math.max(0, Math.min(1, C.voiceVolume / 100)) } catch (e) {}
        var p
        try {
          p = a.play()
          if (p && p.catch) p.catch(function () { fallback() })
        } catch (e) {
          fallback()
        }
      })
    }

    function stop() {
      canceled = true
      if (currentStop) { try { currentStop() } catch (e) {} currentStop = null }
      Object.keys(bank).forEach(function (k) {
        if (k.indexOf('line-') !== 0) return
        try { bank[k].pause() } catch (e) {}
      })
      try { if (window.speechSynthesis) window.speechSynthesis.cancel() } catch (e) {}
      setMeter(false)
    }

    return { line: line, stop: stop, tts: tts, setMeter: setMeter }
  })()

  ;(function wireUnlock() {
    var unlocked = false
    function unlock() {
      if (unlocked) return
      unlocked = true
      try { if (window.speechSynthesis) window.speechSynthesis.resume() } catch (e) {}
      ac()
      document.removeEventListener('pointerdown', unlock, true)
      document.removeEventListener('keydown', unlock, true)
      document.removeEventListener('touchstart', unlock, true)
    }
    document.addEventListener('pointerdown', unlock, true)
    document.addEventListener('keydown', unlock, true)
    document.addEventListener('touchstart', unlock, true)
  })()

  /* ── 六步脚本 ─────────────────────────────────────────────────────────── */
  var STEPS = [
    {
      zh: '需要访问许可', en: 'ACCESS PERMISSION REQUIRED',
      sub: '等待用户授权', subEn: 'AWAITING OPERATOR CONSENT',
      badge: 'AUTHORIZATION', action: 'grant',
      btnZh: '授予访问权限', btnEn: 'GRANT ACCESS',
      hold: 900, progress: 0.34
    },
    {
      zh: '身份资料确认', en: 'IDENTITY VERIFICATION',
      sub: '确认操作用户与设备归属', subEn: 'VERIFYING OPERATOR & DEVICE',
      badge: 'IDENTITY', action: 'confirm',
      btnZh: '确认身份', btnEn: 'CONFIRM IDENTITY',
      hold: 700, progress: 0.5
    },
    {
      zh: '接收访问需求', en: 'RECEIVING ACCESS REQUEST',
      sub: '接收来自设备的访问需求', subEn: 'INBOUND DEVICE REQUEST',
      badge: 'REQUEST', action: 'auto',
      hold: 1200, progress: 0.66, assembleLogo: true
    },
    {
      zh: '开始读取权限', en: 'READING PERMISSIONS',
      sub: '正在读取设备配置与偏好', subEn: 'READING DEVICE PROFILE',
      badge: 'READ', action: 'auto',
      hold: 1200, progress: 0.8, hex: true
    },
    {
      zh: '读取完毕 · 核验通过', en: 'PROFILE VERIFIED',
      sub: '访问已授权，正在载入控制台', subEn: 'ACCESS GRANTED · LOADING CONSOLE',
      badge: 'VERIFY', action: 'auto',
      hold: 1600, progress: 0.93, reticle: true
    }
  ]

  function hexLine() {
    var s = ''
    for (var i = 0; i < 26; i++) {
      s += '0123456789ABCDEF'.charAt(Math.floor(Math.random() * 16))
      if (i % 2 === 1) s += ' '
    }
    return s
  }
  function startHex() {
    var paint = function () {
      var out = []
      for (var i = 0; i < 12; i++) out.push(hexLine())
      ui.hex.innerHTML = out.join('<br>')
    }
    paint()
    ui.hex.classList.add('dsu-in')
    Sfx.tickRun()
    if (hexTimer) clearInterval(hexTimer)
    hexTimer = setInterval(paint, 110)
  }
  function stopHex() {
    if (hexTimer) { clearInterval(hexTimer); hexTimer = null }
    ui.hex.classList.remove('dsu-in')
  }

  function waitAction() {
    return new Promise(function (resolve) {
      if (skipped) { resolve(); return }
      var done = false
      var autoT = setTimeout(fin, 5000)
      function fin() {
        if (done) return
        done = true
        try { clearTimeout(autoT) } catch (e) {}
        ui.btn.removeEventListener('click', onClick)
        ui.action.removeEventListener('click', onClick)
        document.removeEventListener('keydown', onKey)
        var i = waiters.indexOf(fin)
        if (i >= 0) waiters.splice(i, 1)
        resolve()
      }
      function onKey(e) {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); fin() }
      }
      function onClick(e) { e.preventDefault(); fin() }
      ui.btn.addEventListener('click', onClick)
      ui.action.addEventListener('click', onClick)
      document.addEventListener('keydown', onKey)
      waiters.push(fin)
    })
  }

  function showAction(step) {
    ui.btnZh.textContent = step.btnZh
    ui.btnEn.textContent = step.btnEn
    ui.card.hidden = step.action !== 'confirm'
    if (step.action === 'confirm') {
      ui.card.innerHTML = ''
      var rows = [
        ['操作用户', String(C.identityName || 'MCHOSE USER'), true],
        ['设备编号', String(C.identityId || 'MCHOSE-01'), false],
        ['权限等级', 'LEVEL ' + String(C.accessLevel || '03'), false]
      ]
      rows.forEach(function (r) {
        var row = document.createElement('div')
        row.className = 'dsu-card-row'
        var span = document.createElement('span')
        span.textContent = r[0]
        var b = document.createElement('b')
        b.textContent = r[1]
        if (r[2]) b.className = 'dsu-zhname'
        row.appendChild(span)
        row.appendChild(b)
        ui.card.appendChild(row)
      })
    }
    ui.hint.innerHTML = '按 <kbd>Enter</kbd> / <kbd>Space</kbd>，或点击按钮继续'
    ui.action.classList.add('dsu-in')
    ui.btn.classList.add('dsu-pulse')
  }

  function hideAction() {
    ui.action.classList.remove('dsu-in')
    ui.btn.classList.remove('dsu-pulse')
  }

  function assembleLogo() {
    ui.logo.classList.add('dsu-in')
    var paths = ui.logo.querySelectorAll('path')
    for (var i = 0; i < paths.length; i++) {
      var path = paths[i]
      if (!path.getTotalLength) continue
      try {
        var len = path.getTotalLength()
        path.style.fill = 'none'
        path.style.stroke = 'currentColor'
        path.style.strokeWidth = '1.1'
        path.style.strokeDasharray = len
        path.style.strokeDashoffset = len
        path.animate(
          [{ strokeDashoffset: len }, { strokeDashoffset: 0 }],
          { duration: 1400, easing: 'cubic-bezier(.55,.06,.24,1)', fill: 'forwards' }
        )
        setTimeout(function (p) {
          return function () {
            p.style.transition = 'fill 420ms ease, stroke-width 420ms ease'
            p.style.fill = ''
            p.style.strokeWidth = '0'
          }
        }(path), 1450)
      } catch (err) { /* Web Animations 不可用时直接落墨 */ }
    }
    return wait(300)
  }

  /* ── 主线时间线：按 stages 配置跳过段落 ──────────────────────────────── */
  function run() {
    paintClock()
    clockTimer = setInterval(paintClock, 1000)
    setProgress(0.05)

    /* SKIP 在序幕结尾就可用：黑底上一行小字，不抢第一幕的注意力 */
    setTimeout(showSkip, 1200)

    /* intro 段：纯黑 → K 标 → 洗白 → 品牌底板淡入
       每段动态读 C.stages，allow __MHUBApplySplashConfig 中途切换 */
    var chain
    if (C.stages.intro) {
      chain = Promise.resolve()
        .then(function () { return wait(820) })
        .then(function () {
          ui.blackInner.classList.add('dsu-in')
          Sfx.rise()
          return wait(240)
        })
        .then(function () {
          ui.blackEn.classList.add('dsu-tighten')
          return wait(880)
        })
        .then(function () {
          ui.sweep.classList.add('dsu-go')
          return wait(760)
        })
        /* 过曝洗白 */
        .then(function () {
          ui.blackInner.classList.add('dsu-out')
          Sfx.sweep()
          ui.wash.style.transition = 'opacity 220ms linear'
          ui.wash.style.opacity = '1'
          return wait(260)
        })
        .then(function () {
          ui.plate.style.transition = 'opacity 900ms ease'
          ui.plate.style.opacity = '1'
          ui.watermark.style.transition = 'opacity 1100ms ease'
          ui.watermark.style.opacity = '1'
          ui.wash.style.transition = 'opacity 720ms cubic-bezier(.2,.9,.2,1)'
          ui.wash.style.opacity = '0'
          ui.black.style.transition = 'opacity 720ms ease'
          ui.black.style.opacity = '0'
          return wait(760)
        })
    } else {
      /* 跳过 intro：直接亮底，不挂黑色遮罩 */
      ui.black.style.display = 'none'
      ui.plate.style.opacity = '1'
      ui.watermark.style.opacity = '1'
      ui.wash.style.opacity = '0'
      chain = wait(120)
    }

    /* setup 段：品牌块 / 页脚 / 进度 / 机框 */
    if (C.stages.setup) {
      chain = chain.then(function () {
        ui.brand.classList.add('dsu-in')
        ui.foot.classList.add('dsu-in')
        ui.stepcount.classList.add('dsu-in')
        ui.idline.classList.add('dsu-in')
        ui.frame.classList.add('dsu-in')
        ui.slats.classList.add('dsu-in')
        ui.meta.classList.add('dsu-in')
        ui.vignette.classList.add('dsu-in')
        ui.voice.classList.add('dsu-in')
        setProgress(0.12)
        setStepCount(0, 'BOOT')
        setSlats(0)
        setSubtitle('系统自检中…', 'SYSTEM SELF-CHECK')
        return wait(700)
      }).then(function () {
        ui.black.style.display = 'none'
        sweepLine()
      })
    } else {
      /* 跳过 setup：让 plate/watermark 直接在终幕时才挂到 welcome 里 */
      chain = chain.then(function () { ui.black.style.display = 'none' })
    }

    /* steps 段：5 步授权。全部跳过的话直接进 welcome */
    if (C.stages.steps) {
      chain = chain.then(stepLoop)
    } else {
      chain = chain.then(function () { return wait(200) })
    }

    /* welcome 终幕 */
    if (C.stages.welcome) {
      chain = chain.then(finale)
    } else {
      chain = chain.then(function () {
        /* 不播 welcome：直接标记完成收窗 */
        return wait(200).then(function () {
          markWelcomeDone()
          finished = true
          if (clockTimer) { clearInterval(clockTimer); clockTimer = null }
        })
      })
    }

    return chain.catch(function (err) {
      try { console.warn('[M HUB startup] timeline error:', err) } catch (e) {}
      markWelcomeDone()
      finished = true
      if (clockTimer) { clearInterval(clockTimer); clockTimer = null }
    })
  }

  function stepLoop() {
    var chain = Promise.resolve()
    STEPS.forEach(function (step, i) {
      chain = chain.then(function () {
        if (finished || skipped) return
        var n = i + 1
        /* 身份读数只属于身份核验阶段 */
        if (i >= 2) ui.idline.classList.remove('dsu-in')
        setStepCount(n, step.badge)
        setSlats(n)
        setProgress(step.progress)
        setSubtitle(step.sub, step.subEn)
        Sfx.step()

        /* 语音与文字同时起头；语音不阻塞文字渐显 */
        var spoke = Voice.line(i, step.zh)

        ui.status.classList.add('dsu-zhline')
        ui.status.classList.remove('dsu-in')
        ui.subEn.classList.remove('dsu-in')
        void ui.status.offsetWidth
        typeIn(ui.statusZh, step.zh, 46)
        typeIn(ui.subEn, step.en, 13)
        ui.caret.classList.toggle('dsu-on', step.action === 'grant' || step.action === 'confirm')
        requestAnimationFrame(function () {
          if (finished) return
          ui.status.classList.add('dsu-in')
          ui.subEn.classList.add('dsu-in')
        })
        ui.rule.classList.add('dsu-in')

        if (step.assembleLogo) assembleLogo()
        if (step.reticle) {
          ui.logo.classList.remove('dsu-in')
          ui.reticle.classList.add('dsu-in')
          sweepLine()
        }
        if (step.hex) startHex()

        function holdFor(spokenMs) {
          var target = Math.max(step.hold, (spokenMs || 0) + 240)
          return wait(Math.max(0, target - (spokenMs || 0)))
        }

        if ((step.action === 'grant' || step.action === 'confirm') && C.requireInteraction) {
          showAction(step)
          return wait(520).then(function () { return waitAction() }).then(function () {
            hideAction()
            Sfx.confirm()
            ui.caret.classList.remove('dsu-on')
            return spoke
          }).then(function () { return wait(320) })
        }
        if (step.hex) {
          return spoke.then(holdFor).then(function () { stopHex() })
        }
        return spoke.then(holdFor)
      })
    })
    return chain
  }

  function markWelcomeDone() {
    if (welcomeDone) return
    welcomeDone = true
    welcomeEndedAt = performance.now()
    /* 终幕已过：释放所有定时器和 WebAudio 上下文，让渲染进程尽快降内存 */
    releaseAll()
    Voice.stop()
    var list = welcomeCbs.slice()
    welcomeCbs.length = 0
    for (var i = 0; i < list.length; i++) {
      try { list[i](welcomeEndedAt) } catch (e) { /* noop */ }
    }
  }

  function whenWelcomeDone(cb) {
    if (welcomeDone) cb(welcomeEndedAt)
    else welcomeCbs.push(cb)
  }

  function finale() {
    if (finished || skipped) return Promise.resolve()
    setStepCount(6, 'WELCOME')
    setSlats(6)
    setProgress(1)
    /* 终幕欢迎语与这个底部读数区分开，避免同一句出现两遍 */
    setSubtitle('M HUB 设备控制已就绪', 'WELCOME')
    Sfx.chime()

    var welcomeLine = null
    ui.status.classList.remove('dsu-in')
    ui.subEn.classList.remove('dsu-in')
    ui.rule.classList.remove('dsu-in')
    ui.reticle.classList.remove('dsu-in')
    ui.center.classList.add('dsu-off')
    stopHex()

    return wait(360)
      .then(function () {
        ui.welcome.classList.add('dsu-in')
        ui.idline.classList.remove('dsu-in')
        /* 文案亮起的同一刻开口 */
        welcomeLine = Voice.line(5, '欢迎访问')
        return wait(420)
      })
      .then(function () {
        /* 色散故障：分片位移 + 0.5px 模糊 + 混合模式 */
        var targets = [ui.w1, ui.w2, ui.w4]
        targets.forEach(function (t) {
          t.classList.add('dsu-glitch')
          t.setAttribute('data-text', t.textContent)
        })
        ui.w2.classList.add('dsu-glitch-box')
        void ui.welcome.offsetWidth
        targets.forEach(function (t) { t.classList.add('dsu-on') })
        return wait(640)
      })
      /* 光晕炸开 + 光条横扫 */
      .then(function () {
        root.classList.add('dsu-peak')
        ui.bloom.classList.add('dsu-go')
        ui.streak.classList.add('dsu-go')
        return wait(430)
      })
      /* 光晕最亮那一下补一记极短高光 */
      .then(function () {
        ui.flash.style.transition = 'opacity 70ms linear'
        ui.flash.style.opacity = '0.72'
        return wait(90)
      })
      .then(function () {
        ui.flash.style.transition = 'opacity 340ms cubic-bezier(0.4, 0, 0.2, 1)'
        ui.flash.style.opacity = '0'
        return wait(320)
      })
      /* 参考片的青色 halation 只服务于揭幕那一瞬；这里终幕会停留到主进程收窗，
         所以高光过去后把颜色收回正常墨色，避免"欢迎"长时间发蓝。 */
      .then(function () {
        root.classList.remove('dsu-peak')
        return welcomeLine
      })
      .then(function () {
        markWelcomeDone()
        finished = true
        if (clockTimer) { clearInterval(clockTimer); clockTimer = null }
      })
  }

  /* ── dismissStartup / SKIP ────────────────────────────────────────────── */
  function beginLeave(fadeMs) {
    if (leavePromise) return leavePromise
    try { location.hash = 'done' } catch (e) {}
    /* 主进程用窗口标题判断启动页是否播完：location.hash 不一定出现在 getURL() 里。 */
    try { document.title = 'M HUB #done' } catch (e) {}
    var fade = Math.max(560, Number(fadeMs) > 0 ? Number(fadeMs) : 0)
    leavePromise = new Promise(function (resolve) {
      root.style.transitionDuration = fade + 'ms'
      root.classList.add('dsu-leaving')
      setTimeout(function () {
        resolve()
        setTimeout(function () {
          try { window.close() } catch (e) {}
        }, 80)
      }, fade + 30)
    })
    return leavePromise
  }

  function requestSkip() {
    if (skipped) return
    skipped = true
    releaseAll()
    Voice.stop()
    ui.action.classList.remove('dsu-in')
    beginLeave(dismissFade)
    if (dismissResolve) {
      beginLeave(dismissFade).then(function () { if (dismissResolve) dismissResolve() })
    }
  }

  window.__mhubForceDone = requestSkip
  function showSkip() {
    if (!ui.skip || skipped || !C.allowSkip) return
    ui.skip.hidden = false
    ui.skip.classList.add('dsu-in')
  }

  function dismissStartup(fadeMs) {
    var fade = Math.max(560, Number(fadeMs) > 0 ? Number(fadeMs) : 0)
    dismissFade = fade
    if (dismissPromise) return dismissPromise
    dismissPromise = new Promise(function (resolve) {
      var settled = false
      function done() {
        if (settled) return
        settled = true
        resolve()
      }
      dismissResolve = done

      function leaveNow() {
        beginLeave(fade).then(done)
      }

      if (skipped) { leaveNow(); return }

      whenWelcomeDone(function (endedAt) {
        var remain = Math.max(0, 500 - (performance.now() - endedAt))
        setTimeout(leaveNow, remain)
      })

      /* 硬看门狗：无论动画卡在哪一步，保证一定收口 */
      setTimeout(function () {
        if (skipped) { leaveNow(); return }
        leaveNow()
        if (dismissResolve) dismissResolve()
      }, Math.round(20000 / C.speed))
    })
    return dismissPromise
  }

  if (ui.skip) {
    ui.skip.addEventListener('click', function (e) {
      e.stopPropagation()
      if (C.allowSkip) requestSkip()
    })
  }
  document.addEventListener('keydown', function (e) {
    if (!C.allowSkip) return
    if (e.key === 'Escape' || e.key === 'Esc') requestSkip()
  })

  /* 过渡：主进程可能提前调用过占位版 dismissStartup */
  window.dismissStartup = dismissStartup
  ;(function drainQueue() {
    var q = window.__startupDismissQueue || []
    window.__startupDismissQueue = []
    q.forEach(function (item) {
      dismissStartup(item.fadeMs).then(item.resolve)
    })
  })()

  /* 便于自动化验收读取状态（不参与动画逻辑） */
  window.__MHUBSplash = {
    startedAt: startedAt,
    get config() { return C },
    get skipped() { return skipped },
    get finished() { return finished },
    get welcomeDone() { return welcomeDone },
    get welcomeEndedAt() { return welcomeEndedAt },
    get leaving() { return !!leavePromise },
    get audio() {
      return Object.keys(bank).map(function (k) {
        return { name: k, src: bank[k].currentSrc || bank[k].src, readyState: bank[k].readyState, duration: bank[k].duration }
      })
    }
  }

  run()
})()
