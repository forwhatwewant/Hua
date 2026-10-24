'use strict';
/* 周程：一周的边界、逐日负荷、偏重判定。
 *
 * 纯函数，可单独测（和 day.cjs / sleep.cjs 一个路子）。
 * 周的定义**复用 journal 的 ISO 周**（周一开头）—— 周文件就是按这个切的，
 * 两处必须一致，否则「周程」里看到的周和落盘的周文件会差一天。
 */

const journal = require('./journal.cjs');

/* 偏重判定：某天合计 >= 2 小时，且 >= 有安排的天的平均值的 1.5 倍。
   两个条件都要满足 —— 只比值的话，「一周就排了一天、那天 1 小时」也会被标成偏重，
   那是噪音不是信号。 */
const HEAVY_MIN_MINUTES = 120;
const HEAVY_RATIO = 1.5;
/* 有安排的天少于这个数就不标偏重：样本太小，平均值没有意义 */
const HEAVY_MIN_ACTIVE_DAYS = 3;

/** 这一天所在周的周一 */
function weekStartOf(dateStr) {
  return journal.weekDays(dateStr)[0];
}

/** 周整体前后挪 n 周，返回那一周的周一 */
function shiftWeek(weekStart, n) {
  return weekStartOf(journal.addDays(weekStart, n * 7));
}

/** 这一周的第几天（0=周一 … 6=周日）。用于「周几」的显示，不碰系统日期。 */
function weekdayIndex(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  return (d.getDay() + 6) % 7;   // JS 里 0=周日，挪成 0=周一
}

/** 一条事项占多少分钟。优先「预计」；已完成且填了实际耗时的，用实际。 */
function itemMinutes(it) {
  if (!it) return 0;
  if (it.status === 'done' && it.actualMinutes) return it.actualMinutes;
  return it.estMinutes || 0;
}

/** 一组事项的合计分钟 */
function loadOf(items) {
  return (items || []).reduce((sum, it) => sum + itemMinutes(it), 0);
}

/**
 * 给这一周算负荷。
 * @param {string[]} days        7 个日期（周一起）
 * @param {Object}   itemsByDate { 'YYYY-MM-DD': [item, ...] }
 * @returns {{perDay: Object, total: number, avg: number, heavy: string[], activeDays: number}}
 */
function analyze(days, itemsByDate) {
  const perDay = {};
  for (const d of days) perDay[d] = loadOf(itemsByDate[d]);

  const active = days.filter((d) => perDay[d] > 0);
  const total = days.reduce((sum, d) => sum + perDay[d], 0);
  // 平均值只按「有安排的天」算 —— 把 0 也算进去的话，空着的天会把均值压低，
  // 于是「排了两件事的那天」也成了偏重。
  const avg = active.length ? Math.round(total / active.length) : 0;

  const heavy = [];
  if (active.length >= HEAVY_MIN_ACTIVE_DAYS) {
    for (const d of days) {
      const m = perDay[d];
      if (m >= HEAVY_MIN_MINUTES && m >= avg * HEAVY_RATIO) heavy.push(d);
    }
  }
  return { perDay, total, avg, heavy, activeDays: active.length };
}

module.exports = {
  weekStartOf, shiftWeek, weekdayIndex,
  itemMinutes, loadOf, analyze,
  HEAVY_MIN_MINUTES, HEAVY_RATIO, HEAVY_MIN_ACTIVE_DAYS
};
