#!/usr/bin/env node
'use strict';
/* 提交前自检：仓库里不该出现的东西，一律拦下来。
 *
 * 为什么需要它：2026-10-21 / 10-22 / 10-24 三次把私人路径推上公开仓库，
 * 前两次靠「我记得要检查」，第三次还是漏了。记性不可靠，所以：
 *   - 接进 npm test
 *   - 再挂一个 .githooks/pre-push，推不出去就是推不出去
 *
 * 两种模式：
 *   node scripts/check-leaks.cjs                    扫工作区（git ls-files）
 *   node scripts/check-leaks.cjs --commits <sha>... 扫指定提交的树
 *      —— pre-push 用它检查「这次要推的提交」，因为泄漏可能提交过又被删掉，
 *         工作区看着干净，历史里还留着。
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

const argv = process.argv.slice(2);
const COMMIT_MODE = argv[0] === '--commits';
const COMMITS = COMMIT_MODE ? argv.slice(1).filter(Boolean) : [];

/* ---------- 规则 ---------- */

const RULES = [
  {
    name: 'Windows 家目录',
    // C:\Users\someone  /  C:/Users/someone
    re: /[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}[A-Za-z0-9._-]+/g,
    why: '把 Windows 用户名写进了仓库'
  },
  {
    name: 'macOS 家目录',
    re: /\/Users\/[A-Za-z0-9._-]+/g,
    why: '把 macOS 用户名写进了仓库'
  },
  {
    name: 'Linux 家目录',
    re: /\/home\/[A-Za-z0-9._-]+/g,
    why: '把 Linux 用户名写进了仓库'
  },
  {
    name: '写死的盘符路径',
    // 必须紧跟在引号/反引号后面才算「写死的路径」。
    // 不加这个前提，代码里的正则字面量（如 size:\s）会被当成 e:\s 误报（踩过）。
    re: /(['"`])[A-Za-z]:[\\/]{1,2}[A-Za-z0-9_.-]{2,}/g,
    why: '写死了某台机器的盘符路径'
  },
  {
    name: '真实邮箱',
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    why: '可能是真实邮箱'
  }
];

/* 允许出现的：示例域名、GitHub 的 noreply、localhost、测试桩的假邮箱 */
const ALLOW = ['example.com', 'example.org', 'noreply.github.com', 'localhost', '@test'];

/* 本文件自己写着这些规则，别扫自己 */
const FILE_ALLOW = new Set(['scripts/check-leaks.cjs']);

/* package-lock 里的 homepage / repository 字段不归我们管 */
const FILE_SKIP = new Set(['package-lock.json']);

/* ---------- 取文件 ---------- */

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/* 工作区模式：git ls-files 天然排除 node_modules / dist / .git */
function worktreeSources() {
  let files = [];
  try { files = git(['ls-files', '-z']).split('\0').filter(Boolean); } catch { /* 不是 git 仓库 */ }
  return [{
    label: (rel) => rel,
    files: () => files,
    read: (rel) => {
      try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { return null; }
    }
  }];
}

/* 提交模式：逐个提交读它的树 */
function commitSources() {
  return COMMITS.map((sha) => ({
    label: (rel) => `${sha.slice(0, 7)}:${rel}`,
    files: () => {
      try { return git(['ls-tree', '-r', '--name-only', sha]).split('\n').filter(Boolean); } catch { return []; }
    },
    read: (rel) => {
      try { return git(['show', `${sha}:${rel}`]); } catch { return null; }
    }
  }));
}

/* ---------- 扫描 ---------- */

function scan() {
  const hits = [];
  const sources = COMMIT_MODE ? commitSources() : worktreeSources();

  for (const src of sources) {
    for (const rel of src.files()) {
      if (FILE_ALLOW.has(rel) || FILE_SKIP.has(rel)) continue;
      const text = src.read(rel);
      if (!text || text.length > 2 * 1024 * 1024) continue;

      const lines = text.split('\n');
      for (const rule of RULES) {
        for (let i = 0; i < lines.length; i++) {
          const m = lines[i].match(rule.re);
          if (!m) continue;
          for (const raw of m) {
            const found = raw.replace(/^['"`]/, '');   // 盘符规则的第 1 个捕获是引号
            if (ALLOW.some((a) => found.includes(a))) continue;
            hits.push({ where: src.label(rel), line: i + 1, rule: rule.name, found, why: rule.why });
          }
        }
      }
    }
  }
  return hits;
}

const hits = scan();

if (hits.length === 0) {
  console.log(COMMIT_MODE
    ? `  ok   ${COMMITS.length} 个提交里没有私人路径 / 用户名 / 真实邮箱`
    : '  ok   没有发现私人路径 / 用户名 / 真实邮箱');
  process.exit(0);
}

console.log('');
console.log('  FAIL 发现了不该提交的内容：');
console.log('');
for (const h of hits.slice(0, 40)) {
  console.log(`    ${h.where}:${h.line}  [${h.rule}]  ${h.found}`);
  console.log(`      ${h.why}`);
}
if (hits.length > 40) console.log(`    ……还有 ${hits.length - 40} 处`);
console.log('');
console.log('  改法：路径从 os.homedir() / process.env 推出来，别写死。');
console.log('  文档里用占位符（<数据目录>），别写真实路径。');
console.log('');
process.exit(1);
