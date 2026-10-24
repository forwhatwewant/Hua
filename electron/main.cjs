'use strict';

const { app, BrowserWindow, ipcMain, Tray, Menu, globalShortcut, shell, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const db = require('./db.cjs');
const sleep = require('./sleep.cjs');
const journal = require('./journal.cjs');
const day = require('./day.cjs');
const week = require('./week.cjs');
const stats = require('./stats.cjs');

const DEV = process.env.HUA_DEV === '1';
const DEV_URL = 'http://localhost:5273';
const ROOT = path.join(__dirname, '..');

let win = null;
let quickWin = null;
let tray = null;
let dataDir = '';
let quitting = false;

/* ---------- 日期：日界可配置，默认 04:00（ADR-0004 相关决策） ---------- */

const pad2 = (n) => String(n).padStart(2, '0');

/** 今日页「接下来」区块往前看几天 */
const UPCOMING_DAYS = 7;

function dayStartHour() {
  return day.normalizeHour(db.getMeta('dayStartHour', String(day.DAY_START_DEFAULT)));
}

/** 「今天」按日界计算：凌晨 4 点前算前一天。
    实现在 electron/day.cjs（纯函数，可单独测），这里只负责把配置读出来喂进去。 */
function effectiveToday(now = new Date()) {
  return day.effectiveToday(now, dayStartHour());
}

/* ---------- 界面缩放 ---------- */

/**
 * 内容是按窄栏排的，全屏之后字会显得小。
 * 用 zoomFactor 整体放大（文字、间距、按钮一起变），不是只调字号——
 * 只调字号会让间距显得越来越空，整体缩放才协调。
 * 值存在 meta 里，下次打开还是这个大小。
 */
const ZOOM_MIN = 80;
const ZOOM_MAX = 200;
const ZOOM_DEFAULT = 100;

function zoomFactor() {
  const v = parseInt(db.getMeta('zoom', String(ZOOM_DEFAULT)), 10);
  const n = Number.isFinite(v) ? v : ZOOM_DEFAULT;
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, n)) / 100;
}

function applyZoom(w) {
  if (!w || w.isDestroyed()) return;
  w.webContents.setZoomFactor(zoomFactor());
}

/** 步进缩放并落盘，然后把新值广播回去（设置页要即时看到数字变化） */
function setZoom(percent) {
  const v = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(percent)));
  db.setMeta('zoom', String(v));
  for (const w of [win, quickWin]) applyZoom(w);
  if (win && !win.isDestroyed()) win.webContents.send('zoom:changed', v);
  return v;
}

/** Ctrl +/-/0 与 Ctrl+滚轮。Electron 默认的 zoom 快捷键只在有菜单时才生效，
    而这个窗口是 autoHideMenuBar，所以自己接一套。 */
function registerZoomShortcuts() {
  globalShortcut.register('CommandOrControl+=', () => setZoom(zoomFactor() * 100 + 10));
  globalShortcut.register('CommandOrControl+-', () => setZoom(zoomFactor() * 100 - 10));
  globalShortcut.register('CommandOrControl+0', () => setZoom(ZOOM_DEFAULT));
}

/* ---------- 数据目录 ---------- */

// 数据目录的位置本身得存在「数据库之外」（先有位置才能开库），
// 所以放一个小 JSON 在 userData，其余一切（含设置）都进数据目录，
// 这样「备份 = 整个目录拷走」才是真的。
const locationFile = () => path.join(app.getPath('userData'), 'location.json');

function readLocation() {
  try { return JSON.parse(fs.readFileSync(locationFile(), 'utf8')).dataDir || ''; } catch { return ''; }
}

function writeLocation(p) {
  fs.mkdirSync(path.dirname(locationFile()), { recursive: true });
  fs.writeFileSync(locationFile(), JSON.stringify({ dataDir: p }, null, 2));
}

