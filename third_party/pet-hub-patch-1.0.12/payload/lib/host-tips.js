'use strict';

// 解析宿主全局 store 广播的 tipsWindowHtmlMap：DPI、板载、锁定键、低电量和音频通知。
// 本模块只处理文本，不打开设备；实际设备状态由 host-state.js 读取驱动摘要并做差异判断。

// 宿主只在 key 等于这个值的变更里携带通知内容。
const TIPS_KEY = 'tipsWindowHtmlMap';
// 只记住最近 20 个 tip id：同一个 id 只播一次，溢出窗口的老 id 才会再次放行（宿主从不复用它）。
const DEDUPE_LIMIT = 20;

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  middot: '·',
  hellip: '…',
  times: '×',
  deg: '°'
};

const STAGE_ZH = /档位\s*(\d{1,2})/;
// 宿主语言包可能回落到英文，档位英文用 profile/stage/level 兜底。
const STAGE_EN = /\b(?:profile|stage|level)\s*(\d{1,2})/i;
// 正文形如「已切换为档位4【3200】」：全角方括号是主格式，半角与「3200DPI」只是兜底。
const DPI_BRACKET = /【\s*(\d{2,5})\s*】/;
const DPI_SQUARE = /\[\s*(\d{2,5})\s*\]/;
const DPI_SUFFIX = /(\d{3,5})\s*DPI/i;
// 同一条广播还承载别的 autoBoardTip，靠标题关键词区分，不能一律当成 DPI 事件。
const DPI_HINT = /dpi|灵敏度/i;

function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, function (match, body) {
    const key = String(body).toLowerCase();
    if (key.charAt(0) === '#') {
      const code = key.charAt(1) === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      return String.fromCodePoint(code);
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : match;
  });
}

function htmlToText(html) {
  if (typeof html !== 'string' || !html) return '';
  // 整段丢掉 style/script：里面常带大括号和数字，会污染档位/DPI 的匹配。
  const stripped = html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    // 标签一律换空格而不是直接删除，否则相邻文本会粘连成另一个数字。
    .replace(/<[^>]*>/g, ' ');
  return decodeEntities(stripped).replace(/\s+/g, ' ').trim();
}

function firstNumber(re, text) {
  const found = re.exec(text);
  return found ? Number(found[1]) : null;
}

function parseDpiText(text) {
  const clean = typeof text === 'string' ? text : '';
  if (!clean) return { isDpi: false, stage: null, dpi: null };
  let stage = firstNumber(STAGE_ZH, clean);
  if (stage === null) stage = firstNumber(STAGE_EN, clean);
  let dpi = firstNumber(DPI_BRACKET, clean);
  if (dpi === null) dpi = firstNumber(DPI_SQUARE, clean);
  if (dpi === null) dpi = firstNumber(DPI_SUFFIX, clean);
  return { isDpi: DPI_HINT.test(clean), stage: stage, dpi: dpi };
}

// 文案沿用设备播报风格（「灯效：呼吸 · #00A0FF」）：解析缺项就降级，绝不整条丢弃。
function dpiText(stage, dpi) {
  const hasStage = Number.isFinite(stage) && stage > 0;
  const hasDpi = Number.isFinite(dpi) && dpi > 0;
  if (hasStage && hasDpi) return 'DPI：档位 ' + stage + ' · ' + dpi;
  if (hasStage) return 'DPI：档位 ' + stage;
  if (hasDpi) return 'DPI：' + dpi;
  return 'DPI 已切换';
}

// previousIds 允许传数组、Set 或 oldValue 本身，调用方不必先 Object.keys。
function idSet(raw) {
  if (raw instanceof Set) return raw;
  if (Array.isArray(raw)) return new Set(raw);
  if (raw && typeof raw === 'object') return new Set(Object.keys(raw));
  return new Set();
}

