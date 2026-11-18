'use strict';

// 等级成长常量与曲线：CURVE_VERSION / Lv1–30 每级所需经验 / 10s 发放冷却 / 5 段称号；对外快照字段与宿主进度条、等级徽章所需的数据对齐，逐值映射与差异见 docs/pet-growth-spec.md

const CURVE_VERSION = 1;
const MAX_LEVEL = 30;
const DEFAULT_AWARD = 1;
const AWARD_COOLDOWN_MS = 10000;
const LEVELUP_MS = 3000;

const TITLES = Object.freeze([
  Object.freeze({ min: 1, max: 4, zh: '初来乍到', en: 'New arrival' }),
  Object.freeze({ min: 5, max: 9, zh: '熟悉伙伴', en: 'Familiar friend' }),
  Object.freeze({ min: 10, max: 19, zh: '默契搭档', en: 'Trusted partner' }),
  Object.freeze({ min: 20, max: 29, zh: '形影不离', en: 'Inseparable' }),
  Object.freeze({ min: 30, max: 30, zh: '最佳拍档', en: 'Best companion' })
]);

function round3(value) {
  return Math.round(value * 1e3) / 1e3;
}

function xpForLevel(level) {
  const current = Number.isFinite(level) ? Math.max(1, Math.floor(level)) : 1;
  if (current >= MAX_LEVEL) return 0;
  return 60 + (current - 1) * 20 + 8 * Math.max(0, current - 9) ** 2;
}

function maxTotalXp() {
  let total = 0;
  for (let level = 1; level < MAX_LEVEL; level += 1) total += xpForLevel(level);
  return total;
}

const MAX_XP = maxTotalXp();

function normalizeLocale(locale) {
  return locale === 'en' ? 'en' : 'zh';
}

function titleIndexForLevel(level) {
  const index = TITLES.findIndex((entry) => level <= entry.max);
  return index === -1 ? TITLES.length - 1 : index;
}

function titleForLevel(level, locale) {
  return TITLES[titleIndexForLevel(level)][normalizeLocale(locale)];
}

function levelForXp(xp, locale) {
  const totalXp = Number.isFinite(xp) ? round3(Math.min(MAX_XP, Math.max(0, xp))) : 0;
  let level = 1;
  let rest = totalXp;
  while (level < MAX_LEVEL && rest >= xpForLevel(level)) {
    rest = round3(rest - xpForLevel(level));
    level += 1;
  }
  const required = xpForLevel(level);
  const titleIndex = titleIndexForLevel(level);
  return {
    level,
    xp: rest,
    xpNext: required,
    required,
    xpProgress: required > 0 ? round3(rest / required) : 1,
    totalXp,
    maxLevel: level === MAX_LEVEL,
    titleIndex,
    title: TITLES[titleIndex][normalizeLocale(locale)]
  };
}

function normalizeAward(amount) {
  if (!Number.isFinite(amount) || !(amount > 0)) return DEFAULT_AWARD;
  return Math.max(0.001, round3(Math.min(MAX_XP, amount)));
}

function normalizeProfile(profile) {
  const source = profile !== null && typeof profile === 'object' ? profile : {};
  const totalXp = Number.isFinite(source.totalXp) ? source.totalXp : 0;
  const lastAwardAt = Number.isFinite(source.lastAwardAt) ? source.lastAwardAt : 0;
  return {
    totalXp: round3(Math.min(MAX_XP, Math.max(0, totalXp))),
    lastAwardAt: Math.max(0, Math.round(lastAwardAt)),
    curveVersion: CURVE_VERSION
  };
}

function DEFAULT_PROFILE() {
  return { totalXp: 0, lastAwardAt: 0, curveVersion: CURVE_VERSION };
}

function awardFor(nowMs, lastAwardAtMs, totalXp) {
  if (!Number.isFinite(nowMs)) return false;
  const last = Number.isFinite(lastAwardAtMs) ? lastAwardAtMs : 0;
  const clampedLast = nowMs < last ? nowMs : last;
  const safeTotal = Number.isFinite(totalXp) ? totalXp : 0;
  if (safeTotal >= MAX_XP) return false;
  return nowMs - clampedLast >= AWARD_COOLDOWN_MS;
}

function createGrowth(profile, locale) {
  const data = normalizeProfile(profile);
  const activeLocale = normalizeLocale(locale);

  function addXp(amount, now) {
    const at = now === undefined ? Date.now() : now;
    if (!Number.isFinite(at)) return false;
    if (at < data.lastAwardAt) data.lastAwardAt = at;
    if (data.totalXp >= MAX_XP) return false;
    if (at - data.lastAwardAt < AWARD_COOLDOWN_MS) return false;
    data.totalXp = round3(Math.min(MAX_XP, data.totalXp + normalizeAward(amount)));
    data.lastAwardAt = at;
    return true;
  }

  function snapshot() {
    const view = levelForXp(data.totalXp, activeLocale);
    return {
      level: view.level,
      xp: view.xp,
      xpNext: view.xpNext,
      xpProgress: view.xpProgress,
      title: view.title,
      titleIndex: view.titleIndex,
      maxLevel: view.maxLevel,
      totalXp: data.totalXp,
      lastAwardAt: data.lastAwardAt,
      curveVersion: data.curveVersion
    };
  }

  return {
    addXp,
    snapshot,
    get level() {
      return levelForXp(data.totalXp, activeLocale).level;
    },
    get title() {
      return titleForLevel(levelForXp(data.totalXp, activeLocale).level, activeLocale);
    }
  };
}

module.exports = {
  createGrowth,
  levelForXp,
  xpForLevel,
  titleForLevel,
  TITLES,
  MAX_XP,
  MAX_LEVEL,
  CURVE_VERSION,
  DEFAULT_AWARD,
  AWARD_COOLDOWN_MS,
  LEVELUP_MS,
  DEFAULT_PROFILE,
  awardFor
};