function resolveDataDir() {
  // 测试/多份数据用：显式指定优先
  if (process.env.HUA_DATA_DIR) return process.env.HUA_DATA_DIR;

  const saved = readLocation();
  if (saved && fs.existsSync(saved)) return saved;

  // 优先落非系统盘（C 盘容易满），都没有才退回「文档」。
  for (const drive of ['E:', 'D:']) {
    try {
      if (fs.existsSync(`${drive}\\`)) return path.join(`${drive}\\`, 'Hua');
    } catch { /* 盘符不可用就试下一个 */ }
  }
  return path.join(app.getPath('documents'), 'Hua');
}

/* ---------- 完成清单快照（ADR-0005：写入后不回改） ---------- */

/** 完成清单里的耗时：优先「实际」，没有实际就退回「预计」。
    创建时填了预计、完成时不填实际，历史里也不该是空的——
    但必须标明是「预计」，不能把估算当事实写进清单。 */
function effMinutes(it) {
  if (it.actualMinutes) return { m: it.actualMinutes, kind: '实际' };
  if (it.estMinutes) return { m: it.estMinutes, kind: '预计' };
  return null;
}

function fmtLine(it) {
  const t = effMinutes(it);
  const suffix = t ? `（${t.kind} ${fmtMinutes(t.m)}）` : '';
  const output = it.output ? ` —— ${it.output}` : '';
  return `- ${it.title}${output}${suffix}`;
}

function fmtMinutes(m) {
  const h = Math.floor(m / 60);
  const mm = Math.round(m % 60);
  return (h ? `${h}h` : '') + (mm || !h ? `${mm}m` : '');
}

/** 启动时把「已经结束的每一天」的完成清单补写进周文件 */
function catchUpSnapshots() {
  const today = effectiveToday();
  let n = 0;
  for (const date of db.datesWithItemsBefore(today)) {
    const done = db.doneOn(date);
    if (!done.length) continue;
    if (journal.snapshotDone(dataDir, date, done.map(fmtLine))) n += 1;
  }
  return n;
}

function rebuildJournalIndex() {
  db.replaceJournalIndex(journal.scanAll(dataDir));
}

/* ---------- 窗口 ---------- */

function loadInto(w, hash = '') {
  if (DEV) return w.loadURL(DEV_URL + hash);
  return w.loadFile(path.join(ROOT, 'dist', 'index.html'), hash ? { hash: hash.slice(1) } : undefined);
}

function createMainWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 560,
    title: '花',
    backgroundColor: '#faf9f7',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.once('ready-to-show', () => win.show());
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); }
  });

  // 缩放要在每次页面加载后重新套一遍：导航会把它重置回 1
  applyZoom(win);
  win.webContents.on('did-finish-load', () => applyZoom(win));

  // Ctrl + 滚轮。renderer 里 preventDefault 掉默认行为，这里只负责改缩放
  win.webContents.on('before-input-event', (event, input) => {
    if (!(input.control || input.meta)) return;
    const k = input.key;
    if (k === '+' || k === '=') { setZoom(zoomFactor() * 100 + 10); event.preventDefault(); }
    else if (k === '-') { setZoom(zoomFactor() * 100 - 10); event.preventDefault(); }
    else if (k === '0') { setZoom(ZOOM_DEFAULT); event.preventDefault(); }
  });

  // HUA_DEBUG=1 时把渲染层的日志与报错打到终端，省得开 DevTools。
  if (process.env.HUA_DEBUG) {
    win.webContents.on('console-message', (...a) => {
      const e = a[0];
      const msg = e && typeof e === 'object' && 'message' in e ? e.message : a[2];
      console.log('[renderer]', msg);
    });
    win.webContents.on('preload-error', (_e, p, err) => console.error('[preload]', p, err));
    win.webContents.on('render-process-gone', (_e, d) => console.error('[renderer gone]', d));
  }

  loadInto(win);
  return win;
}

