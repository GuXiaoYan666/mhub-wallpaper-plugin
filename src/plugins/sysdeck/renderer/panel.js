(function () {
  'use strict';
  // SenseDeck 面板 v1.3：注入到 M HUB 页面的悬浮仪表盘。
  // 全部 DOM 收在 Shadow Root 里，样式与宿主隔离；快照来自 window.__mcDeck。
  // v1.3 变更：
  //   - 新增：农历（月日/干支生肖/节气/节日徽章，主进程纯本地计算）
  //   - 新增：倒数日（面板内联添加/删除，主进程存配置；Electron 无 prompt 故用内联表单）
  //   - 新增：电池状态（笔记本电量/充电，台式机自动隐藏）

  var W = window;
  if (W.__mcDeckPanel && W.__mcDeckPanel.__installed) return;
  var HOST = W.__mcDeckHost;
  if (!HOST || typeof HOST.onSnapshot !== 'function') return;

  // 桌面悬浮窗模式：同一个面板文件跑在独立窗口里，不需要导航芯片。
  var DESKTOP = !!W.__mcDeckDesktop;
  var lastDeckH = 0;

  var state = {
    snap: null,
    collapsed: true,
    enabled: true,
    position: { left: 1, top: 0 },
    theme: 'auto',
    detected: 'light',
    weatherOn: true,
    weatherCity: '',
    docked: true,
    netOn: true,
    diskOn: true,
    pomoOn: true,
    lunarOn: true,
    battOn: true,
    cdOn: true,
    cdFormOpen: false,
    clockTimer: null,
    drag: null
  };

  // ---------- 工具 ----------

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

  function fmtRate(bps) {
    if (bps === null || bps === undefined || !isFinite(bps)) return '--';
    if (bps < 1024) return Math.round(bps) + ' B/s';
    if (bps < 1024 * 1024) return (bps / 1024).toFixed(1) + ' KB/s';
    if (bps < 1024 * 1024 * 1024) return (bps / 1024 / 1024).toFixed(2) + ' MB/s';
    return (bps / 1024 / 1024 / 1024).toFixed(2) + ' GB/s';
  }

  function fmtGB(bytes) {
    if (!isFinite(bytes) || bytes < 0) return '--';
    var gb = bytes / (1024 * 1024 * 1024);
    if (gb >= 100) return Math.round(gb) + ' GB';
    return gb >= 10 ? gb.toFixed(1) + ' GB' : gb.toFixed(2) + ' GB';
  }

  function fmtUptime(sec) {
    if (!isFinite(sec) || sec < 0) return '--';
    var d = Math.floor(sec / 86400);
    var h = Math.floor((sec % 86400) / 3600);
    var m = Math.floor((sec % 3600) / 60);
    if (d > 0) return d + '天' + h + '小时';
    if (h > 0) return h + '小时' + m + '分';
    return m + '分钟';
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function hmOf(ts) {
    var d = new Date(ts);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  // 风力（蒲福风级）与风向：数据源给 km/h 与角度，这里统一成中文。
  var WIND_DIRS = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
  function degDir(deg) {
    if (typeof deg !== 'number' || !isFinite(deg)) return '';
    return WIND_DIRS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
  }
  function beaufort(kph) {
    var t = [1, 6, 12, 20, 29, 39, 50, 62, 75, 89, 103, 118];
    for (var i = 0; i < t.length; i++) if (kph < t[i]) return i;
    return 12;
  }
  function windText(wx) {
    if (!wx || typeof wx.windKph !== 'number' || !isFinite(wx.windKph)) return '';
    var dir = degDir(wx.windDeg);
    return '风 ' + (dir ? dir + ' ' : '') + beaufort(wx.windKph) + '级';
  }

  function escHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function weekCn(d) {
    return ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][d.getDay()];
  }

  // 检测宿主页面明暗：采样 body/html 的背景色亮度。M HUB 是浅色界面 → 默认 light。
  function detectPageTheme() {
    try {
      var els = [document.body, document.documentElement];
      for (var i = 0; i < els.length; i++) {
        if (!els[i]) continue;
        var bg = W.getComputedStyle(els[i]).backgroundColor;
        if (!bg || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)') continue;
        var m = bg.match(/(\d+)[\s,]+(\d+)[\s,]+(\d+)/);
        if (m) {
          var lum = (0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3])) / 255;
          return lum > 0.55 ? 'light' : 'dark';
        }
      }
      // CSS 变量兜底（很多应用会定义 --bg / --background）
      var rootStyle = W.getComputedStyle(document.documentElement);
      var v = rootStyle.getPropertyValue('--bg') || rootStyle.getPropertyValue('--background') || '';
      var hex = String(v).trim().match(/^#([0-9a-f]{6})$/i);
      if (hex) {
        var n = parseInt(hex[1], 16);
        var lum2 = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
        return lum2 > 0.55 ? 'light' : 'dark';
      }
    } catch (e) { /* ignore */ }
    return 'light';
  }

  function currentTheme() {
    return state.theme === 'auto' ? state.detected : state.theme;
  }

  function loadColor(pct, light) {
    if (pct >= 85) return '#ff5f6d';
    if (pct >= 60) return '#ffb454';
    return '';
  }

  // 迷你折线：返回 { line, area }
  function sparkPaths(hist, w, h, autoMax) {
    if (!hist || hist.length < 2) return { line: '', area: '' };
    var max = autoMax ? Math.max(1024, Math.max.apply(null, hist) * 1.15) : 100;
    var n = hist.length;
    var step = w / (n - 1);
    var top = 2, bottom = h - 2;
    var pts = [];
    for (var i = 0; i < n; i++) {
      var v = clamp((hist[i] || 0) / max, 0, 1);
      pts.push([(i * step), (bottom - v * (bottom - top))]);
    }
    var line = pts.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ');
    return { line: line, area: '0,' + h + ' ' + line + ' ' + w + ',' + h };
  }

  // ---------- 样式（CSS 变量按主题切换） ----------

  var CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box;font-family:"Segoe UI","Microsoft YaHei UI",system-ui,sans-serif}',
    '.deck,.off{',
    '--fg:#1b1f24;--fg-dim:rgba(27,31,36,.62);--fg-faint:rgba(27,31,36,.42);',
    '--track:rgba(27,31,36,.08);--card:rgba(27,31,36,.035);--line:rgba(27,31,36,.07);',
    '--accent:#4c7dff;--green:#22b07d;--amber:#e0922a;--red:#e5484d;',
    '--btn-bg:rgba(27,31,36,.06);--btn-bd:rgba(27,31,36,.10)}',
    '.dark{',
    '--fg:#eceef2;--fg-dim:rgba(236,238,242,.62);--fg-faint:rgba(236,238,242,.40);',
    '--track:rgba(255,255,255,.10);--card:rgba(255,255,255,.06);--line:rgba(255,255,255,.09);',
    '--accent:#6f9bff;--green:#35c58e;--amber:#f0b25a;--red:#ff6b70;',
    '--btn-bg:rgba(255,255,255,.08);--btn-bd:rgba(255,255,255,.14)}',
    '.deck{position:fixed;width:300px;max-height:calc(100vh - 24px);display:flex;flex-direction:column;',
    'border-radius:22px;overflow:hidden;user-select:none;pointer-events:auto;',
    'background:linear-gradient(152deg,rgba(255,255,255,.82) 0%,rgba(232,242,255,.62) 40%,rgba(190,216,246,.54) 100%);',
    'backdrop-filter:blur(44px) saturate(1.9) brightness(1.05);-webkit-backdrop-filter:blur(44px) saturate(1.9) brightness(1.05);',
    'border:1px solid rgba(255,255,255,.65);',
    'box-shadow:0 26px 64px rgba(12,32,64,.22),0 2px 10px rgba(12,32,64,.08),inset 0 1px 0 rgba(255,255,255,.92),inset 0 -20px 40px rgba(150,195,255,.10);',
    'color:var(--fg);z-index:2147483000;animation:deck-in .4s cubic-bezier(.22,.9,.3,1)}',
    '.deck::before{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;z-index:0;',
    'background:radial-gradient(120% 72% at 10% -6%,rgba(255,255,255,.62) 0%,rgba(255,255,255,0) 58%),',
    'linear-gradient(112deg,rgba(255,255,255,.30) 0%,rgba(255,255,255,0) 36%,rgba(255,255,255,.18) 58%,rgba(255,255,255,0) 86%)}',
    '.deck.dark{background:linear-gradient(152deg,rgba(44,49,60,.80) 0%,rgba(28,32,40,.64) 42%,rgba(26,44,68,.58) 100%);',
    'border-color:rgba(255,255,255,.16);',
    'box-shadow:0 26px 68px rgba(0,0,0,.50),inset 0 1px 0 rgba(255,255,255,.10),inset 0 -20px 40px rgba(70,120,200,.10)}',
    '.deck.dark::before{background:radial-gradient(120% 72% at 10% -6%,rgba(255,255,255,.16) 0%,rgba(255,255,255,0) 60%),',
    'linear-gradient(112deg,rgba(255,255,255,.10) 0%,rgba(255,255,255,0) 40%,rgba(255,255,255,.06) 62%,rgba(255,255,255,0) 88%)}',
    '@keyframes deck-in{from{opacity:0;transform:translateY(-8px) scale(.985)}to{opacity:1;transform:none}}',
    '.deck:hover{box-shadow:0 30px 72px rgba(12,32,64,.26),0 3px 12px rgba(12,32,64,.09),inset 0 1px 0 rgba(255,255,255,.95),inset 0 -20px 40px rgba(150,195,255,.12)}',
    '.deck.dark:hover{box-shadow:0 30px 76px rgba(0,0,0,.56),inset 0 1px 0 rgba(255,255,255,.12)}',
    '.head,.body{position:relative;z-index:1}',
    '.deck.desktop{left:10px;top:10px;max-height:calc(100vh - 20px)}',
    '.deck.desktop .head{-webkit-app-region:drag;cursor:default}',
    '.deck.desktop .head:active{cursor:default}',
    '.deck.desktop .btn,.deck.desktop .body{-webkit-app-region:no-drag}',
    '.head{display:flex;align-items:center;gap:8px;padding:13px 14px 9px;cursor:grab;flex:0 0 auto}',
    '.head:active{cursor:grabbing}',
    '.logo{width:16px;height:16px;border-radius:5px;flex:0 0 auto;position:relative;background:#1b1f24}',
    '.logo::after{content:"";position:absolute;inset:4px;border-radius:2px;border:1.5px solid rgba(255,255,255,.9)}',
    '.dark .logo{background:#f2f4f7}',
    '.dark .logo::after{border-color:rgba(26,29,36,.9)}',
    '.title{font-size:12px;font-weight:600;letter-spacing:.2px;opacity:.9}',
    '.spacer{flex:1}',
    '.btn{width:22px;height:22px;border-radius:50%;border:0;background:transparent;',
    'color:inherit;opacity:.52;font-size:11px;line-height:1;display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0;',
    'transition:opacity .15s,background .15s}',
    '.btn:hover{opacity:1;background:var(--btn-bg)}',
    '.btn:active{opacity:.9}',
    '.body{padding:2px 14px 12px;overflow-y:auto;overflow-x:hidden;flex:1 1 auto;min-height:0}',
    '.body::-webkit-scrollbar{width:0;height:0}',
    '.clock{padding:8px 2px 6px;display:flex;align-items:flex-end;gap:10px}',
    '.clock-main{line-height:1}',
    '.clock-time{font-size:31px;font-weight:300;letter-spacing:.8px;font-variant-numeric:tabular-nums;line-height:1}',
    '.clock-sec{font-size:12px;font-weight:400;opacity:.42;margin-left:4px}',
    '.clock-right{margin-left:auto;text-align:right;padding-bottom:3px}',
    '.clock-date{font-size:10.5px;color:var(--fg-dim);white-space:nowrap}',
    '.clock-week{display:inline-block;margin-top:4px;font-size:9px;padding:1.5px 7px;border-radius:999px;',
    'background:var(--card);border:1px solid var(--line);color:var(--fg-dim);letter-spacing:.6px}',
    '.lunar-row{display:flex;align-items:center;gap:6px;margin:2px 2px 10px;font-size:10px;color:var(--fg-faint);min-height:14px}',
    '.lunar-year{color:var(--fg-faint)}',
    '.lunar-badge{margin-left:auto;font-size:9px;padding:1px 7px;border-radius:999px;background:var(--card);border:1px solid var(--line);color:var(--fg-dim);white-space:nowrap;font-weight:600}',
    '.lunar-badge.fest{background:rgba(229,72,77,.10);border-color:rgba(229,72,77,.18);color:#d93a3f}',
    '.dark .lunar-badge.fest{background:rgba(255,107,112,.16);border-color:rgba(255,107,112,.24);color:#ff9094}',
    '.m{margin-top:10px}',
    '.m-head{display:flex;align-items:baseline;gap:6px;font-size:10.5px}',
    '.m-label{color:var(--fg-dim);letter-spacing:.2px}',
    '.m-val{margin-left:auto;font-variant-numeric:tabular-nums;font-size:12px;font-weight:600;transition:color .4s}',
    '.m-sub{font-size:9.5px;color:var(--fg-faint);font-variant-numeric:tabular-nums}',
    '.bar{height:4px;border-radius:999px;background:var(--track);margin-top:6px;overflow:hidden}',
    '.fill{height:100%;border-radius:999px;width:0;transition:width .7s cubic-bezier(.3,.8,.3,1),background .5s ease}',
    '.spark{display:block;margin-top:5px;opacity:.9}',
    '.fill-cpu{background:var(--accent)}',
    '.fill-mem{background:#8a7bff}',
    '.spark-cpu{stroke:var(--accent);stroke-width:1.4;fill:none}',
    '.spark-mem{stroke:#8a7bff;stroke-width:1.4;fill:none}',
    '.spark-area-cpu{fill:url(#sd-g-cpu);opacity:.7}',
    '.spark-area-mem{fill:url(#sd-g-mem);opacity:.7}',
    '.spark-dl{stroke:var(--green);stroke-width:1.3;fill:none}',
    '.spark-ul{stroke:var(--amber);stroke-width:1.3;fill:none}',
    '.spark-area-dl{fill:url(#sd-g-dl);opacity:.8}',
    '.spark-area-ul{fill:url(#sd-g-ul);opacity:.8}',
    '.row2{display:flex;gap:8px}',
    '.row2 .m{flex:1;min-width:0;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:8px 10px 8px;margin-top:10px}',
    '.row2 .spark{margin-top:4px}',
    '.disks{margin-top:10px}',
    '.disk-row{display:flex;align-items:center;gap:8px;margin-top:6px;font-size:10px}',
    '.disk-row:first-child{margin-top:0}',
    '.disk-name{font-weight:600;color:var(--fg-dim);width:18px}',
    '.disk-bar{flex:1;height:3px;border-radius:999px;background:var(--track);overflow:hidden}',
    '.disk-fill{height:100%;border-radius:999px;background:var(--accent);transition:width .7s ease}',
    '.disk-fill.hot{background:var(--amber)}',
    '.disk-info{color:var(--fg-faint);font-variant-numeric:tabular-nums;width:74px;text-align:right}',
    '.wx{margin-top:10px;padding:11px 12px 10px;border-radius:14px;cursor:pointer;',
    'background:var(--card);border:1px solid var(--line);transition:border-color .2s,background .2s}',
    '.wx:hover{border-color:var(--btn-bd);background:rgba(27,31,36,.05)}',
    '.dark .wx:hover{background:rgba(255,255,255,.08)}',
    '.wx-main{display:flex;align-items:center;gap:10px}',
    '.wx-icon{width:36px;height:36px;border-radius:12px;display:flex;align-items:center;justify-content:center;',
    'background:rgba(27,31,36,.045);color:var(--fg-dim);flex:0 0 auto}',
    '.wx-info{flex:1;min-width:0}',
    '.wx-line1{display:flex;align-items:baseline;gap:6px}',
    '.wx-temp{font-size:19px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:.3px;line-height:1.1}',
    '.wx-text{font-size:10.5px;color:var(--fg-dim);white-space:nowrap}',
    '.wx-range{margin-left:auto;font-size:9.5px;color:var(--fg-faint);font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.wx-city{font-size:10px;color:var(--fg-dim);margin-top:3px;cursor:text;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.wx-meta{font-size:9.5px;color:var(--fg-faint);margin-top:2px;display:flex;gap:7px;flex-wrap:wrap;line-height:1.45}',
    '.wx-set{display:flex;align-items:center;gap:5px;margin-top:7px}',
    '.wx-city-in{flex:1;min-width:0;height:24px;border-radius:7px;border:1px solid var(--line);background:rgba(255,255,255,.7);color:var(--fg);font-size:10.5px;padding:0 8px;outline:none}',
    '.dark .wx-city-in{background:rgba(255,255,255,.08)}',
    '.wx-city-in:focus{border-color:var(--accent)}',
    '.wx-set .btn{width:22px;height:24px;border-radius:7px;background:var(--btn-bg)}',
    '.wx-fc{display:flex;gap:6px;margin-top:9px;padding-top:8px;border-top:1px solid var(--line)}',
    '.fc-item{flex:1;text-align:center;font-size:9.5px;color:var(--fg-dim);min-width:0}',
    '.fc-icon{height:15px;line-height:1;color:var(--fg-dim);display:flex;align-items:center;justify-content:center;margin-top:2px}',
    '.fc-temp{font-variant-numeric:tabular-nums;margin-top:2px;white-space:nowrap;font-size:10px}',
    '.fc-day{color:var(--fg-faint);font-size:9px;white-space:nowrap}',
    '.wx-stale{margin-top:7px;font-size:9px;color:var(--amber);display:flex;align-items:center;gap:5px}',
    '.cd{margin-top:10px;padding:9px 11px 9px;border-radius:14px;background:var(--card);border:1px solid var(--line)}',
    '.cd-head{display:flex;align-items:center;gap:6px;font-size:10.5px}',
    '.cd-list{margin-top:4px}',
    '.cd-row{display:flex;align-items:center;gap:7px;font-size:10.5px;padding:3px 0}',
    '.cd-ico{width:5px;height:5px;border-radius:50%;background:var(--fg-faint);font-size:0;overflow:hidden;flex:0 0 auto}',
    '.cd-name{color:var(--fg-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.cd-days{margin-left:auto;font-weight:600;font-variant-numeric:tabular-nums;color:var(--accent);white-space:nowrap}',
    '.cd-days.soon{color:var(--red)}',
    '.cd-days.past{color:var(--fg-faint);font-weight:400}',
    '.cd-del{width:16px;height:16px;font-size:9px;flex:0 0 auto}',
    '.cd-form{display:flex;gap:6px;margin-top:7px;align-items:center}',
    '.cd-form input{height:25px;border-radius:8px;border:1px solid var(--line);background:rgba(255,255,255,.6);color:var(--fg);font-size:10.5px;padding:0 8px;outline:none}',
    '.dark .cd-form input{background:rgba(255,255,255,.06)}',
    '.cd-form input:focus{border-color:var(--accent)}',
    '.cd-form .in-name{flex:1;min-width:0}',
    '.cd-form .in-date{flex:0 0 118px}',
    '.cd-form .btn{width:auto;padding:0 9px;height:25px;border-radius:8px;font-size:10px;flex:0 0 auto;background:var(--btn-bg)}',
    '.pomo{display:flex;align-items:center;gap:9px;margin-top:10px;padding:9px 11px;border-radius:14px;',
    'background:var(--card);border:1px solid var(--line)}',
    '.pomo-time{font-size:16px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:.4px;min-width:50px}',
    '.pomo-time.work{color:var(--accent)}',
    '.pomo-time.break{color:var(--green)}',
    '.pomo-meta{flex:1;font-size:9.5px;color:var(--fg-faint);line-height:1.5}',
    '.pomo-phase{font-size:10.5px;font-weight:600;color:var(--fg-dim)}',
    '.pomo-btns{display:flex;gap:5px}',
    '.pomo-btns .btn{width:24px;background:rgba(27,31,36,.05)}',
    '.dark .pomo-btns .btn{background:rgba(255,255,255,.08)}',
    '.foot{display:flex;align-items:center;gap:8px;margin-top:10px;padding-top:9px;border-top:1px solid var(--line);font-size:9.5px;color:var(--fg-faint)}',
    '.foot .btn{width:auto;padding:0 8px;height:18px;border-radius:6px;font-size:9.5px}',
    '.credit{margin-top:6px;font-size:9px;line-height:1.3;text-align:right;color:var(--fg-faint);opacity:.75;letter-spacing:.2px}',
    '.off{position:fixed;padding:8px 14px;border-radius:999px;cursor:pointer;font-size:10.5px;z-index:2147483000;user-select:none;',
    'pointer-events:auto;background:rgba(255,255,255,.9);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);',
    'border:1px solid rgba(27,31,36,.07);box-shadow:0 10px 28px rgba(23,30,52,.14);color:var(--fg);opacity:.8;transition:opacity .2s}',
    '.off:hover{opacity:1}',
    '.off.dark{background:rgba(26,29,36,.9);border-color:rgba(255,255,255,.10);box-shadow:0 10px 28px rgba(0,0,0,.4)}'
  ].join('');

  // ---------- DOM ----------

  function sparkSvg(col, areaCls, lineCls, w, h, gid) {
    return '<svg class="spark" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">' +
      '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="' + col + '" stop-opacity=".26"/>' +
      '<stop offset="1" stop-color="' + col + '" stop-opacity="0"/>' +
      '</linearGradient></defs>' +
      '<polygon class="' + areaCls + '" points=""/>' +
      '<polyline class="' + lineCls + '" points=""/></svg>';
  }

  // 天气图标：用线性 SVG 代替 emoji，和 M HUB 的图标语言保持一致
  function wxSvg(icon, size) {
    var s = size || 20;
    var key = String(icon || '');
    var g;
    if (/雷|⛈/.test(key)) {
      g = '<path d="M7 14.6h10a3.4 3.4 0 0 0 .4-6.76A4.6 4.6 0 0 0 8.3 6.7 3.8 3.8 0 0 0 7 14.6z"/><path d="M12.8 14.8l-2.4 3.4h2.5l-1 3"/>';
    } else if (/雪|❄/.test(key)) {
      g = '<path d="M7 13.6h10a3.4 3.4 0 0 0 .4-6.76A4.6 4.6 0 0 0 8.3 5.7 3.8 3.8 0 0 0 7 13.6z"/><path d="M8.6 17v1.6M12 17v1.6M15.4 17v1.6"/>';
    } else if (/雨|🌧|🌦/.test(key)) {
      g = '<path d="M7 13.6h10a3.4 3.4 0 0 0 .4-6.76A4.6 4.6 0 0 0 8.3 5.7 3.8 3.8 0 0 0 7 13.6z"/><path d="M8.6 16.6l-.7 2.2M12 16.6l-.7 2.2M15.4 16.6l-.7 2.2"/>';
    } else if (/雾|霾|🌫/.test(key)) {
      g = '<path d="M6 8.5h8.6M8 11.5h10M5.6 14.5h9M8.4 17.5h8"/>';
    } else if (/阴|☁|多云|⛅|🌤/.test(key)) {
      g = '<circle cx="8.6" cy="8" r="2.3"/><path d="M8.6 3.6v1.2M4.2 8h1.2M4.9 4.3l.85.85"/>' +
        '<path d="M9.6 19h7.6a3.1 3.1 0 0 0 .4-6.17A4.2 4.2 0 0 0 9.9 12 3.4 3.4 0 0 0 9.6 19z"/>';
    } else if (/晴|☀|🌞/.test(key)) {
      g = '<circle cx="12" cy="12" r="4.1"/><path d="M12 2.8v2.1M12 19.1v2.1M2.8 12h2.1M19.1 12h2.1M5.4 5.4l1.5 1.5M17.1 17.1l1.5 1.5M18.6 5.4l-1.5 1.5M6.9 17.1l-1.5 1.5"/>';
    } else if (/夜|🌙|月/.test(key)) {
      g = '<path d="M15.7 4.4a7.6 7.6 0 1 0 3.9 11.4 6 6 0 0 1-3.9-11.4z"/>';
    } else {
      g = '<path d="M10 4.2a2 2 0 0 1 4 0v8.9a4.1 4.1 0 1 1-4 0z"/><circle cx="12" cy="16.4" r="1.3" fill="currentColor" stroke="none"/>';
    }
    return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + g + '</svg>';
  }

  var root = document.createElement('div');
  root.id = 'mc-sysdeck-root';
  root.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483000;pointer-events:none;';
  (document.body || document.documentElement).appendChild(root);
  var sr = root.attachShadow ? root.attachShadow({ mode: 'closed' }) : root.createShadowRoot();
  var style = document.createElement('style');
  style.textContent = CSS;
  sr.appendChild(style);

  var deck = document.createElement('div');
  deck.className = 'deck';
  deck.innerHTML =
    '<div class="head">' +
      '<div class="logo"></div>' +
      '<div class="title">SenseDeck</div>' +
      '<div class="spacer"></div>' +
      '<button class="btn theme-btn" title="主题：跟随界面">◐</button>' +
      '<button class="btn wx-refresh" title="刷新天气">⟳</button>' +
      '<button class="btn deck-pop" title="在桌面显示悬浮窗"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5"/></svg></button>' +
      '<button class="btn deck-min" title="收起">—</button>' +
    '</div>' +
    '<div class="body">' +
      '<div class="clock">' +
        '<div class="clock-main"><div class="clock-time"><span id="sd-hm">--:--</span><span class="clock-sec" id="sd-sec"></span></div></div>' +
        '<div class="clock-right">' +
          '<div class="clock-date" id="sd-date"></div>' +
          '<span class="clock-week" id="sd-week"></span>' +
        '</div>' +
      '</div>' +
      '<div class="lunar-row m-lunar">' +
        '<span class="lunar-text">农历 --</span>' +
        '<span class="lunar-year"></span>' +
        '<span class="lunar-badge" style="display:none"></span>' +
      '</div>' +
      '<div class="m m-cpu">' +
        '<div class="m-head"><span class="m-label">CPU</span><span class="m-sub m-cpu-cores"></span><span class="m-val m-cpu-val">--%</span></div>' +
        '<div class="bar"><div class="fill fill-cpu"></div></div>' +
        sparkSvg('#4c7dff', 'spark-area-cpu', 'spark-cpu', 252, 24, 'sd-g-cpu') +
      '</div>' +
      '<div class="m m-mem">' +
        '<div class="m-head"><span class="m-label">内存</span><span class="m-sub m-mem-sub"></span><span class="m-val m-mem-val">--%</span></div>' +
        '<div class="bar"><div class="fill fill-mem"></div></div>' +
        sparkSvg('#8a7bff', 'spark-area-mem', 'spark-mem', 252, 24, 'sd-g-mem') +
      '</div>' +
      '<div class="disks m-disks"></div>' +
      '<div class="row2 m-net">' +
        '<div class="m">' +
          '<div class="m-head"><span class="m-label">↓ 下行</span><span class="m-val m-dl-val">--</span></div>' +
          sparkSvg('#22c58b', 'spark-area-dl', 'spark-dl', 98, 22, 'sd-g-dl') +
        '</div>' +
        '<div class="m">' +
          '<div class="m-head"><span class="m-label">↑ 上行</span><span class="m-val m-ul-val">--</span></div>' +
          sparkSvg('#ffb454', 'spark-area-ul', 'spark-ul', 98, 22, 'sd-g-ul') +
        '</div>' +
      '</div>' +
      '<div class="wx m-wx" title="点击刷新天气">' +
        '<div class="wx-main">' +
          '<div class="wx-icon">🌡️</div>' +
          '<div class="wx-info">' +
            '<div class="wx-line1"><span class="wx-temp">--°</span><span class="wx-text">获取中…</span><span class="wx-range"></span></div>' +
            '<div class="wx-city" title="点击设置城市"></div>' +
            '<div class="wx-meta"></div>' +
            '<div class="wx-set" style="display:none">' +
              '<input class="wx-city-in" maxlength="20" placeholder="城市，如 长沙">' +
              '<button class="btn wx-city-save" title="保存">✓</button>' +
              '<button class="btn wx-city-cancel" title="取消">×</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="wx-fc" style="display:none"></div>' +
        '<div class="wx-stale" style="display:none"></div>' +
      '</div>' +
      '<div class="cd m-cd">' +
        '<div class="cd-head"><span class="m-label">倒数日</span><div class="spacer"></div>' +
          '<button class="btn cd-add" title="添加倒数日">＋</button>' +
        '</div>' +
        '<div class="cd-form" style="display:none">' +
          '<input class="in-name" maxlength="20" placeholder="名称（如：生日）">' +
          '<input class="in-date" type="date">' +
          '<button class="btn cd-save" title="保存">✓</button>' +
          '<button class="btn cd-cancel" title="取消">×</button>' +
        '</div>' +
        '<div class="cd-list"></div>' +
      '</div>' +
      '<div class="pomo m-pomo">' +
        '<div class="pomo-time">25:00</div>' +
        '<div class="pomo-meta"><div class="pomo-phase">番茄钟</div><div class="pomo-sub">专注 ' + 25 + ' 分钟</div></div>' +
        '<div class="pomo-btns">' +
          '<button class="btn pomo-play" title="开始/暂停">▶</button>' +
          '<button class="btn pomo-reset" title="重置">↺</button>' +
        '</div>' +
      '</div>' +
      '<div class="foot">' +
        '<span class="f-batt" style="display:none"></span>' +
        '<span class="f-uptime">开机 --</span>' +
        '<span class="spacer"></span>' +
        '<span class="f-host"></span>' +
        '<button class="btn deck-off" title="停用面板">停用</button>' +
      '</div>' +
      '<div class="credit">SenseDeck 1.5.1 · 作者 顾小颜</div>' +
    '</div>';
  sr.appendChild(deck);

  // ---------- 顶部导航芯片（放进 M HUB 导航组，和「神光同步」等导航项并排） ----------

  var PULSE_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M2.5 12h3.6l2.4-6.2L12 18.4l2.6-6.4h6.9"/></svg>';

  var CHIP_CSS =
    '#sd-chip{box-sizing:border-box;display:flex;align-items:center;white-space:nowrap;cursor:pointer;' +
    'user-select:none;font:inherit;color:inherit;background:transparent;flex:0 0 auto;' +
    'width:auto!important;max-width:none!important;min-width:0;overflow:visible!important;' +
    'transition:background .16s,box-shadow .16s,color .16s;-webkit-app-region:no-drag;pointer-events:auto}' +
    '#sd-chip .sd-ico{display:flex;align-items:center}' +
    '#sd-chip .sd-ico svg{display:block}' +
    '#sd-chip .sd-meta{display:flex;align-items:center;gap:7px;margin-left:8px;font-size:14px}' +
    '#sd-chip .sd-sep{width:1px;height:13px;border-radius:1px;background:currentColor;opacity:.16;flex:0 0 auto}' +
    '#sd-chip .sd-time{font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:.3px;opacity:.85}' +
    '#sd-chip .sd-wx{display:flex;align-items:center;gap:3px;opacity:.85}' +
    '#sd-chip .sd-wx svg{display:block}' +
    '#sd-chip .sd-cpu{font-variant-numeric:tabular-nums;opacity:.6}' +
    '#sd-chip:hover{background:rgba(255,255,255,.5);border-radius:999px}' +
    '#sd-chip.on{background:rgba(255,255,255,.82);border-radius:999px;box-shadow:0 1px 4px rgba(23,30,52,.06)}' +
    '#sd-chip.dark{color:#d7dbe2}' +
    '#sd-chip.dark:hover{background:rgba(255,255,255,.10)}' +
    '#sd-chip.dark.on{background:rgba(255,255,255,.16)}' +
    '#sd-chip.sd-float{position:fixed;z-index:2147483000;height:38px;padding:0 14px;border-radius:19px;' +
    'gap:8px;font:14px/1 "Segoe UI","Microsoft YaHei UI",system-ui,sans-serif;color:#3d434b}' +
    '#sd-chip.sd-float .sd-meta{margin-left:0}' +
    '#sd-chip[hidden]{display:none!important}' +
    '#sd-chip-bg{position:fixed;z-index:2147482998;pointer-events:none;opacity:0;' +
    'background:rgba(255,255,255,.55);box-sizing:border-box;' +
    'backdrop-filter:blur(24px) saturate(1.1);-webkit-backdrop-filter:blur(24px) saturate(1.1);' +
    '-webkit-app-region:no-drag;transition:opacity .15s}';
  var chipStyle = document.getElementById('sd-chip-style');
  if (!chipStyle) {
    chipStyle = document.createElement('style');
    chipStyle.id = 'sd-chip-style';
    (document.head || document.documentElement).appendChild(chipStyle);
  }
  chipStyle.textContent = CHIP_CSS;

  // 先放一个占位芯片，等找到 M HUB 导航项后再克隆成原生导航项。
  var pill = document.createElement('span');
  pill.id = 'sd-chip';
  pill.className = 'sd-chip sd-float';
  pill.innerHTML = '<span class="sd-ico">' + PULSE_SVG + '</span><span class="sd-txt">状态</span>' +
    '<span class="sd-meta"><span class="sd-sep"></span><span class="sd-time">--:--</span>' +
    '<span class="sd-wx"><span class="sd-wx-ico"></span><span class="sd-wx-t">--°</span></span>' +
    '<span class="sd-cpu">--%</span></span>';
  (document.body || document.documentElement).appendChild(pill);
  var chipBg = document.createElement('div');
  chipBg.id = 'sd-chip-bg';
  (document.body || document.documentElement).appendChild(chipBg);

  var off = document.createElement('div');
  off.className = 'off';
  off.textContent = 'SenseDeck 已停用 · 点击启用';
  sr.appendChild(off);

  var q = function (cls) { return sr.querySelector(cls); };
  var qp = function (cls) { return pill.querySelector(cls); };
  var el = {
    deck: deck, pill: pill, off: off,
    time: q('#sd-hm'), sec: q('#sd-sec'), date: q('#sd-date'), week: q('#sd-week'),
    lunar: q('.m-lunar'), lunarText: q('.lunar-text'), lunarYear: q('.lunar-year'),
    lunarBadge: q('.lunar-badge'),
    cpuVal: q('.m-cpu-val'), cpuCores: q('.m-cpu-cores'),
    cpuFill: q('.fill-cpu'),
    cpuSparkLine: q('.spark-cpu'), cpuSparkArea: q('.spark-area-cpu'),
    memVal: q('.m-mem-val'), memSub: q('.m-mem-sub'),
    memFill: q('.fill-mem'),
    memSparkLine: q('.spark-mem'), memSparkArea: q('.spark-area-mem'),
    disks: q('.m-disks'),
    netRow: q('.m-net'), dlVal: q('.m-dl-val'), ulVal: q('.m-ul-val'),
    dlSparkLine: q('.spark-dl'), dlSparkArea: q('.spark-area-dl'),
    ulSparkLine: q('.spark-ul'), ulSparkArea: q('.spark-area-ul'),
    wx: q('.m-wx'), wxIcon: q('.wx-icon'), wxTemp: q('.wx-temp'),
    wxText: q('.wx-text'), wxRange: q('.wx-range'), wxCity: q('.wx-city'), wxFc: q('.wx-fc'),
    wxMeta: q('.wx-meta'), wxStale: q('.wx-stale'),
    wxSet: q('.wx-set'), wxCityIn: q('.wx-city-in'), wxCitySave: q('.wx-city-save'), wxCityCancel: q('.wx-city-cancel'),
    pomo: q('.m-pomo'), pomoTime: q('.pomo-time'), pomoPhase: q('.pomo-phase'),
    pomoSub: q('.pomo-sub'), pomoPlay: q('.pomo-play'), pomoReset: q('.pomo-reset'),
    cd: q('.m-cd'), cdList: q('.cd-list'), cdAdd: q('.cd-add'),
    cdForm: q('.cd-form'), cdName: q('.in-name'), cdDate: q('.in-date'),
    cdSave: q('.cd-save'), cdCancel: q('.cd-cancel'),
    themeBtn: q('.theme-btn'),
    wxRefresh: q('.wx-refresh'), deckMin: q('.deck-min'), deckOff: q('.deck-off'), deckPop: q('.deck-pop'),
    fUptime: q('.f-uptime'), fHost: q('.f-host'), fBatt: q('.f-batt'),
    pillTime: qp('.sd-time'), pillDot: null, pillCpu: qp('.sd-cpu'),
    pillWx: qp('.sd-wx'), pillWxIco: qp('.sd-wx-ico'), pillWxT: qp('.sd-wx-t')
  };

  // ---------- 定位 ----------

  var PANEL_W = 300;
  var PANEL_H_EST = 620;
  var NAV_TOP = 62; // 顶部导航栏高度：面板永远落在导航下方，视觉上挂在导航上

  // 把芯片摆到导航栏「Friends」右侧，和导航项排在一起，而不是压在右侧图标上。
  var chipAnchor = null;
  function findChipAnchor() {
    try {
      var all = document.querySelectorAll('div,span,a,button');
      for (var i = 0; i < all.length; i++) {
        var n = all[i];
        if (n.children.length) continue;
        if (!/^friends$/i.test((n.textContent || '').trim())) continue;
        var r = n.getBoundingClientRect();
        if (r.width > 20 && r.height > 10 && r.height < 60 && r.top < 100) return n;
      }
    } catch (_) { /* 页面结构变化时退回默认位置 */ }
    return null;
  }

  function bgAlpha(color) {
    if (!color || color === 'transparent') return 0;
    var m = String(color).match(/rgba?\(([^)]+)\)/);
    if (!m) return 0;
    var p = m[1].split(',');
    if (p.length < 3) return 0;
    return p.length >= 4 ? parseFloat(p[3]) : 1;
  }

  // 量出「Friends」导航项的真实视觉尺寸：优先找带底色的胶囊，其次按导航组高度估算。
  function measureNav(anchor) {
    var ar = anchor.getBoundingClientRect();
    var item = null;
    var group = null;
    var n = anchor;
    for (var i = 0; i < 6 && n && n !== document.body; i++) {
      var r = n.getBoundingClientRect();
      if (r.top > 140 || r.height > 120) break;
      if (!item && r.height >= 24 && r.height <= 60 && r.width >= 36 && r.width <= 320 &&
        bgAlpha(W.getComputedStyle(n).backgroundColor) >= 0.05) {
        item = r;
      }
      if (!group && r.width >= 220 && r.width <= 900 && r.height >= 28 && r.height <= 80) {
        group = r;
      }
      n = n.parentElement;
    }
    if (!item) {
      n = anchor;
      for (var j = 0; j < 6 && n && n !== document.body; j++) {
        var rr = n.getBoundingClientRect();
        if (rr.height >= 26 && rr.height <= 58 && rr.width >= 36 && rr.width <= 260) { item = rr; break; }
        n = n.parentElement;
      }
    }
    var h = item ? item.height : (group ? group.height - 6 : 38);
    h = clamp(h || 38, 28, 48);
    var centerY = item ? (item.top + item.height / 2)
      : (group ? (group.top + group.height / 2) : (ar.top + ar.height / 2));
    // 右边界优先用整个导航组的右缘，芯片才会排在白色导航组外面而不是压在组内留白上。
    var right = Math.max(ar.right, item ? item.right : 0, group ? group.right : 0);
    return { height: Math.round(h), centerY: centerY, right: right };
  }

  var chipGroup = null;
  var chipFloat = false;
  var chipGroupFailed = false;

  // 不依赖「Friends」文字：按结构在页面顶部找分段导航组件。
  // 有些用户没有 Friends 入口，甚至导航项数量不同，但组件本身还在。
  function findNavGroupByStructure() {
    var list = [];
    try {
      list = document.querySelectorAll('du-segmented-button, .app-header__primary-group, .app-header__action-group');
    } catch (_) { return null; }
    var best = null;
    var bestScore = -1;
    var host = null;
    var hostScore = -1;
    var vw = W.innerWidth || 1280;
    for (var i = 0; i < list.length; i++) {
      var n = list[i];
      var r = n.getBoundingClientRect();
      if (r.width < 160 || r.width > Math.max(900, vw * 0.9)) continue;
      if (r.height < 28 || r.height > 90) continue;
      if (r.top < -4 || r.top > 150) continue;
      var score = r.width * r.height;
      if (String(n.tagName || '').indexOf('-') > 0) score += 2000000;
      if (n.classList && n.classList.contains('app-header__primary-group')) score += 1000000;
      if (n.classList && n.classList.contains('app-header__action-group')) score -= 500000;
      if (score > bestScore) { bestScore = score; best = n; }
      // 能真正承载芯片的（有 Shadow 分段容器的）优先
      try {
        var sr = n.shadowRoot;
        if (sr && (sr.querySelector('.du-segmented-button__rail') || sr.querySelector('[part="rail"]'))) {
          if (score > hostScore) { hostScore = score; host = n; }
        }
      } catch (_) { /* ignore */ }
    }
    return host || best;
  }

  // 找 M HUB 顶部导航组：优先按「Friends」文字向上找，找不到就按结构找。
  function findNavGroup() {
    if (chipGroup && chipGroup.isConnected) return chipGroup;
    if (!chipAnchor || !chipAnchor.isConnected) chipAnchor = findChipAnchor();
    if (chipAnchor) {
      var n = chipAnchor;
      var comp = null;
      var wide = null;
      for (var i = 0; i < 7 && n && n !== document.body; i++) {
        var r = n.getBoundingClientRect();
        if (r.top < 140 && r.height >= 28 && r.height <= 90 && r.width >= 160) {
          if (!comp && String(n.tagName || '').indexOf('-') > 0) comp = n;
          if (!wide && r.width >= 220 && r.width <= 900) wide = n;
        }
        n = n.parentElement;
      }
      if (comp || wide) {
        chipGroup = comp || wide;
        chipGroupFailed = false;
        return chipGroup;
      }
    }
    chipGroup = findNavGroupByStructure();
    if (chipGroup) chipGroupFailed = false;
    return chipGroup;
  }

  var SEG_STYLE_ID = 'sd-chip-shadow-style';

  // M HUB 导航是 du-segmented-button：导航项由 Shadow DOM 里的
  // <button part="item"><slot/></button> 渲染，light DOM 里追加的节点会被框架清掉。
  // 所以直接在 Shadow 里建第 5 个 button，把芯片塞进去，并在同一棵 Shadow 里注入样式。
  function ensureSegment(group) {
    var sr = null;
    try { sr = group.shadowRoot; } catch (_) { sr = null; }
    if (!sr) return false;
    var rail = null;
    try {
      rail = sr.querySelector('.du-segmented-button__rail') || sr.querySelector('[part="rail"]');
    } catch (_) { rail = null; }
    if (!rail) return false;
    try {
      if (!sr.querySelector('#' + SEG_STYLE_ID)) {
        var st = document.createElement('style');
        st.id = SEG_STYLE_ID;
        st.textContent = CHIP_CSS;
        sr.appendChild(st);
      }
    } catch (_) { /* ignore */ }
    var btn = null;
    try { btn = sr.querySelector('button[data-value="sysdeck"]'); } catch (_) { btn = null; }
    if (!btn || !btn.isConnected) {
      try {
        btn = document.createElement('button');
        btn.setAttribute('part', 'item');
        btn.setAttribute('type', 'button');
        btn.setAttribute('role', 'tab');
        btn.className = 'du-segmented-button__item is-content-icon-text';
        btn.setAttribute('data-value', 'sysdeck');
        btn.setAttribute('aria-label', '状态');
        btn.setAttribute('aria-selected', 'false');
        rail.appendChild(btn);
      } catch (_) { return false; }
    }
    try {
      if (pill.parentNode !== btn) btn.appendChild(pill);
    } catch (_) { return false; }
    return true;
  }

  var chipGuardSet = typeof WeakSet === 'function' ? new WeakSet() : null;

  // 阻止 M HUB 的导航组件把芯片点击当成切换 tab。
  function bindChipGuard(group) {
    if (!group || !group.addEventListener) return;
    if (chipGuardSet) {
      if (chipGuardSet.has(group)) return;
      chipGuardSet.add(group);
    } else if (group.__sdChipGuard) {
      return;
    } else {
      try { group.__sdChipGuard = true; } catch (_) { /* ignore */ }
    }
    group.addEventListener('click', function (e) {
      var path = e.composedPath ? e.composedPath() : [];
      var hit = false;
      for (var i = 0; i < path.length; i++) {
        if (path[i] === pill) { hit = true; break; }
      }
      if (!hit) return;
      try {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      } catch (_) { /* ignore */ }
    }, true);
  }

  function placeChip() {
    if (DESKTOP) {
      el.pill.style.display = 'none';
      chipBg.style.opacity = '0';
      return;
    }
    var group = findNavGroup();
    if (group && !chipGroupFailed) {
      if (ensureSegment(group)) {
        bindChipGuard(group);
        var gr = group.getBoundingClientRect();
        var pr = pill.getBoundingClientRect();
        if (pr.width > 10 && pr.right > gr.right + 4) {
          // 导航组宽度固定、把芯片顶出去了：按芯片宽度撑开导航组，胶囊会跟着变长。
          var base = parseFloat(group.getAttribute('data-sd-w')) || 0;
          if (!base) {
            base = gr.width;
            group.setAttribute('data-sd-w', String(Math.round(base)));
          }
          group.style.width = Math.round(base + (pr.right - gr.right) + 10) + 'px';
        }
        chipFloat = false;
        pill.classList.remove('sd-float');
        chipBg.style.opacity = '0';
        pill.style.left = pill.style.top = pill.style.right = '';
        pill.style.fontSize = '';
        pill.style.height = '';
        pill.style.borderRadius = '';
        pill.style.paddingLeft = pill.style.paddingRight = '';
        return;
      }
      // 拿不到组件 Shadow DOM：退回固定定位，下面会补一块同色底。
      chipGroupFailed = true;
    }
    chipFloat = true;
    pill.classList.add('sd-float');
    if (group) {
      var baseW = parseFloat(group.getAttribute('data-sd-w')) || 0;
      if (baseW) group.style.width = Math.round(baseW) + 'px';
    }
    if (pill.parentElement !== document.body) document.body.appendChild(pill);
    if (chipAnchor && chipAnchor.isConnected) {
      var r = chipAnchor.getBoundingClientRect();
      if (r.width > 20) {
        var nav = measureNav(chipAnchor);
        var h = nav.height;
        var fs = 13;
        try {
          var afs = parseFloat(W.getComputedStyle(chipAnchor).fontSize);
          if (isFinite(afs) && afs > 8) fs = Math.round(clamp(afs, 12, 15));
        } catch (_) { /* ignore */ }
        var pad = h >= 36 ? 16 : 13;
        el.pill.style.fontSize = fs + 'px';
        el.pill.style.height = h + 'px';
        el.pill.style.borderRadius = Math.round(h / 2) + 'px';
        el.pill.style.paddingLeft = pad + 'px';
        el.pill.style.paddingRight = pad + 'px';
        el.pill.style.top = Math.round(nav.centerY - h / 2) + 'px';
        var pw = el.pill.offsetWidth || 190;
        var vw = W.innerWidth || 1280;
        var left = Math.round(clamp(nav.right + 8, 8, Math.max(8, vw - pw - 8)));
        el.pill.style.left = left + 'px';
        el.pill.style.right = 'auto';
        // 补一段和导航胶囊同色的底，向左咬住导航组 20px，视觉上连成一个长胶囊。
        var gh = group ? Math.round(group.getBoundingClientRect().height) : (h + 6);
        chipBg.style.height = gh + 'px';
        chipBg.style.borderRadius = Math.round(gh / 2) + 'px';
        chipBg.style.top = Math.round(nav.centerY - gh / 2) + 'px';
        chipBg.style.left = Math.max(0, left - 20) + 'px';
        chipBg.style.width = Math.round(pw + 26) + 'px';
        chipBg.style.opacity = '1';
        return;
      }
    }
    chipBg.style.opacity = '0';
    el.pill.style.fontSize = '14px';
    el.pill.style.height = '38px';
    el.pill.style.borderRadius = '19px';
    el.pill.style.paddingLeft = '14px';
    el.pill.style.paddingRight = '14px';
    // 既没有 Friends、也没有分段导航：放到顶部表头左侧，避免写死 right:320 在窄窗口里跑到中间。
    var vw2 = W.innerWidth || 1280;
    var pw2 = el.pill.offsetWidth || 190;
    var top2 = 14;
    try {
      var hs = document.querySelectorAll('header, .app-header, [class*="header"]');
      for (var hi = 0; hi < hs.length; hi++) {
        var hr = hs[hi].getBoundingClientRect();
        if (hr.top <= 4 && hr.height >= 40 && hr.height <= 96 && hr.width >= vw2 * 0.6) {
          top2 = Math.round(hr.top + (hr.height - 38) / 2);
          break;
        }
      }
    } catch (_) { /* ignore */ }
    el.pill.style.left = Math.round(clamp(16, 8, Math.max(8, vw2 - pw2 - 8))) + 'px';
    el.pill.style.right = 'auto';
    el.pill.style.top = Math.round(clamp(top2, 6, 160)) + 'px';
  }

  function panelHeight() {
    return el.deck.offsetHeight || PANEL_H_EST;
  }

  function applyPosition() {
    if (DESKTOP) {
      el.deck.style.left = '10px';
      el.deck.style.top = '10px';
      el.off.style.display = 'none';
      return;
    }
    var vw = W.innerWidth || 1280;
    var vh = W.innerHeight || 800;
    var left, top;
    placeChip();
    if (state.docked) {
      // 停靠模式：面板左边缘对齐导航芯片，形成下拉菜单的观感
      var chip = el.pill.getBoundingClientRect();
      left = clamp(chip.left || (vw - 480), 8, vw - PANEL_W - 8);
      top = 58;
    } else {
      var freeW = Math.max(24, vw - PANEL_W - 24);
      var freeH = Math.max(24, vh - NAV_TOP - panelHeight() - 12);
      left = clamp(state.position.left, 0, 1) * freeW + 12;
      top = NAV_TOP + clamp(state.position.top, 0, 1) * freeH;
    }
    el.deck.style.left = Math.round(left) + 'px';
    el.deck.style.top = Math.round(top) + 'px';
    el.off.style.left = Math.round(left) + 'px';
    el.off.style.top = Math.round(top) + 'px';
  }

  // ---------- 主题 ----------

  function applyTheme() {
    var t = currentTheme();
    var dark = t === 'dark';
    el.deck.className = 'deck' + (DESKTOP ? ' desktop' : '') + (dark ? ' dark' : '');
    el.pill.className = 'sd-chip' + (dark ? ' dark' : '') +
      (state.enabled && !state.collapsed ? ' on' : '') + (chipFloat ? ' sd-float' : '');
    el.off.className = 'off' + (dark ? ' dark' : '');
    var title = state.theme === 'auto' ? '主题：跟随界面（当前 ' + (dark ? '深色' : '浅色') + '）'
      : '主题：' + (dark ? '深色' : '浅色');
    el.themeBtn.title = title;
    el.themeBtn.textContent = dark ? '☾' : '☀';
  }

  function cycleTheme() {
    var order = ['auto', 'light', 'dark'];
    var next = order[(order.indexOf(state.theme) + 1) % order.length];
    HOST.send({ t: 'theme', theme: next });
  }

  // ---------- 渲染 ----------

  var rafPending = false;
  function renderSoon() {
    if (rafPending) return;
    rafPending = true;
    W.requestAnimationFrame(function () { rafPending = false; render(); });
  }

  function render() {
    var s = state.snap;
    var on = state.enabled;
    el.off.style.display = on ? 'none' : 'block';
    el.deck.style.display = (on && (DESKTOP || !state.collapsed)) ? 'flex' : 'none';
    el.pill.style.display = (on && !DESKTOP) ? 'flex' : 'none';
    el.pill.classList.toggle('on', on && !state.collapsed);
    el.deckPop.style.display = DESKTOP ? 'none' : 'flex';
    placeChip();
    if (!on) return;
    if (DESKTOP) {
      // 窗口高度跟着内容走，避免透明区域挡住桌面点击
      var dh = Math.ceil(el.deck.getBoundingClientRect().height) + 20;
      if (Math.abs(dh - lastDeckH) > 2) {
        lastDeckH = dh;
        HOST.send({ t: 'desktopHeight', h: dh });
      }
    }

    applyTheme();

    var now = new Date();
    var t = pad2(now.getHours()) + ':' + pad2(now.getMinutes());
    el.time.textContent = t;
    el.sec.textContent = ' ' + pad2(now.getSeconds());
    el.date.textContent = now.getFullYear() + '年' + (now.getMonth() + 1) + '月' + now.getDate() + '日';
    el.week.textContent = weekCn(now);
    if (el.pillTime) el.pillTime.textContent = t;

    // 农历（主进程按天计算并缓存）
    var lunarOk = state.lunarOn && s && s.lunar;
    el.lunar.style.display = state.lunarOn ? 'flex' : 'none';
    if (lunarOk) {
      var lu = s.lunar;
      el.lunarText.textContent = '农历 ' + lu.text;
      el.lunarYear.textContent = lu.yearText || '';
      if (lu.badge) {
        el.lunarBadge.style.display = '';
        el.lunarBadge.textContent = (lu.badgeIcon && lu.festival ? lu.badgeIcon + ' ' : '') + lu.badge;
        el.lunarBadge.className = 'lunar-badge' + (lu.festival ? ' fest' : '');
      } else {
        el.lunarBadge.style.display = 'none';
      }
    }

    if (!s || !s.sys) return;
    var sys = s.sys;

    var cpuPct = clamp(sys.cpuPct || 0, 0, 100);
    el.cpuVal.textContent = sys.cpuPct + '%';
    el.cpuVal.style.color = loadColor(cpuPct);
    el.cpuFill.style.width = cpuPct + '%';
    el.cpuFill.style.background = cpuPct >= 85
      ? 'linear-gradient(90deg,#ff7a5c,#ff5f6d)'
      : (cpuPct >= 60 ? 'linear-gradient(90deg,#ffb454,#ff8a5c)' : '');
    el.cpuCores.textContent = sys.cpuCores ? sys.cpuCores + ' 核' : '';
    var sp = sparkPaths(sys.cpuHist, 242, 26, false);
    el.cpuSparkLine.setAttribute('points', sp.line);
    el.cpuSparkArea.setAttribute('points', sp.area);

    var memPct = clamp(sys.memPct || 0, 0, 100);
    el.memVal.textContent = sys.memPct + '%';
    el.memVal.style.color = loadColor(memPct);
    el.memFill.style.width = memPct + '%';
    el.memFill.style.background = memPct >= 85
      ? 'linear-gradient(90deg,#e05cff,#ff5f6d)'
      : (memPct >= 60 ? 'linear-gradient(90deg,#c37aff,#ff6bff)' : '');
    el.memSub.textContent = fmtGB(sys.memUsedBytes) + ' / ' + fmtGB(sys.memTotalBytes);
    sp = sparkPaths(sys.memHist, 242, 26, false);
    el.memSparkLine.setAttribute('points', sp.line);
    el.memSparkArea.setAttribute('points', sp.area);

    // 磁盘
    var disks = state.diskOn && sys.disks ? sys.disks : null;
    if (disks && disks.length) {
      var html = '';
      var hot = '';
      for (var i = 0; i < disks.length && i < 3; i++) {
        var d = disks[i];
        if (d.usedPct >= 85) hot = ' hot';
        html += '<div class="disk-row">' +
          '<span class="disk-name">' + (d.drive || '?') + '</span>' +
          '<div class="disk-bar"><div class="disk-fill' + (d.usedPct >= 85 ? ' hot' : '') + '" style="width:' + clamp(d.usedPct, 0, 100) + '%"></div></div>' +
          '<span class="disk-info">' + fmtGB(d.totalBytes - d.freeBytes) + ' / ' + fmtGB(d.totalBytes) + '</span>' +
          '</div>';
      }
      el.disks.style.display = 'block';
      if (el.disks.innerHTML !== html) el.disks.innerHTML = html;
      void hot;
    } else {
      el.disks.style.display = 'none';
    }

    // 网络
    el.netRow.style.display = state.netOn ? 'flex' : 'none';
    if (state.netOn && s.net) {
      var netOk = s.net.ok !== false;
      el.dlVal.textContent = netOk ? fmtRate(s.net.down) : '不可用';
      el.ulVal.textContent = netOk ? fmtRate(s.net.up) : '';
      var spd = sparkPaths(s.net.downHist, 98, 22, true);
      el.dlSparkLine.setAttribute('points', spd.line);
      el.dlSparkArea.setAttribute('points', spd.area);
      var spu = sparkPaths(s.net.upHist, 98, 22, true);
      el.ulSparkLine.setAttribute('points', spu.line);
      el.ulSparkArea.setAttribute('points', spu.area);
    }

    // 天气 + 预报
    el.wx.style.display = state.weatherOn ? 'block' : 'none';
    if (el.pillWx) el.pillWx.style.display = (state.weatherOn && s && s.weather) ? 'flex' : 'none';
    if (state.weatherOn && s.weather) {
      var wx = s.weather;
      var iconHtml = wxSvg(wx.icon, 20);
      if (el.wxIcon.innerHTML !== iconHtml) el.wxIcon.innerHTML = iconHtml;
      if (el.pillWxIco && el.pillWxT) {
        if (el.pillWxIco.innerHTML !== iconHtml) el.pillWxIco.innerHTML = wxSvg(wx.icon, 14);
        el.pillWxT.textContent = (typeof wx.tempC === 'number' ? Math.round(wx.tempC) : '--') + '°';
      }
      var fc = Array.isArray(wx.forecast) ? wx.forecast : [];
      var today = fc[0];
      el.wxTemp.textContent = (typeof wx.tempC === 'number' ? Math.round(wx.tempC) : '--') + '°';
      el.wxText.textContent = wx.text || '未知';
      el.wxRange.textContent = (today && today.minC != null && today.maxC != null)
        ? Math.round(today.minC) + '° / ' + Math.round(today.maxC) + '°' : '';
      var cityName = state.weatherCity || wx.city;
      el.wxCity.textContent = cityName
        ? cityName + (state.weatherCity ? ' · 手动' : ' · 自动定位') + ' · 点击修改'
        : '点击设置城市';
      var bits = [];
      if (typeof wx.feelsC === 'number') bits.push('体感 ' + Math.round(wx.feelsC) + '°');
      if (typeof wx.humidity === 'number') bits.push('湿度 ' + wx.humidity + '%');
      var windTxt = windText(wx);
      if (windTxt) bits.push(windTxt);
      el.wxMeta.textContent = bits.join(' · ');
      el.wxMeta.style.display = bits.length ? 'flex' : 'none';
      if (wx.stale) {
        el.wxStale.style.display = 'flex';
        el.wxStale.textContent = '离线缓存' + (wx.at ? ' · 更新于 ' + hmOf(wx.at) : '') + '，点击刷新';
      } else {
        el.wxStale.style.display = 'none';
      }
      el.wx.title = wx.stale ? '天气为缓存数据，点击立即刷新' : '点击立即刷新';
      if (fc.length) {
        var fh = '';
        var dayNames = ['今天', '明天', '后天'];
        for (var j = 0; j < fc.length && j < 3; j++) {
          var f = fc[j];
          var day = dayNames[j] || '';
          var md = String(f.date || '').slice(5).replace('-', '/');
          fh += '<div class="fc-item"><div class="fc-day">' + day + (md ? ' ' + md : '') + '</div>' +
            '<div class="fc-icon">' + wxSvg(f.icon || '⛅', 15) + '</div>' +
            '<div class="fc-temp">' + (f.minC != null ? Math.round(f.minC) + '°' : '--') + ' / ' + (f.maxC != null ? Math.round(f.maxC) + '°' : '--') + '</div></div>';
        }
        el.wxFc.style.display = 'flex';
        if (el.wxFc.innerHTML !== fh) el.wxFc.innerHTML = fh;
      } else {
        el.wxFc.style.display = 'none';
      }
    }

    // 倒数日
    var cdList = state.cdOn && Array.isArray(s && s.countdowns) ? s.countdowns : null;
    if (cdList && cdList.length) {
      var cdh = '';
      var ico = ['📌', '🎂', '✈️', '🎓', '💍', '🎁', '📅', '🏁', '⭐', '🔖'];
      for (var c = 0; c < cdList.length && c < 4; c++) {
        var it = cdList[c];
        var cls = 'cd-days';
        var label;
        if (it.days < 0) { cls += ' past'; label = '已过 ' + (-it.days) + ' 天'; }
        else if (it.days === 0) { cls += ' soon'; label = '就是今天'; }
        else if (it.days === 1) { label = '明天'; }
        else if (it.days <= 7) { cls += ' soon'; label = '还有 ' + it.days + ' 天'; }
        else { label = '还有 ' + it.days + ' 天'; }
        cdh += '<div class="cd-row">' +
          '<span class="cd-ico">' + ico[it.i % ico.length] + '</span>' +
          '<span class="cd-name" title="' + it.date + '">' + escHtml(it.name) + '</span>' +
          '<span class="' + cls + '">' + label + '</span>' +
          '<button class="btn cd-del" data-idx="' + it.i + '" title="删除">×</button>' +
          '</div>';
      }
      el.cd.style.display = 'block';
      if (el.cdList.innerHTML !== cdh) el.cdList.innerHTML = cdh;
    } else if (cdList) {
      el.cd.style.display = 'block';
      if (el.cdList.innerHTML !== '') el.cdList.innerHTML = '';
      // 空列表时保留一个占位提示
      if (el.cdList.children.length === 0 && !el.cdList.querySelector('.cd-empty')) {
        var empty = document.createElement('div');
        empty.className = 'cd-row';
        empty.innerHTML = '<span class="cd-name" style="opacity:.55">点右上 ＋ 添加纪念日 / 倒计时</span>';
        el.cdList.appendChild(empty);
      }
    } else {
      el.cd.style.display = 'none';
    }
    el.cdForm.style.display = state.cdFormOpen ? 'flex' : 'none';

    // 番茄钟
    el.pomo.style.display = state.pomoOn ? 'flex' : 'none';
    if (state.pomoOn && s.pomo) {
      var p = s.pomo;
      var mm = Math.floor(p.remainSec / 60);
      var ss = p.remainSec % 60;
      el.pomoTime.textContent = pad2(mm) + ':' + pad2(ss);
      el.pomoTime.className = 'pomo-time ' + (p.phase === 'break' ? 'break' : (p.phase === 'work' || p.phase === 'paused' ? 'work' : ''));
      el.pomoPhase.textContent = p.phase === 'work' ? '专注中'
        : p.phase === 'break' ? '休息中'
        : p.phase === 'paused' ? '已暂停' : '番茄钟';
      el.pomoSub.textContent = '第 ' + p.round + ' 轮 · ' + p.workMin + '/' + p.breakMin + ' 分钟';
      el.pomoPlay.textContent = p.running ? '⏸' : '▶';
    }

    el.fUptime.textContent = '开机 ' + fmtUptime(sys.uptimeSec);
    el.fHost.textContent = sys.host || '';

    // 电池（台式机 available=false 自动隐藏）
    var bt = s.battery;
    if (state.battOn && bt && bt.available === true && typeof bt.pct === 'number') {
      el.fBatt.style.display = '';
      el.fBatt.textContent = (bt.charging ? '⚡ ' : '🔋 ') + bt.pct + '%';
      el.fBatt.style.color = (!bt.charging && bt.pct <= 20) ? 'var(--red)' : '';
    } else {
      el.fBatt.style.display = 'none';
    }

    var busy = cpuPct > 85;
    if (el.pillDot) el.pillDot.className = busy ? 'pill-dot busy' : 'pill-dot';
    if (el.pillCpu) {
      el.pillCpu.textContent = Math.round(cpuPct) + '%';
      el.pillCpu.style.color = loadColor(cpuPct);
    }
  }

  // ---------- 时钟 ----------

  function tickClock() {
    // auto 主题下周期性重检页面明暗（页面切换路由可能换背景）
    if (state.theme === 'auto') {
      var d = detectPageTheme();
      if (d !== state.detected) { state.detected = d; renderSoon(); }
    }
    renderSoon();
  }

  // ---------- 拖拽 ----------

  function startDrag(e) {
    if (DESKTOP) return; // 桌面窗靠 -webkit-app-region 拖整窗，不在这里移动面板
    var target = e.currentTarget;
    if (target !== el.deck.querySelector('.head')) return;
    if (e.target && e.target.closest && e.target.closest('.btn')) return; // 按钮不触发拖动，否则点击被吞
    state.docked = false; // 拖动即脱离导航停靠
    state.drag = {
      startX: e.clientX, startY: e.clientY,
      baseLeft: parseFloat(el.deck.style.left) || 0,
      baseTop: parseFloat(el.deck.style.top) || 0,
      moved: false
    };
    try { target.setPointerCapture && e.pointerId !== undefined && target.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault();
    e.stopPropagation();
  }

  function moveDrag(e) {
    if (!state.drag) return;
    var dx = e.clientX - state.drag.startX;
    var dy = e.clientY - state.drag.startY;
    if (Math.abs(dx) + Math.abs(dy) > 4) state.drag.moved = true;
    var vw = W.innerWidth || 1280, vh = W.innerHeight || 800;
    var left2 = clamp(state.drag.baseLeft + dx, 8, vw - PANEL_W - 8);
    var top2 = clamp(state.drag.baseTop + dy, NAV_TOP, Math.max(NAV_TOP, vh - panelHeight() - 8));
    el.deck.style.left = Math.round(left2) + 'px';
    el.deck.style.top = Math.round(top2) + 'px';
  }

  function endDrag() {
    if (!state.drag) return;
    var moved = state.drag.moved;
    state.drag = null;
    if (!moved) return;
    var vw = W.innerWidth || 1280, vh = W.innerHeight || 800;
    var freeW = Math.max(24, vw - PANEL_W - 24);
    var freeH = Math.max(24, vh - NAV_TOP - panelHeight() - 12);
    var left = parseFloat(el.deck.style.left) || 8;
    var top = parseFloat(el.deck.style.top) || 8;
    HOST.send({ t: 'position', docked: false, pos: { left: clamp((left - 12) / freeW, 0, 1), top: clamp((top - NAV_TOP) / freeH, 0, 1) } });
  }

  // ---------- 事件 ----------

  var head = el.deck.querySelector('.head');
  head.addEventListener('pointerdown', startDrag);
  W.addEventListener('pointermove', moveDrag);
  W.addEventListener('pointerup', endDrag);
  // 芯片可能落在导航栏的拖动区之上，用捕获阶段按坐标接管点击，保证一定点得开。
  var lastChipToggle = 0;
  W.addEventListener('mousedown', function (e) {
    var r = pill.getBoundingClientRect();
    if (!r.width || !r.height) return;
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
    var now = Date.now();
    if (now - lastChipToggle < 280) return;
    lastChipToggle = now;
    try { e.preventDefault(); e.stopPropagation(); } catch (_) { /* ignore */ }
    HOST.send({ t: 'collapse', collapsed: !state.collapsed });
  }, true);
  el.pill.addEventListener('click', function (e) { e.stopPropagation(); });
  el.deckMin.addEventListener('click', function () {
    if (DESKTOP) { HOST.send({ t: 'desktopHide' }); return; }
    HOST.send({ t: 'collapse', collapsed: true });
  });
  if (DESKTOP) {
    el.deckOff.textContent = '隐藏';
    el.deckOff.title = '隐藏悬浮窗';
    el.deckMin.title = '隐藏悬浮窗';
  }
  el.deckPop.addEventListener('click', function (e) { e.stopPropagation(); HOST.send({ t: 'desktopToggle' }); });
  el.deckOff.addEventListener('click', function (e) {
    e.stopPropagation();
    if (DESKTOP) { HOST.send({ t: 'desktopHide' }); return; }
    HOST.send({ t: 'toggle', on: false });
  });
  off.addEventListener('click', function () { HOST.send({ t: 'toggle', on: true }); });
  el.wx.addEventListener('click', function () { HOST.send({ t: 'refreshWeather' }); });
  el.wxRefresh.addEventListener('click', function (e) { e.stopPropagation(); HOST.send({ t: 'refreshWeather' }); });
  function openWxCity(e) {
    if (e) e.stopPropagation();
    el.wxSet.style.display = 'flex';
    el.wxCityIn.value = state.weatherCity || '';
    setTimeout(function () { try { el.wxCityIn.focus(); } catch (_) {} }, 0);
  }
  function closeWxCity(e) {
    if (e) e.stopPropagation();
    el.wxSet.style.display = 'none';
  }
  el.wxCity.addEventListener('click', openWxCity);
  el.wxSet.addEventListener('click', function (e) { e.stopPropagation(); });
  el.wxCitySave.addEventListener('click', function (e) {
    e.stopPropagation();
    var city = String(el.wxCityIn.value || '').trim();
    state.weatherCity = city;
    renderSoon();
    el.wxCity.textContent = city ? (city + ' · 定位中…') : '自动定位中…';
    HOST.send({ t: 'setWeatherCity', city: city });
    closeWxCity(e);
  });
  el.wxCityCancel.addEventListener('click', closeWxCity);
  el.wxCityIn.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') el.wxCitySave.click();
    else if (e.key === 'Escape') closeWxCity();
  });
  el.themeBtn.addEventListener('click', function (e) { e.stopPropagation(); cycleTheme(); });
  el.pomoPlay.addEventListener('click', function (e) {
    e.stopPropagation();
    var p = state.snap && state.snap.pomo;
    var action = p && p.running ? 'pause' : 'start';
    HOST.send({ t: 'pomodoro', action: action });
  });
  el.pomoReset.addEventListener('click', function (e) {
    e.stopPropagation();
    HOST.send({ t: 'pomodoro', action: 'reset' });
  });

  // 倒数日：内联表单（Electron 页面不支持 window.prompt）
  el.cdAdd.addEventListener('click', function (e) {
    e.stopPropagation();
    state.cdFormOpen = !state.cdFormOpen;
    el.cdForm.style.display = state.cdFormOpen ? 'flex' : 'none';
    if (state.cdFormOpen) {
      try { el.cdName.value = ''; el.cdDate.value = ''; } catch (_) {}
      setTimeout(function () { try { el.cdName.focus(); } catch (_) {} }, 30);
    }
  });
  el.cdCancel.addEventListener('click', function (e) {
    e.stopPropagation();
    state.cdFormOpen = false;
    el.cdForm.style.display = 'none';
  });
  el.cdSave.addEventListener('click', function (e) {
    e.stopPropagation();
    var name = String(el.cdName.value || '').trim();
    var date = String(el.cdDate.value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      // 日期未选：聚焦日期输入并轻晃提示
      try { el.cdDate.focus(); } catch (_) {}
      return;
    }
    state.cdFormOpen = false;
    el.cdForm.style.display = 'none';
    HOST.send({ t: 'countdown', op: 'add', name: name || '纪念日', date: date });
  });
  // 表单内回车提交
  el.cdForm.addEventListener('keydown', function (e) {
    if (e && e.key === 'Enter') { try { el.cdSave.click(); } catch (_) {} }
  });
  // 删除（事件委托）
  el.cdList.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('.cd-del') : null;
    if (!btn) return;
    e.stopPropagation();
    var idx = Number(btn.getAttribute('data-idx'));
    if (isFinite(idx)) HOST.send({ t: 'countdown', op: 'del', idx: idx });
  });

  W.addEventListener('resize', applyPosition);
  // 面板高度会随数据/展开变化，实时夹回视口内，避免底部被裁掉。
  try {
    if (W.ResizeObserver) { new W.ResizeObserver(function () { applyPosition(); }).observe(el.deck); }
  } catch (_) {}

  // ---------- 订阅 ----------

  HOST.onSnapshot(function (s) {
    if (!s || s.plugin !== 'sysdeck') return;
    state.snap = s;
    state.enabled = s.pluginEnabled !== false;
    if (s.config) {
      state.collapsed = DESKTOP ? false : !!s.config.collapsed;
      state.weatherOn = s.config.weatherEnabled !== false;
      state.weatherCity = typeof s.config.weatherCity === 'string' ? s.config.weatherCity : '';
      state.docked = s.config.docked !== false;
      state.netOn = s.config.netEnabled !== false;
      state.diskOn = s.config.diskEnabled !== false;
      state.pomoOn = s.config.pomodoroEnabled !== false;
      state.lunarOn = s.config.lunarEnabled !== false;
      state.battOn = s.config.batteryEnabled !== false;
      state.cdOn = s.config.countdownEnabled !== false;
      state.theme = ['auto', 'light', 'dark'].indexOf(s.config.theme) >= 0 ? s.config.theme : 'auto';
      if (s.config.position && typeof s.config.position.left === 'number') {
        state.position = { left: s.config.position.left, top: s.config.position.top };
      }
    }
    applyPosition();
    renderSoon();
  });

  state.detected = detectPageTheme();
  state.clockTimer = setInterval(tickClock, 1000);

  W.__mcDeckPanel = { __installed: true };
})();
