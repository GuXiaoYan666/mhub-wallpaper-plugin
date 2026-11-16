(function () {
  'use strict';
  var W = window;
  try {
    var emit = (console.dir || console.log).bind(console);
    function uplink(msg) { try { emit('[mc-bridge]' + JSON.stringify(msg)); return true; } catch (_) { return false; } }
    if (W.__mcBridgeHost && W.__mcBridgeHost.__installed) {
      W.__mcBridgeHost.send = uplink;
      return;
    }
    var VERSION = 1;
    var subs = [];
    var last = null;
    var PREFIX = '[mc-bridge]';
    function report(where, err) {
      uplink({ t: 'error', where: where, message: String((err && err.message) || err) });
    }
    function call(fn, arg) {
      try { fn(arg); } catch (e) { report('subscriber', e); }
    }
    W.__mcBridge = {
      version: VERSION,
      apply: function (snapshot) {
        last = snapshot;
        for (var i = 0; i < subs.length; i++) call(subs[i], snapshot);
        return true;
      },
      getState: function () { return last; }
    };
    W.__mcBridgeHost = {
      __installed: true,
      version: VERSION,
      onSnapshot: function (fn) {
        if (typeof fn !== 'function') return function () {};
        subs.push(fn);
        if (last) call(fn, last);
        return function () {
          var i = subs.indexOf(fn);
          if (i >= 0) subs.splice(i, 1);
        };
      },
      send: uplink,
      ready: function () { return W.__mcBridgeHost.send({ t: 'ready' }); },
      offline: function () { last = null; }
    };
  } catch (e) {
    try { console.log('[mc-bridge]' + JSON.stringify({ t: 'error', where: 'host', message: String((e && e.message) || e) })); } catch (_) { /* ignore */ }
  }
})();
