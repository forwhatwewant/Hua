/* 真实浏览器里的布局回归测试。
 *
 * 为什么需要它：scripts/test-ui.jsx 走 SSR，只能读 CSS **源码文本**、渲染静态 HTML，
 * 拿不到浏览器算出来的真实布局。像「编辑器自己滚还是整页滚」这种问题，
 * CSS 文本看着全对（作者以为选择器匹配得上），实际 DOM 里根本匹配不到 —— 就是被坑过的那次。
 * 所以这一类必须放到真浏览器里量。
 *
 * 做法：vite build 出两个探针页（用**自造的假数据**，绝不碰真实数据目录），
 * 起一个本地静态服务，用 Playwright(Chromium) 打开，量 scrollHeight/clientHeight/overflowY，
 * 断言：
 *   1) 页面本身不滚（document.scrollHeight ≈ 视口高度）
 *   2) 日纪写作页：编辑器的滚动容器内部滚，光标跟着走
 *   3) 日历页：右栏预览面板内部滚
 *
 * 需要 Playwright + Chromium。找不到就跳过（不算失败），因为不是每台机器都装了。
 * Python playwright 用环境变量指定：HUA_PY 或按默认 venv 路径。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';

const ROOT = path.join(import.meta.dirname, '..');
const PROBE = path.join(ROOT, 'tmp-browser-test');
const PORT = 5391;

// ---- 找 Python（带 playwright 的那个） ----
// 优先用隔离 venv 里的解释器：playwright 就装在那儿，不用再手动拼 PYTHONPATH。
// 路径从当前用户推出来，不写死任何人的用户名 / 盘符
const HOME = os.homedir();
const LOCAL = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const VENV_PY = path.join(HOME, '.workbuddy-ai', 'binaries', 'python', 'envs', 'default', 'Scripts', 'python.exe');
const MANAGED_PY = path.join(HOME, '.workbuddy-ai', 'binaries', 'python', 'versions', '3.13.12', 'python.exe');
const PY_CANDIDATES = [process.env.HUA_PY, VENV_PY, MANAGED_PY].filter(Boolean);
const PY = PY_CANDIDATES.find((p) => fs.existsSync(p));
// 只有当用的不是 venv 解释器时，才需要借它的 site-packages 找 playwright
const SITE = path.join(HOME, '.workbuddy-ai', 'binaries', 'python', 'envs', 'default', 'Lib', 'site-packages');
const CHROME = [
  path.join(LOCAL, 'ms-playwright', 'chromium-1200', 'chrome-win64', 'chrome.exe'),
].find((p) => fs.existsSync(p));

if (!PY || !CHROME) {
  console.log('  (跳过：本机没有找到 Playwright/Chromium，浏览器布局测试不跑)');
  process.exit(0);
}

/** 用异步 spawn 跑子进程。
 *  不用 spawnSync —— 在受限环境里它对 python.exe 会直接 EBUSY，异步 spawn 正常。 */
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('error', (err) => resolve({ stdout, stderr, status: null, error: err }));
    p.on('close', (code) => resolve({ stdout, stderr, status: code, error: null }));
  });
}

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${label}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL ${label}${extra ? '  ' + extra : ''}`); }
};

fs.rmSync(PROBE, { recursive: true, force: true });
fs.mkdirSync(PROBE, { recursive: true });

const LONG = 'Array.from({ length: 80 }, (_, i) => `第 ${i + 1} 段：一段很长的日纪正文，用来验证长文到底是编辑区内部滚，还是整页跟着滚。`).join("\\n\\n")';

// 写作视图探针。刻意用**过去的一天**（不是今天）——
// 用户反馈的原话就是「翻看过去的日纪，内容超出边框（下方）」，
// 所以探针要复现的正是这一支：date != today、正文很长。
fs.writeFileSync(path.join(PROBE, 'write.html'), pageHtml('write'));
fs.writeFileSync(path.join(PROBE, 'write.jsx'), `
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles.css';
import Log from '../src/pages/Log.jsx';
const LONG = ${LONG};
window.hua = {
  bootstrap: () => Promise.resolve({}), onDataChanged: () => {},
  log: { days: () => Promise.resolve([{ date:'2026-10-05', written:true, pinned:false, count:1 }]),
    day: () => Promise.resolve({ date:'2026-10-05', title:'过去的一天', body:LONG, count:1, pinned:false }),
    save: () => Promise.resolve({}), pin: () => Promise.resolve({}) },
  items: { range: () => Promise.resolve([]) },
  search: () => Promise.resolve({ journal: [], items: [] }),
};
function Shell(){ return React.createElement('div', { className:'app' },
  React.createElement('nav', { className:'rail' }, '花'),
  React.createElement('main', { className:'main' },
    React.createElement(Log, { boot:{ today:'2026-10-14', done:[], log:{ date:'2026-10-05' } }, reload:()=>{} }))); }
