/* 已完成清单 —— 今日页右栏和回顾页共用。
   素线方案：左侧完成时刻，右侧一条按时长成比例的细条 + 时长数字，顶部一行合计。
   之所以不是普通列表，是因为这一块真正想让人看到的是「时间花在哪」，
   光排标题读起来只是个流水账。 */

function fmtMin(m) {
  if (!m) return '';
  const h = Math.floor(m / 60);
  const mm = Math.round(m % 60);
  const parts = [];
  if (h) parts.push(`${h} 小时`);
  if (mm || !h) parts.push(`${mm} 分`);   // 整小时不再留下「2 小时 」这种尾空格
  return parts.join(' ');
}

/** completedAt 是 UTC ISO，这里换算成本地 HH:MM */
function hm(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/* 条的刻度是绝对的：满格 = 120 分钟（2 小时），超出就顶格。
   早先按「当日最长」算比例，结果一天只有一件事时永远是满格 ——
   15 分钟和 2 小时画出来一样长，还看不出跨天的对比。 */
const FULL_MIN = 120;

export default function DoneList({ items, className = '' }) {
  if (!items || items.length === 0) return null;

  const rows = items.map((it) => ({ it, min: it.actualMinutes || it.estMinutes || 0 }));
  const total = rows.reduce((s, r) => s + r.min, 0);
  const hasMin = rows.some((r) => r.min > 0);
  const hasTime = rows.some((r) => hm(r.it.completedAt));

  // 老数据可能既没时长也没完成时刻 —— 对应的列整列收起，免得留一排空档
  const cls = ['donelist', className, hasMin ? '' : 'no-min', hasTime ? '' : 'no-time']
    .filter(Boolean).join(' ');

  return (
    <div className={cls}>
      {total > 0 && <div className="dl-sum">合计 {fmtMin(total)}</div>}
      {rows.map(({ it, min }) => (
        <div className="doneline ok" key={it.id}>
          <span className="dl-time">{hm(it.completedAt)}</span>
          <span className="dl-title">
            {it.title}
            {it.output && <span className="dl-out">{it.output}</span>}
          </span>
          <span className="dl-bar">
            {min > 0
              ? <i style={{ width: `${Math.min(100, Math.round((min / FULL_MIN) * 100))}%` }} />
              : null}
          </span>
          <span className="dl-meta">{min > 0 ? fmtMin(min) : ''}</span>
        </div>
      ))}
    </div>
  );
}
