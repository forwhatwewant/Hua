import { useEffect, useRef, useState } from 'react';

export default function QuickCapture() {
  const [title, setTitle] = useState('');
  const ref = useRef(null);

  const focus = () => { ref.current?.focus(); ref.current?.select(); };

  useEffect(() => {
    document.documentElement.dataset.theme = 'plain';
    focus();
    window.hua.quick.onFocus(() => { setTitle(''); focus(); });
  }, []);

  const submit = async () => {
    const t = title.trim();
    if (!t) { window.hua.quick.hide(); return; }
    await window.hua.quick.submit({ title: t });
    setTitle('');
  };

  return (
    <div className="quick">
      <span className="q-mark">花</span>
      <input
        ref={ref}
        value={title}
        placeholder="记一件事…"
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
          if (e.key === 'Escape') window.hua.quick.hide();
        }}
      />
      <span className="q-hint">Enter 记下 · Esc 关闭</span>
    </div>
  );
}
