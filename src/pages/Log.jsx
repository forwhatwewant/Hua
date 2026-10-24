import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor from '../components/Editor.jsx';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import { mdToHtml } from '../md.js';
import { daySpan, fmtWhen } from '../dates.js';

const WD = ['日', '一', '二', '三', '四', '五', '六'];
const pad2 = (n) => String(n).padStart(2, '0');
const dstr = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const fromStr = (s) => new Date(`${s}T00:00:00`);

function shiftDays(dateStr, n) {
  const d = fromStr(dateStr);
  d.setDate(d.getDate() + n);
  return dstr(d);
}

/* 「今天是哪天」一律用主进程下发的 boot.today —— 那边按日界算（默认凌晨 4 点前算前一天）。
   这里**不要**再自己 new Date() 取当天：凌晨 1 点写日志，本该落在「还没睡的那一天」上，
   自己算就会错到新的一天去。这条规则在 electron/main.cjs 的 effectiveToday()。 */

const niceFull = (s) => {
  const d = fromStr(s);
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日 · 周${WD[d.getDay()]}`;
};
const niceShort = (s) => {
  const d = fromStr(s);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 · 周${WD[d.getDay()]}`;
};

/** 侧栏里用的短标签：今天/昨天/前天/周X + 日期 */
function shortLabel(date, today) {
  const diff = Math.round((fromStr(today) - fromStr(date)) / 86400000);
  if (diff === 0) return '今天';
  if (diff === 1) return '昨天';
  if (diff === 2) return '前天';
  if (diff > 0 && diff < 7) return `周${WD[fromStr(date).getDay()]}`;
  return `${fromStr(date).getMonth() + 1} 月 ${fromStr(date).getDate()} 日`;
}