function createQuickWindow() {
  quickWin = new BrowserWindow({
    width: 560,
    height: 96,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  quickWin.on('blur', () => quickWin.hide());
  loadInto(quickWin, '#/quick');
  return quickWin;
}

function toggleQuick() {
  if (!quickWin) createQuickWindow();
  if (quickWin.isVisible()) { quickWin.hide(); return; }
  quickWin.show();
  quickWin.focus();
  quickWin.webContents.send('quick:focus');
}

function createTray() {
  const iconPath = path.join(ROOT, 'build', 'tray.png');
  const img = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  tray = new Tray(img);
  tray.setToolTip('花');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开「花」', click: () => { if (win) { win.show(); win.focus(); } } },
    { label: '快速记录', click: toggleQuick },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } }
  ]));
  tray.on('click', () => { if (win) { win.show(); win.focus(); } });
}

/* ---------- IPC ---------- */

/** 固定区要用的心得：索引只存 date+time，正文回周文件取（保证是最新的） */
function pinnedReflections(today) {
  return db.pinnedReflections()
    .filter((r) => r.date !== today)          // 今天的在自己那一栏里，不重复
    .map((r) => {
      const day = journal.readDay(dataDir, r.date);
      const hit = (day.reflections || []).find((x) => x.time === (r.time || ''));
      return {
        date: r.date,
        time: r.time || '',
        title: hit ? (hit.title || '') : (r.title || ''),
        body: hit ? hit.body : r.body,
        pinned: true
      };
    })
    .filter((r) => (r.body || '').trim() || (r.title || '').trim());   // 空壳不占位置
}

