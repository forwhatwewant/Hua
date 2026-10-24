const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- 链接安全 ---------- */

const SAFE_LINK = /^(hua:\/\/item\/[\w-]+|https?:\/\/|mailto:|tel:|#|\/|\.\/|\.\.\/)/i;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** 只放行已知安全协议和相对路径，挡掉 javascript: / data: 之类。 */
export const isAllowedUri = (url) => SAFE_LINK.test(url) || !HAS_SCHEME.test(url);

/* ---------- 行内 ---------- */

function inline(s) {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  // 事项引用走标准链接语法，这样能原样转回 Markdown（往返无损）。
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, text, href) =>
    isAllowedUri(href) ? `<a href="${href}" rel="noreferrer">${text}</a>` : m
  );
  return t;
}

/** 只读渲染用：把事项引用从链接换成不可点的标记，避免触发系统协议处理。 */
export function linkifyItemRefs(html) {
  return String(html).replace(
    /<a href="hua:\/\/item\/[\w-]+"[^>]*>([\s\S]*?)<\/a>/g,
    '<span class="itemref">$1</span>'
  );
}

/* ---------- Markdown → HTML（喂给编辑器） ---------- */

export function mdToHtml(md) {
  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

  for (const raw of String(md || '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { closeList(); continue; }

    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      closeList();
      const lvl = Math.min(6, m[1].length);
      out.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`);
    } else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li><p>${inline(m[1])}</p></li>`);
    } else if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) {
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li><p>${inline(m[1])}</p></li>`);
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      closeList();
      out.push(`<blockquote><p>${inline(m[1])}</p></blockquote>`);
    } else if (line.trim() === '---') {
      closeList();
      out.push('<hr>');
    } else {
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  return out.join('\n') || '<p></p>';
}

/* ---------- HTML → Markdown（写进周文件） ---------- */

const stripP = (t) => t.replace(/<\/?p[^>]*>/gi, '\n');

/** 把一段 <li>…</li> 转成列表行。先消掉标签之间的空白，否则会多出空行。 */
function listItems(html, marker) {
  let i = 0;
  return html
    .replace(/>\s+</g, '><')
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, t) => {
      i += 1;
      const num = typeof marker === 'function' ? marker(i) : marker;
      return `${num} ${stripP(t).trim()}\n`;
    })
    .replace(/\n{2,}/g, '\n');
}

export function htmlToMd(html) {
  let s = String(html || '');

  s = s.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n\n# $1\n\n');
  s = s.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n\n## $1\n\n');
  s = s.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n\n### $1\n\n');
  s = s.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n\n#### $1\n\n');
  s = s.replace(/<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi, '\n\n```\n$1\n```\n\n');
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n\n```\n$1\n```\n\n');
  s = s.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi,
    (_m, p1) => `\n\n> ${stripP(p1).replace(/>\s+</g, '><').trim().replace(/\n+/g, '\n').replace(/\n/g, '\n> ')}\n\n`);
  s = s.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_m, p1) => `\n\n${listItems(p1, '-')}\n`);
  s = s.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_m, p1) => `\n\n${listItems(p1, (i) => `${i}.`)}\n`);
  s = s.replace(/<hr\s*\/?>/gi, '\n\n---\n\n');
  s = s.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n\n$1\n\n');

  s = s.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**');
  s = s.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*');
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  s = s.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');

  s = s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

  return s.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim();
}

/* ---------- 搜索结果高亮 ---------- */

export function highlight(text, q) {
  const safe = esc(text);
  if (!q) return safe;
  const needle = esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return safe.replace(new RegExp(needle, 'gi'), (m) => `<mark>${m}</mark>`);
}
