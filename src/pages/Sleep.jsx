import { useState, useEffect, useMemo } from 'react';
import SleepChart from '../components/SleepChart.jsx';
import { nightLabel } from '../dates.js';
import { mdToHtml } from '../md.js';
import { shift } from '../dates.js';

const WD = ['日', '一', '二', '三', '四', '五', '六'];

function niceDate(s) {
  const d = new Date(`${s}T00:00:00`);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 · 周${WD[d.getDay()]}`;
}

function fmtDur(m) {
  if (!m && m !== 0) return '';
  const h = Math.floor(m / 60);
  const mi = Math.round(m % 60);
  const parts = [];
  if (h) parts.push(`${h} 小时`);
  if (mi || !h) parts.push(`${mi} 分`);
  return parts.join(' ');
}

/** 带符号的分钟差，给「比上一段」用。0 显示「持平」。 */
export function signedDur(m) {
  if (!m) return '持平';
  return `${m > 0 ? '+' : '−'}${fmtDur(Math.abs(m))}`;
}

/* 录入前的预览用。真正的换算在主进程（electron/sleep.cjs），
   那边才是权威 —— 保存时以它返回的时长为准。
   两处用同一组用例测过，见 scripts/smoke.cjs 和 scripts/test-ui.jsx。 */
export function calcMinutes(bed, wake, min, max) {
  const toMin = (s) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
    if (!m) return null;
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (h > 23 || mi > 59) return null;
    return h * 60 + mi;
  };
  const b = toMin(bed);
  const w = toMin(wake);
  if (b === null || w === null) return null;
  let d = w - b;
  if (d <= 0) d += 24 * 60;                 // 跨午夜：23:40 → 07:10
  if (d < min || d > max) return null;
  return d;
}

/** 「23:40」加减分钟，用于 ± 微调按钮。折回 0–23:59。 */
export function nudgeClock(hhmm, delta) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return hhmm;
  const total = ((Number(m[1]) * 60 + Number(m[2]) + delta) % 1440 + 1440) % 1440;
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(total / 60))}:${p(total % 60)}`;
}

/** 阈值从 bootstrap 下发（bands），不在前端重复写常量 */
function bandOf(minutes, bands) {
  if (!bands || !bands.length || !minutes) return null;
  return bands.find((b) => b.max === null || minutes < b.max) || bands[bands.length - 1];
}

