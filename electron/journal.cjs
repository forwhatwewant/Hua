'use strict';

/**
 * 周文件读写。
 *
 * 格式（见 ADR-0004 / ADR-0005）：
 *
 *   # 2026 年第 38 周（09-14 ~ 09-20）
 *
 *   ## 09-14 周一
 *
 *   ### 完成
 *   - 修好了登录流程的 token 过期问题（1.5h）
 *
 *   ### 心得
 *
 *   #### 23:12 · 卡在 token 刷新 ·置顶
 *   今天卡在……
 *
 *   #### 20:05 · 散步时的一点想法
 *   下午散步时又想到一点……
 *
 * 心得按「条」存，一天可以有多条，用 #### HH:MM 分条（时间即顺序，也是条目的身份）。
 * 老格式（### 心得 下直接是正文、没有 ####）向后兼容，当作该天仅有的一条无时间心得。
 *
 * 标题和置顶都写在小标题里：#### HH:MM · 标题 ·置顶
 * 无时间的老条目没有小标题可挂，就记在小节上：### 心得 · 标题 ·置顶
 * ——文件即真相，不另开状态文件。
 *
 * 关键约束：完成清单是「快照」——写入后不再随事项变动回改（ADR-0005）。
 * 心得里引用事项的语法是 [标题](hua://item/<id>)。
 */

const fs = require('node:fs');
const path = require('node:path');

const WD = ['日', '一', '二', '三', '四', '五', '六'];
const pad2 = (n) => String(n).padStart(2, '0');
const dstr = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const fromStr = (s) => new Date(`${s}T00:00:00`);

function addDays(dateStr, n) {
  const d = fromStr(dateStr);
  d.setDate(d.getDate() + n);
  return dstr(d);
}

function isoWeekOf(dateStr) {
  const d = fromStr(dateStr);
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayNum = t.getDay() || 7;
  t.setDate(t.getDate() + 4 - dayNum);
  const yearStart = new Date(t.getFullYear(), 0, 1);
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return { year: t.getFullYear(), week };
}

function weekKey(dateStr) {
  const { year, week } = isoWeekOf(dateStr);
  return `${year}-W${pad2(week)}`;
}

function isoWeekMonday(year, week) {
  const jan4 = Date.UTC(year, 0, 4);
  const dow = new Date(jan4).getUTCDay() || 7;
  const m = new Date(jan4 + (1 - dow) * 86400000 + (week - 1) * 7 * 86400000);
  return `${m.getUTCFullYear()}-${pad2(m.getUTCMonth() + 1)}-${pad2(m.getUTCDate())}`;
}

