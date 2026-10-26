'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

let db = null;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);

CREATE TABLE IF NOT EXISTS items (
  id             TEXT PRIMARY KEY,
  date           TEXT NOT NULL,
  title          TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'todo',
  est_minutes    INTEGER,
  actual_minutes INTEGER,
  start_time     TEXT,
  output         TEXT,
  note           TEXT NOT NULL DEFAULT '',
  slot           TEXT NOT NULL DEFAULT '',
  tags           TEXT NOT NULL DEFAULT '[]',
  sort_key       REAL NOT NULL DEFAULT 0,
  pinned         INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  completed_at   TEXT
);
CREATE TABLE IF NOT EXISTS journal_meta (
  date       TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  edits      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_items_date   ON items(date);
CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);

CREATE TABLE IF NOT EXISTS journal_index (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  week   TEXT NOT NULL,
  date   TEXT NOT NULL,
  time   TEXT NOT NULL DEFAULT '',
  title  TEXT NOT NULL DEFAULT '',
  body   TEXT NOT NULL,
  refs   TEXT NOT NULL DEFAULT '[]',
  pinned INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_jidx_date ON journal_index(date);

-- 睡眠：一天一条（date 是起床那天，也就是「昨晚」归属的那天）
CREATE TABLE IF NOT EXISTS sleep (
  date       TEXT PRIMARY KEY,
  bed_time   TEXT NOT NULL,
  wake_time  TEXT NOT NULL,
  minutes    INTEGER NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 备忘：不绑定某一天的常驻提醒条，作用是「贴士」而不是待办。
-- 没有完成/归档的概念 —— 用完了直接删，或者改内容继续用。
-- note 是补充说明（显示时字号更小、颜色更淡）；time 是可选的 HH:MM。
CREATE TABLE IF NOT EXISTS memos (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  text       TEXT NOT NULL,
  time       TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT '',
  done       INTEGER NOT NULL DEFAULT 0,
  sort_key   REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
`;

function open(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'data.db');
  db = new DatabaseSync(file);
  db.exec(SCHEMA);
  migrate();
  return file;
}

/** 老库补列。CREATE TABLE IF NOT EXISTS 不会给已存在的表加列，只能显式 ALTER。 */
function migrate() {
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((r) => r.name);
  const addCol = (t, c, ddl) => { if (!cols(t).includes(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${ddl}`); };
  addCol('items', 'pinned', 'pinned INTEGER NOT NULL DEFAULT 0');
  addCol('journal_index', 'time', "time TEXT NOT NULL DEFAULT ''");
  addCol('journal_index', 'title', "title TEXT NOT NULL DEFAULT ''");
  addCol('journal_index', 'pinned', 'pinned INTEGER NOT NULL DEFAULT 0');
  // 日纪的「最后编辑时间」。周文件里没有这个信息，只能存在索引里。
  addCol('journal_index', 'updated_at', "updated_at TEXT NOT NULL DEFAULT ''");
  // 老的「最后编辑时间」存在 journal_index 里，而且每次重建索引都要「认领」回来，很脆。
  // 现在挪到 journal_meta（按日期一行、不参与重建），顺手把老数据搬过来。
  seedJournalMeta();
  // 备忘的「补充」：昨天建的库没有这一列
  addCol('memos', 'note', "note TEXT NOT NULL DEFAULT ''");
  // 事项的「说明/补充」：和备忘的 note 是同一个意思（小字注解），但绑在事项上
  addCol('items', 'note', "note TEXT NOT NULL DEFAULT ''");
  // 时段（上午/下午/晚上）：'' = 没指定，界面上按开始时间推
  addCol('items', 'slot', "slot TEXT NOT NULL DEFAULT ''");
  // 新列上的索引必须等 ALTER 之后再建：老库上先建索引会报 no such column
  db.exec('CREATE INDEX IF NOT EXISTS idx_jidx_pin ON journal_index(pinned)');
}

function close() {
  if (db) { try { db.close(); } catch {} db = null; }
}

