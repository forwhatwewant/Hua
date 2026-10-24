import { useCallback, useEffect, useState } from 'react';
import { highlight } from '../md.js';
import ReflectionEntry from '../components/ReflectionEntry.jsx';
import DoneList from '../components/DoneList.jsx';
import { rateText } from '../rate.js';

const WD = ['日', '一', '二', '三', '四', '五', '六'];
const pad2 = (n) => String(n).padStart(2, '0');

/** 相对某一天往前/后推 n 天。基准日必须是主进程按日界算出来的那天（boot.today），
    不是本地 new Date() —— 凌晨 1 点「今天」应该还是前一天。 */
function shiftFrom(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

const nice = (s) => {
  const d = new Date(`${s}T00:00:00`);
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日 · 周${WD[d.getDay()]}`;
};

export default function Review({ boot }) {
  const [tab, setTab] = useState('flow');

  return (
    <>
      <div className="pagehead">
        <h1>回顾</h1>
        <span className="sub">往回看，是为了决定下一步</span>
      </div>
      <div className="scroll">
        <div className="tabs">
          <button className={tab === 'flow' ? 'on' : ''} onClick={() => setTab('flow')}>时间流</button>
          <button className={tab === 'search' ? 'on' : ''} onClick={() => setTab('search')}>搜索</button>
          <button className={tab === 'report' ? 'on' : ''} onClick={() => setTab('report')}>报告</button>
        </div>

        {tab === 'flow' && <Flow today={boot?.today} />}
        {tab === 'search' && <Search />}
        {tab === 'report' && <Reports />}
      </div>
    </>
  );
}

/* ---------- 时间流 ---------- */

function Flow({ today: todayIn }) {
  const today = todayIn || (() => {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  })();
  const [span, setSpan] = useState(30);
  const [days, setDays] = useState([]);
  const [loading, setLoading] = useState(true);
  const [openRefs, setOpenRefs] = useState(() => {
    // 回顾里展开的心得跨页签保留 —— 否则写到一半切走再回来又折叠，编辑上下文丢了
    try { return new Set(JSON.parse(localStorage.getItem('hua:rev-open') || '[]')); }
    catch { return new Set(); }
  });

  const fetchDays = useCallback(
    () => window.hua.review.days({ from: shiftFrom(today, -(span - 1)), to: today }),
    [span, today]
  );

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchDays().then((r) => { if (alive) { setDays(r); setLoading(false); } });
    return () => { alive = false; };
  }, [fetchDays]);

  const refreshDays = async () => { setDays(await fetchDays()); };

  const toggleRef = (date, time) => {
    setOpenRefs((prev) => {
      const next = new Set(prev);
      const k = `${date}|${time}`;
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  };

  // 折叠/展开状态写入 localStorage，跨页签/重启都保留
  useEffect(() => {
    try { localStorage.setItem('hua:rev-open', JSON.stringify([...openRefs])); } catch { /* 无痕模式忽略 */ }
  }, [openRefs]);

  const addRef = async (date) => {
    const { time } = await window.hua.journal.add({ date, body: '' });
    setOpenRefs((prev) => new Set(prev).add(`${date}|${time}`));   // 新加的这条直接展开
    setDays(await fetchDays());
  };

  return (
    <>
      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        {[7, 30, 90].map((n) => (
          <button key={n} className={`btn${span === n ? ' primary' : ''}`} style={{ padding: '5px 12px', fontSize: 12.5 }} onClick={() => setSpan(n)}>
            近 {n} 天
          </button>
        ))}
      </div>

      {loading && <div className="empty">正在读……</div>}
      {!loading && days.length === 0 && <div className="empty">这段时间还没有记录。</div>}

      {days.map((d) => {
        const done = d.items.filter((i) => i.status === 'done');
        const dropped = d.items.filter((i) => i.status === 'dropped');
        return (
        <div className="daycard" key={d.date}>
          <div className="dc-head">
            <span className="dc-date">{nice(d.date)}</span>
            <span className="dc-wd">
              {done.length} 完成
              {dropped.length ? ` · ${dropped.length} 放弃` : ''}
            </span>
          </div>

          <DoneList items={done} className="dc-done" />

          {(d.reflections || []).length > 0
            ? (d.reflections || []).map((e) => (
                <ReflectionEntry
                  key={e.time}
                  date={d.date}
                  entry={e}
                  open={openRefs.has(`${d.date}|${e.time}`)}
                  onToggle={() => toggleRef(d.date, e.time)}
                  onRemoved={refreshDays}
                  onSaved={refreshDays}
                  onPin={refreshDays}
                  refItems={d.items.filter((i) => i.status === 'done')}
                />
              ))
            : <div className="dc-body" style={{ color: 'var(--text-3)', fontSize: 12.5 }}>这天没有写心得。</div>}

          <button
            className="btn"
            style={{ padding: '4px 10px', fontSize: 12, marginTop: 6 }}
            onClick={() => addRef(d.date)}
          >
            + 补写心得
          </button>
        </div>
        );
      })}
    </>
  );
}

/* ---------- 搜索 ---------- */

function Search() {
  const [q, setQ] = useState('');
  const [res, setRes] = useState(null);

  useEffect(() => {
    if (!q.trim()) { setRes(null); return; }
    const t = setTimeout(() => window.hua.search({ q: q.trim() }).then(setRes), 220);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <>
      <div className="searchbar">
        <input
          autoFocus
          value={q}
          placeholder="搜心得和事项…（例：token）"
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {res && (
        <>
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 8 }}>
            心得 {res.journal.length} 条 · 事项 {res.items.length} 条
          </div>

          {res.journal.map((h, i) => (
            <div className="hit" key={`j${i}`}>
              <div className="h-date">
                {nice(h.date)} · 心得{h.time ? ` · ${h.time}` : ''}{h.title ? ` · ${h.title}` : ''}
              </div>
              <div style={{ fontSize: 13.5, color: 'var(--text-2)', whiteSpace: 'pre-wrap' }}
                dangerouslySetInnerHTML={{ __html: highlight(h.body, q) }} />
            </div>
          ))}

          {res.items.map((it) => (
            <div className="hit" key={it.id}>
              <div className="h-date">{nice(it.date)} · 事项</div>
              <div style={{ fontSize: 13.5 }}
                dangerouslySetInnerHTML={{ __html: highlight(it.title, q) }} />
              {it.output && (
                <div style={{ fontSize: 12.5, color: 'var(--text-3)', marginTop: 3 }}
                  dangerouslySetInnerHTML={{ __html: highlight(it.output, q) }} />
              )}
            </div>
          ))}

          {res.journal.length === 0 && res.items.length === 0 && <div className="empty">没有找到。</div>}
        </>
      )}

      {!res && <div className="empty">输入关键词，在心得原文和事项里全文检索。</div>}
    </>
  );
}

/* ---------- 报告 ---------- */

function Reports() {
  const [list, setList] = useState([]);
  const [msg, setMsg] = useState('');
  const [ov, setOv] = useState(null);

  const refresh = () => window.hua.report.list().then(setList);
  useEffect(() => { refresh(); }, []);
  // 完成率总览：整体累计 + 最近 8 周。口径由主进程算（electron/stats.cjs）。
  useEffect(() => {
    window.hua.stats.overview({ weeks: 8 }).then(setOv).catch(() => setOv(null));
  }, []);

  const gen = async (period) => {
    const r = await window.hua.report.generate({ period });
    setMsg(`${r.title} 已生成（${r.dayCount} 天有记录）`);
    refresh();
    setTimeout(() => setMsg(''), 3000);
  };

  return (
    <>
      {ov && (
        <div className="rec-block ratereport">
          <h3>完成率</h3>
          <div className="rateover">
            <span className="ro-big">{rateText(ov.overall)}</span>
            <span className="ro-sub">
              至今完成 {ov.overall.done} / {ov.overall.total} 件
              {ov.overall.dropped > 0 ? ` · 另有 ${ov.overall.dropped} 件放弃` : ''}
            </span>
          </div>

          {ov.weeks.length > 0 && (
            <div className="rateweeks">
              {ov.weeks.map((w) => (
                <div className="rw-row" key={w.weekKey}>
                  <span className="rw-label">{w.weekStart.slice(5).replace('-', '/')} 那周</span>
                  <span className="rw-bar">
                    <i style={{ width: `${w.pct === null ? 0 : w.pct}%` }} />
                  </span>
                  <span className="rw-pct">{rateText(w)}</span>
                  <span className="rw-count">{w.done}/{w.total}</span>
                </div>
              ))}
            </div>
          )}

          <div className="desc" style={{ marginTop: 10, fontSize: 12.5, color: 'var(--text-3)', lineHeight: 1.7 }}>
            完成率 = 完成 / <b>全部事项</b>（完成 + 未完成 + 放弃）。<b>「放弃」按未完成计</b> ——
            事情没做完就是没做完，换个说法不该改变这个事实；它的件数单独列在上面。
            真正不计入的只有「删除」：删除会把记录从库里删掉，自然就不存在了。
            一周里没有任何事项时显示「—」，因为「没东西可做」和「一件没完成」是两回事。
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <button className="btn primary" onClick={() => gen('week')}>生成本周周报</button>
        <button className="btn" onClick={() => gen('month')}>生成上月月报</button>
        <span style={{ fontSize: 12.5, color: 'var(--text-3)' }}>{msg}</span>
      </div>

      <div style={{ fontSize: 12.5, color: 'var(--text-3)', marginBottom: 14, lineHeight: 1.7 }}>
        报告是机械汇总——完成清单加总耗时，加上那段时间的心得原文，不做任何改写。<br />
        月报会在每月 1 号自动生成（如果那天没打开应用，下次打开时补生成）。
      </div>

      {list.length === 0 && <div className="empty">还没有生成过报告。</div>}

      {list.map((r) => (
        <div className="reportrow" key={r.name}>
          <span className="rr-name">{r.name.replace(/\.md$/, '')}</span>
          <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
            {new Date(r.mtime).toLocaleDateString('zh-CN')}
          </span>
          <button onClick={() => window.hua.shell.openDataDir()}>打开目录</button>
        </div>
      ))}
    </>
  );
}