/** 正文里去掉 Markdown 标记后的字数（不含空白） */
export const countWords = (md) =>
  String(md || '').replace(/[#*_>`\-\[\]()]/g, '').replace(/\s/g, '').length;

/** 把 Markdown 压成一行纯文本 */
function plainText(md) {
  return String(md || '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^>\s*/gm, '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 搜索结果里截取关键词附近的一段，并高亮 */
export function excerpt(body, q) {
  const plain = plainText(body);
  const idx = plain.toLowerCase().indexOf(String(q).toLowerCase());
  const start = idx > 40 ? idx - 40 : 0;
  const slice = (start > 0 ? '…' : '') + plain.slice(start, start + 160);
  const esc = String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return slice.replace(new RegExp(`(${esc})`, 'gi'), '<mark>$1</mark>');
}

const SPANS = [30, 90, 365];
const VIEWS = [['write', '写'], ['search', '翻'], ['calendar', '日历']];

/** 「已保存」那一瞬间的 HH:MM */
export function hhmm(d) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 把保存状态翻成给人看的一句话 + 一个颜色档。导出来是为了能单测。 */
export function saveLabel(st) {
  switch (st?.k) {
    case 'dirty': return { text: '有改动，稍后自动保存', tone: 'wait' };
    case 'saving': return { text: '正在保存…', tone: 'wait' };
    case 'saved': return { text: `已保存 ${st.at ? hhmm(st.at) : ''}`.trim(), tone: 'ok' };
    case 'error': return { text: '保存失败，请检查', tone: 'bad' };
    default: return { text: '', tone: '' };
  }
}

export default function Log({ boot, reload, jump, onJumpDone }) {
  // 日界由主进程算了随 boot 下发；兜底才用本地日期（SSR/测试环境没 boot.today 时）
  const today = boot?.today || dstr(new Date());
  // 视图与「日历里选中的那天」允许从 boot.log 预置 —— 只为了 SSR 测试能渲染到
  // 日历/预览那一支（内部 state 在 SSR 里摸不到）。正常运行传不传都一样。
  const [view, setView] = useState(boot?.log?.view || 'write');
  const [span, setSpan] = useState(90);
  const [days, setDays] = useState([]);
  const [date, setDate] = useState(boot?.log?.date || today);
  const [title, setTitle] = useState('');
  const [words, setWords] = useState(0);
  /* 这一天的「最后改于」。周文件里没存这个信息，主进程从索引里取。
     空串 = 从没改过（或旧数据还没打过点），界面上就不显示。 */
  /* 这一天的编辑记录：首次写于 / 最后改于 / 一共改过几次。
     周文件里没有这些，主进程存在 journal_meta 里（一天一行，不随索引重建丢失）。 */
  const [meta, setMeta] = useState({ createdAt: '', updatedAt: '', edits: 0 });
  // 这篇日纪从第一次写到最后一次改动跨了几天（同一天写就是 0）
  const editSpan = daySpan(meta.createdAt, meta.updatedAt);
  /* 保存状态：一份明确的机器可读状态，而不是一句会消失的提示字符串。
     idle = 没有未保存改动；dirty = 有改动、等 debounce；
     saving = 正在写盘；saved = 已落盘（带时刻）；error = 写失败。 */
  const [saveState, setSaveState] = useState({ k: 'idle' });
  const [confirming, setConfirming] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [doneItems, setDoneItems] = useState([]);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState(null);
  const [calMonth, setCalMonth] = useState(() => today.slice(0, 7));
  /* 日历里点开的那一天：先只读预览，点了「编辑这一天」才切到写作视图。
     这样翻看过去的日记不会误改，也不至于点一下就跳走。 */
  const [peek, setPeek] = useState(boot?.log?.peek || null);   // { date, title, body, count, pinned, done }
  const [peekLoading, setPeekLoading] = useState(false);

  const timer = useRef(null);
  const pendingTitle = useRef('');
  const pendingBody = useRef('');
  const dirty = useRef(false);
  const curDate = useRef(date);

  const fetchDays = useCallback(
    () => window.hua.log.days({ from: shiftDays(today, -(span - 1)), to: today }),
    [span, today]
  );

  /** 拉左栏的日子：有内容的那些 + 今天（今天永远列出，空着也能写） */
  const refreshDays = useCallback(async () => {
    const r = await fetchDays();
    const has = new Set(r.map((x) => x.date));
    const merged = has.has(today)
      ? r
      : [{ date: today, written: false, pinned: false, count: 0 }, ...r];
    setDays(merged);
    return merged;
  }, [fetchDays, today]);

  useEffect(() => { refreshDays(); }, [refreshDays]);

  const flush = useCallback(() => {
    if (!dirty.current) return;
    clearTimeout(timer.current);
    dirty.current = false;
    const at = new Date();
    const saveDate = curDate.current;   // 存的是这一天；等回调回来时可能已经切走了
    setSaveState({ k: 'saving' });
    // save 是 invoke，等它回来才算真的落了盘 —— 中间显示「正在保存」，
    // 回来才显示「已保存 HH:MM」。这样「存了没」一目了然。
    window.hua.log.save({
      date: saveDate,
      title: pendingTitle.current,
      body: pendingBody.current
    }).then(() => {
      setSaveState({ k: 'saved', at });
      // 刚存完：本地就把记录推进一格，不用再跑一趟主进程
      if (curDate.current === saveDate) {
        setMeta((m) => ({
          createdAt: m.createdAt || at.toISOString(),
          updatedAt: at.toISOString(),
          edits: m.edits + 1
        }));
      }
    }).catch(() => {
      setSaveState({ k: 'error' });
    });
  }, []);

  // 载入选中那天的正文 + 那天的完成事项
  useEffect(() => {
    let alive = true;
    setLoaded(false);
    curDate.current = date;
    // 换了一天，上一个保存状态就不适用了，先归零（避免显示别的日期的「已保存」）
    setSaveState({ k: 'idle' });
    window.hua.log.day({ date }).then((log) => {
      if (!alive) return;
      setTitle(log.title || '');
      pendingTitle.current = log.title || '';
      pendingBody.current = log.body || '';
      setWords(countWords(log.body));
      setMeta({ createdAt: log.createdAt || '', updatedAt: log.updatedAt || '', edits: log.edits || 0 });
      setLoaded(true);
    });
    window.hua.items.range({ from: date, to: date }).then((items) => {
      if (!alive) return;
      setDoneItems((items || []).filter((i) => i.status === 'done'));
    });
    return () => { alive = false; };
  }, [date]);

  // 切走或关窗口前把没落盘的补写进去
  useEffect(() => () => {
    clearTimeout(timer.current);
    flush();
  }, [flush]);

  /* 外部请求跳到某一天（今日页点固定的日志标题）。
     消费一次就回调清空，免得下次切回日志页又跳一遍。
     先 flush 当前这天，防止正在写的内容没落盘。
     若那天早于当前区间，把区间自动放宽 —— 否则跳过去列表里却没有这一天。 */
  useEffect(() => {
    if (!jump || !jump.date) return;
    flush();
    const d = jump.date;
    const oldest = shiftDays(today, -(span - 1));
    if (d < oldest) {
      const need = Math.round((fromStr(today) - fromStr(d)) / 86400000) + 1;
      // 往上一档取，别设成刚好够 —— 否则前后翻一天就掉出区间
      setSpan(SPANS.find((n) => n >= need) || SPANS[SPANS.length - 1]);
    }
    setView(jump.view || 'write');
    setPeek(null);
    setDate(d);
    onJumpDone?.();
  }, [jump, flush, onJumpDone, today, span]);

  const pick = (d) => {
    if (d === date) return;
    flush();
    setDate(d);
  };

  const schedule = () => {
    dirty.current = true;
    setSaveState({ k: 'dirty' });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { flush(); refreshDays(); }, 700);
  };

  const cur = days.find((d) => d.date === date);
  const pinned = !!cur?.pinned;
  const written = !!cur?.written;

  const togglePin = async () => {
    flush();
    await window.hua.log.pin({ date, pinned: !pinned });
    await refreshDays();
    reload?.();
  };

  const clearDay = async () => {
    clearTimeout(timer.current);
    dirty.current = false;
    pendingBody.current = '';
    pendingTitle.current = '';
    setTitle('');
    setWords(0);
    await window.hua.log.save({ date, title: '', body: '' });
    setSaveState({ k: 'idle' });
    setConfirming(false);
    await refreshDays();
    reload?.();
  };

  // 搜索：在日志正文里全文检索
  useEffect(() => {
    if (!q.trim()) { setHits(null); return; }
    const t = setTimeout(() => {
      window.hua.search({ q: q.trim() }).then((r) => setHits(r.journal || []));
    }, 220);
    return () => clearTimeout(t);
  }, [q]);

  /* ---------- 统计：连续记录天数 ---------- */
  const sv = saveLabel(saveState);

  const streak = useMemo(() => {
    const has = new Set(days.filter((d) => d.written).map((d) => d.date));
    let n = 0;
    let d = has.has(today) ? today : shiftDays(today, -1);   // 今天还没写就从昨天往前数
    while (has.has(d)) { n += 1; d = shiftDays(d, -1); }
    return n;
  }, [days, today]);

  const writtenCount = days.filter((d) => d.written).length;

  /* ---------- 日历 ---------- */
  const calCells = useMemo(() => {
    const [y, m] = calMonth.split('-').map(Number);
    const first = new Date(y, m - 1, 1);
    const total = new Date(y, m, 0).getDate();
    const lead = first.getDay();
    const cells = Array.from({ length: lead }, () => null);
    for (let d = 1; d <= total; d += 1) cells.push(`${calMonth}-${pad2(d)}`);
    return cells;
  }, [calMonth]);

  const calWritten = useMemo(
    () => new Set(days.filter((d) => d.written).map((d) => d.date)),
    [days]
  );

  const shiftMonth = (n) => {
    const [y, m] = calMonth.split('-').map(Number);
    const d = new Date(y, m - 1 + n, 1);
    setCalMonth(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}`);
  };

  /* 点日历里的某一天：拉那天的日志正文 + 完成事项，右侧只读展示。
     不直接进编辑 —— 翻看和修改是两件事，混在一起容易误改。 */
  const openPeek = useCallback(async (dateStr) => {
    setPeekLoading(true);
    setPeek({ date: dateStr, title: '', body: '', count: 0, pinned: false, done: [] });
    const [log, items] = await Promise.all([
      window.hua.log.day({ date: dateStr }),
      window.hua.items.range({ from: dateStr, to: dateStr })
    ]);
    setPeek({
      date: dateStr,
      title: log?.title || '',
      body: log?.body || '',
      count: log?.count || 0,
      pinned: !!log?.pinned,
      createdAt: log?.createdAt || '',
      updatedAt: log?.updatedAt || '',
      edits: log?.edits || 0,
      done: (items || []).filter((i) => i.status === 'done')
    });
    setPeekLoading(false);
  }, []);

  /* 从预览切到编辑：先 flush 当前这天（免得丢），再切到写作视图并定位 */
  const editFromPeek = (dateStr) => {
    flush();
    setPeek(null);
    setDate(dateStr);
    setView('write');
  };

  return (
    <>
      <div className="pagehead">
        <h1>日纪</h1>
        <span className="sub">一天一篇，写下这一天</span>
        <span className="grow" />
        {sv.text && (
          <span className={`savestate ${sv.tone}`} title="停笔 0.7 秒后自动写入磁盘">
            <span className="sv-dot" />{sv.text}
          </span>
        )}
      </div>

      {/* 写作视图用 log-scroll-write、日历视图用 log-scroll-cal：把 .scroll 变成不滚动的
          容器，高度一路传下去，让内部的编辑器 / 预览面板自己滚。
          以前整页滚，写长了光标跑出框外、翻旧日记时正文把整页撑长。
          「翻」视图结果是一列卡片，内容不长，保持原来的整页滚动即可。 */}
      <div className={`scroll${view === 'write' ? ' log-scroll-write' : view === 'calendar' ? ' log-scroll-cal' : ''}`}>
        <div className="logbar">
          <div className="tabs" style={{ margin: 0 }}>
            {VIEWS.map(([k, label]) => (
              <button key={k} className={view === k ? 'on' : ''} onClick={() => setView(k)}>{label}</button>
            ))}
          </div>
          <span style={{ flex: 1 }} />
          {view !== 'calendar' && SPANS.map((n) => (
            <button
              key={n}
              className={`btn${span === n ? ' primary' : ''}`}
              style={{ padding: '5px 12px', fontSize: 12.5 }}
              onClick={() => setSpan(n)}
            >
              近 {n} 天
            </button>
          ))}
        </div>

        {view === 'write' && (
          <div className="logstats">
            <span>这段时间写了 <b>{writtenCount}</b> 天</span>
            <span>连续 <b>{streak}</b> 天</span>
            <span>{date === today ? '今天' : niceShort(date)} <b>{words}</b> 字</span>
          </div>
        )}

        {view === 'search' && (
          <>
            <div className="searchbar logsearch">
              <input
                autoFocus
                value={q}
                placeholder="翻一翻以前写过什么…（例：写方案）"
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            {hits && (
              <>
                <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 8 }}>
                  找到 {hits.length} 条
                </div>
                {hits.length === 0 && <div className="empty">没有找到。</div>}
                {hits.map((h, i) => (
                  <div
                    className="loghit"
                    key={`${h.date}-${i}`}
                    onClick={() => { setView('write'); pick(h.date); }}
                  >
                    <div className="loghit-date">
                      {niceShort(h.date)}{h.title ? ` · ${h.title}` : ''} · {countWords(h.body)} 字
                    </div>
                    <div
                      className="loghit-body"
                      dangerouslySetInnerHTML={{ __html: excerpt(h.body, q) }}
                    />
                  </div>
                ))}
              </>
            )}
            {!hits && <div className="empty">输入关键词，在你写过的日纪里全文检索。</div>}
          </>
        )}

        {view === 'calendar' && (
          <div className="calwrap">
            <div className="calcol">
              <div className="logcal-head">
                <button className="btn" style={{ padding: '3px 10px', fontSize: 12.5 }} onClick={() => shiftMonth(-1)}>←</button>
                <span className="ym">{calMonth.replace('-', ' 年 ')} 月</span>
                <button className="btn" style={{ padding: '3px 10px', fontSize: 12.5 }} onClick={() => shiftMonth(1)}>→</button>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 12, color: 'var(--text-3)' }}>深色 = 写过</span>
              </div>
              <div className="logcal">
                {WD.map((w) => <div className="logcal-wd" key={w}>{w}</div>)}
                {calCells.map((d, i) => (
                  d === null
                    ? <div className="logcal-day blank" key={`b${i}`} />
                    : (
                      <button
                        key={d}
                        className={`logcal-day${calWritten.has(d) ? ' written' : ''}${d === today ? ' today' : ''}${peek?.date === d ? ' on' : ''}`}
                        title={d}
                        onClick={() => openPeek(d)}
                      >
                        <span>{Number(d.slice(8, 10))}</span>
                        <span className={`logcal-dot${calWritten.has(d) ? '' : ' hidden'}`} />
                      </button>
                    )
                ))}
              </div>
              <div className="desc" style={{ marginTop: 14, fontSize: 12.5, color: 'var(--text-3)' }}>
                点一天，右边先看内容；想改再点「编辑这一天」。
              </div>
            </div>

            {/* 右侧：只读预览。日历只占左栏，右栏把剩下的空间用起来 */}
            <section className="calpeek">
              {!peek && (
                <div className="empty" style={{ padding: '20px 0' }}>
                  点左边日历里的任意一天，这里显示那天的日纪和完成的事。
                </div>
              )}

              {peek && (
                <>
                  <div className="cp-head">
                    <div className="cp-date">
                      {niceFull(peek.date)}
                      {peek.date === today ? ' · 今天' : ''}
                      {peek.updatedAt && (
                        <span className="cp-when" title="这一天的编辑记录">
                          首次 {fmtWhen(peek.createdAt)} · 最后 {fmtWhen(peek.updatedAt)}
                          {peek.edits > 1 ? ` · 改过 ${peek.edits} 次` : ''}
                        </span>
                      )}
                    </div>
                <span className="grow" />
                    {peek.pinned && <span className="cp-pin">已固定</span>}
                    <button
                      className="btn primary"
                      style={{ padding: '4px 12px', fontSize: 12.5 }}
                      onClick={() => editFromPeek(peek.date)}
                    >
                      编辑这一天
                    </button>
                  </div>

                  {peekLoading
                    ? <div className="empty" style={{ padding: '16px 0' }}>正在读取…</div>
                    : (
                      <>
                        {peek.title && <h3 className="cp-title">{peek.title}</h3>}
                        {(peek.body || '').trim()
                          ? (
                            <div
                              className="cp-body tiptap-like"
                              dangerouslySetInnerHTML={{ __html: mdToHtml(peek.body) }}
                            />
                          )
                          : <div className="empty" style={{ padding: '16px 0' }}>这天没有写日纪。</div>}

                        <div className="cp-done">
                          <h4>这天完成 · {peek.done.length} 件</h4>
                          {peek.done.length === 0
                            ? <div className="cp-done-empty">这天没有已完成的事项。</div>
                            : peek.done.map((it) => (
                              <div className="cp-done-row" key={it.id}>
                                <span className="t">{it.title}</span>
                                {it.actualMinutes ? <span className="m">{it.actualMinutes} 分</span> : null}
                              </div>
                            ))}
                        </div>
                      </>
                    )}
                </>
              )}
            </section>
          </div>
        )}

        {view === 'write' && (
          <div className="logwrap">
            <aside className="loglist">
              {days.length === 0 && (
                <div className="empty" style={{ padding: '8px 0', fontSize: 12.5 }}>这段时间没有记录。</div>
              )}
              {days.map((d) => (
                <button
                  key={d.date}
                  className={`logday${d.date === date ? ' on' : ''}${d.pinned ? ' pinned' : ''}`}
                  onClick={() => pick(d.date)}
                  title={d.title || d.date}
                >
                  <span className="logday-top">
                    <span className="logday-rel">{shortLabel(d.date, today)}</span>
                    <span className="grow" />
                    {d.pinned && <span className="logday-pin" title="已固定到今日页">固定</span>}
                    <span className={`logday-mark${d.written ? ' on' : ''}`} title={d.written ? '写过' : '还没写'}>·</span>
                  </span>
                  {/* 过往日纪的标题 —— 光看日期想不起来那天写了什么 */}
                  <span className={`logday-title${d.title ? '' : ' muted'}`}>
                    {d.title || (d.written ? '（无标题）' : '还没写')}
                  </span>
                </button>
              ))}
            </aside>

            <section className="logmain">
              <div className="logmain-head">
                <h2>{niceFull(date)}</h2>
                <span className="logstat">
                  {loaded ? `${words} 字` : ''}{date === today ? ' · 今天' : ''}
                </span>
                <span className="grow" />
                <div className="daynav">
                  <button onClick={() => pick(shiftDays(date, -1))} title="前一天">←</button>
                  <button onClick={() => pick(shiftDays(date, 1))} disabled={date >= today} title="后一天">→</button>
                  <button onClick={() => pick(today)} disabled={date === today}>今天</button>
                </div>
                <button
                  className="btn"
                  style={{ padding: '4px 10px', fontSize: 12 }}
                  onClick={togglePin}
                  disabled={!written}
                  title={written ? '' : '先写点内容才能固定'}
                >
                  {pinned ? '取消固定' : '固定到今日页'}
                </button>
                <button
                  className="btn"
                  style={{ padding: '4px 10px', fontSize: 12 }}
                  onClick={() => setConfirming(true)}
                  disabled={!written}
                >
                  清空
                </button>
              </div>

              {/* 编辑记录：单独一行，别再塞回标题行里当小字 —— 那样根本看不见 */}
              {meta.updatedAt && (
                <div className="logedits-bar">
                  <span className="leb-tag">编辑记录</span>
                  <span className="leb-item">首次 {fmtWhen(meta.createdAt)}</span>
                  <span className="leb-dot">·</span>
                  <span className="leb-item">最后 {fmtWhen(meta.updatedAt)}</span>
                  {meta.edits > 1 && (
                    <>
                      <span className="leb-dot">·</span>
                      <span className="leb-item">共 {meta.edits} 次</span>
                    </>
                  )}
                  {editSpan > 0 && (
                    <>
                      <span className="leb-dot">·</span>
                      <span className="leb-item">跨 {editSpan} 天</span>
                    </>
                  )}
                </div>
              )}

              {loaded && (
                <div className="logbody">
                  <div className="loginner">
                    <input
                      type="text"
                      className="logtitle-input"
                      value={title}
                      placeholder="给这一天起个标题（可留空）"
                      onChange={(e) => {
                        setTitle(e.target.value);
                        pendingTitle.current = e.target.value;
                        schedule();
                      }}
                    />
                    <div className="loghint">
                      {date === today
                        ? '今天还没写的话，从下面开始。写完了会自动保存。'
                        : '补记这一天。写完了会自动保存。'}
                    </div>
                    <Editor
                      key={date}
                      initial={pendingBody.current}
                      onChange={(md) => {
                        pendingBody.current = md;
                        setWords(countWords(md));
                        schedule();
                      }}
                      refItems={date === today ? boot.done : []}
                    />
                  </div>

                  {/* 当天完成的事项单独一栏，和正文并排。
                      放在正文下面的话日志一写长就沉到屏幕外了 —— 回顾时要能同时看到。 */}
                  <aside className="logside">
                    <div className="logdone">
                      <h4>这天完成 · {doneItems.length} 件</h4>
                      {doneItems.length === 0
                        ? <div className="logdone-empty">这天没有已完成的事项。</div>
                        : (
                          <div className="logdone-list">
                            {doneItems.map((it) => (
                              <div className="logdone-row" key={it.id}>
                                <span className="t" title={it.title}>{it.title}</span>
                                {it.actualMinutes
                                  ? <span className="m">{it.actualMinutes} 分</span>
                                  : null}
                              </div>
                            ))}
                          </div>
                        )}
                    </div>
                  </aside>
                </div>
              )}
            </section>
          </div>
        )}
      </div>

      {confirming && (
        <ConfirmDialog
          title="清空这一天的日纪？"
          text={`${niceFull(date)} 的正文和标题都会被清掉，无法撤销。`}
          okLabel="清空"
          danger
          onCancel={() => setConfirming(false)}
          onOk={clearDay}
        />
      )}
    </>
  );
}