const all = (sql, p = []) => db.prepare(sql).all(...p);
const one = (sql, p = []) => db.prepare(sql).get(...p);
const run = (sql, p = []) => db.prepare(sql).run(...p);

function getMeta(k, dflt = null) {
  const row = one('SELECT v FROM meta WHERE k = ?', [k]);
  return row ? row.v : dflt;
}

function setMeta(k, v) {
  run('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', [k, String(v)]);
}

function rowToItem(r) {
  if (!r) return null;
  return {
    id: r.id,
    date: r.date,
    title: r.title,
    status: r.status,
    estMinutes: r.est_minutes,
    actualMinutes: r.actual_minutes,
    startTime: r.start_time,
    output: r.output,
    note: r.note || '',
    slot: r.slot || '',
    tags: safeJson(r.tags, []),
    sortKey: r.sort_key,
    pinned: !!r.pinned,
    createdAt: r.created_at,
    completedAt: r.completed_at
  };
}

function safeJson(s, dflt) {
  try { return JSON.parse(s); } catch { return dflt; }
}

const ITEM_COLS = `id, date, title, status, est_minutes, actual_minutes, start_time, output, note, slot, tags, sort_key, pinned, created_at, completed_at`;

function getItem(id) {
  return rowToItem(one(`SELECT ${ITEM_COLS} FROM items WHERE id = ?`, [id]));
}

function listByDate(date) {
  return all(
    `SELECT ${ITEM_COLS} FROM items WHERE date = ? ORDER BY
       pinned DESC,
       CASE status WHEN 'todo' THEN 0 WHEN 'done' THEN 1 ELSE 2 END,
       CASE WHEN start_time IS NULL THEN 1 ELSE 0 END, start_time, sort_key, created_at`,
    [date]
  ).map(rowToItem);
}

function listRange(from, to) {
  return all(
    `SELECT ${ITEM_COLS} FROM items WHERE date >= ? AND date <= ? ORDER BY date, sort_key, created_at`,
    [from, to]
  ).map(rowToItem);
}

