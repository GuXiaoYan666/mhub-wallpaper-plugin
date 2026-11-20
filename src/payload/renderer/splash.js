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
    out.mode = ['moon', 'gallery', 'dragon', 'ios'].indexOf(String(out.mode)) >= 0 ? String(out.mode) : 'mhub'
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
       纯代码复刻 ChatGPT macOS 启动序列（非视频）：
       锁屏 → 解锁 → 桌面菜单栏 + Dock → App 窗口展开
       → “welcome Jay” 彩虹手写 → 云朵形变 → 主界面
       ios / dragon 两个模式共用，仅节奏略有差异
       ─────────────────────────────────────────────────────────────────────── */
    if (cfg.mode === 'ios') {
      boot2Branch()
      return
    }

    function boot2Branch() {
      var T = 1.0
      function a(ms, fn) { var id = setTimeout(fn, Math.round(ms * T / speed)); timers.push(id); return id }
      function pad2(n) { return n < 10 ? '0' + n : '' + n }
      wrap.classList.add('b3')

      /* 注入 CSS */
      var bcss = document.createElement('style')
      bcss.textContent = [
        '.b3{position:absolute;inset:0;background:#000;overflow:hidden;font-family:-apple-system,"SF Pro Text","PingFang SC","Microsoft YaHei",system-ui,sans-serif;--e:cubic-bezier(.25,.6,.3,1)}' +
        '.b3 *{box-sizing:border-box;margin:0;padding:0}' +
        /* 壁纸（锁屏 + 桌面同源，交叉淡入） */
        '.b3-wall{position:absolute;inset:0;overflow:hidden;background:#0b1020}' +
        '.b3-wall img,.b3-wall video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}' +
        '.b3-wall-ls>img,.b3-wall-ls>video{filter:brightness(.6) saturate(.95);transition:filter 1s var(--e),opacity 1s var(--e)}' +
        '.b3-wall-desk{opacity:0;transition:opacity 1s var(--e)}' +
        '.b3.unlock .b3-wall-desk{opacity:1}' +
        '.b3.unlock .b3-wall-ls{opacity:0;transition:opacity .8s var(--e)}' +
        '.b3-lsveil{position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.3) 0%,rgba(0,0,0,0) 20%,rgba(0,0,0,0) 60%,rgba(0,0,0,.45) 100%);transition:opacity .7s var(--e)}' +
        '.b3.unlock .b3-lsveil{opacity:0}' +
        /* 锁屏时钟 */
        '.b3-lstime{position:absolute;left:0;right:0;top:15%;text-align:center;color:#fff;opacity:0;transform:translateY(10px);transition:opacity 1s var(--e) .15s,transform 1s var(--e) .15s}' +
        '.b3.in .b3-lstime{opacity:1;transform:none}' +
        '.b3.unlock .b3-lstime{opacity:0;transition:opacity .45s var(--e)}' +
        '.b3-lstime .d{font-size:clamp(15px,2vw,21px);font-weight:500;opacity:.92}' +
        '.b3-lstime .t{font-size:clamp(84px,15vw,172px);font-weight:250;line-height:.98;letter-spacing:-.02em;margin-top:2px;text-shadow:0 2px 26px rgba(0,0,0,.3)}' +
        /* 锁屏右上状态 */
        '.b3-lstop{position:absolute;right:26px;top:50px;color:#fff;font-size:14px;letter-spacing:.12em;opacity:0;transition:opacity .8s var(--e) .3s}' +
        '.b3.in .b3-lstop{opacity:.9}' +
        '.b3.unlock .b3-lstop{opacity:0;transition:opacity .4s var(--e)}' +
        /* 锁屏底部生物解锁 */
        '.b3-lsbio{position:absolute;left:50%;bottom:54px;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:8px;color:#fff;opacity:0;transition:opacity .8s var(--e) .4s}' +
        '.b3.in .b3-lsbio{opacity:1}' +
        '.b3.unlock .b3-lsbio{opacity:0;transition:opacity .35s var(--e)}' +
        '.b3-lsbio .av{width:46px;height:46px;border-radius:50%;background:linear-gradient(140deg,#4a5a8a,#20263a);display:flex;align-items:center;justify-content:center;font-size:17px;font-weight:600;color:#cdd7ef;box-shadow:0 2px 14px rgba(0,0,0,.45)}' +
        '.b3-lsbio .nm{font-size:13px;font-weight:600}' +
        '.b3-lsbio .hint{font-size:11.5px;opacity:.72}' +
        /* 桌面菜单栏 */
        '.b3-menu{position:absolute;left:0;right:0;top:0;height:26px;z-index:8;display:flex;align-items:center;gap:15px;padding:0 14px;font-size:12.5px;color:#fff;background:rgba(24,26,34,.5);backdrop-filter:blur(20px) saturate(1.5);-webkit-backdrop-filter:blur(20px) saturate(1.5);opacity:0;transform:translateY(-100%);transition:opacity .45s var(--e),transform .45s var(--e)}' +
        '.b3.unlock .b3-menu{opacity:1;transform:none}' +
        '.b3-menu .brand{font-weight:700;display:flex;align-items:center;gap:6px}' +
        '.b3-menu .brand i{width:13px;height:13px;border-radius:3px;background:linear-gradient(135deg,#fff,#c7d2ff);display:inline-block}' +
        '.b3-menu .mi{opacity:.92}' +
        '.b3-menu .rt{margin-left:auto;display:flex;align-items:center;gap:12px;opacity:.92}' +
        '.b3-menu .bat{width:22px;height:11px;border:1px solid rgba(255,255,255,.85);border-radius:3px;padding:1px}' +
        '.b3-menu .bat i{display:block;height:100%;width:80%;background:#fff;border-radius:1px}' +
        /* Dock */
        '.b3-dock{position:absolute;left:50%;bottom:18px;transform:translateX(-50%) translateY(26px);z-index:8;display:flex;align-items:flex-end;gap:11px;padding:9px 14px;border-radius:20px;background:rgba(255,255,255,.14);backdrop-filter:blur(22px) saturate(1.6);-webkit-backdrop-filter:blur(22px) saturate(1.6);box-shadow:0 8px 34px rgba(0,0,0,.35),inset 0 0 0 .5px rgba(255,255,255,.22);opacity:0;transition:opacity .5s var(--e) .15s,transform .55s var(--e) .15s}' +
        '.b3.unlock .b3-dock{opacity:1;transform:translateX(-50%)}' +
        '.b3-dock .di{width:46px;height:46px;border-radius:11px;display:flex;align-items:center;justify-content:center;font-size:20px;box-shadow:0 3px 9px rgba(0,0,0,.28);position:relative}' +
        '.b3-dock .di.hl{transform:translateY(-6px);outline:2px solid rgba(255,255,255,.55);outline-offset:1px}' +
        '.b3-dock .di.hl::after{content:"M HUB";position:absolute;bottom:calc(100% + 7px);left:50%;transform:translateX(-50%);white-space:nowrap;font-size:11px;padding:2px 7px;border-radius:5px;background:rgba(30,32,40,.92);color:#fff}' +
        /* App 窗口 */
        '.b3-app{position:absolute;left:50%;top:50%;width:min(900px,86vw);height:min(580px,72vh);transform:translate(-50%,-50%) scale(.82);opacity:0;z-index:12;border-radius:11px;overflow:hidden;background:#141518;box-shadow:0 26px 90px rgba(0,0,0,.6),0 3px 10px rgba(0,0,0,.35);transition:transform .85s var(--e),opacity .6s var(--e)}' +
        '.b3.appopen .b3-app{transform:translate(-50%,-50%) scale(1);opacity:1}' +
        '.b3-bar{height:36px;display:flex;align-items:center;padding:0 12px;background:#26282e;gap:8px}' +
        '.b3-bar .tl{display:flex;gap:7px}' +
        '.b3-bar .tl i{width:12px;height:12px;border-radius:50%;display:block}' +
        '.b3-bar .tl i.r{background:#ff5f57}.b3-bar .tl i.y{background:#febc2e}.b3-bar .tl i.g{background:#28c840}' +
        '.b3-bar .tt{font-size:12.5px;color:#c9cdd6;font-weight:600;margin-left:6px}' +
        '.b3-body{position:absolute;inset:36px 0 0 0;background:#131417;display:flex;align-items:center;justify-content:center;overflow:hidden}' +
        '.b3-hand{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);text-align:center;white-space:nowrap;z-index:3;transition:opacity .5s var(--e),transform .5s var(--e)}' +
        '.b3-hand .w{display:inline-block;font-family:"Segoe Script","Snell Roundhand","Brush Script MT","Lucida Handwriting","Segoe Print",cursive;font-size:clamp(46px,7vw,104px);line-height:1;font-weight:400;background:linear-gradient(90deg,#ff5d8f 0%,#ff9f43 16%,#ffd93d 32%,#51cf66 50%,#4dabf7 68%,#da77f2 86%,#ff5d8f 100%);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent;clip-path:inset(0 100% 0 0);opacity:0;filter:blur(3px)}' +
        '.b3.hand1 .b3-hand .w{animation:b3write 2.15s var(--e) forwards}' +
        '@keyframes b3write{0%{clip-path:inset(0 100% 0 0);opacity:0;filter:blur(3px)}12%{opacity:1}100%{clip-path:inset(0 0 0 0);opacity:1;filter:blur(0)}}' +
        '.b3-hand .n{display:inline-block;margin-left:.16em;font-family:"Segoe Script","Snell Roundhand","Brush Script MT","Lucida Handwriting",cursive;font-size:clamp(40px,6vw,90px);line-height:1;font-weight:400;transform:rotate(-4deg) translateY(-.04em);background:linear-gradient(90deg,#f06595 0%,#b197fc 55%,#845ef7 100%);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent;clip-path:inset(0 100% 0 0);opacity:0;filter:blur(3px)}' +
        '.b3.hand2 .b3-hand .n{animation:b3write 1.5s var(--e) forwards}' +
        '.b3.handout .b3-hand{opacity:0;transform:translate(-50%,-50%) scale(1.06)}' +
        /* 云朵 UI */
        '.b3-cloud{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%) scale(.4);opacity:0;z-index:5;width:min(640px,76vw);height:min(540px,64vh);display:flex;align-items:center;justify-content:center;transition:opacity .5s var(--e),transform .9s var(--e)}' +
        '.b3.cloudon .b3-cloud{opacity:1;transform:translate(-50%,-50%) scale(1)}' +
        '.b3.cloudout .b3-cloud{opacity:0;transform:translate(-50%,-50%) scale(1.35);transition:opacity .45s var(--e),transform .55s var(--e)}' +
        '.b3-cloud{background:linear-gradient(#fff,#fff) padding-box,linear-gradient(135deg,#ffd93d,#51cf66,#4dabf7,#da77f2) border-box;border:3px solid transparent;border-radius:28px;box-shadow:0 22px 64px rgba(0,0,0,.38)}' +
        '.b3-cloud .brandmark{display:flex;justify-content:center;margin-bottom:16px}' +
        '.b3-cloud .brandmark svg{width:108px;height:auto;display:block}' +
        '.b3-cloud .inner{position:relative;z-index:2;text-align:center;width:100%;padding:0 14%}' +
        '.b3-cloud .q{font-size:clamp(17px,2.3vw,29px);font-weight:600;color:#1a1a1a;margin-bottom:15px}' +
        '.b3-cloud .box{width:100%;height:80px;border-radius:12px;background:#f4f4f5;box-shadow:inset 0 0 0 1px #e3e3e6;display:flex;align-items:flex-start;padding:13px 16px;color:#9aa0aa;font-size:13px}' +
        '.b3-cloud .box::before{content:"使用 M HUB Work"}' +
        /* 最终 UI */
        '.b3-final{position:absolute;inset:0;z-index:4;background:#fff;opacity:0;transition:opacity .55s var(--e);display:flex}' +
        '.b3.final .b3-final{opacity:1}' +
        '.b3-final .side{width:186px;background:#f7f7f8;border-right:1px solid #ececee;padding:16px 10px;font-size:13px;color:#3a3a3a}' +
        '.b3-final .side .row{height:30px;border-radius:7px;display:flex;align-items:center;gap:8px;padding:0 9px;margin-bottom:4px}' +
        '.b3-final .side .row.on{background:#ececee}' +
        '.b3-final .main{flex:1;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:16px}' +
        '.b3-final .main .q{font-size:clamp(19px,2.5vw,31px);font-weight:600;color:#1a1a1a}' +
        '.b3-final .main .box{width:min(520px,56vw);height:94px;border-radius:14px;background:#f7f7f8;box-shadow:inset 0 0 0 1px #e6e6e9;padding:14px 16px;color:#9aa0aa;font-size:13px}' +
        '.b3-final .main .box::before{content:"使用 M HUB Work"}' +
        '.b3.done .b3-menu,.b3.done .b3-dock{opacity:0;transition:opacity .4s var(--e)}'
      ].join('')
      document.head.appendChild(bcss)

      /* 构建 DOM ──── */
      var wp = cfg.wpBg
      function mkWall(cls, fallback) {
        var d = document.createElement('div')
        d.className = 'b3-wall ' + cls
        if (wp && wp.kind === 'video' && wp.url) {
          var v = document.createElement('video')
          v.src = wp.url; v.muted = true; v.loop = true; v.autoplay = true; v.playsInline = true
          d.appendChild(v); try { v.play().catch(function () {}) } catch (e) {}
        } else if (wp && wp.kind === 'image' && wp.url) {
          var im = document.createElement('img'); im.src = wp.url; d.appendChild(im)
        } else {
          d.style.background = fallback
        }
        stage.appendChild(d)
      }
      mkWall('b3-wall-desk', 'linear-gradient(160deg,#2a3a72 0%,#141a3a 58%,#05060f 100%)')

      /* 手写版：直接进入桌面 + 已展开的 App 窗口，只保留手写 welcome 段 */
      var now = new Date()

      /* 桌面菜单栏 */
      var menu = document.createElement('div')
      menu.className = 'b3-menu'
      menu.innerHTML = '<span class="brand"><i></i>M HUB</span>' +
        '<span class="mi">文件</span><span class="mi">编辑</span><span class="mi">显示</span>' +
        '<span class="mi">前往</span><span class="mi">窗口</span><span class="mi">帮助</span>' +
        '<span class="rt"><span class="mt">' + pad2(now.getHours()) + ':' + pad2(now.getMinutes()) + '</span><span class="bat"><i></i></span></span>'
      stage.appendChild(menu)

      /* Dock */
      var dock = document.createElement('div')
      dock.className = 'b3-dock'
      var dockDefs = [
        ['🗂','#7aa2ff'],['🎨','#ff9f43'],['💬','#51cf66'],['🎵','#ff6b6b'],
        ['📧','#4dabf7'],['📁','#fcc419'],['⬛','#1b1d22'],['🌐','#22b8cf'],
        ['🖼','#da77f2'],['🗑','#868e96']
      ]
      dockDefs.forEach(function (ic, i) {
        var d = document.createElement('div')
        d.className = 'di' + (i === 6 ? ' hl' : '')
        d.style.background = 'linear-gradient(150deg,' + ic[1] + ',rgba(0,0,0,.3))'
        d.textContent = ic[0]
        dock.appendChild(d)
      })
      stage.appendChild(dock)

      /* App 窗口 */
      var app = document.createElement('div')
      app.className = 'b3-app'
      app.innerHTML = '<div class="b3-bar"><div class="tl"><i class="r"></i><i class="y"></i><i class="g"></i></div><span class="tt">M HUB</span></div>' +
        '<div class="b3-body"><div class="b3-hand"><span class="w">welcome</span><span class="n"></span></div></div>'
      stage.appendChild(app)
      var body = app.querySelector('.b3-body')
      app.querySelector('.b3-hand .n').textContent = (cfg.welcomeName || 'Jay')

      /* 云朵 UI：四色渐变描边 + 内部内容 */
      var CLOUD_PATH = 'M100 22 C114 22 124 31 126 43 C139 40 152 46 157 58 C169 59 178 69 176 81 C187 88 189 101 181 111 C187 123 180 137 167 140 C166 154 153 162 140 158 C132 170 116 173 105 165 C93 174 76 171 69 159 C55 161 42 151 42 138 C29 135 21 122 28 110 C18 102 22 86 34 81 C31 68 41 54 55 54 C58 41 71 30 84 31 C88 26 94 22 100 22 Z'
      var cloud = document.createElement('div')
      cloud.className = 'b3-cloud'
      cloud.innerHTML = '<div class="inner">' +
        '<div class="brandmark"><svg viewBox="0 0 745 576" aria-hidden="true"><use href="#kmark" fill="#111"/></svg></div>' +
        '<div class="q">我们要做什么？</div><div class="box"></div></div>'
      body.appendChild(cloud)

      /* 最终 UI */
      var fin = document.createElement('div')
      fin.className = 'b3-final'
      fin.innerHTML = '<div class="side"><div class="row on">✎ 新聊天</div><div class="row">◫ 项目</div><div class="row">◷ 最近</div><div class="row">⋯ 更多</div></div>' +
        '<div class="main"><div class="q">我们要做什么？</div><div class="box"></div></div>'
      body.appendChild(fin)

      /* 时钟刷新（仅菜单栏） */
      var clockInt = setInterval(function () {
        var n = new Date()
        var mEl = menu.querySelector('.mt'); if (mEl) mEl.textContent = pad2(n.getHours()) + ':' + pad2(n.getMinutes())
      }, 1000); timers.push(clockInt)

      /* 直接进入桌面（跳过锁屏/解锁），保留 App 展开的轻微动效 */
      wrap.classList.add('in')
      requestAnimationFrame(function () { wrap.classList.add('unlock', 'appopen') })

      /* 只保留手写欢迎段：
         1.0s  手写 “welcome”
         3.2s  手写 “Jay”
         5.0s  手写淡出 + 云朵形变
         7.6s  云朵展开 → 主界面
         9.3s  收尾 */
      a(1000, function () { wrap.classList.add('hand1') })
      a(3200, function () { wrap.classList.add('hand2') })
      a(5000, function () { wrap.classList.add('handout', 'cloudon') })
      a(7600, function () { wrap.classList.add('cloudout', 'final') })
      a(9300, function () { clearInterval(clockInt); wrap.classList.add('done'); finish(700) })

      /* 跳过：点击或 Esc */
      var skipBound = false
      function bindSkip() {
        if (skipBound) return
        skipBound = true
        document.addEventListener('click', function () {
          clearInterval(clockInt)
          finish(500)
        }, { once: true })
        document.addEventListener('keydown', function (e) {
          if (e.key === 'Escape') { clearInterval(clockInt); finish(400) }
        }, { once: true })
      }
      a(1000, bindSkip)
    }
    if (cfg.mode === 'gallery') {
      var frame = document.createElement('iframe')
      frame.className = 'dsu-alt-frame'
      frame.src = base + 'modes/gallery/index.html'
      stage.appendChild(frame)
      /* 原动画固定 12 秒，结束后淡出交还主窗口 */
      timer = setTimeout(function () { finish(700) }, Math.round(12600 / speed))
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
    video.addEventListener('ended', function () { finish(700) })
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
