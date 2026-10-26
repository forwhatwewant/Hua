'use strict';
/* 泄漏规则（唯一一份）。
 *
 * 为什么抽出来：提交前检查（check-leaks）和推送后检查（check-remote）必须用**同一套规则**。
 * 两份规则早晚会漂移 —— 一份改了另一份没改，就是「假绿」。
 */

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

/* 这几个文件自己写着这些规则，别扫自己 */
const FILE_ALLOW = new Set([
  'scripts/check-leaks.cjs',
  'scripts/check-remote.cjs',
  'scripts/leak-rules.cjs'
]);

/* package-lock 里的 homepage / repository 字段不归我们管 */
const FILE_SKIP = new Set(['package-lock.json']);

/* 超过这个大小的文件不扫（二进制 / 数据文件本来也不该进仓库） */
const MAX_BYTES = 2 * 1024 * 1024;

/** 扫一段文本，返回命中列表（不抛错，调用方自己决定怎么报） */
function scanText(text, label) {
  const hits = [];
  if (!text || text.length > MAX_BYTES) return hits;

  const lines = text.split('\n');
  for (const rule of RULES) {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(rule.re);
      if (!m) continue;
      for (const raw of m) {
        const found = raw.replace(/^['"`]/, '');   // 盘符规则的第 1 个捕获是引号
        if (ALLOW.some((a) => found.includes(a))) continue;
        hits.push({ where: label, line: i + 1, rule: rule.name, found, why: rule.why });
      }
    }
  }
  return hits;
}

/** 这个文件要不要扫 */
function shouldScan(rel) {
  return !FILE_ALLOW.has(rel) && !FILE_SKIP.has(rel);
}

/** 统一的失败输出 */
function report(hits, { scope = '' } = {}) {
  console.log('');
  console.log(`  FAIL 发现了不该提交的内容${scope ? '（' + scope + '）' : ''}：`);
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
}

module.exports = { RULES, ALLOW, FILE_ALLOW, FILE_SKIP, MAX_BYTES, scanText, shouldScan, report };
