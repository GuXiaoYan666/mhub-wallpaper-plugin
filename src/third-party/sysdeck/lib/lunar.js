'use strict';
// 农历 / 节气 / 节日计算 —— 纯本地，无网络依赖，无外部库。
// 数据表来自经典 calendar.js 数据集（solarlunar 3.1.0 程序化提取，1900-2100，见 lunar-data.js）。
// 所有函数纯计算、可缓存；输入异常返回 null，绝不抛出。

var DATA = require('./lunar-data.js');
var LUNAR_INFO = DATA.LUNAR_INFO;
var TERM_INFO = DATA.TERM_INFO;

var MONTH_CN = ['正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '冬', '腊'];
var DAY_CN = [
  '初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
  '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十'
];
var DIGIT_CN = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
var STEMS = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];
var BRANCHES = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];
var ANIMALS = ['鼠', '牛', '虎', '兔', '龙', '蛇', '马', '羊', '猴', '鸡', '狗', '猪'];

// 节气名，n=1..24（传统顺序），月 = ceil(n/2)
var TERM_NAMES = [
  '小寒', '大寒', '立春', '雨水', '惊蛰', '春分', '清明', '谷雨',
  '立夏', '小满', '芒种', '夏至', '小暑', '大暑', '立秋', '处暑',
  '白露', '秋分', '寒露', '霜降', '立冬', '小雪', '大雪', '冬至'
];

// ---------- 农历核心 ----------

function leapMonth(y) { return LUNAR_INFO[y - 1900] & 0xf; }

function leapDays(y) {
  if (leapMonth(y)) return (LUNAR_INFO[y - 1900] & 0x10000) ? 30 : 29;
  return 0;
}

function monthDays(y, m) { return (LUNAR_INFO[y - 1900] & (0x10000 >> m)) ? 30 : 29; }

function lunarYearDays(y) {
  var sum = 348;
  for (var i = 0x8000; i > 0x8; i >>= 1) sum += (LUNAR_INFO[y - 1900] & i) ? 1 : 0;
  return sum + leapDays(y);
}

function yearCnNum(y) {
  var s = String(y), out = '';
  for (var i = 0; i < s.length; i++) out += DIGIT_CN[Number(s.charAt(i))];
  return out;
}

// 公历 → 农历（公历 Date 或 Y/M/D）。范围 1901-2099，越界/异常返回 null。
function solarToLunar(Y, M, D) {
  if (Y === undefined) return null;
  if (M === undefined) { try { M = Y.getMonth() + 1; D = Y.getDate(); Y = Y.getFullYear(); } catch (e) { return null; } }
  Y = Math.floor(Y); M = Math.floor(M); D = Math.floor(D);
  if (Y < 1901 || Y > 2099 || M < 1 || M > 12 || D < 1 || D > 31) return null;
  var offset;
  try { offset = Math.floor((Date.UTC(Y, M - 1, D) - Date.UTC(1900, 0, 31)) / 86400000); }
  catch (e) { return null; }
  if (!(offset >= 0)) return null;

  var y = 1900, temp = 0;
  for (; y < 2101 && offset > 0; y++) { temp = lunarYearDays(y); offset -= temp; }
  if (offset < 0) { offset += temp; y--; }
  if (y > 2100) return null;
  var lunarYear = y;

  var leap = leapMonth(y);
  var isLeap = false;
  var lunarMonth = 1;
  for (; lunarMonth < 13 && offset > 0; lunarMonth++) {
    if (leap > 0 && lunarMonth === leap + 1 && !isLeap) { --lunarMonth; isLeap = true; temp = leapDays(y); }
    else { temp = monthDays(y, lunarMonth); }
    if (isLeap && lunarMonth === leap + 1) isLeap = false;
    offset -= temp;
  }
  if (offset === 0 && leap > 0 && lunarMonth === leap + 1) {
    if (isLeap) { isLeap = false; }
    else { isLeap = true; --lunarMonth; }
  }
  if (offset < 0) { offset += temp; --lunarMonth; }
  var lunarDay = offset + 1;
  if (lunarMonth < 1 || lunarMonth > 12 || lunarDay < 1 || lunarDay > 30) return null;

  var ganZhi = STEMS[(lunarYear - 4) % 10] + BRANCHES[(lunarYear - 4) % 12];
  return {
    year: lunarYear,
    month: lunarMonth,
    day: lunarDay,
    isLeap: isLeap,
    monthCn: (isLeap ? '闰' : '') + MONTH_CN[lunarMonth - 1] + '月',
    dayCn: DAY_CN[lunarDay - 1],
    yearCn: yearCnNum(lunarYear),
    ganZhi: ganZhi,
    animal: ANIMALS[(lunarYear - 4) % 12]
  };
}

// ---------- 节气（表驱动） ----------
// 年内 24 节气：[{name, month, day}]。TERM_INFO 每年 30 个 hex 位编码 24 个“日”，月=ceil(n/2)。

var termCache = { year: 0, list: null, map: null };

