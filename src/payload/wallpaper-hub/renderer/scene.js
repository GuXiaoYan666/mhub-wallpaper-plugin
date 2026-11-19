(function () {
  'use strict';

  /* 部分 M HUB/Electron 组合中，XHR 可访问自定义协议但 Fetch 在请求发出前失败。
     只给场景资源加兼容回退；其他 URL 始终走原生 Fetch。 */
  function installSceneFetch() {
    if (window.__mhubWpSceneFetch === '4.0' || typeof window.fetch !== 'function') return;
    var nativeFetch = window.fetch;

    function xhrFetch(input, init) {
      return new Promise(function (resolve, reject) {
        var url = typeof input === 'string' ? input : String(input && input.url || input || '');
        var options = init || {};
        var signal = options.signal || input && input.signal;
        if (signal && signal.aborted) {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
          return;
        }
        var xhr = new XMLHttpRequest();
        var method = String(options.method || input && input.method || 'GET').toUpperCase();
        xhr.open(method, url, true);
        xhr.responseType = 'arraybuffer';
        xhr.withCredentials = options.credentials === 'include';
        var headers = new Headers(options.headers || input && input.headers || {});
        headers.forEach(function (value, key) {
          try { xhr.setRequestHeader(key, value); } catch (e) { /* browser-controlled header */ }
        });

        function cleanup() {
          if (signal && typeof signal.removeEventListener === 'function') {
            signal.removeEventListener('abort', aborted);
          }
        }

        function aborted() {
          try { xhr.abort(); } catch (e) { /* ignore */ }
          cleanup();
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        }

        xhr.onload = function () {
          cleanup();
          var status = xhr.status === 1223 ? 204 : xhr.status;
          if (!status) {
            reject(new TypeError('Failed to fetch'));
            return;
          }
          var responseHeaders = new Headers();
          var lines = String(xhr.getAllResponseHeaders() || '').split(/\r?\n/);
          for (var i = 0; i < lines.length; i++) {
            var pos = lines[i].indexOf(':');
            if (pos > 0) responseHeaders.append(lines[i].slice(0, pos).trim(), lines[i].slice(pos + 1).trim());
          }
          var body = status === 204 || status === 304 || method === 'HEAD' ? null : xhr.response;
          resolve(new Response(body, { status: status, statusText: xhr.statusText || '', headers: responseHeaders }));
        };
        xhr.onerror = function () { cleanup(); reject(new TypeError('Failed to fetch')); };
        xhr.ontimeout = function () { cleanup(); reject(new TypeError('Scene request timed out')); };
        if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', aborted, { once: true });
        xhr.send(options.body || null);
      });
    }

    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : String(input && input.url || input || '');
      if (!/^mchose-wallpaper:\/\/scene\//i.test(url)) return nativeFetch.apply(this, arguments);
      var args = arguments;
      return nativeFetch.apply(this, args).catch(function (error) {
        var signal = init && init.signal || input && input.signal;
        if (error && error.name === 'AbortError' || signal && signal.aborted) throw error;
        return xhrFetch(input, init);
      });
    };
    window.__mhubWpSceneFetch = '4.0';
  }

  installSceneFetch();

  if (window.__mhubWpScene && window.__mhubWpScene.version === '4.0') return;

  var active = null;
  var generation = 0;

  function qualityFor(preset) {
    if (preset === 'saver') return { antiAliasing: 'off', particles: 'low', postProcessing: 'off' };
    if (preset === 'quality') return { antiAliasing: 'fxaa', particles: 'high', postProcessing: 'high' };
    return { antiAliasing: 'off', particles: 'medium', postProcessing: 'medium' };
  }

  function performanceFor(performance) {
    var p = performance || {};
    return {
      fps: Math.min(120, Math.max(5, Number(p.fps) || 30)),
      renderDpr: Math.min(2, Math.max(0.5, Number(p.renderDpr) || 1)),
      videoTexScale: Math.min(1, Math.max(0.25, Number(p.videoTexScale) || 0.75)),
      quality: qualityFor(p.preset)
    };
  }

  function mount(host, media, callbacks) {
    if (active) active.destroy();
    var cb = callbacks || {};
    var session = {
      generation: ++generation,
      host: host,
      media: media,
      instance: null,
      ready: false,
      failed: false,
      destroyed: false,
      paused: false,
      fit: 'cover',
      stage: 'preflight-project',
      performance: performanceFor(media.performance)
    };
    active = session;

    host.style.cssText = 'position:absolute;inset:0;overflow:hidden;opacity:0;transition:opacity .35s ease;pointer-events:none;';

    function alive() {
      return !session.destroyed && active === session && generation === session.generation;
    }

    function errorText(error) {
      return String(error && error.message || error || '场景初始化失败').slice(0, 500);
    }

    function report(stage, detail) {
      if (!alive()) return;
      session.stage = stage;
      if (typeof cb.status === 'function') cb.status(stage, detail || null);
    }

    function stageError(stage, url, message, status) {
      var error = new Error(message);
      error.stage = stage;
      error.url = url || '';
      if (status !== undefined) error.status = status;
      return error;
    }

    function fail(error) {
      if (!alive() || session.failed) return;
      session.failed = true;
      var message = errorText(error);
      var stage = error && error.stage || session.stage || 'mount';
      var detail = {
        url: String(error && error.url || '').slice(0, 1000),
        status: error && error.status
      };
      session.destroy();
      if (typeof cb.error === 'function') cb.error(message, stage, detail);
    }

    function ready(info) {
      if (!alive() || session.failed) return;
      session.ready = true;
      session.stage = 'ready';
      host.style.opacity = '1';
      if (typeof cb.ready === 'function') cb.ready(info || null);
    }

    function checkedResponse(response, stage, url) {
      if (!response.ok) {
        throw stageError(stage, url, 'HTTP ' + response.status + ' ' + String(response.statusText || '').trim(), response.status);
      }
      return response;
    }

    function mountRuntime() {
      if (!alive()) return;
      report('mount');
      var options = Object.assign({
        source: window.WebWallGL.httpSource(media.sceneBase),
        fit: session.fit,
        volume: 0,
        autoplay: !session.paused,
        properties: media.props && typeof media.props === 'object' ? media.props : {},
        onReady: ready,
        onError: fail,
        onDiagnostic: function (message, level) {
          if (level === 'error') fail(stageError('mount', '', errorText(message)));
          else if (typeof cb.diagnostic === 'function') cb.diagnostic(String(message || ''), level);
        }
      }, session.performance);
      var pending = window.WebWallGL.mount(host, options);
      Promise.resolve(pending).then(function (instance) {
        if (!alive()) {
          try { instance.destroy({ releasePkgCache: true }); } catch (e) { /* ignore */ }
          return;
        }
        session.instance = instance;
        session.setFit(session.fit);
        if (session.paused) instance.pause();
      }).catch(fail);
    }

    function preflight() {
      var projectUrl = media.sceneBase + 'project.json';
      var pkgUrl = media.sceneBase + 'scene.pkg';
      report('preflight-project', { url: projectUrl });
      return fetch(projectUrl, { cache: 'no-store', credentials: 'omit' }).then(function (response) {
        checkedResponse(response, 'preflight-project', projectUrl);
        return response.json().catch(function () {
          throw stageError('preflight-project', projectUrl, 'project.json 不是有效 JSON');
        });
      }).then(function (project) {
        if (!project || typeof project !== 'object') {
          throw stageError('preflight-project', projectUrl, 'project.json 内容无效');
        }
        report('preflight-pkg', { url: pkgUrl });
        return fetch(pkgUrl, {
          cache: 'no-store',
          credentials: 'omit',
          headers: { Range: 'bytes=0-0' }
        });
      }).then(function (response) {
        checkedResponse(response, 'preflight-pkg', pkgUrl);
        /* 即使服务端忽略 Range 返回 200，也立即取消主体，避免诊断重复下载大型 scene.pkg。 */
        if (response.body && typeof response.body.cancel === 'function') {
          try { response.body.cancel(); } catch (e) { /* ignore */ }
        }
        mountRuntime();
      }).catch(function (error) {
        if (error && error.stage) throw error;
        var stage = session.stage || 'preflight-project';
        var url = stage === 'preflight-pkg' ? pkgUrl : projectUrl;
        throw stageError(stage, url, errorText(error));
      });
    }

    session.setFit = function (fit) {
      session.fit = fit === 'fill' ? 'stretch' : (fit === 'contain' ? 'contain' : 'cover');
      if (session.instance) {
        try { session.instance.setFit(session.fit); } catch (e) { /* ignore */ }
      }
    };

    session.setPerformance = function (performance) {
      if (!alive()) return;
      session.performance = performanceFor(performance);
      media.performance = performance;
      var instance = session.instance;
      if (!instance) return;
      try { instance.setFps(session.performance.fps); } catch (e) { /* ignore */ }
      try { instance.setRenderDpr(session.performance.renderDpr); } catch (e) { /* ignore */ }
      try { instance.setVideoTexScale(session.performance.videoTexScale); } catch (e) { /* ignore */ }
      try { instance.setQuality(session.performance.quality); } catch (e) { /* ignore */ }
    };

    session.setProperties = function (props) {
      if (!alive() || !props || typeof props !== 'object') return;
      session.properties = Object.assign({}, session.properties, props);
      if (!session.instance) return;
      try { session.instance.setProperties(props); } catch (e) { /* ignore */ }
    };

    session.setPaused = function (paused) {
      session.paused = !!paused;
      if (!session.instance || session.destroyed) return;
      try {
        if (session.paused) session.instance.pause();
        else session.instance.resume();
      } catch (e) { /* ignore */ }
    };

    session.destroy = function () {
      if (session.destroyed) return;
      session.destroyed = true;
      if (active === session) {
        active = null;
        generation++;
      }
      var instance = session.instance;
      session.instance = null;
      if (instance) {
        try { instance.destroy({ releasePkgCache: true }); } catch (e) { /* ignore */ }
      }
      if (host.parentNode) host.parentNode.removeChild(host);
    };

    try {
      if (!window.WebWallGL || typeof window.WebWallGL.mount !== 'function' || typeof window.WebWallGL.httpSource !== 'function') {
        throw stageError('mount', '', '本地 WebWallGL 渲染器未加载');
      }
      if (!media.sceneBase) throw stageError('preflight-project', '', '场景资源地址为空');
      preflight().catch(fail);
    } catch (error) {
      fail(error);
    }
    return session;
  }

  window.__mhubWpScene = {
    version: '4.0',
    mount: mount,
    activeCount: function () { return active && !active.destroyed ? 1 : 0; }
  };
})();
