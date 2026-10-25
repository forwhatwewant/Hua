import { Fragment, useEffect, useRef, useState } from 'react';
import CompleteModal from '../components/CompleteModal.jsx';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import DoneList from '../components/DoneList.jsx';
import EditItemModal from '../components/EditItemModal.jsx';
import { shift } from '../dates.js';
import { SLOTS, groupBySlot, slotOf } from '../slot.js';
import { nightLabel } from '../dates.js';
import { rateText } from '../rate.js';

const POOL = 'pool';   // addDate 的哨兵：记进待分配（没有日期）

const WD = ['日', '一', '二', '三', '四', '五', '六'];

/** 把 Markdown 压成一行纯文本，用于摘要和预览 */
function previewText(body) {
  const plain = String(body || '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^>\s*/gm, '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > 80 ? `${plain.slice(0, 80)}…` : plain;
}

function fmtMin(m) {
  if (!m) return '';
  const h = Math.floor(m / 60);
  const mm = Math.round(m % 60);
  const parts = [];
  if (h) parts.push(`${h} 小时`);
  if (mm || !h) parts.push(`${mm} 分`);   // 整小时不再留下「2 小时 」这种尾空格
  return parts.join(' ');
}

function niceDate(s) {
  const d = new Date(`${s}T00:00:00`);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 · 周${WD[d.getDay()]}`;
}

/** 相对说法：今天 / 明天 / 后天 / 周三 / 9月25日 —— 未来区块里比绝对日期好读 */
function relLabel(today, s) {
  if (s === today) return '今天';
  if (s === shift(today, -1)) return '昨天';
  if (s === shift(today, 1)) return '明天';
  if (s === shift(today, 2)) return '后天';
  const d = new Date(`${s}T00:00:00`);
  const diff = Math.round((d - new Date(`${today}T00:00:00`)) / 86400000);
  if (diff > 0 && diff < 7) return `周${WD[d.getDay()]}`;
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

/** 睡眠时长：和睡眠页一样的说法（整小时不留尾空格）。导出来是为了能单测。 */
export function fmtSleepDur(m) {
  if (!m && m !== 0) return '';
  const h = Math.floor(m / 60);
  const mi = Math.round(m % 60);
  const parts = [];
  if (h) parts.push(`${h} 小时`);
  if (mi || !h) parts.push(`${mi} 分`);
  return parts.join(' ');
}

/** 今日页顶部那张睡眠卡要显示什么。
 *  「昨晚睡了多久」是早上打开应用最想先知道的事，所以放到今日记录最上面。
 *  优先今天的记录；今天还没记就退回最近一条（标注是哪天的），都没有则 null。 */
export function lastNight(sleep) {
  if (!sleep) return null;
  if (sleep.today) return { ...sleep.today, stale: false };
  const recent = sleep.recent || [];
  if (!recent.length) return null;
  // recent 按日期升序，最后一条就是最近的那次
  const last = recent[recent.length - 1];
  return { ...last, stale: last.date !== sleep.date };
}

/** 最近 n 条记录里的时长数组，给迷你趋势条用（老的在前）。 */
export function miniTrend(recent, n = 7) {
  if (!Array.isArray(recent)) return [];
  return recent.slice(-n).map((r) => r.minutes);
}

/** 备忘左侧的固定标记：一朵小花。
 *  刻意**不是**勾选框 —— 备忘是贴士，不需要被「完成」。
 *  纯装饰，不响应点击（改/删在右边）。 */
function MemoMark() {
  return (
    <svg className="memo-mark" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <g fill="currentColor">
        <circle cx="6" cy="2.7" r="1.95" />
        <circle cx="6" cy="9.3" r="1.95" />
        <circle cx="2.7" cy="6" r="1.95" />
        <circle cx="9.3" cy="6" r="1.95" />
      </g>
      <circle cx="6" cy="6" r="1.3" fill="var(--surface)" />
    </svg>
  );
}

export default function Today({ boot, reload, onOpenLogAt, onOpenSleep }) {
  const [title, setTitle] = useState('');
  const [est, setEst] = useState('');
  const [completing, setCompleting] = useState(null);
  const [editing, setEditing] = useState(null);
  const [confirming, setConfirming] = useState(null);
  const [showBacklog, setShowBacklog] = useState(false);   // 遗留默认收起：打开就是今天，想拉旧的再点开
  const [showUpcoming, setShowUpcoming] = useState(false);
  const [addDate, setAddDate] = useState('');      // '' = 今天；POOL = 待分配；否则是 YYYY-MM-DD
  const [datePick, setDatePick] = useState(false);
  const [estPick, setEstPick] = useState(false);   // 预计耗时的快捷选择
  // 时段：记的时候就能说是上午还是晚上。留空 = 未安排（列表里排在最后那一档）。
  const [slot, setSlot] = useState('');
  const [slotPick, setSlotPick] = useState(false);
  // 「不定时」：现在不估，做完在完成弹窗里填实际耗时。数据上就是 estMinutes = null，
  // 单独记一个状态只是为了在录入框上显示出来（空着 vs 明确选过，看起来不一样）。
  const [untimed, setUntimed] = useState(false);
  const [saveNote, setSaveNote] = useState('');
  const noteTimer = useRef(null);    // 「已写入」提示的消失定时器
  const [dragId, setDragId] = useState(null);
  const [over, setOver] = useState(null);   // { id, after: boolean }
  /* 备忘条：常驻提醒。一行文字 + 可选时间，不绑日期。
     录入框的 time 用一个 <input type="time">，留空就是没时间。 */
  const [memoText, setMemoText] = useState('');
  const [memoTime, setMemoTime] = useState('');
  const [memoNote, setMemoNote] = useState('');   // 补充说明（可留空）
  /* 正在就地改的那条备忘（点文字改）。null = 没有。 */
  const [memoEdit, setMemoEdit] = useState(null);   // { id, text, time, note }
  const memos = boot.memos || [];
  /* 固定区块里就地展开的那几条（日志用 date 做键，事项用 id）。
     固定区常常是「想起来才看一眼」，就地展开不用跳页、不丢上下文。 */
  const [expanded, setExpanded] = useState(() => new Set());
  const toggleExpand = (key) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const visible = boot.items;
  const todo = visible.filter((i) => i.status === 'todo');
  const dropped = visible.filter((i) => i.status === 'dropped');
  // 待分配：还没定哪天做的事（date 为空）
  const unscheduled = boot.unscheduled || [];

  /* 上午 / 下午 / 晚上：按时段分组，组之间插一条很轻的隔断。
     三档**一直画**（空档只留一行小字，不画线）—— 之前「一条都没指定就整块不画」，
     结果是用户看到的就是「日程没有早中晚」。骨架要稳定。 */
  const grouped = groupBySlot(visible);
  const ordered = grouped.flatMap((g) => g.items);

  // 录入目标日期：默认今天，可在输入框上切到明天/后天/具体某天
  // '' 已经被「今天」占用（addDate 为空就是今天），所以「待分配」单独用一个哨兵
  const targetDate = addDate === POOL ? '' : (addDate || boot.today);

  /* 录入框上的两个小弹层（日期 / 预计耗时）：点别处或按 Esc 要能关掉。
     原来点开了只能再点一次那个按钮才收，很容易误以为卡住。 */
  useEffect(() => {
    if (!datePick && !estPick) return undefined;
    const onDown = (e) => {
      if (!(e.target instanceof Element) || !e.target.closest('.ct-wrap')) {
        setDatePick(false);
        setEstPick(false);
      }
    };
    const onKey = (e) => { if (e.key === 'Escape') { setDatePick(false); setEstPick(false); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [datePick, estPick]);

  // 未来事项按天分组（bootstrap 已按 date 升序返回，这里只做切分）
  const upGroups = [];
  for (const it of boot.upcoming || []) {
    const g = upGroups[upGroups.length - 1];
    if (g && g.date === it.date) g.items.push(it);
    else upGroups.push({ date: it.date, items: [it] });
  }
  const upTotal = (boot.upcoming || []).length;

  // 日志入口的摘要：给一段正文开头，让人知道今天写没写过、写了什么
  const logBody = (boot.todayLog?.body || '').trim();
  const logWords = logBody ? logBody.replace(/\s/g, '').length : 0;
  const logPreview = logBody
    ? `${logBody.replace(/^#{1,6}\s*/gm, '').replace(/[*_`>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60)}${logBody.length > 60 ? '…' : ''}`
    : '';

  // 昨晚睡了多久：早上打开最想先看到的东西。今天没记就退回最近一条（标出是哪天）。
  const night = lastNight(boot.sleep);
  const trend = miniTrend(boot.sleep?.recent, 7);

  const add = async () => {
    const t = title.trim();
    if (!t) return;
    await window.hua.items.create({
      date: targetDate,
      title: t,
      estMinutes: est ? Number(est) : null,
      slot: slot || null
    });
    setTitle('');
    setEst('');
    setUntimed(false);
    setSlot('');
    // 排到未来 / 待分配的事项不会出现在今天的列表里，给一句即时回执，免得以为没记上
    if (!targetDate) flash('已放进待分配');
    else if (targetDate !== boot.today) flash(`已排到${relLabel(boot.today, targetDate)}`);
    reload();
  };

  /** 把未来（或任意）事项拉到今天 —— 与遗留区块的「移到今天」同一条语义 */
  const bringToToday = async (it) => {
    await window.hua.items.carry({ ids: [it.id], date: boot.today });
    reload();
  };

  const reopen = async (it) => { await window.hua.items.reopen({ id: it.id }); reload(); };
  const drop = async (it) => { await window.hua.items.drop({ id: it.id }); reload(); };
  const remove = async (it) => {
    await window.hua.items.remove({ id: it.id });
    setConfirming(null);
    reload();
  };

  /* 待分配：把日期清空。它不属于任何一天，所以会从今天的列表里消失，
     落到「待分配」窗口里；周程的待分配池也会自然带上它（'' 比任何日期都小）。 */
  const unassign = async (it) => {
    await window.hua.items.update({ id: it.id, patch: { date: '' } });
    reload();
  };

  // 从待分配里挑一天：放回去
  const assignFromPool = async (it, date) => {
    await window.hua.items.update({ id: it.id, patch: { date } });
    reload();
  };

  const carryAll = async () => {
    await window.hua.items.carry({ ids: boot.backlog.map((i) => i.id), date: boot.today });
    reload();
  };

  /* 遗留的多选 + 批量处理 */
  const [backSel, setBackSel] = useState([]);
  const [bulkDoneOpen, setBulkDoneOpen] = useState(false);
  const [bulkDoneDate, setBulkDoneDate] = useState('');
  const [bulkConfirm, setBulkConfirm] = useState(false);

  const toggleBack = (id) =>
    setBackSel((sel) => (sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]));
  const backAll = boot.backlog.length > 0 && backSel.length === boot.backlog.length;
  const toggleBackAll = () => setBackSel(backAll ? [] : boot.backlog.map((i) => i.id));

  const bulkCarry = async () => {
    await window.hua.items.carry({ ids: backSel, date: boot.today });
    setBackSel([]);
    reload();
  };

  /* 批量完成：统一记到某一天的完成清单里（默认今天） */
  const bulkComplete = async (date) => {
    const d = date || boot.today;
    for (const id of backSel) {
      await window.hua.items.complete({
        id,
        doneDate: d,
        completedAt: d === boot.today ? null : new Date(`${d}T12:00:00`).toISOString()
      });
    }
    setBackSel([]);
    setBulkDoneOpen(false);
    reload();
  };

  const bulkDelete = async () => {
    for (const id of backSel) await window.hua.items.remove({ id });
    setBackSel([]);
    setBulkConfirm(false);
    reload();
  };

  const carryOne = async (it) => {
    await window.hua.items.carry({ ids: [it.id], date: boot.today });
    reload();
  };

  // 拖拽排序：仅在今天的可视列表内部重排，按 drop 目标的上/下半决定插入点
  const onDragStart = (e, id) => {
    e.dataTransfer.effectAllowed = 'move';
    setDragId(id);
  };
  const onDragOverItem = (e, it) => {
    if (!dragId || it.id === dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const r = e.currentTarget.getBoundingClientRect();
    setOver({ id: it.id, after: e.clientY > r.top + r.height / 2 });
  };
  const onDropItem = async (e, it) => {
    e.preventDefault();
    const src = dragId;
    const insertAfter = over?.after;
    setDragId(null); setOver(null);
    if (!src || src === it.id) return;
    // 按分组后的显示顺序算 —— 用户看到什么顺序，就按什么顺序落 sortKey
    const ids = ordered.map((i) => i.id);
    const next = ids.filter((id) => id !== src);
    const i = next.indexOf(it.id);
    if (i < 0) return;
    next.splice(insertAfter ? i + 1 : i, 0, src);
    await window.hua.items.reorder({ ids: next });
    // 拖到别的时段里 = 顺便改时段，否则它会被重新分组「弹回去」，看着像没拖动
    const srcItem = visible.find((x) => x.id === src);
    if (srcItem && slotOf(srcItem) !== slotOf(it)) {
      await window.hua.items.update({ id: src, patch: { slot: slotOf(it) } });
    }
    reload();
  };

  /* 日志正文搬去了「日志」页（一天一篇）。这里只保留固定区要用的数据。 */
  const pins = boot.pins || { logs: [], items: [] };
  const pinnedCount = (pins.logs || []).length + (pins.items || []).length;

  const pinItem = async (it) => {
    await window.hua.items.pin({ id: it.id, pinned: !it.pinned });
    reload();
  };

  // 固定区里直接完成一条往日事项：走和今日事项同一个完成弹窗，产出同样会入档
  const completePinned = (it) => setCompleting(it);

  const flash = (msg) => {
    setSaveNote(msg);
    clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setSaveNote(''), 2500);
  };

  /* ---------- 备忘（贴士） ---------- */
  const addMemo = async () => {
    const t = memoText.trim();
    if (!t) return;
    await window.hua.memos.create({ text: t, time: memoTime, note: memoNote });
    setMemoText('');
    setMemoTime('');
    setMemoNote('');
    reload();
  };
  const removeMemo = async (m) => {
    await window.hua.memos.remove({ id: m.id });
    reload();
  };
  const saveMemoEdit = async () => {
    if (!memoEdit) return;
    const t = memoEdit.text.trim();
    // 清空了就当删除，跟大多数清单的手感一致
    if (!t) { await window.hua.memos.remove({ id: memoEdit.id }); }
    else {
      await window.hua.memos.update({
        id: memoEdit.id,
        patch: { text: t, time: memoEdit.time, note: memoEdit.note || '' }
      });
    }
    setMemoEdit(null);
    reload();
  };

  const snapshotNow = async () => {
    const r = await window.hua.journal.snapshot({ date: boot.today, force: true });
    reload();   // 让 boot.snapshotWritten 跟上，否则「完成清单明天入档」提示一直不更新
    flash(`完成清单已写入（${r.count} 件）`);
  };

  return (
    <div className="pagehead" style={{ flex: 1, minHeight: 0, flexDirection: 'column', alignItems: 'stretch', padding: 0 }}>
      <div className="pagehead" style={{ padding: '22px 30px 12px' }}>
        <h1>今天</h1>
        <span className="sub">{niceDate(boot.today)}</span>
        <span className="grow" />
        {saveNote && <span className="sub">{saveNote}</span>}
      </div>

      {/* 录入框 = 这个页面的主角。
          设计上刻意做成「一条可以写的线 + 一行很轻的注解」：
          - 标题是唯一抢眼的东西（18px，压在一道细线上，像在纸上写一行）；
          - 日期 / 预计耗时退成小字注解，不用的时候几乎看不见；
          - 「记下」只在写了东西之后才浮出来 —— 空着的时候整张卡是干净的。
          90% 的情况就是「写一行、回车」，别的一概不打扰。 */}
      <div className="composer-hero-wrap">
        <div className={`composer composer-hero${title.trim() ? ' has-text' : ''}`}>
          <input
            type="text"
            className="composer-title"
            value={title}
            placeholder={
              addDate === POOL ? '记一件还没定哪天的事…'
                : (targetDate === boot.today ? '记一件事…' : `记到${relLabel(boot.today, targetDate)}的事…`)
            }
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />

          <div className="composer-meta">
            {/* 记到哪天 */}
            <span className="ct-wrap">
              <button
                className={`ct-link${targetDate !== boot.today ? ' on' : ''}`}
                onClick={() => { setEstPick(false); setSlotPick(false); setDatePick((v) => !v); }}
                title="记到哪一天"
              >
                {addDate === POOL ? '待分配' : relLabel(boot.today, targetDate)}<i className="ct-caret">▾</i>
              </button>
              {datePick && (
                <div className="ct-pop">
                  <button className={`dp-chip${targetDate === boot.today ? ' on' : ''}`}
                    onClick={() => { setAddDate(''); setDatePick(false); }}>今天</button>
                  <button className={`dp-chip${addDate === shift(boot.today, 1) ? ' on' : ''}`}
                    onClick={() => { setAddDate(shift(boot.today, 1)); setDatePick(false); }}>明天</button>
                  <button className={`dp-chip${addDate === shift(boot.today, 2) ? ' on' : ''}`}
                    onClick={() => { setAddDate(shift(boot.today, 2)); setDatePick(false); }}>后天</button>
                  <button
                    className={`dp-chip${addDate === POOL ? ' on' : ''}`}
                    onClick={() => { setAddDate(POOL); setDatePick(false); }}
                    title="先不定哪天做，放进「待分配」"
                  >
                    待分配
                  </button>
                  <input
                    type="date"
                    className="dp-date"
                    value={targetDate}
                    min={boot.today}
                    title="选一个具体日期"
                    onChange={(e) => { if (e.target.value) { setAddDate(e.target.value); setDatePick(false); } }}
                  />
                </div>
              )}
            </span>

            <span className="ct-dot">·</span>

            {/* 时段：记的时候就说是上午还是晚上。留空 = 未安排（列表里排最后一档） */}
            <span className="ct-wrap">
              <button
                className={`ct-link${slot ? ' on' : ''}`}
                onClick={() => { setDatePick(false); setEstPick(false); setSlotPick((v) => !v); }}
                title="这件事放在上午、下午还是晚上"
              >
                {slot ? (SLOTS.find((s) => s.key === slot)?.label ?? '时段') : '时段'}<i className="ct-caret">▾</i>
              </button>
              {slotPick && (
                <div className="ct-pop">
                  {SLOTS.map((s) => (
                    <button
                      key={s.key}
                      className={`dp-chip${slot === s.key ? ' on' : ''}`}
                      onClick={() => { setSlot(s.key); setSlotPick(false); }}
                    >
                      {s.label}
                    </button>
                  ))}
                  <button
                    className={`dp-chip${slot === '' ? ' on' : ''}`}
                    onClick={() => { setSlot(''); setSlotPick(false); }}
                    title="先不排进某一段，放在「未安排」里"
                  >
                    不指定
                  </button>
                </div>
              )}
            </span>

            <span className="ct-dot">·</span>

            {/* 预计耗时：给几个常用档点，不用手打数字 */}
            <span className="ct-wrap">
              <button
                className={`ct-link${est || untimed ? ' on' : ''}`}
                onClick={() => { setDatePick(false); setSlotPick(false); setEstPick((v) => !v); }}
                title="预计要花多久；选「不定时」就等做完再填实际耗时"
              >
                {est ? `预计 ${est} 分钟` : (untimed ? '不定时' : '预计耗时')}<i className="ct-caret">▾</i>
              </button>
              {estPick && (
                <div className="ct-pop">
                  {[15, 30, 45, 60, 90, 120].map((n) => (
                    <button
                      key={n}
                      className={`dp-chip${Number(est) === n ? ' on' : ''}`}
                      onClick={() => { setEst(String(n)); setUntimed(false); setEstPick(false); }}
                    >
                      {n}
                    </button>
                  ))}
                  <button
                    className={`dp-chip${untimed ? ' on' : ''}`}
                    onClick={() => { setEst(''); setUntimed(true); setEstPick(false); }}
                    title="现在不估，做完在完成弹窗里填实际耗时"
                  >
                    不定时
                  </button>
                  <input
                    type="number"
                    min="0"
                    className="dp-date"
                    style={{ width: 92 }}
                    value={est}
                    placeholder="自定义"
                    title="自定义分钟数"
                    onChange={(e) => { setEst(e.target.value); setUntimed(false); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') setEstPick(false); }}
                  />
                </div>
              )}
            </span>

            <span className="grow" />

            {/* 写了东西才浮出来 —— 空卡不该摆一个「保存」按钮在那儿催你 */}
            <button className="composer-btn" onClick={add} tabIndex={-1}>记下 <span className="cb-key">↵</span></button>
          </div>
        </div>
      </div>

      <div className="scroll" style={{ paddingTop: 0 }}>
        <div className="today">
          {/* 左：今日事项 */}
          <section className="pane">
            <div className="pane-head">
              <span>今日事项</span>
              <span className="grow" />
              <span>{todo.length} 待办 · {boot.done.length} 完成{dropped.length ? ` · ${dropped.length} 放弃` : ''}</span>
              {/* 今天的完成率。口径由主进程算（见 electron/stats.cjs）：
                  完成 / 全部事项；放弃的按未完成计，只有删除才不算。 */}
              <span className="todayrate" title="完成率 = 完成 / 全部事项；放弃的按未完成计，只有删除才不算">
                完成率 <b>{rateText(boot.todayStats)}</b>
              </span>
            </div>

            {/* 作曲器已提到两栏之上（见 composer-hero）——
                「记一件事」是这个应用最核心的动作，不该缩在左栏里当一个小方块。 */}

            <div className="pane-body pane-left">
              <div className="pane-scroll">
              {/* 遗留：默认收起，只留一个入口（ADR-0008：不顺延，手动拉）。
                  打开应用的第一眼应该是「今天」，而不是被前几天没做完的事占满。 */}
              {boot.backlog.length > 0 && (
                <div className="backsect">
                  <button className="backsect-head" onClick={() => setShowBacklog((v) => !v)}>
                    <span>前几天遗留</span>
                    <span className="back-count">{boot.backlog.length}</span>
                    <span className="grow" />
                    <span className="chev">{showBacklog ? '收起' : '展开'}</span>
                  </button>
                  {showBacklog && (
                    <>
                      <div className="items">
                        {boot.backlog.map((it) => (
                          <div className={`item back${backSel.includes(it.id) ? ' sel' : ''}`} key={it.id}>
                            <input
                              type="checkbox"
                              className="back-check"
                              checked={backSel.includes(it.id)}
                              onChange={() => toggleBack(it.id)}
                              title="选中，之后可以一起处理"
                            />
                            <div>
                              <div className="it-title">{it.title}</div>
                              <div className="it-meta"><span>{it.date}</span></div>
                            </div>
                            <div className="it-actions" style={{ opacity: 1 }}>
                              <button onClick={() => carryOne(it)}>移到今天</button>
                              <button onClick={() => setCompleting(it)}>完成</button>
                              <button className="del" onClick={() => setConfirming(it)}>删除</button>
                            </div>
                          </div>
                        ))}
                      </div>
                      <div className="backsect-foot backfoot">
                        <label className="back-all">
                          <input type="checkbox" checked={backAll} onChange={toggleBackAll} />
                          全选
                        </label>
                        {backSel.length > 0 ? (
                          <>
                            <span className="back-selnum">已选 {backSel.length} 件</span>
                            <button className="btn" style={{ padding: '4px 10px', fontSize: 12 }} onClick={bulkCarry}>
                              移到今天
                            </button>
                            <button
                              className="btn"
                              style={{ padding: '4px 10px', fontSize: 12 }}
                              onClick={() => { setBulkDoneDate(boot.today); setBulkDoneOpen(true); }}
                            >
                              完成
                            </button>
                            <button
                              className="btn danger"
                              style={{ padding: '4px 10px', fontSize: 12 }}
                              onClick={() => setBulkConfirm(true)}
                            >
                              删除
                            </button>
                            <button className="btn" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setBackSel([])}>
                              取消选择
                            </button>
                          </>
                        ) : (
                          <button className="btn" style={{ padding: '4px 10px', fontSize: 12 }} onClick={carryAll}>
                            全部移到今天
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* 未来：同样是常驻区块，但默认收起 —— 今天才是主角，这里只做预告。
                  标题里带分布摘要，不展开也能一眼看到「明天有几件」。 */}
              {upTotal > 0 && (
                <div className="backsect upsect">
                  <button className="backsect-head" onClick={() => setShowUpcoming((v) => !v)}>
                    <span>接下来 · {upTotal} 件</span>
                    <span className="up-digest">
                      {upGroups.slice(0, 3).map((g) => `${relLabel(boot.today, g.date)} ${g.items.length}`).join(' · ')}
                      {upGroups.length > 3 ? ' · …' : ''}
                    </span>
                    <span className="grow" />
                    <span className="chev">{showUpcoming ? '收起' : '展开'}</span>
                  </button>
                  {showUpcoming && (
                    <>
                      {upGroups.map((g) => (
                        <div className="upgroup" key={g.date}>
                          <div className="up-date">
                            <span className="up-rel">{relLabel(boot.today, g.date)}</span>
                            <span className="up-abs">{niceDate(g.date)}</span>
                          </div>
                          <div className="items">
                            {g.items.map((it) => (
                              <div className="item" key={it.id}>
                                <span />
                                <div>
                                  <div className="it-title">{it.title}</div>
                                  {(it.startTime || it.estMinutes) && (
                                    <div className="it-meta">
                                      {it.startTime && <span>{it.startTime}</span>}
                                      {it.estMinutes ? <span>预计 {fmtMin(it.estMinutes)}</span> : null}
                                    </div>
                                  )}
                                </div>
                                <div className="it-actions" style={{ opacity: 1 }}>
                                  <button onClick={() => bringToToday(it)}>移到今天</button>
                                  <button onClick={() => setEditing(it)}>改期</button>
                                  <button className="del" onClick={() => setConfirming(it)}>删除</button>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                      {boot.upcomingFar > 0 && (
                        <div className="upsect-foot">更远还有 {boot.upcomingFar} 件</div>
                      )}
                    </>
                  )}
                </div>
              )}

              <div className="items">
                {grouped.map((g) => {
                  const isNone = !g.key;
                  // 上午 / 下午 / 晚上**永远画** —— 日程的骨架不能因为「一条都没指定」就消失，
                  // 那样看起来就是「根本没有早中晚」（用户报过）。
                  // 「未安排」不是一天里的某一段，只是兜底，空了就不画。
                  if (isNone && !g.items.length) return null;
                  return (
                    <Fragment key={g.key || 'none'}>
                      {/* 小小的隔断：一条淡线 + 一个时段名。空档不画线，只留一行小字 */}
                      <div className={`it-slot${isNone ? ' none' : ''}${g.items.length ? '' : ' empty'}`}>
                        <span>{g.label}</span>
                      </div>
                      {g.items.map((it) => {
                  const cls = `item ${it.status}` +
                    (it.pinned ? ' pinned' : '') +
                    (dragId === it.id ? ' dragging' : '') +
                    (over?.id === it.id ? (over.after ? ' dragover-after' : ' dragover-before') : '');
                  return (
                    <div
                      className={cls}
                      key={it.id}
                      draggable
                      onDragStart={(e) => onDragStart(e, it.id)}
                      onDragOver={(e) => onDragOverItem(e, it)}
                      onDragEnd={() => { setDragId(null); setOver(null); }}
                      onDrop={(e) => onDropItem(e, it)}
                    >
                      <button
                        className="check"
                        draggable={false}
                        title={it.status === 'done' ? '撤销完成' : '标记完成'}
                        onClick={() => (it.status === 'done' ? reopen(it) : setCompleting(it))}
                      >
                        ✓
                      </button>
                      <div>
                        <div className="it-title">
                          {it.pinned && <span className="it-pin" title="已固定到今日页">固定</span>}
                          {it.title}
                        </div>
                        {/* 说明/补充：小字注解，和备忘的「补充」同一套语言 */}
                        {it.note && <div className="it-note">{it.note}</div>}
                        {it.output && <div className="it-output">{it.output}</div>}
                        {(it.startTime || it.estMinutes || it.actualMinutes) && (
                          <div className="it-meta">
                            {it.startTime && <span>{it.startTime}</span>}
                            {it.estMinutes ? <span>预计 {fmtMin(it.estMinutes)}</span> : null}
                            {it.actualMinutes ? <span>实际 {fmtMin(it.actualMinutes)}</span> : null}
                          </div>
                        )}
                      </div>
                      <div className="it-actions" draggable={false}>
                        <button onClick={() => pinItem(it)}>{it.pinned ? '取消固定' : '固定'}</button>
                        <button onClick={() => setEditing(it)}>修改</button>
                        {it.status === 'todo' && <button onClick={() => unassign(it)} title="先不定哪天做，放进待分配">待分配</button>}
                        {it.status === 'todo' && <button onClick={() => drop(it)}>放弃</button>}
                        <button className="del" onClick={() => setConfirming(it)}>删除</button>
                      </div>
                    </div>
                  );
                      })}
                    </Fragment>
                  );
                })}
                {visible.length === 0 && (
                  <div className="empty">今天还没有事项。在下面写一条试试。</div>
                )}
              </div>

              {/* 待分配：直接摊在列表下面，不再藏在一个按钮后面。
                  每行都能当场丢到今天/明天/某个日期，或者删掉。 */}
              {unscheduled.length > 0 && (
                <div className="poolsect">
                  <div className="poolsect-head">
                    <span>待分配</span>
                    <span className="poolsect-count">{unscheduled.length}</span>
                    <span className="grow" />
                    <span className="poolsect-hint">还没定哪天做</span>
                  </div>
                  {unscheduled.map((it) => (
                    <div className="pitem" key={it.id}>
                      <div className="pitem-main">
                        <div className="pitem-title" title={it.title}>{it.title}</div>
                        {it.note && <div className="it-note">{it.note}</div>}
                        {it.estMinutes ? <div className="it-meta"><span>预计 {fmtMin(it.estMinutes)}</span></div> : null}
                      </div>
                      <div className="pitem-acts">
                        <button onClick={() => setEditing(it)} title="改标题 / 说明 / 预计耗时">修改</button>
                        <button onClick={() => assignFromPool(it, boot.today)}>今天</button>
                        <button onClick={() => assignFromPool(it, shift(boot.today, 1))}>明天</button>
                        <input
                          type="date"
                          className="pitem-date"
                          min={boot.today}
                          title="挑一个具体日期"
                          onChange={(e) => { if (e.target.value) assignFromPool(it, e.target.value); }}
                        />
                        <button className="del" onClick={() => setConfirming(it)} title="删除">×</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              </div>{/* pane-scroll */}
            </div>
          </section>

          {/* 右：今日记录 */}
          <section className="pane">
            <div className="pane-head">
              <span>今日记录</span>
              <span className="grow" />
              <span>{boot.snapshotWritten ? '完成清单已入档' : '完成清单明天入档'}</span>
            </div>

            <div className="pane-body">
              {/* 备忘：贴士，不是待办。
                  左边是固定的花形标记（不是勾选框）—— 它不用被「完成」，只是一直贴在那儿；
                  用不上了就删掉。每条可以带一句补充，字号更小、颜色更淡。 */}
              <div className="rec-block memos">
                <div className="rec-head">
                  <h3>备忘{memos.length ? ` · ${memos.length}` : ''}</h3>
                  <span className="grow" />
                  <span className="memo-hint">不绑日期，一直在</span>
                </div>

                {memos.length > 0 && (
                  <div className="memolist">
                    {memos.map((m) => (
                      memoEdit && memoEdit.id === m.id ? (
                        <div className="memorow editing" key={m.id}>
                          <MemoMark />
                          <div className="memo-main">
                            <div className="memo-line">
                              <input
                                type="time"
                                className="memo-time-input"
                                value={memoEdit.time}
                                onChange={(e) => setMemoEdit({ ...memoEdit, time: e.target.value })}
                              />
                              <input
                                type="text"
                                className="memo-text-input"
                                autoFocus
                                value={memoEdit.text}
                                onChange={(e) => setMemoEdit({ ...memoEdit, text: e.target.value })}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') saveMemoEdit();
                                  if (e.key === 'Escape') setMemoEdit(null);
                                }}
                              />
                            </div>
                            <input
                              type="text"
                              className="memo-note-input"
                              placeholder="补充一句（可留空）"
                              value={memoEdit.note || ''}
                              onChange={(e) => setMemoEdit({ ...memoEdit, note: e.target.value })}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') saveMemoEdit();
                                if (e.key === 'Escape') setMemoEdit(null);
                              }}
                            />
                          </div>
                          <button className="refpinbtn" onClick={saveMemoEdit}>保存</button>
                          <button className="refpinbtn" onClick={() => setMemoEdit(null)}>取消</button>
                        </div>
                      ) : (
                        <div className="memorow" key={m.id}>
                          <MemoMark />
                          <div
                            className="memo-main"
                            title="点一下改"
                            onClick={() => setMemoEdit({ id: m.id, text: m.text, time: m.time, note: m.note || '' })}
                          >
                            <div className="memo-line">
                              <span className="memo-text">{m.text}</span>
                              {m.time && <span className="memo-time">{m.time}</span>}
                            </div>
                            {m.note && <div className="memo-note">{m.note}</div>}
                          </div>
                          <button className="refpinbtn" title="删除这条备忘" onClick={() => removeMemo(m)}>删除</button>
                        </div>
                      )
                    ))}
                  </div>
                )}

                <div className="memoadd">
                  <div className="memo-line">
                    <input
                      type="time"
                      className="memo-time-input"
                      value={memoTime}
                      title="时间（可留空）"
                      onChange={(e) => setMemoTime(e.target.value)}
                    />
                    <input
                      type="text"
                      className="memo-text-input"
                      value={memoText}
                      placeholder="记一条要提醒自己的事，回车添加"
                      onChange={(e) => setMemoText(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && addMemo()}
                    />
                    <button className="composer-btn" onClick={addMemo}>加一条</button>
                  </div>
                  <input
                    type="text"
                    className="memo-note-input"
                    value={memoNote}
                    placeholder="补充一句（可留空，比如「周五前交到前台」）"
                    onChange={(e) => setMemoNote(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && addMemo()}
                  />
                </div>
                {memos.length === 0 && (
                  <div className="memo-empty">还没有备忘。像「记得交表格」这种一直要惦记的事，写这儿。</div>
                )}
              </div>
              {/* 昨晚睡得怎么样：早上打开先看这个，再看待办。
                  今天还没记就退回最近一条并标出日期；一条都没有就提示去记。 */}
              <div className="rec-block sleeptile-wrap">
                <div className="rec-head">
                  <h3>睡眠</h3>
                  <span className="grow" />
                  <button
                    className="btn"
                    style={{ padding: '4px 10px', fontSize: 12 }}
                    onClick={onOpenSleep}
                  >
                    {night && !night.stale ? '去改' : '去记一笔'}
                  </button>
                </div>

                {night ? (
                  <button className="sleep-tile" onClick={onOpenSleep} title="去睡眠页看详情">
                    <span className="st-main">
                      <span className="st-dur">{fmtSleepDur(night.minutes)}</span>
                      {night.band && night.bandLabel && (
                        <span className={`sleep-chip b-${night.band}`}>{night.bandLabel}</span>
                      )}
                    </span>
                    <span className="st-times">
                      {night.bedTime} 入睡 → {night.wakeTime} 起床
                      <span className="st-when"> · {nightLabel(night.date)}</span>
                      {night.stale && <span className="st-when">（{relLabel(boot.today, night.date)}记的）</span>}
                    </span>
                    {trend.length > 1 && (
                      <span className="st-trend" title={`最近 ${trend.length} 次`}>
                        {trend.map((m, i) => (
                          <i
                            key={i}
                            className={`st-bar${i === trend.length - 1 ? ' now' : ''}`}
                            style={{ height: `${Math.max(3, Math.round((m / (9 * 60)) * 22))}px` }}
                          />
                        ))}
                      </span>
                    )}
                  </button>
                ) : (
                  <div className="empty" style={{ padding: '8px 0' }}>
                    还没有睡眠记录。记一笔昨晚几点睡、几点起，这里就会显示时长。
                  </div>
                )}
              </div>

              {/* 固定：往日的日志 / 事项，在今日页也能看到（否则只有翻回日志页才找得到） */}
              {(pinnedCount > 0) && (
                <div className="rec-block pins">
                  <h3>固定 · {pinnedCount} 条</h3>

                  {pins.items.map((it) => (
                    <div className="pinrow" key={it.id}>
                      <button className="check" title="标记完成" onClick={() => completePinned(it)}>✓</button>
                      {/* 固定过来的事项和列表里是同一份数据，标签/耗时也得跟着显示 ——
                          只留一个光秃秃的标题，等于把它的标签丢了。 */}
                      <div className="pinrow-main">
                        <span className="pinrow-title">{it.title}</span>
                        {it.note && <div className="it-note">{it.note}</div>}
                        {(it.startTime || it.estMinutes || it.actualMinutes) && (
                          <div className="it-meta">
                            {it.startTime && <span>{it.startTime}</span>}
                            {it.estMinutes ? <span>预计 {fmtMin(it.estMinutes)}</span> : null}
                            {it.actualMinutes ? <span>实际 {fmtMin(it.actualMinutes)}</span> : null}
                          </div>
                        )}
                      </div>
                      <span className="pinrow-date">{it.date}</span>
                      <button className="refpinbtn" title="取消固定" onClick={() => pinItem(it)}>取消固定</button>
                    </div>
                  ))}

                  {pins.logs.map((e) => {
                    const open = expanded.has(`l:${e.date}`);
                    return (
                      <div className="pinlog" key={e.date}>
                        <div className="pinlog-head">
                          {/* 标题可点：跳到日志页那一天（去看/去改都在那边） */}
                          <button
                            className="refdate pinlog-jump"
                            title="去日纪页看这一天"
                            onClick={() => onOpenLogAt(e.date)}
                          >
                            {e.date}
                          </button>
                          {e.title && <span className="pinlog-title">{e.title}</span>}
                          <span className="grow" />
                          {/* 就地展开：不跳页就能看全文 */}
                          <button
                            className="refpinbtn"
                            title={open ? '收起' : '展开全文'}
                            onClick={() => toggleExpand(`l:${e.date}`)}
                          >
                            {open ? '收起' : '展开'}
                          </button>
                          <button
                            className="refpinbtn"
                            title="取消固定"
                            onClick={() => window.hua.log.pin({ date: e.date, pinned: false }).then(reload)}
                          >
                            取消固定
                          </button>
                        </div>
                        {open
                          ? <div className="pinlog-full">{e.body}</div>
                          : <div className="pinlog-body">{previewText(e.body)}</div>}
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="rec-block">
                <h3>完成 · {boot.done.length} 件</h3>
                {boot.done.length > 0
                  ? <DoneList items={boot.done} />
                  : <div className="empty" style={{ padding: '8px 0' }}>还没有完成的事项。</div>}
                <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
                    完成清单在明天首次打开时快照进周文件，之后不再回改。
                  </span>
                  <button className="btn" style={{ padding: '4px 10px', fontSize: 12 }} onClick={snapshotNow}>
                    立即入档
                  </button>
                </div>
              </div>

              {/* 日纪入口：正文搬去了「日纪」页（一天一篇），这里只留一句话和一个按钮。
                  放在右栏最下，因为它不再是「今天要做的事」的一部分。
                  标题和摘要做成可点：直接跳到日纪页的今天 —— 和上面固定区里
                  往日日纪标题的行为一致，别一处能点一处不能点。 */}
              <div className="rec-block">
                <div className="rec-head">
                  <button
                    className="rec-title-btn"
                    title="去日纪页写今天"
                    onClick={() => onOpenLogAt(boot.today)}
                  >
                    <h3>日纪{logWords ? ` · ${logWords} 字` : ''}</h3>
                  </button>
                  <span className="grow" />
                  <button
                    className="btn"
                    style={{ padding: '4px 10px', fontSize: 12 }}
                    onClick={() => onOpenLogAt(boot.today)}
                  >
                    去写今天
                  </button>
                </div>
                {logPreview
                  ? (
                    <button
                      className="logteaser logteaser-btn"
                      title="去日纪页写今天"
                      onClick={() => onOpenLogAt(boot.today)}
                    >
                      {logPreview}
                    </button>
                  )
                  : (
                    <div
                      className="empty clickable"
                      style={{ padding: '8px 0' }}
                      onClick={() => onOpenLogAt(boot.today)}
                      title="去日纪页写今天"
                    >
                      今天还没写日纪。一天一篇，记在「日纪」里。
                    </div>
                  )}
              </div>
            </div>
          </section>
        </div>
      </div>

        {bulkDoneOpen && (
          <div className="modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) setBulkDoneOpen(false); }}>
            <div className="modal">
              <h3>完成这 {backSel.length} 件</h3>
              <div className="m-sub">记到哪一天的完成清单里？</div>
              <div className="m-row">
                <label>完成于哪天</label>
                <input type="date" value={bulkDoneDate} max={boot.today} onChange={(e) => setBulkDoneDate(e.target.value)} />
              </div>
              <div className="m-foot">
                <button className="btn" onClick={() => setBulkDoneOpen(false)}>取消</button>
                <button className="btn primary" onClick={() => bulkComplete(bulkDoneDate || boot.today)}>完成</button>
              </div>
            </div>
          </div>
        )}

        {bulkConfirm && (
          <ConfirmDialog
            title={`删除这 ${backSel.length} 件？`}
            text="删掉之后就没有了，不能恢复。"
            okLabel="删除"
            danger
            onCancel={() => setBulkConfirm(false)}
            onOk={bulkDelete}
          />
        )}


      {completing && (
        <CompleteModal
          item={completing}
          today={boot.today}
          onClose={() => setCompleting(null)}
          onDone={() => { setCompleting(null); reload(); }}
        />
      )}

      {editing && (
        <EditItemModal
          item={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); }}
        />
      )}

      {confirming && (
        <ConfirmDialog
          title="删除这条事项？"
          text={`「${confirming.title}」将被永久删除，无法撤销。`}
          okLabel="删除"
          danger
          onCancel={() => setConfirming(null)}
          onOk={() => remove(confirming)}
        />
      )}
    </div>
  );
}
