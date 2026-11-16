(function () {
  'use strict';
  var W = window;
  if (W.__mcDevice && W.__mcDevice.version === 7) return;
  if (W.__mcDevice && W.__mcDevice.dispose) W.__mcDevice.dispose();
  var service = null, system = null, finding = null, snapshot = null, preview = null;
  var busy = false, disposed = false, lastKey = '', owner = null, retryAt = 0;
  var delivery = { phase: 'waiting', text: '', source: null, sent: 0, error: null };
  var eventKey = 'lyric-bridge-device-v1', media = null, unsubscribe = null;
  var nativeControl = null, nativeEnabled = null, preferenceKey = 'mc-lyric-bridge:officialEnabled';
  try {
    var saved = W.localStorage.getItem(preferenceKey);
    if (saved === 'true' || saved === 'false') nativeEnabled = saved === 'true';
  } catch (_) { /* Storage may be unavailable in an older host. */ }
  function rememberNative(value) {
    nativeEnabled = value;
    if (owner) owner.enabled = value;
    try { W.localStorage.setItem(preferenceKey, String(value)); } catch (_) {}
  }
  function syncNativeControl() {
    if (nativeControl && nativeControl.lyricsDisplayEnabled && nativeEnabled !== null && nativeControl.lyricsDisplayEnabled.value !== nativeEnabled)
      nativeControl.applyLyricsSettings({ enabled: nativeEnabled });
  }
  function send(message) { if (W.__mcBridgeHost) W.__mcBridgeHost.send(message); }
  function status(phase, extra) {
    delivery = Object.assign({}, delivery, { phase: phase, error: null }, extra || {});
    W.dispatchEvent(new CustomEvent('mc-bridge-delivery', { detail: delivery }));
  }
  function devices() {
    var ds = system && system.devices;
    return ds && Array.isArray(ds.value || ds) ? (ds.value || ds) : [];
  }
  function device() { return devices().find(function (d) { return d.modelKey === 'MCHOSE K20 GT'; }); }
  function connectionKey(d) {
    var list = Array.isArray(d.connections) ? d.connections : (d.connections && Array.isArray(d.connections.value) ? d.connections.value : []);
    return d.logicalDeviceId + '|' + list.map(function (c) { return c.sessionId; }).sort().join(',');
  }
  async function discoverPreview(url) {
    if (preview) return;
    try {
      var source = await (await fetch(url)).text();
      var match = source.match(/\.\/useK20GtPreviewStore-[\w-]+\.js/);
      if (!match) return;
      var mod = await import(new URL(match[0], url).href);
      var factory = Object.values(mod).find(function (v) { return typeof v === 'function' && v.$id === 'k20GtPreview'; });
      if (factory) preview = factory();
      var nativeMatch = source.match(/\.\/useWebLyrics-[\w-]+\.js/);
      if (nativeMatch) {
        var nativeModule = await import(new URL(nativeMatch[0], url).href);
        var nativeNamespace = Object.values(nativeModule).find(function (v) { return v && typeof v.useWebLyrics === 'function'; });
        if (nativeNamespace) nativeControl = nativeNamespace.useWebLyrics();
      }
    } catch (_) { /* Preview is optional; it must never block a device write. */ }
  }
  async function discover() {
    if (service && system) return;
    if (finding) return finding;
    finding = (async function () {
      var urls = [], entries = Array.from(document.scripts).map(function (s) { return s.src; });
      function add(u) { if (u && urls.indexOf(u) < 0) urls.push(u); }
      performance.getEntriesByType('resource').forEach(function (r) { if (/\/assets\/main-[\w-]+\.js(?:\?|$)/.test(r.name)) add(r.name); });
      for (var entry of entries) {
        if (!/\/assets\/main-[\w-]+\.js(?:\?|$)/.test(entry)) continue;
        add(entry);
        try {
          var source = await (await fetch(entry)).text();
          var re = /(?:import\(|from\s*)["'](\.\/main-[\w-]+\.js)["']/g, match;
          while ((match = re.exec(source))) add(new URL(match[1], entry).href);
        } catch (_) { /* A cached entry can still be imported. */ }
      }
      for (var url of urls) {
        try {
          var mod = await import(url);
          Object.values(mod).forEach(function (v) {
            if (v && typeof v.setK20GtLyrics === 'function' && typeof v.getK20GtLyrics === 'function') service = v;
            if (v && v.devices && Array.isArray(v.devices.value || v.devices)) system = v;
          });
          if (service && system) await discoverPreview(url);
        } catch (_) { /* Try another already loaded entry. */ }
        if (service && system) break;
      }
      if (!service || !system) throw Error('当前 M HUB 页面版本未找到 K20 GT 歌词服务');
    })();
    try { await finding; } finally { finding = null; }
  }
  function nativePlaying() {
    var m = media && (media.mediaInfo || media);
    return !!(m && m.isPlaying && /qqmusic|qq音乐|cloudmusic|netease|网易云/i.test(m.sourceApp || ''));
  }
  async function flush() {
    if (busy || disposed || Date.now() < retryAt) return;
    busy = true;
    try {
      var s = snapshot, l = s && s.lyric;
      var enabled = !!(s && s.pluginEnabled && l && l.on);
      var active = !!(enabled && l.playing && l.text && /^(kugou|soda|session|bilibili)$/.test(l.source));
      if (nativePlaying()) {
        owner = null; lastKey = ''; status('native'); return;
      }
      if (!active && !owner) { status(enabled ? 'waiting' : 'off'); return; }
      await discover();
      if (disposed) return;
      var d = device();
      if (!d || !d.connections || !d.connections.length) { owner = null; lastKey = ''; status('offline'); return; }
      var id = d.logicalDeviceId;
      var session = connectionKey(d);
      if (d.deviceState && (d.deviceState.sleep || d.deviceState.screen && d.deviceState.screen.enabled === false)) {
        lastKey = ''; status('screen-off'); return;
      }
      if (owner && owner.session !== session) { owner = null; lastKey = ''; }
      var settings = (d.deviceState && d.deviceState.screen && d.deviceState.screen.lyrics) || {};
      if (active && !owner) {
        var before = await service.getK20GtLyrics(id);
        if (disposed) return;
        if (nativeEnabled === null) rememberNative(!!(before && before.lyrics && before.lyrics.enabled));
        owner = { id: id, session: session, enabled: nativeEnabled };
      }
      var command = {
        enabled: active ? true : !!(owner && owner.enabled),
        scroll: Number(settings.animation == null ? settings.scroll == null ? 5 : settings.scroll : settings.animation),
        font: settings.font || 0, fontSize: settings.fontSize || 0, align: settings.align || 0,
        direction: settings.direction || 0, animation: settings.animation == null ? 5 : settings.animation,
        text: active ? String(l.text).replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 200) : ''
      };
      var key = session + '|' + (active ? l.source : 'release') + '|' + JSON.stringify(command);
      if (lastKey === key && (!active || settings.enabled !== false)) { syncNativeControl(); return; }
      var result = await service.setK20GtLyrics(id, command);
      if (disposed) return;
      lastKey = key;
      syncNativeControl();
      if (preview) {
        try {
          if (active) preview.setMusicLyricInfo({ text: command.text, lyricSwitch: 1,
            scroll: command.animation, align: command.align, fontSize: command.fontSize });
          else if (preview.musicLyricScreen.text === delivery.text) preview.clearMusicLyricInfo();
        } catch (_) { /* The device ACK remains valid if the optional preview changes. */ }
      }
      if (!active) owner = null;
      status(active ? 'sent' : enabled ? 'waiting' : 'off', {
        deviceId: id, source: active ? l.source : null, text: command.text,
        sent: delivery.sent + 1, at: Date.now(), extended: !!(result && result.extended)
      });
      send({ t: 'delivery', phase: delivery.phase, deviceId: id, source: delivery.source,
        text: command.text, at: delivery.at, extended: delivery.extended });
    } catch (e) {
      retryAt = Date.now() + 2000;
      var message = String(e && e.message || e);
      status('error', { error: message });
      send({ t: 'delivery', phase: 'error', error: message, at: Date.now() });
    } finally { busy = false; }
  }
  function onMedia(value) {
    media = value;
    var info = value && (value.mediaInfo || value);
    if (info) send({ t: 'media', media: info });
    flush();
  }
  function ensureMonitor() {
    var api = W.electronAPI;
    if (api && typeof api.startLyricsMonitor === 'function' && snapshot && snapshot.pluginEnabled && snapshot.lyric && snapshot.lyric.on) {
      Promise.resolve(api.startLyricsMonitor()).catch(function () {});
    }
  }
  function onNativeToggle(event) {
    var target = event.target;
    if (!target || target.tagName !== 'DU-SWITCH' || !target.closest('.screen-lyrics-panel__heading')) return;
    var next = event.detail && event.detail.checked;
    rememberNative(typeof next === 'boolean' ? next : !target.checked);
    lastKey = '';
  }
  document.addEventListener('change', onNativeToggle, true);
  if (W.electronAPI && typeof W.electronAPI.addEventListener === 'function') W.electronAPI.addEventListener('onLyricsMediaUpdate', eventKey, onMedia);
  if (W.__mcBridgeHost) unsubscribe = W.__mcBridgeHost.onSnapshot(function (s) { snapshot = s; flush(); });
  var timer = W.setInterval(flush, 500), monitorTimer = W.setInterval(ensureMonitor, 4000);
  ensureMonitor();
  W.__mcDevice = {
    version: 7,
    inspect: function () { return Object.assign({ ready: !!(service && system), busy: busy, officialEnabled: nativeEnabled }, delivery); },
    retry: function () { retryAt = 0; lastKey = ''; return flush(); },
    dispose: function () {
      disposed = true; W.clearInterval(timer); W.clearInterval(monitorTimer);
      if (unsubscribe) unsubscribe();
      document.removeEventListener('change', onNativeToggle, true);
      if (W.electronAPI && W.electronAPI.removeEventListener) W.electronAPI.removeEventListener('onLyricsMediaUpdate', eventKey);
    }
  };
})();