/** 固定区里的日志：按天聚合（一天一篇），不是按条 */
function pinnedLogs(today) {
  const dates = new Set(db.pinnedReflections().map((r) => r.date));
  const out = [];
  for (const d of dates) {
    if (d === today) continue;                       // 今天的不重复占位
    const log = journal.readDayLog(dataDir, d);
    if ((log.body || '').trim() || (log.title || '').trim()) {
      out.push({ date: d, title: log.title, body: log.body, pinned: true, count: log.count });
    }
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

/** 给睡眠记录补上分档（key + 中文标签）。
    阈值只存在于 electron/sleep.cjs，渲染层不重复定义，免得两边漂移。 */
function annotateSleep(r) {
  const b = sleep.bandOf(r.minutes);
  return { ...r, band: b ? b.key : '', bandLabel: b ? b.label : '' };
}

const SLEEP_SPANS = [14, 30, 90];

/** 最近 90 天有记录的日子里，往前推该 span 天作对照 —— 让「这 30 天」有个参照物。
    只对比平均时长与正常率两个最直观的数。数据不足时返回 null，界面就不显示。 */
function prevStats(recent, today, n) {
  const from = journal.addDays(today, -(2 * n - 1));
  const to = journal.addDays(today, -n);
  const prev = recent.filter((r) => r.date >= from && r.date <= to);
  const cur = recent.filter((r) => r.date >= journal.addDays(today, -(n - 1)));
  const a = sleep.summarize(prev);
  const b = sleep.summarize(cur);
  if (!a || !b) return null;
  return {
    from, to,
    avgDelta: b.avg - a.avg,          // 正数 = 比上一段多睡，单位分钟
    okRateDelta: b.okRate - a.okRate, // 正数 = 比上一段更正常
    avg: a.avg,
    okRate: a.okRate
  };
}

function sleepPayload(today) {
  const recent = db.listSleep(journal.addDays(today, -89), today).map(annotateSleep);
  const stats = {};
  const compare = {};
  for (const n of SLEEP_SPANS) {
    const from = journal.addDays(today, -(n - 1));
    stats[n] = sleep.summarize(recent.filter((r) => r.date >= from));
    if (n === 30) compare[n] = prevStats(recent, today, n);
  }
  const rec = db.getSleep(today);
  return {
    date: today,                                  // 「今天是哪天」——别和下面的 today 混
    today: rec ? annotateSleep(rec) : null,       // 今天的记录，没有就是 null
    recent,
    stats,
    compare,
    spans: SLEEP_SPANS,
    // 阈值随数据一起下发：渲染层用这份算录入预览的档位，不用自己再写一遍常量
    bands: sleep.BANDS.map((b) => ({
      key: b.key, label: b.label, range: b.range, max: b.max === Infinity ? null : b.max
    })),
    minMinutes: sleep.MIN_MINUTES,
    maxMinutes: sleep.MAX_MINUTES,
    // 界面上要显示「依据」——健康类数字得让人知道出处
    guideline: { minHours: 7, maxHours: 9, source: 'Sleep Foundation（NSF 指南）', checkedAt: '2026-09-22' }
  };
}

function bootstrap() {
  const today = effectiveToday();
  const day = journal.readDay(dataDir, today);
  return {
    today,
    settings: {
      dayStartHour: dayStartHour(),
      theme: db.getMeta('theme', 'paper'),
      zoom: parseInt(db.getMeta('zoom', String(ZOOM_DEFAULT)), 10) || ZOOM_DEFAULT,
      dataDir
    },
    items: db.listByDate(today),
    backlog: db.backlog(today),
    unscheduled: db.unscheduled(),
    done: db.doneOn(today),
    // 未来：只带 7 天窗口，更远的只给计数（今日页「接下来」区块）
    upcoming: db.upcoming(today, UPCOMING_DAYS),
    upcomingFar: db.countAfter(journal.addDays(today, UPCOMING_DAYS)),
    reflections: day.reflections,
    // 今天的日志（一天一篇的写法）—— 今日页只给入口，正文在日志页里
    todayLog: { ...journal.readDayLog(dataDir, today), ...db.journalMeta(today) },
    snapshotWritten: day.done.length > 0,
    pins: {
      reflections: pinnedReflections(today),
      logs: pinnedLogs(today),
      items: db.pinnedItems()
    },
    sleep: sleepPayload(today),
    // 备忘：不绑日期，常驻在今日页，当提醒/备忘用
    memos: db.listMemos(),
    // 今天的完成率（口径见 electron/stats.cjs）—— 今日页顶部直接用，不在前端重算
    todayStats: stats.completionOfItems(db.listByDate(today))
  };
}

function registerIpc() {
  ipcMain.handle('app:bootstrap', () => bootstrap());

  ipcMain.handle('items:create', (_e, { date, title, estMinutes, startTime, tags }) =>
    db.createItem({ date, title: String(title).trim(), estMinutes, startTime, tags }));

  ipcMain.handle('items:update', (_e, { id, patch }) => db.updateItem(id, patch));
  ipcMain.handle('items:complete', (_e, { id, actualMinutes, output, doneDate, completedAt }) =>
    db.completeItem(id, { actualMinutes, output, doneDate, completedAt }));
  ipcMain.handle('items:reopen', (_e, { id }) => db.reopenItem(id));
  ipcMain.handle('items:drop', (_e, { id }) => db.setStatus(id, 'dropped'));
  ipcMain.handle('items:delete', (_e, { id }) => { db.deleteItem(id); return true; });
  ipcMain.handle('items:carry', (_e, { ids, date }) => db.carryTo(ids, date));
  ipcMain.handle('items:reorder', (_e, { ids }) => { db.reorder(ids); return true; });
  ipcMain.handle('items:range', (_e, { from, to }) => db.listRange(from, to));
  ipcMain.handle('items:pin', (_e, { id, pinned }) => db.pinItem(id, !!pinned));

  /* 周程板：某一周的 7 天 + 「待分配」池 + 负荷分析 + 完成率。
     不传 weekStart 时默认**本周** —— 打开先看这一周排得怎么样；
     要看下周，点一下「下一周」就行（默认值由主进程定，前端不做日期推算）。 */
  ipcMain.handle('week:board', (_e, { weekStart } = {}) => {
    const today = effectiveToday();
    const start = weekStart ? week.weekStartOf(weekStart) : week.weekStartOf(today);
    const days = journal.weekDays(start);
    const from = days[0];
    const to = days[days.length - 1];

    const rows = db.listRange(from, to);
    /* 固定的事项不属于任何一周 —— 它一直挂在今日页，把它摊到「创建它的那一天」会误导：
       看着像那天要做，其实它天天都在。所以从日列里剔掉，单独给前端一个 pinned 列表，
       用另一种形式（一条带子）展示；也不进「待分配」池，因为它不是待排的东西。 */
    const pinned = rows.filter((it) => it.pinned);
    const normal = rows.filter((it) => !it.pinned);

    const itemsByDate = {};
    for (const d of days) itemsByDate[d] = [];
    for (const it of normal) if (itemsByDate[it.date]) itemsByDate[it.date].push(it);

    const thisWeek = week.weekStartOf(today);
    return {
      weekStart: from,
      weekEnd: to,
      weekKey: journal.weekKey(from),
      today,
      days,
      itemsByDate,
      pinned,
      // 待分配：未完成、且不在这一周里的（遗留 + 更远的未来 + 今天）；固定的不参与排期
      pool: db.openItemsOutside(from, to).filter((it) => !it.pinned),
      load: week.analyze(days, itemsByDate),
      // 完成率只算这一周真正排了的事；固定事项不算进来（它不在这周的盘子里）
      completion: stats.completionOfItems(normal),
      prevStart: week.shiftWeek(from, -1),
      nextStart: week.shiftWeek(from, 1),
      isThisWeek: from === thisWeek,
      isNextWeek: from === week.shiftWeek(thisWeek, 1),
      isPast: from < thisWeek
    };
  });

  /* 完成率总览：整体累计 + 最近若干周的逐周完成率（回顾页「报告」用） */
  ipcMain.handle('stats:overview', (_e, { weeks = 8 } = {}) => {
    const today = effectiveToday();
    const overall = stats.rateOf(db.countByStatus());
    // 起点：往前数 (weeks-1) 周那一周的周一；终点：**本周周日**。
    // 终点取整周而不是 today，是为了和周程板上「本周完成率」口径一致 ——
    // 同一个数在两处显示成不同值，比数字本身不准更糟。
    const thisMonday = week.weekStartOf(today);
    const from = week.shiftWeek(thisMonday, -(weeks - 1));
    const to = journal.addDays(thisMonday, 6);
    const recent = db.listRange(from, to);
    return {
      overall,
      weeks: stats.weekBuckets(recent).slice(-weeks),
      spanWeeks: weeks
    };
  });

  ipcMain.handle('journal:day', (_e, { date }) => journal.readDay(dataDir, date));

  // 心得按「条」存：一天多条，用 HH:MM 当条目身份，另有可选标题
  ipcMain.handle('journal:save', (_e, { date, time, body, title }) => {
    const p = journal.saveEntry(dataDir, date, time, body ?? '', title);
    rebuildJournalIndex();
    db.bumpJournalMeta(date, new Date().toISOString());
    return { path: p };
  });
  ipcMain.handle('journal:add', (_e, { date, body, title }) => {
    const time = journal.addEntry(dataDir, date, body ?? '', title ?? '');
    rebuildJournalIndex();
    db.bumpJournalMeta(date, new Date().toISOString());
    return { time };
  });
  ipcMain.handle('journal:remove', (_e, { date, time }) => {
    journal.removeEntry(dataDir, date, time);
    rebuildJournalIndex();
    db.bumpJournalMeta(date, new Date().toISOString());
    return true;
  });
  ipcMain.handle('journal:pin', (_e, { date, time, pinned }) => {
    const ok = journal.setPinned(dataDir, date, time, !!pinned);
    rebuildJournalIndex();
    return { ok };
  });

  // 日志：一天一篇。存的时候仍然落进周文件的 reflections，磁盘格式没变，
  // 只是写之前会把这一天原有的多条合并成一条。
  ipcMain.handle('log:day', (_e, { date }) => ({
    ...journal.readDayLog(dataDir, date),
    // 编辑记录：首次写于 / 最后改于 / 一共改过几次（周文件里没有这些，存在 journal_meta）
    ...db.journalMeta(date)
  }));
  ipcMain.handle('log:save', (_e, { date, body, title }) => {
    const time = journal.saveDay(dataDir, date, body ?? '', title ?? '');
    rebuildJournalIndex();
    db.bumpJournalMeta(date, new Date().toISOString());
    return { time };
  });
  ipcMain.handle('log:pin', (_e, { date, pinned }) => {
    const ok = journal.setDayPinned(dataDir, date, !!pinned);
    rebuildJournalIndex();
    return { ok };
  });
  // 日志页左栏：最近这些天里哪几天有东西可写（有日志或有事项）
  ipcMain.handle('log:days', (_e, { from, to }) => {
    const days = new Set([
      ...db.datesWithItemsBetween(from, to),
      ...db.datesWithReflectionsBetween(from, to)
    ]);
    // 编辑记录一次性取回，免得逐天查库
    const meta = db.journalMetaMap();
    const out = [];
    for (const d of [...days].sort().reverse()) {
      const log = journal.readDayLog(dataDir, d);
      out.push({
        date: d,
        written: !!(log.body || '').trim(),
        pinned: log.pinned,
        count: log.count,
        title: log.title || '',          // 左栏要显示过往日纪的标题
        createdAt: meta[d]?.createdAt || '',
        updatedAt: meta[d]?.updatedAt || '',
        edits: meta[d]?.edits || 0
      });
    }
    return out;
  });
  ipcMain.handle('journal:snapshot', (_e, { date, force }) => {
    const done = db.doneOn(date);
    const p = journal.snapshotDone(dataDir, date, done.map(fmtLine), { force: !!force });
    // 系统把完成清单归档进日纪：内容变了要更新时间，但不算用户「编辑」了一次
    if (p) { rebuildJournalIndex(); db.touchJournalMeta(date, new Date().toISOString()); }
    return { written: !!p, count: done.length };
  });

  // 睡眠：时长由主进程算，渲染层只送两个时间点 —— 阈值和换算只留一份实现
  ipcMain.handle('sleep:save', (_e, { date, bedTime, wakeTime, note }) => {
    const minutes = sleep.calcMinutes(bedTime, wakeTime);
    if (minutes === null) {
      return { error: `这两个时间点算出来的时长不合理（${sleep.MIN_MINUTES / 60}–${sleep.MAX_MINUTES / 60} 小时之外），检查一下是不是填反了。` };
    }
    const rec = db.saveSleep({ date, bedTime, wakeTime, minutes, note });
    return { record: annotateSleep(rec) };
  });
  ipcMain.handle('sleep:remove', (_e, { date }) => { db.deleteSleep(date); return true; });
  ipcMain.handle('sleep:range', (_e, { from, to }) => db.listSleep(from, to).map(annotateSleep));
  ipcMain.handle('sleep:report', (_e, { from, to }) => generateSleepReport(from, to));

  // 备忘（贴士）：text 必填；time 可选（'' 表示没写时间）；note 是可选的补充说明。
  ipcMain.handle('memos:list', () => db.listMemos());
  ipcMain.handle('memos:create', (_e, { text, time, note }) => db.createMemo({ text, time, note }));
  ipcMain.handle('memos:update', (_e, { id, patch }) => db.updateMemo(id, patch || {}));
  ipcMain.handle('memos:remove', (_e, { id }) => { db.deleteMemo(id); return true; });
  ipcMain.handle('memos:reorder', (_e, { ids }) => { db.reorderMemos(ids || []); return true; });

  ipcMain.handle('review:days', (_e, { from, to }) => {
    // 既要"有事项"的天，也要"只有心得没有事项"的天 —— 后者之前漏了，结果那天的回顾空白
    const days = new Set([
      ...db.datesWithItemsBetween(from, to),
      ...db.datesWithReflectionsBetween(from, to)
    ]);
    const out = [];
    for (const d of [...days].sort()) {
      out.push({ date: d, items: db.listByDate(d), reflections: journal.readDay(dataDir, d).reflections });
    }
    return out.reverse();
  });

  ipcMain.handle('search', (_e, { q }) => {
    const query = String(q || '').trim();
    if (!query) return { journal: [], items: [] };
    return { journal: db.searchJournal(query), items: db.searchItems(query) };
  });

  ipcMain.handle('settings:set', (_e, { k, v }) => { db.setMeta(k, v); return bootstrap().settings; });
  // 缩放：主进程统一应用，避免各窗口各算一遍
  ipcMain.handle('zoom:set', (_e, { percent }) => ({ zoom: setZoom(percent) }));
  ipcMain.handle('shell:openDataDir', () => shell.openPath(dataDir));
  ipcMain.handle('shell:openJournalFile', (_e, { date }) => {
    const p = journal.weekFilePath(dataDir, date);
    return fs.existsSync(p) ? shell.openPath(p) : shell.openPath(journal.journalDir(dataDir));
  });

  ipcMain.handle('report:generate', (_e, { period, anchor }) => generateReport(period, anchor));
  ipcMain.handle('report:list', () => listReports());

  ipcMain.handle('quick:submit', (_e, { title }) => {
    const t = String(title || '').trim();
    if (t) db.createItem({ date: effectiveToday(), title: t });
    if (quickWin) quickWin.hide();
    if (win) win.webContents.send('data:changed');
    return true;
  });
  ipcMain.handle('quick:hide', () => { if (quickWin) quickWin.hide(); });
}

/* ---------- 周报 / 月报：机械汇总，不接 AI（ADR-0006） ---------- */

function reportDir() { return path.join(dataDir, 'reports'); }

function summarize(from, to) {
  const days = db.datesWithItemsBetween(from, to);
  const out = [];
  let total = 0;
  for (const d of days) {
    const done = db.doneOn(d);
    if (!done.length) continue;
    const lines = done.map((it) => {
      const t = effMinutes(it);      // 与 fmtLine 同一口径，合计才对得上清单
      if (t) total += t.m;
      return fmtLine(it);
    });
    const reflections = journal.readDay(dataDir, d).reflections;
    out.push({ date: d, lines, reflections });
  }
  return { days: out, totalMinutes: total };
}

function generateReport(period, anchor) {
  const today = anchor || effectiveToday();
  let from, to, title;
  if (period === 'month') {
    const d = new Date(`${today}T00:00:00`);
    d.setMonth(d.getMonth() - 1, 1);
    const y = d.getFullYear();
    const m = d.getMonth();
    from = `${y}-${pad2(m + 1)}-01`;
    to = `${y}-${pad2(m + 1)}-${pad2(new Date(y, m + 1, 0).getDate())}`;
    title = `${y} 年 ${m + 1} 月`;
  } else {
    const { year, week } = journal.isoWeekOf(today);
    const days = journal.weekDays(today);
    from = days[0];
    to = days[6];
    title = `${year} 年第 ${week} 周`;
  }

  const { days, totalMinutes } = summarize(from, to);
  const parts = [`# ${title}回顾`, '', `覆盖 ${from} ~ ${to}`];
  if (totalMinutes) parts.push(`完成事项合计耗时 ${fmtMinutes(totalMinutes)}`);
  parts.push('');
  for (const day of days) {
    parts.push(`## ${day.date}`, '', '### 完成', ...day.lines);
    // 当天可能有多条心得，逐条汇总（带时间的小标题，跟周文件保持一致）
    const refs = (day.reflections || []).filter((r) => (r.body || '').trim());
    if (refs.length) {
      parts.push('', '### 心得');
      for (const r of refs) {
        if (r.time) parts.push('', `#### ${r.time}${journal.refHead(r.title, r.pinned)}`, '', r.body.trim());
        else parts.push('', r.body.trim());
      }
    }
    parts.push('');
  }
  if (!days.length) parts.push('这段时间没有记录。');

  fs.mkdirSync(reportDir(), { recursive: true });
  const name = period === 'month' ? `month-${from.slice(0, 7)}.md` : `week-${from}.md`;
  const file = path.join(reportDir(), name);
  fs.writeFileSync(file, parts.join('\n'), 'utf8');
  return { file, title, from, to, dayCount: days.length, totalMinutes };
}

/** 睡眠分析报告。正文由 electron/sleep.cjs 生成（那边能单独测），这里只负责落盘。
    跟周报月报一样放到 reports/，一起出现在「报告」列表里。 */
function generateSleepReport(from, to) {
  const records = db.listSleep(from, to);
  const md = sleep.buildReport({ from, to, records });
  fs.mkdirSync(reportDir(), { recursive: true });
  const file = path.join(reportDir(), `sleep-${from}_${to}.md`);
  fs.writeFileSync(file, md, 'utf8');
  // 把正文一起返回：页面上要直接显示，不能只落个文件让用户去目录里找
  return { file, title: `睡眠分析 ${from} ~ ${to}`, from, to, dayCount: records.length, md };
}

function listReports() {
  const dir = reportDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .reverse()
    .map((f) => ({ name: f, path: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }));
}

/** 月报：每月 1 号自动（实际是下次启动时补生成） */
function catchUpMonthlyReports() {
  const today = effectiveToday();
  const d = new Date(`${today}T00:00:00`);
  if (d.getDate() > 1) return 0;
  const prev = new Date(d);
  prev.setMonth(prev.getMonth() - 1, 1);
  const key = `${prev.getFullYear()}-${pad2(prev.getMonth() + 1)}`;
  const file = path.join(reportDir(), `month-${key}.md`);
  if (fs.existsSync(file)) return 0;
  generateReport('month', today);
  return 1;
}

/* ---------- 启动 ---------- */

// 纯文字应用，不需要 GPU 合成。关掉硬件加速可以避开一整类显卡驱动问题
// （受限桌面 / 远程会话 / 老显卡驱动下，GPU 进程常常直接起不来，导致启动即崩）。
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });

  app.whenReady().then(() => {
    app.setName('Hua');

    dataDir = resolveDataDir();
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(journal.journalDir(dataDir), { recursive: true });
    // HUA_DATA_DIR 是测试/临时覆盖，绝不能落进 location.json ——
    // 否则一次带临时目录的调试就会把用户真实的数据目录永久顶掉（踩过一次）。
    if (!process.env.HUA_DATA_DIR) writeLocation(dataDir);

    db.open(dataDir);

    catchUpSnapshots();
    // 清掉往日「点了新增却没写」的空壳心得，今天的不动
    journal.pruneEmpty(dataDir, effectiveToday());
    rebuildJournalIndex();
    catchUpMonthlyReports();

    registerIpc();
    createMainWindow();

    // 开发/打包自测：HUA_SHOT=<png> 时截一张主窗口图然后退出（仅该环境变量存在时生效）。
    // 放在 createTray 之前注册，确保即使托盘初始化失败也不影响截图自测；
    // 同时监听 did-fail-load，加载异常时也能给出日志而非静默。
    if (process.env.HUA_SHOT) {
      const tryShot = async () => {
        try {
          if (process.env.HUA_SHOT_JS) {
            try { await win.webContents.executeJavaScript(process.env.HUA_SHOT_JS); } catch (e) { console.error('shot js:', e.message); }
            await new Promise((r) => setTimeout(r, 1200));
          }
          const img = await win.webContents.capturePage();
          fs.writeFileSync(process.env.HUA_SHOT, img.toPNG());
          console.log('screenshot ->', process.env.HUA_SHOT, JSON.stringify(img.getSize()));
        } catch (e) { console.error('shot failed:', e && e.message); }
        quitting = true;
        app.quit();
      };
      win.webContents.once('did-finish-load', () => setTimeout(tryShot, 1800));
      win.webContents.once('did-fail-load', (_e, code, desc) => { console.error('load failed:', code, desc); setTimeout(tryShot, 1800); });
    }

    // 托盘在某些环境（无桌面会话 / 服务器核心版）可能初始化失败，避免因此崩溃整个应用。
    try { createTray(); } catch (e) { console.error('tray init skipped:', e && e.message); }
    globalShortcut.register('CommandOrControl+Shift+H', toggleQuick);
    registerZoomShortcuts();
  });

  app.on('window-all-closed', () => { /* 常驻托盘，不退出 */ });
  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    db.close();
  });
}
