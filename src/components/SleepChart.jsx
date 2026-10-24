/* 睡眠时长柱状图。纯展示组件：不碰 window、不碰 document，
   所以能脱离 Electron 用 SSR 渲染出来做断言（见 scripts/test-ui.jsx）。

   设计取向：**克制**。睡眠数据只有「时长」一个维度，图上不该再叠装饰：
   - 只画 6h / 9h 两条极淡的网格线，标出正常区间的边界；
   - 一条 7h 虚线参考线（建议下限），标签压在线上；
   - 柱子按档位着色，颜色本身就是「达标没有」的答案；
   - 不画趋势折线 —— 柱子已经表达了走势，再叠一条线只会糊成一团。
 */
import { shift, nightLabel } from '../dates.js';

/** 纵轴满格。固定 12 小时，不跟着数据变 —— 否则「这周看起来都挺高」是假的。 */
const SCALE_MAX = 12 * 60;
const REF_MIN = 7 * 60;      // 参考线：成年人建议的下限
const REF_MAX = 9 * 60;      // 正常区间的上界

function fmtDur(m) {
  if (!m && m !== 0) return '';
  const h = Math.floor(m / 60);
  const mi = Math.round(m % 60);
  const parts = [];
  if (h) parts.push(`${h} 小时`);
  if (mi || !h) parts.push(`${mi} 分`);
  return parts.join(' ');
}

export default function SleepChart({ records, span, today, onPick, picked }) {
  const byDate = new Map((records || []).map((r) => [r.date, r]));

  // 从 today 往前铺满 span 天，缺的那天也占一格（否则柱子会挤在一起，看不出断档）
  const cols = [];
  for (let i = span - 1; i >= 0; i--) {
    const date = shift(today, -i);
    cols.push({ date, rec: byDate.get(date) || null });
  }

  const filled = cols.filter((c) => c.rec).length;
  const labelEvery = span <= 14 ? 1 : span <= 30 ? 3 : 10;
  const dense = span > 30;
  const pct = (min) => `${(min / SCALE_MAX) * 100}%`;

  return (
    <div className={`sleep-chart${dense ? ' dense' : ''}`}>
      <div className="sc-plot">
        {/* 左侧刻度：只标 9 / 6 小时（正常区间的两条边界），顶线代表 12 小时满格 */}
        <div className="sc-y" aria-hidden="true">
          {[9, 6].map((h) => (
            <span key={h} className="sc-ytick" style={{ bottom: pct(h * 60) }}>{h}h</span>
          ))}
        </div>

        <div className="sc-inner">
          {[REF_MAX, 6 * 60].map((m) => (
            <div key={m} className="sc-grid" style={{ bottom: pct(m) }} aria-hidden="true" />
          ))}
          {/* 7 小时下限：虚线要穿过柱子（z-index 比柱子高，否则等于没画）。
              这里刻意**不挂文字标签** —— 任何高于 7 小时的柱子都会顶到线上方，
              标签放哪儿都会压住一根柱子；改在下面的脚注里说明这条虚线是什么。 */}
          <div className="sc-ref" style={{ bottom: pct(REF_MIN) }} aria-hidden="true" />

          <div className="sc-bars">
            {cols.map(({ date, rec }) => (
              <div
                className={`sc-col${date === today ? ' today' : ''}${picked === date ? ' picked' : ''}${rec ? '' : ' empty'}`}
                key={date}
                title={rec
                  ? `${nightLabel(date)} · ${fmtDur(rec.minutes)}（${rec.bandLabel}）`
                  : `${nightLabel(date)} · 没有记录`}
                onClick={rec && onPick ? () => onPick(rec) : undefined}
              >
                {rec && (
                  <span
                    className={`sc-bar b-${rec.band}`}
                    style={{ height: `${Math.max(3, (rec.minutes / SCALE_MAX) * 100)}%` }}
                  />
                )}
              </div>
            ))}
          </div>

          {/* 基线：柱子站在一条线上，而不是悬在空中 */}
          <div className="sc-base" aria-hidden="true" />
        </div>
      </div>

      <div className="sc-axis">
        <span className="sc-axis-pad" />
        {cols.map(({ date }, i) => (
          <span key={date} className={`sc-tick${date === today ? ' today' : ''}`}>
            {i % labelEvery === 0 ? Number(date.slice(8, 10)) : ''}
          </span>
        ))}
      </div>

      <div className="sc-foot">
        <span>{span} 天里有记录 {filled} 天</span>
        <span className="sc-sep">·</span>
        <span>虚线是 7 小时下限</span>
        <span className="grow" />
        {onPick && <span className="sc-tip">点柱子可以回看那一天</span>}
      </div>
    </div>
  );
}
