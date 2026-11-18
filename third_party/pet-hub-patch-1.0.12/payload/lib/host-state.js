'use strict';

// Only project the driver's device summary. Macros, account data and SDK objects
// never cross this bridge. MHUB types 1/4 are keyboard/speaker respectively.
function deviceType(device) {
  const raw = device && device.deviceType;
  if (raw === 1 || raw === 'keyboard') return 'keyboard';
  if (raw === 4 || raw === 'speaker') return 'speaker';
  if (raw === 'headset') return 'headset';
  if (raw === 'mouse' || (device && device.mouseType !== undefined)) return 'mouse';
  const name = String(device && (device.deviceName || device.productName) || '');
  if (/speaker|音箱|音响|K20\b/i.test(name)) return 'speaker';
  if (/headset|耳机/i.test(name)) return 'headset';
  if (/mouse|鼠标|\bK5\b/i.test(name)) return 'mouse';
  if (/keyboard|键盘|God\s*\d|\b(?:G|GX|Gx)\d/i.test(name)) return 'keyboard';
  return 'unknown';
}

function finite(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function text(value, max) { return typeof value === 'string' ? value.trim().slice(0, max || 100) : ''; }

function projectDevices(raw) {
  if (!Array.isArray(raw)) return null;
  return raw.slice(0, 128).filter(d => d && typeof d === 'object').map(d => {
    const profile = d.profile && typeof d.profile === 'object' ? d.profile : {};
    const index = finite(profile.index !== undefined ? profile.index : d.profileIndex);
    const detail = Array.isArray(profile.detail) ? profile.detail : [];
    const selected = detail.find(p => p && p.index === index);
    const name = text(d.deviceName || d.productName || d.name);
    return {
      id: text(d.storageKey || d.id) || [d.vendorId, d.productId, name].join(':'),
      name: name,
      deviceType: deviceType(d),
      profileIndex: index,
      profileName: text(selected && selected.name || d.profileName),
      audioMode: finite(d.audioMode !== undefined ? d.audioMode : d.eqModeState !== undefined ? d.eqModeState : d.deviceState && d.deviceState.eqModeState),
      batteryLevel: finite(d.batteryLevel),
      featBattery: typeof d.featBattery === 'boolean' ? d.featBattery : undefined,
      allowUpdateBattery: typeof d.allowUpdateBattery === 'boolean' ? d.allowUpdateBattery : undefined,
      chargeStatus: finite(d.chargeStatus),
      connectMode: typeof d.connectMode === 'number' || typeof d.connectMode === 'string' ? d.connectMode : null
    };
  }).filter(d => d.name && d.id);
}

function createTracker() {
  let previous = null;
  const low = new Set();
  function ingest(raw, initial) {
    const list = projectDevices(raw);
    if (!list) return [];
    const next = new Map(list.map(d => [d.id, d]));
    const events = [];
    const event = (d, kind, message, action) => ({
      kind, device: { id: d.id, type: d.deviceType }, text: d.name + ' · ' + message,
      action, source: 'mhub.driver', result: 'confirmed', priority: 2,
      critical: kind === 'battery'
    });
    next.forEach(d => {
      const before = previous && previous.get(d.id);
      const hasBattery = d.featBattery !== false && d.allowUpdateBattery !== false && d.batteryLevel !== null && d.batteryLevel >= 0 && d.batteryLevel <= 100;
      const isLow = hasBattery && d.batteryLevel <= 10 && !d.chargeStatus;
      if (previous && !initial) {
        if (!before) events.push({ ...event(d, 'connection', '已连接', 'waving'), connected: true });
        else {
          if (before.profileIndex !== null && d.profileIndex !== null && before.profileIndex !== d.profileIndex) {
            events.push(event(d, 'profile', '板载：' + (d.profileName || '档位 ' + (d.profileIndex + 1)), 'review'));
          }
          if (before.connectMode !== null && d.connectMode !== null && before.connectMode !== d.connectMode) events.push(event(d, 'connection', '连接方式已切换', 'waving'));
          if (d.deviceType === 'speaker' && before.audioMode !== null && d.audioMode !== null && before.audioMode !== d.audioMode && [0, 1, 2].includes(d.audioMode)) events.push(event(d, 'mode', '音效模式：' + ['音乐模式', '游戏模式', '电影模式'][d.audioMode], 'review'));
          // Unknown/initial readings are a baseline, never a fabricated battery alert.
          if (isLow && before.batteryLevel !== null && !low.has(d.id)) events.push(event(d, 'battery', '低电量 ' + d.batteryLevel + '%', 'waiting'));
        }
      }
      if (isLow) low.add(d.id);
      else if (!hasBattery || d.batteryLevel > 15 || d.chargeStatus) low.delete(d.id);
    });
    if (previous && !initial) previous.forEach(d => {
      if (!next.has(d.id)) { events.push({ ...event(d, 'connection', '已断开', 'waiting'), connected: false }); low.delete(d.id); }
    });
    previous = next;
    return events;
  }
  return { ingest, devices: () => previous ? Array.from(previous.values()) : [] };
}

module.exports = { deviceType, projectDevices, createTracker };
