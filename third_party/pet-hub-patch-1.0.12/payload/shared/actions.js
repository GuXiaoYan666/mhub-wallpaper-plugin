(function (factory) {
  const table = factory();
  if (typeof window !== 'undefined') window.PetActions = table;
  if (typeof module === 'object' && module.exports && typeof require === 'function' && typeof require.resolve === 'function') module.exports = table;
})(function () {
  const FRAME_WIDTH = 192;
  const FRAME_HEIGHT = 208;
  const ATLAS_COLUMNS = 8;
  const ATLAS_ROWS = 9;

  const ACTIONS = [
    { id: 'idle', label: '待机', en: 'Idle', durations: [280, 110, 110, 140, 140, 320] },
    { id: 'running-right', label: '向右跑', en: 'Run right', durations: [120, 120, 120, 120, 120, 120, 120, 220] },
    { id: 'running-left', label: '向左跑', en: 'Run left', durations: [120, 120, 120, 120, 120, 120, 120, 220] },
    { id: 'waving', label: '挥手', en: 'Wave', durations: [140, 140, 140, 280] },
    { id: 'jumping', label: '跳跃', en: 'Jump', durations: [140, 140, 140, 140, 280] },
    { id: 'failed', label: '失败', en: 'Fail', durations: [140, 140, 140, 140, 140, 140, 140, 240] },
    { id: 'waiting', label: '等待', en: 'Wait', durations: [150, 150, 150, 150, 150, 260] },
    { id: 'running', label: '实验', en: 'Experiment', durations: [120, 120, 120, 120, 120, 220] },
    { id: 'review', label: '查阅', en: 'Lookup', durations: [150, 150, 150, 150, 150, 280] }
  ];

  const AUTO_ACTIONS = ACTIONS.map(function (action) { return action.id; });

  function pickAuto(current, random) {
    const choices = AUTO_ACTIONS.filter(function (id) { return id !== current; });
    const sample = typeof random === 'function' ? random() : Math.random();
    const ratio = Number.isFinite(sample) ? Math.max(0, Math.min(0.999999999, sample)) : 0;
    return choices[Math.floor(ratio * choices.length)];
  }

  function rowOf(id) {
    for (let i = 0; i < ACTIONS.length; i += 1) {
      if (ACTIONS[i].id === id) return i;
    }
    return -1;
  }

  function durationOf(id) {
    const row = rowOf(id);
    if (row < 0) return 0;
    return ACTIONS[row].durations.reduce(function (sum, ms) { return sum + ms; }, 0);
  }

  function frameFor(id, elapsed) {
    const row = Math.max(0, rowOf(id));
    const durations = ACTIONS[row].durations;
    const total = durations.reduce(function (sum, ms) { return sum + ms; }, 0);
    const ms = typeof elapsed === 'number' && isFinite(elapsed) ? Math.max(0, elapsed) : 0;
    let rest = ms % total;
    let col = 0;
    while (col < durations.length - 1 && rest >= durations[col]) {
      rest -= durations[col];
      col += 1;
    }
    return { row: row, col: col, x: FRAME_WIDTH * col, y: FRAME_HEIGHT * row };
  }

  function sourceScale(image) {
    const width = image && (image.naturalWidth || image.width), height = image && (image.naturalHeight || image.height);
    return [1, 2, 4].find(scale => width === 1536 * scale && height === 1872 * scale) || 1;
  }

  Object.defineProperties(ACTIONS, {
    AUTO_MIN_MS: { value: 20000 },
    AUTO_MAX_MS: { value: 28000 },
    AUTO_ACTIONS: { value: AUTO_ACTIONS },
    pickAuto: { value: pickAuto },
    FRAME_WIDTH: { value: FRAME_WIDTH },
    FRAME_HEIGHT: { value: FRAME_HEIGHT },
    ATLAS_COLUMNS: { value: ATLAS_COLUMNS },
    ATLAS_ROWS: { value: ATLAS_ROWS },
    rowOf: { value: rowOf },
    durationOf: { value: durationOf },
    frameFor: { value: frameFor },
    sourceScale: { value: sourceScale },
    has: { value: function (id) { return rowOf(id) >= 0; } }
  });

  return ACTIONS;
});
