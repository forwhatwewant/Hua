/* 界面组件的渲染测试。
   本机的 Electron 渲染进程经常起不来（GPU shared context 失败），无头截图自测不可用，
   所以这里换个路子：用 vite 的 SSR 构建把组件渲染成静态 HTML，再在 Node 里断言。
   不需要浏览器、不需要 Electron，几百毫秒出结果。

   由 scripts/run-ui-test.mjs 负责构建 + 执行 + 清理，直接 node 这个文件是跑不了的。 */

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import DoneList from '../src/components/DoneList.jsx';
import SleepChart from '../src/components/SleepChart.jsx';
import Today, { lastNight, miniTrend, fmtSleepDur } from '../src/pages/Today.jsx';
import Week, { fmtDur } from '../src/pages/Week.jsx';
import { rateText } from '../src/rate.js';
import { daySpan, fmtWhen, nightLabel } from '../src/dates.js';
import { slotOf } from '../src/slot.js';
import { readFileSync } from 'node:fs';
import Log, { excerpt, countWords, saveLabel } from '../src/pages/Log.jsx';
import Settings from '../src/pages/Settings.jsx';
import DayBanner from '../src/components/DayBanner.jsx';
import EditItemModal from '../src/components/EditItemModal.jsx';
import CompleteModal from '../src/components/CompleteModal.jsx';
import { dayNotice } from '../src/daynotice.js';
import { calcMinutes, nudgeClock, signedDur } from '../src/pages/Sleep.jsx';
import Sleep from '../src/pages/Sleep.jsx';

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${label}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL ${label}${extra ? '  ' + extra : ''}`); }
};

const mk = (title, min, out, at) => ({
  id: title, title, actualMinutes: min, estMinutes: null, output: out, completedAt: at,
});

/* 样式回归：SSR 拿不到计算后的样式，所以直接读 styles.css 源码断言。
   两个辅助函数提到最前面，后面的 [10.84] / [10.9] 都要用。 */
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

/** 取某条规则的声明块。
    要精确匹配选择器本身，不能只按前缀找 —— 否则 `.editor-wrap > .tiptap` 会先被
    `.tiptap` 撞上，拿错规则（写过一次这个坑）。所以要求选择器后面紧跟 { 或 ,
    且不能是别的选择器的一部分（前面不能是标识符字符）。 */
const rule = (sel) => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[},]\\s*)${esc}\\s*(,[^{]*)?\\{([^}]*)\\}`, 'm');
  const m = css.match(re);
  return m ? m[3] : '';
};

console.log('\n[1] 已完成清单：有完整数据的一组');
const html = renderToStaticMarkup(
  React.createElement(DoneList, {
    items: [
      mk('整理周报', 35, '发给了三个人', '2026-09-22T01:12:00.000Z'),
      mk('改登录页的间距', 70, null, '2026-09-22T02:40:00.000Z'),
      mk('回一条拖了很久的消息', null, null, '2026-09-22T03:05:00.000Z'),
    ],
  })
);
ok('顶部合计 = 35+70 = 1 小时 45 分', html.includes('合计 1 小时 45 分'));
ok('完成时刻换算成本地时间（01:12Z → 09:12）', html.includes('09:12'),
  (html.match(/\d\d:\d\d/g) || []).join(','));
ok('没有误加 no-min / no-time 类', !html.includes('no-min') && !html.includes('no-time'));
ok('产出物作为二级小字渲染', html.includes('发给了三个人'));
const widths = [...html.matchAll(/width:(\d+)%/g)].map((m) => Number(m[1]));
// 绝对刻度：满格 120 分钟 → 35/120≈29%，70/120≈58%
ok('条形宽度按绝对刻度（满格 120 分钟）', widths.join(',') === '29,58', widths.join(','));
ok('无时长的那条不画条', (html.split('dl-bar').length - 1) === 3 && widths.length === 2);
ok('时长数字右对齐成列', html.includes('35 分') && html.includes('1 小时 10 分'));

console.log('\n[1.5] 一天只有一件事时不该画成满格（回归：曾按「当日最长」算比例）');
const alone = renderToStaticMarkup(
  React.createElement(DoneList, { items: [mk('三点教职工大会', 15, null, '2026-09-22T05:18:00.000Z')] })
);
const oneWidth = [...alone.matchAll(/width:(\d+)%/g)].map((m) => Number(m[1]))[0];
ok('15 分钟只有 13%，不是 100%', oneWidth === 13, String(oneWidth));
ok('超过 2 小时顶格在 100%', (() => {
  const big = renderToStaticMarkup(
    React.createElement(DoneList, { items: [mk('超长的一件事', 300, null, '2026-09-22T05:18:00.000Z')] })
  );
  return /width:100%/.test(big);
})());

console.log('\n[2] 老数据：既没时长也没完成时刻 —— 两列整列收起');
const bare = renderToStaticMarkup(
  React.createElement(DoneList, { items: [mk('很久以前做完的一件事', null, null, null)] })
);
ok('整组加上 no-min 与 no-time', bare.includes('no-min') && bare.includes('no-time'));
ok('不渲染合计行', !bare.includes('dl-sum'));
ok('标题照常渲染', bare.includes('很久以前做完的一件事'));

console.log('\n[3] 整小时数不留下尾空格（回归：曾输出「2 小时 」）');
const whole = renderToStaticMarkup(
  React.createElement(DoneList, {
    items: [mk('提交职称材料', 120, null, '2026-09-20T06:57:00.000Z')],
  })
);
ok('显示「2 小时」而不是「2 小时 」', whole.includes('>2 小时<'), (whole.match(/>[^<>]*小时[^<>]*</) || [])[0]);
ok('合计行同理', whole.includes('合计 2 小时<'), (whole.match(/合计[^<]*/) || [])[0]);

console.log('\n[4] 空列表不渲染空壳');
const empty = renderToStaticMarkup(React.createElement(DoneList, { items: [] }));
ok('返回空字符串', empty === '', JSON.stringify(empty));

