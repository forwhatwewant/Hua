/* 界面组件测试的驱动器：SSR 构建 -> 执行 -> 清理临时产物。
   单独放在这里是因为 vite 必须先构建（Node 不认 JSX），而构建产物又要放在项目内
   —— 放在项目外的话，产物里 import 'react' 会解析不到 node_modules。 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const OUT = path.join(ROOT, '.tmp-ui-test');   // 项目内，跑完就删

const node = process.execPath;
const vite = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

const built = spawnSync(
  node,
  [vite, 'build', '--ssr', 'scripts/test-ui.jsx', '--outDir', '.tmp-ui-test', '--logLevel', 'error'],
  { cwd: ROOT, stdio: 'inherit' }
);
if (built.status !== 0) {
  fs.rmSync(OUT, { recursive: true, force: true });
  console.error('界面测试构建失败');
  process.exit(1);
}

const ran = spawnSync(node, [path.join(OUT, 'test-ui.mjs')], { cwd: ROOT, stdio: 'inherit' });
const code = ran.status ?? 1;

fs.rmSync(OUT, { recursive: true, force: true });
process.exit(code);
