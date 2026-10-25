#!/usr/bin/env node
'use strict';
/* 提交前自检：仓库里不该出现的东西，一律拦下来。
 *
 * 为什么需要它：2026-10-21 / 10-22 / 10-24 三次把私人路径推上公开仓库，
 * 前两次靠「我记得要检查」，第三次还是漏了。记性不可靠，所以：
 *   - 接进 npm test
 *   - 再挂一个 .githooks/pre-push，推不出去就是推不出去
 *   - 推完还有 check-remote 从远端真实内容再验一遍（规则同一份，见 leak-rules.cjs）
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
const { scanText, shouldScan, report } = require('./leak-rules.cjs');

const ROOT = path.join(__dirname, '..');

const argv = process.argv.slice(2);
const COMMIT_MODE = argv[0] === '--commits';
const COMMITS = COMMIT_MODE ? argv.slice(1).filter(Boolean) : [];

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

function scan() {
  const hits = [];
  const sources = COMMIT_MODE ? commitSources() : worktreeSources();

  for (const src of sources) {
    for (const rel of src.files()) {
      if (!shouldScan(rel)) continue;
      hits.push(...scanText(src.read(rel), src.label(rel)));
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

report(hits);
process.exit(1);