function createItem(it) {
  const now = new Date().toISOString();
  const id = it.id || (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const max = one('SELECT COALESCE(MAX(sort_key), 0) AS m FROM items WHERE date = ?', [it.date])?.m ?? 0;
  run(
    `INSERT INTO items (id, date, title, status, est_minutes, actual_minutes, start_time, output, note, slot, tags, sort_key, created_at)
     VALUES (?, ?, ?, 'todo', ?, NULL, ?, NULL, ?, ?, ?, ?, ?)`,
    [id, it.date, it.title, it.estMinutes ?? null, it.startTime ?? null, it.note ?? '', it.slot ?? '', JSON.stringify(it.tags ?? []), max + 1, now]
  );
  return rowToItem(one(`SELECT ${ITEM_COLS} FROM items WHERE id = ?`, [id]));
}

const UPDATABLE = {
  title: 'title',
  date: 'date',
  status: 'status',
  estMinutes: 'est_minutes',
  actualMinutes: 'actual_minutes',
  startTime: 'start_time',
  output: 'output',
  note: 'note',
  slot: 'slot',
  sortKey: 'sort_key',
  pinned: 'pinned'
};

function updateItem(id, patch) {
  const sets = [];
  const vals = [];
  for (const [k, col] of Object.entries(UPDATABLE)) {
    if (k in patch) { sets.push(`${col} = ?`); vals.push(col === 'pinned' ? (patch[k] ? 1 : 0) : patch[k]); }
  }
  if ('tags' in patch) { sets.push('tags = ?'); vals.push(JSON.stringify(patch.tags ?? [])); }
  if (sets.length === 0) return rowToItem(one(`SELECT ${ITEM_COLS} FROM items WHERE id = ?`, [id]));
  vals.push(id);
  run(`UPDATE items SET ${sets.join(', ')} WHERE id = ?`, vals);
  return rowToItem(one(`SELECT ${ITEM_COLS} FROM items WHERE id = ?`, [id]));
}

/* 标记完成。
   doneDate：完成于哪一天（可留空 = 现在就完成）。
   遗留事项可能是好几天前的事、今天才做完 —— 那就把它挪到「实际做完的那天」，
   否则它会留在原来那天的完成清单里，时间和日期对不上。
   completedAt：完成的具体时间戳（留空 = 现在）。 */
function completeItem(id, { actualMinutes = null, output = null, doneDate = null, completedAt = null } = {}) {
  const at = completedAt || new Date().toISOString();
  if (doneDate) {
    run(
      `UPDATE items SET status = 'done', date = ?, actual_minutes = ?, output = ?, completed_at = ? WHERE id = ?`,
      [doneDate, actualMinutes, output, at, id]
    );
  } else {
    run(
      `UPDATE items SET status = 'done', actual_minutes = ?, output = ?, completed_at = ? WHERE id = ?`,
      [actualMinutes, output, at, id]
    );
  }
  return rowToItem(one(`SELECT ${ITEM_COLS} FROM items WHERE id = ?`, [id]));
}

function reopenItem(id) {
  run(`UPDATE items SET status = 'todo', completed_at = NULL WHERE id = ?`, [id]);
  return rowToItem(one(`SELECT ${ITEM_COLS} FROM items WHERE id = ?`, [id]));
}

function setStatus(id, status) {
  run(`UPDATE items SET status = ?, completed_at = ? WHERE id = ?`,
    [status, status === 'done' ? new Date().toISOString() : null, id]);
  return rowToItem(one(`SELECT ${ITEM_COLS} FROM items WHERE id = ?`, [id]));
}

function deleteItem(id) {
  run('DELETE FROM items WHERE id = ?', [id]);
}

/** 置顶 / 取消置顶一条事项 */
function pinItem(id, pinned) {
  run('UPDATE items SET pinned = ? WHERE id = ?', [pinned ? 1 : 0, id]);
  return rowToItem(one(`SELECT ${ITEM_COLS} FROM items WHERE id = ?`, [id]));
}

/* 今日页「固定」区：**所有**固定的未完成事项，不按日期筛。
   之前这里有个 date <> today，把「今天」那条排除了 —— 结果固定今天的事项时，
   右下角永远不显示，看起来就像固定没生效（用户报过）。
   固定区的意思是「一直挂在这儿」，跟它原本排在哪天无关。 */
function pinnedItems() {
  return all(
    `SELECT ${ITEM_COLS} FROM items
      WHERE pinned = 1 AND status = 'todo'
      ORDER BY date, sort_key, created_at`
  ).map(rowToItem);
}

/** 被置顶的心得（索引里只记 date+time，正文回周文件取最新的） */
function pinnedReflections() {
  return all('SELECT week, date, time, title, body FROM journal_index WHERE pinned = 1 ORDER BY date DESC, time DESC');
}

function backlog(beforeDate) {
  // 固定的不算「前几天没做完」：固定的意思是「一直挂在那儿」，它不欠任何一天。
  // 把它算进遗留，等于把一条提醒变成一笔债（用户报过「固定的都被排到前几天未完成」）。
  return all(
    `SELECT ${ITEM_COLS} FROM items
      WHERE status = 'todo' AND date < ? AND pinned = 0
      ORDER BY date DESC, sort_key`,
    [beforeDate]
  ).map(rowToItem);
}

/** 各状态的件数。给了区间就只算区间内的（按 date）。
    完成率的分母口径见 electron/stats.cjs —— 这里只负责数数。 */
function countByStatus(from = null, to = null) {
  const out = { todo: 0, done: 0, dropped: 0 };
  const rows = (from && to)
    ? all('SELECT status, COUNT(*) AS n FROM items WHERE date >= ? AND date <= ? GROUP BY status', [from, to])
    : all('SELECT status, COUNT(*) AS n FROM items GROUP BY status');
  for (const r of rows) out[r.status] = r.n;
  return out;
}

/** 未完成、且不在给定区间里的事项 —— 周程「待分配」的候选。
    区间就是那一周的周一~周日，所以这些正是「还没排进那一周」的活。
    过去的（遗留）在前，然后今天，然后更远的。 */
function openItemsOutside(from, to) {
  return all(
    `SELECT ${ITEM_COLS} FROM items
      WHERE status = 'todo' AND (date < ? OR date > ?)
      ORDER BY date, sort_key, created_at`,
    [from, to]
  ).map(rowToItem);
}

/* 待分配：还没定哪天做。用 date = '' 表示 —— 它不属于任何一天，
   所以不会出现在 listRange / 某天的列表里，但会自然落进周程的待分配池（'' < 任何日期）。 */
function unscheduled() {
  return all(
    `SELECT ${ITEM_COLS} FROM items WHERE status = 'todo' AND date = ''
      ORDER BY sort_key, created_at`
  ).map(rowToItem);
}

function carryTo(ids, date) {
  const now = new Date().toISOString();
  let max = one('SELECT COALESCE(MAX(sort_key), 0) AS m FROM items WHERE date = ?', [date])?.m ?? 0;
  for (const id of ids) {
    max += 1;
    run('UPDATE items SET date = ?, sort_key = ?, created_at = created_at WHERE id = ?', [date, max, id]);
  }
  return listByDate(date);
}

/** 拖拽排序：按传入顺序把 sort_key 重写为 1..n。
    调用方传应当天全部事项的 id（按目标顺序），同状态组内的相对位置才会一起重排。 */
function reorder(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return false;
  const stmt = db.prepare('UPDATE items SET sort_key = ? WHERE id = ?');
  ids.forEach((id, i) => stmt.run(i + 1, id));
  return true;
}

function doneOn(date) {
  return all(`SELECT ${ITEM_COLS} FROM items WHERE date = ? AND status = 'done' ORDER BY completed_at`, [date]).map(rowToItem);
}

function datesWithItemsBefore(date) {
  return all('SELECT DISTINCT date FROM items WHERE date < ? ORDER BY date', [date]).map((r) => r.date);
}

/** YYYY-MM-DD 加减天数（不与 journal 互相依赖，这里自己算一遍） */
function shiftDays(s, n) {
  const d = new Date(`${s}T00:00:00`);
  d.setDate(d.getDate() + n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 未来窗口内的事项（不含今天），按日期升序 —— 今日页「接下来」区块的数据源。
    只取 window 天，更远的用 countAfter 给个计数，避免区块无限变长。 */
function upcoming(fromDate, windowDays = 7) {
  return all(
    `SELECT ${ITEM_COLS} FROM items WHERE date > ? AND date <= ? ORDER BY
       date, CASE WHEN start_time IS NULL THEN 1 ELSE 0 END, start_time, sort_key, created_at`,
    [fromDate, shiftDays(fromDate, windowDays)]
  ).map(rowToItem);
}

function countAfter(date) {
  return one('SELECT COUNT(*) AS n FROM items WHERE date > ?', [date])?.n ?? 0;
}

function datesWithItemsBetween(from, to) {
  return all('SELECT DISTINCT date FROM items WHERE date >= ? AND date <= ? ORDER BY date', [from, to]).map((r) => r.date);
}

/** 只有心得没有事项的日子 —— review 的时间流也要列出来，不然那天的回顾空白、没法编辑。 */
function datesWithReflectionsBetween(from, to) {
  return all('SELECT DISTINCT date FROM journal_index WHERE date >= ? AND date <= ? ORDER BY date', [from, to]).map((r) => r.date);
}

/* ---------- 睡眠 ---------- */

function rowToSleep(r) {
  return {
    date: r.date,
    bedTime: r.bed_time,
    wakeTime: r.wake_time,
    minutes: r.minutes,
    note: r.note || ''
  };
}

/** 同一天再记一次就覆盖（一天只该有一条） */
function saveSleep(rec) {
  const now = new Date().toISOString();
  run(
    `INSERT INTO sleep (date, bed_time, wake_time, minutes, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       bed_time = excluded.bed_time, wake_time = excluded.wake_time,
       minutes = excluded.minutes, note = excluded.note, updated_at = excluded.updated_at`,
    [rec.date, rec.bedTime, rec.wakeTime, rec.minutes, rec.note || '', now, now]
  );
  return getSleep(rec.date);
}

function getSleep(date) {
  const r = one('SELECT * FROM sleep WHERE date = ?', [date]);
  return r ? rowToSleep(r) : null;
}

function listSleep(from, to) {
  return all('SELECT * FROM sleep WHERE date >= ? AND date <= ? ORDER BY date', [from, to]).map(rowToSleep);
}

function deleteSleep(date) {
  run('DELETE FROM sleep WHERE date = ?', [date]);
}

/* ---------- 备忘（贴士：常驻提醒条） ---------- */

function rowToMemo(r) {
  if (!r) return null;
  return {
    id: r.id,
    text: r.text,
    time: r.time || '',
    note: r.note || '',
    sortKey: r.sort_key,
    createdAt: r.created_at
  };
}

/** 排序：有时间的按时刻先后顶上去，其余按录入顺序。
    备忘没有「完成」这回事（它是贴士不是待办），所以这里不再按 done 分组。 */
function listMemos() {
  return all(
    `SELECT * FROM memos ORDER BY
       CASE WHEN time = '' THEN 1 ELSE 0 END ASC, time ASC,
       sort_key ASC, id ASC`
  ).map(rowToMemo);
}

function createMemo({ text, time, note }) {
  const t = String(text || '').trim();
  if (!t) return null;
  const now = new Date().toISOString();
  // 新的一条排在同组末尾
  const max = one('SELECT MAX(sort_key) AS m FROM memos');
  const key = (max && max.m != null ? max.m : 0) + 1;
  const r = run('INSERT INTO memos (text, time, note, sort_key, created_at) VALUES (?, ?, ?, ?, ?)',
    [t, String(time || '').trim(), String(note || '').trim(), key, now]);
  return getMemo(Number(r.lastInsertRowid));
}

function getMemo(id) {
  return rowToMemo(one('SELECT * FROM memos WHERE id = ?', [id]));
}

function updateMemo(id, patch) {
  const sets = [];
  const vals = [];
  if ('text' in patch) { sets.push('text = ?'); vals.push(String(patch.text || '').trim()); }
  if ('time' in patch) { sets.push('time = ?'); vals.push(String(patch.time || '').trim()); }
  if ('note' in patch) { sets.push('note = ?'); vals.push(String(patch.note || '').trim()); }
  if (!sets.length) return getMemo(id);
  vals.push(id);
  run(`UPDATE memos SET ${sets.join(', ')} WHERE id = ?`, vals);
  return getMemo(id);
}

function deleteMemo(id) {
  run('DELETE FROM memos WHERE id = ?', [id]);
}

function reorderMemos(ids) {
  ids.forEach((id, i) => run('UPDATE memos SET sort_key = ? WHERE id = ?', [i + 1, id]));
}

function allTags() {
  const set = new Set();
  for (const r of all('SELECT tags FROM items')) for (const t of safeJson(r.tags, [])) set.add(t);
  return [...set].sort();
}

function replaceJournalIndex(rows) {
  // 索引是磁盘的镜像，整体重建即可。
  // 「编辑时间」**不在这里** —— 它不在周文件里，重建时保留不住，所以单独放在 journal_meta。
  run('DELETE FROM journal_index');
  const stmt = db.prepare(
    'INSERT INTO journal_index (week, date, time, title, body, refs, pinned) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  for (const r of rows) {
    stmt.run(r.week, r.date, r.time || '', r.title || '', r.body,
      JSON.stringify(r.refs ?? []), r.pinned ? 1 : 0);
  }
}

/* ---------- 日纪的编辑记录 ----------
   一天一行：首次写于 / 最后改于 / 一共改过几次。
   之前只存了一个 updated_at，而且只有 log:save 会写它 ——
   从「回顾」页写心得走的是 journal:add / journal:save，那条路不更新，
   于是界面上的时间永远停在最早那次。现在所有写入口都走 bumpJournalMeta。 */

/** 用户改动了一次：更新时间 + 次数 +1（首次写时顺带记下 created_at）。 */
function bumpJournalMeta(date, iso) {
  run(
    `INSERT INTO journal_meta (date, created_at, updated_at, edits) VALUES (?, ?, ?, 1)
     ON CONFLICT(date) DO UPDATE SET updated_at = excluded.updated_at, edits = journal_meta.edits + 1`,
    [date, iso, iso]
  );
}

/** 系统写入（如自动把完成清单归档进日纪）：只更新时间，不算一次「编辑」。 */
function touchJournalMeta(date, iso) {
  run(
    `INSERT INTO journal_meta (date, created_at, updated_at, edits) VALUES (?, ?, ?, 0)
     ON CONFLICT(date) DO UPDATE SET updated_at = excluded.updated_at`,
    [date, iso, iso]
  );
}

/** { createdAt, updatedAt, edits } —— 从没写过就是三个空值。 */
function journalMeta(date) {
  const r = one('SELECT created_at, updated_at, edits FROM journal_meta WHERE date = ?', [date]);
  return r
    ? { createdAt: r.created_at || '', updatedAt: r.updated_at || '', edits: r.edits || 0 }
    : { createdAt: '', updatedAt: '', edits: 0 };
}

/** { 'YYYY-MM-DD': { createdAt, updatedAt, edits } } —— 给日纪列表一次性取回。 */
function journalMetaMap() {
  const out = {};
  for (const r of all('SELECT date, created_at, updated_at, edits FROM journal_meta')) {
    out[r.date] = { createdAt: r.created_at || '', updatedAt: r.updated_at || '', edits: r.edits || 0 };
  }
  return out;
}

/** 把老库里 journal_index.updated_at 的时间搬进 journal_meta（只搬一次）。 */
function seedJournalMeta() {
  const has = one('SELECT COUNT(*) AS n FROM journal_meta')?.n ?? 0;
  if (has > 0) return;
  for (const r of all(
    "SELECT date, MAX(updated_at) AS u FROM journal_index WHERE updated_at <> '' GROUP BY date"
  )) {
    run(
      'INSERT INTO journal_meta (date, created_at, updated_at, edits) VALUES (?, ?, ?, 1)',
      [r.date, r.u, r.u]
    );
  }
}

/* 兼容旧名字：外面还在用这两个的语义 */
function setJournalUpdated(date, iso) { bumpJournalMeta(date, iso); }
function logUpdatedAt(date) { return journalMeta(date).updatedAt; }
function logUpdatedMap() {
  const out = {};
  for (const [d, m] of Object.entries(journalMetaMap())) out[d] = m.updatedAt;
  return out;
}

/** 标题也算检索范围——只搜正文的话，用户给心得起的标题搜不到 */
function searchJournal(q) {
  const like = `%${q}%`;
  return all(
    `SELECT date, week, time, title, body FROM journal_index
      WHERE body LIKE ? OR title LIKE ? ORDER BY date DESC, time DESC LIMIT 200`,
    [like, like]
  );
}

function searchItems(q) {
  const like = `%${q}%`;
  return all(
    `SELECT ${ITEM_COLS} FROM items WHERE title LIKE ? OR output LIKE ? OR note LIKE ? ORDER BY date DESC LIMIT 200`,
    [like, like, like]
  ).map(rowToItem);
}

module.exports = {
  open, close, getMeta, setMeta,
  listByDate, listRange, getItem, createItem, updateItem, completeItem, reopenItem,
  setStatus, deleteItem, backlog, carryTo, reorder, doneOn, allTags,
  countByStatus, openItemsOutside, unscheduled,
  datesWithItemsBefore, datesWithItemsBetween, shiftDays, upcoming, countAfter, datesWithReflectionsBetween,
  pinItem, pinnedItems, pinnedReflections,
  replaceJournalIndex, searchJournal, searchItems,
  setJournalUpdated, logUpdatedAt, logUpdatedMap,
  bumpJournalMeta, touchJournalMeta, journalMeta, journalMetaMap,
  saveSleep, getSleep, listSleep, deleteSleep,
  listMemos, getMemo, createMemo, updateMemo, deleteMemo, reorderMemos
};