function weekDays(dateStr) {
  const { year, week } = isoWeekOf(dateStr);
  const monday = isoWeekMonday(year, week);
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

function journalDir(dataDir) {
  return path.join(dataDir, 'journal');
}

function weekFilePath(dataDir, dateStr) {
  return path.join(journalDir(dataDir), `${weekKey(dateStr)}.md`);
}

function emptyDays(dateStr) {
  return Object.fromEntries(weekDays(dateStr).map((d) => [d, { done: [], reflections: [] }]));
}

/* ---------- 时间（心得条目的身份） ---------- */

const nowHM = () => {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

/** HH:MM 加一分钟，跨小时自动进位（用于同一分钟已有条目时顺延） */
function bumpMinute(hm) {
  const [h, m] = String(hm || '00:00').split(':').map(Number);
  const d = new Date(2000, 0, 1, h || 0, (m || 0) + 1);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 解析小标题里时间之后的部分：· 标题 ·置顶
    置顶永远在最后一段，剩下的拼回标题（标题里也可以带 ·）。 */
function parseHeadRest(rest) {
  const parts = String(rest || '')
    .split('·')
    .map((s) => s.trim())
    .filter(Boolean);
  let pinned = false;
  if (parts.length && parts[parts.length - 1] === '置顶') { pinned = true; parts.pop(); }
  return { title: parts.join(' · '), pinned };
}

/* ---------- 解析 ---------- */

function parseWeek(raw, dateStr) {
  const { year, week } = isoWeekOf(dateStr);
  const days = emptyDays(dateStr);
  // 用 MM-DD 反查这一周里的真实日期，避免跨年周归属错乱
  const byMd = Object.fromEntries(weekDays(dateStr).map((d) => [d.slice(5), d]));

  let cur = null;
  let sec = null;
  let buf = [];
  let refTime = null;   // 当前正在收集的心得条目的时间
  let refTitle = '';    // 当前这条的标题
  let refPin = false;   // 当前这条是否置顶
  let secTitle = '';    // 小节标题上的标题——只可能指那条「无时间」的老心得
  let secPin = false;   // 小节标题上的置顶，同上
  let refs = [];        // 当前天已收集到的心得条目

  // 把 buf 里的内容收成一条心得（遇到下一个 #### 或小节结束时调用）
  const pushRef = () => {
    const text = buf.join('\n').trim();
    // 只有「既没时间又没正文」才是空壳，丢掉；
    // 有时间的空条目是用户刚点「新增」还没写，必须留下（之前在这里被过滤掉，导致新增无效）。
    if (text || refTime) refs.push({ time: refTime || '', title: refTitle, body: text, pinned: refPin });
    buf = [];
    refTime = null;
    refTitle = '';
    refPin = false;
  };

  // 读出来统一按时间升序（无时间的老条目排最前），界面和写入顺序才不会随插入先后乱跳
  const byTime = (a, b) => String(a.time || '').localeCompare(String(b.time || ''));

  const flush = () => {
    if (cur && sec) {
      if (sec === 'done') {
        const text = buf.join('\n').trim();
        days[cur].done = text ? text.split('\n').map((l) => l.trim()).filter(Boolean) : [];
      } else {
        pushRef();
        // 老格式那条没有 #### 可挂标记，标题和置顶只能记在小节上：### 心得 · 标题 ·置顶
        const untimed = refs.filter((r) => !r.time);
        if (untimed.length === 1) {          // 多于一条就无从判断指的是哪条，放弃
          if (secPin) untimed[0].pinned = true;
          if (secTitle && !untimed[0].title) untimed[0].title = secTitle;
        }
        days[cur].reflections = [...refs].sort(byTime);
      }
    }
    buf = [];
    refs = [];
    refTime = null;
    refTitle = '';
    refPin = false;
    secTitle = '';
    secPin = false;
    sec = null;
  };

  for (const line of raw.split(/\r?\n/)) {
    const m2 = line.match(/^##\s+(\d{2})-(\d{2})\b/);
    if (m2) {
      flush();
      cur = byMd[`${m2[1]}-${m2[2]}`] || null;
      continue;
    }
    const m3 = line.match(/^###\s+(完成|心得)(?=\s|$)(.*)$/);
    if (m3 && cur) {
      flush();
      sec = m3[1] === '完成' ? 'done' : 'reflection';
      const rest = parseHeadRest(m3[2]);
      secTitle = m3[1] === '心得' ? rest.title : '';
      secPin = m3[1] === '心得' && rest.pinned;
      continue;
    }
    const m4 = line.match(/^####\s+(\d{2}):(\d{2})(?=\s|$)(.*)$/);
    if (m4 && cur && sec === 'reflection') {
      pushRef();
      refTime = `${m4[1]}:${m4[2]}`;
      const rest = parseHeadRest(m4[3]);
      refTitle = rest.title;
      refPin = rest.pinned;
      continue;
    }
    if (cur && sec) buf.push(line);
  }
  flush();
  void year; void week;
  return days;
}

/** 小标题里时间之后的部分：· 标题 ·置顶 */
function refHead(title, pinned) {
  const t = String(title || '').trim().replace(/\s*·\s*/g, ' · ');
  return `${t ? ` · ${t}` : ''}${pinned ? ' ·置顶' : ''}`;
}

function serializeWeek(dateStr, days) {
  const { year, week } = isoWeekOf(dateStr);
  const list = weekDays(dateStr);
  const head = `# ${year} 年第 ${week} 周（${list[0].slice(5)} ~ ${list[6].slice(5)}）`;
  const blocks = [];

  for (const d of list) {
    const day = days[d];
    if (!day) continue;
    const hasDone = day.done && day.done.length > 0;
    // 只丢「既没时间又没正文」的空壳。有时间的空条目要留着——那是用户刚点新增还没写的占位。
    // 排序：无时间（老格式）的排在有时间的之前。否则它会被紧跟在前面的 #### 小节吞掉——
    // 空条目现在也会落盘，一旦 #### 后面是空的，下一段无标记正文就会被算成那一条的正文。
    const refs = (day.reflections || [])
      .filter((r) => r.time || (r.body || '').trim() || (r.title || '').trim())
      .sort((a, b) => (a.time ? 1 : 0) - (b.time ? 1 : 0));
    if (!hasDone && refs.length === 0) continue;

    const wd = WD[fromStr(d).getDay()];
    const parts = [`## ${d.slice(5)} 周${wd}`];
    if (hasDone) parts.push('', '### 完成', ...day.done);
    if (refs.length) {
      // 无时间（老格式）那条没有 #### 可挂，标题和置顶记在小节标题上
      const untimed = refs.filter((r) => !r.time);
      const head = untimed.length === 1 ? refHead(untimed[0].title, untimed[0].pinned) : '';
      parts.push('', `### 心得${head}`);
      for (const r of refs) {
        // 有时间的按 #### HH:MM 分条；没时间的（老格式）直接铺正文，保持与旧文件一致
        if (r.time) {
          parts.push('', `#### ${r.time}${refHead(r.title, r.pinned)}`);
          const body = (r.body || '').trim();
          if (body) parts.push('', body);
        } else {
          parts.push('', (r.body || '').trim());
        }
      }
    }
    blocks.push(parts.join('\n'));
  }

  if (blocks.length === 0) return '';
  return `${head}\n\n${blocks.join('\n\n')}\n`;
}

/* ---------- 读写 ---------- */

function readWeek(dataDir, dateStr) {
  const f = weekFilePath(dataDir, dateStr);
  if (!fs.existsSync(f)) return emptyDays(dateStr);
  return parseWeek(fs.readFileSync(f, 'utf8'), dateStr);
}

function writeWeek(dataDir, dateStr, days) {
  fs.mkdirSync(journalDir(dataDir), { recursive: true });
  const f = weekFilePath(dataDir, dateStr);
  const text = serializeWeek(dateStr, days);
  if (!text) { if (fs.existsSync(f)) fs.unlinkSync(f); return null; }
  fs.writeFileSync(f, text, 'utf8');
  return f;
}

function readDay(dataDir, dateStr) {
  const days = readWeek(dataDir, dateStr);
  return days[dateStr] ?? { done: [], reflections: [] };
}

function ensureDay(days, dateStr) {
  if (!days[dateStr]) days[dateStr] = { done: [], reflections: [] };
  if (!Array.isArray(days[dateStr].reflections)) days[dateStr].reflections = [];
  return days[dateStr];
}

/** 新增一条心得：时间取当前时刻；该分钟已被占用则顺延一分钟（时间是条目身份，必须唯一） */
function addEntry(dataDir, dateStr, body = '', title = '') {
  const days = readWeek(dataDir, dateStr);
  const day = ensureDay(days, dateStr);
  const used = new Set(day.reflections.map((r) => r.time));
  let t = nowHM();
  while (used.has(t)) t = bumpMinute(t);
  day.reflections.push({ time: t, title, body });
  writeWeek(dataDir, dateStr, days);
  return t;
}

/** 写某一条心得（按 time 定位；找不到就补一条）。完成清单不受影响。
    title 传 undefined 表示不动原标题，传字符串（含空串）表示改写。 */
function saveEntry(dataDir, dateStr, time, body = '', title) {
  const days = readWeek(dataDir, dateStr);
  const day = ensureDay(days, dateStr);
  const hit = day.reflections.find((r) => r.time === (time || ''));
  if (hit) {
    hit.body = body;
    if (title !== undefined) hit.title = title;
  } else {
    day.reflections.push({ time: time || '', title: title || '', body });
  }
  return writeWeek(dataDir, dateStr, days);
}

/**
 * 一整天写成一篇（日志视图）。
 *
 * 磁盘格式不动 —— 仍然是一天里的若干条 reflections，只是界面上把它们
 * 首尾相接当成一篇连续正文。合并成**一条**会丢掉各条原本的时间：
 * 那些时间写在 #### HH:MM 小标题里，是有意义的「什么时候写的」。
 *
 * 折算规则：
 * - 按时间升序（无时间的老条目排最前，与读取时的顺序一致）
 * - 空正文的条目直接丢掉（占位壳没有存在价值）
 * - 标题：只有一条且它带标题时，标题上浮成日志标题；多条时各自的标题
 *   降级成正文里的 ### 小标题 —— 这样「一天多条」的信息不会凭空消失
 * - 置顶：任意一条置顶，整篇算置顶
 */
function saveDay(dataDir, dateStr, body = '', title = '') {
  const days = readWeek(dataDir, dateStr);
  const day = ensureDay(days, dateStr);

  const prev = day.reflections || [];
  const sorted = [...prev].sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));
  const pinned = prev.some((r) => r.pinned);

  // 时间：沿用这一天最早一条的时间，**不**改写成「现在」——
  // 否则每敲一个字，这条记录的时间就跳一次。没有就现取一个。
  const time = sorted.find((r) => r.time)?.time || nowHM();

  const text = String(body || '').trim();
  const head = String(title || '').trim();
  if (!text && !head) {
    // 正文和标题都空 —— 整篇清掉（这一天别的东西不受影响）
    day.reflections = [];
    writeWeek(dataDir, dateStr, days);
    return time;
  }

  // 合并成一条。原本各条的标题已经在 readDayLog 拼进正文当了 ### 小标题，
  // 所以用户看到什么、存下去就是什么，不会丢。
  day.reflections = [{ time, title: head, body: text, pinned }];
  writeWeek(dataDir, dateStr, days);
  return time;
}

/**
 * 读出某一天的「日志」正文：把这一天所有心得按时间顺序拼成一篇。
 * 多条之间用它们各自的标题（若有）当 ### 小节，然后正文顺次接上。
 * 返回 { date, body, title, pinned, time, count }，count 是这一天原本有几条。
 */
function readDayLog(dataDir, dateStr) {
  const day = readDay(dataDir, dateStr);
  const list = (day.reflections || [])
    .filter((r) => (r.body || '').trim() || (r.title || '').trim() || r.time)
    .sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));

  if (list.length === 0) {
    return { date: dateStr, body: '', title: '', pinned: false, time: '', count: 0 };
  }

  const pinned = list.some((r) => r.pinned);
  const single = list.length === 1;

  const parts = [];
  for (const r of list) {
    const body = (r.body || '').trim();
    if (single) {
      // 只有一条：正文原样呈现，标题单独返回给标题栏
      if (body) parts.push(body);
    } else {
      // 多条：各自的标题变成正文里的小标题，保住「这段是为什么写的」
      if ((r.title || '').trim()) parts.push(`### ${r.title.trim()}`);
      if (body) parts.push(body);
    }
  }

  return {
    date: dateStr,
    body: parts.join('\n\n'),
    title: single ? (list[0].title || '') : '',
    pinned,
    time: list.find((r) => r.time)?.time || '',
    count: list.length
  };
}

/** 置顶 / 取消置顶一整天的日志 */
function setDayPinned(dataDir, dateStr, pinned) {
  const days = readWeek(dataDir, dateStr);
  const day = ensureDay(days, dateStr);
  if (!day.reflections.length) return false;
  for (const r of day.reflections) r.pinned = !!pinned;
  writeWeek(dataDir, dateStr, days);
  return true;
}

/** 删除某一条心得 */
function removeEntry(dataDir, dateStr, time) {
  const days = readWeek(dataDir, dateStr);
  const day = ensureDay(days, dateStr);
  day.reflections = day.reflections.filter((r) => r.time !== (time || ''));
  return writeWeek(dataDir, dateStr, days);
}

/** 置顶 / 取消置顶某一条心得 */
function setPinned(dataDir, dateStr, time, pinned) {
  const days = readWeek(dataDir, dateStr);
  const day = ensureDay(days, dateStr);
  const hit = day.reflections.find((r) => r.time === (time || ''));
  if (!hit) return false;
  hit.pinned = !!pinned;
  writeWeek(dataDir, dateStr, days);
  return true;
}

/** 清理「今天之前」的空壳心得：有 time 但一直没写正文的占位，
    今天的不动——用户可能刚点新增还没来得及写。 */
function pruneEmpty(dataDir, today) {
  const dir = journalDir(dataDir);
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!/^\d{4}-W\d{2}\.md$/.test(name)) continue;
    const anchor = isoWeekMonday(+name.slice(0, 4), +name.slice(6, 8));
    const f = path.join(dir, name);
    const days = parseWeek(fs.readFileSync(f, 'utf8'), anchor);
    let changed = false;
    for (const [date, day] of Object.entries(days)) {
      if (date >= today) continue;
      const kept = (day.reflections || []).filter((r) => !r.time || (r.body || '').trim());
      if (kept.length !== (day.reflections || []).length) {
        day.reflections = kept;
        changed = true;
        n += 1;
      }
    }
    if (changed) writeWeek(dataDir, anchor, days);
  }
  return n;
}

