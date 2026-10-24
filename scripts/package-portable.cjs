'use strict';
/* 打包成「免安装绿色版」——双击 hua.exe 即可启动，无需命令行。
   思路：Electron 运行时（node_modules/electron/dist）整目录拷贝，
   把 electron.exe 改名为 hua.exe，应用源码塞进 resources/app/。

   运行时主进程只依赖 node: 内置模块 + electron，不依赖任何 npm 包，
   所以发布版【不需要】带 node_modules。 */

const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..');                       // 项目根
const ELECTRON_DIST = path.join(SRC, 'node_modules', 'electron', 'dist');
const OUT = process.env.HUA_OUT || path.resolve(SRC, '..', '..', 'HuaApp');   // 绿色版输出目录（可用 HUA_OUT 覆盖）
const APP = path.join(OUT, 'resources', 'app');

function info(...a) { console.log('[pkg]', ...a); }
function fail(msg) { console.error('[pkg] ERROR:', msg); process.exit(1); }

if (!fs.existsSync(ELECTRON_DIST)) fail(`找不到 Electron 运行时：${ELECTRON_DIST}`);
if (!fs.existsSync(path.join(SRC, 'dist', 'index.html'))) fail('dist/ 不存在，请先 npm run build');

// 图标：纯 Node 生成，各几毫秒。原先是独立的 npm 脚本，合并进来是为了少 spawn 一次 npm
// （npm 每次启动在本机有 ~1s 开销，三次就是 3 秒白等）。
require('./make-icon.cjs');   // build/tray.png
require('./make-ico.cjs');    // build/flower.ico

const exeTo = path.join(OUT, 'hua.exe');

// 1) Electron 运行时（368MB）：版本没变就别删别拷 —— 这是打包慢的根源。
//    真正会变的只有 resources/app 里那几百 KB 的应用源码。
const srcVer = fs.readFileSync(path.join(ELECTRON_DIST, 'version'), 'utf8').trim();
const dstVerFile = path.join(OUT, 'version');
const sameRuntime =
  fs.existsSync(exeTo) &&
  fs.existsSync(dstVerFile) &&
  fs.readFileSync(dstVerFile, 'utf8').trim() === srcVer;

if (process.argv.includes('--full') || !sameRuntime) {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.cpSync(ELECTRON_DIST, OUT, { recursive: true });
  const exeFrom = path.join(OUT, 'electron.exe');
  if (!fs.existsSync(exeFrom)) fail('electron.exe 未找到');
  fs.renameSync(exeFrom, exeTo);
  info('全量：拷入 Electron 运行时', srcVer, '->', OUT);
} else {
  info('增量：Electron 运行时', srcVer, '未变，跳过 368MB 拷贝（--full 可强制）');
}

// 2) 刷新 resources/app —— 只动这几百 KB，应用开着也能打包
try { fs.rmSync(APP, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }); } catch { /* 占用就走覆盖 */ }
fs.mkdirSync(APP, { recursive: true });

// 先删后拷：直接 cpSync(force) 只会覆盖同名文件，上一版改名后的旧产物会越堆越多。
// 万一删除被占用（应用没关），退化为覆盖，再由下面 prune 兜底。
function freshCopy(name) {
  const src = path.join(SRC, name);
  const dst = path.join(APP, name);
  try { fs.rmSync(dst, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }); } catch { /* 忽略 */ }
  fs.cpSync(src, dst, { recursive: true, force: true });
}
freshCopy('electron');   // 主进程代码
freshCopy('dist');       // 前端构建产物
freshCopy('build');      // 资源（托盘图标等）

// 2d) 清掉 dist/assets 里不属于本次构建的旧文件（Vite 每次产出带 hash 的新文件名，
//     旧的不会被覆盖，留着只是占空间 + 干扰排查）
const assetsDir = path.join(APP, 'dist', 'assets');
if (fs.existsSync(assetsDir)) {
  const want = new Set(fs.readdirSync(path.join(SRC, 'dist', 'assets')));
  let removed = 0;
  for (const f of fs.readdirSync(assetsDir)) {
    if (!want.has(f)) { fs.rmSync(path.join(assetsDir, f), { force: true }); removed++; }
  }
  if (removed) info('清理旧构建产物', removed, '个');
}
info('copied app source (electron/ dist/ build/) -> resources/app');

// 4d) 写一份精简 package.json（electron 只认 main 字段）
const pkg = {
  name: 'hua',
  version: require(path.join(SRC, 'package.json')).version,
  private: true,
  main: 'electron/main.cjs',
  description: '花 —— 记录每天要做的事、做完的事，以及做完之后的心得'
};
fs.writeFileSync(path.join(APP, 'package.json'), JSON.stringify(pkg, null, 2));
info('wrote resources/app/package.json');

// 5) 一份使用说明
const readme = [
  '花（Hua）— 桌面端「任务 / 完成 / 心得」记录工具',
  '',
  '【启动】',
  '  直接双击 hua.exe 即可。也可把 hua.exe 或本文件夹固定到任务栏 / 开始菜单。',
  '  桌面上的「花」快捷方式已指向它。',
  '',
  '【你的数据在哪里】',
  '  默认数据目录：非系统盘根目录下的 Hua（也可以在「设置」里改）',
  '  —— 事项库（SQLite）与每周心得（Markdown）都在这里。',
  '  —— 备份 = 把整个数据目录拷走即可。',
  '  —— 在「设置」里可改数据目录位置。',
  '',
  '【换电脑 / 移动】',
  '  绿色版无需安装。整体移动 HuaApp 文件夹即可，但桌面的快捷方式要重新指向新位置。',
  '',
  '【关掉窗口 ≠ 退出】',
  '  点右上角关闭只是收进托盘（右下角图标）。从托盘菜单「退出」才真正退出。',
  '  快捷键 Ctrl+Shift+H 唤起「快速记录」。',
  '',
  '【版本】' + pkg.version
].join('\n');
fs.writeFileSync(path.join(OUT, '使用说明.txt'), readme);
info('wrote 使用说明.txt');

info('DONE ->', OUT);
info('总大小约', (fs.statSync(exeTo).size / 1024 / 1024).toFixed(0), 'MB（仅可执行文件）');
