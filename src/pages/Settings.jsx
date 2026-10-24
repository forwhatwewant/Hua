import { useEffect, useState } from 'react';
import { dayNotice } from '../daynotice.js';

const THEMES = [
  { id: 'paper', name: '暖纸', desc: '米白底 · 衬线标题', colors: ['#f7f4ee', '#fffdf8', '#9a5b0a'] },
  { id: 'plain', name: '素白', desc: '纯白 · 克制', colors: ['#fbfbfc', '#ffffff', '#4f46e5'] },
  { id: 'teal', name: '青墨', desc: '青绿 · 延续「风」', colors: ['#f4f8f7', '#ffffff', '#0f766e'] },
  { id: 'dark', name: '夜读', desc: '深色 · 晚上写', colors: ['#15171b', '#1d2025', '#5dcaa5'] }
];

const ZOOMS = [
  { v: 100, name: '标准' },
  { v: 115, name: '大' },
  { v: 130, name: '更大' },
  { v: 150, name: '很大' }
];

export default function Settings({ boot, theme, setTheme, reload }) {
  const [dayStart, setDayStart] = useState(boot.settings.dayStartHour);
  const [zoom, setZoom] = useState(boot.settings.zoom || 100);
  /* 「现在写的算哪天」—— 一分钟对一次表，让人改完日界立刻看到效果。
     凌晨来设置页改日界时，这一行就是最直接的说明。 */
  const [notice, setNotice] = useState(() => dayNotice(new Date(), boot.settings.dayStartHour));
  useEffect(() => {
    setNotice(dayNotice(new Date(), dayStart));
    const t = setInterval(() => setNotice(dayNotice(new Date(), dayStart)), 60000);
    return () => clearInterval(t);
  }, [dayStart]);

  const pickTheme = async (id) => {
    setTheme(id);
    await window.hua.settings.set({ k: 'theme', v: id });
  };

  // 缩放存进设置，下次打开还是这个大小；主进程负责真正应用它。
  // 走 zoom:set 而不是 settings:set —— 缩放要同时作用到所有窗口，统一在主进程做。
  const pickZoom = async (v) => {
    const r = await window.hua.zoom.set({ percent: v });
    if (r && r.zoom) setZoom(r.zoom);
  };

  const nudgeZoom = (delta) => pickZoom(zoom + delta);

  // Ctrl + 滚轮 / 快捷键改了缩放，设置页上的数字要跟上
  useEffect(() => {
    window.hua.zoom.onChanged?.((v) => setZoom(v));
  }, []);

  const saveDayStart = async (v) => {
    const n = Math.max(0, Math.min(12, Number(v) || 0));
    setDayStart(n);
    await window.hua.settings.set({ k: 'dayStartHour', v: n });
    reload();
  };

  return (
    <>
      <div className="pagehead">
        <h1>设置</h1>
      </div>
      <div className="scroll">
        <div className="field">
          <label>外观</label>
          <div className="themes">
            {THEMES.map((t) => (
              <button key={t.id} className={`themecard${theme === t.id ? ' on' : ''}`} onClick={() => pickTheme(t.id)}>
                <div className="swatch">
                  {t.colors.map((c) => <i key={c} style={{ background: c }} />)}
                </div>
                <div className="tn">{t.name}</div>
                <div className="td">{t.desc}</div>
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <label>界面大小</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <button className="btn" onClick={() => nudgeZoom(-5)} title="缩小（Ctrl+-）">−</button>
            <div className="zoomsel">
              {ZOOMS.map((z) => (
                <button
                  key={z.v}
                  className={`zoomchip${zoom === z.v ? ' on' : ''}`}
                  onClick={() => pickZoom(z.v)}
                >
                  {z.name}
                </button>
              ))}
            </div>
            <button className="btn" onClick={() => nudgeZoom(5)} title="放大（Ctrl++）">+</button>
            <span className="mono" style={{ fontSize: 12.5, color: 'var(--text-2)' }}>{zoom}%</span>
          </div>
          <div className="desc">
            现在的内容是按窄栏排的，屏幕大、全屏之后字会显得小。这里整体放大——
            文字、间距、按钮一起变，比只调字号协调。
            也可以用 <span className="mono">Ctrl + 滚轮</span>、<span className="mono">Ctrl + +/−</span>，
            或 <span className="mono">Ctrl + 0</span> 回到默认。
          </div>
        </div>

        <div className="field">
          <label>一天的起点</label>
          <input
            type="number"
            min="0"
            max="12"
            value={dayStart}
            onChange={(e) => saveDayStart(e.target.value)}
          />
          <span style={{ marginLeft: 8, fontSize: 13, color: 'var(--text-2)' }}>点</span>
          <div className="desc">
            凌晨 {dayStart} 点之前写的记录，都算前一天。熬夜到一两点还在干活时，
            你心里的「今天」还没结束。
          </div>
          {/* 现在这一刻按这个日界算哪天 —— 凌晨改设置时最直观的确认 */}
          {notice && (
            <div className={`daynow ${notice.kind}`}>
              <span className="dn-dot" />
              {notice.text}
            </div>
          )}
          <div className="desc" style={{ marginTop: 8 }}>
            跨日的那段时间，应用顶部会挂一条提示，写着「现在写的算哪天」。
            设成 0 点就表示午夜一过即新的一天，不再有跨日。
          </div>
        </div>

        <div className="field">
          <label>数据位置</label>
          <div className="mono" style={{ marginBottom: 10 }}>{boot.settings.dataDir}</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn" onClick={() => window.hua.shell.openDataDir()}>打开数据目录</button>
            <button className="btn" onClick={() => window.hua.shell.openJournalFile({ date: boot.today })}>打开本周周文件</button>
          </div>
          <div className="desc">
            全部内容都在这一个目录里：<span className="mono">data.db</span> 存事项，
            <span className="mono"> journal/</span> 存心得（Markdown），<span className="mono">reports/</span> 存周报月报。
            备份就是整个目录拷走。
          </div>
        </div>

        <div className="field">
          <label>关于这份记录的边界</label>
          <div className="desc" style={{ lineHeight: 1.8 }}>
            · 数据不出本地，没有任何联网行为，也没有 AI 参与总结。<br />
            · 完成清单在次日首次打开时快照进周文件，之后不再回改——它是留档，不是镜像。<br />
            · 未完成的事项不会自动顺延，它们留在原来的日期里，今天页顶部会提示还剩多少。
          </div>
        </div>

        {/* 应用常驻托盘，关窗口不等于退出 —— 改完代码后很容易一直在看旧窗口。
            把构建时间摆在这儿，一眼就能确认跑的是不是最新版。 */}
        <div className="field">
          <label>版本</label>
          <div className="mono">构建于 {__BUILD_TIME__}</div>
        </div>
      </div>
    </>
  );
}
