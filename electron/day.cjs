'use strict';
/* 日期边界（日界）的纯逻辑。
   抽出来是为了能脱离 Electron 直接测 —— 主进程 require('electron') 后就跑不起来了。

   规则：凌晨 dayStartHour 点之前发生的记录，都算「前一天」。
   理由是人不是按零点作息的 —— 熬夜到 1 点还在写日志，那一条属于「还没睡的那一天」，
   落到新的一天会把日记劈成两半。默认 4 点，可在设置里改。
   见 ADR-0004。 */

const pad2 = (n) => String(n).padStart(2, '0');

const DAY_START_DEFAULT = 4;

/** 把配置里的值收成合法的 0–23 整数，坏值回落到默认 */
function normalizeHour(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return DAY_START_DEFAULT;
  return Math.max(0, Math.min(23, n));
}

/** 「今天是哪天」按日界计算。传入 now 便于测试。 */
function effectiveToday(now = new Date(), dayStart = DAY_START_DEFAULT) {
  const d = new Date(now);
  if (d.getHours() < normalizeHour(dayStart)) d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

module.exports = { DAY_START_DEFAULT, pad2, normalizeHour, effectiveToday };
