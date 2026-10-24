'use strict';
/* 睡眠记录的纯逻辑：时长换算 + 分档。
   抽成单独模块是为了能脱离界面直接测，也免得阈值散落在主进程和渲染层两处。

   分档依据：健康成年人每晚至少 7 小时。低于 7 小时与免疫、心血管、代谢风险相关；
   偶尔超过 9 小时可能是补觉，长期偏多才值得留意。
   来源：Sleep Foundation（NSF 指南）
   https://www.sleepfoundation.org/how-sleep-works/how-much-sleep-do-we-really-need
   核对日期：2026-09-22。阈值以后要改就改这里。 */

const H = 60;

/** 分档：<6 严重不足 / 6–7 偏少 / 7–9 正常 / >9 偏多 */
const BANDS = [
  { key: 'low', max: 6 * H, label: '严重不足', range: '不足 6 小时' },
  { key: 'short', max: 7 * H, label: '偏少', range: '6–7 小时' },
  { key: 'ok', max: 9 * H, label: '正常', range: '7–9 小时' },
  { key: 'long', max: Infinity, label: '偏多', range: '9 小时以上' }
];

/** 少于半小时或多于 20 小时都当填错了 —— 多半是时间点填反了 */
const MIN_MINUTES = 30;
const MAX_MINUTES = 20 * H;

function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * H + mi;
}

/** 入睡 → 起床的时长（分钟）。跨午夜自动加一天；填反了或无效返回 null。 */
function calcMinutes(bed, wake) {
  const b = toMinutes(bed);
  const w = toMinutes(wake);
  if (b === null || w === null) return null;
  let d = w - b;
  if (d <= 0) d += 24 * H;              // 跨午夜：23:40 → 07:10
  if (d < MIN_MINUTES || d > MAX_MINUTES) return null;
  return d;
}

/** 时刻字符串加减分钟，用于算平均入睡时间（会把 23:40 和 00:20 正确平均到 00:00 而不是 12:00） */
function shiftClock(hhmm, delta) {
  const m = toMinutes(hhmm);
  if (m === null) return null;
  return ((m + delta) % (24 * H) + 24 * H) % (24 * H);
}

function bandOf(minutes) {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes)) return null;
  return BANDS.find((b) => minutes < b.max) || BANDS[BANDS.length - 1];
}

/** 「7 小时 30 分」 */
function fmtMinutes(m) {
  if (!m && m !== 0) return '';
  const h = Math.floor(m / H);
  const mi = Math.round(m % H);
  const parts = [];
  if (h) parts.push(`${h} 小时`);
  if (mi || !h) parts.push(`${mi} 分`);
  return parts.join(' ');
}

/** 入睡时间的平均值。入睡时刻跨午夜，直接算术平均会得到「中午 12 点」这种荒唐值，
    所以先把 0:00–12:00 之间的时刻 +24h 挪到午夜之后，再平均、再折回来。 */
