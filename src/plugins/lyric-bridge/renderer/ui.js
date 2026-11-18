(function () {
  'use strict';
  var W = window, D = document, api;
  if (W.__mcUI && W.__mcUI.version === 32) return;
  if (W.__mcUI && W.__mcUI.dispose) W.__mcUI.dispose();
  var snap = null, row = null, panel = null, brand = null, disposed = false, queued = false, cellsSig = '';
  var nowLines = null, nowMeta = null, nowState = null;
  var pending = null, pendingTimer = null, unsub = null;
  var pendingOnline = null, pendingOnlineTimer = null, cacheTimer = 0;
  var wave = null, waveAnchor = null;
  var waveCanvas = null, waveContext = null, waveResize = null, waveRaf = 0, waveLast = 0, waveTime = 0;
  var waveWidth = 0, waveHeight = 0, waveGradient = null, waveFrames = 0, waveMaxDrawMs = 0;
  var wavePreview = null, waveBoundary = null, waveRegion = null, waveCx = 0, waveCy = 0, waveRadius = 0;
  var wavePalettePhase = .55, waveInkLevel = 0;
  var wavePalette = [205,255,300,335,265].map(function (hue) {
    var angle = hue*Math.PI/180;
    return [.81,.08*Math.cos(angle),.08*Math.sin(angle)];
  });
  var waveAura = null, waveAuraContext = null, waveAuraSmooth = null, waveAuraSmoothContext = null, waveAuraBlend = null, waveAuraBlendContext = null, waveAuraScale = 1, waveAuraReady = false, waveAuraChanges = -1;
  var wavePaletteGate = createWavePaletteGate();
  var waveThemeMedia = W.matchMedia('(prefers-color-scheme: dark)');
  var waveThemeDark = isWaveDark(), waveThemeBlend = waveThemeDark ? 1 : 0;
  var waveAudio = null, waveAudioAt = -Infinity, waveAudioWanted = false, waveLeaseAt = 0, waveBeatKey = '';
  var waveLevels = {energy:0,bass:0,mid:0,treble:0}, waveImpulse = 0, waveFlow = 0, waveAccents = [0,0,0,0,0,0];
  var waveParticles = [];
  for (var dust = 0; dust < 60; dust++) {
    waveParticles.push({ x: ((dust * .61803398875) % 1), y: ((dust * .41421356237 + .13) % 1), size: .6 + (dust % 5) * .22, phase: dust * 2.39996 });
  }
  var waveMotion = W.matchMedia('(prefers-reduced-motion: reduce)');
  var wavePoints = [];
  for (var wp = 0; wp < 256; wp++) {
    var wa = wp * Math.PI / 128;
    wavePoints.push({ a: wa, x: Math.cos(wa), y: Math.sin(wa) });
  }
  var CSS = [
    '[data-mc-plugin]{box-sizing:border-box;font-family:inherit}',
    '.mc-player-panel{margin:8px 24px 20px;padding:18px 0 0;border-top:1px solid rgba(0,0,0,.08);color:inherit;min-width:0}',
    '.mc-player-heading{display:flex;align-items:center;gap:8px;margin:0 0 12px;padding:0 12px}',
    '.mc-player-heading svg{width:18px;height:18px;flex:none;stroke:currentColor;fill:none;stroke-width:1.5;opacity:.72}',
    '.mc-player-title{margin:0;flex:1;font-size:13px;font-weight:600;line-height:18px;letter-spacing:.01em}',
    '.mc-player-refresh{display:flex;align-items:center;justify-content:center;width:26px;height:26px;padding:5px;border:0;border-radius:7px;background:transparent;color:inherit;cursor:pointer;opacity:.5;transition:opacity .15s,background .15s}',
    '.mc-player-refresh svg{width:15px;height:15px}',
    '.mc-player-refresh:hover{opacity:.9;background:rgba(0,0,0,.05)}',
    '.mc-player-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px 6px}',
    '.mc-player-cell{position:relative;display:flex;flex-direction:column;align-items:center;gap:6px;min-width:0;width:100%;padding:10px 2px 8px;border:1px solid rgba(0,0,0,.055);border-radius:10px;background:transparent;font:inherit;color:inherit;cursor:pointer;transition:background .15s,border-color .15s}',
    '.mc-player-cell:hover{background:rgba(0,0,0,.03);border-color:rgba(0,0,0,.1)}',
    '.mc-player-cell:active{background:rgba(0,0,0,.06)}',
    '.mc-player-cell:disabled{cursor:wait;opacity:.5}',
    '.mc-player-cell:focus-visible,.mc-player-refresh:focus-visible{outline:2px solid currentColor;outline-offset:2px}',
    '.mc-player-icon{position:relative;display:grid;place-items:center;width:26px;height:26px;flex:none}',
    '.mc-player-icon img{display:block;width:26px;height:26px;object-fit:contain;border-radius:6px}',
    '.mc-player-icon--text{border-radius:6px;background:rgba(127,127,127,.12);font-size:13px}',
    '.mc-player-name{width:100%;font-size:11.5px;line-height:16px;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:.86}',
    '.mc-player-dot{position:absolute;right:-2px;bottom:-2px;width:6px;height:6px;border-radius:50%;background:#22c55e;border:2px solid #fff;box-sizing:content-box}',
    '.mc-player-note{margin:10px 0 0;padding:0 4px;line-height:17px;font-size:11px;opacity:.5;overflow-wrap:anywhere}',
    '.mc-player-note[data-error=true]{opacity:.9}',
    '.mc-player-now{margin-top:10px;padding:10px 11px 9px;border:1px solid rgba(0,0,0,.055);border-radius:10px;background:rgba(127,127,127,.035);min-width:0}',
    '.mc-player-now-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 6px}',
    '.mc-player-now-title{font-size:10.5px;line-height:14px;letter-spacing:.04em;opacity:.5}',
    '.mc-player-now-state{display:inline-flex;align-items:center;gap:5px;font-size:10.5px;line-height:14px;opacity:.7;white-space:nowrap}',
    '.mc-player-bili{margin-left:auto;display:inline-flex;align-items:center;height:20px;padding:0 9px;border:1px solid rgba(0,0,0,.12);border-radius:999px;background:transparent;color:inherit;font:inherit;font-size:10.5px;line-height:18px;cursor:pointer;opacity:.8;white-space:nowrap}',
    '.mc-player-bili:hover{opacity:1;background:rgba(0,0,0,.04)}',
    '.mc-player-bili:disabled{opacity:.45;cursor:default}',
    '.mc-player-bili[hidden]{display:none}',
    '.mc-player-now-state::before{content:"";width:5px;height:5px;flex:none;border-radius:50%;background:currentColor;opacity:.45}',
    '.mc-player-now-state[data-phase=sent]{color:#16a34a;opacity:.92}',
    '.mc-player-now-state[data-phase=error]{color:#dc2626;opacity:.95}',
    '.mc-player-now-lines{margin:0;display:flex;flex-direction:column;gap:2px;justify-content:center;min-height:44px}',
    '.mc-player-now-line{margin:0;font-size:12.5px;line-height:18px;color:rgba(var(--mc-ink),.42);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:.55;transition:color .35s ease,opacity .35s ease}',
    '.mc-player-now-line.active{color:rgb(var(--mc-ink));opacity:1;font-weight:600}',
    '.mc-line-trans{display:block;font-size:11px;font-weight:400;color:rgba(var(--mc-ink),.45);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.mc-player-now-lines[data-empty=true] .mc-player-now-line{font-weight:400;opacity:.55;color:rgba(var(--mc-ink),.34)}',
    '@keyframes mcLineFadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}',
    '.mc-player-now-line.active{animation:mcLineFadeIn .4s ease}',
    '.mc-player-now-meta{margin:5px 0 0;font-size:10.5px;line-height:15px;opacity:.45;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.mc-brand-note{position:fixed;left:28px;bottom:12px;z-index:2147483646;margin:0;color:inherit;font-size:11px;font-weight:500;line-height:16px;letter-spacing:.02em;opacity:.42;pointer-events:none;user-select:none}',
    '.mc-lyric-row{display:inline-flex;align-items:center;flex:0 0 auto;gap:7px;margin:0;padding:4px 6px 4px 10px;border:1px solid rgba(0,0,0,.07);border-radius:11px;background:rgba(127,127,127,.045);color:inherit;box-shadow:0 1px 1px rgba(0,0,0,.02)}',
    '.mc-lyric-title{font-size:13px;font-weight:600;line-height:20px;letter-spacing:.01em;white-space:nowrap}',
    '.mc-lyric-state{max-width:132px;font-size:11.5px;line-height:18px;opacity:.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.mc-lyric-preview{max-width:220px;font-size:12px;line-height:18px;opacity:.68;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transform:translateY(.5px)}',
    '.mc-lyric-online{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 9px;border:1px solid rgba(0,0,0,.1);border-radius:999px;background:transparent;color:inherit;font:inherit;font-size:11px;line-height:20px;cursor:pointer;opacity:.7;white-space:nowrap;transition:background .15s,border-color .15s,opacity .15s,color .15s}',
    '.mc-lyric-online:hover{opacity:1;background:rgba(127,127,127,.12);border-color:rgba(0,0,0,.2)}',
    '.mc-lyric-online:focus-visible{outline:2px solid currentColor;outline-offset:2px}',
    '.mc-lyric-online::before{content:"";width:6px;height:6px;flex:none;border-radius:50%;background:currentColor;opacity:.28;transition:background .15s,opacity .15s,box-shadow .15s}',
    '.mc-lyric-online[aria-pressed=true]{opacity:1;color:#2563eb;border-color:rgba(37,99,235,.4);background:rgba(37,99,235,.1)}',
    '.mc-lyric-online[aria-pressed=true]::before{background:#2563eb;opacity:1;box-shadow:0 0 0 3px rgba(37,99,235,.14)}',
    '.mc-lyric-row du-switch{flex:none}',
    '.mc-lyric-row button.mc-switch{position:relative;width:40px;height:22px;padding:2px;border:0;border-radius:12px;background:#888;cursor:pointer;transition:background .16s}',
    '.mc-switch span{display:block;width:18px;height:18px;background:#fff;border-radius:50%;transition:transform .16s}',
    '.mc-switch[aria-checked=true]{background:#222}',
    '.mc-switch[aria-checked=true] span{transform:translateX(18px)}',
    'html[theme-mode=dark] .mc-player-panel{border-color:rgba(255,255,255,.1)}',
    'html[theme-mode=dark] .mc-player-cell{border-color:rgba(255,255,255,.07)}',
    'html[theme-mode=dark] .mc-player-cell:hover{background:rgba(255,255,255,.045);border-color:rgba(255,255,255,.13)}',
    'html[theme-mode=dark] .mc-player-refresh:hover{background:rgba(255,255,255,.07)}',
    'html[theme-mode=dark] .mc-player-cell:active{background:rgba(255,255,255,.075)}',
    'html[theme-mode=dark] .mc-player-dot{border-color:#1b1b1b}',
    'html[theme-mode=dark] .mc-brand-note{opacity:.58}',
    'html[theme-mode=dark] .mc-lyric-row{border-color:rgba(255,255,255,.1);background:rgba(255,255,255,.045);box-shadow:none}',
    'html[theme-mode=dark] .mc-lyric-online{border-color:rgba(255,255,255,.16);background:rgba(255,255,255,.05)}',
    'html[theme-mode=dark] .mc-lyric-online:hover{background:rgba(255,255,255,.1);border-color:rgba(255,255,255,.26)}',
    'html[theme-mode=dark] .mc-lyric-online[aria-pressed=true]{color:#93c5fd;border-color:rgba(147,197,253,.45);background:rgba(96,165,250,.16)}',
    'html[theme-mode=dark] .mc-lyric-online[aria-pressed=true]::before{background:#93c5fd;box-shadow:0 0 0 3px rgba(96,165,250,.18)}',
    'html[theme-mode=dark] .mc-switch[aria-checked=true]{background:#ddd}',
    'html[theme-mode=dark] .mc-player-now{border-color:rgba(255,255,255,.08);background:rgba(255,255,255,.035)}',
    '@media(max-width:1500px){.screen-lyrics-panel__header:has(> .mc-lyric-row)>.screen-lyrics-panel__hint{order:2;flex-basis:100%;white-space:normal}.mc-lyric-row{order:1}.mc-lyric-state{display:none}.mc-lyric-preview{max-width:150px}}',
    '@media(max-width:1250px){.mc-lyric-row{gap:6px;padding-left:10px}.mc-lyric-title{font-size:13px}.mc-lyric-preview{max-width:110px;font-size:11.5px}}',
    '[data-mc-wave-anchor]{isolation:isolate}',
    '.mc-wave-relative{position:relative}',
    '.mc-speaker-wave{position:absolute;top:0;left:0;width:100%;height:0;overflow:hidden;z-index:-1;pointer-events:none;user-select:none;opacity:0;mask-image:linear-gradient(180deg,#000 calc(100% - 32px),transparent);transition:opacity 200ms cubic-bezier(.23,1,.32,1)}',
    '.mc-speaker-wave[data-full-stage=true]{z-index:0}',
    '.mc-speaker-wave[data-playing=true]{opacity:1}',
    '.mc-speaker-wave canvas{display:block;width:100%;height:100%;pointer-events:none}',
    '@media(prefers-reduced-motion:reduce){.mc-player-cell,.mc-speaker-wave,.mc-switch span{transition:none}}'
  ].join('\n');
  function send(m) { return W.__mcBridgeHost && W.__mcBridgeHost.send(m); }
  function root() {
    var el = D.querySelector('.audio-detail-root');
    var title = el && el.querySelector('.app-header__title');
    return title && /^K20\s*GT$/i.test(title.textContent.trim()) && /^#\/audio(?:\/|$)/.test(location.hash) ? el : null;
  }
  function remove(el) { if (el && el.parentNode) el.parentNode.removeChild(el); }
  function scopedCleanup() {
    remove(row); remove(panel); row = null; panel = null; cellsSig = '';
    nowLines = nowMeta = nowState = null;
    clearWave();
    D.querySelectorAll('[data-mc-plugin="lyric-toggle"],[data-mc-plugin="player-panel"]').forEach(function (e) { e.remove(); });
  }
  function clearWave() {
    stopWave();
    if (waveResize) waveResize.disconnect(); waveResize = null;
    waveCanvas = null; waveContext = null; waveGradient = null; waveWidth = 0; waveHeight = 0;
    wavePreview = null; waveBoundary = null; waveRegion = null; waveAura = null; waveAuraContext = null; waveAuraSmooth = null; waveAuraSmoothContext = null; waveAuraBlend = null; waveAuraBlendContext = null; waveAuraReady = false; waveAuraChanges = -1;
    remove(wave); wave = null;
    if (waveAnchor) {
      waveAnchor.removeAttribute('data-mc-wave-anchor');
      waveAnchor.classList.remove('mc-wave-relative');
    }
    D.querySelectorAll('[data-mc-plugin="speaker-wave"]').forEach(remove);
    D.querySelectorAll('[data-mc-wave-anchor]').forEach(function (el) {
      el.removeAttribute('data-mc-wave-anchor'); el.classList.remove('mc-wave-relative');
    });
    waveAnchor = null;
  }
  function stopWave() {
    if (waveRaf) W.cancelAnimationFrame(waveRaf);
    waveRaf = 0; waveLast = 0;
    wantAudio(false);
  }
  function wantAudio(active) {
    if (active !== waveAudioWanted || active && Date.now()-waveLeaseAt > 2000) {
      waveAudioWanted = active; waveLeaseAt = Date.now(); send({t:'audioView',active:active});
    }
    if (!active) {
      waveAudio = null; waveAudioAt = -Infinity; waveBeatKey = ''; waveImpulse = 0; waveAccents.fill(0); waveInkLevel = 0; wavePaletteGate.resetSignal();
      waveLevels.energy = waveLevels.bass = waveLevels.mid = waveLevels.treble = 0;
    }
  }
  function applyAudio(value) {
    if (disposed || !waveAudioWanted || !value) return;
    if (!value.ready) { waveAudio = null; waveAudioAt = -Infinity; return; }
    if (!['energy','bass','mid','treble','beat'].every(function (k) { return Number.isFinite(value[k]) && value[k]>=0 && value[k]<=1; }) || !Number.isSafeInteger(value.serial) || value.serial<0 || !Number.isSafeInteger(value.session)) return;
    waveAudio = value; waveAudioAt = W.performance.now();
    var key = value.session+':'+value.serial;
    if (key !== waveBeatKey && value.serial>0 && value.beat>.08 && value.energy>.04) {
      waveImpulse = Math.max(waveImpulse,value.beat);
      waveAccents[value.serial%6] = Math.max(waveAccents[value.serial%6],value.beat);
    }
    waveBeatKey = key;
  }
  function stepWave(dt) {
    var fresh = waveAudio && W.performance.now()-waveAudioAt < 600;
    Object.keys(waveLevels).forEach(function (k) {
      var target = fresh ? Math.pow(waveAudio[k],.65) : 0;
      var ease = 1-Math.exp(-dt/(target>waveLevels[k] ? .065 : .28));
      waveLevels[k] += (target-waveLevels[k])*ease;
    });
    waveImpulse *= Math.exp(-dt/.24);
    waveAccents = waveAccents.map(function (v) { return v*Math.exp(-dt/.5); });
    waveFlow += dt*(.24+waveLevels.energy*1.2+waveLevels.treble*.9);
    var signal = fresh && waveAudio.energy>.025 ? waveAudio.energy*.6+waveAudio.bass*.25+waveAudio.treble*.15 : null;
    wavePalettePhase = wavePaletteGate.step(dt,signal);
    waveInkLevel += (waveLevels.mid-waveInkLevel)*(1-Math.exp(-dt/.8));
    waveThemeBlend += ((waveThemeDark ? 1 : 0)-waveThemeBlend)*(1-Math.exp(-dt/.18));
  }
  function createWavePaletteGate() {
    var duration=3.5, value=.55, from=.55, to=.55, elapsed=duration, reference=null, direction=0, hold=0, changes=0;
    return {
      step: function (dt,signal) {
        if (elapsed<duration) {
          elapsed=Math.min(duration,elapsed+dt);
          var u=elapsed/duration; value=from+(to-from)*u*u*(3-2*u);
          return value;
        }
        if (!Number.isFinite(signal)) { direction=0;hold=0;return value; }
        if (reference===null) { reference=signal;return value; }
        var next=signal-reference>=.10 ? 1 : reference-signal>=.10 ? -1 : 0;
        if (!next) { direction=0;hold=0;return value; }
        hold = next===direction ? hold+dt : dt; direction=next;
        if (hold>=.12) {
          from=value;to=value+direction;elapsed=0;reference=signal;hold=0;direction=0;changes++;
        }
        return value;
      },
      resetSignal: function () { reference=null;hold=0;direction=0; },
      inspect: function () { return {value:value,target:to,elapsed:elapsed,duration:duration,threshold:.10,changes:changes,active:elapsed<duration}; }
    };
  }
  function isWaveDark() {
    var mode=D.documentElement.getAttribute('theme-mode');
    return mode==='dark' || mode!=='light' && waveThemeMedia.matches;
  }
  function updateWaveTheme() {
    waveThemeDark=isWaveDark();
    if (!waveRaf) { waveThemeBlend=waveThemeDark ? 1 : 0;drawWave(); }
  }
  function drawWave() {
    if (!waveContext || !waveWidth || !waveHeight) return;
    var started = W.performance.now(), ctx = waveContext;
    var breath = 3 + waveLevels.bass*25 + waveImpulse*18;
    waveGradient = ctx.createLinearGradient(0, waveHeight, waveWidth, 0);
    for (var colorStop=0;colorStop<=16;colorStop++) waveGradient.addColorStop(colorStop/16,waveColor(36*Math.sin(colorStop/16*Math.PI*1.2-.6),1));
    ctx.clearRect(0, 0, waveWidth, waveHeight);
    drawWaveAura();
    ctx.strokeStyle = waveGradient; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (var layer = 0; layer < 22; layer++) {
      var t = waveFlow * 1.25 - layer * .085, offset = (layer - 10.5) * (.18+waveLevels.mid*.16);
      ctx.beginPath();
      for (var p = 0; p < wavePoints.length; p++) {
        var point = wavePoints[p], a = point.a;
        var field = .46 * Math.sin(5 * a + .8 * t + Math.sin(3 * a - .4 * t))
          + .29 * Math.sin(11 * a - .9 * t + Math.sin(2 * a + .3 * t))
          + .17 * Math.sin(23 * a + 1.2 * t) + .08 * Math.sin(47 * a - .7 * t);
        var drift = offset + waveLevels.bass*5 + waveImpulse*8 + breath * field + (.4+waveLevels.treble*2.5) * Math.sin(73 * a + layer * .2 + t);
        var x = point.bx + point.nx * drift;
        var y = point.by + point.ny * drift;
        if (p) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      ctx.closePath();
      var crest = layer === 2 || layer === 10 || layer === 19;
      if (crest) {
        ctx.globalAlpha = .055; ctx.lineWidth = 4; ctx.stroke();
      }
      ctx.globalAlpha = crest ? .4+waveLevels.energy*.22+waveImpulse*.12 : .08+waveLevels.mid*.08; ctx.lineWidth = crest ? .8 : .6; ctx.stroke();
    }
    ctx.globalAlpha = 1; drawWaveParticles(); waveFrames++;
    waveMaxDrawMs = Math.max(waveMaxDrawMs, W.performance.now() - started);
  }
  function wavePigment(phase) {
    var count = wavePalette.length, index = Math.floor(phase), u = phase-index;
    var colors = [-1,0,1,2].map(function (n) { return wavePalette[((index+n)%count+count)%count]; });
    return [0,1,2].map(function (channel) {
      var p = colors.map(function (color) { return color[channel]; });
      return .5*((2*p[1])+(-p[0]+p[2])*u+(2*p[0]-5*p[1]+4*p[2]-p[3])*u*u+(-p[0]+3*p[1]-3*p[2]+p[3])*u*u*u);
    });
  }
  function waveRgb(phase, lightness, chroma) {
    var lab = wavePigment(phase), L = Number.isFinite(lightness) ? lightness : lab[0];
    var a = lab[1]*(chroma||1), b = lab[2]*(chroma||1);
    var l = Math.pow(L+.3963377774*a+.2158037573*b,3);
    var m = Math.pow(L-.1055613458*a-.0638541728*b,3);
    var s = Math.pow(L-.0894841775*a-1.291485548*b,3);
    return [4.0767416621*l-3.3077115913*m+.2309699292*s,
      -1.2684380046*l+2.6097574011*m-.3413193965*s,
      -.0041960863*l-.7034186147*m+1.707614701*s].map(function (v) {
        v = Math.max(0,Math.min(1,v));
        return 255*(v<=.0031308 ? 12.92*v : 1.055*Math.pow(v,1/2.4)-.055);
      });
  }
  function waveColor(offset, alpha, ambient) {
    var lightness=ambient ? .81 : .56+.25*waveThemeBlend, chroma=ambient ? 1 : 1.1-.1*waveThemeBlend;
    return 'rgba('+waveRgb(wavePalettePhase+offset*.008,lightness,chroma).map(function (v) { return v.toFixed(2); }).join(',')+','+alpha+')';
  }
  function drawWaveInk(ctx) {
    var t = waveFlow, r = waveRadius, ink = waveInkLevel;
    ctx.save();
    for (var plume = 0; plume < 3; plume++) {
      var seed = plume * 2.4, turn = t * .055 + seed;
      var px = waveCx + Math.cos(turn) * r * .94;
      var py = waveCy + Math.sin(turn * .8 + seed) * r * .7;
      ctx.fillStyle = waveColor(plume*32-24,1,true);
      for (var veil = 0; veil < 14; veil++) {
        var spread = .5 + veil * .046 + ink*.2;
        ctx.beginPath();
        for (var p = 0; p <= 80; p++) {
          var a = p * Math.PI / 40;
          var field = 1 + (.16+ink*.2)*Math.sin(a*3+t*.16+seed) + .12*Math.sin(a*5-t*.1+seed) + (.025+ink*.07)*Math.sin(a*11+t*.2+veil*.08);
          var x = px + Math.cos(a)*r*spread*field*1.55;
          var y = py + Math.sin(a)*r*spread*field*.8;
          if(p)ctx.lineTo(x,y);else ctx.moveTo(x,y);
        }
        ctx.closePath();ctx.globalAlpha=.005+ink*.006;ctx.fill();
        if(veil%4===0){ctx.globalAlpha=.018;ctx.strokeStyle=waveColor(plume*26+4,1);ctx.lineWidth=.7;ctx.stroke();}
      }
    }
    ctx.restore();
  }
  function drawWaveParticles() {
    var ctx = waveContext, t = waveFlow;
    waveParticles.forEach(function (dot,index) {
      var x = dot.x*waveWidth + Math.sin(t*.11+dot.phase)*18 + Math.cos(dot.phase)*waveImpulse*16;
      var y = ((dot.y*waveHeight-t*(2+index%3))%waveHeight+waveHeight)%waveHeight;
      var alpha = .08 + (.18+waveLevels.treble*.34)*(.5+.5*Math.sin(t*.6+dot.phase));
      if(index%6===0){var halo=ctx.createRadialGradient(x,y,0,x,y,6);halo.addColorStop(0,waveColor(index*3,alpha*.34));halo.addColorStop(1,waveColor(index*3,0));ctx.fillStyle=halo;ctx.fillRect(x-6,y-6,12,12);}
      ctx.beginPath();ctx.arc(x,y,dot.size*(1+waveLevels.treble*.45),0,Math.PI*2);ctx.fillStyle=waveColor(index*2,alpha);ctx.fill();
    });
  }
  function drawWaveAura() {
    var ctx = waveAuraContext, w = waveWidth, h = waveHeight;
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    var t = waveFlow, r = waveRadius, cx = waveCx, cy = waveCy;
    [[cx-r*.65+Math.sin(t*.18)*r*.18,cy-r*.45,r*1.7,-42],
     [cx+r*.65,cy-r*.1+Math.cos(t*.16)*r*.22,r*1.6,64],
     [cx+Math.sin(t*.13)*r*.5,cy+r*.6,r*1.65,12]].forEach(function (light) {
      var glow = ctx.createRadialGradient(light[0],light[1],0,light[0],light[1],light[2]);
      glow.addColorStop(0,waveColor(light[3],.2,true)); glow.addColorStop(.5,waveColor(light[3],.085,true)); glow.addColorStop(1,waveColor(light[3],0,true));
      ctx.fillStyle = glow; ctx.fillRect(0,0,w,h);
    });
    drawWaveInk(ctx);
    blendWaveAura();
    ctx.clearRect(0,0,w,h);
    var far = Math.max(Math.hypot(cx,cy), Math.hypot(w-cx,cy), Math.hypot(cx,h-cy), Math.hypot(w-cx,h-cy));
    for (var ring = 0; ring < 6; ring++) {
      var phase = (t * .1 + ring / 6) % 1;
      var radius = r + phase * (far - r + 70);
      ctx.beginPath();
      for (var i = 0; i <= 128; i++) {
        var a = i * Math.PI / 64;
        var flutter = Math.sin(a*7-t*.7+ring)*3 + Math.sin(a*19+t*.4)*1.5;
        var x = cx + (radius+flutter)*Math.cos(a), y = cy + (radius+flutter)*Math.sin(a);
        if (i) ctx.lineTo(x,y); else ctx.moveTo(x,y);
      }
      ctx.closePath();
      var appear=.5-.5*Math.cos(Math.PI*Math.min(1,phase/.10));
      var disappear=.5-.5*Math.cos(Math.PI*Math.min(1,(1-phase)/.18));
      var opacity=(.22+.25*waveLevels.energy+.13*waveAccents[ring])*appear*disappear*(1.15-.15*waveThemeBlend);
      ctx.strokeStyle = waveColor(ring*12,opacity.toFixed(4));
      ctx.lineWidth = 2.8-.4*waveThemeBlend; ctx.stroke();
    }
    var scale = waveAuraScale, reed = 6;
    for (var col = 0; col < w; col += reed) {
      var width = Math.min(reed,w-col), shift = Math.sin(col*.017+t*.17)*12;
      var source = Math.max(0,Math.min(w-width,col+Math.sin(col*.09)*3));
      waveContext.drawImage(waveAuraBlend,source*scale,0,width*scale,waveAuraBlend.height,col,-18+shift,width,h+36);
      waveContext.drawImage(waveAura,source*scale,0,width*scale,waveAura.height,col,-18+shift,width,h+36);
      waveContext.fillStyle = 'rgba(204,213,255,' + (.015+.012*Math.sin(col*.13)).toFixed(4) + ')';
      waveContext.fillRect(col,0,1,h);
    }
  }
  function blendWaveAura() {
    var ctx = waveAuraBlendContext, state = wavePaletteGate.inspect();
    if (!ctx) return;
    ctx.setTransform(1,0,0,1,0,0);
    if (!waveAuraReady || waveAuraChanges !== state.changes) {
      waveAuraSmoothContext.globalCompositeOperation = 'copy';
      waveAuraSmoothContext.drawImage(waveAuraReady ? waveAuraBlend : waveAura,0,0);
      waveAuraSmoothContext.globalCompositeOperation = 'source-over';
      waveAuraChanges = state.changes; waveAuraReady = true;
    }
    var u = Math.min(1,state.elapsed/state.duration), mix = u*u*(3-2*u);
    ctx.globalCompositeOperation = 'copy'; ctx.globalAlpha = 1-mix;
    ctx.drawImage(waveAuraSmooth,0,0);
    ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = mix; ctx.drawImage(waveAura,0,0);
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    waveAuraReady = true;
  }
  function resizeWave() {
    if (!waveCanvas || !wave || !wave.isConnected) return;
    var stage = waveAnchor.getBoundingClientRect(), preview = wavePreview.getBoundingClientRect(), region = waveRegion.getBoundingClientRect();
    var top = stage.top, bottom = waveBoundary.getBoundingClientRect().top;
    var width = Math.round(region.width), height = Math.max(0,Math.round(bottom-top));
    var cx = preview.left+preview.width/2-region.left, cy = preview.top+preview.height/2-top;
    var radius = preview.width * .49, left = (region.left-stage.left).toFixed(2)+'px';
    var dpr = Math.min(W.devicePixelRatio || 1, 1.25);
    if (!width || !height) { stopWave(); return; }
    if (wave.style.left !== left) wave.style.left = left;
    if (wave.style.width !== width+'px') wave.style.width = width+'px';
    if (wave.style.height !== height+'px') wave.style.height = height+'px';
    if (width === waveWidth && height === waveHeight && cx === waveCx && cy === waveCy && radius === waveRadius && waveCanvas.width === Math.round(width*dpr)) return;
    waveWidth = width; waveHeight = height;
    waveCx = cx; waveCy = cy; waveRadius = radius;
    wavePoints.forEach(function (point) {
      point.bx = cx + radius * point.x; point.by = cy + radius * point.y;
      point.nx = point.x; point.ny = point.y;
    });
    waveCanvas.width = Math.round(width * dpr); waveCanvas.height = Math.round(height * dpr);
    waveContext.setTransform(dpr, 0, 0, dpr, 0, 0);
    waveAuraScale = Math.min(.55,640/width);
    waveAura.width = Math.max(1,Math.round(width*waveAuraScale)); waveAura.height = Math.max(1,Math.round(height*waveAuraScale));
    waveAuraContext.setTransform(waveAuraScale,0,0,waveAuraScale,0,0);
    if (waveAuraSmooth) {
      waveAuraSmooth.width = waveAura.width; waveAuraSmooth.height = waveAura.height;
      waveAuraSmoothContext.setTransform(1,0,0,1,0,0);
      waveAuraBlend.width = waveAura.width; waveAuraBlend.height = waveAura.height;
      waveAuraBlendContext.setTransform(1,0,0,1,0,0);
    }
    waveAuraReady = false; waveAuraChanges = -1;
    drawWave();
  }
  function animateWave(at) {
    waveRaf = 0;
    if (disposed || !wave || !wave.isConnected || wave.dataset.playing !== 'true' || waveMotion.matches || D.hidden) { stopWave(); return; }
    if (!waveLast) waveLast = at;
    if (at - waveLast >= 1000 / 30) {
      var dt = Math.min((at-waveLast)/1000,.1); waveTime += dt; stepWave(dt);
      waveLast = at; drawWave();
    }
    waveRaf = W.requestAnimationFrame(animateWave);
  }
  function paintWave(target) {
    var preview = target.querySelector('.screen-page__device-preview');
    var page = preview && preview.closest('.screen-page');
    var layout = page && page.closest('.device-detail-layout');
    var anchor = layout || page;
    var region = layout && layout.querySelector('.device-detail-layout__workspace-background') || page;
    var boundary = page && page.querySelector('.screen-page__content-area');
    if (!anchor || !region || !boundary || !preview.getClientRects().length || !boundary.getClientRects().length) { clearWave(); return; }
    if (anchor !== waveAnchor || preview !== wavePreview || boundary !== waveBoundary || region !== waveRegion) {
      clearWave(); waveAnchor = anchor; wavePreview = preview; waveBoundary = boundary; waveRegion = region;
      anchor.setAttribute('data-mc-wave-anchor', '');
      if (W.getComputedStyle(anchor).position === 'static') anchor.classList.add('mc-wave-relative');
    }
    if (!wave) {
      wave = D.createElement('div'); wave.dataset.mcPlugin = 'speaker-wave'; wave.className = 'mc-speaker-wave';
      wave.dataset.fullStage = String(!!layout);
      wave.setAttribute('aria-hidden', 'true');
      waveCanvas = D.createElement('canvas'); waveCanvas.setAttribute('aria-hidden', 'true');
      waveContext = waveCanvas.getContext('2d');
      waveAura = D.createElement('canvas'); waveAuraContext = waveAura.getContext('2d');
      waveAuraSmooth = D.createElement('canvas'); waveAuraSmoothContext = waveAuraSmooth.getContext('2d');
      waveAuraBlend = D.createElement('canvas'); waveAuraBlendContext = waveAuraBlend.getContext('2d');
      if (!waveContext || !waveAuraContext || !waveAuraSmoothContext || !waveAuraBlendContext) { clearWave(); return; }
      wave.appendChild(waveCanvas);
      if (W.ResizeObserver) { waveResize = new ResizeObserver(resizeWave); waveResize.observe(anchor); waveResize.observe(preview); waveResize.observe(region); }
    }
    if (wave.parentElement !== anchor) anchor.appendChild(wave);
    var now = snap && snap.nowPlaying;
    var playing = !!(snap && snap.pluginEnabled !== false && now && now.ready !== false && !now.error && now.media && now.media.playing === true && !D.hidden);
    if (wave.dataset.playing !== String(playing)) wave.dataset.playing = String(playing);
    resizeWave();
    if (playing && !waveMotion.matches) {
      wantAudio(true);
      if (!waveRaf) waveRaf = W.requestAnimationFrame(animateWave);
    } else stopWave();
  }
  function ensureStyle() {
    if (D.querySelector('style[data-mc-plugin=style]')) return;
    var style = D.createElement('style'); style.dataset.mcPlugin = 'style'; style.textContent = CSS; D.head.appendChild(style);
  }
  function on() { return pending == null ? !!(snap && snap.pluginEnabled && snap.lyric && snap.lyric.on) : pending; }
  function toggle() {
    var next = !on(); pending = next; paintRow(); send({ t: 'toggle', on: next });
    W.clearTimeout(pendingTimer); pendingTimer = W.setTimeout(function () { pending = null; paintRow(); }, 3000);
  }
  function onlineOn() {
    return pendingOnline == null ? !!(snap && snap.online && snap.online.enabled !== false) : pendingOnline;
  }
  function toggleOnline() {
    var next = !onlineOn(); pendingOnline = next; paintRow(); send({ t: 'online', on: next });
    W.clearTimeout(pendingOnlineTimer);
    pendingOnlineTimer = W.setTimeout(function () { pendingOnline = null; paintRow(); }, 3000);
  }
  var mediaApps = [
    [/bilibili|哔哩|bili/i, 'B站'],
    [/kuwo|kwmusic|酷我/i, '酷我'],
    [/lx[-_ ]?music|洛雪|落雪/i, '洛雪'],
    [/qqmusic|qq音乐|tencent/i, 'QQ音乐'],
    [/cloudmusic|netease|网易云/i, '网易云'],
    [/kugou|酷狗/i, '酷狗'],
    [/soda|汽水/i, '汽水'],
    [/migu|咪咕/i, '咪咕'],
    [/qianqian|baidumusic|千千/i, '千千'],
    [/spotify/i, 'Spotify'],
    [/apple\s*music/i, 'Apple Music'],
    [/folia/i, 'Folia'],
    [/mineradio/i, 'Mineradio'],
    [/foobar/i, 'foobar2000'],
    [/aimp/i, 'AIMP'],
    [/musicbee/i, 'MusicBee'],
    [/groove|media\.ui|zune/i, 'Media Player']
  ];
  function mediaApp(id) {
    if (!id) return '';
    for (var i = 0; i < mediaApps.length; i++) if (mediaApps[i][0].test(String(id))) return mediaApps[i][1];
    return '';
  }
  function sessionLabel(online) {
    var media = snap && snap.nowPlaying && snap.nowPlaying.media;
    var app = mediaApp(media && media.id);
    var cached = online && online.state === 'cached';
    var provider = online && online.provider === 'netease' ? '网易云' : '在线';
    return app ? app + ' · ' + (cached ? '缓存' : provider) : cached ? '在线 · 缓存' : provider;
  }
  function biliActive() {
    var lyric = snap && snap.lyric;
    if (lyric && lyric.source === 'bilibili') return true;
    var b = snap && snap.bilibili;
    if (b && b.web && (b.state === 'ready' || b.state === 'no-cookie' || b.state === 'no-subtitle')) return true;
    var media = snap && snap.nowPlaying && snap.nowPlaying.media;
    return !!(media && /bilibili|哔哩|bili/i.test(String(media.id || '')));
  }
  function biliLabel() {
    var b = snap && snap.bilibili;
    if (!b) return '';
    var pre = b.web ? 'B站网页' : 'B站';
    if (b.state === 'no-cookie') return pre + ' · 需登录';
    if (b.state === 'no-subtitle') return pre + ' · 无字幕';
    if (b.state === 'no-bvid' || b.state === 'no-video') return pre + ' · 未识别';
    if (b.state === 'error') return pre + ' · 字幕失败';
    if (b.state === 'resolving') return pre + ' · 获取字幕';
    if (b.state === 'ready') return pre + ' · 字幕' + (b.cached ? '缓存' : '') + (b.estimated ? ' · 估算' : '');
    return '';
  }
  function makeRow() {
    var el = D.createElement('div'); el.dataset.mcPlugin = 'lyric-toggle'; el.className = 'mc-lyric-row';
    var label = D.createElement('strong'); label.className = 'mc-lyric-title'; label.id = 'mc-lyric-label'; label.textContent = '歌词'; el.appendChild(label);
    var sw;
    if (W.customElements && customElements.get('du-switch')) {
      sw = D.createElement('du-switch'); sw.setAttribute('passive', ''); sw.setAttribute('test-id', 'mc-lyrics-enabled'); sw.addEventListener('change', toggle);
    } else {
      sw = D.createElement('button'); sw.type = 'button'; sw.className = 'mc-switch'; sw.setAttribute('role', 'switch'); sw.innerHTML = '<span></span>'; sw.addEventListener('click', toggle);
    }
    sw.setAttribute('aria-label', '歌词扩展显示开关'); el.appendChild(sw);
    var onlineBtn = D.createElement('button'); onlineBtn.type = 'button'; onlineBtn.className = 'mc-lyric-online';
    onlineBtn.textContent = '在线歌词'; onlineBtn.setAttribute('aria-label', '在线歌词（系统媒体会话，适配酷我、洛雪、QQ音乐、网易云等播放器）'); onlineBtn.addEventListener('click', toggleOnline);
    el.appendChild(onlineBtn);
    var preview = D.createElement('span'); preview.className = 'mc-lyric-preview'; preview.hidden = true; el.appendChild(preview);
    var info = D.createElement('span'); info.className = 'mc-lyric-state'; info.setAttribute('role', 'status'); el.appendChild(info);
    return el;
  }
  function paintRow() {
    if (!row) return;
    var sw = row.querySelector('du-switch,button');
    if (sw) { if (sw.tagName === 'DU-SWITCH') sw.checked = on(); else sw.setAttribute('aria-checked', String(on())); }
    var onlineBtn = row.querySelector('.mc-lyric-online');
    if (onlineBtn) onlineBtn.setAttribute('aria-pressed', String(onlineOn()));
    var delivery = W.__mcDevice && W.__mcDevice.inspect();
    var online = (snap && snap.online) || {};
    var lyric = snap && snap.lyric;
    var state;
    if (!on()) state = '已关闭';
    else if (lyric && lyric.source === 'kugou') state = '酷狗';
    else if (lyric && lyric.source === 'soda') state = '汽水';
    else if (lyric && lyric.source === 'bilibili') state = biliLabel() || 'B站';
    else if (biliActive() && biliLabel()) state = biliLabel();
    else if (lyric && lyric.source === 'session') state = sessionLabel(online);
    else if (online.state === 'searching') state = '在线搜索中';
    else if (online.state === 'miss') state = '未找到歌词';
    else if (online.state === 'offline') state = '在线不可用';
    else {
      var phases = { waiting: '等待播放', off: '已关闭', sent: '已连接', native: '官方音源播放中', offline: '设备未连接', 'screen-off': '请开启屏幕', error: '连接失败' };
      state = delivery ? phases[delivery.phase] || '连接中' : '连接中';
    }
    row.querySelector('.mc-lyric-state').textContent = state;
    var preview = row.querySelector('.mc-lyric-preview');
    if (preview) {
      var line = lyric && lyric.text ? String(lyric.text) : '';
      if (preview.textContent !== line) preview.textContent = line;
      preview.hidden = !line;
      preview.title = line;
    }
    row.title = (delivery && delivery.error) || '歌词开关控制全部来源；「在线」适配酷我、洛雪、QQ音乐、网易云等写入系统媒体会话的播放器；B 站字幕点播放器面板里的「扫码登录 B 站」，也可以在 config.json 的 bilibili.sessdata 手动填写';
  }
  function makePanel() {
    var el = D.createElement('section'); el.dataset.mcPlugin = 'player-panel'; el.className = 'mc-player-panel'; el.setAttribute('aria-label', '音乐播放器');
    el.innerHTML = '<div class="mc-player-heading"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V5l11-2v13M9 8l11-2"/><ellipse cx="6" cy="18" rx="3" ry="2.5"/><ellipse cx="17" cy="16" rx="3" ry="2.5"/></svg><h3 class="mc-player-title">音乐播放器</h3><button type="button" class="mc-player-refresh mc-player-clear" title="清空在线歌词缓存" aria-label="清空在线歌词缓存"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg></button><button type="button" class="mc-player-refresh" title="重新扫描播放器" aria-label="重新扫描播放器"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M5 8a8 8 0 0 1 13-3l2 3M4 16l2 3a8 8 0 0 0 13-3"/></svg></button></div><div class="mc-player-grid" role="group" aria-label="已安装的音乐播放器"></div><div class="mc-player-now" aria-label="当前歌词与设备状态"><div class="mc-player-now-head"><span class="mc-player-now-title">当前歌词</span><button type="button" class="mc-player-bili mc-player-webbili" hidden>浏览器播放</button><button type="button" class="mc-player-bili" hidden>扫码登录 B 站</button><span class="mc-player-now-state" data-phase="waiting">等待播放</span></div><div class="mc-player-now-lines" data-empty="true"><p class="mc-player-now-line">播放歌曲后在此预览歌词</p></div><p class="mc-player-now-meta">来源 — · 设备 —</p></div><p class="mc-player-note" role="status"></p>';
    el.querySelector('.mc-player-refresh:not(.mc-player-clear)').onclick = function () { send({ t: 'refreshPlayers' }); };
    el.querySelector('.mc-player-clear').onclick = function () {
      send({ t: 'clearLyricsCache' });
      var note = el.querySelector('.mc-player-note');
      note.dataset.error = 'false'; note.textContent = '歌词缓存已清理';
      W.clearTimeout(cacheTimer);
      cacheTimer = W.setTimeout(function () { cellsSig = ''; paintPanel(); }, 2600);
    };
    el.addEventListener('click', function (event) {
      var button = event.target.closest('.mc-player-cell');
      if (button && el.contains(button)) send({ t: 'launch', id: button.dataset.id });
    });
    var webBiliBtn = el.querySelector('.mc-player-webbili');
    if (webBiliBtn) webBiliBtn.onclick = function () { send({ t: 'biliOpen' }); };
    var biliBtn = el.querySelector('.mc-player-bili:not(.mc-player-webbili)');
    if (biliBtn) biliBtn.onclick = function () {
      biliBtn.disabled = true;
      biliBtn.textContent = '请在窗口中扫码…';
      send({ t: 'biliLogin' });
      W.setTimeout(function () {
        biliBtn.disabled = false;
        biliBtn.textContent = '扫码登录 B 站';
      }, 8000);
    };
    nowLines = el.querySelector('.mc-player-now-lines');
    nowMeta = el.querySelector('.mc-player-now-meta');
    nowState = el.querySelector('.mc-player-now-state');
    return el;
  }
  function paintNow() {
    if (!panel || !nowLines) return;
    var lyric = snap && snap.lyric, online = (snap && snap.online) || {};
    var delivery = W.__mcDevice && W.__mcDevice.inspect();
    var sources = { kugou: '酷狗', soda: '汽水', bilibili: 'B站 · 字幕', netease: '网易云' };
    var source = lyric && lyric.source ? sources[lyric.source] || lyric.source : '';
    if (lyric && lyric.source === 'session') source = sessionLabel(online);
    if (lyric && lyric.source === 'bilibili') {
      source = (snap.bilibili && snap.bilibili.web ? 'B站网页' : 'B站') + ' · 字幕' + (snap.bilibili && snap.bilibili.cached ? ' · 缓存' : '') + (snap.bilibili && snap.bilibili.estimated ? ' · 估算' : '');
    }
    var text;
    if (!on()) text = '歌词显示已关闭';
    else if (lyric && lyric.text) text = lyric.text;
    else if (biliActive() && snap.bilibili) {
      var bs = snap.bilibili.state;
      if (bs === 'no-cookie') text = 'B站字幕需要登录：点击「扫码登录 B 站」';
      else if (bs === 'no-subtitle') text = '当前 B 站视频没有可用字幕';
      else if (bs === 'no-bvid' || bs === 'no-video') text = '未识别到当前 B 站视频';
      else if (bs === 'resolving') text = '正在获取 B 站字幕…';
      else if (bs === 'error') text = 'B 站字幕获取失败';
      else text = '播放 B 站视频后在此预览字幕';
    }
    else if (online.state === 'searching') text = '正在获取在线歌词…';
    else if (online.state === 'miss') text = '未找到匹配歌词';
    else if (online.state === 'offline') text = '在线歌词服务不可用';
    else text = '播放歌曲后在此预览歌词';
    var phases = { waiting: '等待播放', off: '已关闭', sent: '已连接', native: '官方音源播放中', offline: '设备未连接', 'screen-off': '请开启屏幕', error: '连接失败' };
    var phase = delivery ? delivery.phase : 'waiting';
    var state = on() ? phases[phase] || '连接中' : '已关闭';
    var meta = '来源 ' + (source || '—') + ' · 设备 ' + state;
    var webBiliBtn = panel.querySelector('.mc-player-webbili');
    if (webBiliBtn) {
      webBiliBtn.hidden = !(biliActive() && snap.bilibili && !snap.bilibili.web && snap.bilibili.estimated && snap.bilibili.bvid);
      webBiliBtn.title = 'B 站客户端不上报播放进度，改用浏览器播放可精确同步';
    }
    var biliBtn = panel.querySelector('.mc-player-bili:not(.mc-player-webbili)');
    if (biliBtn) biliBtn.hidden = !(biliActive() && snap.bilibili && !snap.bilibili.hasCookie);
    renderLyricLines(nowLines, lyric, text);
    if (nowMeta.textContent !== meta) nowMeta.textContent = meta;
    if (nowState.textContent !== state) nowState.textContent = state;
    if (nowState.dataset.phase !== (delivery ? phase : 'waiting')) nowState.dataset.phase = delivery ? phase : 'waiting';
  }
  var mcLineSeq = 0;
  function renderLyricLines(container, lyric, fallback) {
    var win = lyric && Array.isArray(lyric.window) ? lyric.window : null;
    var current = lyric && Number.isFinite(lyric.index) ? lyric.index : -1;
    var hasReal = !!(win && win.length && current >= 0);
    var sig = hasReal ? (current + '|' + win.map(function (l) { return l.i + ':' + l.text; }).join('//')) : ('fallback:' + fallback);
    if (container.dataset.sig === sig) return;
    container.dataset.sig = sig;
    container.innerHTML = '';
    if (!hasReal) {
      var p = D.createElement('p');
      p.className = 'mc-player-now-line';
      p.textContent = fallback || '';
      container.appendChild(p);
      container.dataset.empty = 'true';
      return;
    }
    container.dataset.empty = 'false';
    win.forEach(function (ln) {
      var isActive = ln.i === current;
      var line = D.createElement('p');
      line.className = 'mc-player-now-line' + (isActive ? ' active' : '');
      var main = D.createElement('span');
      main.className = 'mc-line-text';
      main.textContent = ln.text || '';
      line.appendChild(main);
      if (ln.translation && ln.translation.trim()) {
        var tr = D.createElement('span');
        tr.className = 'mc-line-trans';
        tr.textContent = ln.translation.trim();
        line.appendChild(tr);
      }
      container.appendChild(line);
    });
  }
  function ensureBrand() {
    if (brand && brand.isConnected) return;
    brand = D.createElement('div');
    brand.dataset.mcPlugin = 'brand-note';
    brand.className = 'mc-brand-note';
    brand.setAttribute('aria-label', 'LyricBridge 版本 1.3.10，作者 顾小颜');
    brand.textContent = 'LyricBridge 1.3.10 · 顾小颜';
    D.body.appendChild(brand);
  }
  function paintPanel() {
    if (!panel) return;
    var list = snap && Array.isArray(snap.players) ? snap.players : [];
    var action = snap && snap.playerAction;
    var recent = action && Date.now() - action.at < 12000 ? action : null;
    var scan = snap && snap.playersNote && Date.now() - snap.playersNote.at < 8000 ? snap.playersNote : null;
    var sig = (snap && snap.playersReady ? '1' : '0') + '|' + (recent ? recent.id + ':' + recent.phase + ':' + (recent.message || '') : '') + '|' + (scan ? scan.at + ':' + scan.count + ':' + scan.added : '') + '|';
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      sig += p.id + ':' + (p.running ? 1 : 0) + ':' + (p.name || '') + ':' + ((p.icon && p.icon.length) || 0) + ';';
    }
    if (sig === cellsSig) return; cellsSig = sig;
    var grid = panel.querySelector('.mc-player-grid');
    var focusedId = D.activeElement && D.activeElement.dataset && D.activeElement.dataset.id;
    grid.replaceChildren();
    list.forEach(function (p) {
      var button = D.createElement('button'); button.type = 'button'; button.className = 'mc-player-cell'; button.dataset.id = p.id;
      button.title = p.name + (p.running ? ' · 运行中，点击打开窗口' : ' · 点击启动'); button.setAttribute('aria-label', button.title);
      button.disabled = !!(recent && recent.id === p.id && recent.phase === 'launching');
      var icon = D.createElement('span'); icon.className = 'mc-player-icon';
      if (/^data:image\/[\w.+-]+;base64,/i.test(p.icon || '')) {
        var img = D.createElement('img'); img.src = p.icon; img.alt = ''; icon.appendChild(img);
      } else { icon.classList.add('mc-player-icon--text'); icon.textContent = String(p.name || '?').charAt(0); }
      if (p.running) { var dot = D.createElement('span'); dot.className = 'mc-player-dot'; dot.setAttribute('aria-hidden', 'true'); icon.appendChild(dot); }
      var name = D.createElement('span'); name.className = 'mc-player-name'; name.textContent = p.name; button.append(icon, name); grid.appendChild(button);
      if (focusedId === p.id) button.focus({ preventScroll: true });
    });
    var note = panel.querySelector('.mc-player-note');
    note.dataset.error = String(!!(recent && recent.phase === 'error'));
    note.textContent = recent && recent.phase === 'error' ? recent.message : recent && recent.phase === 'launching' ? '正在打开播放器…' : !snap || !snap.playersReady ? '正在扫描本机播放器…' : scan ? ('已刷新 · 发现 ' + scan.count + ' 个播放器' + (scan.added > 0 ? '，新增 ' + scan.added + ' 个' : '')) : list.length ? '自动识别本机播放器 · 绿点表示运行中' : '未发现播放器，点击右上角刷新可重新扫描';
  }
  function check() {
    queued = false; if (disposed || D.hidden) return;
    ensureStyle();
    var target = root();
    if (!target) { scopedCleanup(); remove(brand); brand = null; return; }
    ensureBrand();
    paintWave(target);
    var nav = target.querySelector('.audio-detail-sidebar__navigation');
    if (nav && nav.parentElement) {
      if (!panel) panel = makePanel();
      if (panel.parentElement !== nav.parentElement) nav.insertAdjacentElement('afterend', panel);
      paintPanel(); paintNow();
    } else { remove(panel); panel = null; cellsSig = ''; nowLines = nowMeta = nowState = null; }
    var heading = target.querySelector('.screen-lyrics-panel__header');
    if (heading && heading.getClientRects().length) {
      if (!row) row = makeRow();
      if (row.parentElement !== heading) heading.appendChild(row);
      paintRow();
    } else { remove(row); row = null; }
  }
  function queue() { if (queued || disposed || D.hidden) return; queued = true; W.setTimeout(check, 150); }
  var observer = new MutationObserver(function (changes) {
    if (changes.some(function (c) { return !(c.target.nodeType === 1 && c.target.closest('[data-mc-plugin]')); })) queue();
  });
  observer.observe(D.body, { childList: true, subtree: true });
  var themeObserver = new MutationObserver(updateWaveTheme);
  themeObserver.observe(D.documentElement,{attributes:true,attributeFilter:['theme-mode']});
  var timer = W.setInterval(check, 1000);
  W.addEventListener('hashchange', check); W.addEventListener('mc-bridge-delivery', paintRow); D.addEventListener('visibilitychange', check); W.addEventListener('resize', resizeWave);
  waveMotion.addEventListener('change', check);
  waveThemeMedia.addEventListener('change',updateWaveTheme);
  if (W.__mcBridgeHost) unsub = W.__mcBridgeHost.onSnapshot(function (s) { snap = s; pending = null; check(); });
  api = W.__mcUI = {
    __installed: true, version: 37, check: check, applyAudio: applyAudio,
    inspect: function () { return { scoped: !!root(), row: !!(row && row.isConnected), panel: !!(panel && panel.isConnected), wave: !!(wave && wave.isConnected), wavePlaying: !!(wave && wave.isConnected && wave.dataset.playing === 'true'), waveFrames: waveFrames, waveAnimating: !!waveRaf, waveReduced: waveMotion.matches, waveMaxDrawMs: waveMaxDrawMs, wavePaletteRgb:waveRgb(wavePalettePhase,.56+.25*waveThemeBlend,1.1-.1*waveThemeBlend), wavePalettePhase:wavePalettePhase, wavePaletteGate:wavePaletteGate.inspect(), waveTheme:waveThemeDark ? 'dark' : 'light', waveTime:waveTime, waveParticles:waveParticles.length, waveRipples:6, audioWanted:waveAudioWanted, audioFresh:!!(waveAudio && W.performance.now()-waveAudioAt<600), audioLevels:Object.assign({},waveLevels), audioImpulse:waveImpulse, audioAccents:waveAccents.slice(), waveGeometry: {x:waveCx,y:waveCy,radiusX:waveRadius,radiusY:waveRadius,width:waveWidth,height:waveHeight}, players: snap && snap.players ? snap.players.length : 0, on: on() }; },
    dispose: function () {
      disposed = true; observer.disconnect(); themeObserver.disconnect(); waveThemeMedia.removeEventListener('change',updateWaveTheme); W.clearInterval(timer); W.clearTimeout(pendingTimer); W.clearTimeout(pendingOnlineTimer); W.clearTimeout(cacheTimer);
      W.removeEventListener('hashchange', check); W.removeEventListener('mc-bridge-delivery', paintRow); D.removeEventListener('visibilitychange', check); W.removeEventListener('resize', resizeWave); waveMotion.removeEventListener('change', check); if (unsub) unsub(); scopedCleanup();
      remove(brand); brand = null;
      var style = D.querySelector('style[data-mc-plugin="style"]'); remove(style);
      if (W.__mcUI === api) W.__mcUI = null;
    }
  };
  check();
})();
