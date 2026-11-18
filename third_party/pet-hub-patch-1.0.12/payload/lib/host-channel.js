'use strict';

const { projectDevices } = require('./host-state.js');
const DEVICE_KEY = 'webIndexList';
const TIP_KEY = 'tipsWindowHtmlMap';

function pickTips(raw) {
  const out = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) Object.keys(raw).slice(-64).forEach(key => {
    if (typeof raw[key] === 'string') out[key] = raw[key].slice(0, 16000);
  });
  return out;
}

// Use the host's public subscription, never a HID handle or a second device SDK.
function subscribe(options) {
  const { ipc, onDevices, onTips } = options;
  const warn = options.warn || function () {};
  const schedule = options.setTimeout || setTimeout, cancel = options.clearTimeout || clearTimeout;
  let stopped = false, seeded = false, listenerId = null, timer = null, attempt = 0;
  let generation = 0;
  function status(state, reason) { if (options.onStatus) options.onStatus({ state, reason: reason || '', attempt, at: Date.now() }); }
  function devices(raw, initial) {
    const value = projectDevices(raw);
    if (!value || stopped) return;
    onDevices({ value, initial: initial || !seeded });
    seeded = true;
    status('connected');
  }
  function change(_event, payload) {
    if (stopped) return;
    const data = payload && payload.changeData;
    if (!data || typeof data !== 'object') return;
    if (data.key === DEVICE_KEY) devices(data.value, false);
    else if (data.key === TIP_KEY) onTips({ value: pickTips(data.value), oldValue: pickTips(data.oldValue) });
  }
  async function start() {
    const current = ++generation;
    status('connecting');
    try {
      const result = await ipc.invoke('watchAllStore');
      if (!result || result.success !== true) throw new Error('host subscription unavailable');
      if (stopped || current !== generation) { if (result.listenerId != null) await ipc.invoke('unwatchAllStore', result.listenerId); return; }
      listenerId = result.listenerId;
      const resultState = await ipc.invoke('getStore', DEVICE_KEY, []);
      if (current !== generation || stopped) return;
      // An event arriving before the initial read owns the newer baseline.
      if (!seeded) {
        const raw = resultState && resultState.success !== false ? (Array.isArray(resultState) ? resultState : resultState.value) : null;
        if (!projectDevices(raw)) throw new Error('host initial state unavailable');
        devices(raw, true);
      }
      attempt = 0;
    } catch (error) {
      if (stopped || current !== generation) return;
      if (listenerId != null) { try { await ipc.invoke('unwatchAllStore', listenerId); } catch (_) {} listenerId = null; }
      if (++attempt <= 3) { status('retrying', 'initial-read'); timer = schedule(start, 250 * attempt); }
      else { status('failed', 'initial-read'); warn(error); }
    }
  }
  ipc.on('storeChange', change);
  start();
  return {
    reconnect() {
      if (stopped) return false;
      generation++;
      if (timer) { cancel(timer); timer = null; }
      if (listenerId != null) { try { Promise.resolve(ipc.invoke('unwatchAllStore', listenerId)).catch(warn); } catch (_) {} listenerId = null; }
      seeded = false; attempt = 0; start(); return true;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      generation++; status('disconnected');
      if (timer) cancel(timer);
      ipc.removeListener('storeChange', change);
      if (listenerId != null) { try { Promise.resolve(ipc.invoke('unwatchAllStore', listenerId)).catch(warn); } catch (error) { warn(error); } }
      listenerId = null;
    }
  };
}

module.exports = { DEVICE_KEY, TIP_KEY, subscribe, pickTips };
