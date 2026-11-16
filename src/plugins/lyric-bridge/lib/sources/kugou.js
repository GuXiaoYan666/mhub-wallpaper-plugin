'use strict';
const path = require('path');
const kugou = require('../kugou.js');
const { createKuGouUiTimeline } = require('../kugou-uia.js');
function monoMs() { return Number(process.hrtime.bigint() / 1000000n); }
function createKuGouSource(options) {
  const opts = options || {};
  const logger = opts.logger || { debug: function () {}, info: function () {}, warn: function () {}, error: function () {} };
  const onTrack = typeof opts.onTrack === 'function' ? opts.onTrack : function () {};
  const onAnchor = typeof opts.onAnchor === 'function' ? opts.onAnchor : function () {};
  const onError = typeof opts.onError === 'function' ? opts.onError : function () {};
  const getConfig = typeof opts.getConfig === 'function' ? opts.getConfig : function () { return {}; };
  const st = { watcher: null, ui: null, uiPositionLeadMs: 0, track: null, lastAnchorAt: 0, lastError: null, tracks: 0, errors: 0 };
  function buildTrack(title, krcPath, meta, parsedLines) {
    const artist = String((meta && (meta.ar || meta.artist)) || '').trim();
    const offset = Number(meta && meta.offset);
    const length = Number(meta && meta.length);
    return {
      key: 'kugou|' + (title || '') + '|' + String(krcPath || '') + '|' + parsedLines.length,
      source: 'kugou',
      title: String(title || (meta && meta.ti) || '').trim(),
      artist: artist,
      album: String((meta && (meta.al || meta.album)) || '').trim(),
      durationMs: Number.isFinite(length) && length > 0 ? length : 0,
      lines: parsedLines,
      offsetMs: Number.isFinite(offset) ? offset : 0,
      untimed: false,
      translation: false
    };
  }
  function start() {
    if (st.watcher) return;
    const cfg = getConfig() || {};
    const k = cfg.kugou || {};
    if (k.uiTimeline !== false) {
      st.ui = opts.uiTimeline || createKuGouUiTimeline();
      st.ui.start();
    }
    const watcherOpts = {
      intervalMs: k.intervalMs > 0 ? k.intervalMs : 250,
      pauseAfterMs: k.pauseAfterMs >= 0 ? k.pauseAfterMs : 5000,
      positionLeadMs: Number.isFinite(Number(k.positionLeadMs)) ? Number(k.positionLeadMs) : 2600,
      emitProgress: true
    };
    if (k.iniPath) watcherOpts.iniPath = path.join(k.iniPath);
    try {
      st.watcher = kugou.createKuGouWatcher({
        intervalMs: watcherOpts.intervalMs,
        pauseAfterMs: watcherOpts.pauseAfterMs,
        positionLeadMs: watcherOpts.positionLeadMs,
        emitProgress: true,
        iniPath: watcherOpts.iniPath,
        mediaProvider: function (ini) {
          const media = typeof opts.getMedia === 'function' ? opts.getMedia() : null;
          const clock = st.ui && st.ui.current();
          st.uiPositionLeadMs = 0;
          if (!clock) return media;
          const settings = (getConfig() || {}).kugou || {};
          const configuredLead = settings.uiPositionLeadMs;
          const lead = Number.isFinite(configuredLead) ? configuredLead : 300;
          const playing = media ? !!(media.playing && clock.playing) : !!clock.playing;
          st.uiPositionLeadMs = playing && clock.positionMs > 0 ? lead : 0;
          const positionMs = Math.min(clock.durationMs, Math.max(0, clock.positionMs + st.uiPositionLeadMs));
          if (media) return Object.assign({}, media, { positionMs: positionMs, playing: playing });
          const full = String(ini && ini.title || '');
          const split = full.lastIndexOf(' - ');
          return { artist: split > 0 ? full.slice(0, split) : '', title: split > 0 ? full.slice(split + 3) : full,
            positionMs: positionMs, playing: playing };
        },
        onTrack: function (info) {
          if (!info || !info.krcPath) {
            if (st.track) { st.track = null; onTrack(null); }
            return;
          }
          let parsed;
          try { parsed = kugou.parseKrcFile(info.krcPath); }
          catch (e) { parsed = { ok: false, error: { code: 'KRC_THROW', message: String(e && e.message) } }; }
          if (!parsed.ok) {
            st.errors++;
            st.lastError = parsed.error;
            onError(parsed.error);
            return;
          }
          const lines = [];
          for (let i = 0; i < parsed.lines.length; i++) {
            const l = parsed.lines[i];
            if (!l.text) continue;
            lines.push({ timeMs: l.timeMs, text: l.text });
          }
          if (!lines.length) return;
          const track = buildTrack(info.title, info.krcPath, parsed.meta, lines);
          st.track = track;
          st.tracks++;
          st.lastError = null;
          logger.info('kugou: 曲目 "' + track.title + '" 行数=' + lines.length + ' 文件=' + path.basename(info.krcPath));
          if (Number.isFinite(info.initialPosMs)) {
            st.lastAnchorAt = monoMs();
            onAnchor({ posMs: info.initialPosMs, playing: !!info.playing, at: st.lastAnchorAt });
          }
          onTrack(track);
        },
        onTrackError: function () {},
        onProgress: function (p) {
          if (!st.track) return;
          st.lastAnchorAt = monoMs();
          onAnchor({ posMs: p.posMs, playing: !!p.playing, at: st.lastAnchorAt });
        },
        onLine: function (line) {
          if (!st.track) return;
          st.lastAnchorAt = monoMs();
          onAnchor({ posMs: line.posMs, playing: !!line.playing, at: st.lastAnchorAt });
        },
        onState: function (s) {
          if (!st.track || !s) return;
          st.lastAnchorAt = monoMs();
          onAnchor({ posMs: s.posMs, playing: !!s.playing, at: st.lastAnchorAt });
        },
        onError: function (e) {
          st.errors++;
          st.lastError = e;
          onError(e);
        }
      });
      st.watcher.start();
      logger.info('kugou: 监听已启动 (ini=' + (watcherOpts.iniPath || kugou.DEFAULTS.iniPath) + ')');
    } catch (e) {
      st.lastError = { code: 'KUGOU_START_FAILED', message: String(e && e.message) };
      logger.warn('kugou: 启动失败 ' + (e && e.message));
    }
  }
  return {
    start: start,
    stop: function () {
      if (st.watcher) { try { st.watcher.stop(); } catch (e) { /* ignore */ } st.watcher = null; }
      if (st.ui) { if (!opts.uiTimeline) { try { st.ui.stop(); } catch (e) { /* ignore */ } } st.ui = null; }
      st.track = null;
      return this;
    },
    track: function () { return st.track; },
    status: function () {
      const s = st.watcher ? st.watcher.getState() : null;
      return { running: !!st.watcher, track: st.track ? st.track.title : null, lines: st.track ? st.track.lines.length : 0, anchorAgeMs: st.lastAnchorAt ? Math.round(monoMs() - st.lastAnchorAt) : null, watcher: s, ui: st.ui ? st.ui.status() : null, uiPositionLeadMs: st.uiPositionLeadMs, error: st.lastError, tracks: st.tracks, errors: st.errors };
    },
    _internal: st
  };
}
module.exports = { createKuGouSource: createKuGouSource };
