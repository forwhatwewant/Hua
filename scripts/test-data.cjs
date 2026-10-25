'use strict';
/* 数据层回归测试：把 electron/main.cjs 的 bootstrap() 依赖到的**每一个** db 函数
 * 都真跑一遍，用临时目录里自造的库（绝不碰真实数据目录）。
 *
 * 为什么要有它：曾经有个低级但致命的事故 —— allTags() 里 `const set = new Set();`
 * 被一次编辑误删，于是 bootstrap() 抛 ReferenceError，IPC reject，
 * 渲染层 boot 永远是 null，界面永久停在「正在打开……」，看起来就是「打不开了」。
 * SSR/UI 测试全绿（它们用假的 window.hua），真浏览器测试也全绿，
 * 因为它们都不碰真实的数据层。只有「真跑一遍 db 函数」才抓得住。
 *
 * 覆盖两遍：全新库，以及「旧代码建的库」（缺 memos 表）—— 后者验证 SCHEMA/migrate 的补表路径。
 */
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const db = require(path.join(ROOT, 'electron', 'db.cjs'));
const week = require(path.join(ROOT, 'electron', 'week.cjs'));
const stats = require(path.join(ROOT, 'electron', 'stats.cjs'));
const journal = require(path.join(ROOT, 'electron', 'journal.cjs'));

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${label}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL ${label}${extra ? '  ' + extra : ''}`); }
};

/** 把 fn 跑一遍，捕获异常。返回 { value, error } */
function attempt(fn) {
  try { return { value: fn(), error: null }; }
  catch (e) { return { value: undefined, error: e }; }
}

/* bootstrap() 里用到的全部 db 调用。新增 bootstrap 依赖时，这里也要加。 */
const BOOTSTRAP_DEPS = [
  ['getMeta', () => db.getMeta('dayStartHour', '4')],
  ['listByDate', () => db.listByDate('2026-10-16')],
  ['backlog', () => db.backlog('2026-10-16')],
  ['doneOn', () => db.doneOn('2026-10-16')],
  ['upcoming', () => db.upcoming('2026-10-16', 7)],
  ['countAfter', () => db.countAfter('2026-10-23')],
  ['allTags', () => db.allTags()],
  ['pinnedReflections', () => db.pinnedReflections()],
  ['pinnedItems', () => db.pinnedItems()],
  ['listMemos', () => db.listMemos()],
  ['listSleep', () => db.listSleep('2026-07-19', '2026-10-16')],
  ['getSleep', () => db.getSleep('2026-10-16')],
  ['searchJournal', () => db.searchJournal('x')],
  ['searchItems', () => db.searchItems('x')],
  ['datesWithItemsBetween', () => db.datesWithItemsBetween('2026-10-01', '2026-10-16')],
  ['datesWithReflectionsBetween', () => db.datesWithReflectionsBetween('2026-10-01', '2026-10-16')],
  ['countByStatus', () => db.countByStatus()],
  ['openItemsOutside', () => db.openItemsOutside('2026-10-19', '2026-10-25')],
  ['logUpdatedAt', () => db.logUpdatedAt('2026-10-16')],
  ['logUpdatedMap', () => db.logUpdatedMap()]
];

function runDeps(label) {
  console.log(`\n[data] bootstrap 依赖逐个真跑一遍 —— ${label}`);
  for (const [name, fn] of BOOTSTRAP_DEPS) {
    const { error } = attempt(fn);
    ok(`${name}() 不抛错`, !error, error ? error.message : '');
  }
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hua-data-'));
}

/* ---------- 1) 全新库 ---------- */
const d1 = tmpDir();
db.open(d1);
runDeps('全新库');

console.log('\n[data] 备忘（贴士）：增删改查、补充、排序');
{
  const a = db.createMemo({ text: '交表格', time: '', note: '周五前交到前台' });
  const b = db.createMemo({ text: '项目周会', time: '14:00' });
  const c = db.createMemo({ text: 'x', time: ' 09:30 ', note: '  前后空格  ' });   // 顺带验 trim
  ok('能建备忘', !!a && !!b && !!c);
  ok('空文字被拒绝', db.createMemo({ text: '   ' }) === null);
  ok('时间做了 trim', c.time === '09:30', JSON.stringify(c.time));
  ok('补充也能存', a.note === '周五前交到前台', JSON.stringify(a.note));
  ok('补充做了 trim', c.note === '前后空格', JSON.stringify(c.note));
  ok('没写补充时是空串（不是 undefined）', b.note === '', JSON.stringify(b.note));
  ok('备忘不再有「完成」这个概念', !('done' in a), JSON.stringify(Object.keys(a)));

  const list = db.listMemos();
  const times = list.map((m) => m.time);
  const firstUntimed = times.findIndex((t) => t === '');
  const lastTimed = times.map((t) => t !== '').lastIndexOf(true);
  ok('所有带时间的都排在没时间的前面',
    firstUntimed === -1 || lastTimed < firstUntimed, times.map((t) => t || '--:--').join(' '));
  const timed = list.filter((m) => m.time).map((m) => m.time);
  ok('带时间的按时刻先后排',
    timed.join(',') === [...timed].sort().join(','), timed.join(','));

  db.updateMemo(a.id, { text: '交表格（已交）' });
  ok('能改文字', db.getMemo(a.id).text === '交表格（已交）');
  db.updateMemo(a.id, { note: '改成下周交' });
  ok('能改补充', db.getMemo(a.id).note === '改成下周交', db.getMemo(a.id).note);
  db.updateMemo(a.id, { note: '' });
  ok('补充能清空', db.getMemo(a.id).note === '');
  db.deleteMemo(a.id);
  ok('能删', db.listMemos().every((m) => m.id !== a.id));
}
db.close();
fs.rmSync(d1, { recursive: true, force: true });

/* ---------- 2) 旧库（缺 memos 表）—— 模拟用户升级上来的那个库 ---------- */
const d2 = tmpDir();
db.open(d2);
db.close();
{
  const raw = new DatabaseSync(path.join(d2, 'data.db'));
  // 模拟「昨天那版」建的 memos 表：有 done、**没有 note**
  raw.exec('DROP TABLE IF EXISTS memos');
  raw.exec(`CREATE TABLE memos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    time TEXT NOT NULL DEFAULT '',
    done INTEGER NOT NULL DEFAULT 0,
    sort_key REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`);
  raw.exec("INSERT INTO memos (text, time, done, sort_key, created_at) VALUES ('昨天建的备忘', '', 1, 1, '2026-10-16T00:00:00Z')");
  // 同理模拟「昨天那版」的 items：没有 note 列
  raw.exec('DROP TABLE IF EXISTS items');
  raw.exec(`CREATE TABLE items (
    id TEXT PRIMARY KEY, date TEXT NOT NULL, title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'todo', est_minutes INTEGER, actual_minutes INTEGER,
    start_time TEXT, output TEXT, tags TEXT NOT NULL DEFAULT '[]',
    sort_key REAL NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, completed_at TEXT
  )`);
  raw.exec("INSERT INTO items (id, date, title, status, created_at) VALUES ('old-1', '2026-10-16', '老事项', 'todo', '2026-10-16T00:00:00Z')");
  const icols = raw.prepare('PRAGMA table_info(items)').all().map((r) => r.name);
  const cols = raw.prepare('PRAGMA table_info(memos)').all().map((r) => r.name);
  raw.close();
  ok('已模拟出「昨天的备忘表」（有 done、没有 note）', !cols.includes('note'), cols.join(','));
  ok('已模拟出「昨天的事项表」（没有 note）', !icols.includes('note'), icols.join(','));
}
{
  const { error } = attempt(() => db.open(d2));
  ok('新代码能打开旧库（自动补 note 列）', !error, error ? error.message : '');
  // 老数据不能丢，新列要有默认值
  const old = db.listRange('2026-10-16', '2026-10-16').find((x) => x.id === 'old-1');
  ok('旧库里的老事项还在', !!old, old ? old.title : '没了');
  ok('老事项的说明是空串（补列有默认值）', old && old.note === '', old ? JSON.stringify(old.note) : '');
  ok('老事项的时段也是空串', old && old.slot === '', old ? JSON.stringify(old.slot) : '');
  const withNote = db.createItem({ date: '2026-10-16', title: '新事项', note: '带说明' });
  ok('升级后的库能写说明', withNote.note === '带说明', JSON.stringify(withNote.note));
}
runDeps('旧库升级上来的');
{
  const raw = new DatabaseSync(path.join(d2, 'data.db'));
  const cols = raw.prepare('PRAGMA table_info(memos)').all().map((r) => r.name);
  raw.close();
  ok('补上了 note 列', cols.includes('note'), cols.join(','));
}
{
  const kept = db.listMemos();
  ok('旧备忘还在（升级不会弄丢数据）',
    kept.length === 1 && kept[0].text === '昨天建的备忘', JSON.stringify(kept.map((m) => m.text)));
  ok('旧备忘的补充默认为空串', kept[0].note === '', JSON.stringify(kept[0].note));
}
db.close();
fs.rmSync(d2, { recursive: true, force: true });

/* ---------- 3) 周程：周边界与负荷（纯函数，不碰库） ---------- */
console.log('\n[data] 周程：周边界与负荷分析');
{
  // 2026-10-16 是周五；所在周周一 = 10-12，下周 = 10-19 ~ 10-25
  ok('周一起算正确', week.weekStartOf('2026-10-16') === '2026-10-12', week.weekStartOf('2026-10-16'));
  ok('周日归到本周（不是下周）', week.weekStartOf('2026-10-18') === '2026-10-12', week.weekStartOf('2026-10-18'));
  ok('周一归到本周', week.weekStartOf('2026-10-19') === '2026-10-19');
  ok('下一周 = 本周 +7 天', week.shiftWeek('2026-10-12', 1) === '2026-10-19', week.shiftWeek('2026-10-12', 1));
  ok('上一周', week.shiftWeek('2026-10-12', -1) === '2026-10-05', week.shiftWeek('2026-10-12', -1));
  ok('跨年也稳（2026-01-01 所在周的周一）', week.weekStartOf('2026-01-01') === '2025-12-29', week.weekStartOf('2026-01-01'));
  ok('周程的周与周文件的周一致',
    JSON.stringify(journal.weekDays('2026-10-21')) === JSON.stringify(journal.weekDays('2026-10-19')),
    journal.weekDays('2026-10-19')[0]);
  ok('周几：周一=0、周日=6', week.weekdayIndex('2026-10-19') === 0 && week.weekdayIndex('2026-10-25') === 6);

  const mkIt = (status, est, actual) => ({ status, estMinutes: est, actualMinutes: actual });
  ok('计时优先「预计」', week.itemMinutes(mkIt('todo', 60)) === 60);
  ok('已完成且填了实际的，用实际', week.itemMinutes(mkIt('done', 60, 90)) === 90);
  ok('已完成但没填实际的，退回预计', week.itemMinutes(mkIt('done', 60)) === 60);
  ok('没填预计的算 0', week.itemMinutes(mkIt('todo', null)) === 0);

  const days = journal.weekDays('2026-10-19');
  const byDate = {
    '2026-10-19': [mkIt('todo', 60), mkIt('done', 30, 45)],   // 105
    '2026-10-21': [mkIt('todo', 240), mkIt('todo', 120)],      // 360
    '2026-10-22': [mkIt('todo', 60)]                           // 60
  };
  const a = week.analyze(days, byDate);
  ok('逐日合计正确', a.perDay['2026-10-19'] === 105 && a.perDay['2026-10-21'] === 360, JSON.stringify(a.perDay));
  ok('合计 = 全部相加', a.total === 525, a.total);
  ok('平均只按「有安排的天」算（(105+360+60)/3=175）', a.avg === 175, a.avg);
  ok('偏重的那天被标出来', a.heavy.length === 1 && a.heavy[0] === '2026-10-21', a.heavy.join(','));

  // 只有 1-2 天有安排时不标偏重：样本太小，平均没意义
  const tiny = week.analyze(days, { '2026-10-21': [mkIt('todo', 600)] });
  ok('有安排的天少于 3 天时不标偏重', tiny.heavy.length === 0, tiny.heavy.join(','));
  // 光有比值不够：总量太小也不算偏重
  const small = week.analyze(days, {
    '2026-10-19': [mkIt('todo', 10)], '2026-10-20': [mkIt('todo', 10)],
    '2026-10-21': [mkIt('todo', 60)]
  });
  ok('总量不到 2 小时不算偏重', small.heavy.length === 0, small.heavy.join(','));
  ok('空周不炸', week.analyze(days, {}).total === 0);
}

/* ---------- 4) 完成率：口径 ---------- */
console.log('\n[data] 完成率：口径与边界');
{
  const r = stats.rateOf({ done: 7, todo: 5, dropped: 3 });
  ok('分母 = 完成 + 未完成 + 放弃（放弃按未完成计）', r.total === 15, `total=${r.total}`);
  ok('放弃的件数单独记着', r.dropped === 3);
  ok('比率正确（7/15）', Math.abs(r.rate - 7 / 15) < 1e-9, r.rate);
  ok('百分比已算好', r.pct === 47, r.pct);

  const empty = stats.rateOf({ done: 0, todo: 0, dropped: 0 });
  ok('没有任何事项时 rate 是 null（不是 0）', empty.rate === null);
  ok('此时 pct 也是 null，界面显示「—」', empty.pct === null);
  // 全是放弃 = 一件都没完成，是实打实的 0%，不是「没数据」
  const allDropped = stats.rateOf({ done: 0, todo: 0, dropped: 5 });
  ok('全是放弃时是 0%（不是「—」）', allDropped.pct === 0, allDropped.pct);
  // 放弃和未完成对分母的贡献相同 —— 换个说法不改变「没做完」这个事实
  ok('放弃与未完成对分母等价',
    stats.rateOf({ done: 1, todo: 1, dropped: 0 }).pct === stats.rateOf({ done: 1, todo: 0, dropped: 1 }).pct);

  const items = [
    { status: 'done', date: '2026-10-12' }, { status: 'done', date: '2026-10-13' },
    { status: 'todo', date: '2026-10-19' }, { status: 'dropped', date: '2026-10-19' }
  ];
  const c = stats.completionOfItems(items);
  ok('从事项数组也能算（2 done / 4 全部）',
    c.done === 2 && c.todo === 1 && c.dropped === 1 && c.pct === 50, JSON.stringify(c));

  const buckets = stats.weekBuckets(items);
  ok('按周分桶：两周', buckets.length === 2, buckets.map((b) => b.weekKey).join(','));
  ok('分桶按时间升序', buckets[0].weekStart < buckets[1].weekStart);
  ok('分桶里的完成率正确', buckets[0].pct === 100 && buckets[1].pct === 0,
    buckets.map((b) => `${b.weekKey}:${b.pct}%`).join(' '));
  ok('空输入返回空数组', stats.weekBuckets([]).length === 0);
}

/* ---------- 5) 周程要用的两个查询 ---------- */
console.log('\n[data] 周程：待分配池与状态计数');
{
  const d3 = tmpDir();
  db.open(d3);
  const mk = (date, title, status) => {
    const it = db.createItem({ date, title });
    if (status === 'done') db.completeItem(it.id, {});
    else if (status === 'dropped') db.setStatus(it.id, 'dropped');
    return it;
  };
  mk('2026-10-21', '周内甲', 'todo');
  mk('2026-10-22', '周内已完成', 'done');
  mk('2026-10-05', '遗留', 'todo');
  mk('2026-10-16', '今天', 'todo');
  mk('2026-11-20', '很远的未来', 'todo');
  mk('2026-10-05', '遗留但放弃了', 'dropped');

  const pool = db.openItemsOutside('2026-10-19', '2026-10-25').map((i) => i.title);
  ok('池子里有遗留', pool.includes('遗留'));
  ok('池子里有今天', pool.includes('今天'));
  ok('池子里有更远的未来', pool.includes('很远的未来'));
  ok('池子里没有本周的', !pool.includes('周内甲'));
  ok('池子里没有已完成的', !pool.includes('周内已完成'));
  ok('池子里没有放弃的', !pool.includes('遗留但放弃了'));
  ok('池子按日期升序', pool[0] === '遗留', pool.join(','));

  const counts = db.countByStatus();
  ok('countByStatus 全量', counts.todo === 4 && counts.done === 1 && counts.dropped === 1, JSON.stringify(counts));
  const ranged = db.countByStatus('2026-10-19', '2026-10-25');
  ok('countByStatus 带区间', ranged.todo === 1 && ranged.done === 1, JSON.stringify(ranged));
  ok('区间内没有的就是 0（不是缺键）',
    ranged.dropped === 0, JSON.stringify(ranged));

  // 「删除才不计入」：删除会把记录从库里物理删掉，于是它不再出现在任何统计里。
  // 这正是它和「放弃」的区别 —— 放弃仍然留在库里、仍然进分母。
  const beforeTotal = counts.todo + counts.done + counts.dropped;
  const victim = db.listByDate('2026-10-21')[0];
  db.deleteItem(victim.id);
  const afterDel = db.countByStatus();
  ok('删除后不再计入任何统计',
    afterDel.todo + afterDel.done + afterDel.dropped === beforeTotal - 1,
    `${JSON.stringify(afterDel)} vs ${JSON.stringify(counts)}`);
  ok('放弃的仍然留在库里（和删除不同）',
    db.countByStatus().dropped === 1, db.countByStatus().dropped);

  db.close();
  fs.rmSync(d3, { recursive: true, force: true });
}

/* ---------- 5.5) 事项的「说明/补充」 ---------- */
console.log('\n[data] 事项的说明/补充（note）');
{
  const d4 = tmpDir();
  db.open(d4);
  const a = db.createItem({ date: '2026-10-21', title: '整理文档', note: '只改第二部分' });
  ok('建的时候能带说明', a.note === '只改第二部分', JSON.stringify(a.note));
  ok('没写说明时是空串（不是 null/undefined）',
    db.createItem({ date: '2026-10-21', title: '另一件' }).note === '');

  db.updateItem(a.id, { note: '改成只改选择题' });
  ok('改说明能落库',
    db.listRange('2026-10-21', '2026-10-21').find((x) => x.id === a.id).note === '改成只改选择题');

  db.updateItem(a.id, { note: '' });
  ok('说明可以清空',
    db.listRange('2026-10-21', '2026-10-21').find((x) => x.id === a.id).note === '');

  db.updateItem(a.id, { note: '搜得到的关键词ABC' });
  ok('搜索能搜到说明里的字', db.searchItems('关键词ABC').length === 1,
    String(db.searchItems('关键词ABC').length));

  db.close();
  fs.rmSync(d4, { recursive: true, force: true });
}

/* ---------- 5.6) 事项的时段（上午/下午/晚上） ---------- */
console.log('\n[data] 事项的时段（slot）');
{
  const d7 = tmpDir();
  db.open(d7);
  const a = db.createItem({ date: '2026-10-21', title: '下午的事', slot: 'pm' });
  ok('建的时候能带时段', a.slot === 'pm', JSON.stringify(a.slot));
  ok('没写时段时是空串（不是 null）',
    db.createItem({ date: '2026-10-21', title: '没时段' }).slot === '');

  db.updateItem(a.id, { slot: 'eve' });
  ok('改时段能落库',
    db.listRange('2026-10-21', '2026-10-21').find((x) => x.id === a.id).slot === 'eve');

  db.updateItem(a.id, { slot: '' });
  ok('时段可以清空',
    db.listRange('2026-10-21', '2026-10-21').find((x) => x.id === a.id).slot === '');

  db.close();
  fs.rmSync(d7, { recursive: true, force: true });
}

/* ---------- 5.7) 待分配：没有日期的事项 ---------- */
console.log("\n[data] 待分配（date 为空）");
{
  const d8 = tmpDir();
  db.open(d8);
  const a = db.createItem({ date: '2026-10-21', title: '定好的' });
  const b = db.createItem({ date: '2026-10-21', title: '还没想好' });
  ok('一开始都在今天', db.listByDate('2026-10-21').length === 2);
  ok('待分配是空的', db.unscheduled().length === 0);

  db.updateItem(b.id, { date: '' });
  ok('清空日期后进了待分配',
    db.unscheduled().map((x) => x.title).join() === '还没想好',
    JSON.stringify(db.unscheduled().map((x) => x.title)));
  ok('不再出现在那一天', db.listByDate('2026-10-21').length === 1);
  ok('也不在任何日期区间里', db.listRange('2026-10-01', '2026-10-31').length === 1);
  ok('周程的待分配池能带上它',
    db.openItemsOutside('2026-10-19', '2026-10-25').some((x) => x.title === '还没想好'));

  db.updateItem(b.id, { date: '2026-10-22' });
  ok('放回某一天后就离开待分配',
    db.unscheduled().length === 0 && db.listByDate('2026-10-22').length === 1);

  const c = db.createItem({ date: '', title: '直接建成就没日期' });
  ok('直接建成待分配也行', db.unscheduled().length === 1,
    JSON.stringify(db.unscheduled().map((x) => x.title)));
  db.completeItem(c.id, {});
  ok('完成的不会再出现在待分配里（只列未完成）', db.unscheduled().length === 0);

  db.close();
  fs.rmSync(d8, { recursive: true, force: true });
}

/* ---------- 5.8) 遗留完成：可以选「完成于哪天」 ---------- */
console.log("\n[data] 遗留完成（doneDate）");
{
  const d9 = tmpDir();
  db.open(d9);
  const a = db.createItem({ date: '2026-10-20', title: '前几天的事' });
  const r1 = db.completeItem(a.id, { doneDate: '2026-10-24' });
  ok('完成时能指定完成于哪天', r1.date === '2026-10-24', r1.date);
  ok('状态变成 done', r1.status === 'done');
  ok('原来那天就没有它了', db.listByDate('2026-10-20').length === 0);
  ok('跑到完成那天的列表里', db.listByDate('2026-10-24').length === 1);

  const b = db.createItem({ date: '2026-10-20', title: '另一件' });
  const r2 = db.completeItem(b.id, {});
  ok('不指定完成日期时日期不变', r2.date === '2026-10-20', r2.date);

  const c = db.createItem({ date: '2026-10-20', title: '指定时间戳' });
  const r3 = db.completeItem(c.id, { doneDate: '2026-10-22', completedAt: '2026-10-22T12:00:00.000Z' });
  ok('能指定完成时间戳', r3.completedAt === '2026-10-22T12:00:00.000Z', r3.completedAt);

  db.close();
  fs.rmSync(d9, { recursive: true, force: true });
}

/* ---------- 5.9) 固定区：今天的那条也算 ---------- */
console.log("\n[data] 固定区（含今天）");
{
  const d10 = tmpDir();
  db.open(d10);
  const T = '2026-10-24';
  const a = db.createItem({ date: T, title: '今天固定的' });
  const b = db.createItem({ date: '2026-10-20', title: '往日固定的' });
  db.pinItem(a.id, true);
  db.pinItem(b.id, true);
  const titles = db.pinnedItems().map((x) => x.title);
  ok('今天固定的那条也列出来（之前被 date <> today 排除了）',
    titles.includes('今天固定的'), JSON.stringify(titles));
  ok('往日固定的照样在', titles.includes('往日固定的'));
  db.completeItem(a.id, {});
  ok('完成之后从固定区消失', !db.pinnedItems().some((x) => x.id === a.id));
  db.close();
  fs.rmSync(d10, { recursive: true, force: true });
}

/* ---------- 5.10) 固定的不算「前几天没做完」 ---------- */
console.log("\n[data] 固定的不进遗留");
{
  const d11 = tmpDir();
  db.open(d11);
  const T = '2026-10-25';
  const a = db.createItem({ date: '2026-10-20', title: '过去的' });
  const b = db.createItem({ date: '2026-10-20', title: '过去但固定的' });
  db.pinItem(b.id, true);

  const back = db.backlog(T).map((x) => x.title);
  ok('普通的过去事项进遗留', back.includes('过去的'), JSON.stringify(back));
  ok('固定的不进遗留（它不欠任何一天）', !back.includes('过去但固定的'), JSON.stringify(back));
  ok('固定的仍在固定区里', db.pinnedItems().some((x) => x.id === b.id));

  db.pinItem(b.id, false);
  ok('取消固定后又回到遗留里', db.backlog(T).some((x) => x.id === b.id));

  db.close();
  fs.rmSync(d11, { recursive: true, force: true });
}

/* ---------- 6) 日纪的编辑记录：首次写于 / 最后改于 / 改过几次 ---------- */
console.log('\n[data] 日纪的编辑记录（journal_meta）');
{
  const d5 = tmpDir();
  db.open(d5);
  const row = (date, time, title, body) => ({ week: '2026-W42', date, time, title, body, refs: [], pinned: false });

  db.replaceJournalIndex([row('2026-10-16', '23:12', '标题甲', '正文')]);
  ok('刚建的索引还没有编辑记录',
    db.journalMeta('2026-10-16').updatedAt === '' && db.journalMeta('2026-10-16').edits === 0,
    JSON.stringify(db.journalMeta('2026-10-16')));

  db.bumpJournalMeta('2026-10-16', '2026-10-16T14:00:00.000Z');
  let m = db.journalMeta('2026-10-16');
  ok('第一次写：首次 = 最后，次数 1',
    m.createdAt === '2026-10-16T14:00:00.000Z' && m.updatedAt === m.createdAt && m.edits === 1,
    JSON.stringify(m));

  db.bumpJournalMeta('2026-10-16', '2026-10-17T01:30:00.000Z');
  m = db.journalMeta('2026-10-16');
  ok('再改一次：首次不动、最后前移、次数 2',
    m.createdAt === '2026-10-16T14:00:00.000Z'
    && m.updatedAt === '2026-10-17T01:30:00.000Z' && m.edits === 2,
    JSON.stringify(m));

  db.touchJournalMeta('2026-10-16', '2026-10-18T02:00:00.000Z');
  m = db.journalMeta('2026-10-16');
  ok('系统写入只更新时间、不算一次编辑',
    m.updatedAt === '2026-10-18T02:00:00.000Z' && m.edits === 2, JSON.stringify(m));

  // 编辑记录不在 journal_index 里，重建索引不该动它
  db.replaceJournalIndex([row('2026-10-16', '23:12', '标题乙', '改过的正文')]);
  m = db.journalMeta('2026-10-16');
  ok('重建索引后编辑记录还在',
    m.updatedAt === '2026-10-18T02:00:00.000Z' && m.edits === 2, JSON.stringify(m));
  ok('重建确实换了内容', db.searchJournal('改过的正文').length === 1);

  const map = db.journalMetaMap();
  ok('一次性取回：结构完整', map['2026-10-16']?.edits === 2, JSON.stringify(map));

  db.close();
  fs.rmSync(d5, { recursive: true, force: true });
}

/* 老库：时间存在 journal_index.updated_at 里，打开后要搬进 journal_meta */
console.log('\n[data] 老库的编辑时间搬进 journal_meta');
{
  const d6 = tmpDir();
  db.open(d6);
  db.close();
  {
    const raw = new DatabaseSync(path.join(d6, 'data.db'));
    raw.exec('DELETE FROM journal_meta');
    raw.exec(`INSERT INTO journal_index (week, date, time, title, body, refs, pinned, updated_at)
              VALUES ('2026-W42','2026-10-16','23:12','老标题','老正文','[]',0,'2026-10-17T03:00:00.000Z')`);
    raw.close();
  }
  db.open(d6);
  const m = db.journalMeta('2026-10-16');
  ok('老库的时间搬过来了', m.updatedAt === '2026-10-17T03:00:00.000Z', JSON.stringify(m));
  ok('搬过来时把首次也当成那个时间、次数记 1', m.createdAt === m.updatedAt && m.edits === 1, JSON.stringify(m));
  ok('兼容接口 logUpdatedAt 也能读到', db.logUpdatedAt('2026-10-16') === '2026-10-17T03:00:00.000Z');
  db.close();
  fs.rmSync(d6, { recursive: true, force: true });
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);process.exit(fail ? 1 : 0);
