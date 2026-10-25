#!/usr/bin/env node
'use strict';
/* 推送之后：从**远端真实内容**再验一遍，不信本地。
 *
 * 为什么还要这一道：pre-push 只检查「我打算推的东西」。推完到底远端变成了什么样，
 * 只有真去读一遍才知道 —— 强推、别人推的、API 建的提交，都可能绕过本地检查。
 * 2026-10-24 那次就是「本地干净、远端旧对象还能按 SHA 打开」。
 *
 * 两条路（自动选）：
 *   A. git clone --bare 到临时目录（走 github.com，一次拿全部历史，最准）
 *   B. GitHub API（走 api.github.com）—— github.com 不通时用这个
 *      （实测经常是 github.com 000 / api 200）
 *
 * 扫的范围：**所有分支的所有提交**里的每一份文件内容（按 blob sha 去重）。
 * 规则和 check-leaks 是同一份（scripts/leak-rules.cjs），不会漂移。
 *
 * 用法：
 *   node scripts/check-remote.cjs              # 匿名（仓库是 public）
 *   node scripts/check-remote.cjs --token xxx  # 私有仓库 / 避开限流
 *   GITHUB_TOKEN=xxx node scripts/check-remote.cjs
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { scanText, shouldScan, report } = require('./leak-rules.cjs');

const ROOT = path.join(__dirname, '..');

const argv = process.argv.slice(2);
const TOKEN = (() => {
  const i = argv.indexOf('--token');
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  return process.env.GITHUB_TOKEN || process.env.HUA_GITHUB_TOKEN || '';
})();

/* ---------- 仓库地址 ---------- */

/* 测试用：HUA_REMOTE_URL 直接指定要扫的远端（可以是本地 bare 仓库）。
   加这个是为了能验证「检查真的会红」—— 不能变红的检查等于没有。 */
const OVERRIDE_URL = process.env.HUA_REMOTE_URL || '';

function repoSlug() {
  if (OVERRIDE_URL) return { owner: '(override)', repo: OVERRIDE_URL, url: OVERRIDE_URL };
  const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: ROOT, encoding: 'utf8' }).trim();
  // https://github.com/owner/repo.git  /  git@github.com:owner/repo.git
  const m = url.match(/github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) throw new Error(`看不懂 origin：${url}`);
  return { owner: m[1], repo: m[2], url: `https://github.com/${m[1]}/${m[2]}.git` };
}

/* ---------- 路线 A：clone --bare ---------- */