export default function Sleep({ boot, reload }) {
  const sp = boot.sleep;
  const todayRec = sp.today;   // 今天的记录（不是日期字符串，日期是 sp.date）

  const [bed, setBed] = useState(todayRec ? todayRec.bedTime : '23:00');
  const [wake, setWake] = useState(todayRec ? todayRec.wakeTime : '07:00');
  const [span, setSpan] = useState(sp.spans[0]);
  const [note, setNote] = useState('');
  const [picked, setPicked] = useState(null);   // 从柱状图点开回看的那一天
  const [report, setReport] = useState(null);
  const [more, setMore] = useState(false);   // 「更多数据」展开状态   // 刚生成的分析报告（直接显示在页面上）

  // 换一天的数据回来（保存后 reload）时，把输入框同步过去
  useEffect(() => {
    if (todayRec) { setBed(todayRec.bedTime); setWake(todayRec.wakeTime); }
  }, [todayRec && todayRec.bedTime, todayRec && todayRec.wakeTime]);

  const preview = calcMinutes(bed, wake, sp.minMinutes, sp.maxMinutes);
  const previewBand = bandOf(preview, sp.bands);
  const stats = sp.stats[span];
  const cmp = span === 30 ? sp.compare && sp.compare[30] : null;
  const g = sp.guideline;

  // 这一段里缺记录的天数（只有起点确定时才算得出来）
  const missing = useMemo(() => {
    if (!stats) return null;
    return span - stats.count;
  }, [stats, span]);

  const flash = (m) => { setNote(m); setTimeout(() => setNote(''), 3000); };

  const save = async () => {
    const r = await window.hua.sleep.save({ date: sp.date, bedTime: bed, wakeTime: wake });
    if (r.error) { flash(r.error); return; }
    flash(`已记下 ${fmtDur(r.record.minutes)}`);
    setPicked(null);
    reload();
  };

  const remove = async () => {
    await window.hua.sleep.remove({ date: sp.date });
    flash('已删除今天的记录');
    reload();
  };

  const genReport = async (days) => {
    const to = sp.date;
    const r = await window.hua.sleep.report({ from: shift(to, -(days - 1)), to });
    // 直接显示在页面上。只 flash 一句「已生成」的话，用户会以为「点了没反应」——
    // 报告落到 reports/ 里，但那不是他点按钮时想看的东西。
    setReport(r);
    flash(`${r.title} 已生成（${r.dayCount} 天有记录）`);
  };

  /* 柱状图的跨度可能超过 90 天下发窗口，所以按 span 取「这段的记录」给图用。
     图自己会按 today 往前铺满，缺的补空格。 */
  const chartRecords = useMemo(() => {
    const from = shift(sp.date, -(span - 1));
    return sp.recent.filter((r) => r.date >= from && r.date <= sp.date);
  }, [sp.recent, sp.date, span]);

  const pickDay = (rec) => setPicked((cur) => (cur === rec.date ? null : rec.date));
  const pickedRec = picked ? chartRecords.find((r) => r.date === picked) || null : null;

  return (
    <>
      <div className="pagehead">
        <h1>睡眠</h1>
        <span className="sub">{nightLabel(sp.date)}</span>
        <span className="grow" />
        {note && <span className="sub">{note}</span>}
      </div>

      <div className="scroll">
        {/* 录入：只填两个时间点，时长和分档都是算出来的 */}
        <div className={`sleep-entry${preview ? '' : ' bad'}`}>
          <div className="se-field">
            <span className="se-label">昨晚</span>
            <div className="se-row">
              <input type="time" className="se-time" value={bed} onChange={(e) => setBed(e.target.value)} />
              <span className="se-word">入睡</span>
              <span className="se-nudge">
                <button className="se-nb" onClick={() => setBed(nudgeClock(bed, -30))} title="提前半小时">−</button>
                <button className="se-nb" onClick={() => setBed(nudgeClock(bed, 30))} title="推后半小时">+</button>
              </span>
            </div>
          </div>

          <div className="se-field">
            <span className="se-label">今早</span>
            <div className="se-row">
              <input type="time" className="se-time" value={wake} onChange={(e) => setWake(e.target.value)} />
              <span className="se-word">起床</span>
              <span className="se-nudge">
                <button className="se-nb" onClick={() => setWake(nudgeClock(wake, -30))} title="提前半小时">−</button>
                <button className="se-nb" onClick={() => setWake(nudgeClock(wake, 30))} title="推后半小时">+</button>
              </span>
            </div>
          </div>

          <span className="grow" />

          {preview
            ? (
              <div className="se-readout">
                <span className="se-dur">{fmtDur(preview)}</span>
                <span className={`sleep-chip b-${previewBand.key}`}>{previewBand.label}</span>
              </div>
            )
            : <span className="se-bad">这两个时间点算不出合理时长，检查一下是不是填反了</span>}

          <div className="se-actions">
            <button className="composer-btn" onClick={save}>记下</button>
            {todayRec && <button className="se-del" onClick={remove}>删除今天</button>}
          </div>
        </div>

        {todayRec && (
          <div className="sleep-today">
            今天已记：{todayRec.bedTime} 入睡 → {todayRec.wakeTime} 起床，{fmtDur(todayRec.minutes)} · {todayRec.bandLabel}
            {preview && preview !== todayRec.minutes && (
              <span className="se-dirty">（输入框改了还没保存）</span>
            )}
          </div>
        )}

        <div className="sleep-chart-head">
          <span className="se-label">近 {span} 天</span>
          <span className="grow" />
          <div className="tabs" style={{ marginBottom: 0 }}>
            {sp.spans.map((n) => (
              <button key={n} className={span === n ? 'on' : ''} onClick={() => setSpan(n)}>{n} 天</button>
            ))}
          </div>
        </div>

        <SleepChart
          records={chartRecords}
          span={span}
          today={sp.date}
          picked={picked}
          onPick={pickDay}
        />

        {pickedRec && (
          <div className="sleep-peek">
            <span className="sp-date">{nightLabel(pickedRec.date)}</span>
            <span className="sp-main">{fmtDur(pickedRec.minutes)}</span>
            <span className={`sleep-chip b-${pickedRec.band}`}>{pickedRec.bandLabel}</span>
            <span className="sp-times">{pickedRec.bedTime} → {pickedRec.wakeTime}</span>
            <span className="grow" />
            <button className="se-del" onClick={() => setPicked(null)}>收起</button>
          </div>
        )}

        {/* 分档：一条堆叠条 + 一行图例。它同时充当柱状图的图例（颜色 → 档位），
            所以上面不再单独放一排色块说明 —— 同一个信息不写两遍。 */}
        {stats && (
          <div className="sleep-dist">
            <div className="sd-bar">
              {sp.bands.map((b) => {
                const n = stats.counts[b.key] || 0;
                if (!n) return null;
                return (
                  <span
                    key={b.key}
                    className={`sd-seg b-${b.key}`}
                    style={{ flex: n }}
                    title={`${b.label}（${b.range}）· ${n} 天`}
                  />
                );
              })}
            </div>
            <div className="sd-legend">
              {sp.bands.map((b) => {
                const n = stats.counts[b.key] || 0;
                return (
                  <span className={`sd-item${n ? '' : ' zero'}`} key={b.key} title={b.range}>
                    <i className={`sl-dot b-${b.key}`} />
                    {b.label}
                    <b>{n}</b>天
                  </span>
                );
              })}
            </div>
          </div>
        )}
        {stats
          ? (
            <>
              {/* 关键数字：一行，用细竖线分隔 —— 不是六张各自为政的小卡片 */}
              <div className="sleep-metrics">
                <div className="sm-item">
                  <span className="sm-v">{fmtDur(stats.avg)}</span>
                  <span className="sm-k">
                    平均时长
                    {cmp && (
                      <em className={cmp.avgDelta === 0 ? '' : cmp.avgDelta > 0 ? 'up' : 'down'}>
                        比上一段 {signedDur(cmp.avgDelta)}
                      </em>
                    )}
                  </span>
                </div>
                <span className="sm-sep" />
                <div className="sm-item">
                  <span className="sm-v">{stats.okRate}<i>%</i></span>
                  <span className="sm-k">
                    正常率（7–9 小时）
                    {cmp && (
                      <em className={cmp.okRateDelta === 0 ? '' : cmp.okRateDelta > 0 ? 'up' : 'down'}>
                        比上一段 {cmp.okRateDelta > 0 ? '+' : ''}{cmp.okRateDelta}%
                      </em>
                    )}
                  </span>
                </div>
                <span className="sm-sep" />
                <div className="sm-item">
                  <span className="sm-v">{stats.regularity === null ? '—' : stats.regularity}<i>分</i></span>
                  <span className="sm-k">
                    作息规律度
                    <em>入睡离散 ±{stats.bedSpread === null ? '—' : fmtDur(stats.bedSpread)}</em>
                  </span>
                </div>
                <span className="sm-sep" />
                <div className="sm-item">
                  <span className="sm-v">{stats.count}<i>/{span}</i></span>
                  <span className="sm-k">天有记录</span>
                </div>
              </div>

              {/* 其余细节收起来 —— 一屏里不需要同时看八个数字 */}
              <button className="sleep-more" onClick={() => setMore((v) => !v)}>
                {more ? '收起细节' : '更多数据'}
                <i className="sm-caret">{more ? '▴' : '▾'}</i>
              </button>
              {more && (
                <dl className="sleep-details">
                  <div><dt>中位数</dt><dd>{fmtDur(stats.median)}</dd></div>
                  <div><dt>最长</dt><dd>{fmtDur(stats.longest)}</dd></div>
                  <div><dt>最短</dt><dd>{fmtDur(stats.shortest)}</dd></div>
                  <div><dt>时长波动</dt><dd>±{fmtDur(stats.sd)}</dd></div>
                  <div><dt>平均入睡</dt><dd>{stats.avgBed}</dd></div>
                  <div><dt>平均起床</dt><dd>{stats.avgWake}</dd></div>
                </dl>
              )}

              {missing !== null && missing > 0 && (
                <div className="sleep-miss">
                  这 {span} 天里还有 <b>{missing} 天</b>没记。记录缺得多的时候，上面的均值只代表记了的那些天。
                </div>
              )}
            </>
          )
          : <div className="empty" style={{ padding: '14px 0' }}>这 {span} 天还没有睡眠记录。</div>}

        <div className="sleep-report">
          <button className="btn" onClick={() => genReport(span)}>生成近 {span} 天分析报告</button>
          <button className="btn" onClick={() => genReport(30)}>近 30 天</button>
          <button className="btn" onClick={() => genReport(90)}>近 90 天</button>
          <span className="se-word">生成后直接显示在下面，同时落到 reports/</span>
        </div>

        {/* 报告正文：点了按钮就在这儿看，不用去目录里翻文件 */}
        {report && (
          <div className="sleep-report-body">
            <div className="srb-head">
              <span className="srb-title">{report.title}</span>
              <span className="srb-meta">{report.dayCount} 天有记录</span>
              <span className="grow" />
              <button className="btn" style={{ padding: '3px 10px', fontSize: 12 }}
                onClick={() => window.hua.shell.openDataDir()}>打开 reports 目录</button>
              <button className="refpinbtn" onClick={() => setReport(null)}>收起</button>
            </div>
            <div
              className="srb-md"
              dangerouslySetInnerHTML={{ __html: mdToHtml(report.md || '') }}
            />
          </div>
        )}

        <div className="sleep-note">
          判定依据：健康成年人每晚至少 <b>{g.minHours} 小时</b>，{g.minHours}–{g.maxHours} 小时为正常，
          低于 6 小时属严重不足。来源：{g.source} · 核对日期 {g.checkedAt} · 以官网为准。
          这里只做记录和汇总，不构成医学建议。
        </div>
      </div>
    </>
  );
}