function avgClock(times) {
  const mins = times.map(toMinutes).filter((m) => m !== null)
    .map((m) => (m < 12 * H ? m + 24 * H : m));
  if (!mins.length) return '';
  const avg = Math.round(mins.reduce((a, b) => a + b, 0) / mins.length) % (24 * H);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(avg / H))}:${p(avg % H)}`;
}

/** 一组数的中位数。偶数个取中间两个的平均。传入空数组返回 null。 */
function median(nums) {
  const a = (nums || []).filter((x) => Number.isFinite(x)).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2);
}

/** 总体标准差（分钟）。用来衡量「这几天睡得稳不稳」——
    平均值一样的两个人，一个每天 7.5 小时、一个 5/10 小时轮流，
    看平均分不出来，看波动才行。少于 2 条返回 null（一条谈不上波动）。 */
function stdev(nums) {
  const a = (nums || []).filter((x) => Number.isFinite(x));
  if (a.length < 2) return null;
  const mean = a.reduce((s, x) => s + x, 0) / a.length;
  const v = a.reduce((s, x) => s + (x - mean) ** 2, 0) / a.length;
  return Math.round(Math.sqrt(v));
}

/** 入睡时刻的离散程度（分钟）。把跨午夜的时刻统一挪到同一坐标系后再算标准差，
    否则 23:50 和 00:10 只差 20 分钟，直接算术差却是 23 小时 40 分。 */
function bedSpread(records) {
  const mins = (records || [])
    .map((r) => toMinutes(r.bedTime))
    .filter((m) => m !== null)
    .map((m) => (m < 12 * H ? m + 24 * H : m));
  return stdev(mins);
}

/** 汇总一段时间的睡眠记录。返回 null 表示一条都没有。
    「正常率」只算 7–9 小时那一档 —— 跟界面上绿色代表的含义一致，
    比笼统的「达标率」诚实：睡 10 小时不算正常。 */
function summarize(records) {
  const n = (records || []).length;
  if (!n) return null;
  const counts = { low: 0, short: 0, ok: 0, long: 0 };
  let total = 0;
  let longest = 0;
  let shortest = Infinity;
  const list = [];
  for (const r of records) {
    total += r.minutes;
    longest = Math.max(longest, r.minutes);
    shortest = Math.min(shortest, r.minutes);
    list.push(r.minutes);
    const b = bandOf(r.minutes);
    if (b) counts[b.key] += 1;
  }
  const okRate = Math.round((counts.ok / n) * 100);
  const spread = bedSpread(records);
  const sd = stdev(list);
  return {
    count: n,
    avg: Math.round(total / n),
    median: median(list),
    longest,
    shortest,
    counts,
    okRate,
    // 波动（时长标准差），越小越稳
    sd,
    // 入睡时刻离散度，越小说明作息越规律
    bedSpread: spread,
    avgBed: avgClock(records.map((r) => r.bedTime)),
    avgWake: avgClock(records.map((r) => r.wakeTime)),
    // 作息规律度：0–100，把入睡离散度（分钟）折算成分数。
    // 30 分钟以内满分，超过 120 分钟归零 —— 这条曲线是主观约定，只是给个直观抓手。
    regularity: spread === null ? null
      : Math.max(0, Math.min(100, Math.round(100 - ((spread - 30) / 90) * 100)))
  };
}

/** 生成睡眠分析报告的 Markdown 正文。
    放在这里（而不是主进程里）是为了能直接测 —— 报告本身就是交付物，
    埋在 require('electron') 的模块里就没法单独验证了。 */
function buildReport({ from, to, records }) {
  const s = summarize(records);
  const parts = [`# 睡眠分析 ${from} ~ ${to}`, '', `覆盖 ${from} ~ ${to}`];

  if (!s) {
    parts.push('', '这段时间还没有睡眠记录。');
  } else {
    const spanDays = Math.round((new Date(`${to}T00:00:00`) - new Date(`${from}T00:00:00`)) / 86400000) + 1;
    parts.push('', `有记录 ${s.count} 天${spanDays > s.count ? `，缺 ${spanDays - s.count} 天` : ''}`, '');

    parts.push('## 概览', '');
    parts.push(`- 平均时长 **${fmtMinutes(s.avg)}** · 中位数 ${fmtMinutes(s.median)}`);
    parts.push(`- 正常率（7–9 小时）**${s.okRate}%**`);
    parts.push(`- 最长 ${fmtMinutes(s.longest)} · 最短 ${fmtMinutes(s.shortest)} · 波动 ±${fmtMinutes(s.sd)}`);
    parts.push(`- 平均入睡 ${s.avgBed} · 平均起床 ${s.avgWake}`);
    if (s.regularity !== null) {
      parts.push(`- 作息规律度 **${s.regularity} 分**（入睡时刻离散 ±${fmtMinutes(s.bedSpread)}）`);
    }
    parts.push('');

    // 用列表而不是表格：报告正文要直接显示在页面上，而应用自带的 Markdown 转换器
    // 不支持表格（表格会原样显示成一堆竖线）。列表在记事本里也一样好读。
    parts.push('## 分档', '');
    for (const b of BANDS) {
      const n = s.counts[b.key] || 0;
      parts.push(`- ${b.label}（${b.range}）：${n} 天 · ${Math.round((n / s.count) * 100)}%`);
    }
    parts.push('');

    parts.push('## 每日明细', '');
    for (const r of records) {
      const b = bandOf(r.minutes);
      parts.push(`- ${r.date} · ${r.bedTime} → ${r.wakeTime} · ${fmtMinutes(r.minutes)} · ${b ? b.label : ''}`);
    }
    parts.push('');

    const low = records.filter((r) => (bandOf(r.minutes) || {}).key === 'low');
    if (low.length) {
      parts.push('## 不足 6 小时的日子', '');
      for (const r of low) parts.push(`- ${r.date} · ${fmtMinutes(r.minutes)}（${r.bedTime} → ${r.wakeTime}）`);
      parts.push('');
    }
  }

  parts.push('## 判定依据', '');
  parts.push('- 健康成年人每晚至少 **7 小时**；7–9 小时为正常，低于 6 小时属严重不足。');
  parts.push('- 来源：Sleep Foundation（美国国家睡眠基金会指南）· 核对日期 2026-09-22 · 以官网为准。');
  parts.push('- 本报告是机械汇总，不构成医学建议。');

  return parts.join('\n');
}

module.exports = {
  BANDS, MIN_MINUTES, MAX_MINUTES,
  toMinutes, calcMinutes, shiftClock, bandOf, fmtMinutes, avgClock,
  median, stdev, bedSpread, summarize, buildReport
};
