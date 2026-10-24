/* Markdown ↔ HTML 往返测试。心得存在 Markdown 里，往返必须无损——
   否则写一次心得再打开，引用和格式就悄悄没了。 */

import { mdToHtml, htmlToMd, linkifyItemRefs } from '../src/md.js';

let pass = 0;
let fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${extra ? '  ' + extra : ''}`); }
};

const round = (md) => htmlToMd(mdToHtml(md));

console.log('\n[往返无损]');
const cases = [
  ['段落', '今天卡在 token 刷新的时序上。'],
  ['多段', '第一段。\n\n第二段。'],
  ['加粗', '**教训**：先看时序。'],
  ['斜体', '有点 *意外* 的发现。'],
  ['行内代码', '最后是 `refresh` 里少了一个 await。'],
  ['无序列表', '- 试了三种方案\n- 最后定位到 await'],
  ['有序列表', '1. 先看日志\n2. 再看代码'],
  ['引用', '> 先看时序，再看逻辑'],
  ['标题', '### 一个发现'],
  ['分割线', '上面\n\n---\n\n下面']
];

for (const [label, md] of cases) {
  const back = round(md);
  ok(label, back === md, back === md ? '' : `\n       in : ${JSON.stringify(md)}\n       out: ${JSON.stringify(back)}`);
}

console.log('\n[事项引用]');
const id = 'a0dea146-a01a-4444-b8c3-390445bbaba5';
const ref = `后来把 [修好了登录流程的 token 过期问题](hua://item/${id}) 的日志排开。`;
const refHtml = mdToHtml(ref);
ok('引用渲染成链接', refHtml.includes(`<a href="hua://item/${id}"`), refHtml);
ok('引用往返无损', round(ref) === ref, JSON.stringify(round(ref)));
ok('只读展示转成不可点标记', linkifyItemRefs(refHtml).includes('<span class="itemref">'));
ok('只读展示不再含 hua://', !linkifyItemRefs(refHtml).includes('hua://'));

console.log('\n[危险协议]');
ok('javascript: 不会被渲染成链接', !mdToHtml('[点我](javascript:alert(1))').includes('href="javascript:'));

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
