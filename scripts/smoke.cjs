'use strict';
/* 数据层冒烟测试：不开窗口，直接验证 db + journal 的核心行为。 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const db = require('../electron/db.cjs');
const journal = require('../electron/journal.cjs');

const dir = path.join(os.tmpdir(), `hua-smoke-${Date.now()}`);
fs.mkdirSync(dir, { recursive: true });

let pass = 0;
let fail = 0;
function ok(label, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok   ${label}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL ${label}${extra ? '  ' + extra : ''}`); }
}

db.open(dir);

console.log('\n[1] ISO 周号与周文件路径');
ok('2026-09-19 属于 2026-W38', journal.weekKey('2026-09-19') === '2026-W38', journal.weekKey('2026-09-19'));
ok('周一 2026-09-14 同属 W38', journal.weekKey('2026-09-14') === '2026-W38');
ok('周日 2026-09-20 同属 W38', journal.weekKey('2026-09-20') === '2026-W38');
ok('下周一 2026-09-21 进入 W39', journal.weekKey('2026-09-21') === '2026-W39');
ok('跨年 2027-01-01 为 W53', journal.weekKey('2027-01-01') === '2026-W53', journal.weekKey('2027-01-01'));
ok('一周七天连续', journal.weekDays('2026-09-19').join(',') ===
  '2026-09-14,2026-09-15,2026-09-16,2026-09-17,2026-09-18,2026-09-19,2026-09-20');

console.log('\n[1.5] 日界：凌晨没睡的那一段算前一天（ADR-0004）');
const D = require('../electron/day.cjs');
const at = (iso) => new Date(iso);
// 默认日界 4 点
ok('凌晨 1:30 → 还是前一天', D.effectiveToday(at('2026-10-12T01:30:00'), 4) === '2026-10-11',
  D.effectiveToday(at('2026-10-12T01:30:00'), 4));
ok('凌晨 3:59 → 还是前一天', D.effectiveToday(at('2026-10-12T03:59:00'), 4) === '2026-10-11');
ok('凌晨 4:00 整 → 进入新的一天（边界归新）', D.effectiveToday(at('2026-10-12T04:00:00'), 4) === '2026-10-12',
  D.effectiveToday(at('2026-10-12T04:00:00'), 4));
ok('上午 10:00 → 就是当天', D.effectiveToday(at('2026-10-12T10:00:00'), 4) === '2026-10-12');
ok('晚上 23:59 → 就是当天', D.effectiveToday(at('2026-10-12T23:59:00'), 4) === '2026-10-12');
ok('日界设成 6 点：凌晨 5:00 仍算前一天', D.effectiveToday(at('2026-10-12T05:00:00'), 6) === '2026-10-11');
ok('日界设成 0 点：凌晨 1:00 就算新的一天', D.effectiveToday(at('2026-10-12T01:00:00'), 0) === '2026-10-12');
ok('跨月边界：11-01 凌晨 2 点 → 10-31', D.effectiveToday(at('2026-11-01T02:00:00'), 4) === '2026-10-31',
  D.effectiveToday(at('2026-11-01T02:00:00'), 4));
ok('跨年边界：01-01 凌晨 2 点 → 上一年 12-31', D.effectiveToday(at('2027-01-01T02:00:00'), 4) === '2026-12-31',
  D.effectiveToday(at('2027-01-01T02:00:00'), 4));
ok('跨月且跨年：01-01 上午 10 点 → 01-01', D.effectiveToday(at('2027-01-01T10:00:00'), 4) === '2027-01-01');
// 闰年 2 月
ok('闰年：03-01 凌晨 2 点 → 02-29', D.effectiveToday(at('2028-03-01T02:00:00'), 4) === '2028-02-29',
  D.effectiveToday(at('2028-03-01T02:00:00'), 4));
ok('闰年：02-29 凌晨 2 点 → 02-28', D.effectiveToday(at('2028-02-29T02:00:00'), 4) === '2028-02-28');

ok('配置坏值回落默认 4 点', D.normalizeHour('abc') === 4 && D.normalizeHour(undefined) === 4
  && D.normalizeHour('') === 4, String(D.normalizeHour('abc')));
ok('配置越界被钳制在 0–23', D.normalizeHour(-5) === 0 && D.normalizeHour(99) === 23);
ok('配置是数字字符串也能识别', D.normalizeHour('6') === 6);
ok('不传日界时用默认值', D.effectiveToday(at('2026-10-12T02:00:00')) === '2026-10-11');

console.log('\n[2] 事项：创建 / 完成 / 放弃 / 遗留');
const a = db.createItem({ date: '2026-09-18', title: '修好了登录流程的 token 过期问题', estMinutes: 90 });
const b = db.createItem({ date: '2026-09-18', title: '评审 v2 接口设计', estMinutes: 30 });
const c = db.createItem({ date: '2026-09-19', title: '写周报' });
ok('创建了 3 条事项', db.listByDate('2026-09-18').length === 2 && db.listByDate('2026-09-19').length === 1);
ok('新事项默认 todo', a.status === 'todo');

db.completeItem(a.id, { actualMinutes: 95, output: '根因是刷新时序不对' });
db.completeItem(b.id, { actualMinutes: 25, output: null });
db.setStatus(c.id, 'dropped');
ok('完成状态写入', db.listByDate('2026-09-18').filter((i) => i.status === 'done').length === 2);
ok('实际耗时与产出描述落库', db.doneOn('2026-09-18')[0].actualMinutes === 95 && db.doneOn('2026-09-18')[0].output === '根因是刷新时序不对');
ok('放弃状态写入', db.listByDate('2026-09-19')[0].status === 'dropped');

const d = db.createItem({ date: '2026-09-15', title: '一直没做完的事' });
const backlog = db.backlog('2026-09-19');
ok('遗留查询只捞 19 号之前的 todo', backlog.length === 1 && backlog[0].id === d.id, `找到 ${backlog.length} 件`);

console.log('\n[3] 手动搬运遗留事项');
db.carryTo([d.id], '2026-09-19');
ok('事项日期被改到今天', db.listByDate('2026-09-19').some((i) => i.id === d.id));
ok('原日期不再有它', !db.listByDate('2026-09-15').some((i) => i.id === d.id));

console.log('\n[3.5] 拖拽排序：reorder 把 sort_key 重写为 1..n');
const r1 = db.createItem({ date: '2026-09-19', title: '排序-甲' });
const r2 = db.createItem({ date: '2026-09-19', title: '排序-乙' });
const r3 = db.createItem({ date: '2026-09-19', title: '排序-丙' });
db.reorder([r3.id, r1.id, r2.id]);
const afterReorder = db.listByDate('2026-09-19').filter((i) => i.title.startsWith('排序-')).map((i) => i.title);
ok('reorder 后顺序按指定', afterReorder.join(',') === '排序-丙,排序-甲,排序-乙', afterReorder.join(','));
ok('reorder 后 sort_key 是 1..n',
  [r3, r1, r2].every((it, i) => db.getItem(it.id).sortKey === i + 1));

console.log('\n[4] 周文件：心得写入 + 完成清单快照');
journal.saveEntry(dir, '2026-09-18', '23:10', '今天卡在 token 刷新的时序上。\n\n- 试了三种方案\n- 最后是 `refresh` 里少了一个 await');
const day = journal.readDay(dir, '2026-09-18');
ok('心得读回一致',
  day.reflections.length === 1 &&
  day.reflections[0].time === '23:10' &&
  day.reflections[0].body.includes('token 刷新的时序') &&
  day.reflections[0].body.includes('少了一个 await'));

const file = journal.weekFilePath(dir, '2026-09-18');
ok('周文件已落盘', fs.existsSync(file), path.basename(file));
const raw = fs.readFileSync(file, 'utf8');
ok('文件头是周标题', raw.startsWith('# 2026 年第 38 周（09-14 ~ 09-20）'), raw.split('\n')[0]);
ok('含当天小节', raw.includes('## 09-18 周五'));
ok('含心得小节', raw.includes('### 心得'));

const lines = db.doneOn('2026-09-18').map((it) => `- ${it.title}${it.output ? ` —— ${it.output}` : ''}（${it.actualMinutes}m）`);
journal.snapshotDone(dir, '2026-09-18', lines);
const raw2 = fs.readFileSync(file, 'utf8');
ok('完成清单已写入', raw2.includes('### 完成') && raw2.includes('修好了登录流程的 token 过期问题'));

journal.snapshotDone(dir, '2026-09-18', ['- 这是不该被写进去的内容']);
const raw3 = fs.readFileSync(file, 'utf8');
ok('快照不回改（ADR-0005）', !raw3.includes('不该被写进去') && raw3.includes('修好了登录流程'));

journal.snapshotDone(dir, '2026-09-18', ['- 手动刷新覆盖'], { force: true });
ok('force 可以覆盖', fs.readFileSync(file, 'utf8').includes('手动刷新覆盖'));
journal.snapshotDone(dir, '2026-09-18', lines, { force: true });

console.log('\n[5] 心得里引用事项 + 索引重建 + 检索');
journal.saveEntry(dir, '2026-09-19', '23:30', `顺着 [修好了登录流程的 token 过期问题](hua://item/${a.id}) 又想到一点。`);
const rows = journal.scanAll(dir);
ok('索引扫描到 2 天的心得', rows.length === 2, `实际 ${rows.length}`);
const withRef = rows.find((r) => r.date === '2026-09-19');
ok('从心得里抽出了事项引用', withRef && withRef.refs.length === 1 && withRef.refs[0] === a.id);

db.replaceJournalIndex(rows);
ok('全文检索命中心得', db.searchJournal('await').length === 1);
ok('全文检索命中中文', db.searchJournal('时序').length === 1);
ok('检索事项标题', db.searchItems('token').length === 1);
ok('检索事项产出描述', db.searchItems('刷新时序').length === 1);
ok('搜不到的词返回空', db.searchJournal('这个词不存在').length === 0);

console.log('\n[5.5] 一天多条心得：新增 / 分条保存 / 删除 / 老格式兼容');
const d2 = path.join(os.tmpdir(), `hua-multi-${Date.now()}`);
fs.mkdirSync(path.join(d2, 'journal'), { recursive: true });
journal.saveEntry(d2, '2026-09-18', '09:05', '早上先记一笔');
journal.saveEntry(d2, '2026-09-18', '23:10', '晚上再记一笔');
const t3 = journal.addEntry(d2, '2026-09-18', '随手又加了一条');
const md1 = journal.readDay(d2, '2026-09-18');
ok('一天可以有多条心得', md1.reflections.length === 3, `实际 ${md1.reflections.length} 条`);
ok('各条时间互不重复',
  new Set(md1.reflections.map((r) => r.time)).size === 3, md1.reflections.map((r) => r.time).join(','));
const times = md1.reflections.map((r) => r.time);
ok('读出来按时间升序', times.join(',') === [...times].sort().join(','), times.join(','));
const rawM = fs.readFileSync(journal.weekFilePath(d2, '2026-09-18'), 'utf8');
ok('周文件用 #### HH:MM 分条',
  rawM.includes('#### 09:05') && rawM.includes('#### 23:10') && rawM.includes(`#### ${t3}`));
journal.saveEntry(d2, '2026-09-18', '09:05', '早上那笔改过了');
ok('按时间改的是对应那条',
  journal.readDay(d2, '2026-09-18').reflections.find((r) => r.time === '09:05').body === '早上那笔改过了');
journal.removeEntry(d2, '2026-09-18', '09:05');
const md2 = journal.readDay(d2, '2026-09-18');
ok('删掉一条后其余还在', md2.reflections.length === 2 && !md2.reflections.some((r) => r.time === '09:05'));
ok('索引按条建（剩 2 条 = 2 行）', journal.scanAll(d2).length === 2, `实际 ${journal.scanAll(d2).length}`);
fs.rmSync(d2, { recursive: true, force: true });

// 老格式：### 心得 下面直接是正文、没有 #### —— 当作该天仅有的一条「无时间」心得
const d3 = path.join(os.tmpdir(), `hua-legacy-${Date.now()}`);
fs.mkdirSync(path.join(d3, 'journal'), { recursive: true });
fs.writeFileSync(journal.weekFilePath(d3, '2026-09-18'),
  '# 2026 年第 38 周（09-14 ~ 09-20）\n\n## 09-18 周五\n\n### 完成\n- 做完了某事\n\n### 心得\n\n老文件里的一段心得\n');
const ld = journal.readDay(d3, '2026-09-18');
ok('老格式解析成一条心得', ld.reflections.length === 1, `实际 ${ld.reflections.length}`);
ok('老格式那条没有时间', ld.reflections[0].time === '');
ok('老格式正文原样保留', ld.reflections[0].body === '老文件里的一段心得');
fs.rmSync(d3, { recursive: true, force: true });

console.log('\n[5.6] 新增空心得必须留下（回归：以前空条目被序列化过滤掉，点了「+ 新增一条」没反应）');
const d4 = path.join(os.tmpdir(), `hua-empty-${Date.now()}`);
fs.mkdirSync(path.join(d4, 'journal'), { recursive: true });
const tEmpty = journal.addEntry(d4, '2026-09-18', '');
const rdEmpty = journal.readDay(d4, '2026-09-18');
ok('空心得也能读回来', rdEmpty.reflections.length === 1 && rdEmpty.reflections[0].time === tEmpty,
  JSON.stringify(rdEmpty.reflections));
ok('空心得写进了周文件',
  fs.existsSync(journal.weekFilePath(d4, '2026-09-18')) &&
  fs.readFileSync(journal.weekFilePath(d4, '2026-09-18'), 'utf8').includes(`#### ${tEmpty}`));
journal.saveEntry(d4, '2026-09-18', tEmpty, '后来补上了内容');
ok('给空条目补内容不产生第二条',
  journal.readDay(d4, '2026-09-18').reflections.length === 1,
  `实际 ${journal.readDay(d4, '2026-09-18').reflections.length} 条`);
fs.rmSync(d4, { recursive: true, force: true });

console.log('\n[5.7] 置顶：写进 #### HH:MM ·置顶，能被解析回来');
const d5 = path.join(os.tmpdir(), `hua-pin-${Date.now()}`);
fs.mkdirSync(path.join(d5, 'journal'), { recursive: true });
journal.saveEntry(d5, '2026-09-17', '08:30', '早上的心得');
journal.saveEntry(d5, '2026-09-17', '22:10', '晚上的心得');
ok('默认都没置顶',
  journal.readDay(d5, '2026-09-17').reflections.every((r) => !r.pinned));
journal.setPinned(d5, '2026-09-17', '08:30', true);
const pinRaw = fs.readFileSync(journal.weekFilePath(d5, '2026-09-17'), 'utf8');
ok('置顶标记落在周文件里', pinRaw.includes('#### 08:30 ·置顶'), JSON.stringify(pinRaw.match(/#### .*/g)));
const pinDay = journal.readDay(d5, '2026-09-17');
ok('只有被置顶那条 pinned=true',
  pinDay.reflections.find((r) => r.time === '08:30').pinned === true &&
  pinDay.reflections.find((r) => r.time === '22:10').pinned === false);
