import { useEffect, useRef, useState } from 'react';
import Editor from './Editor.jsx';
import ConfirmDialog from './ConfirmDialog.jsx';

/** 折叠时显示的首行预览：去掉 Markdown 标记，截断。 */
function preview(body) {
  const line = String(body || '')
    .split('\n')
    .map((s) => s.trim())
    .find(Boolean) || '';
  const plain = line
    .replace(/^#{1,6}\s*/, '')
    .replace(/^[-*+]\s*/, '')
    .replace(/^>\s*/, '')
    .replace(/[*_`]/g, '')
    .trim();
  if (!plain) return '（还没写内容）';
  return plain.length > 34 ? `${plain.slice(0, 34)}…` : plain;
}

/**
 * 一条心得。自带防抖保存与卸载前 flush —— 多条并存时，每条各自管自己的写入，
 * 不会互相顶掉（这是之前单条实现里最容易踩的坑）。
 */
export default function ReflectionEntry({ date, entry, open, onToggle, onRemoved, onSaved, onPin, refItems, showDate }) {
  const [title, setTitle] = useState(entry.title || '');
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState(false);
  const timer = useRef(null);
  const noteTimer = useRef(null);

  // 标题和正文一起攒着，一次写回（分开写会互相覆盖）
  const pendingTitle = useRef(entry.title || '');
  const pendingBody = useRef(entry.body || '');
  const dirty = useRef(false);

  const flush = () => {
    if (!dirty.current) return;
    clearTimeout(timer.current);
    dirty.current = false;
    window.hua.journal.save({
      date,
      time: entry.time,
      title: pendingTitle.current,
      body: pendingBody.current
    });
    setNote('已写入周文件');
    clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(''), 1800);
    onSaved?.();
  };

  // 切页签 / 关窗口前把没落盘的内容补写进去
  useEffect(() => () => {
    clearTimeout(timer.current);
    clearTimeout(noteTimer.current);
    flush();
  }, []);

  const schedule = () => {
    dirty.current = true;
    setNote('未保存…');
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, 700);
  };

  const onChange = (md) => { pendingBody.current = md; schedule(); };

  const onTitleChange = (v) => {
    setTitle(v);
    pendingTitle.current = v;
    schedule();
  };

  const remove = async () => {
    await window.hua.journal.remove({ date, time: entry.time });
    setConfirming(false);
    onRemoved?.();
  };

  // 无时间（旧版「一天一篇」）的条目也能固定：标记写在 ### 心得 ·置顶 上
  const label = entry.time || '补记';
  const heading = (title || '').trim() || preview(entry.body);

  const togglePin = async () => {
    await window.hua.journal.pin({ date, time: entry.time, pinned: !entry.pinned });
    onPin?.();
  };

  return (
    <div className={`refentry${open ? ' open' : ''}${entry.pinned ? ' pinned' : ''}`}>
      <div className="refentry-head">
        <button
          className="refold"
          title={open ? '折叠' : '展开'}
          onClick={onToggle}
        >
          {open ? '▾' : '▸'}
        </button>
        {entry.pinned && <span className="refpin-tag" title="已固定，会显示在今日页">固定</span>}
        {showDate && <span className="refdate">{date}</span>}
        <span
          className="reftime"
          title={entry.time ? '' : '这条来自旧版格式（一天一篇），没有记录时间'}
        >
          {label}
        </span>
        <span className="refpreview">{heading}</span>
        {note && <span className="refnote">{note}</span>}
        <button
          className="refpinbtn"
          title={entry.pinned ? '取消固定' : '固定到今日页'}
          onClick={togglePin}
        >
          {entry.pinned ? '取消固定' : '固定'}
        </button>
        <button className="refdel" title="删除这条心得" onClick={() => setConfirming(true)}>删除</button>
      </div>

      {open && (
        <div className="refentry-body">
          <input
            type="text"
            className="reftitle-input"
            value={title}
            placeholder="给这条心得起个标题（可留空）"
            onChange={(e) => onTitleChange(e.target.value)}
          />
          <Editor key={`${date}-${entry.time}`} initial={entry.body} onChange={onChange} refItems={refItems} />
        </div>
      )}

      {confirming && (
        <ConfirmDialog
          title="删除这条心得？"
          text={`${label} · ${heading}`}
          okLabel="删除"
          danger
          onCancel={() => setConfirming(false)}
          onOk={remove}
        />
      )}
    </div>
  );
}
