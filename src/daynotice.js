/* 「一天的起点」的提示逻辑。
 *
 * 背景：日界设成凌晨 N 点（默认 4 点）之后，0:00–N:59 写的东西都算前一天。
 * 这事本身是对的（熬夜到一两点，心里的「今天」还没结束），但**人容易忘**：
 * 凌晨敲字时以为自己记的是「新的一天」，第二天翻日志才发现落在昨天。
 *
 * 所以这里给一句话提示，两种状态：
 *   - cross : 当前时刻在日界之前 → 现在写的算**前一天**，明确说出来
 *   - fresh : 刚过日界不久 → 已经进入新的一天，顺带通知一声
 * 其余时间返回 null，不打扰。
 *
 * 纯函数，日期当参数传，好在测试里把时钟拨来拨去。
 */

/** 「2026-10-11」→ 「10 月 11 日」*/
function niceDate(s) {
  const d = new Date(`${s}T00:00:00`);
  if (Number.isNaN(d.getTime())) return s;
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

/** 刚过日界后还提示多久（分钟）—— 只说「新的一天开始了」，别一直挂着 */
const FRESH_WINDOW_MIN = 60;

/**
 * @param {Date}   now        当前时刻
 * @param {number} dayStart   日界（0–12），默认 4
 * @returns {{kind:'cross'|'fresh', text:string, prev:string, today:string}|null}
 */
export function dayNotice(now, dayStart) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return null;

  // 坏值回落默认 4 点（与主进程 normalizeHour 口径一致）
  let h = Number(dayStart);
  if (!Number.isFinite(h)) h = 4;
  h = Math.max(0, Math.min(12, Math.floor(h)));

  const mins = now.getHours() * 60 + now.getMinutes();
  const cut = h * 60;

  // 日界为 0 时没有「跨日」这一说，永远是新的一天
  if (h === 0) return null;

  // 当天 0:00 – 日界：写的算前一天
  if (mins < cut) {
    const prev = new Date(now);
    prev.setDate(prev.getDate() - 1);
    const today = new Date(now);
    const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return {
      kind: 'cross',
      prev: fmt(prev),
      today: fmt(today),
      text: `现在写的算 ${niceDate(fmt(prev))}（还没到 ${h} 点，这一天还没翻页）`,
    };
  }

  // 刚过日界的一小时内：提醒「新的一天开始了」
  if (mins < cut + FRESH_WINDOW_MIN) {
    const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return {
      kind: 'fresh',
      prev: '',
      today: fmt(now),
      text: `已过 ${h} 点，新的一天开始了`,
    };
  }

  return null;
}