// value 里新出现的 id 才算新事件：通知关闭时 value 变 {}，只剩下 oldValue，这里自然为空。
function extractTips(previousIds, valueMap) {
  const prev = idSet(previousIds);
  const out = [];
  if (!valueMap || typeof valueMap !== 'object') return out;
  Object.keys(valueMap).forEach(function (id) {
    if (prev.has(id)) return;
    const html = valueMap[id];
    if (typeof html !== 'string' || !html) return;
    const text = htmlToText(html);
    const parsed = parseDpiText(text);
    out.push({
      id: id,
      text: text,
      isDpi: parsed.isDpi,
      stage: parsed.stage,
      dpi: parsed.dpi,
      bubble: parsed.isDpi ? dpiText(parsed.stage, parsed.dpi) : ''
    });
  });
  return out;
}

function extractDpiTips(previousIds, valueMap) {
  return extractTips(previousIds, valueMap)
    .filter(function (tip) { return tip.isDpi === true; })
    .map(function (tip) { return { id: tip.id, stage: tip.stage, dpi: tip.dpi, text: tip.bubble }; });
}

// Classify the driver's own notification text; preserve its wording except for
// the existing compact DPI format. Unrelated update/account notices are ignored.
function classifyTip(tip) {
  const text = tip && tip.text || '';
  if (!text) return null;
  let type = /键盘|keyboard|Caps\s*Lock|Num\s*Lock|Scroll\s*Lock|大小写|数字锁|滚动锁/i.test(text) ? 'keyboard'
    : /鼠标|mouse|DPI|灵敏度/i.test(text) ? 'mouse'
      : /音箱|音响|speaker|K20\s*(?:GT|PRO)/i.test(text) ? 'speaker'
      : /耳机|headset/i.test(text) ? 'headset' : 'unknown';
  let kind = '', action = 'review';
  if (tip.isDpi) kind = 'dpi';
  else if (/低电量|电量不足|低电池|low\s*(?:battery|power)|battery.*low/i.test(text)) { kind = 'battery'; action = 'waiting'; }
  else if (/Caps\s*Lock|Num\s*Lock|Scroll\s*Lock|大小写锁|数字锁|滚动锁/i.test(text)) { kind = 'config'; type = 'keyboard'; }
  else if (/板载|on[- ]?board|\bprofile\b|(?:切换|switch).{0,12}(?:配置|configuration)/i.test(text)) kind = 'profile';
  else if (/断开|已连接|重新连接|disconnected|connected/i.test(text)) { kind = 'connection'; action = /断开|disconnected/i.test(text) ? 'waiting' : 'waving'; }
  else if (/麦克风|microphone|\bmic\b/i.test(text)) { kind = 'mic'; if (type === 'unknown') type = 'audio'; }
  else if (/\bEQ\b|均衡器/i.test(text)) { kind = 'eq'; if (type === 'unknown') type = 'audio'; }
  else if (/音量|volume/i.test(text)) { kind = 'volume'; if (type === 'unknown') type = 'audio'; }
  if (!kind) return null;
  const failed = /失败|failed|failure|error/i.test(text);
  return { kind, action: failed ? 'failed' : action, type, result: failed ? 'failed' : 'confirmed', text: tip.isDpi ? tip.bubble : text, critical: kind === 'battery',
    connected: kind === 'connection' ? !/断开|disconnected/i.test(text) : undefined };
}

// 宿主会把还活着的通知留在 value 里反复下发（oldValue 只带被替换的那一条），所以按 id 去重。
function createDedupe(limit) {
  const size = Number(limit) > 0 ? Math.floor(Number(limit)) : DEDUPE_LIMIT;
  const order = [];
  const seen = new Set();
  return {
    // 返回 true 表示首次见到并已记住；空 id 直接当重复，绝不播报。
    fresh: function (id) {
      const key = typeof id === 'string' ? id.trim() : '';
      if (!key || seen.has(key)) return false;
      seen.add(key);
      order.push(key);
      while (order.length > size) seen.delete(order.shift());
      return true;
    },
    size: function () { return order.length; },
    ids: function () { return order.slice(); }
  };
}

module.exports = {
  TIPS_KEY,
  DEDUPE_LIMIT,
  decodeEntities,
  htmlToText,
  parseDpiText,
  dpiText,
  extractTips,
  extractDpiTips,
  classifyTip,
  createDedupe
};
