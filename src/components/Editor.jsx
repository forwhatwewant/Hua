import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useState } from 'react';
import { mdToHtml, htmlToMd, isAllowedUri } from '../md.js';

const Btn = ({ active, onClick, children, title }) => (
  <button
    type="button"
    title={title}
    className={active ? 'on' : ''}
    onMouseDown={(e) => e.preventDefault()}
    onClick={onClick}
  >
    {children}
  </button>
);

export default function Editor({ initial, onChange, refItems = [] }) {
  const [picking, setPicking] = useState(false);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        link: {
          openOnClick: false,
          autolink: false,
          isAllowedUri,
          HTMLAttributes: { rel: 'noreferrer' }
        }
      })
    ],
    content: mdToHtml(initial),
    onUpdate: ({ editor }) => onChange?.(htmlToMd(editor.getHTML()))
  });

  if (!editor) return <div className="editor-wrap" />;

  const c = () => editor.chain().focus();

  const insertRef = (item) => {
    c()
      .insertContent([
        { type: 'text', text: item.title, marks: [{ type: 'link', attrs: { href: `hua://item/${item.id}` } }] },
        { type: 'text', text: ' ' }
      ])
      .run();
    setPicking(false);
  };

  return (
    <div className="editor-wrap">
      <div className="editor-tools">
        <Btn title="加粗" active={editor.isActive('bold')} onClick={() => c().toggleBold().run()}>B</Btn>
        <Btn title="斜体" active={editor.isActive('italic')} onClick={() => c().toggleItalic().run()}>I</Btn>
        <Btn title="标题" active={editor.isActive('heading', { level: 3 })} onClick={() => c().toggleHeading({ level: 3 }).run()}>H</Btn>
        <Btn title="无序列表" active={editor.isActive('bulletList')} onClick={() => c().toggleBulletList().run()}>•</Btn>
        <Btn title="有序列表" active={editor.isActive('orderedList')} onClick={() => c().toggleOrderedList().run()}>1.</Btn>
        <Btn title="引用" active={editor.isActive('blockquote')} onClick={() => c().toggleBlockquote().run()}>”</Btn>
        <Btn title="行内代码" active={editor.isActive('code')} onClick={() => c().toggleCode().run()}>{'</>'}</Btn>
        <span className="grow" />
        {refItems.length > 0 && (
          <Btn title="把今天完成的事项引用进来" onClick={() => setPicking((v) => !v)}>引用事项</Btn>
        )}
      </div>

      {picking && (
        <div style={{ borderBottom: '1px solid var(--line-2)', padding: '8px 12px', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {refItems.map((it) => (
            <button
              key={it.id}
              type="button"
              className="tag"
              style={{ border: '1px solid var(--line)', background: 'none', cursor: 'pointer' }}
              onClick={() => insertRef(it)}
            >
              {it.title}
            </button>
          ))}
        </div>
      )}

      <EditorContent editor={editor} />
    </div>
  );
}