createRoot(document.getElementById('root')).render(React.createElement(Shell));
`);

// 日历视图探针
fs.writeFileSync(path.join(PROBE, 'cal.html'), pageHtml('cal'));
fs.writeFileSync(path.join(PROBE, 'cal.jsx'), `
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles.css';
import Log from '../src/pages/Log.jsx';
const LONG = ${LONG};
window.hua = {
  bootstrap: () => Promise.resolve({}), onDataChanged: () => {},
  log: { days: () => Promise.resolve([]), day: () => Promise.resolve({}), save: () => Promise.resolve({}), pin: () => Promise.resolve({}) },
  items: { range: () => Promise.resolve([]) },
  search: () => Promise.resolve({ journal: [], items: [] }),
};
function Shell(){ return React.createElement('div', { className:'app' },
  React.createElement('nav', { className:'rail' }, '花'),
  React.createElement('main', { className:'main' },
    React.createElement(Log, { boot:{ today:'2026-10-14', done:[], log:{ view:'calendar',
      peek:{ date:'2026-10-01', title:'很久以前', body:LONG, count:1, pinned:false, done:[] } } }, reload:()=>{} }))); }
createRoot(document.getElementById('root')).render(React.createElement(Shell));
`);

// 今日页探针：备忘条的增删勾 + 当日日纪点击跳转
fs.writeFileSync(path.join(PROBE, 'today.html'), pageHtml('today'));
fs.writeFileSync(path.join(PROBE, 'today.jsx'), `
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles.css';
import Today from '../src/pages/Today.jsx';
// 一个最小的内存版 hua：只实现今日页真正会调到的几个方法，
// 好让「加一条备忘 → 列表多一条」「点日纪 → 触发跳转」能在真浏览器里跑通。
let memos = [{ id:1, text:'记得交表格', time:'', note:'周五前交到前台' }];
let nextId = 2;
const calls = [];
window.__calls = calls;
// 真应用每次改动后都会重新 bootstrap，列表由 SQLite 排好序（有时间的按时刻）。
// 探针这里也照着排一遍，否则会拿「插入顺序」当「显示顺序」，测出假失败。
const sortMemos = () => {
  memos = [...memos].sort((a, b) => {
    const at = a.time || '~', bt = b.time || '~';   // 没时间的排后面
    if (at !== bt) return at < bt ? -1 : 1;
    return a.id - b.id;
  });
};
window.hua = {
  bootstrap: () => Promise.resolve({}), onDataChanged: () => {},
  items: { create:(p)=>{ calls.push(['create', p]); return Promise.resolve(); }, carry:()=>Promise.resolve(), reopen:()=>Promise.resolve(),
    update:(p)=>{ calls.push(['update', p]); return Promise.resolve(); },
    drop:()=>Promise.resolve(), remove:()=>Promise.resolve(), reorder:()=>Promise.resolve(),
    pin:()=>Promise.resolve(), range:()=>Promise.resolve([]) },
  journal: { snapshot: ()=>Promise.resolve({count:0}) },
  log: { pin:()=>Promise.resolve() },
  memos: {
    list: () => Promise.resolve(memos),
    create: (p) => { calls.push(['create', p]); memos = [...memos, { id: nextId++, text:p.text, time:p.time||'', note:p.note||'' }]; sortMemos(); return Promise.resolve(memos[memos.length-1]); },
    update: (p) => { calls.push(['update', p]); memos = memos.map(m => m.id===p.id ? {...m, ...p.patch} : m); sortMemos(); return Promise.resolve(); },
    remove: (p) => { calls.push(['remove', p]); memos = memos.filter(m => m.id!==p.id); return Promise.resolve(); },
    reorder: () => Promise.resolve(),
  },
};
const boot = {
  today: '2026-10-14', items: [], backlog: [], done: [], upcoming: [], upcomingFar: 0,
  reflections: [], todayLog: { date:'2026-10-14', body:'', title:'', pinned:false, count:0 },
  snapshotWritten: false, tags: [], pins: { logs:[], items:[], reflections:[] },
  memos, sleep: null,
  settings: { dayStartHour: 4, theme: 'paper', dataDir: '/tmp/hua' },
};
function Shell(){
  const [b, setB] = React.useState(boot);
  const reload = () => setB((prev) => ({ ...prev, memos: [...memos] }));
  return React.createElement('div', { className:'app' },
    React.createElement('nav', { className:'rail' }, '花'),
    React.createElement('main', { className:'main' },
      React.createElement(Today, { boot:b, reload, onOpenLogAt:(d)=>{ calls.push(['jump', d]); } })));
}
createRoot(document.getElementById('root')).render(React.createElement(Shell));
`);

// 周程板探针：负荷合计、偏重标记、完成率、拖/点分配
fs.writeFileSync(path.join(PROBE, 'week.html'), pageHtml('week'));
fs.writeFileSync(path.join(PROBE, 'week.jsx'), `
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles.css';
import Week from '../src/pages/Week.jsx';

const WEEK = ['2026-10-19','2026-10-20','2026-10-21','2026-10-22','2026-10-23','2026-10-24','2026-10-25'];
const TODAY = '2026-10-16';
let items = [
  { id:1, date:'2026-10-21', title:'周三四小时', status:'todo', estMinutes:240, actualMinutes:null, tags:[] },
  { id:2, date:'2026-10-21', title:'周三两小时', status:'todo', estMinutes:120, actualMinutes:null, tags:[] },
  { id:3, date:'2026-10-19', title:'周一已完成', status:'done', estMinutes:30, actualMinutes:45, tags:[] },
  { id:6, date:'2026-10-22', title:'周四一件', status:'todo', estMinutes:60, actualMinutes:null, tags:[] },
  { id:7, date:'2026-10-24', title:'周六一件', status:'todo', estMinutes:30, actualMinutes:null, tags:[] },
  { id:4, date:'2026-10-05', title:'遗留甲', status:'todo', estMinutes:90, actualMinutes:null, tags:[] },
  { id:5, date:'2026-10-16', title:'今天的活', status:'todo', estMinutes:45, actualMinutes:null, tags:[] },
  // 固定的：创建在周三，但**不该**被摊到周三那一列
  { id:8, date:'2026-10-21', title:'每天读半小时书', status:'todo', estMinutes:30, actualMinutes:null, pinned:true, tags:['阅读'] },
];
let nextId = 20;
const calls = [];
window.__calls = calls;

