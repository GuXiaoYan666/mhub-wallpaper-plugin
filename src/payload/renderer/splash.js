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
        setTimeout(function () { try { window.close() } catch (e) {} }, 80)
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