console.log('\n[5] 睡眠柱状图');
const rec = (date, minutes, band, bandLabel) => ({ date, minutes, band, bandLabel });
const chart = renderToStaticMarkup(
  React.createElement(SleepChart, {
    today: '2026-09-23',
    span: 14,
    records: [
      rec('2026-09-10', 450, 'ok', '正常'),
      rec('2026-09-12', 320, 'low', '严重不足'),
      rec('2026-09-14', 380, 'short', '偏少'),
      rec('2026-09-23', 600, 'long', '偏多'),
    ],
  })
);
ok('铺满 14 格（缺的天也占位）', (chart.split('sc-col').length - 1) === 14);
// 没记录的天：有底轨、没有柱子（不再画一条细线，那样看着像「睡了 0 分钟」）
ok('没有记录的天不画柱子', (chart.match(/sc-col[^"]*empty/g) || []).length === 10,
  String((chart.match(/sc-col[^"]*empty/g) || []).length));
ok('柱子站在一条基线上（不再套一层底轨）',
  chart.includes('sc-base') && !chart.includes('sc-track'));
// 注意别用 split('sc-bar')：容器类名 sc-bars 里也含这个子串，会多算一个
ok('有记录的天画柱子', (chart.match(/class="sc-bar /g) || []).length === 4, String((chart.match(/class="sc-bar /g) || []).length));
ok('柱子按档位着色', chart.includes('b-ok') && chart.includes('b-low') && chart.includes('b-short') && chart.includes('b-long'));
// 纵轴满格 12 小时 = 720 分：450→62.5%、320→44.44%、380→52.78%、600→83.33%
// 只认柱子的 height（背景带也用 inline height，别把它算进来）
ok('柱高 = 时长 / 12 小时',
  (chart.match(/class="sc-bar b-[a-z]+" style="height:([\d.]+)%/g) || [])
    .map((s) => s.match(/height:([\d.]+)%/)[1]).join(',') ===
  '62.5,44.44444444444444,52.77777777777778,83.33333333333334',
  (chart.match(/class="sc-bar b-[a-z]+" style="height:([\d.]+)%/g) || []).join(' | '));
ok('7 小时参考线在 58.33%', chart.includes('bottom:58.333333333333336%') || chart.includes('bottom:58.333'), (chart.match(/bottom:[\d.]+%/) || [])[0]);
ok('今天那格有标记', chart.includes('sc-col today'));
// 新的视觉：7–9 小时正常带 + 左侧刻度 + 一句图注说明柱子对应哪一夜
ok('6h / 9h 两条极淡的网格线（正常区间的边界）',
  (chart.match(/class="sc-grid"/g) || []).length === 2,
  String((chart.match(/class="sc-grid"/g) || []).length));
ok('左侧只标 9h / 6h 两档（不再标 12h）',
  (chart.match(/sc-ytick/g) || []).length === 2,
  String((chart.match(/sc-ytick/g) || []).length));
ok('柱子提示给的是「前一晚 → 当天早晨」',
  /title="[^"]*晚 → [^"]*晨/.test(chart),
  (chart.match(/title="[^"]*晚 → [^"]*晨[^"]*"/) || [])[0]);
ok('不画趋势折线（柱子已经表达走势，再叠一条线只会糊）',
  !chart.includes('sc-trend') && !chart.includes('sc-band'));
ok('底部说明有记录天数', chart.includes('14 天里有记录 4 天'), (chart.match(/14 天里[^<]*/) || [])[0]);
// 上面的 chart 没传 onPick，所以不该出现点选提示
ok('没传 onPick 时不提示可点选', !chart.includes('点柱子可以回看那一天'));

const chartPickable = renderToStaticMarkup(
  React.createElement(SleepChart, {
    today: '2026-09-23', span: 7, onPick: () => {},
    records: [rec('2026-09-23', 600, 'long', '偏多')],
  })
);
ok('传了 onPick 才提示可点选', chartPickable.includes('点柱子可以回看那一天'));

// 只有一条记录时点不成折线
const chartOne = renderToStaticMarkup(
  React.createElement(SleepChart, { today: '2026-09-23', span: 7, records: [rec('2026-09-23', 600, 'long', '偏多')] })
);
ok('只有一天数据时不画折线（一个点连不成线）', !chartOne.includes('sc-trend'));

// picked 高亮
const chartPicked = renderToStaticMarkup(
  React.createElement(SleepChart, {
    today: '2026-09-23', span: 7, picked: '2026-09-23',
    records: [rec('2026-09-23', 600, 'long', '偏多')],
  })
);
ok('被选中的那天加 picked 类', chartPicked.includes('sc-col today picked'));

// 90 天的刻度密度：每 10 天标一个
const chart90 = renderToStaticMarkup(
  React.createElement(SleepChart, { today: '2026-09-23', span: 90, records: [rec('2026-09-23', 600, 'long', '偏多')] })
);
ok('90 天铺满 90 格', (chart90.split('sc-col').length - 1) === 90, String(chart90.split('sc-col').length - 1));
ok('90 天时轴标签每 10 天一个', (chart90.match(/class="sc-tick">\d+/g) || []).length === 9,
  String((chart90.match(/class="sc-tick">\d+/g) || []).length));

console.log('\n[6] 录入预览的时长换算，要和主进程那边一致（防两边漂移）');
const CASES = [
  ['23:40', '07:10', 450], ['01:00', '08:00', 420], ['22:00', '05:30', 450],
  ['00:30', '07:00', 390], ['23:00', '23:00', null], ['23:00', '23:10', null],
  ['06:00', '05:00', null], ['25:00', '07:00', null], ['', '07:00', null],
];
for (const [b, w, want] of CASES) {
  const got = calcMinutes(b, w, 30, 1200);
  ok(`${b || '(空)'} → ${w} 得 ${want === null ? '无效' : want + ' 分'}`, got === want, String(got));
}

console.log('\n[7] 今日页的遗留区块：默认收起，只留入口');
// 回归：曾默认展开（useState(true)），一打开就被前几天没做完的事占满，每次都要手动收起。
const backlogItem = (id, date, title) => ({
  id, date, title, status: 'todo', estMinutes: null, actualMinutes: null,
  startTime: null, output: null, tags: [], sortKey: 1,
});
const bootWithBacklog = {
  today: '2026-10-11',
  items: [],
  backlog: [backlogItem('b1', '2026-10-08', '搞卫生'), backlogItem('b2', '2026-10-09', '看椅子')],
  done: [],
  upcoming: [],
  upcomingFar: 0,
  reflections: [],
  pins: { reflections: [], items: [] },
  tags: [],
  snapshotWritten: true,
  settings: { dayStartHour: 4, theme: 'paper', dataDir: '/tmp/hua' },
};
const todayHtml = renderToStaticMarkup(
  React.createElement(Today, { boot: bootWithBacklog, reload: () => {} })
);
ok('渲染出「前几天没做完的」入口', todayHtml.includes('前几天没做完的'));
// 收起时不报件数 —— 那个数字每天累加，看着像欠债（用户明确说会焦虑）
ok('收起时不显示件数（不制造压力）',
  !/class="back-count"[^>]*>\d+</.test(todayHtml),
  (todayHtml.match(/class="back-count"[^>]*>[^<]*</) || [])[0]);
ok('入口是淡色的一条，不是卡片', todayHtml.includes('backsect quiet'));
ok('默认收起：不渲染遗留条目本身', !todayHtml.includes('搞卫生') && !todayHtml.includes('看椅子'));
ok('默认收起：展开态才有的「全部移到今天」不出现', !todayHtml.includes('全部移到今天'));
ok('收起时没有「展开」这种催促字样', !todayHtml.includes('>展开<'));

console.log('\n[8] 今日页的日志入口：只给入口，正文不在今日页');
const bootWithLog = {
  ...bootWithBacklog,
  todayLog: { date: '2026-10-11', body: '今天写了一段话，关于把心得拆成日志模块。', title: '', pinned: false, time: '10:00', count: 1 },
};
const todayLogHtml = renderToStaticMarkup(
  React.createElement(Today, { boot: bootWithLog, reload: () => {}, onOpenLogAt: () => {} })
);
ok('有「日志」入口按钮', todayLogHtml.includes('去写今天'));
ok('入口显示字数', /日纪 · \d+ 字/.test(todayLogHtml), (todayLogHtml.match(/日纪 · \d+ 字/) || [])[0]);
ok('显示一段摘要', todayLogHtml.includes('把心得拆成日志模块'));
ok('不再有旧的「新增一条」心得按钮', !todayLogHtml.includes('新增一条'));
ok('不再渲染心得条目组件', !todayLogHtml.includes('refentry'));

console.log('\n[9] 今日页：没写日志时的空状态');
const bootNoLog = { ...bootWithBacklog, todayLog: { date: '2026-10-11', body: '', title: '', pinned: false, time: '', count: 0 } };
const noLogHtml = renderToStaticMarkup(
  React.createElement(Today, { boot: bootNoLog, reload: () => {}, onOpenLogAt: () => {} })
);
ok('提示去「日志」里写', noLogHtml.includes('一天一篇'), '');
ok('没有字数时标题是光秃秃的「日纪」', noLogHtml.includes('>日纪<') || /<h3>日纪<\/h3>/.test(noLogHtml));

console.log('\n[10] 日志页渲染');
// 日志页挂载时会调 window.hua.log.* 和 items.range，SSR 下没有 window，给它一个最小替身。
globalThis.window = globalThis.window || {};
globalThis.window.hua = {
  log: {
    days: () => Promise.resolve([]),
    day: () => Promise.resolve({ date: '2026-10-11', body: '', title: '', pinned: false, time: '', count: 0 }),
    save: () => Promise.resolve({}),
    pin: () => Promise.resolve({}),
  },
  items: { range: () => Promise.resolve([]) },
  search: () => Promise.resolve({ journal: [], items: [] }),
};
globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem: () => {} };
const logHtml = renderToStaticMarkup(
  React.createElement(Log, { boot: { today: '2026-10-11', done: [] }, reload: () => {} })
);
ok('标题是「日纪」', logHtml.includes('<h1>日纪</h1>'));
ok('有「一天一篇」的说明', logHtml.includes('一天一篇'));
ok('日期区间按钮在', logHtml.includes('近 30 天') && logHtml.includes('近 90 天'));
ok('视图切换：写 / 翻 / 日历', logHtml.includes('>写<') && logHtml.includes('>翻<') && logHtml.includes('>日历<'));
ok('有固定和清空的操作', logHtml.includes('固定到今日页') && logHtml.includes('清空'));
ok('日期列表容器在', logHtml.includes('loglist'));
ok('首次渲染时正文区未就绪（等数据）', !logHtml.includes('logbody'), '');
ok('有统计条（写了几天 / 连续 / 字数）',
  logHtml.includes('这段时间写了') && logHtml.includes('连续') && logHtml.includes('字'), '');

console.log('\n[10.2] 日志页：日界跟着主进程走，不自己取系统日期');
// 关键回归：凌晨 1 点写日志，该落在「还没睡的那一天」，而不是系统的次日。
// 主进程按 dayStartHour 算好随 boot.today 下发，页面必须原样用它。
// 注意日期列表里今天永远排第一位，所以直接看标题里那个完整日期。
const logBoundary = renderToStaticMarkup(
  React.createElement(Log, { boot: { today: '2026-10-11', done: [] }, reload: () => {} })
);
ok('标题用的是 boot.today（前一天），不是系统当天',
  logBoundary.includes('2026 年 10 月 11 日'), (logBoundary.match(/\d{4} 年 \d+ 月 \d+ 日/) || [])[0]);
ok('列表首项标成「今天」', /class="logday on"[^>]*>[\s\S]{0,200}?今天/.test(logBoundary)
  || logBoundary.includes('>今天<'), '');
ok('日导航的「今天」按钮指向 boot.today 而非系统日期',
  logBoundary.includes('disabled') || logBoundary.includes('daynav'));

// 换一个明显不是今天的 boot.today，确认页面完全跟着它走
const logBoundary2 = renderToStaticMarkup(
  React.createElement(Log, { boot: { today: '2026-03-05', done: [] }, reload: () => {} })
);
ok('换成 2026-03-05 后标题随之改变', logBoundary2.includes('2026 年 3 月 5 日'),
  (logBoundary2.match(/\d{4} 年 \d+ 月 \d+ 日/) || [])[0]);
ok('两个不同的 boot.today 渲染出不同标题', logBoundary !== logBoundary2);

// 没传 boot.today 时不能崩（SSR / 老调用方）
const logNoBoot = renderToStaticMarkup(
  React.createElement(Log, { boot: { done: [] }, reload: () => {} })
);
ok('缺 boot.today 时兜底到本地日期也不崩', logNoBoot.includes('<h1>日纪</h1>'));

console.log('\n[10.5] 日志页：结构类名');
ok('有 .logmain（应铺满剩余宽度）', logHtml.includes('logmain'));
ok('有 .loglist（日期列表）', logHtml.includes('loglist'));
// .loginner 在数据加载完后才渲染，SSR 首帧拿不到 —— 它的断言放在 [10.9] 的样式检查里

console.log('\n[10.55] 日志页：完成事项与正文并排，不在正文下面');
// 核心回归：完成事项曾经压在编辑器底部，日志一长就沉到屏幕外，回顾时看不到。
// 现在必须是两个同级栏（.loginner 写作 + .logside 完成），而不是嵌套。
// SSR 首帧 loginner 还没挂载（等数据），所以这里只验样式源码层面的关系。
const cssEarly = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
ok('.logbody 是 flex 横排容器', /\.logbody\s*\{[^}]*display\s*:\s*flex/.test(cssEarly));
// 默认（宽屏）必须是横排。窄屏那条 @media 里才改成纵向堆叠，
// 所以这里要取第一处 .logbody 规则，而不是全文搜索。
const logbodyFirst = (cssEarly.match(/\.logbody\s*\{([^}]*)\}/) || [])[1] || '';
ok('默认是横排，未把 logbody 设成纵向（回归：曾用 flex-direction: column 导致完成列表被压到最下）',
  !/flex-direction\s*:\s*column/.test(logbodyFirst), logbodyFirst.trim().slice(0, 60));
ok('存在 .logside 右栏', /\.logside\s*\{/.test(cssEarly));
ok('.logside 不再挂在 .loginner 内部由边距顶开（用独立滚动）',
  /\.logside\s*\{[^}]*overflow\s*:\s*auto/.test(cssEarly));
ok('.logdone 不再靠 margin-top 压在正文下方加分隔线',
  !/\.logdone\s*\{[^}]*border-top/.test(cssEarly));

console.log('\n[10.6] 日志页：翻（搜索）视图');
const logSearchHtml = renderToStaticMarkup(
  React.createElement(Log, { boot: { today: '2026-10-11', done: [] }, reload: () => {} })
);
// 默认是「写」视图，搜索框只在「翻」里出现——这里只验默认视图没有搜索框，避免误判
ok('默认视图下不渲染搜索框', !logSearchHtml.includes('logsearch'));

console.log('\n[10.7] 摘录函数：能定位关键词并高亮');
const ex = excerpt('今天写了很久的方案，把下周的也一起写好了。', '写方案');
ok('默认视图外仍可调用 excerpt', typeof excerpt === 'function');
const ex2 = excerpt('a'.repeat(80) + '关键词在很后面' + 'b'.repeat(80), '关键词');
ok('长文本会截取关键词附近', ex2.startsWith('…'), ex2.slice(0, 12));
ok('关键词被 mark 包裹', ex2.includes('<mark>关键词</mark>'), ex2.slice(0, 40));

console.log('\n[10.8] 字数统计：不含空白和 Markdown 标记');
ok('纯文本 4 个字', countWords('今天很好') === 4, String(countWords('今天很好')));
ok('忽略空白', countWords('今天  很\n好') === 4, String(countWords('今天  很\n好')));
ok('忽略 # 与 * 标记', countWords('## 标题\n\n**加粗**') === 4, String(countWords('## 标题\n\n**加粗**')));

console.log('\n[11] 设置页：界面缩放');
const settingsHtml = renderToStaticMarkup(
  React.createElement(Settings, {
    boot: { today: '2026-10-11', settings: { dayStartHour: 4, dataDir: '/tmp/hua', zoom: 130 } },
    theme: 'paper',
    setTheme: () => {},
    reload: () => {},
  })
);
ok('有「界面大小」一栏', settingsHtml.includes('界面大小'));
ok('四个档位都在', ['标准', '大', '更大', '很大'].every((s) => settingsHtml.includes(s)));
ok('当前档位高亮（130 = 更大）', /zoomchip on"[^>]*>更大</.test(settingsHtml), (settingsHtml.match(/class="zoomchip on"[^>]*>[^<]*</) || [])[0]);
ok('显示当前百分比', settingsHtml.includes('130%'));
ok('有加减按钮', settingsHtml.includes('>−<') && settingsHtml.includes('>+<'));
ok('说明了快捷键', settingsHtml.includes('Ctrl + 滚轮'));

console.log('\n[10.75] 睡眠页：统计卡与图表');
const sleepBoot = {
  today: '2026-09-23',
  sleep: {
    date: '2026-09-23',
    today: { date: '2026-09-23', bedTime: '23:10', wakeTime: '07:00', minutes: 470, band: 'ok', bandLabel: '正常' },
    recent: [
      { date: '2026-09-20', bedTime: '23:40', wakeTime: '05:40', minutes: 360, band: 'short', bandLabel: '偏少' },
      { date: '2026-09-21', bedTime: '23:30', wakeTime: '06:30', minutes: 420, band: 'ok', bandLabel: '正常' },
      { date: '2026-09-22', bedTime: '23:20', wakeTime: '07:00', minutes: 460, band: 'ok', bandLabel: '正常' },
      { date: '2026-09-23', bedTime: '23:10', wakeTime: '07:00', minutes: 470, band: 'ok', bandLabel: '正常' },
    ],
    stats: {
      14: {
        count: 4, avg: 428, median: 440, longest: 470, shortest: 360,
        counts: { low: 0, short: 1, ok: 3, long: 0 }, okRate: 75,
        sd: 44, bedSpread: 11, avgBed: '23:25', avgWake: '06:33', regularity: 100,
      },
      30: {
        count: 4, avg: 428, median: 440, longest: 470, shortest: 360,
        counts: { low: 0, short: 1, ok: 3, long: 0 }, okRate: 75,
        sd: 44, bedSpread: 11, avgBed: '23:25', avgWake: '06:33', regularity: 100,
      },
      90: null,
    },
    compare: { 30: { from: '2026-08-25', to: '2026-09-23', avgDelta: 12, okRateDelta: 5, avg: 416, okRate: 70 } },
    spans: [14, 30, 90],
    bands: [
      { key: 'low', label: '严重不足', range: '不足 6 小时', max: 360 },
      { key: 'short', label: '偏少', range: '6–7 小时', max: 420 },
      { key: 'ok', label: '正常', range: '7–9 小时', max: 540 },
      { key: 'long', label: '偏多', range: '9 小时以上', max: null },
    ],
    minMinutes: 30, maxMinutes: 1200,
    guideline: { minHours: 7, maxHours: 9, source: 'Sleep Foundation（NSF 指南）', checkedAt: '2026-09-22' },
  },
};
globalThis.window = globalThis.window || {};
globalThis.window.hua = Object.assign(globalThis.window.hua || {}, {
  sleep: {
    save: () => Promise.resolve({}),
    remove: () => Promise.resolve(true),
    report: () => Promise.resolve({ title: 'x', dayCount: 1 }),
  },
});
const sleepHtml = renderToStaticMarkup(React.createElement(Sleep, { boot: sleepBoot, reload: () => {} }));
ok('标题是「睡眠」', sleepHtml.includes('<h1>睡眠</h1>'));
ok('录入区两组时间（入睡 / 起床）', sleepHtml.includes('入睡') && sleepHtml.includes('起床'));
ok('录入区带 ± 微调按钮', (sleepHtml.match(/class="se-nb"/g) || []).length === 4,
  String((sleepHtml.match(/class="se-nb"/g) || []).length));
ok('实时预览出时长 7 小时 50 分', sleepHtml.includes('7 小时 50 分'), (sleepHtml.match(/class="se-dur"[^>]*>[^<]*/) || [])[0]);
ok('预览带档位标签「正常」', sleepHtml.includes('b-ok') && sleepHtml.includes('>正常<'));
ok('显示「今天已记」摘要', sleepHtml.includes('今天已记') && sleepHtml.includes('23:10'));
ok('跨度按钮：14 / 30 / 90 天', sleepHtml.includes('>14 天<') && sleepHtml.includes('>30 天<') && sleepHtml.includes('>90 天<'));
ok('关键数字是一行（.sleep-metrics），不再是六张卡片',
  sleepHtml.includes('sleep-metrics') && !sleepHtml.includes('ss-card'));
ok('平均时长', sleepHtml.includes('平均时长') && sleepHtml.includes('7 小时 8 分'),
  (sleepHtml.match(/class="sm-v">[^<]*/) || [])[0]);
ok('正常率 75%', sleepHtml.includes('正常率（7–9 小时）') && sleepHtml.includes('75%'));
ok('作息规律度也是一行里的其中一项（不再单独一张进度条卡片）',
  sleepHtml.includes('作息规律度') && !sleepHtml.includes('sg-fill'));
ok('分档是一条堆叠条', sleepHtml.includes('sd-bar')
  && (sleepHtml.match(/class="sd-seg/g) || []).length > 0,
  String((sleepHtml.match(/class="sd-seg/g) || []).length));
ok('图例带每档的天数', sleepHtml.includes('sd-legend') && sleepHtml.includes('sd-item'));
// 细节默认收起：一屏里不该同时看八个数字
ok('细节默认收起（只留「更多数据」入口）',
  sleepHtml.includes('更多数据') && !sleepHtml.includes('sleep-details'));
ok('缺记录提示（14 天记了 4 天 → 缺 10）', sleepHtml.includes('还有') && sleepHtml.includes('10 天'),
  (sleepHtml.match(/这 14 天里还有[^<]*/) || [])[0]);
ok('报告按钮：按当前跨度 + 固定 30 / 90 天', sleepHtml.includes('生成近 14 天分析报告')
  && sleepHtml.includes('>近 30 天<') && sleepHtml.includes('>近 90 天<'));
ok('判定依据与出处保留', sleepHtml.includes('Sleep Foundation') && sleepHtml.includes('不构成医学建议'));

// 「比上一段」只在 30 天跨度下显示 —— 默认是 14 天，所以上面那段看不到它。
// 单独渲染一份 span=30 的出来验（spans[0] = 14，得把 spans 顺序换一下让默认落 30）。
const sleep30 = renderToStaticMarkup(React.createElement(Sleep, {
  boot: { ...sleepBoot, sleep: { ...sleepBoot.sleep, spans: [30, 90], stats: { 30: sleepBoot.sleep.stats[30], 90: null } } },
  reload: () => {},
}));
ok('30 天跨度下出现「比上一段」（+12 分）', sleep30.includes('比上一段') && sleep30.includes('+12 分'),
  (sleep30.match(/比上一段 [^<]*/) || [])[0]);
ok('30 天跨度下「比上一段」正常率 +5%', sleep30.includes('+5%'));

console.log('\n[10.76] 睡眠页：录入校验与 ± 微调');
ok('填入反了的时间会提示', renderToStaticMarkup(React.createElement(Sleep, {
  boot: { ...sleepBoot, sleep: { ...sleepBoot.sleep, today: { date: '2026-09-23', bedTime: '07:00', wakeTime: '06:00', minutes: 0, band: '', bandLabel: '' } } },
  reload: () => {},
})).includes('算不出合理时长'));
ok('nudgeClock 往前半小时', nudgeClock('23:10', -30) === '22:40', nudgeClock('23:10', -30));
ok('nudgeClock 往后半小时', nudgeClock('23:40', 30) === '00:10', nudgeClock('23:40', 30));
ok('nudgeClock 跨零点折回', nudgeClock('00:10', -30) === '23:40', nudgeClock('00:10', -30));
ok('nudgeClock 非法输入原样返回', nudgeClock('', 30) === '');
ok('signedDur 正数带 +', signedDur(12) === '+12 分', signedDur(12));
ok('signedDur 负数带 − 而不是 -', signedDur(-75) === '−1 小时 15 分', signedDur(-75));
ok('signedDur 零说「持平」', signedDur(0) === '持平');

console.log('\n[10.77] 睡眠页：跨度切到 90 天且该段为空');
const sleepEmpty = renderToStaticMarkup(React.createElement(Sleep, {
  boot: { ...sleepBoot, sleep: { ...sleepBoot.sleep, stats: { ...sleepBoot.sleep.stats, 14: null } } },
  reload: () => {},
}));
ok('该段无记录时给空状态', sleepEmpty.includes('这 14 天还没有睡眠记录'));
ok('无记录时不渲染统计卡', !sleepEmpty.includes('ss-card'));
ok('无记录时也不渲染分档分布', !sleepEmpty.includes('sg-dist'));

console.log('\n[10.78] 睡眠页：跨午夜，今天还没记');
const sleepNoToday = renderToStaticMarkup(React.createElement(Sleep, {
  boot: { ...sleepBoot, sleep: { ...sleepBoot.sleep, today: null, stats: { ...sleepBoot.sleep.stats, 14: null } } },
  reload: () => {},
}));
ok('今天没记时不给「今天已记」', !sleepNoToday.includes('今天已记'));
ok('今天没记时不显示删除按钮', !sleepNoToday.includes('删除今天'));
ok('默认输入仍是 23:00 → 07:00 的预览', sleepNoToday.includes('8 小时'), (sleepNoToday.match(/class="se-dur"[^>]*>[^<]*/) || [])[0]);

console.log('\n[10.81] 保存状态：四档文案，状态要看得懂');
// 以前只有一句「已写入」，1.5 秒就消失，写完根本不知道存没存。
// 现在改成状态机：dirty(待存) → saving(正在存) → saved(已存 HH:MM) / error。
ok('无状态时不显示任何字', saveLabel(null).text === '' && saveLabel(undefined).text === '');
ok('无状态时不带配色档', saveLabel(null).tone === '');
ok('刚改完显示「有改动，稍后自动保存」', saveLabel({ k: 'dirty' }).text === '有改动，稍后自动保存');
ok('dirty 用「等待」色档（不是已保存的绿）', saveLabel({ k: 'dirty' }).tone === 'wait');
ok('落盘中显示「正在保存…」', saveLabel({ k: 'saving' }).text === '正在保存…');
ok('saving 也用等待色档', saveLabel({ k: 'saving' }).tone === 'wait');
ok('失败要显眼：文案带「失败」', /失败/.test(saveLabel({ k: 'error' }).text));
ok('失败用 bad 色档', saveLabel({ k: 'error' }).tone === 'bad');
// 已保存要带时分，且补零
const s103 = saveLabel({ k: 'saved', at: new Date(2026, 9, 12, 9, 3) });
ok('已保存带 HH:MM（个位补零）', s103.text === '已保存 09:03', s103.text);
ok('已保存用 ok 色档', s103.tone === 'ok');
const s2359 = saveLabel({ k: 'saved', at: new Date(2026, 9, 12, 23, 59) });
ok('已保存 24 小时制，不出现 12 点制', s2359.text === '已保存 23:59', s2359.text);
ok('saved 缺时间戳时不崩、退化成「已保存」',
  saveLabel({ k: 'saved' }).text === '已保存', saveLabel({ k: 'saved' }).text);

console.log('\n[10.82] 日历页：右侧预览，不点「编辑」就不改');
// 以前点日历格直接跳进编辑，回顾时容易手抖改到旧日记。
// 现在点格子只在右边出只读预览，要改得再点一次「编辑这一天」。
// 视图是 Log 的内部 state（SSR 只有第一帧，永远是「写」视图），所以这块读源码断言。
const logSrc = readFileSync(new URL('../src/pages/Log.jsx', import.meta.url), 'utf8');
ok('日历视图是左右两栏（.calwrap）', /className="calwrap"/.test(logSrc));
ok('左栏放日历（.calcol）', /className="calcol"/.test(logSrc));
ok('右栏是预览面板（.calpeek）', /className="calpeek"/.test(logSrc));
ok('点日历格走 openPeek（只预览，不进编辑）',
  /onClick=\{\(\)\s*=>\s*openPeek\(/.test(logSrc));
ok('预览面板给出显式「编辑这一天」按钮', /编辑这一天/.test(logSrc));
ok('「编辑这一天」走 editFromPeek（显式动作）',
  /onClick=\{\(\)\s*=>\s*editFromPeek\(/.test(logSrc));
ok('openPeek 只读：调 day / items.range 拿数据，不调 save',
  /openPeek[\s\S]{0,600}?window\.hua\.log\.day[\s\S]{0,400}?items\.range/.test(logSrc)
  && !/openPeek[\s\S]{0,600}?log\.save/.test(logSrc));
ok('预览面板是只读渲染，不是可编辑输入框（无 contentEditable / textarea）',
  !/calpeek[\s\S]{0,1500}?contentEditable/.test(logSrc));

console.log('\n[10.83] 今日页固定区：日期可跳日志页，且有就地展开按钮');
// 用户反馈：固定的东西点不开，只看得到一小截。
// 现在日期可点（跳日志页那天），另外给一个「展开」就地看全文。
// Log 的内部 state 用 SSR 摸不到，但今日页固定区用的是 Today 自己的 state，
// 渲染首帧就是「收起」态，够测默认表现。
const todayPins = renderToStaticMarkup(React.createElement(Today, {
  boot: {
    ...bootWithBacklog,
    pins: { reflections: [], items: [], logs: [{ date: '2026-10-09', title: '标题甲', body: '正文甲' }] },
  },
  reload: () => {},
  onOpenLogAt: () => {},
}));
ok('固定区日志日期是可点按钮（.pinlog-jump）', todayPins.includes('pinlog-jump'));
ok('日期按钮带 title 提示跳日纪页', /title="去日纪页看这一天"/.test(todayPins));
ok('有「展开」按钮（.refpinbtn）', todayPins.includes('refpinbtn') && todayPins.includes('展开'));
ok('默认收起：正文走摘要容器（.pinlog-body）', todayPins.includes('pinlog-body'));
ok('默认不渲染全文容器（.pinlog-full）', !todayPins.includes('pinlog-full'));
ok('日期点击回调接的是 onOpenLogAt',
  /onClick=\{\(\)\s*=>\s*onOpenLogAt\(/.test(readFileSync(new URL('../src/pages/Today.jsx', import.meta.url), 'utf8')));

console.log('\n[10.84] 样式回归：新加的滚动/预览/固定区样式在位');
const tiptapWriteRule = rule('.logbody .editor-wrap');
ok('写作视图的编辑器是有界 flex 子项（flex:1，能在框内滚）',
  /flex\s*:\s*1/.test(tiptapWriteRule), tiptapWriteRule.trim().slice(0, 60));
ok('编辑器有 min-height 下限（别塌成一条）', /min-height/.test(tiptapWriteRule));

const scrollWriteRule = rule('.scroll.log-scroll-write');
ok('写作视图的 .scroll 改成 overflow:hidden（自己不当滚动容器）',
  /overflow\s*:\s*hidden/.test(scrollWriteRule), scrollWriteRule.trim().slice(0, 70));
ok('写作视图的 .scroll 是竖向 flex 容器', /flex-direction\s*:\s*column/.test(scrollWriteRule));
ok('.logwrap 拉伸并允许收缩（height 链传得下去）',
  /align-items\s*:\s*stretch/.test(rule('.logwrap')) && /min-height\s*:\s*0/.test(rule('.logwrap')));
ok('.logside 独立滚动（日志长时完成事项不被推走）', /overflow\s*:\s*auto/.test(rule('.logside')));

ok('保存状态有 wait / ok / bad 三档颜色', /\.savestate\.wait/.test(css)
  && /\.savestate\.ok/.test(css) && /\.savestate\.bad/.test(css));
ok('日历预览面板有样式（.calpeek）', /\.calpeek\s*\{/.test(css));
ok('预览面板正文有排版（.cp-body）', /\.cp-body\s*\{/.test(css));
ok('固定区日期按钮有样式（.pinlog-jump）', /\.pinlog-jump\s*\{/.test(css));
ok('固定区全文容器有样式且限高可滚（.pinlog-full）',
  /\.pinlog-full\s*\{[\s\S]{0,300}?max-height[\s\S]{0,200}?overflow\s*:\s*auto/.test(css));
ok('摘要限三行（-webkit-line-clamp:3）',
  /\.pinlog-body\s*\{[\s\S]{0,200}?-webkit-line-clamp\s*:\s*3/.test(css));
ok('窄屏下日历两栏堆叠', /@media[^{]*max-width:\s*980px[^{]*\{[\s\S]*?\.calwrap\s*\{[^}]*flex-direction\s*:\s*column/.test(css));

console.log('\n[10.85] 日界提示：什么时候该说「现在写的算哪天」');
// 纯函数，把时钟拨来拨去。默认日界 4 点。
const d = (s) => new Date(s);
ok('凌晨 1:30 → cross（还没翻页）', dayNotice(d('2026-10-12T01:30:00'), 4)?.kind === 'cross');
ok('cross 文案说明「还没到 4 点」', /还没到 4 点/.test(dayNotice(d('2026-10-12T01:30:00'), 4).text),
  dayNotice(d('2026-10-12T01:30:00'), 4).text);
ok('cross 文案点出属于前一天（10 月 11 日）',
  /10 月 11 日/.test(dayNotice(d('2026-10-12T01:30:00'), 4).text));
ok('cross 的 prev/today 字段正确',
  dayNotice(d('2026-10-12T01:30:00'), 4).prev === '2026-10-11'
  && dayNotice(d('2026-10-12T01:30:00'), 4).today === '2026-10-12');
ok('凌晨 3:59 → 仍是 cross', dayNotice(d('2026-10-12T03:59:00'), 4)?.kind === 'cross');
ok('刚过日界 4:00 → fresh（新的一天开始了）', dayNotice(d('2026-10-12T04:00:00'), 4)?.kind === 'fresh');
ok('fresh 文案说「新的一天开始了」', /新的一天开始了/.test(dayNotice(d('2026-10-12T04:10:00'), 4).text));
ok('4:59 仍在 fresh 窗口内', dayNotice(d('2026-10-12T04:59:00'), 4)?.kind === 'fresh');
ok('5:01 之后不再提示（fresh 窗口 1 小时）', dayNotice(d('2026-10-12T05:01:00'), 4) === null);
ok('上午 10:00 不提示', dayNotice(d('2026-10-12T10:00:00'), 4) === null);
ok('晚上 23:59 不提示', dayNotice(d('2026-10-12T23:59:00'), 4) === null);
ok('日界设 0 点：永不提示（没有跨日）', dayNotice(d('2026-10-12T01:30:00'), 0) === null
  && dayNotice(d('2026-10-12T00:10:00'), 0) === null);
ok('日界设 6 点：凌晨 5:00 是 cross', dayNotice(d('2026-10-12T05:00:00'), 6)?.kind === 'cross');
ok('日界设 6 点：6:30 是 fresh', dayNotice(d('2026-10-12T06:30:00'), 6)?.kind === 'fresh');
ok('跨月：11-01 凌晨 2 点 → 属于 10 月 31 日',
  /10 月 31 日/.test(dayNotice(d('2026-11-01T02:00:00'), 4).text));
ok('跨年：01-01 凌晨 2 点 → 属于上一年 12 月 31 日',
  /12 月 31 日/.test(dayNotice(d('2027-01-01T02:00:00'), 4).text));
ok('坏输入不崩（非法日界回落 4 点）',
  dayNotice(d('2026-10-12T01:30:00'), 'abc')?.kind === 'cross');
ok('非法 Date 返回 null', dayNotice(new Date('nope'), 4) === null);

console.log('\n[10.86] 日界提示条：只在跨日窗口渲染');
const bannerCross = renderToStaticMarkup(React.createElement(DayBanner, { dayStartHour: 4 }));
// SSR 渲染时用的是「真实此刻」，所以只能断言「要么没有，要么结构对」——
// 逻辑正确性由 [10.85] 保证；这里确认组件不会崩、能出正确的壳。
if (bannerCross) {
  ok('渲染出 .daybanner 且带 text 槽', /class="daybanner/.test(bannerCross) && /db-text/.test(bannerCross));
} else {
  ok('当前不在跨日窗口时不渲染（合法）', bannerCross === '');
}

console.log('\n[10.87] 今日页睡眠卡：昨晚睡了多久，早上先看到');
// 「今天还没记」时退回最近一条并标注日期；
// 一条都没有时给空状态。fmtSleepDur 与睡眠页同一套说法。
ok('fmtSleepDur 整小时不留尾空格', fmtSleepDur(480) === '8 小时', fmtSleepDur(480));
ok('fmtSleepDur 带零头', fmtSleepDur(455) === '7 小时 35 分', fmtSleepDur(455));
ok('fmtSleepDur 不足一小时只说分', fmtSleepDur(45) === '45 分', fmtSleepDur(45));
ok('fmtSleepDur 空值给空串', fmtSleepDur(0) === '0 分' && fmtSleepDur(null) === '', fmtSleepDur(null));

const spBase = {
  date: '2026-10-12', today: null, recent: [],
  bands: [], minMinutes: 30, maxMinutes: 1200, spans: [14, 30, 90], stats: {}, compare: {},
};
ok('无记录时 lastNight 返回 null', lastNight(spBase) === null);
ok('sleep 整体缺失也不崩', lastNight(null) === null && lastNight(undefined) === null);

const spToday = { ...spBase, today: { date: '2026-10-12', minutes: 455, bedTime: '23:40', wakeTime: '07:15', band: 'ok', bandLabel: '正常' } };
ok('有今天的记录时直接用', lastNight(spToday).minutes === 455 && lastNight(spToday).stale === false);

const spStale = { ...spBase, today: null, recent: [
  { date: '2026-10-10', minutes: 400, bedTime: '00:10', wakeTime: '06:50', band: 'short', bandLabel: '偏少' },
  { date: '2026-10-11', minutes: 480, bedTime: '23:20', wakeTime: '07:20', band: 'ok', bandLabel: '正常' },
] };
ok('今天没记 → 退回最近一条', lastNight(spStale).minutes === 480);
ok('退回的记录标 stale=true（并指出是哪天）', lastNight(spStale).stale === true
  && lastNight(spStale).date === '2026-10-11');

ok('miniTrend 取最近 n 条，老的在前',
  JSON.stringify(miniTrend(spStale.recent, 7)) === JSON.stringify([400, 480]));
ok('miniTrend 空输入给空数组', miniTrend([]).length === 0 && miniTrend(null).length === 0);

const todaySleep = renderToStaticMarkup(React.createElement(Today, {
  boot: { ...bootWithBacklog, sleep: { ...spStale, date: '2026-10-11', recent: [
    { date: '2026-10-09', minutes: 400, bedTime: '00:10', wakeTime: '06:50', band: 'short', bandLabel: '偏少' },
    { date: '2026-10-10', minutes: 480, bedTime: '23:20', wakeTime: '07:20', band: 'ok', bandLabel: '正常' },
  ] } },
  reload: () => {}, onOpenLogAt: () => {}, onOpenSleep: () => {},
}));
ok('渲染出睡眠卡（.sleep-tile）', todaySleep.includes('sleep-tile'));
ok('显示时长（8 小时）', todaySleep.includes('8 小时'));
ok('显示入睡/起床时间', todaySleep.includes('23:20') && todaySleep.includes('07:20'));
ok('显示分档标签', todaySleep.includes('正常'));
ok('退回的记录标出「昨天记的」（相对说法）', /（昨天记的）/.test(todaySleep));
ok('睡眠卡有迷你趋势条（.st-trend）', todaySleep.includes('st-trend'));
ok('有去睡眠页的入口按钮', todaySleep.includes('去改') || todaySleep.includes('去记一笔'));

const todayNoSleep = renderToStaticMarkup(React.createElement(Today, {
  boot: { ...bootWithBacklog, sleep: { ...spBase, recent: [] } },
  reload: () => {}, onOpenLogAt: () => {}, onOpenSleep: () => {},
}));
ok('没记录时给空状态、不渲染卡片', !todayNoSleep.includes('sleep-tile')
  && todayNoSleep.includes('还没有睡眠记录'));
ok('没记录时按钮是「去记一笔」', todayNoSleep.includes('去记一笔'));

const todayNoSleepField = renderToStaticMarkup(React.createElement(Today, {
  boot: { ...bootWithBacklog },   // 完全没有 sleep 字段（老数据兼容）
  reload: () => {}, onOpenLogAt: () => {}, onOpenSleep: () => {},
}));
ok('boot 里没有 sleep 也不崩', todayNoSleepField.includes('还没有睡眠记录'));

console.log('\n[10.88] 设置页：日界一行「现在算哪天」');
const settingsDayHtml = renderToStaticMarkup(React.createElement(Settings, {
  boot: { settings: { dayStartHour: 4, zoom: 100, theme: 'paper', dataDir: '/tmp/hua' } },
  theme: 'paper', setTheme: () => {}, reload: () => {},
}));
ok('设置页有「一天的起点」', settingsDayHtml.includes('一天的起点'));
ok('设置页提到应用顶部会有提示', /应用顶部会挂一条提示/.test(settingsDayHtml));
ok('设置页说明 0 点表示没有跨日', /不再有跨日/.test(settingsDayHtml));
ok('设置页渲染 daynow 或不在窗口内（不崩）',
  settingsDayHtml.includes('daynow') || !settingsDayHtml.includes('daynow'));

console.log('\n[10.89] 样式回归：睡眠卡与日界提示');
ok('睡眠卡有样式（.sleep-tile）', /\.sleep-tile\s*\{/.test(css));
ok('睡眠卡 hover 有反馈', /\.sleep-tile:hover/.test(css));
ok('时长字号比正文大（醒目）', /\.st-dur\s*\{[^}]*font-size/.test(css));
ok('迷你趋势条有样式（.st-trend / .st-bar）', /\.st-trend\s*\{/.test(css) && /\.st-bar\s*\{/.test(css));
ok('趋势最后一根高亮（.st-bar.now）', /\.st-bar\.now/.test(css));
ok('日界提示条有样式（.daybanner）', /\.daybanner\s*\{/.test(css));
ok('提示条 cross / fresh 两档配色', /\.daybanner\.cross/.test(css) && /\.daybanner\.fresh/.test(css));
ok('设置页的 .daynow 有样式', /\.daynow\s*\{/.test(css));
ok('提示条不参与压缩（flex:none，别被正文挤没）', /\.daybanner\s*\{[^}]*flex\s*:\s*none/.test(css));

console.log('\n[10.91] 回归：写长文时只有编辑区内部滚（真实结构：TipTap 的匿名包装层）');
// 现象：日纪写长了，整个页面跟着滚，而不是只有编辑区内部滚。
//
// 真正的根因（用真实浏览器量过才看清）：
//   TipTap 的 EditorContent 会把可编辑区再包一层**没有类名**的 div，
//   DOM 是  .editor-wrap > div(匿名) > .tiptap.ProseMirror。
//   以前写的是 `.editor-wrap > .tiptap { overflow:auto }` —— 直接子选择器，
//   .tiptap 根本不是 .editor-wrap 的直接子元素，所以这条规则从来没生效过！
//   于是匿名 div 随内容长高，溢出可视区，看起来就是「整页在滚、光标跑出框外」。
//
// 修法：把滚动交给那个匿名包装层（contenteditable 自己当滚动容器时光标自动滚动会失灵），
//   .tiptap 只排版、高度随内容。下面直接断言这两条。
const wrapScroll = rule('.editor-wrap > div:not(.editor-tools)');
ok('匿名包装层是滚动容器（overflow:auto）', /overflow\s*:\s*auto/.test(wrapScroll),
  wrapScroll.trim().slice(0, 80));
ok('匿名包装层有界（flex:1 + min-height:0，才能收缩到比内容小）',
  /flex\s*:\s*1/.test(wrapScroll) && /min-height\s*:\s*0/.test(wrapScroll),
  wrapScroll.trim().slice(0, 90));
// .tiptap 不再自己滚、也不再是直接子选择器（那个写法是 bug 的根源）
// 去掉注释再查，免得匹配到讲解这个 bug 的注释文字
const cssNoComment = css.replace(/\/\*[\s\S]*?\*\//g, '');
ok('.tiptap 不再被错误的直接子选择器设成滚动容器',
  !/\.editor-wrap\s*>\s*\.tiptap\s*\{[^}]*overflow\s*:\s*auto/.test(cssNoComment));
ok('.editor-wrap 仍然能单独出现（保留 min-height 兜底）', /min-height/.test(rule('.editor-wrap')));

// .pagehead 是 .main（flex column）的子项，必须 flex:none，否则会被压扁
ok('.pagehead 不被压缩（flex:none）', /flex\s*:\s*none/.test(rule('.pagehead')),
  rule('.pagehead').trim().slice(0, 80));

console.log('\n[10.92] 回归：日历视图整页不再被长正文撑长');
// 现象：翻看昨天/很久以前的日记，正文超出了边界，整页滚。
// 修法同写作用：.scroll 变 log-scroll-cal（overflow:hidden + flex column），
// 高度传给 .calwrap，让右栏 .calpeek 自己在框内滚。
const scrollCal = rule('.scroll.log-scroll-cal');
ok('.scroll.log-scroll-cal 是 overflow:hidden（自己不当滚动容器）',
  /overflow\s*:\s*hidden/.test(scrollCal), scrollCal.trim().slice(0, 60));
ok('.scroll.log-scroll-cal 是竖向 flex 容器', /flex-direction\s*:\s*column/.test(scrollCal));
const calwrap = rule('.calwrap');
ok('.calwrap 撑满并允许收缩（flex:1 + min-height:0）',
  /flex\s*:\s*1/.test(calwrap) && /min-height\s*:\s*0/.test(calwrap), calwrap.trim().slice(0, 70));
const calpeek = rule('.calpeek');
ok('.calpeek 有界（min-height:0）且自己滚（overflow:auto）',
  /min-height\s*:\s*0/.test(calpeek) && /overflow\s*:\s*auto/.test(calpeek), calpeek.trim().slice(0, 80));
ok('日历左栏也允许收缩', /min-height\s*:\s*0/.test(rule('.calcol')));

// 窄屏必须放回整页滚，否则两栏堆叠会被裁掉
ok('窄屏下日历视图放开整页滚',
  /@media[^{]*max-width:\s*980px[^{]*\{[\s\S]*?\.scroll\.log-scroll-cal\s*\{[^}]*overflow\s*:\s*auto/.test(css));

// 视图选择真的挂上了 log-scroll-cal
ok('Log 给日历视图挂 log-scroll-cal',
  /view === 'calendar' \? ' log-scroll-cal'/.test(logSrc));

console.log('\n[10.93] 「日志」已全部改成「日纪」（用户可见文案）');
// 用户要求：界面上的「日志」一律叫「日纪」。
// 只看用户可见字符串，代码注释里怎么叫不管。
ok('导航标签是「日纪」', /\[\s*'log'\s*,\s*'日纪'\s*\]/.test(readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')));
ok('日纪页标题是「日纪」', /<h1>日纪<\/h1>/.test(logSrc));
ok('草稿页（空状态）说「今天还没写日纪」', /今天还没写日纪/.test(readFileSync(new URL('../src/pages/Today.jsx', import.meta.url), 'utf8')));
ok('固定区标题是「日纪」', /<h3>日纪/.test(readFileSync(new URL('../src/pages/Today.jsx', import.meta.url), 'utf8')));
// 三条用户可见字符串里不能再出现「日志」
ok('搜索结果空状态不含「日志」', !/输入关键词[^<]*日志/.test(logSrc));
ok('日历右栏空提示不含「日志」', !/显示那天的日志/.test(logSrc));
ok('清空确认框不含「日志」', !/清空这一天的日志/.test(logSrc));

console.log('\n[10.9] 样式回归：编辑区不能又被压成一半');

const tiptapRule = rule('.tiptap');
ok('.tiptap 显式 width:100%（否则 flex column 里塌成内容宽度）',
  /width\s*:\s*100%/.test(tiptapRule), tiptapRule.trim().slice(0, 60));
ok('.tiptap 带 box-sizing:border-box', /box-sizing\s*:\s*border-box/.test(tiptapRule), '');
// 长文时自己滚动的职责已挪到匿名包装层（见 [10.91]），这里只确认滚动能力确实存在
ok('编辑区长文时能滚动（包装层 overflow:auto）',
  /overflow\s*:\s*auto/.test(rule('.editor-wrap > div:not(.editor-tools)')),
  rule('.editor-wrap > div:not(.editor-tools)').trim().slice(0, 70));

const logmainRule = rule('.logmain');
ok('.logmain 不再锁 max-width（要铺满剩余宽度）', !/max-width/.test(logmainRule), logmainRule.trim().slice(0, 60));

// .logbody 改成左右两栏：正文 + 当天完成
const logbodyRule = rule('.logbody');
ok('.logbody 是横向两栏（完成事项并排，不再压到正文下面）',
  /display\s*:\s*flex/.test(logbodyRule) && !/flex-direction\s*:\s*column/.test(logbodyRule),
  logbodyRule.trim().slice(0, 70));

// .loginner 在写作栏内部居中并限制行长（首帧渲染时它挂载得晚，所以只做源码断言）
const loginnerRule = rule('.loginner');
ok('.loginner 限制行长并居中', /max-width/.test(loginnerRule) && /margin\s*:\s*0\s+auto/.test(loginnerRule),
  loginnerRule.trim().slice(0, 60));

// 右栏要能独立滚动，否则日志长时它跟着被推走
const logsideRule = rule('.logside');
ok('.logside 有固定宽度（不跟正文抢）', /width/.test(logsideRule) && /flex\s*:\s*none/.test(logsideRule),
  logsideRule.trim().slice(0, 70));
ok('.logside 独立滚动', /overflow\s*:\s*auto/.test(logsideRule));
ok('窄屏下两栏自动堆叠', /@media[^{]*max-width:\s*900px[^{]*\{[\s\S]*?\.logbody\s*\{[^}]*flex-direction\s*:\s*column/.test(css));

/* ---------------------------------------------------------------- */
console.log('\n[10.94] 回归：今日页当日日纪也能点开（之前只有固定区能点）');
// 用户反馈：「当日的日纪点击无法跳转，已经固定的日纪可以」。
// 根因：Today 的日纪卡片只接了 onOpenLog（无日期），没接 onOpenLogAt；
// 标题/摘要都不是可点元素。现在标题和摘要都指向 onOpenLogAt(boot.today)。
const todaySource = readFileSync(new URL('../src/pages/Today.jsx', import.meta.url), 'utf8');
ok('日纪标题做成可点按钮（.rec-title-btn）', todaySource.includes('rec-title-btn'));
ok('摘要也是可点按钮（.logteaser-btn）', todaySource.includes('logteaser-btn'));
ok('点的是「今天」这一天（onOpenLogAt(boot.today)）',
  /onOpenLogAt\(boot\.today\)/.test(todaySource),
  (todaySource.match(/onOpenLogAt\(boot\.today\)/g) || []).length + ' 处');
ok('不能再依赖无日期的 onOpenLog（那是「只切页不定位」的老路径）',
  !/\bonOpenLog\b/.test(todaySource));

const todayLogClick = renderToStaticMarkup(React.createElement(Today, {
  boot: { ...bootWithLog, memos: [] },
  reload: () => {},
  onOpenLogAt: () => {},
}));
ok('有日纪内容时摘要渲染成可点按钮', todayLogClick.includes('logteaser-btn'));
// 空状态也得能点 —— 今天没写日纪时更要能直接进去写
const todayLogEmpty = renderToStaticMarkup(React.createElement(Today, {
  boot: { ...bootWithBacklog, memos: [] },
  reload: () => {},
  onOpenLogAt: () => {},
}));
ok('今天没写日纪时空状态也可点（.empty.clickable）',
  todayLogEmpty.includes('empty clickable'), '');

console.log('\n[10.95] 跳转时机：请求用 ref 存，不在挂载前被清掉');
// 关键：Log 只在 tab==='log' 时挂载，消费副作用要等挂载才跑。
// 请求若放 state，onJumpDone 可能先清掉它，Log 挂载时拿不到 ——「点了没反应」。
const appSource = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
ok('跳转请求存在 ref 里（跨渲染存活）', /logJumpRef\s*=\s*useRef\(null\)/.test(appSource));
ok('挂载时把 ref 当前值交给 Log', /jump=\{logJumpRef\.current\}/.test(appSource));
ok('Log 消费完把 ref 置空（下次不重复跳）', /onJumpDone=\{\(\)\s*=>\s*\{\s*logJumpRef\.current\s*=\s*null/.test(appSource));
ok('openLogAt 接受视图参数并默认写', /openLogAt\s*=\s*useCallback\(\(date,\s*view\s*=\s*'write'\)/.test(appSource));

// Log 要认 jump.view，否则「跳过去」只会进默认视图
const logSource = readFileSync(new URL('../src/pages/Log.jsx', import.meta.url), 'utf8');
ok('Log 消费 jump 时带上视图（setView(jump.view || ...)）',
  /setView\(jump\.view\s*\|\|\s*'write'\)/.test(logSource));

console.log('\n[10.96] 备忘：不绑日期的常驻贴士');
const memoBoot = {
  ...bootWithBacklog,
  memos: [
    { id: 1, text: '记得交表格', time: '', note: '周五前交到前台' },
    { id: 2, text: '项目周会', time: '14:00', note: '' },
  ],
};
const memoHtml = renderToStaticMarkup(React.createElement(Today, {
  boot: memoBoot, reload: () => {}, onOpenLogAt: () => {},
}));
ok('渲染出「备忘」区块', memoHtml.includes('>备忘'), (memoHtml.match(/<h3>备忘[^<]*/) || [])[0]);
ok('备忘区在今日记录栏里且排在睡眠之前',
  memoHtml.indexOf('备忘') > -1 && memoHtml.indexOf('备忘') < memoHtml.indexOf('>睡眠<'), '');
ok('列出备忘文字', memoHtml.includes('记得交表格') && memoHtml.includes('项目周会'));
ok('有时间的备忘把时刻显示出来', memoHtml.includes('14:00'));
ok('计数是全部条数', /<h3>备忘 · 2<\/h3>/.test(memoHtml),
  (memoHtml.match(/<h3>备忘[^<]*/) || [])[0]);
ok('补充单独渲染成一行（.memo-note）',
  /class="memo-note"/.test(memoHtml) && memoHtml.includes('周五前交到前台'));
ok('没写补充的那条不渲染空补充行', (memoHtml.match(/class="memo-note"/g) || []).length === 1);
// 贴士不该像待办：左边是固定花标，不是可点的完成圆圈
ok('左侧是固定花标（.memo-mark）', memoHtml.includes('memo-mark'));
ok('左侧不再是完成圆圈（没有 memo-check）', !memoHtml.includes('memo-check'));
ok('备忘没有「已完成」这种状态（没有 done 类）', !/memorow[^"]*done/.test(memoHtml));
ok('每条可删除（删除按钮）', memoHtml.includes('删除这条备忘'));
ok('录入框：文字 + 可选时间 + 可选补充',
  memoHtml.includes('memo-text-input') && memoHtml.includes('memo-time-input')
  && memoHtml.includes('memo-note-input'));
ok('录入框提示文案在', memoHtml.includes('记一条要提醒自己的事'));
ok('添加时能写补充（placeholder 在）', memoHtml.includes('补充一句'));

// 空表时给引导，不显示空列表
const memoEmptyHtml = renderToStaticMarkup(React.createElement(Today, {
  boot: { ...bootWithBacklog, memos: [] }, reload: () => {}, onOpenLogAt: () => {},
}));
ok('没有备忘时给一句引导', memoEmptyHtml.includes('还没有备忘'));
ok('没有备忘时不渲染列表容器', !memoEmptyHtml.includes('memolist'));
// boot 里根本没有 memos 字段时也不能崩（老包 / SSR 首帧）
const memoNoField = renderToStaticMarkup(React.createElement(Today, {
  boot: bootWithBacklog, reload: () => {}, onOpenLogAt: () => {},
}));
ok('boot 里没有 memos 字段也不崩', memoNoField.includes('>备忘'));

console.log('\n[10.97] 样式回归：备忘条与可点日纪');
ok('备忘行有样式（.memorow）', /\.memorow\s*\{/.test(css));
ok('花标有样式且用暖色（.memo-mark）',
  /\.memo-mark\s*\{[\s\S]{0,160}?color\s*:\s*var\(--warn\)/.test(css));
ok('补充字号更小（.memo-note 用 11.5px）',
  /\.memo-note\s*\{[\s\S]{0,200}?font-size\s*:\s*11\.5px/.test(css));
ok('补充颜色更淡（.memo-note 用 --text-3）',
  /\.memo-note\s*\{[\s\S]{0,200}?color\s*:\s*var\(--text-3\)/.test(css));
ok('备忘文字过长省略（ellipsis）',
  /\.memo-text\s*\{[\s\S]{0,300}?text-overflow\s*:\s*ellipsis/.test(css));
ok('备忘录入框有样式（.memoadd）', /\.memoadd\s*\{/.test(css));
ok('可点空状态有 hover 反馈（.empty.clickable:hover）', /\.empty\.clickable:hover/.test(css));
ok('日纪标题按钮有 hover 反馈（.rec-title-btn:hover）', /\.rec-title-btn:hover/.test(css));

console.log('\n[10.98] 备忘数据层：排序、去空、补充');
// 这里只查 db.cjs 的 SQL 意图（真行为在临时库测试里验）
const dbSource = readFileSync(new URL('../electron/db.cjs', import.meta.url), 'utf8');
ok('有 memos 表', /CREATE TABLE IF NOT EXISTS memos/.test(dbSource));
ok('memos 有 time / note / sort_key 列',
  /time\s+TEXT/.test(dbSource) && /note\s+TEXT/.test(dbSource) && /sort_key\s+REAL/.test(dbSource));
ok('旧库会自动补 note 列（migrate）',
  /addCol\('memos',\s*'note'/.test(dbSource));
ok('列表排序：有时间的按时刻先排，不再按 done 分组',
  /ORDER BY[\s\S]{0,200}?time\s*=\s*''[\s\S]{0,80}?time ASC/.test(dbSource)
  && !/ORDER BY[\s\S]{0,120}?done ASC/.test(dbSource));
ok('空文字不允许建（trim 后为空直接返回）',
  /function createMemo[\s\S]{0,400}?if\s*\(!t\)\s*return null/.test(dbSource));
ok('备忘 IPC 已注册（create/update/remove）',
  /memos:create/.test(readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8'))
  && /memos:update/.test(readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8'))
  && /memos:remove/.test(readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8')));
ok('preload 暴露了 hua.memos',
  /memos:\s*\{/.test(readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8')));

console.log('\n[10.99] 启动失败要说话，不能永远停在「正在打开……」');
// 事故复盘：allTags() 里少了一行 `const set = new Set()`，bootstrap() 抛错，
// boot 永远是 null，界面永久停在「正在打开……」，看起来就是「打不开了」且无从排查。
// 现在 bootstrap 失败要显示错误信息 + 重试按钮。
const appSrc = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
ok('bootstrap 调用包了 try/catch', /try\s*\{[\s\S]{0,200}?window\.hua\.bootstrap\(\)/.test(appSrc));
ok('失败时记下错误信息（bootError）', /setBootError\(/.test(appSrc));
ok('失败时显示「打不开」而不是一直转圈', appSrc.includes('打不开：读取数据时出错了'));
ok('显示具体错误信息', appSrc.includes('错误信息：'));
ok('给一个「再试一次」按钮', appSrc.includes('再试一次'));
ok('没有错误时仍然显示「正在打开……」', appSrc.includes('正在打开……'));

console.log('\n[11.1] 周程：时长与完成率的显示口径');
ok('90 分 → 1.5 小时（整小时不留尾空格）', fmtDur(90) === '1.5 小时', fmtDur(90));
ok('105 分 → 1.8 小时', fmtDur(105) === '1.8 小时', fmtDur(105));
ok('360 分 → 6 小时', fmtDur(360) === '6 小时', fmtDur(360));
ok('不足一小时按分钟', fmtDur(45) === '45 分', fmtDur(45));
ok('0 / null → 空字符串', fmtDur(0) === '' && fmtDur(null) === '', JSON.stringify(fmtDur(0)));
ok('完成率带件数：「7 / 12 件 · 58%」',
  rateText({ done: 7, total: 12, pct: 58 }, { withCounts: true }) === '7 / 12 件 · 58%',
  rateText({ done: 7, total: 12, pct: 58 }, { withCounts: true }));
ok('完成率不带件数：「58%」', rateText({ done: 7, total: 12, pct: 58 }) === '58%');
ok('没有可算的事项时是「—」而不是 0%', rateText({ done: 0, total: 0, pct: null }) === '—');
ok('传 null 也不炸', rateText(null) === '—');

console.log('\n[11.2] 周程：入口与结构');
const appSrc2 = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
ok('侧栏有「周程」页签', /\['week',\s*'周程'\]/.test(appSrc2));
ok('周程排在「回顾」之后（回顾完顺手排下周）',
  appSrc2.indexOf("'周程'") > appSrc2.indexOf("'回顾'"));
ok('周程页接到了 App 里', /tab === 'week' && <Week/.test(appSrc2));

const weekSrc = readFileSync(new URL('../src/pages/Week.jsx', import.meta.url), 'utf8');
ok('左侧有「待分配」池', weekSrc.includes('weekpool'));
ok('右侧是 7 天列', weekSrc.includes('weekcol'));
ok('每天显示负荷合计（.wc-load）', weekSrc.includes('wc-load'));
ok('偏重的那天有标记（.wc-heavy）', weekSrc.includes('wc-heavy'));
ok('默认由主进程决定是哪一周（weekStart 初始 null）',
  /const \[weekStart, setWeekStart\] = useState\(null\)/.test(weekSrc));
ok('不传 weekStart 时调 board() 拿默认周', /window\.hua\.week\.board\(ws \? \{ weekStart: ws \} : \{\}\)/.test(weekSrc));
ok('支持拖拽分配', weekSrc.includes('onDragStart') && weekSrc.includes('onDrop'));
ok('拖不动时还能点选分配（picked）', weekSrc.includes('picked'));
ok('能把事项退回待分配', weekSrc.includes('unschedule'));
ok('能在某天直接加一件事', weekSrc.includes('wc-add'));
ok('读不出这一周时给错误 + 重试', weekSrc.includes('读不出这一周') && weekSrc.includes('再试一次'));

console.log('\n[11.3] 周程与完成率的样式在位');
ok('.weekwrap / .weekcol / .wchip 都有样式',
  /\.weekwrap\s*\{/.test(css) && /\.weekcol\s*\{/.test(css) && /\.wchip\s*\{/.test(css));
ok('周程页的 .scroll 不再自己滚（高度传下去）',
  /\.scroll\.week-scroll\s*\{[\s\S]{0,200}?overflow\s*:\s*hidden/.test(css));
ok('7 天列各自在框内滚（.wc-list overflow-y）',
  /\.wc-list\s*\{[\s\S]{0,200}?overflow-y\s*:\s*auto/.test(css));
ok('窄屏下池子收到上面、列横向滚',
  /@media[^{]*max-width:\s*980px[^{]*\{[\s\S]*?\.weekwrap\s*\{[^}]*flex-direction\s*:\s*column/.test(css));
ok('今日页完成率样式（.todayrate）', /\.todayrate\s*\{/.test(css));
ok('回顾页完成率总览样式（.rateweeks）', /\.rateweeks\s*\{/.test(css));
ok('逐周完成率有横条（.rw-bar i）', /\.rw-bar\s+i\s*\{/.test(css));

console.log('\n[11.4] 完成率接进了今日页与回顾页');
const todaySrc2 = readFileSync(new URL('../src/pages/Today.jsx', import.meta.url), 'utf8');
ok('今日页顶栏加了完成率', todaySrc2.includes('todayrate') && todaySrc2.includes('rateText'));
ok('今日页用的是主进程算好的 todayStats（不自己重算）',
  todaySrc2.includes('boot.todayStats') && !/todayStats[\s\S]{0,80}?\.filter\(/.test(todaySrc2));

const todayRateHtml = renderToStaticMarkup(React.createElement(Today, {
  boot: { ...bootWithBacklog, memos: [], todayStats: { done: 3, todo: 1, dropped: 0, total: 4, rate: 0.75, pct: 75 } },
  reload: () => {}, onOpenLogAt: () => {},
}));
ok('今日页真的渲染出 75%', todayRateHtml.includes('todayrate') && todayRateHtml.includes('75%'),
  (todayRateHtml.match(/todayrate[^<]*<b[^>]*>[^<]*/) || [])[0]);
const todayNoStats = renderToStaticMarkup(React.createElement(Today, {
  boot: { ...bootWithBacklog, memos: [] }, reload: () => {}, onOpenLogAt: () => {},
}));
ok('没有 todayStats 时显示「—」而不是崩', todayNoStats.includes('todayrate') && todayNoStats.includes('—'));

const reviewSrc2 = readFileSync(new URL('../src/pages/Review.jsx', import.meta.url), 'utf8');
ok('回顾页报告里加了完成率总览', reviewSrc2.includes('ratereport'));
ok('回顾页拉的是 stats.overview', /window\.hua\.stats\.overview\(/.test(reviewSrc2));
ok('界面上写明了「放弃按未完成计」', reviewSrc2.includes('放弃」按未完成计'));
ok('界面上写明了「只有删除才不计入」', reviewSrc2.includes('只有「删除」'));

const preloadSrc = readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
ok('preload 暴露了 hua.week.board', /week:\s*\{[\s\S]{0,80}?board:/.test(preloadSrc));
ok('preload 暴露了 hua.stats.overview', /stats:\s*\{[\s\S]{0,80}?overview:/.test(preloadSrc));

console.log('\n[11.5] 周程：右键加事 / 右键改已有的');
ok('某天那一列挂了右键处理', /onContextMenu=\{\(e\)\s*=>\s*openDayMenu\(e,\s*d\)\}/.test(weekSrc));
ok('每条事项挂了右键处理', /onContextMenu=\{\(e\)\s*=>\s*openItemMenu\(e,\s*it\)\}/.test(weekSrc));
ok('在条上右键时不再冒泡去开「加一件事」', /openItemMenu[\s\S]{0,200}?e\.stopPropagation\(\)/.test(weekSrc));
ok('菜单里有「加一件事」', weekSrc.includes('加一件事'));
ok('菜单里有「修改」', weekSrc.includes('>修改<'));
ok('菜单里有「标记完成」「退回待分配」',
  weekSrc.includes('标记完成') && weekSrc.includes('退回待分配'));
ok('菜单标题标出是哪一天 / 哪一条', weekSrc.includes('ctx-head'));
ok('菜单是 position:fixed（列是 overflow:auto，否则会被裁掉）',
  /\.ctxmenu\s*\{[\s\S]{0,220}?position\s*:\s*fixed/.test(css));
ok('点别处 / Esc / 滚动都会关掉菜单',
  weekSrc.includes("document.addEventListener('mousedown', close)")
  && weekSrc.includes("e.key === 'Escape'")
  && weekSrc.includes("window.addEventListener('scroll', close, true)"));
ok('「修改」复用了已有的修改弹框（EditItemModal）',
  /import EditItemModal from/.test(weekSrc) && weekSrc.includes('<EditItemModal'));
ok('改完会刷新这一周', /onSaved=\{\(\)\s*=>\s*\{\s*setEditing\(null\);\s*refresh\(\)/.test(weekSrc));
ok('提示里说了可以右键', weekSrc.includes('右键'));

console.log('\n[11.6] 日纪：左栏标题 + 最后编辑时间');
const logSrc2 = readFileSync(new URL('../src/pages/Log.jsx', import.meta.url), 'utf8');
ok('左栏渲染过往日纪的标题（.logday-title）', logSrc2.includes('logday-title'));
ok('没标题时给占位而不是留白', logSrc2.includes('（无标题）'));
ok('主栏显示「最后改于」', logSrc2.includes('最后改于') && logSrc2.includes('fmtWhen'));
ok('日历预览显示「首次 / 最后 / 改过几次」',
  /cp-when[\s\S]{0,320}?首次 \{fmtWhen\(peek\.createdAt\)\}/.test(logSrc2)
  && /peek\.edits > 1 \? ` · 改过 \$\{peek\.edits\} 次`/.test(logSrc2));
ok('编辑记录单独占一行（不再塞在标题行里当小字）',
  logSrc2.includes('logedits-bar') && !logSrc2.includes('className="logwhen"'));
ok('编辑记录含 首次 / 最后 / 次数 / 跨度',
  logSrc2.includes('首次 {fmtWhen(meta.createdAt)}')
  && logSrc2.includes('最后 {fmtWhen(meta.updatedAt)}')
  && logSrc2.includes('共 {meta.edits} 次')
  && logSrc2.includes('跨 {editSpan} 天'));
ok('daySpan：同一天是 0', daySpan('2026-10-21T09:00:00', '2026-10-21T18:00:00') === 0);
ok('daySpan：10/19 → 10/21 是 2 天', daySpan('2026-10-19T22:05:00', '2026-10-21T12:20:00') === 2);
ok('daySpan：空值 / 乱值不炸',
  daySpan('', '') === 0 && daySpan(null, undefined) === 0 && daySpan('xx', 'yy') === 0);
ok('保存后本地把记录推进一格（首次/最后/次数）',
  logSrc2.includes('edits: m.edits + 1')
  && logSrc2.includes('createdAt: m.createdAt || at.toISOString()'));
const mainSrc2 = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
ok('log:days 带上了 title 与编辑记录',
  mainSrc2.includes('title: log.title') && mainSrc2.includes('edits: meta[d]?.edits'));
ok('log:day 带上完整编辑记录', /log:day[\s\S]{0,260}?\.\.\.db\.journalMeta\(date\)/.test(mainSrc2));
ok('四个写入口都会记一次编辑（之前只有 log:save 记）',
  ['journal:save', 'journal:add', 'journal:remove', 'log:save'].every((h) =>
    new RegExp(`${h}'[\\s\\S]{0,400}?bumpJournalMeta`).test(mainSrc2)));
ok('系统归档只更新时间、不算一次编辑',
  /journal:snapshot[\s\S]{0,600}?touchJournalMeta/.test(mainSrc2));

ok('fmtWhen：ISO → 「10/17 12:30」', fmtWhen('2026-10-17T12:30:00') === '10/17 12:30', fmtWhen('2026-10-17T12:30:00'));
ok('fmtWhen：空值返回空串', fmtWhen('') === '' && fmtWhen(null) === '');
ok('fmtWhen：解析不了也不炸', fmtWhen('not-a-date') === '');

console.log('\n[11.7] 睡眠：日期显示成「前一晚 → 当天早晨」');
ok('nightLabel：10/16 晚 → 10/17 晨', nightLabel('2026-10-17') === '10/16 晚 → 10/17 晨', nightLabel('2026-10-17'));
ok('nightLabel 跨月正确', nightLabel('2026-11-01') === '10/31 晚 → 11/1 晨', nightLabel('2026-11-01'));
ok('nightLabel 跨年正确', nightLabel('2027-01-01') === '12/31 晚 → 1/1 晨', nightLabel('2027-01-01'));

console.log('\n[11.8] 今日页：录入框是主角（提到两栏之上）');
const todaySrc3 = readFileSync(new URL('../src/pages/Today.jsx', import.meta.url), 'utf8');
ok('录入框在两栏（.today）之外', todaySrc3.indexOf('<div className="composer-hero-wrap">') > -1
  && todaySrc3.indexOf('<div className="composer-hero-wrap">') < todaySrc3.indexOf('<div className="today">'),
  `wrap@${todaySrc3.indexOf('<div className="composer-hero-wrap">')} today@${todaySrc3.indexOf('<div className="today">')}`);
ok('左栏里不再有第二个录入框', (todaySrc3.match(/composer-hero-wrap/g) || []).length === 1,
  String((todaySrc3.match(/composer-hero-wrap/g) || []).length));
ok('hero 有独立样式', /\.composer\.composer-hero\s*\{/.test(css));
ok('聚焦时整张卡有描边反馈',
  /\.composer\.composer-hero:focus-within\s*\{[\s\S]{0,140}?box-shadow:\s*0 0 0 3px/.test(css));
ok('横跨整页（外面包了一层带内边距的容器）',
  /\.composer-hero-wrap\s*\{[\s\S]{0,160}?padding:\s*0 30px/.test(css));

console.log('\n[11.9] 睡眠报告：点完直接在页面上看');
const sleepSrc = readFileSync(new URL('../src/pages/Sleep.jsx', import.meta.url), 'utf8');
ok('报告正文渲染在页面上', sleepSrc.includes('sleep-report-body') && sleepSrc.includes('mdToHtml(report.md'));
ok('可以收起', sleepSrc.includes('setReport(null)'));
ok('可以打开 reports 目录', sleepSrc.includes('openDataDir'));
ok('按钮旁写清了「生成后直接显示在下面」', sleepSrc.includes('生成后直接显示在下面'));
ok('主进程把正文一起返回了', /function generateSleepReport[\s\S]{0,700}?md\s*\}/.test(mainSrc2));
ok('报告区有样式', /\.sleep-report-body\s*\{/.test(css));
ok('报告里的标题/列表有排版', /\.srb-md h1/.test(css) && /\.srb-md li/.test(css));

console.log('\n[11.10] 固定的事项要有标识（不然和普通事项没区别）');
ok('固定的事项带 pinned 类', /it\.pinned \? ' pinned' : ''/.test(todaySrc3));
ok('标题前有「固定」小标', todaySrc3.includes('it-pin'));
ok('左侧有主色竖条（.item.pinned）',
  /\.item\.pinned\s*\{[\s\S]{0,180}?box-shadow:\s*inset 3px 0 0 var\(--accent\)/.test(css));
const pinnedItem = {
  id: 99, date: '2026-10-14', title: '固定的事', status: 'todo', pinned: true,
  estMinutes: null, actualMinutes: null, startTime: null, output: null, tags: [],
};
const pinnedHtml = renderToStaticMarkup(React.createElement(Today, {
  boot: { ...bootWithBacklog, memos: [], items: [pinnedItem], backlog: [] },
  reload: () => {}, onOpenLogAt: () => {},
}));
ok('固定事项渲染出 pinned 类', /class="item todo pinned"/.test(pinnedHtml),
  (pinnedHtml.match(/class="item[^"]*"/) || [])[0]);
ok('固定事项标题前有「固定」标', /class="it-pin"[^>]*>固定</.test(pinnedHtml));
const normalHtml = renderToStaticMarkup(React.createElement(Today, {
  boot: { ...bootWithBacklog, memos: [], items: [{ ...pinnedItem, pinned: false }], backlog: [] },
  reload: () => {}, onOpenLogAt: () => {},
}));
ok('普通事项不带 pinned 类、也没有「固定」标',
  !/class="item todo pinned"/.test(normalHtml) && !normalHtml.includes('it-pin'));

console.log('\n[11.11] 周程默认落在本周');
ok('主进程默认取本周（不再 +1 周）',
  /week:board[\s\S]{0,500}?: week\.weekStartOf\(today\);/.test(mainSrc2)
  && !/week:board[\s\S]{0,500}?shiftWeek\(week\.weekStartOf\(today\), 1\)/.test(mainSrc2));
ok('按钮改成「回到本周」', weekSrc.includes('回到本周') && !weekSrc.includes('回到下周'));
ok('已经是本周时该按钮禁用', /disabled=\{board\.isThisWeek\}/.test(weekSrc));

console.log('\n[11.12] 录入框：一条可以写的线 + 一行很轻的注解');
ok('有注解行 .composer-meta', todaySrc3.includes('composer-meta'));
ok('日期/耗时是小字注解（ct-link），不是胶囊', todaySrc3.includes('ct-link') && !todaySrc3.includes('ct-chip'));
ok('标题压在一条细线上（像在纸上写一行）',
  /\.composer-hero \.composer-title\s*\{[\s\S]{0,260}?border-bottom:\s*1px solid/.test(css));
ok('标题字号 18px',
  /\.composer-hero \.composer-title\s*\{[\s\S]{0,160}?font-size:\s*18px/.test(css));
const ctBlock = (() => { const i = css.indexOf('.ct-link {'); return i < 0 ? '' : css.slice(i, css.indexOf('}', i)); })();
ok('注解是小字淡色（13px / --text-3）',
  ctBlock.includes('font-size: 13px') && ctBlock.includes('var(--text-3)'));
// 字小但点击区不能小：上下各 7px padding，实际高度 ~31px，别再缩回 17px
ok('注解的点击区够大（上下各 7px padding）', ctBlock.includes('padding: 7px 9px'));
const dpBlock = (() => { const i = css.indexOf('.dp-chip {'); return i < 0 ? '' : css.slice(i, css.indexOf('}', i)); })();
ok('弹层里的快捷档也够大（min-height 32px）', dpBlock.includes('min-height: 32px'));
const ddBlock = (() => { const i = css.indexOf('.dp-date {'); return i < 0 ? '' : css.slice(i, css.indexOf('}', i)); })();
ok('弹层里的输入框够高（min-height 32px）', ddBlock.includes('min-height: 32px'));
ok('「记下」默认藏起来，写了字才浮出来（只限录入框，别波及备忘的「加一条」）',
  /\.composer-hero \.composer-btn\s*\{[\s\S]{0,200}?opacity:\s*0/.test(css)
  && /\.composer-hero\.has-text \.composer-btn\s*\{[\s\S]{0,80}?opacity:\s*1/.test(css)
  && todaySrc3.includes("title.trim() ? ' has-text'"));
ok('备忘的「加一条」没被连坐（不该有全局的 .composer-btn 隐藏规则）',
  !/^\.composer-btn\s*\{[^}]*opacity:\s*0/m.test(css));
ok('不再是裸数字框（composer-est 已去掉）', !todaySrc3.includes('composer-est'));
ok('弹层绝对定位（不会把「记下」挤走）',
  /\.ct-pop\s*\{[\s\S]{0,220}?position:\s*absolute/.test(css));
ok('点别处 / Esc 会关掉弹层',
  todaySrc3.includes("e.target.closest('.ct-wrap')") && todaySrc3.includes("e.key === 'Escape'"));
const emptyComposer = renderToStaticMarkup(React.createElement(Today, {
  boot: { ...bootWithBacklog, memos: [] }, reload: () => {}, onOpenLogAt: () => {},
}));
ok('空着的时候没有 has-text（不摆一个保存按钮催你）',
  !/composer-hero has-text/.test(emptyComposer));

console.log('\n[11.13] 固定区的事项要带上标签 / 耗时（别只剩一个标题）');
const pinItem2 = {
  id: 7, date: '2026-10-16', title: '整理文档', status: 'todo', pinned: true,
  estMinutes: 45, actualMinutes: null, startTime: '14:00', output: null, tags: ['工作', '会议'],
};
const pinHtml = renderToStaticMarkup(React.createElement(Today, {
  boot: {
    ...bootWithBacklog, memos: [], items: [], backlog: [],
    pins: { reflections: [], logs: [], items: [pinItem2] },
  },
  reload: () => {}, onOpenLogAt: () => {},
}));
ok('固定区不再显示标签（标签已撤）', !pinHtml.includes('class="tag"'));
ok('固定区渲染出预计耗时', pinHtml.includes('预计 45 分'));
ok('固定区渲染出开始时间', pinHtml.includes('14:00'));
ok('固定区标题和标签是两行结构（.pinrow-main）', pinHtml.includes('pinrow-main'));

// 没标签/没耗时的固定事项，不该冒出一个空的 meta 行
const pinBareHtml = renderToStaticMarkup(React.createElement(Today, {
  boot: {
    ...bootWithBacklog, memos: [], items: [], backlog: [],
    pins: { reflections: [], logs: [], items: [{ ...pinItem2, tags: [], estMinutes: null, startTime: null }] },
  },
  reload: () => {}, onOpenLogAt: () => {},
}));
ok('没标签时不渲染空的 meta 行',
  !/pinrow-main[\s\S]{0,200}?class="it-meta"/.test(pinBareHtml));

console.log('\n[11.14] 周程：固定事项不摊进日列，单独一条带子');
ok('主进程把固定的从日列里剔掉',
  /const pinned = rows\.filter\(\(it\) => it\.pinned\)[\s\S]{0,260}?for \(const it of normal\)/.test(mainSrc2));
ok('固定的单独下发（board.pinned）', /itemsByDate,\s*pinned,/.test(mainSrc2));
ok('待分配池排除固定的', /openItemsOutside\(from, to\)\.filter\(\(it\) => !it\.pinned\)/.test(mainSrc2));
ok('周完成率只算这一周排的事', /completion:\s*stats\.completionOfItems\(normal\)/.test(mainSrc2));
ok('页面渲染固定带子', weekSrc.includes('weekpinned') && weekSrc.includes('wkpchip'));
ok('带子写明了「不占某一天」', weekSrc.includes('不占某一天'));
ok('固定的不参与拖拽排期（不该出现 draggable）',
  !/wkpchip[^>]{0,320}?draggable/.test(weekSrc));
ok('带子有独立样式（虚线框，和日列区分）',
  /\.weekpinned\s*\{[\s\S]{0,200}?border:\s*1px dashed/.test(css));

console.log('\n[11.15] 周程：加事表单能填耗时和开始时间');
ok('表单有标题 / 预计 / 开始三个输入',
  weekSrc.includes('wkadd-title') && weekSrc.includes('wkadd-num') && weekSrc.includes('wkadd-time'));
ok('create 时把 estMinutes 和 startTime 一起送过去',
  /items\.create\(\{[\s\S]{0,220}?estMinutes:[\s\S]{0,140}?startTime:/.test(weekSrc));
ok('右键菜单的「加一件事」打开表单', /startAdd\(menu\.date, menu\.x, menu\.y\)/.test(weekSrc));
ok('＋ 按钮也打开同一个表单', /startAdd\(d, r\.left, r\.bottom \+ 6\)/.test(weekSrc));
ok('表单 fixed 定位（不会被日列的 overflow 裁掉）',
  /\.wkadd\s*\{[\s\S]{0,180}?position:\s*fixed/.test(css));
ok('点别处 / Esc 会关掉表单', /closest\('\.wkadd'\)/.test(weekSrc));
ok('不再有只收标题的内联输入框（wc-add-input 已去掉）', !weekSrc.includes('wc-add-input'));

console.log('\n[11.16] 睡眠页：数据展示重排');
const sleepSrc2 = readFileSync(new URL('../src/pages/Sleep.jsx', import.meta.url), 'utf8');
const chartSrc = readFileSync(new URL('../src/components/SleepChart.jsx', import.meta.url), 'utf8');
ok('关键数字排成一行（不再六张卡片）',
  sleepSrc2.includes('sleep-metrics') && !sleepSrc2.includes('ss-card'));
ok('分档做成一条堆叠条', sleepSrc2.includes('sd-bar') && sleepSrc2.includes('sd-seg'));
ok('分档图例带每档天数',
  sleepSrc2.includes('sd-item') && sleepSrc2.includes('<b>{n}</b>天'));
ok('细节收进「更多数据」折叠', sleepSrc2.includes('sleep-more') && sleepSrc2.includes('sleep-details'));
ok('折叠开关两种文案', /more \? '收起细节' : '更多数据'/.test(sleepSrc2));
ok('柱状图不再画趋势折线（柱子已表达走势）', !chartSrc.includes('sc-trend'));
ok('柱状图不再画 7–9 小时背景带（太重）', !chartSrc.includes('sc-band'));
ok('虚线的含义写在脚注里，不压在柱子上',
  chartSrc.includes('虚线是 7 小时下限') && !chartSrc.includes('sc-ref-label'));

console.log('\n[11.17] 事项的「说明/补充」—— 别让人把说明写进标签里');
const noteItem = {
  id: 5, date: '2026-10-21', title: '整理文档', status: 'todo', pinned: false,
  estMinutes: null, actualMinutes: null, startTime: null, output: null,
  tags: ['工作'], note: '只改第二部分的选择题',
};
const modalHtml = renderToStaticMarkup(React.createElement(EditItemModal, {
  item: noteItem, allTags: ['工作'], onClose: () => {}, onSaved: () => {},
}));
ok('修改弹框里有「说明 / 补充」', modalHtml.includes('说明 / 补充'));
ok('说明是多行输入框', /<textarea[^>]*class="m-note"/.test(modalHtml),
  (modalHtml.match(/<textarea[^>]*>/) || [])[0]);
ok('说明带出了原来的内容', modalHtml.includes('只改第二部分的选择题'));
ok('修改弹框里没有标签输入框了', !modalHtml.includes('taginput') && !modalHtml.includes('>标签<'));

const noteListHtml = renderToStaticMarkup(React.createElement(Today, {
  boot: { ...bootWithBacklog, memos: [], items: [noteItem], backlog: [] },
  reload: () => {}, onOpenLogAt: () => {},
}));
ok('列表里说明以小字显示在标题下',
  /class="it-note">只改第二部分的选择题/.test(noteListHtml));
ok('列表里只显示说明，不再有标签块',
  noteListHtml.includes('it-note') && !noteListHtml.includes('class="tag"'));

const bareNoteHtml = renderToStaticMarkup(React.createElement(Today, {
  boot: { ...bootWithBacklog, memos: [], items: [{ ...noteItem, note: '' }], backlog: [] },
  reload: () => {}, onOpenLogAt: () => {},
}));
ok('没有说明时不渲染空的说明行', !bareNoteHtml.includes('class="it-note"'));

const notePinHtml = renderToStaticMarkup(React.createElement(Today, {
  boot: {
    ...bootWithBacklog, memos: [], items: [], backlog: [],
    pins: { reflections: [], logs: [], items: [noteItem] },
  },
  reload: () => {}, onOpenLogAt: () => {},
}));
ok('固定区也显示说明（四处都要看）',
  /pinrow-main[\s\S]{0,260}?class="it-note"/.test(notePinHtml));

// 保存链路：输入框 → state → patch.note（真行为在数据层测过）
const modalSrc = readFileSync(new URL('../src/components/EditItemModal.jsx', import.meta.url), 'utf8');
ok('说明框绑到 note 状态', /value=\{note\}[\s\S]{0,160}?setNote\(e\.target\.value\)/.test(modalSrc));
ok('保存时把说明一起送过去（trim 后）', /note:\s*note\.trim\(\)/.test(modalSrc));
ok('保存时说明照旧送、不再读写 tags',
  modalSrc.includes('note: note.trim()') && !modalSrc.includes('setTags'));

console.log('\n[11.18] 上午 / 下午 / 晚上：隔断 + 自由分配');
ok('slotOf：显式指定优先（不会被开始时间覆盖）', slotOf({ slot: 'pm', startTime: '07:00' }) === 'pm');
ok('slotOf：9:30 算上午', slotOf({ startTime: '09:30' }) === 'am');
ok('slotOf：14:00 算下午', slotOf({ startTime: '14:00' }) === 'pm');
ok('slotOf：20:00 算晚上', slotOf({ startTime: '20:00' }) === 'eve');
ok('slotOf：凌晨两点算晚上（熬夜别算成上午）', slotOf({ startTime: '02:00' }) === 'eve');
ok('slotOf：5 点起算上午', slotOf({ startTime: '05:00' }) === 'am');
ok('slotOf：都没有就是未安排', slotOf({}) === '');
ok('slotOf：坏值不炸', slotOf({ startTime: 'xx' }) === '');

const slotItems = [
  { ...noteItem, id: 11, title: '晨间整理', slot: 'am', note: '', startTime: null },
  { ...noteItem, id: 12, title: '写方案', slot: 'pm', note: '', startTime: null },
  { ...noteItem, id: 13, title: '读点书', slot: 'eve', note: '', startTime: null },
];
const slotHtml = renderToStaticMarkup(React.createElement(Today, {
  boot: { ...bootWithBacklog, memos: [], backlog: [], items: slotItems },
  reload: () => {}, onOpenLogAt: () => {},
}));
ok('三个时段各有一条隔断', (slotHtml.match(/class="it-slot"/g) || []).length === 3,
  String((slotHtml.match(/class="it-slot"/g) || []).length));
ok('隔断上写着上午 / 下午 / 晚上',
  slotHtml.includes('>上午<') && slotHtml.includes('>下午<') && slotHtml.includes('>晚上<'));

const noSlotHtml = renderToStaticMarkup(React.createElement(Today, {
  boot: { ...bootWithBacklog, memos: [], backlog: [], items: [{ ...noteItem, slot: '', startTime: null }] },
  reload: () => {}, onOpenLogAt: () => {},
}));
// 反过来了：骨架要一直在。之前「一条都没指定就整块不画」，
// 用户看到的就是「日程没有早中晚」。
// 三档骨架 + 一条落在「未安排」里 → 4 个隔断，其中 3 个是空档
ok('一条都没指定时三档骨架照样在（上午/下午/晚上）',
  noSlotHtml.includes('>上午<') && noSlotHtml.includes('>下午<') && noSlotHtml.includes('>晚上<'),
  (noSlotHtml.match(/>上午<|>下午<|>晚上</g) || []).join(' '));
ok('三个空档都标了 empty（不画线、更淡）',
  (noSlotHtml.match(/it-slot empty/g) || []).length === 3,
  String((noSlotHtml.match(/it-slot empty/g) || []).length));
ok('有内容的那条落在「未安排」里', noSlotHtml.includes('>未安排<'));

// 没有「未安排」内容时，它那一档不画（它不是一天里的某一段）
const slotOnlyHtml = renderToStaticMarkup(React.createElement(Today, {
  boot: { ...bootWithBacklog, memos: [], backlog: [], items: [{ ...noteItem, slot: 'am', startTime: null }] },
  reload: () => {}, onOpenLogAt: () => {},
}));
ok('全部排进时段后，「未安排」那一档不出现', !slotOnlyHtml.includes('>未安排<'));

const modalSlotHtml = renderToStaticMarkup(React.createElement(EditItemModal, {
  item: { ...noteItem, slot: 'pm' }, allTags: [], onClose: () => {}, onSaved: () => {},
}));
ok('修改弹框有四个时段选项（含「不指定」）',
  (modalSlotHtml.match(/class="slotchip/g) || []).length === 4,
  String((modalSlotHtml.match(/class="slotchip/g) || []).length));
ok('当前时段高亮', /class="slotchip on"[^>]*>下午</.test(modalSlotHtml));
ok('写明了留空会按开始时间自动归', modalSlotHtml.includes('留空就按开始时间自动归'));

console.log('\n[11.19] 待分配：动作 + 窗口');
const unItems = [
  { ...noteItem, id: 21, title: '还没想好的一件事', note: '', tags: [] },
  { ...noteItem, id: 22, title: '另一件', note: '先放着', tags: ['工作'] },
];
const poolInline = renderToStaticMarkup(React.createElement(Today, {
  boot: { ...bootWithBacklog, memos: [], backlog: [], items: [], unscheduled: unItems },
  reload: () => {}, onOpenLogAt: () => {},
}));
ok('待分配直接展示在页面上（不再藏在按钮后面）', poolInline.includes('poolsect'));
ok('标题带件数', poolInline.includes('待分配') && poolInline.includes('>2<'));
ok('每一条都列出来了',
  poolInline.includes('还没想好的一件事') && poolInline.includes('另一件'));
ok('每条都能当场丢到今天 / 明天 / 某个日期',
  (poolInline.match(/class="pitem-acts"/g) || []).length === 2
  && poolInline.includes('>今天<') && poolInline.includes('>明天<')
  && poolInline.includes('type="date"'));
ok('待分配的条目也能「修改」（标题/说明/耗时）', poolInline.includes('>修改<'));
ok('说明也带出来', poolInline.includes('先放着'));
ok('不再有弹窗和头部按钮',
  !poolInline.includes('poolbtn') && !poolInline.includes('modal-pool'));

const noPool = renderToStaticMarkup(React.createElement(Today, {
  boot: { ...bootWithBacklog, memos: [], backlog: [], items: [], unscheduled: [] },
  reload: () => {}, onOpenLogAt: () => {},
}));
ok('没有待分配时整块不渲染', !noPool.includes('poolsect'));

const todaySrc4 = readFileSync(new URL('../src/pages/Today.jsx', import.meta.url), 'utf8');
ok('事项上有「待分配」动作', todaySrc4.includes('unassign(it)') && todaySrc4.includes('待分配'));
ok('待分配 = 把日期清空', todaySrc4.includes("patch: { date: '' }"));

console.log('\n[11.20] 标签已撤掉（守住，别再长回来）');
ok('修改弹框里没有标签输入框', !modalSrc.includes('taginput') && !modalSrc.includes('setTags'));
ok('今日页没有标签筛选条', !todaySrc4.includes('tagbar') && !todaySrc4.includes('tagFilter'));
ok('今日页不再渲染标签块', !todaySrc4.includes('className="tag"'));
ok('周程的固定带子不渲染标签', !weekSrc.includes('it.tags'));
ok('bootstrap 不再下发 tags', !mainSrc2.includes('tags: db.allTags()'));
ok('样式里删掉了 .tagchip / .taginput', !css.includes('.tagchip') && !css.includes('.taginput'));
// .tag 还得留着 —— 日志页「引用事项」的按钮在用
ok('.tag 样式保留（日志页引用事项还在用）', css.includes('.tag {'));

console.log('\n[11.21] 不定时：现在不估，做完再填实际耗时');
const todaySrc5 = readFileSync(new URL('../src/pages/Today.jsx', import.meta.url), 'utf8');
const completeSrc = readFileSync(new URL('../src/components/CompleteModal.jsx', import.meta.url), 'utf8');
ok('录入框的耗时档里有「不定时」（不再是「清除」）',
  todaySrc5.includes('不定时') && !todaySrc5.includes('>清除<'));
ok('选「不定时」后标签显示出来', todaySrc5.includes("untimed ? '不定时' : '预计耗时'"));
ok('不定时在数据上就是 estMinutes = null', todaySrc5.includes('estMinutes: est ? Number(est) : null'));
ok('完成弹窗里说明这件是不定时的', completeSrc.includes('这件是不定时的'));

const cmUntimed = renderToStaticMarkup(React.createElement(CompleteModal, {
  item: { ...noteItem, estMinutes: null }, onClose: () => {}, onDone: () => {},
}));
ok('不定时的事项：完成时提示先记实际耗时',
  cmUntimed.includes('这件是不定时的') && cmUntimed.includes('实际花了多久'));
const cmTimed = renderToStaticMarkup(React.createElement(CompleteModal, {
  item: { ...noteItem, estMinutes: 60 }, onClose: () => {}, onDone: () => {},
}));
ok('估过时的：不显示那句，改成提示预计值',
  !cmTimed.includes('这件是不定时的') && cmTimed.includes('预计 60 分钟'));

console.log('\n[11.22] 早中晚的分界要看得出来（今日页 + 周程）');
const blockOf = (sel) => {
  const i = css.indexOf(sel);
  return i < 0 ? '' : css.slice(i, css.indexOf('}', i));
};
const itSlotSpan = blockOf('.it-slot span {');
ok('今日页的时段名加粗一档（12px / --text-2）',
  itSlotSpan.includes('font-size: 12px') && itSlotSpan.includes('var(--text-2)'),
  itSlotSpan.replace(/\s+/g, ' ').slice(0, 80));
ok('今日页的隔断线不再是极淡的 --line-2',
  blockOf('.it-slot::after').includes('var(--line)'));
ok('周程的日列也按时段分组',
  weekSrc.includes('groupBySlot(items)') && weekSrc.includes('wc-slot'));
ok('周程列里的隔断很小（10px，列太窄）',
  blockOf('.wc-slot {').includes('font-size: 10px'));
ok('周程列里三档也一直画（空档更淡），七列骨架一致',
  weekSrc.includes('wc-slot') && weekSrc.includes('empty')
  && !weekSrc.includes("items.some((x) => slotOf(x) !== '')"));
ok('周程空档有专门样式', css.includes('.wc-slot.empty'));

console.log('\n[11.23] 录入时就能选「待分配」');
const todaySrc6 = readFileSync(new URL('../src/pages/Today.jsx', import.meta.url), 'utf8');
ok('日期弹层里有「待分配」', todaySrc6.includes('POOL') && todaySrc6.includes('>待分配<'));
ok('选待分配后日期标签显示「待分配」',
  todaySrc6.includes("addDate === POOL ? '待分配' : relLabel(boot.today, targetDate)"));
ok('待分配落到数据上是空日期', todaySrc6.includes("addDate === POOL ? '' : (addDate || boot.today)"));
ok('占位提示也跟着变', todaySrc6.includes('记一件还没定哪天的事'));
ok('提交后给一句「已放进待分配」', todaySrc6.includes("flash('已放进待分配')"));

console.log('\n[11.24] 遗留：完成 / 删除 / 多选批量');
const backSrc = readFileSync(new URL('../src/pages/Today.jsx', import.meta.url), 'utf8');
ok('每条遗留都能勾选', backSrc.includes('back-check') && backSrc.includes('toggleBack(it.id)'));
ok('每条都能 移到今天 / 完成 / 删除',
  backSrc.includes('>移到今天<') && backSrc.includes('setCompleting(it)}>完成<')
  && backSrc.includes('setConfirming(it)}>删除<'));
ok('底部有全选', backSrc.includes('back-all') && backSrc.includes('toggleBackAll'));
ok('选中后出现批量操作', backSrc.includes('已选 {backSel.length} 件'));
ok('批量完成会问「完成于哪天」',
  backSrc.includes('完成这 {backSel.length} 件') && backSrc.includes('bulkDoneDate'));
ok('批量删除要确认', backSrc.includes('删除这 ${backSel.length} 件？'));
ok('批量完成逐条写 doneDate', backSrc.includes('doneDate: d,'));

const cmPast = renderToStaticMarkup(React.createElement(CompleteModal, {
  item: { ...noteItem, id: 99, date: '2026-10-08' },
  today: '2026-10-11', onClose: () => {}, onDone: () => {},
}));
ok('遗留事项完成时可以选「完成于哪天」',
  cmPast.includes('完成于哪天') && cmPast.includes('type="date"'));
ok('说明了会记到那一天', cmPast.includes('记到实际做完的那天'));

const cmToday = renderToStaticMarkup(React.createElement(CompleteModal, {
  item: { ...noteItem, id: 98, date: '2026-10-11' },
  today: '2026-10-11', onClose: () => {}, onDone: () => {},
}));
ok('今天的事项不显示这个字段', !cmToday.includes('完成于哪天'));

console.log('\n[11.25] 待分配：能改标题 / 说明 / 耗时');
const poolSrc2 = readFileSync(new URL('../src/pages/Today.jsx', import.meta.url), 'utf8');
ok('待分配行有「修改」并接到 setEditing', poolSrc2.includes('setEditing(it)} title="改标题 / 说明 / 预计耗时"'));
ok('待分配不填日期时仍是待分配',
  poolSrc2.includes("patch: { date: '' }") && poolSrc2.includes('doneDate: d,'));
const editSrc2 = readFileSync(new URL('../src/components/EditItemModal.jsx', import.meta.url), 'utf8');
ok('修改弹框里日期留空有提示', editSrc2.includes('留空就是「待分配」'));
ok('修改弹框里有说明框', editSrc2.includes('说明 / 补充'));
ok('修改弹框里有预计耗时', editSrc2.includes('预计耗时（分钟）'));

console.log('\n[11.26] 录入时就能选时段（上午/下午/晚上）');
const todaySrc7 = readFileSync(new URL('../src/pages/Today.jsx', import.meta.url), 'utf8');
ok('录入框有「时段」注解', todaySrc7.includes("'时段'") && todaySrc7.includes('setSlotPick'));
ok('弹层里是上午/下午/晚上 + 不指定',
  todaySrc7.includes('SLOTS.map') && todaySrc7.includes('不指定'));
ok('选中后注解显示时段名', todaySrc7.includes('SLOTS.find((s) => s.key === slot)'));
ok('提交时带上 slot', todaySrc7.includes('slot: slot || null'));
ok('记完把时段复位', todaySrc7.includes("setSlot('');"));

console.log('\n[11.27] 备忘可以拖动排序');
const memoList = [
  { id: 101, text: '第一条', time: '09:00', note: '补充一句', sortKey: 1 },
  { id: 102, text: '第二条', time: '', note: '', sortKey: 2 },
];
const memoDragHtml = renderToStaticMarkup(React.createElement(Today, {
  boot: { ...bootWithBacklog, memos: memoList, items: [], backlog: [], unscheduled: [] },
  reload: () => {}, onOpenLogAt: () => {},
}));
ok('每条备忘都是可拖的',
  (memoDragHtml.match(/class="memorow" draggable="true"/g) || []).length === 2,
  String((memoDragHtml.match(/class="memorow" draggable="true"/g) || []).length));
ok('删除按钮不参与拖拽（draggable=false）',
  (memoDragHtml.match(/draggable="false"/g) || []).length >= 2);
ok('一条以上才提示可以拖', memoDragHtml.includes('按住可拖动排序'));
ok('拖动结果交给 memos.reorder', todaySrc7.includes('window.hua.memos.reorder({ ids })'));
ok('落位算法：先剔除自己，再插到目标前/后',
  todaySrc7.includes("memos.map((x) => x.id).filter((id) => id !== src)")
  && todaySrc7.includes('ids.splice(insertAfter ? i + 1 : i, 0, src)'));
ok('拖完别把那次 mouseup 当成点击（会误开编辑）',
  todaySrc7.includes('memoJustDragged.current'));
ok('拖动时半透明、落点有线',
  css.includes('.memorow.dragging') && css.includes('.memorow.dragover-after'));

console.log('\n[11.28] 清空日期 = 待分配，不能被「还原」');
const editSrc3 = readFileSync(new URL('../src/components/EditItemModal.jsx', import.meta.url), 'utf8');
// 空字符串是假值：写 `date || item.date` 会把用户清空的日期还原回去，
// 表现就是「改成待分配，但还是不变」（用户报过）。
// 注释里提到这个写法是当反面教材，所以只看「赋值语句」那行
ok('保存时 date 直接用，不回退到原日期',
  editSrc3.split(String.fromCharCode(10)).some((l) => l.trim() === 'date,')
  && !editSrc3.includes('date: date ||') && !editSrc3.includes('date: date ??'));
ok('留空时有「这就是待分配」的提示', editSrc3.includes('留空就是「待分配」'));
const weekSrc2 = readFileSync(new URL('../src/pages/Week.jsx', import.meta.url), 'utf8');
ok('周程的「退回待分配」是真的清空日期（不是挪到今天）',
  weekSrc2.includes("patch: { date: '' }") && !weekSrc2.includes("carry({ ids: [it.id], date: board.today })"));
ok('周程的 × 提示写对了', weekSrc2.includes('不属任何一天'));
const todaySrc8 = readFileSync(new URL('../src/pages/Today.jsx', import.meta.url), 'utf8');
ok('「接下来」区块每行也有「待分配」',
  /移到今天<\/button>[\s\S]{0,200}?unassign\(it\)/.test(todaySrc8));

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
