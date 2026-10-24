import { useEffect, useState } from 'react';
import { dayNotice } from '../daynotice.js';

/* 日界提示条。
 *
 * 凌晨 0 点到「一天的起点」之间，写的东西算前一天 —— 这事很容易忘。
 * 在应用顶部挂一条细提示，说清楚「现在写的算哪天」「新的一天什么时候开始」。
 * 一分钟对一次表，跨过日界的瞬间会自动切换（不用重开应用）。
 *
 * 只在两种短暂窗口出现：跨日期间、刚过日界的一小时内。其余时间不渲染，不占地方。
 */
export default function DayBanner({ dayStartHour }) {
  const [notice, setNotice] = useState(() => dayNotice(new Date(), dayStartHour));

  useEffect(() => {
    setNotice(dayNotice(new Date(), dayStartHour));
    const t = setInterval(() => setNotice(dayNotice(new Date(), dayStartHour)), 60000);
    return () => clearInterval(t);
  }, [dayStartHour]);

  if (!notice) return null;

  return (
    <div className={`daybanner ${notice.kind}`} role="status">
      <span className="db-dot" />
      <span className="db-text">{notice.text}</span>
    </div>
  );
}
