/* 完成率的显示文案。
 *
 * 口径（哪些算、哪些不算）在 electron/stats.cjs 一处定义，主进程算好 pct 下发；
 * 这里只负责排版，不重算 —— 免得两处口径漂移。
 */

/** 「58%」；带件数时「7 / 12 件 · 58%」。没有可算的事项时是「—」（不是 0%）。 */
export function rateText(c, { withCounts = false } = {}) {
  if (!c || c.pct === null || c.pct === undefined) return '—';
  return withCounts ? `${c.done} / ${c.total} 件 · ${c.pct}%` : `${c.pct}%`;
}
