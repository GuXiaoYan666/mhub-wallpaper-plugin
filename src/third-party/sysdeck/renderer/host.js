(function () {
  'use strict';
  // 页面侧宿主：只做通道，不碰 DOM。
  // 上行 console.dir('[mc-deck]'+JSON)；下行 window.__mcDeck.apply(snapshot)。
  var W = window;
  try {
    // The production app replaces log/info/warn/error with no-ops after boot.
    // dir remains native; retain its bound reference before any later replacement.
    var emit = (console.dir || console.log).bind(console);
    function uplink(msg) { try { emit('[mc-deck]' + JSON.stringify(msg)); return true; } catch (_) { return false; } }
    if (W.__mcDeckHost && W.__mcDeckHost.__installed) {
      W.__mcDeckHost.send = uplink;
      return;
    }

    var VERSION = 1;
    var subs = [];
    var last = null;
    var PREFIX = '[mc-deck]';

    function report(where, err) {
      uplink({ t: 'error', where: where, message: String((err && err.message) || err) });
    }

    function call(fn, arg) {
      try { fn(arg); } catch (e) { report('subscriber', e); }
    }

    W.__mcDeck = {
      version: VERSION,
      apply: function (snapshot) {
        last = snapshot;
        for (var i = 0; i < subs.length; i++) call(subs[i], snapshot);
        return true;
      },
      getState: function () { return last; }
    };

    W.__mcDeckHost = {
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
      ready: function () { return W.__mcDeckHost.send({ t: 'ready' }); },
      offline: function () { last = null; }
    };
  } catch (e) {
    try { console.dir('[mc-deck]' + JSON.stringify({ t: 'error', where: 'host', message: String((e && e.message) || e) })); } catch (_) { /* ignore */ }
  }
})();