function termsOfYear(Y) {
  Y = Math.floor(Y);
  if (Y < 1901 || Y > 2099) return null;
  if (termCache.year !== Y) {
    var hex = TERM_INFO[Y - 1900];
    var list = [];
    for (var n = 1; n <= 24; n++) {
      // 30 个 hex 位 = 6 组 × 5 位；每组编码 4 个节气日：
      // 组内位置 0/2 → 单字符日（substr 0 / 3），位置 1/3 → 两位数日（substr 1 / 4）
      var g = Math.floor((n - 1) / 4);
      var info = String(parseInt('0x' + hex.substr(g * 5, 5), 16));
      var pos = (n - 1) % 4;
      // 组内布局：[D1(1位) D2(2位) D3(1位) D4(2位)] → substr 0/1/3/4
      var dayStr = (pos === 0) ? info.substr(0, 1)
        : (pos === 1) ? info.substr(1, 2)
        : (pos === 2) ? info.substr(3, 1)
        : info.substr(4, 2);
      var day = parseInt(dayStr, 10);
      var month = Math.ceil(n / 2);
      list.push({ name: TERM_NAMES[n - 1], month: month, day: day });
    }
    var map = {};
    for (var i = 0; i < list.length; i++) map[list[i].month + '-' + list[i].day] = list[i].name;
    termCache = { year: Y, list: list, map: map };
  }
  return termCache.list;
}

function termOn(Y, M, D) {
  if (!termsOfYear(Y)) return null;
  return termCache.map[M + '-' + D] || null;
}

// ---------- 节日 ----------

var SOLAR_FESTS = {
  '1-1': ['元旦', '🎉'], '2-14': ['情人节', '💗'], '3-8': ['妇女节', '🌷'],
  '3-12': ['植树节', '🌱'], '4-1': ['愚人节', '🎭'], '5-1': ['劳动节', '🛠️'],
  '5-4': ['青年节', '⚡'], '6-1': ['儿童节', '🎈'], '7-1': ['建党节', '🚩'],
  '8-1': ['建军节', '🎖️'], '9-10': ['教师节', '📖'], '10-1': ['国庆节', '🇨🇳'],
  '12-24': ['平安夜', '🍎'], '12-25': ['圣诞节', '🎄']
};

var LUNAR_FESTS = {
  '1-1': ['春节', '🧧'], '1-15': ['元宵节', '🏮'], '2-2': ['龙抬头', '🐉'],
  '5-5': ['端午节', '🐲'], '7-7': ['七夕', '💞'], '7-15': ['中元节', '🕯️'],
  '8-15': ['中秋节', '🥮'], '9-9': ['重阳节', '🍂'], '12-8': ['腊八节', '🥣']
};

// 除夕精确判断：明天是否正月初一
function isChuxi(Y, M, D) {
  var t = new Date(Date.UTC(Y, M - 1, D + 1));
  var n = solarToLunar(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
  return !!(n && n.month === 1 && n.day === 1 && !n.isLeap);
}

function festivalOf(lunar, Y, M, D) {
  // 农历节日优先
  if (lunar && !lunar.isLeap) {
    var k = lunar.month + '-' + lunar.day;
    if (LUNAR_FESTS[k]) return { name: LUNAR_FESTS[k][0], icon: LUNAR_FESTS[k][1], lunar: true };
  }
  if (Y !== undefined) {
    var sk = M + '-' + D;
    if (SOLAR_FESTS[sk]) return { name: SOLAR_FESTS[sk][0], icon: SOLAR_FESTS[sk][1], lunar: false };
  }
  return null;
}

// ---------- 对外主接口 ----------

// date → { text, yearText, monthCn, dayCn, animal, ganZhi, yearCn, term, festival, badge, badgeIcon }
function describe(date) {
  try {
    var Y = date.getFullYear(), M = date.getMonth() + 1, D = date.getDate();
    var lu = solarToLunar(Y, M, D);
    if (!lu) return null;
    var term = termOn(Y, M, D);
    var fest = festivalOf(lu, Y, M, D);
    if (!fest && isChuxi(Y, M, D)) fest = { name: '除夕', icon: '🧨', lunar: true };
    var badge = null, badgeIcon = null;
    if (fest) { badge = fest.name; badgeIcon = fest.icon; }
    else if (term) { badge = term; badgeIcon = '❄'; }
    return {
      text: lu.monthCn + lu.dayCn,
      yearText: lu.yearCn + '年 · ' + lu.ganZhi + lu.animal,
      monthCn: lu.monthCn, dayCn: lu.dayCn,
      animal: lu.animal, ganZhi: lu.ganZhi, yearCn: lu.yearCn,
      term: term, festival: fest ? fest.name : null,
      badge: badge, badgeIcon: badgeIcon
    };
  } catch (e) { return null; }
}

module.exports = {
  solarToLunar: solarToLunar,
  termsOfYear: termsOfYear,
  termOn: termOn,
  describe: describe,
  isChuxi: isChuxi
};
