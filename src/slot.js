/* 事项的「时段」：上午 / 下午 / 晚上。
   两种来源：显式指定的 slot，或者从开始时间推出来 —— 让「填了 14:00」的人不用再点一次。 */

export const SLOTS = [
  { key: 'am', label: '上午' },
  { key: 'pm', label: '下午' },
  { key: 'eve', label: '晚上' }
];

export const SLOT_NONE = { key: '', label: '未安排' };

/** 所有分组的显示顺序：上午 → 下午 → 晚上 → 未安排（没安排的排在最后） */
export const SLOT_GROUPS = [...SLOTS, SLOT_NONE];

/**
 * 这条事项属于哪个时段。
 * 显式 slot 优先；否则按开始时间推；两者都没有就是 ''（未安排）。
 * 0–5 点算晚上（熬夜），别把凌晨两点算成上午。
 */
export function slotOf(it) {
  if (!it) return '';
  if (it.slot === 'am' || it.slot === 'pm' || it.slot === 'eve') return it.slot;
  const t = it.startTime;
  if (!t) return '';
  const h = Number(String(t).slice(0, 2));
  if (!Number.isFinite(h)) return '';
  if (h >= 5 && h < 12) return 'am';
  if (h >= 12 && h < 18) return 'pm';
  return 'eve';
}

/** 按时段分组，空组也会返回（调用方自己决定要不要画那一格） */
export function groupBySlot(items) {
  return SLOT_GROUPS.map((g) => ({
    ...g,
    items: (items || []).filter((it) => slotOf(it) === g.key)
  }));
}