// 按主进程 week:board 的形状拼一份。真实算法在 electron/week.cjs，
// 已由 scripts/test-data.cjs 单测；这里只为把界面跑起来。
function buildBoard(){
  const itemsByDate = {}; for (const d of WEEK) itemsByDate[d] = [];
  // 和主进程一致：固定的不摊进日列，单独给 pinned；也不进待分配池
  const pinned = items.filter(it => it.pinned);
  const normal = items.filter(it => !it.pinned);
  for (const it of normal) if (itemsByDate[it.date]) itemsByDate[it.date].push(it);
  const pool = items.filter(it => it.status === 'todo' && !WEEK.includes(it.date) && !it.pinned);
  const perDay = {}; for (const d of WEEK) perDay[d] = itemsByDate[d].reduce((s,it)=> s + (it.status==='done'&&it.actualMinutes ? it.actualMinutes : (it.estMinutes||0)), 0);
  const active = WEEK.filter(d => perDay[d] > 0);
  const total = WEEK.reduce((s,d)=> s + perDay[d], 0);
  const avg = active.length ? Math.round(total/active.length) : 0;
  const heavy = active.length >= 3 ? WEEK.filter(d => perDay[d] >= 120 && perDay[d] >= avg*1.5) : [];
  const all = WEEK.flatMap(d => itemsByDate[d]);
  const done = all.filter(i=>i.status==='done').length;
  const todo = all.filter(i=>i.status==='todo').length;
  const dropped = all.filter(i=>i.status==='dropped').length;
  const t = done + todo + dropped;   // 放弃按未完成计，进分母
  return { weekStart:WEEK[0], weekEnd:WEEK[6], weekKey:'2026-W43', today:TODAY, days:WEEK,
    itemsByDate, pinned, pool,
    load:{ perDay, total, avg, heavy, activeDays:active.length },
    completion:{ done, todo, dropped, total:t, rate: t? done/t : null, pct: t? Math.round(done/t*100):null },
    prevStart:'2026-10-12', nextStart:'2026-10-26', isThisWeek:false, isNextWeek:true, isPast:false };
}
window.hua = {
  bootstrap: () => Promise.resolve({}), onDataChanged: () => {},
  week: { board: () => Promise.resolve(buildBoard()) },
  items: {
    carry: (p) => { calls.push(['carry', p]); items = items.map(it => p.ids.includes(it.id) ? {...it, date:p.date} : it); return Promise.resolve([]); },
    create: (p) => { calls.push(['create', p]); items = [...items, { id: nextId++, date:p.date, title:p.title, status:'todo', estMinutes:null, actualMinutes:null, tags:[] }]; return Promise.resolve({}); },
    complete: (p) => { calls.push(['complete', p]); return Promise.resolve({}); },
    update: (p) => { calls.push(['update', p]); items = items.map(it => it.id === p.id ? {...it, ...p.patch} : it); return Promise.resolve({}); },
  },
};
function Shell(){
  const [, setN] = React.useState(0);
  return React.createElement('div', { className:'app' },
    React.createElement('nav', { className:'rail' }, '花'),
    React.createElement('main', { className:'main' },
      React.createElement(Week, { boot:{ today:TODAY }, reload:()=>setN(v=>v+1) })));
}
createRoot(document.getElementById('root')).render(React.createElement(Shell));
`);

function pageHtml(name) {
  // 用途是自检 —— 一个永远绿的测试没有意义，得能证明它抓得住这个 bug。
  // 跑 `HUA_BREAK=1 node scripts/test-browser.mjs`，应当看到 FAIL。
  const broken = process.env.HUA_BREAK
    ? '<style>.editor-wrap > div:not(.editor-tools){overflow:visible!important;flex:none!important}</style>'
    : '';
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>${name}</title>${broken}</head>` +
    `<body><div id="root"></div><script type="module" src="/tmp-browser-test/${name}.jsx"></script></body></html>`;
}

async function freePort(p) {
  return new Promise((res) => {
    const s = net.createServer();
    s.once('error', () => res(false));
    s.once('listening', () => s.close(() => res(true)));
    s.listen(p, '127.0.0.1');
  });
}