journal.setPinned(d5, '2026-09-17', '08:30', false);
ok('取消置顶后标记消失',
  !fs.readFileSync(journal.weekFilePath(d5, '2026-09-17'), 'utf8').includes('置顶'));
// 老格式那条没有 ####，置顶只能记在小节标题上：### 心得 ·置顶
const d5b = path.join(os.tmpdir(), `hua-pin-legacy-${Date.now()}`);
fs.mkdirSync(path.join(d5b, 'journal'), { recursive: true });
fs.writeFileSync(journal.weekFilePath(d5b, '2026-09-18'),
  '# 2026 年第 38 周（09-14 ~ 09-20）\n\n## 09-18 周五\n\n### 心得\n\n老文件里的一段心得\n');
journal.setPinned(d5b, '2026-09-18', '', true);
const legacyRaw = fs.readFileSync(journal.weekFilePath(d5b, '2026-09-18'), 'utf8');
ok('老格式置顶写在小节标题上', legacyRaw.includes('### 心得 ·置顶'), JSON.stringify(legacyRaw.match(/###.*/g)));
ok('老格式置顶能读回来', journal.readDay(d5b, '2026-09-18').reflections[0].pinned === true);
ok('老格式正文没被标记污染',
  journal.readDay(d5b, '2026-09-18').reflections[0].body === '老文件里的一段心得');
journal.setPinned(d5b, '2026-09-18', '', false);
ok('老格式取消置顶',
  !fs.readFileSync(journal.weekFilePath(d5b, '2026-09-18'), 'utf8').includes('置顶') &&
  journal.readDay(d5b, '2026-09-18').reflections[0].body === '老文件里的一段心得');
fs.rmSync(d5b, { recursive: true, force: true });

const pinRows = journal.scanAll(d5);
ok('索引带上 time 与 pinned',
  pinRows.length === 2 && pinRows.every((r) => typeof r.time === 'string') &&
  pinRows.every((r) => r.pinned === 0), JSON.stringify(pinRows.map((r) => [r.time, r.pinned])));
ok('置顶的心得不会被别的写操作顶掉',
  (() => {
    journal.setPinned(d5, '2026-09-17', '22:10', true);
    journal.saveEntry(d5, '2026-09-17', '08:30', '早上的心得（改过）');
    const rs = journal.readDay(d5, '2026-09-17').reflections;
    return rs.find((r) => r.time === '08:30').body === '早上的心得（改过）' &&
           rs.find((r) => r.time === '22:10').pinned === true;
  })());
fs.rmSync(d5, { recursive: true, force: true });

console.log('\n[5.8] 清理往日空壳心得：今天的不动，昨天的清掉');
const d6 = path.join(os.tmpdir(), `hua-prune-${Date.now()}`);
const TODAY = '2026-09-18';
const YESTERDAY = '2026-09-17';
fs.mkdirSync(path.join(d6, 'journal'), { recursive: true });
journal.addEntry(d6, TODAY, '');
journal.addEntry(d6, YESTERDAY, '');
journal.saveEntry(d6, YESTERDAY, undefined, '昨天真正写了的一条');
ok('清理前有 2 天的空壳 + 1 条有内容',
  journal.readDay(d6, TODAY).reflections.length === 1 &&
  journal.readDay(d6, YESTERDAY).reflections.length === 2,
  `今天 ${journal.readDay(d6, TODAY).reflections.length} 条 / 昨天 ${journal.readDay(d6, YESTERDAY).reflections.length} 条`);
const pruned = journal.pruneEmpty(d6, TODAY);
ok('清掉了 1 天的空壳', pruned === 1, `返回 ${pruned}`);
ok('今天那条还在（用户可能正要写）', journal.readDay(d6, TODAY).reflections.length === 1);
const yd = journal.readDay(d6, YESTERDAY).reflections;
ok('昨天只剩写了内容的那条', yd.length === 1 && yd[0].body === '昨天真正写了的一条', JSON.stringify(yd));
fs.rmSync(d6, { recursive: true, force: true });

console.log('\n[5.9] 事项置顶');
const p1 = db.createItem({ date: '2026-09-19', title: '置顶-甲' });
const p2 = db.createItem({ date: '2026-09-19', title: '置顶-乙' });
db.pinItem(p1.id, true);
ok('置顶标记落库', db.getItem(p1.id).pinned === true && db.getItem(p2.id).pinned === false);
ok('置顶事项排在最前', db.listByDate('2026-09-19')[0].id === p1.id,
  db.listByDate('2026-09-19').map((i) => i.title).join(' / '));
ok('固定区列出所有固定的未完成项（包括今天那条）',
  db.pinnedItems().length === 1 && db.pinnedItems()[0].id === p1.id,
  JSON.stringify(db.pinnedItems().map((i) => i.title)));
db.pinItem(p1.id, false);
ok('取消置顶后回到原位', db.listByDate('2026-09-19')[0].id !== p1.id);
db.deleteItem(p1.id); db.deleteItem(p2.id);

console.log('\n[5.10] 未来：今日页「接下来」区块的数据源');
ok('shiftDays 跨月', db.shiftDays('2026-09-28', 5) === '2026-10-03', db.shiftDays('2026-09-28', 5));
ok('shiftDays 跨年', db.shiftDays('2026-12-30', 3) === '2027-01-02', db.shiftDays('2026-12-30', 3));
ok('窗口右边界 = 今天 + 7 天', db.shiftDays('2026-09-20', 7) === '2026-09-27');

const f1 = db.createItem({ date: '2026-09-21', title: '明天的事' });
const f2 = db.createItem({ date: '2026-09-22', title: '后天的事' });
const farBefore = db.countAfter('2026-09-27');
const f3 = db.createItem({ date: '2026-12-01', title: '更远的事' });

const up = db.upcoming('2026-09-20', 7);
ok('窗口内既有事项都在 (今天, 今天+7] 区间',
  up.every((i) => i.date > '2026-09-20' && i.date <= '2026-09-27'),
  up.map((i) => i.date).join(',') || '(空)');
ok('明天的排进窗口', up.some((i) => i.id === f1.id));
ok('后天的排进窗口', up.some((i) => i.id === f2.id));
ok('窗口外的不进来', !up.some((i) => i.id === f3.id));
ok('窗口内按日期升序', up.every((i, n) => n === 0 || up[n - 1].date <= i.date));
ok('窗口外只给计数', db.countAfter('2026-09-27') === farBefore + 1);
ok('未来事项不会被当成遗留', db.backlog('2026-09-20').every((i) => i.id !== f1.id));
ok('到了那天自然进入今日列表（不用搬运）',
  db.listByDate('2026-09-21').some((i) => i.id === f1.id));

db.deleteItem(f1.id); db.deleteItem(f2.id); db.deleteItem(f3.id);

console.log('\n[5.11] 睡眠：时长换算（跨午夜）+ 分档');
const S = require('../electron/sleep.cjs');
ok('23:40 → 07:10 = 7 小时 30 分（跨午夜）', S.calcMinutes('23:40', '07:10') === 450, String(S.calcMinutes('23:40', '07:10')));
ok('01:00 → 08:00 = 7 小时（不跨）', S.calcMinutes('01:00', '08:00') === 420);
ok('22:00 → 05:30 = 7 小时 30 分', S.calcMinutes('22:00', '05:30') === 450);
ok('00:30 → 07:00 = 6 小时 30 分', S.calcMinutes('00:30', '07:00') === 390);
ok('同一时刻判为无效（否则会算成 24 小时）', S.calcMinutes('23:00', '23:00') === null);
ok('只睡 10 分钟判为无效', S.calcMinutes('23:00', '23:10') === null);
ok('超过 20 小时判为无效', S.calcMinutes('06:00', '05:00') === null);
ok('格式不对判为无效', S.calcMinutes('25:00', '07:00') === null && S.calcMinutes('', '07:00') === null);

ok('5 小时 59 分 → 严重不足', S.bandOf(359).key === 'low', S.bandOf(359).label);
ok('6 小时整 → 偏少（边界归上一档）', S.bandOf(360).key === 'short');
ok('6 小时 59 分 → 偏少', S.bandOf(419).key === 'short');
ok('7 小时整 → 正常', S.bandOf(420).key === 'ok');
ok('8 小时 59 分 → 正常', S.bandOf(539).key === 'ok');
ok('9 小时整 → 偏多', S.bandOf(540).key === 'long');
ok('无时长不给档', S.bandOf(null) === null);

ok('整小时不留下尾空格', S.fmtMinutes(420) === '7 小时', `「${S.fmtMinutes(420)}」`);
ok('带零头正常显示', S.fmtMinutes(450) === '7 小时 30 分', `「${S.fmtMinutes(450)}」`);

console.log('\n[5.12] 睡眠：平均入睡时间要处理跨午夜');
ok('23:00 与 01:00 的平均是 00:00，不是 12:00', S.avgClock(['23:00', '01:00']) === '00:00', S.avgClock(['23:00', '01:00']));
ok('23:40 与 00:20 的平均是 00:00', S.avgClock(['23:40', '00:20']) === '00:00', S.avgClock(['23:40', '00:20']));
ok('两个 22:30 的平均还是 22:30', S.avgClock(['22:30', '22:30']) === '22:30');
ok('空列表返回空串', S.avgClock([]) === '');

console.log('\n[5.13] 睡眠：落库与汇总');
db.saveSleep({ date: '2026-09-19', bedTime: '23:40', wakeTime: '07:10', minutes: 450 });
db.saveSleep({ date: '2026-09-20', bedTime: '00:30', wakeTime: '05:50', minutes: 320 });
db.saveSleep({ date: '2026-09-21', bedTime: '23:10', wakeTime: '07:00', minutes: 470 });
ok('单日读回', db.getSleep('2026-09-19').minutes === 450);
db.saveSleep({ date: '2026-09-19', bedTime: '23:40', wakeTime: '07:40', minutes: 480 });
ok('同一天再记会覆盖，不会多出一条', db.listSleep('2026-09-19', '2026-09-19').length === 1);
ok('覆盖后是新值', db.getSleep('2026-09-19').minutes === 480);
ok('按区间升序列出', db.listSleep('2026-09-19', '2026-09-21').map((r) => r.date).join(',') === '2026-09-19,2026-09-20,2026-09-21');

const sm = S.summarize(db.listSleep('2026-09-19', '2026-09-21'));
ok('汇总：条数', sm.count === 3);
ok('汇总：平均 = (480+320+470)/3 ≈ 423', sm.avg === 423, String(sm.avg));
ok('汇总：最长 480 / 最短 320', sm.longest === 480 && sm.shortest === 320);
// 480 分=8 小时、470 分=7 小时 50 分都落在 7–9 小时；320 分=5 小时 20 分属严重不足
ok('汇总：分档天数 正常2 / 严重不足1', sm.counts.ok === 2 && sm.counts.low === 1 && sm.counts.short === 0, JSON.stringify(sm.counts));
ok('汇总：正常率 = 2/3 ≈ 67%', sm.okRate === 67, `${sm.okRate}%`);
ok('汇总：平均入睡 23:47（跨午夜没被平均成中午）', sm.avgBed === '23:47', sm.avgBed);
ok('汇总：平均起床 = (07:40 + 05:50 + 07:00)/3 = 06:50', sm.avgWake === '06:50', sm.avgWake);
// 排序后 320 / 470 / 480，中间那个是 470
ok('汇总：中位数 = 470（不是平均值 423）', sm.median === 470, String(sm.median));
ok('空集合汇总为 null', S.summarize([]) === null);

console.log('\n[5.13b] 睡眠：波动与作息规律度');
ok('中位数：奇数个取正中间', S.median([300, 500, 400]) === 400, String(S.median([300, 500, 400])));
ok('中位数：偶数个取中间两个的平均', S.median([300, 400, 500, 600]) === 450, String(S.median([300, 400, 500, 600])));
ok('中位数：空数组返回 null', S.median([]) === null);
ok('中位数：忽略非法值', S.median([300, null, 500, undefined, 400]) === 400, String(S.median([300, null, 500, undefined, 400])));

ok('标准差：全等的一组为 0', S.stdev([600, 600, 600]) === 0, String(S.stdev([600, 600, 600])));
ok('标准差：400 与 600 → 100', S.stdev([400, 600]) === 100, String(S.stdev([400, 600])));
ok('标准差：少于 2 条返回 null', S.stdev([600]) === null && S.stdev([]) === null);

ok('汇总带出时长波动', typeof sm.sd === 'number' && sm.sd > 0, String(sm.sd));
// 480 / 470 都在 23:10–23:40 之间，320 那条的入睡是 00:30（挪到 24:30）
ok('汇总带出入睡离散度', typeof sm.bedSpread === 'number' && sm.bedSpread > 0, String(sm.bedSpread));
ok('规律度是 0–100 的整数', Number.isInteger(sm.regularity) && sm.regularity >= 0 && sm.regularity <= 100, String(sm.regularity));

// 作息离散度：同一时刻一条 → 0，规律度该是满分
ok('入睡时刻完全一致 → 离散 0、规律度 100',
  S.bedSpread([{ bedTime: '23:00' }, { bedTime: '23:00' }, { bedTime: '23:00' }]) === 0
  && S.summarize([
    { date: '2026-09-19', bedTime: '23:00', wakeTime: '07:00', minutes: 480 },
    { date: '2026-09-20', bedTime: '23:00', wakeTime: '07:00', minutes: 480 },
  ]).regularity === 100,
  String(S.summarize([
    { date: '2026-09-19', bedTime: '23:00', wakeTime: '07:00', minutes: 480 },
    { date: '2026-09-20', bedTime: '23:00', wakeTime: '07:00', minutes: 480 },
  ]).regularity));
// 23:30 与 00:30 跨午夜只相隔 60 分钟。统一挪到「凌晨坐标系」后是 1410 与 1470，
// 两点样本的总体标准差 = 30；直接算术差会得到 23 小时 40 分那么离谱的值。
ok('跨午夜的入睡时刻没被算成差 23 小时',
  S.bedSpread([{ bedTime: '23:30' }, { bedTime: '00:30' }]) === 30,
  String(S.bedSpread([{ bedTime: '23:30' }, { bedTime: '00:30' }])));
// 对照组：若不处理跨午夜，23:30(1410) 与 00:30(30) 的差是 1380，整体标准差会是 690
ok('（对照）不处理跨午夜的话离散度会是 690 这种荒唐值',
  S.bedSpread([{ bedTime: '23:30' }, { bedTime: '00:30' }]) < 100);
ok('离散超过 120 分钟 → 规律度归零（不出现负数）',
  S.summarize([
    { date: '2026-09-19', bedTime: '21:00', wakeTime: '07:00', minutes: 600 },
    { date: '2026-09-20', bedTime: '02:00', wakeTime: '08:00', minutes: 360 },
  ]).regularity === 0);

db.deleteSleep('2026-09-19'); db.deleteSleep('2026-09-20'); db.deleteSleep('2026-09-21');
ok('删除后不再列出', db.listSleep('2026-09-19', '2026-09-21').length === 0);

console.log('\n[5.14] 睡眠：分析报告正文');
const md = S.buildReport({
  from: '2026-09-19', to: '2026-09-21',
  records: [
    { date: '2026-09-19', bedTime: '23:40', wakeTime: '07:40', minutes: 480 },
    { date: '2026-09-20', bedTime: '00:30', wakeTime: '05:50', minutes: 320 },
    { date: '2026-09-21', bedTime: '23:10', wakeTime: '07:00', minutes: 470 },
  ]
});
ok('标题含区间', md.startsWith('# 睡眠分析 2026-09-19 ~ 2026-09-21'));
ok('概览给出平均时长', md.includes('- 平均时长 **7 小时 3 分**'), (md.match(/- 平均时长[^\n]*/) || [])[0]);
ok('概览同时给出中位数', md.includes('中位数 7 小时 50 分'), (md.match(/- 平均时长[^\n]*/) || [])[0]);
ok('概览给出波动（±）', /- 最长[^\n]*波动 ±/.test(md), (md.match(/- 最长[^\n]*/) || [])[0]);
ok('概览给出作息规律度', /- 作息规律度 \*\*\d+ 分\*\*/.test(md), (md.match(/- 作息规律度[^\n]*/) || [])[0]);
ok('概览给出正常率', md.includes('- 正常率（7–9 小时）**67%**'), (md.match(/- 正常率[^\n]*/) || [])[0]);
// 三条记录是 480(正常) / 320(严重不足) / 470(正常)，没有落在「偏少」档的
ok('分档用「6–7 小时」这种写法，不写「不足 7 小时」',
  md.includes('- 偏少（6–7 小时）：0 天 · 0%'), (md.match(/- 偏少[^\n]*/) || [])[0]);
ok('分档四行齐全', S.BANDS.every((b) => md.includes(`- ${b.label}（`)));
// 明细行和「不足 6 小时」那段的列表都以「- 日期 ·」开头，所以要靠时间形态区分
ok('每日明细三行', (md.match(/^- 2026-09-\d{2} · \d{2}:\d{2} → \d{2}:\d{2} ·/gm) || []).length === 3,
  String((md.match(/^- 2026-09-\d{2}[^\n]*/gm) || []).length));
ok('明细里标出判定',
  md.includes('- 2026-09-20 · 00:30 → 05:50 · 5 小时 20 分 · 严重不足'),
  (md.match(/^- 2026-09-20[^\n]*/) || [])[0]);
// 报告正文要直接显示在页面上，而应用的 Markdown 转换器不支持表格 —— 所以报告里不该出现表格
ok('报告里不用 Markdown 表格（页面渲染不出来）', !/^\|/m.test(md));
ok('单独列出不足 6 小时的日子', md.includes('## 不足 6 小时的日子') && md.includes('- 2026-09-20 · 5 小时 20 分（00:30 → 05:50）'));
ok('写明判定依据与来源', md.includes('## 判定依据') && md.includes('Sleep Foundation') && md.includes('2026-09-22'));
ok('声明不构成医学建议', md.includes('不构成医学建议'));
ok('没有记录时不崩，给出提示', S.buildReport({ from: '2026-01-01', to: '2026-01-07', records: [] }).includes('还没有睡眠记录'));
ok('缺失天数会算出来', S.buildReport({
  from: '2026-09-01', to: '2026-09-07',
  records: [{ date: '2026-09-01', bedTime: '23:00', wakeTime: '07:00', minutes: 480 }]
}).includes('有记录 1 天，缺 6 天'));

console.log('\n[5.15] 日志：一天多条 → 一篇（readDayLog 聚合）');
const dlog = path.join(os.tmpdir(), `hua-log-${Date.now()}`);
fs.mkdirSync(path.join(dlog, 'journal'), { recursive: true });
// 模拟「一天多条」的旧数据
{
  const days = journal.readWeek(dlog, '2026-10-08');
  days['2026-10-08'] = {
    done: ['- 写方案（40m）'],
    reflections: [
      { time: '09:15', title: '早上', body: '改完了文档工具的第一步。', pinned: false },
      { time: '20:09', title: '备忘', body: '两周联系一次。', pinned: true }
    ]
  };
  journal.writeWeek(dlog, '2026-10-08', days);
}
const lg = journal.readDayLog(dlog, '2026-10-08');
ok('聚合出 2 条来源', lg.count === 2, String(lg.count));
ok('各条标题降级成 ### 小标题', lg.body.includes('### 早上') && lg.body.includes('### 备忘'), JSON.stringify(lg.body));
ok('正文按时间顺序首尾相接',
  lg.body.indexOf('改完了文档工具的第一步') < lg.body.indexOf('两周联系一次'));
ok('任意一条置顶则整篇置顶', lg.pinned === true);
ok('多条时不留单独标题（已在正文里）', lg.title === '', JSON.stringify(lg.title));

console.log('\n[5.16] 日志：一天的写入与置顶');
const t16 = journal.saveDay(dlog, '2026-10-08', '### 早上\n\n改完了文档工具的第一步。\n\n### 备忘\n\n两周联系一次。\n\n补充一句新内容。', '');
ok('写入返回一个时间', /^\d{2}:\d{2}$/.test(t16), t16);
ok('时间沿用当天最早一条，不是「现在」', t16 === '09:15', t16);
const lg2 = journal.readDayLog(dlog, '2026-10-08');
ok('合并成了一条', lg2.count === 1, String(lg2.count));
ok('新内容保住了', lg2.body.includes('补充一句新内容'), JSON.stringify(lg2.body));
ok('置顶状态跨写入保留', lg2.pinned === true);
journal.setDayPinned(dlog, '2026-10-08', false);
ok('可以取消整篇置顶', journal.readDayLog(dlog, '2026-10-08').pinned === false);
journal.setDayPinned(dlog, '2026-10-08', true);
ok('可以重新置顶整篇', journal.readDayLog(dlog, '2026-10-08').pinned === true);

console.log('\n[5.17] 日志：清空与「没写过」');
journal.saveDay(dlog, '2026-10-09', '', '');
ok('空写不留痕（该天没有日志）', journal.readDayLog(dlog, '2026-10-09').count === 0);
journal.saveDay(dlog, '2026-10-10', '先写点东西', '标题也在');
ok('写了就有', journal.readDayLog(dlog, '2026-10-10').body === '先写点东西');
ok('单条时标题上浮到 title', journal.readDayLog(dlog, '2026-10-10').title === '标题也在');
journal.saveDay(dlog, '2026-10-10', '', '');
ok('清空后回到没写过', journal.readDayLog(dlog, '2026-10-10').count === 0);

console.log('\n[5.18] 日志：完成清单不受影响（两种东西共存于同一天）');
const day18 = journal.readDay(dlog, '2026-10-08');
ok('完成清单还在', day18.done.length === 1 && day18.done[0].includes('写方案'), JSON.stringify(day18.done));
ok('日志也在', (day18.reflections || []).length === 1);
fs.rmSync(dlog, { recursive: true, force: true });

console.log('\n[6] 数据目录结构');
ok('journal 目录存在', fs.existsSync(path.join(dir, 'journal')));
console.log('  ---- 周文件内容 ----');
console.log(fs.readFileSync(file, 'utf8').split('\n').map((l) => '  | ' + l).join('\n'));

db.close();
fs.rmSync(dir, { recursive: true, force: true });

// 放在最后：会重新开关一次数据库连接
console.log('\n[6.5] 心得标题：写在 #### HH:MM · 标题 上');
const d7 = path.join(os.tmpdir(), `hua-title-${Date.now()}`);
fs.mkdirSync(path.join(d7, 'journal'), { recursive: true });
journal.saveEntry(d7, '2026-09-18', '09:05', '正文一段', '关于职称材料');
journal.saveEntry(d7, '2026-09-18', '23:10', '晚上又想了想', '');
const t7 = journal.readDay(d7, '2026-09-18');
ok('标题能读回来', t7.reflections.find((r) => r.time === '09:05').title === '关于职称材料');
ok('没标题的就是空串', t7.reflections.find((r) => r.time === '23:10').title === '');
const raw7 = fs.readFileSync(journal.weekFilePath(d7, '2026-09-18'), 'utf8');
ok('标题写进小标题', raw7.includes('#### 09:05 · 关于职称材料'), JSON.stringify(raw7.match(/#### .*/g)));
ok('没标题的不写多余分隔符', raw7.includes('#### 23:10\n'), JSON.stringify(raw7.match(/#### .*/g)));
journal.setPinned(d7, '2026-09-18', '09:05', true);
ok('标题和置顶共存',
  fs.readFileSync(journal.weekFilePath(d7, '2026-09-18'), 'utf8')
    .includes('#### 09:05 · 关于职称材料 ·置顶'));
ok('共存时标题与置顶都解析正确', (() => {
  const r = journal.readDay(d7, '2026-09-18').reflections.find((x) => x.time === '09:05');
  return r.title === '关于职称材料' && r.pinned === true && r.body === '正文一段';
})());
ok('只改正文不会把标题冲掉', (() => {
  journal.saveEntry(d7, '2026-09-18', '09:05', '正文改过了');
  const r = journal.readDay(d7, '2026-09-18').reflections.find((x) => x.time === '09:05');
  return r.body === '正文改过了' && r.title === '关于职称材料';
})());
ok('清掉标题', (() => {
  journal.saveEntry(d7, '2026-09-18', '09:05', '正文改过了', '');
  return journal.readDay(d7, '2026-09-18').reflections.find((x) => x.time === '09:05').title === '';
})());
ok('标题里有 · 也不会被当成置顶', (() => {
  journal.saveEntry(d7, '2026-09-18', '23:10', '晚上又想了想', '散步 · 一点想法');
  const r = journal.readDay(d7, '2026-09-18').reflections.find((x) => x.time === '23:10');
  return r.title === '散步 · 一点想法' && r.pinned === false;
})());
// 老格式：标题记在小节上 ### 心得 · 标题
const d8 = path.join(os.tmpdir(), `hua-title-legacy-${Date.now()}`);
fs.mkdirSync(path.join(d8, 'journal'), { recursive: true });
fs.writeFileSync(journal.weekFilePath(d8, '2026-09-18'),
  '# 2026 年第 38 周（09-14 ~ 09-20）\n\n## 09-18 周五\n\n### 心得\n\n老文件里的一段心得\n');
journal.saveEntry(d8, '2026-09-18', '', '老文件里的一段心得', '深深的疲惫');
ok('老格式标题写在小节标题上',
  fs.readFileSync(journal.weekFilePath(d8, '2026-09-18'), 'utf8').includes('### 心得 · 深深的疲惫'));
ok('老格式标题能读回来',
  journal.readDay(d8, '2026-09-18').reflections[0].title === '深深的疲惫');
journal.setPinned(d8, '2026-09-18', '', true);
ok('老格式标题 + 置顶共存', (() => {
  const r = journal.readDay(d8, '2026-09-18').reflections[0];
  return r.title === '深深的疲惫' && r.pinned === true && r.body === '老文件里的一段心得';
})());
ok('索引带上标题', journal.scanAll(d8)[0].title === '深深的疲惫');
fs.rmSync(d7, { recursive: true, force: true });
fs.rmSync(d8, { recursive: true, force: true });

console.log('\n[7] 老库升级：加列 + 新列上的索引必须等 ALTER 之后再建');
const oldDir = path.join(os.tmpdir(), `hua-old-${Date.now()}`);
fs.mkdirSync(oldDir, { recursive: true });
{
  const { DatabaseSync } = require('node:sqlite');
  const o = new DatabaseSync(path.join(oldDir, 'data.db'));
  o.exec(`
    CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE items (
      id TEXT PRIMARY KEY, date TEXT NOT NULL, title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'todo', est_minutes INTEGER, actual_minutes INTEGER,
      start_time TEXT, output TEXT, tags TEXT NOT NULL DEFAULT '[]',
      sort_key REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL, completed_at TEXT);
    CREATE TABLE journal_index (
      id INTEGER PRIMARY KEY AUTOINCREMENT, week TEXT NOT NULL, date TEXT NOT NULL,
      body TEXT NOT NULL, refs TEXT NOT NULL DEFAULT '[]');`);
  o.exec(`INSERT INTO items (id, date, title, status, tags, sort_key, created_at)
          VALUES ('old1', '2026-09-19', '老库里的事', 'todo', '[]', 1, '2026-09-19T00:00:00.000Z')`);
  o.close();
}
let opened = true;
try { db.open(oldDir); } catch (e) { opened = false; console.log('  ' + e.message); }
ok('老库能打开（不会卡在 no such column）', opened);
ok('老库里的事项还在', db.listByDate('2026-09-19').length === 1);
ok('items 补上了 pinned 列', db.getItem('old1') && db.getItem('old1').pinned === false);
ok('置顶查询在老库上可用', db.pinnedItems().length === 0);
db.close();
fs.rmSync(oldDir, { recursive: true, force: true });

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
