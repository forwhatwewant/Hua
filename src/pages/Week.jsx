import { Fragment, useCallback, useEffect, useState } from 'react';
import CompleteModal from '../components/CompleteModal.jsx';
import EditItemModal from '../components/EditItemModal.jsx';
import { rateText } from '../rate.js';
import { groupBySlot, slotOf } from '../slot.js';

const WD = ['一', '二', '三', '四', '五', '六', '日'];

/** 分钟 → 给人看的时长。和别处一样：整小时不留「2 小时 」这种尾空格。 */
export function fmtDur(m) {
  if (!m) return '';
  if (m < 60) return `${m} 分`;
  const h = Math.round(m / 6) / 10;      // 一位小数：105 分 → 1.8 小时
  return `${h} 小时`;
}

/** 池子里那一条离这一周有多远，用来提示它是「遗留」还是「以后」 */
function poolTag(date, board) {
  if (!date) return '待分配';                       // 没定日期
  if (date < board.weekStart) return date === board.today ? '今天' : '遗留';
  return '以后';
}

const niceShort = (s) => `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}`;

export default function Week({ boot, reload }) {
  /* weekStart = null 表示「用默认的那一周」—— 默认是下周，由主进程定。
     前端不自己推算日期：凌晨跨日界这类事只有主进程算得对。 */
  const [weekStart, setWeekStart] = useState(null);
  const [board, setBoard] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [dragId, setDragId] = useState(null);
  const [overDate, setOverDate] = useState(null);
  /* 点选式分配：拖拽之外的另一条路。先点池子里的一条，再点某一天。 */
  const [picked, setPicked] = useState(null);
  const [completing, setCompleting] = useState(null);
  /* 加一件事的小表单：只写标题太单薄 —— 排期时真正要判断的是「这件事要花多久」，
     所以这里同时给「预计耗时」和「开始时间」，不用先加再回头改。 */
  const [adding, setAdding] = useState(null);   // { date, x, y }
  const [addTitle, setAddTitle] = useState('');
  const [addEst, setAddEst] = useState('');
  const [addStart, setAddStart] = useState('');
  /* 右键菜单：在某一天上右键 = 直接加一件事；在某条上右键 = 改它 / 完成 / 退回。
     列自己是 overflow:auto 的，菜单必须 position:fixed 才不会被列裁掉。 */
  const [menu, setMenu] = useState(null);        // { x, y, kind: 'day' | 'item', date, item }
  const [editing, setEditing] = useState(null);  // 正在「修改」的那条

  const fetchBoard = useCallback(async (ws) => {
    setLoading(true);
    try {
      const b = await window.hua.week.board(ws ? { weekStart: ws } : {});
      setBoard(b);
      setError(null);
      return b;
    } catch (e) {
      setError(e?.message || String(e));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchBoard(weekStart); }, [fetchBoard, weekStart]);

  /* 菜单开着时，点别处 / Esc / 滚动都关掉。
     用 mousedown（而不是 click）是为了让「在另一天再右键」能一步到位：
     右键的事件顺序是 mousedown → contextmenu，所以先关掉旧的、再开新的，不用点两次。 */
  useEffect(() => {
    if (!menu) return undefined;
    const close = () => setMenu(null);
    const onKey = (e) => { if (e.key === 'Escape') setMenu(null); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
    };
  }, [menu]);

  const openDayMenu = (e, date) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, kind: 'day', date });
  };
  const openItemMenu = (e, it) => {
    e.preventDefault();
    e.stopPropagation();   // 别让列再开一个「加一件事」
    setMenu({ x: e.clientX, y: e.clientY, kind: 'item', item: it });
  };

  /** 在菜单里点「加一件事」：直接把那天的输入框打开 */
  /** 打开「加一件事」小表单。x/y 是指针位置（右键菜单或 ＋ 按钮），用来定位 */
  const startAdd = (date, x, y) => {
    resetAdd();
    setAdding({ date, x: x ?? 200, y: y ?? 160 });
    setMenu(null);
  };

  /* 表单开着时，点别处 / Esc 关掉。用 mousedown 是为了和右键菜单一致：
     右键 → mousedown（关掉旧的）→ contextmenu（开新的），一步到位。 */
  useEffect(() => {
    if (!adding) return undefined;
    const onDown = (e) => {
      if (!(e.target instanceof Element) || !e.target.closest('.wkadd')) closeAdd();
    };
    const onKey = (e) => { if (e.key === 'Escape') closeAdd(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [adding]);

  const refresh = async () => { await fetchBoard(weekStart); reload?.(); };

  const assign = async (id, date) => {
    await window.hua.items.carry({ ids: [id], date });
    setPicked(null);
    setDragId(null);
    setOverDate(null);
    await refresh();
  };

  /* 退回待分配：把日期放回今天，它就会重新出现在池子里。
     不用「删除」—— 那太狠了；这里只是「这周先不排」。 */
  const unschedule = async (it) => {
    await window.hua.items.carry({ ids: [it.id], date: board.today });
    await refresh();
  };

  const resetAdd = () => { setAddTitle(''); setAddEst(''); setAddStart(''); };
  const closeAdd = () => { resetAdd(); setAdding(null); };

  const addTo = async () => {
    if (!adding) return;
    const t = addTitle.trim();
    if (!t) { closeAdd(); return; }
    await window.hua.items.create({
      date: adding.date,
      title: t,
      estMinutes: addEst === '' ? null : Number(addEst),
      startTime: addStart || null
    });
    closeAdd();
    await refresh();
  };

  if (error) {
    return (
      <>
        <div className="pagehead"><h1>周程</h1></div>
        <div className="scroll">
          <div className="empty" style={{ padding: 40 }}>
            读不出这一周：{error}
            <div style={{ marginTop: 12 }}>
              <button className="btn primary" onClick={() => fetchBoard(weekStart)}>再试一次</button>
            </div>
          </div>
        </div>
      </>
    );
  }

  if (!board) return <div className="empty" style={{ padding: 48 }}>正在读这一周……</div>;

  const { load, completion, pool, itemsByDate, days, pinned = [] } = board;
  const label = board.isNextWeek ? '下周' : board.isThisWeek ? '本周' : board.isPast ? '已过去的' : '更远的';
  const heavyLabel = load.heavy.length
    ? load.heavy.map((d) => `周${WD[days.indexOf(d)]}`).join('、')
    : '—';

  return (
    <>
      <div className="pagehead">
        <h1>周程</h1>
        <span className="sub">{label} · {niceShort(board.weekStart)} ~ {niceShort(board.weekEnd)}</span>
        <span className="grow" />
        <div className="weeknav">
          <button className="btn" onClick={() => setWeekStart(board.prevStart)}>← 上一周</button>
          <button className="btn" onClick={() => setWeekStart(null)} disabled={board.isThisWeek}>回到本周</button>
          <button className="btn" onClick={() => setWeekStart(board.nextStart)}>下一周 →</button>
        </div>
      </div>

      <div className="scroll week-scroll">
        {/* 负荷 + 完成率：排之前先看清这周有多重、上周干完没有 */}
        <div className="weekstats">
          <span className="wsitem">这周共排 <b>{fmtDur(load.total) || '0 分'}</b></span>
          <span className="wsitem">平均每天 <b>{fmtDur(load.avg) || '0 分'}</b></span>
          <span className="wsitem">
            偏重 <b className={load.heavy.length ? 'warn' : ''}>{heavyLabel}</b>
          </span>
          <span className="wssep" />
          <span className="wsitem">
            完成率 <b>{rateText(completion, { withCounts: true })}</b>
            {completion.dropped > 0 && <span className="wsnote">（含 {completion.dropped} 件放弃，按未完成计）</span>}
          </span>
        </div>

        {/* 固定的事项：不属于某一周，所以不摊进日列，单独一条带子。
            把它放在日列里会误导 —— 看着像「那天要做」，其实它天天都在今日页上。 */}
        {pinned.length > 0 && (
          <div className="weekpinned">
            <div className="wkp-head">
              <span className="wkp-title">固定 · {pinned.length} 条</span>
              <span className="wkp-hint">一直挂在今日页，不占某一天，也不参与排期</span>
            </div>
            <div className="wkp-list">
              {pinned.map((it) => (
                <div className="wkpchip" key={it.id} title={`这条固定着，不排到具体某天（创建于 ${it.date}）`}>
                  <span className="wkp-badge">固定</span>
                  <span className="wkp-name">{it.title}</span>
                  {it.estMinutes ? <span className="wkp-meta">{fmtDur(it.estMinutes)}</span> : null}
                  <button className="wkp-done" title="标记完成" onClick={() => setCompleting(it)}>✓</button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="weekwrap">
          {/* 左：待分配。未完成、且不在这一周里的事项 */}
          <aside className="weekpool">
            <div className="wp-head">
              <span>待分配</span>
              <span className="wp-count">{pool.length}</span>
            </div>
            <div className="wp-hint">拖到右边某一天；或点一条，再点那天。在右边某天右键可直接加。</div>
            <div className="wp-list">
              {pool.map((it) => (
                <div
                  key={it.id}
                  className={`wpitem${picked === it.id ? ' on' : ''}${dragId === it.id ? ' dragging' : ''}`}
                  draggable
                  onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; setDragId(it.id); }}
                  onDragEnd={() => { setDragId(null); setOverDate(null); }}
                  onClick={() => setPicked(picked === it.id ? null : it.id)}
                  title="点一下选中，再点右边某一天"
                >
                  <span className={`wptag t-${poolTag(it.date, board) === '遗留' ? 'old' : poolTag(it.date, board) === '今天' ? 'today' : 'far'}`}>
                    {poolTag(it.date, board)}
                  </span>
                  <span className="wp-title">{it.title}</span>
                  {it.estMinutes ? <span className="wp-est">{fmtDur(it.estMinutes)}</span> : null}
                </div>
              ))}
              {pool.length === 0 && <div className="empty" style={{ padding: '10px 0', fontSize: 12.5 }}>没有待分配的，都排好了。</div>}
            </div>
          </aside>

          {/* 右：这一周 7 天 */}
          <div className="weekgrid">
            {days.map((d, i) => {
              const items = itemsByDate[d] || [];
              const isHeavy = load.heavy.includes(d);
              return (
                <div
                  key={d}
                  className={
                    'weekcol' +
                    (overDate === d ? ' over' : '') +
                    (isHeavy ? ' heavy' : '') +
                    (d === board.today ? ' today' : '')
                  }
                  onDragOver={(e) => { if (dragId) { e.preventDefault(); setOverDate(d); } }}
                  onDragLeave={() => setOverDate((o) => (o === d ? null : o))}
                  onDrop={(e) => { e.preventDefault(); if (dragId) assign(dragId, d); }}
                  onClick={() => { if (picked) assign(picked, d); }}
                  onContextMenu={(e) => openDayMenu(e, d)}
                  title="右键可以往这天加一件事"
                >
                  <div className="wc-head">
                    <span className="wc-wd">周{WD[i]}</span>
                    <span className="wc-date">{niceShort(d)}</span>
                  </div>

                  {/* 负荷分析：这一天的合计，偏重的标出来 */}
                  <div className={`wc-load${isHeavy ? ' warn' : ''}`}>
                    {load.perDay[d] ? fmtDur(load.perDay[d]) : '—'}
                    {isHeavy && <span className="wc-heavy">偏重</span>}
                  </div>

                  <div className="wc-list">
                    {/* 上午 / 下午 / 晚上：列很窄，隔断只留一个很小的时段名 + 一条淡线 */}
                    {groupBySlot(items).map((g) => g.items.length === 0 ? null : (
                      <Fragment key={g.key || 'none'}>
                        {items.some((x) => slotOf(x) !== '') && (
                          <div className={`wc-slot${g.key ? '' : ' none'}`}>{g.label}</div>
                        )}
                        {g.items.map((it) => (
                      <div
                        key={it.id}
                        className={`wchip${it.status === 'done' ? ' done' : ''}${it.status === 'dropped' ? ' dropped' : ''}`}
                        draggable
                        onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.effectAllowed = 'move'; setDragId(it.id); }}
                        onDragEnd={() => { setDragId(null); setOverDate(null); }}
                        onContextMenu={(e) => openItemMenu(e, it)}
                        title="右键可以修改这条"
                      >
                        <button
                          className="wchip-check"
                          draggable={false}
                          title={it.status === 'done' ? '已完成' : '标记完成'}
                          onClick={(e) => { e.stopPropagation(); if (it.status !== 'done') setCompleting(it); }}
                        >
                          ✓
                        </button>
                        {/* 标题和时间分两行：列很窄，挤在一行的话标题只剩三四个字 */}
                        <span className="wchip-body">
                          <span className="wchip-title" title={it.title}>{it.title}</span>
                          {it.estMinutes ? <span className="wchip-est">{fmtDur(it.estMinutes)}</span> : null}
                        </span>
                        <button
                          className="wchip-x"
                          draggable={false}
                          title="退回待分配（放回今天）"
                          onClick={(e) => { e.stopPropagation(); unschedule(it); }}
                        >
                          ×
                        </button>
                      </div>
                        ))}
                      </Fragment>
                    ))}
                  </div>

                  <button
                    className="wc-add"
                    title={`在周${WD[i]}加一件事`}
                    onClick={(e) => {
                      e.stopPropagation();
                      const r = e.currentTarget.getBoundingClientRect();
                      startAdd(d, r.left, r.bottom + 6);
                    }}
                  >
                    ＋
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {loading && <div className="week-loading">正在更新……</div>}
      </div>

      {/* 右键菜单。position:fixed + 在列之外渲染，免得被列的 overflow 裁掉 */}
      {menu && (
        <div
          className="ctxmenu"
          style={{ left: Math.min(menu.x, window.innerWidth - 180), top: Math.min(menu.y, window.innerHeight - 150) }}
          onMouseDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          {menu.kind === 'day' ? (
            <>
              <div className="ctx-head">周{WD[days.indexOf(menu.date)]} · {niceShort(menu.date)}</div>
              <button onClick={() => startAdd(menu.date, menu.x, menu.y)}>加一件事</button>
            </>
          ) : (
            <>
              <div className="ctx-head" title={menu.item.title}>{menu.item.title}</div>
              <button onClick={() => { setEditing(menu.item); setMenu(null); }}>修改</button>
              {menu.item.status !== 'done' && (
                <button onClick={() => { setCompleting(menu.item); setMenu(null); }}>标记完成</button>
              )}
              <button onClick={() => { unschedule(menu.item); setMenu(null); }}>退回待分配</button>
            </>
          )}
        </div>
      )}

      {/* 加一件事的小表单：贴在指针旁边，标题 + 预计耗时 + 开始时间 */}
      {adding && (
        <div
          className="wkadd"
          style={{
            left: Math.min(adding.x, Math.max(0, window.innerWidth - 272)),
            top: Math.min(adding.y, Math.max(0, window.innerHeight - 190))
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div className="wkadd-head">
            加到 周{WD[days.indexOf(adding.date)]} · {niceShort(adding.date)}
          </div>
          <input
            className="wkadd-title"
            autoFocus
            value={addTitle}
            placeholder="这件事是……"
            onChange={(e) => setAddTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addTo(); }}
          />
          <div className="wkadd-row">
            <label htmlFor="wkadd-est">预计</label>
            <input
              id="wkadd-est"
              type="number"
              min="0"
              className="wkadd-num"
              value={addEst}
              placeholder="—"
              onChange={(e) => setAddEst(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addTo(); }}
            />
            <span className="wkadd-unit">分钟</span>
            <span className="wkadd-gap" />
            <label htmlFor="wkadd-start">开始</label>
            <input
              id="wkadd-start"
              type="time"
              className="wkadd-time"
              value={addStart}
              onChange={(e) => setAddStart(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addTo(); }}
            />
          </div>
          <div className="wkadd-foot">
            <button className="refpinbtn" onClick={closeAdd}>取消</button>
            <button className="btn primary wkadd-ok" onClick={addTo}>加</button>
          </div>
        </div>
      )}

      {completing && (
        <CompleteModal
          item={completing}
          today={board.today}
          onClose={() => setCompleting(null)}
          onDone={() => { setCompleting(null); refresh(); }}
        />
      )}

      {editing && (
        <EditItemModal
          item={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); refresh(); }}
        />
      )}
    </>
  );
}