function scanByClone({ owner, repo }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hua-remote-'));
  const auth = TOKEN ? `x-access-token:${TOKEN}@` : '';
  const url = OVERRIDE_URL ? OVERRIDE_URL : `https://${auth}github.com/${owner}/${repo}.git`;

  try {
    execFileSync('git', ['clone', '--bare', '--quiet', url, dir], {
      cwd: ROOT, stdio: 'pipe', timeout: 90_000
    });
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    return null;   // 让调用方走 API
  }

  const git = (args, bin = false) => execFileSync('git', [`--git-dir=${dir}`, ...args], {
    encoding: bin ? 'buffer' : 'utf8', maxBuffer: 128 * 1024 * 1024
  });

  try {
    const branches = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads']).split('\n').filter(Boolean);
    const commits = git(['rev-list', '--all']).split('\n').filter(Boolean);
    const hits = [];
    const seen = new Set();      // blob sha 去重：同一份内容只扫一次

    for (const sha of commits) {
      const tree = git(['ls-tree', '-r', sha]);      // "<mode> blob <sha>\t<path>"
      for (const line of tree.split('\n')) {
        if (!line) continue;
        const m = line.match(/^\d+ blob ([0-9a-f]+)\t(.+)$/);
        if (!m) continue;
        const [, blobSha, rel] = m;
        if (!shouldScan(rel)) continue;
        const key = `${blobSha}\u0000${rel}`;
        if (seen.has(key)) continue;
        seen.add(key);

        let text;
        try { text = git(['cat-file', 'blob', blobSha], true).toString('utf8'); } catch { continue; }
        hits.push(...scanText(text, `${sha.slice(0, 7)}:${rel}`));
      }
    }

    return { via: 'clone', branches, commits: commits.length, blobs: seen.size, hits };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* ---------- 路线 B：GitHub API ---------- */

function scanByApi({ owner, repo }) {
  const API = `https://api.github.com/repos/${owner}/${repo}`;
  const headers = ['-H', 'Accept: application/vnd.github+json'];
  if (TOKEN) headers.push('-H', `Authorization: Bearer ${TOKEN}`);

  function call(p) {
    const out = spawnSync('curl', ['-s', '--max-time', '60', ...headers, `${API}${p}`],
      { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }).stdout;
    try { return JSON.parse(out); } catch { return { __raw: out }; }
  }

  const branches = call('/branches');
  if (!Array.isArray(branches)) {
    throw new Error(`拿不到分支列表：${branches.message || JSON.stringify(branches).slice(0, 120)}`);
  }

  const hits = [];
  const seenBlob = new Set();
  const seenCommit = new Set();
  let commitCount = 0;

  for (const b of branches) {
    // 该分支的所有提交（默认 100 条足够；多了就分页）
    let page = 1;
    let list = [];
    do {
      const chunk = call(`/commits?sha=${encodeURIComponent(b.name)}&per_page=100&page=${page}`);
      if (!Array.isArray(chunk) || chunk.length === 0) break;
      list = list.concat(chunk);
      page += 1;
    } while (page <= 10);

    for (const c of list) {
      if (seenCommit.has(c.sha)) continue;
      seenCommit.add(c.sha);
      commitCount += 1;

      const full = call(`/git/commits/${c.sha}`);
      const treeSha = full.tree && full.tree.sha;
      if (!treeSha) continue;

      const tree = call(`/git/trees/${treeSha}?recursive=1`);
      if (!Array.isArray(tree.tree)) continue;

      for (const e of tree.tree) {
        if (e.type !== 'blob') continue;
        if (!shouldScan(e.path)) continue;
        const key = `${e.sha}\u0000${e.path}`;
        if (seenBlob.has(key)) continue;
        seenBlob.add(key);

        const blob = call(`/git/blobs/${e.sha}`);
        if (!blob.content) continue;
        const text = Buffer.from(blob.content, blob.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
        hits.push(...scanText(text, `${c.sha.slice(0, 7)}:${e.path}`));
      }
    }
  }

  return { via: 'api', branches: branches.map((b) => b.name), commits: commitCount, blobs: seenBlob.size, hits };
}

/* ---------- 跑 ---------- */

let slug;
try {
  slug = repoSlug();
} catch (e) {
  console.log(`  !! ${e.message}`);
  process.exit(2);
}

console.log(OVERRIDE_URL
  ? `[remote] ${OVERRIDE_URL}（HUA_REMOTE_URL 指定）`
  : `[remote] ${slug.owner}/${slug.repo}${TOKEN ? '（带 token）' : '（匿名）'}`);

let result = scanByClone(slug);
if (!result) {
  if (OVERRIDE_URL) {
    console.log('  !! HUA_REMOTE_URL 指向的远端 clone 失败');
    process.exit(2);
  }
  console.log('[remote] github.com 走不通，改用 GitHub API');
  try {
    result = scanByApi(slug);
  } catch (e) {
    console.log(`  !! 两条路都失败了：${e.message}`);
    console.log('  !! 这不代表「干净」，只代表「没查成」。别把这次当成通过。');
    process.exit(2);
  }
} else {
  console.log('[remote] 已 clone 到临时目录（走 github.com）');
}

console.log(`[remote] 分支 ${result.branches.length} 个：${result.branches.join(', ')}`);
console.log(`[remote] 提交 ${result.commits} 个，扫了 ${result.blobs} 份文件内容`);

if (result.hits.length === 0) {
  console.log('  ok   远端历史里没有私人路径 / 用户名 / 真实邮箱');
  process.exit(0);
}

report(result.hits, { scope: `远端 ${result.commits} 个提交` });
console.log('  这条已经在远端了。重写历史不够 —— 要么删库重建，要么把仓库改私有。');
console.log('');
process.exit(1);