const vite = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const vlog = path.join(PROBE, 'vite.log');
const vout = fs.openSync(vlog, 'w');
// --host 127.0.0.1 必须显式给：Vite 默认 host=localhost，在 Windows 上会只绑到 IPv6 的 ::1，
// 于是探活用的 127.0.0.1 一直 ECONNREFUSED，脚本误判「服务没起来」直接跳过。
// 钉死成 IPv4，探活 / Playwright / 静态服务三边才是同一个地址。
const server = spawn(
  process.execPath,
  [vite, '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
  { cwd: ROOT, stdio: ['ignore', vout, vout] }
);
let serverExit = null;
server.on('exit', (code, sig) => { serverExit = { code, sig }; });

const cleanup = () => {
  try { server.kill(); } catch {}
  if (!process.env.HUA_KEEP) fs.rmSync(PROBE, { recursive: true, force: true });
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 探一下端口是否已经在监听（纯 TCP，不依赖 HTTP 内容） */
function portOpen(p, timeout = 600) {
  return new Promise((res) => {
    const s = net.connect(p, '127.0.0.1');
    const done = (v) => { try { s.destroy(); } catch {} res(v); };
    s.setTimeout(timeout);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

try {
  // 等服务器起来（最多 ~20 秒，Vite 首次冷启动会慢）
  let up = false;
  for (let i = 0; i < 80; i++) {
    await wait(250);
    if (serverExit) break;                 // 进程已经退了，再等也没用
    if (await portOpen(PORT)) { up = true; break; }
  }
  if (!up) {
    // 别再静默跳过 —— 把 vite 的日志摊出来，否则「没起来」查无对证
    let log = '';
    try { log = fs.readFileSync(vlog, 'utf8').trim(); } catch {}
    console.log('  (跳过：本地服务没起来，浏览器布局测试不跑)');
    if (serverExit) console.log(`  vite 进程已退出：code=${serverExit.code} sig=${serverExit.sig}`);
    if (log) console.log('  --- vite 日志 ---\n' + log.split('\n').map((l) => '  ' + l).join('\n'));
    cleanup();
    process.exit(0);
  }
  await wait(600);   // 再给一点时间，确保能响应静态文件

  const script = path.join(PROBE, 'check.py');
  fs.writeFileSync(script, pyScript(PORT, CHROME));
  const env = { ...process.env };
  if (PY !== VENV_PY) env.PYTHONPATH = SITE;   // 借 venv 的 site-packages 找 playwright
  const r = await run(PY, [script], { cwd: ROOT, env });
  process.stdout.write(r.stdout || '');
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.error) console.error('  运行 Python 出错：', r.error.message);
  if (r.status !== 0) console.error(`  Python 退出码：${r.status}`);
  // Python 里也用 ok 行输出，自己统计
  const out = r.stdout || '';
  pass = (out.match(/^ {2}ok /gm) || []).length;
  fail = (out.match(/^ {2}FAIL /gm) || []).length;
  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  cleanup();
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error('浏览器布局测试出错：', e.message);
  cleanup();
  process.exit(1);
}

function pyScript(port, chrome) {
  return `
import json
from playwright.sync_api import sync_playwright
BASE = "http://127.0.0.1:${port}"
EXE = r"${chrome}"
pass_ = 0
def ok(label, cond, extra=""):
    global pass_
    if cond:
        print("  ok   " + label + (("  " + str(extra)) if extra else ""))
    else:
        print("  FAIL " + label + (("  " + str(extra)) if extra else ""))
def box(p, sel):
    return p.evaluate("(sel)=>{const el=document.querySelector(sel); if(!el) return null;"
        "const cs=getComputedStyle(el),r=el.getBoundingClientRect();"
        "return {h:Math.round(r.height),scrollH:el.scrollHeight,clientH:el.clientHeight,"
        "overflowY:cs.overflowY,canScroll:el.scrollHeight>el.clientHeight+1};}", sel)
with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path=EXE)
    p = b.new_page(viewport={"width":1400,"height":800})
    errs=[]
    p.on("pageerror", lambda e: errs.append(str(e)))

    print("\\n[浏览器] 日纪写作：长文只有编辑区内部滚")
    p.goto(BASE + "/tmp-browser-test/write.html", wait_until="networkidle")
    p.wait_for_timeout(1500)
    doc = p.evaluate("()=>({sh:document.documentElement.scrollHeight, wh:window.innerHeight})")
    ok("页面本身不滚（scrollHeight ≈ 视口高）", abs(doc["sh"]-doc["wh"])<=2, f'{doc["sh"]} vs {doc["wh"]}')
    scroller = ".editor-wrap > div:not(.editor-tools)"
    ew = box(p, scroller)
    ok("编辑器的滚动容器存在", ew is not None)
    ok("滚动容器 overflow:auto", ew and ew["overflowY"]=="auto", ew["overflowY"] if ew else "")
    ok("滚动容器被有界（clientH < scrollH，即内容超了但框住了）",
       ew and ew["clientH"] < ew["scrollH"], f'client {ew["clientH"]} / scroll {ew["scrollH"]}' if ew else "")
    ok("滚动容器真的能滚（scrollHeight > clientHeight）", ew and ew["canScroll"])
    ti = box(p, ".tiptap")
    ok(".tiptap 不再自己当滚动容器（overflow 不是 auto）", ti and ti["overflowY"]!="auto", ti["overflowY"] if ti else "")

    # 「内容超出边框（下方）」的直接量法：编辑器的外框必须整体待在窗口里，
    # 底边不能被长文顶到屏幕外，框高也不能随内容无限长高。
    wrapbox = p.evaluate("()=>{const el=document.querySelector('.editor-wrap'); if(!el) return null;"
        "const r=el.getBoundingClientRect(); return {top:Math.round(r.top),bottom:Math.round(r.bottom),wh:window.innerHeight};}")
    ok("编辑器外框底边没被内容顶出屏幕（下方不超框）",
       wrapbox and wrapbox["bottom"] <= wrapbox["wh"]+1,
       f'底边 {wrapbox["bottom"]} / 窗口 {wrapbox["wh"]}' if wrapbox else "")
    # 「内容超出边框（下方）」的直接量法：在编辑器外框下沿取几个点，
    # 用 elementFromPoint 看命中的是不是编辑器内部的东西。
    # 修复前：正文没被框住，会画到边框外面去 → 命中 <p> → FAIL。
    # 修复后：正文被滚动容器裁掉 → 命中的是页面本身 → PASS。
    spill = p.evaluate("""()=>{const w=document.querySelector('.editor-wrap'); if(!w) return null;
        const r=w.getBoundingClientRect();
        const ys=[r.bottom+4, r.bottom+30, r.bottom+80].filter(y=>y<window.innerHeight-2);
        let hits=0; for(const y of ys){ const el=document.elementFromPoint(r.left+40, y);
          if(el && w.contains(el)) hits++; }
        return {bottom:Math.round(r.bottom), tested:ys.length, hits};}""")
    ok("编辑器边框下方没有正文漏出来（内容被框住，不溢出边框）",
       spill and spill["hits"]==0,
       f'下方采样 {spill["tested"]} 点，漏出 {spill["hits"]} 点' if spill else "")

    # 在末尾连续输入，滚动量应随内容增长，且最后一次输入后光标在可视区内
    p.evaluate("(sel)=>{const s=document.querySelector(sel); s.scrollTop=s.scrollHeight;}", scroller)
    p.wait_for_timeout(150)
    bxy = p.evaluate("(sel)=>{const r=document.querySelector(sel).getBoundingClientRect(); return {x:r.left+r.width/2,y:r.bottom-20};}", scroller)
    p.mouse.click(bxy["x"], bxy["y"])
    p.keyboard.press("End")
    for i in range(12):
        p.keyboard.type("继续写一行字，看光标跟不跟。")
        p.keyboard.press("Enter")
        p.wait_for_timeout(50)
    p.wait_for_timeout(250)
    after = p.evaluate("""(sel)=>{const s=document.querySelector(sel);
        const ps=[...document.querySelectorAll('.tiptap p')]; const last=ps[ps.length-1];
        const lr=last.getBoundingClientRect();
        const w=document.querySelector('.editor-wrap').getBoundingClientRect();
        return {scrollTop:Math.round(s.scrollTop), canScroll:s.scrollHeight>s.clientHeight+1,
          lastViewTop:Math.round(lr.top), lastViewBottom:Math.round(lr.bottom),
          boxViewTop:Math.round(w.top), boxViewBottom:Math.round(w.bottom),
          sh:document.documentElement.scrollHeight, wh:window.innerHeight};}""", scroller)
    ok("输入过程中容器在滚动", after["scrollTop"]>0, after["scrollTop"])
    # 参照系用**编辑器外框**（有界的那个），不是滚动容器自己 ——
    # 修复前滚动容器会跟着内容长高，拿它当参照永远「装得下」，等于白测。
    ok("输入后末行落在编辑框可视区内（不在框外）",
       after["boxViewTop"]-2 <= after["lastViewTop"] and after["lastViewBottom"] <= after["boxViewBottom"]+2,
       f'末行 {after["lastViewTop"]}–{after["lastViewBottom"]} / 框 {after["boxViewTop"]}–{after["boxViewBottom"]}')
    ok("持续输入时页面依然不滚", abs(after["sh"]-after["wh"])<=2, f'{after["sh"]} vs {after["wh"]}')

    print("\\n[浏览器] 日历预览：长文只有预览栏内部滚")
    p.goto(BASE + "/tmp-browser-test/cal.html", wait_until="networkidle")
    p.wait_for_timeout(1200)
    doc2 = p.evaluate("()=>({sh:document.documentElement.scrollHeight, wh:window.innerHeight})")
    ok("日历页页面本身不滚", abs(doc2["sh"]-doc2["wh"])<=2, f'{doc2["sh"]} vs {doc2["wh"]}')
    pk = box(p, ".calpeek")
    ok("预览面板存在", pk is not None)
    ok("预览面板 overflow:auto", pk and pk["overflowY"]=="auto", pk["overflowY"] if pk else "")
    ok("预览面板被有界且内部滚（长文不撑破边界）",
       pk and pk["clientH"] < pk["scrollH"] and pk["canScroll"],
       f'client {pk["clientH"]} / scroll {pk["scrollH"]}' if pk else "")
    cal = box(p, ".calcol")
    ok("日历左栏仍完整可见（不被长文挤走）", cal and cal["clientH"] >= cal["scrollH"]-1)

    # ---- 今日页：备忘条真的能加 / 勾 / 删，日纪真的能点跳 ----
    print("\\n[浏览器] 今日页：备忘条可增删勾 + 当日日纪可点跳")
    p.goto(BASE + "/tmp-browser-test/today.html", wait_until="networkidle")
    p.wait_for_timeout(1000)

    n0 = p.locator(".memorow").count()
    ok("初始渲染出已有备忘", n0 == 1, f"{n0} 行")

    # 加一条带时间的
    p.fill(".memoadd .memo-time-input", "14:00")
    p.fill(".memoadd .memo-text-input", "项目周会")
    p.fill(".memoadd .memo-note-input", "带好会议记录本")
    p.click(".memoadd .composer-btn")
    p.wait_for_timeout(500)
    n1 = p.locator(".memorow").count()
    ok("点「加一条」后列表多一行", n1 == 2, f"{n0} -> {n1}")
    ok("新备忘的文字出现", p.locator(".memo-text", has_text="项目周会").count() == 1)
    ok("新备忘的时间出现", p.locator(".memo-time", has_text="14:00").count() == 1)
    ok("新备忘的补充出现", p.locator(".memo-note", has_text="带好会议记录本").count() == 1)
    # 有时间的应排到没时间的前面
    first_txt = p.locator(".memorow .memo-text").first.inner_text()
    ok("有时间的备忘排前面", first_txt.strip() == "项目周会", first_txt)
    # 调用了数据层，且补充一起送过去了
    created = p.evaluate("()=>window.__calls.filter(c=>c[0]==='create').map(c=>[c[1].text, c[1].note])")
    ok("补充跟着落到了数据层", created == [["项目周会", "带好会议记录本"]], created)

    # 贴士不该像待办：左边是花标，没有可点的完成圆圈
    ok("左边是固定花标", p.locator(".memorow .memo-mark").count() == 2,
       p.locator(".memorow .memo-mark").count())
    ok("没有完成圆圈", p.locator(".memo-check").count() == 0)

    # 点文字就地改，补一句
    p.evaluate("()=>{window.__calls.length=0;}")
    p.locator(".memorow .memo-main").first.click()
    p.wait_for_timeout(300)
    ok("点一条进入编辑态", p.locator(".memorow.editing").count() == 1)
    ok("编辑态里带出了原来的补充",
       p.locator(".memorow.editing .memo-note-input").input_value() == "带好会议记录本",
       p.locator(".memorow.editing .memo-note-input").input_value())
    p.fill(".memorow.editing .memo-note-input", "改成线上会议")
    p.keyboard.press("Enter")
    p.wait_for_timeout(500)
    updated = p.evaluate("()=>window.__calls.filter(c=>c[0]==='update').map(c=>c[1].patch.note)")
    ok("改补充落到了数据层", updated == ["改成线上会议"], updated)
    ok("改完显示新的补充", p.locator(".memo-note", has_text="改成线上会议").count() == 1)

    # 删除一条
    p.locator(".memorow").first.locator("button", has_text="删除").click()
    p.wait_for_timeout(500)
    ok("删除后列表少一行", p.locator(".memorow").count() == 1, p.locator(".memorow").count())
    ok("remove 被调用", p.evaluate("()=>window.__calls.filter(c=>c[0]==='remove').length") == 1)

    # ---- 录入框：一条可以写的线 + 一行很轻的注解 ----
    p.evaluate("()=>{window.__calls.length=0;}")
    # 空着的时候「记下」是藏起来的（不摆一个保存按钮催你）
    op_before = p.evaluate("()=>getComputedStyle(document.querySelector('.composer-btn')).opacity")
    ok("空着时「记下」不可见", float(op_before) < 0.1, op_before)
    p.fill(".composer-hero .composer-title", "录入框测一下")
    p.wait_for_timeout(300)
    op_after = p.evaluate("()=>getComputedStyle(document.querySelector('.composer-btn')).opacity")
    ok("写了字之后「记下」浮出来", float(op_after) > 0.9, op_after)
    ok("注解行里是日期 / 时段 / 预计耗时",
       "今天" in p.locator(".composer-meta").inner_text()
       and "时段" in p.locator(".composer-meta").inner_text()
       and "预计耗时" in p.locator(".composer-meta").inner_text(),
       p.locator(".composer-meta").inner_text().replace("\\n", " "))
    # 三个注解排成一行了，按文本点，别用索引（加一栏就点错）
    p.locator(".composer-meta .ct-link", has_text="预计").click()
    ok("点「预计」弹出快捷档", p.locator(".ct-pop").count() == 1, p.locator(".ct-pop").count())
    ok("弹层里有 30 分钟这一档", p.locator(".ct-pop .dp-chip", has_text="30").count() == 1)
    p.locator(".ct-pop .dp-chip", has_text="30").first.click()
    p.wait_for_timeout(300)
    ok("选完弹层自动收起", p.locator(".ct-pop").count() == 0)
    ok("注解变成「预计 30 分钟」",
       "预计 30 分钟" in p.locator(".composer-meta").inner_text(),
       p.locator(".composer-meta").inner_text().replace("\\n", " "))

    # 日期弹层：Esc 能关掉（原来点开了只能再点一次按钮才收）
    p.locator(".composer-meta .ct-link").first.click()
    p.wait_for_timeout(300)
    ok("点日期注解弹出日期选项", p.locator(".ct-pop").count() == 1)
    p.keyboard.press("Escape")
    p.wait_for_timeout(300)
    ok("Esc 关掉日期弹层", p.locator(".ct-pop").count() == 0)

    # 点别处也能关
    p.locator(".composer-meta .ct-link").first.click()
    p.wait_for_timeout(250)
    p.click(".pagehead")
    p.wait_for_timeout(250)
    ok("点别处也关掉弹层", p.locator(".ct-pop").count() == 0)

    # 回车记下，预计耗时一起带过去
    p.locator(".composer-hero .composer-title").press("Enter")
    p.wait_for_timeout(700)
    created_item = p.evaluate("()=>window.__calls.filter(c=>c[0]==='create').map(c=>[c[1].title, c[1].estMinutes])")
    ok("回车就记下，且带上预计耗时", created_item == [["录入框测一下", 30]], created_item)
    ok("记完输入框清空", p.locator(".composer-hero .composer-title").input_value() == "",
       p.locator(".composer-hero .composer-title").input_value())

    # 当日日纪：点标题按钮应触发跳转到「今天」
    p.evaluate("()=>{window.__calls.length=0;}")
    p.click(".rec-title-btn")
    p.wait_for_timeout(200)
    jump = p.evaluate("()=>window.__calls.filter(c=>c[0]==='jump').map(c=>c[1])")
    ok("点日纪标题触发跳转，且跳到今天", jump == ["2026-10-14"], jump)
    # 空状态也要能点
    p.evaluate("()=>{window.__calls.length=0;}")
    p.click(".empty.clickable")
    p.wait_for_timeout(200)
    jump2 = p.evaluate("()=>window.__calls.filter(c=>c[0]==='jump').map(c=>c[1])")
    ok("点「今天还没写」空状态也能跳", jump2 == ["2026-10-14"], jump2)

    # ---- 周程板：负荷分析 + 完成率 + 分配 ----
    print("\\n[浏览器] 周程：负荷合计、偏重标记、完成率、分配")
    p.goto(BASE + "/tmp-browser-test/week.html", wait_until="networkidle")
    p.wait_for_timeout(1200)

    ok("渲染出 7 天列", p.locator(".weekcol").count() == 7, p.locator(".weekcol").count())
    ok("待分配池渲染出 2 条", p.locator(".wpitem").count() == 2, p.locator(".wpitem").count())

    # 负荷：周三 360 分 = 6 小时，且是唯一偏重的那天
    loads = " ".join(p.locator(".wc-load").all_inner_texts()).replace("\\n", " ")
    ok("每天显示负荷合计", "6 小时" in loads and "45 分" in loads, loads)
    ok("只有周三被标偏重",
       p.locator(".weekcol.heavy").count() == 1 and p.locator(".wc-heavy").count() == 1,
       p.locator(".weekcol.heavy").count())
    heavy_wd = p.locator(".weekcol.heavy .wc-wd").inner_text()
    ok("偏重的是周三", heavy_wd.strip() == "周三", heavy_wd)

    # 完成率：本周 1 done / 5 → 20%
    stats_txt = p.locator(".weekstats").inner_text()
    ok("总览里有完成率 20%", "20%" in stats_txt, stats_txt.replace("\\n", " "))

    # ---- 固定的事项：不摊进日列，单独一条带子 ----
    ok("有固定带子", p.locator(".weekpinned").count() == 1, p.locator(".weekpinned").count())
    wkp_txt = p.locator(".weekpinned").inner_text().replace("\\n", " ")
    ok("带子里有那条固定的", "每天读半小时书" in wkp_txt, wkp_txt)
    ok("带子标了「固定」", "固定" in wkp_txt, wkp_txt)
    ok("带子说明了不占某一天", "不占某一天" in wkp_txt, wkp_txt)
    ok("固定的没被摊到任何一天",
       p.locator(".weekcol .wchip", has_text="每天读半小时书").count() == 0,
       p.locator(".weekcol .wchip", has_text="每天读半小时书").count())
    ok("固定的也不在待分配池里",
       p.locator(".weekpool", has_text="每天读半小时书").count() == 0)
    ok("固定带子里不再显示标签（标签已撤）", "阅读" not in wkp_txt, wkp_txt)
    ok("总览里有「偏重」那一项", "偏重" in stats_txt)
    ok("完成率带了件数", "1 / 5 件" in stats_txt, stats_txt.replace("\\n", " "))

    # 点选分配：点池子里一条 → 再点周三那一列
    p.locator(".wpitem").first.click()
    p.wait_for_timeout(200)
    ok("点中池子里的条目后高亮", p.locator(".wpitem.on").count() == 1)
    p.evaluate("()=>{window.__calls.length=0;}")
    p.evaluate("()=>{document.querySelectorAll('.weekcol')[2].click();}")
    p.wait_for_timeout(600)
    carried = p.evaluate("()=>window.__calls.filter(c=>c[0]==='carry').map(c=>[c[1].ids, c[1].date])")
    ok("分配到周三：carry 带着正确的日期", carried == [[[4], "2026-10-21"]], carried)
    ok("分配后池子少一条", p.locator(".wpitem").count() == 1, p.locator(".wpitem").count())
    ok("周三那一列多了一条",
       p.locator(".weekcol").nth(2).locator(".wchip").count() == 3,
       p.locator(".weekcol").nth(2).locator(".wchip").count())
    # 分完要重算负荷：360 + 90 = 450 分 = 7.5 小时
    after_loads = " ".join(p.locator(".wc-load").all_inner_texts()).replace("\\n", " ")
    ok("分配后负荷跟着重算", "7.5 小时" in after_loads, after_loads)

    # 在某天直接加一件事（＋ 按钮 → 小表单：标题 + 预计 + 开始）
    p.evaluate("()=>{window.__calls.length=0;}")
    p.locator(".weekcol").nth(0).locator(".wc-add").click()
    p.wait_for_timeout(300)
    ok("＋ 打开加事表单", p.locator(".wkadd").count() == 1, p.locator(".wkadd").count())
    ok("表单里能填预计耗时", p.locator(".wkadd .wkadd-num").count() == 1)
    ok("表单里能填开始时间", p.locator(".wkadd .wkadd-time").count() == 1)
    p.fill(".wkadd-title", "周一新加的事")
    p.fill(".wkadd .wkadd-num", "45")
    p.fill(".wkadd .wkadd-time", "09:30")
    p.keyboard.press("Enter")
    p.wait_for_timeout(600)
    created = p.evaluate("()=>window.__calls.filter(c=>c[0]==='create').map(c=>[c[1].title, c[1].date, c[1].estMinutes, c[1].startTime])")
    ok("加的事带上了日期/耗时/开始时间",
       created == [["周一新加的事", "2026-10-19", 45, "09:30"]], created)
    ok("加完表单收起", p.locator(".wkadd").count() == 0)

    # 退回待分配：把周一那条从这天拿掉 → 日期清空（不是挪到今天）
    p.evaluate("()=>{window.__calls.length=0;}")
    p.wait_for_timeout(400)
    p.locator(".weekcol").nth(0).locator(".wchip-x").first.click()
    p.wait_for_timeout(600)
    back = p.evaluate("()=>window.__calls.filter(c=>c[0]==='update').map(c=>c[1].patch.date)")
    allcalls = p.evaluate("()=>JSON.stringify(window.__calls)")
    ok("退回待分配 = 把日期清空，落到池子里", back == [""], "back=" + str(back) + " all=" + allcalls)

    # ---- 右键：在某天加事 ----
    p.evaluate("()=>{window.__calls.length=0;}")
    p.locator(".weekcol").nth(4).click(button="right")
    p.wait_for_timeout(300)
    ok("在某天右键弹出菜单", p.locator(".ctxmenu").count() == 1, p.locator(".ctxmenu").count())
    menu_txt = p.locator(".ctxmenu").inner_text().replace("\\n", " ")
    ok("菜单里有「加一件事」", "加一件事" in menu_txt, menu_txt)
    ok("菜单标出是哪一天", "周五" in menu_txt and "10/23" in menu_txt, menu_txt)
    p.locator(".ctxmenu button", has_text="加一件事").click()
    p.wait_for_timeout(300)
    ok("点完菜单关掉了", p.locator(".ctxmenu").count() == 0)
    ok("右键后打开了加事表单", p.locator(".wkadd").count() == 1)
    ok("表单标出了是哪一天", "周五" in p.locator(".wkadd-head").inner_text(),
       p.locator(".wkadd-head").inner_text())
    p.fill(".wkadd-title", "右键加的")
    p.keyboard.press("Enter")
    p.wait_for_timeout(600)
    created2 = p.evaluate("()=>window.__calls.filter(c=>c[0]==='create').map(c=>[c[1].title, c[1].date])")
    ok("右键加的事落到那天", created2 == [["右键加的", "2026-10-23"]], created2)

    # ---- 右键：改已有的 ----
    p.locator(".weekcol").nth(2).locator(".wchip").first.click(button="right")
    p.wait_for_timeout(300)
    ok("在某条上右键弹出菜单", p.locator(".ctxmenu").count() == 1)
    item_txt = p.locator(".ctxmenu").inner_text().replace("\\n", " ")
    ok("菜单里有「修改」", "修改" in item_txt, item_txt)
    ok("菜单标出是哪一条", "周三四小时" in item_txt, item_txt)
    ok("菜单里有「标记完成」和「退回待分配」",
       "标记完成" in item_txt and "退回待分配" in item_txt, item_txt)
    p.locator(".ctxmenu button", has_text="修改").click()
    p.wait_for_timeout(500)
    ok("点「修改」打开修改弹框", p.locator(".modal").count() == 1, p.locator(".modal").count())
    modal_txt = p.locator(".modal").inner_text()
    ok("弹框标题是「修改事项」", "修改事项" in modal_txt)
    ok("弹框里带出了原标题",
       p.locator(".modal input[type=text]").first.input_value() == "周三四小时",
       p.locator(".modal input[type=text]").first.input_value())
    ok("弹框里带出了原日期",
       p.locator(".modal input[type=date]").first.input_value() == "2026-10-21")
    p.keyboard.press("Escape")
    p.wait_for_timeout(300)
    ok("Esc 关掉弹框", p.locator(".modal").count() == 0)

    # Esc / 点别处也能关掉右键菜单
    p.locator(".weekcol").nth(0).click(button="right")
    p.wait_for_timeout(250)
    ok("再次右键能开出来", p.locator(".ctxmenu").count() == 1)
    p.keyboard.press("Escape")
    p.wait_for_timeout(250)
    ok("Esc 关掉右键菜单", p.locator(".ctxmenu").count() == 0)

    ok("周程页控制台无报错", len(errs)==0, errs[:1])
    b.close()
`;
}
