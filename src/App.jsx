import { useCallback, useEffect, useRef, useState } from 'react';
import Today from './pages/Today.jsx';
import Log from './pages/Log.jsx';
import Review from './pages/Review.jsx';
import Week from './pages/Week.jsx';
import Sleep from './pages/Sleep.jsx';
import Settings from './pages/Settings.jsx';
import DayBanner from './components/DayBanner.jsx';

/* 顺序按时间跨度排：今天 → 日纪（记录今天）→ 回顾（往回看）→ 周程（决定下一步）。
   周程紧挨着回顾，因为「回顾完顺手排下周」就是它要支撑的那个动作。 */
const TABS = [
  ['today', '今天'],
  ['log', '日纪'],
  ['review', '回顾'],
  ['week', '周程'],
  ['sleep', '睡眠'],
  ['settings', '设置']
];

export default function App() {
  const [tab, setTab] = useState('today');
  const [boot, setBoot] = useState(null);
  const [theme, setTheme] = useState('paper');
  /* 跨页跳转：在今日页点日纪，要跳到日纪页并定位到那一天。
     用一个「请求」对象传递，Log 消费掉之后清空（避免下次进来又跳一次）。

     为什么用 ref 而不是 state：Log 只在 tab==='log' 时才挂载，消费副作用要等挂载才跑；
     而 openLogAt 紧接着要 switchTab（会 reload）。若请求放在 state 里，
     `onJumpDone` 可能在重渲染中先把请求清掉，Log 挂载时就什么也拿不到 ——
     表现就是「点了没反应」。ref 同步写、跨渲染存活，切页/重拉都不丢。 */
  const logJumpRef = useRef(null);
  const [, bumpJump] = useState(0);   // 只是为了让 Log 知道「来了个新请求」
  /* 启动失败要说话。以前 bootstrap 一旦抛错，boot 永远是 null，
     界面就永远停在「正在打开……」—— 看起来像「打不开了」，还查不出原因。
     现在把错误显示出来，至少知道是哪一步坏了。 */
  const [bootError, setBootError] = useState(null);

  const reload = useCallback(async () => {
    try {
      const b = await window.hua.bootstrap();
      setBoot(b);
      setTheme(b.settings.theme || 'paper');
      setBootError(null);
      return b;
    } catch (e) {
      setBootError(e?.message || String(e));
      return null;
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  useEffect(() => { window.hua.onDataChanged(() => reload()); }, [reload]);

  // 切页签也要重拉一次：在回顾里固定/编辑的内容，回到今日页必须能看到。
  // 之前 boot 只在启动时取，导致「回顾里点了固定，今日页毫无反应」。
  const switchTab = (k) => { setTab(k); reload(); };

  /** 跳到日纪页的某一天（默认写作视图）。连点同一天也要能重新定位，所以带个 n。 */
  const openLogAt = useCallback((date, view = 'write') => {
    logJumpRef.current = { date, view, n: Date.now() };
    bumpJump((v) => v + 1);
    switchTab('log');
  }, []);

  if (!boot) {
    if (!bootError) return <div className="empty" style={{ padding: 48 }}>正在打开……</div>;
    return (
      <div className="empty" style={{ padding: 48, lineHeight: 1.9 }}>
        <div style={{ fontSize: 15, color: 'var(--danger, #b3261e)', marginBottom: 6 }}>
          打不开：读取数据时出错了
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--text-3)', maxWidth: 520 }}>
          错误信息：{bootError}
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--text-3)', maxWidth: 520, marginTop: 10 }}>
          你的记录都还在磁盘上，别删数据目录。若反复出错，把上面这行信息发我。
        </div>
        <button
          className="btn primary"
          style={{ marginTop: 14 }}
          onClick={() => { setBootError(null); reload(); }}
        >
          再试一次
        </button>
      </div>
    );
  }

  return (
    <div className="app">
      <nav className="rail">
        <div className="brand">
          花<small>HUA</small>
        </div>
        {TABS.map(([k, label]) => (
          <button key={k} className={`navbtn${tab === k ? ' on' : ''}`} onClick={() => switchTab(k)}>
            <span className="dotmark" />
            {label}
          </button>
        ))}
        <div className="rail-foot">
          Ctrl+Shift+H
          <br />
          快速记录
        </div>
      </nav>

      <main className="main">
        {/* 日界提示：凌晨把「现在写的算哪天」说清楚，免得记错日子。
            只在跨日窗口和刚过日界时出现，平时不占地方。 */}
        <DayBanner dayStartHour={boot.settings.dayStartHour} />

        {tab === 'today' && (
          <Today
            boot={boot}
            reload={reload}
            onOpenLogAt={openLogAt}
            onOpenSleep={() => switchTab('sleep')}
          />
        )}
        {tab === 'log' && (
          <Log
            boot={boot}
            reload={reload}
            jump={logJumpRef.current}
            onJumpDone={() => { logJumpRef.current = null; }}
          />
        )}
        {tab === 'review' && <Review boot={boot} />}
        {tab === 'week' && <Week boot={boot} reload={reload} />}
        {tab === 'sleep' && <Sleep boot={boot} reload={reload} />}
        {tab === 'settings' && <Settings boot={boot} theme={theme} setTheme={setTheme} reload={reload} />}
      </main>
    </div>
  );
}
