'use strict';
/* 任务完成率。纯函数，可单独测。
 *
 * 口径：完成率 = 完成 / **全部事项**（完成 + 未完成 + 放弃）。
 * 「放弃」**按未完成计** —— 事情没做完就是没做完，换个说法不该改变这个事实。
 * 真正不计入的只有「删除」：删除会把记录从库里物理删掉，自然就不存在了。
 * 也就是说，「不想让它影响完成率」的正确做法是删除，而不是放弃。
 *
 * 放弃的件数仍然单独显示，不藏起来 —— 让人看得见「有几件是我主动放下的」。
 *
 * 没有任何事项时 rate = null（而不是 0）：0% 和「还没有东西可做」是两回事，
 * 界面上一律显示成「—」。
 */

const journal = require('./journal.cjs');
const week = require('./week.cjs');

/** 从计数算完成率。pct 一并算好下发 —— 百分比的口径也只留这一处。 */
function rateOf({ done = 0, todo = 0, dropped = 0 } = {}) {
  const total = done + todo + dropped;
  const rate = total > 0 ? done / total : null;
  return {
    done, todo, dropped, total, rate,
    pct: rate === null ? null : Math.round(rate * 100)
  };
}

/** 从事项数组算完成率 */
function completionOfItems(items = []) {
  let done = 0, todo = 0, dropped = 0;
  for (const it of items || []) {
    if (it.status === 'done') done += 1;
    else if (it.status === 'dropped') dropped += 1;
    else todo += 1;
  }
  return rateOf({ done, todo, dropped });
}

/** 百分比整数；没有数据返回 null，交给界面显示「—」 */
function pct(rate) {
  return rate === null || rate === undefined ? null : Math.round(rate * 100);
}

/**
 * 按 ISO 周分桶，算出每一周的完成率。
 * 按周而不是按天：一天的样本太小，「今天完成 1/2 = 50%」没什么信息量；
 * 而且周本来就是这套应用切文件、做周报的单位。
 * @returns {Array<{weekKey, weekStart, done, todo, dropped, total, rate}>} 按时间升序
 */
function weekBuckets(items = []) {
  const map = new Map();
  for (const it of items || []) {
    const k = journal.weekKey(it.date);
    let b = map.get(k);
    if (!b) {
      b = { weekKey: k, weekStart: week.weekStartOf(it.date), done: 0, todo: 0, dropped: 0 };
      map.set(k, b);
    }
    if (it.status === 'done') b.done += 1;
    else if (it.status === 'dropped') b.dropped += 1;
    else b.todo += 1;
  }
  return [...map.values()]
    .map((b) => ({ weekKey: b.weekKey, weekStart: b.weekStart, ...rateOf(b) }))
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

module.exports = { rateOf, completionOfItems, pct, weekBuckets };
