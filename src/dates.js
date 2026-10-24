/* 日期小工具。之前 Today.jsx 里有一份，睡眠页也要用，抽出来免得再抄一遍。 */

/** YYYY-MM-DD 加减天数（本地时区，不碰 UTC） */
export function shift(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** ISO 时间串 → 「10/17 12:30」。空值 / 解析不了都返回空串，交给调用方决定要不要显示。 */
export function fmtWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 睡眠记录存的是「醒来那天」，显示成「10/16 晚 → 10/17 晨」这一段，避免「17 号还没到」的歧义。 */
export function nightLabel(wakeDate) {
  const bed = shift(wakeDate, -1);
  const md = (s) => `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}`;
  return `${md(bed)} 晚 → ${md(wakeDate)} 晨`;
}

/** 两个 ISO 时间相差几个日历日（10/19 → 10/21 = 2）。用来算「这篇日纪跨了几天」。 */
export function daySpan(fromIso, toIso) {
  if (!fromIso || !toIso) return 0;
  const a = new Date(fromIso);
  const b = new Date(toIso);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
  const d1 = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const d2 = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.max(0, Math.round((d2 - d1) / 86400000));
}