/** 写入完成清单快照。已写过则默认不覆盖（ADR-0005）。 */
function snapshotDone(dataDir, dateStr, lines, { force = false } = {}) {
  const days = readWeek(dataDir, dateStr);
  const day = ensureDay(days, dateStr);
  if (!force && day.done.length > 0) return null;
  days[dateStr].done = lines;
  return writeWeek(dataDir, dateStr, days);
}

/** 全部周文件 → 索引行（可随时重建，Markdown 始终是真相源） */
function scanAll(dataDir) {
  const dir = journalDir(dataDir);
  if (!fs.existsSync(dir)) return [];
  const rows = [];
  for (const name of fs.readdirSync(dir)) {
    if (!/^\d{4}-W\d{2}\.md$/.test(name)) continue;
    const raw = fs.readFileSync(path.join(dir, name), 'utf8');
    const anchor = isoWeekMonday(+name.slice(0, 4), +name.slice(6, 8));
    const days = parseWeek(raw, anchor);
    for (const [date, day] of Object.entries(days)) {
      // 一条心得一行索引，搜索才能定位到具体哪一条（而不只是哪一天）
      for (const r of (day.reflections || [])) {
        if (!r.body || !r.body.trim()) continue;
        const refs = [...r.body.matchAll(/hua:\/\/item\/([\w-]+)/g)].map((m) => m[1]);
        rows.push({
          week: name.replace('.md', ''),
          date,
          time: r.time || '',
          title: r.title || '',
          body: r.body,
          refs,
          pinned: r.pinned ? 1 : 0
        });
      }
    }
  }
  return rows;
}

module.exports = {
  weekKey, weekDays, weekFilePath, journalDir, isoWeekOf,
  readWeek, writeWeek, readDay, snapshotDone, scanAll, refHead,
  addEntry, saveEntry, removeEntry, setPinned, pruneEmpty,
  readDayLog, saveDay, setDayPinned,
  addDays, dstr
};
