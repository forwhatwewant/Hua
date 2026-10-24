'use strict';
/* 造一份演示数据到临时目录，用来核对版面。不碰真实数据目录。 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const db = require('../electron/db.cjs');
const journal = require('../electron/journal.cjs');

const dir = process.argv[2] || path.join(os.tmpdir(), 'hua-demo');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
db.open(dir);

// 用「今天」而不是写死的日期，否则第二天跑演示数据就不在今天页上了
const pad = (n) => String(n).padStart(2, '0');
const shift = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const TODAY = shift(0);
const D2 = shift(2);
const D3 = shift(3);

for (const [title, est, start, tags] of [
  ['把 v2 接口的鉴权中间件补上', 90, '12:30', ['开发']],
  ['评审登录模块的重构方案', 45, null, ['开发', '评审']],
  ['回王工那封关于灰度节奏的邮件', 15, null, ['沟通']],
  ['整理这周的线上告警，挑出重复的', 60, null, ['运维']]
]) {
  db.createItem({ date: TODAY, title, estMinutes: est, startTime: start, tags });
}

const doneToday = [];
for (const [title, actual, output, tags] of [
  ['修好了登录流程的 token 过期问题', 95, '根因是 refresh 的时序不对，不是 token 本身', ['开发']],
  ['把 v2 接口的字段命名统一成 snake_case', 40, '顺手补了 12 个字段的注释', ['开发']],
  ['读了同事写的限流方案，提了三条意见', 30, null, ['评审']]
]) {
  const it = db.createItem({ date: TODAY, title, tags });
  db.completeItem(it.id, { actualMinutes: actual, output });
  doneToday.push(db.listByDate(TODAY).find((x) => x.id === it.id));
}

/* 创建时填了预计、完成时不填实际 —— 完成清单应回退显示「预计 xx」而不是空白 */
const estOnly = db.createItem({ date: TODAY, title: '把周报模板改成能一键生成', estMinutes: 30, tags: ['开发'] });
db.setStatus(estOnly.id, 'done');

db.setStatus(db.createItem({ date: TODAY, title: '给新同事讲一遍部署流程' }).id, 'dropped');
db.createItem({ date: D2, title: '研究一下能不能把构建时间压下来' });
db.createItem({ date: D3, title: '跟产品对齐下个版本的范围' });

/* 昨天：有完成清单 + 心得（快照已入档） */
const YDAY = shift(1);
for (const [title, actual, output] of [
  ['把灰度开关从配置中心挪到代码里', 70, '改完发现回滚更麻烦了'],
  ['写完了 v2 的接口文档', 120, null]
]) {
  const it = db.createItem({ date: YDAY, title });
  db.completeItem(it.id, { actualMinutes: actual, output });
}
journal.saveEntry(
  dir,
  YDAY,
  '22:40',
  '今天主要在推 v2 的接口文档。\n\n写文档的时候才发现有几个字段的含义我自己都没想清楚，**写下来就是逼自己想清楚**。\n\n- 灰度的开关挪进代码里，回滚反而更麻烦，明天得问问老周当时的取舍\n- 接口文档还差错误码那一节'
);
journal.snapshotDone(
  dir,
  YDAY,
  db.doneOn(YDAY).map((it) => `- ${it.title}${it.output ? ` —— ${it.output}` : ''}（${it.actualMinutes}m）`)
);

/* 今天：心得里引用了一条事项 */
// 同一天两条：演示「一天多篇 + 折叠」（10:15 那条默认折叠，23:05 那条展开）
journal.saveEntry(
  dir,
  TODAY,
  '10:15',
  '【上午】先把今天要啃的骨头记下来：token 那个 bug 得查清楚，别又拖到半夜。'
);
journal.saveEntry(
  dir,
  TODAY,
  '23:05',
  `今天最值得记的是 token 那个 bug。\n\n前两个小时一直在怀疑是 token 本身的过期逻辑写错了，后来把 [${doneToday[0].title}](hua://item/${doneToday[0].id}) 的日志按时间轴排开，才发现是 refresh 的调用时序问题。\n\n**教训**：先看时序，再看逻辑。`
);

db.replaceJournalIndex(journal.scanAll(dir));
db.close();

console.log('seeded ->', dir);
console.log('today items:', db.listByDate ? '' : '');
