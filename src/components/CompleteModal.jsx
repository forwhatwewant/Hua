import { useEffect, useRef, useState } from 'react';

export default function CompleteModal({ item, today, onClose, onDone }) {
  const [mins, setMins] = useState('');
  const [output, setOutput] = useState('');
  const outRef = useRef(null);
  // 遗留事项（排在今天之前）：可以选「完成于哪天」，默认今天
  const isPast = !!(today && item.date && item.date < today);
  const [doneDate, setDoneDate] = useState(isPast ? today : '');

  useEffect(() => { outRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async (skip) => {
    await window.hua.items.complete({
      id: item.id,
      actualMinutes: skip || !mins ? null : Number(mins),
      output: skip ? null : output.trim() || null,
      // 选了过去的日子就用那天的中午当完成时间；选今天就交给主进程取当前时间
      doneDate: isPast && doneDate ? doneDate : null,
      completedAt: isPast && doneDate && doneDate !== today
        ? new Date(`${doneDate}T12:00:00`).toISOString()
        : null
    });
    onDone();
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || e.target.tagName === 'INPUT')) {
      e.preventDefault();
      submit(false);
    }
  };

  return (
    <div className="modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" onKeyDown={onKeyDown}>
        <h3>完成了</h3>
        <div className="m-sub">{item.title}</div>

        {isPast && (
          <div className="m-row">
            <label>完成于哪天</label>
            <input
              type="date"
              value={doneDate}
              max={today}
              onChange={(e) => setDoneDate(e.target.value)}
            />
            <div className="m-hint">这件原本排在 {item.date}。记到实际做完的那天，完成清单才对得上。</div>
          </div>
        )}

        <div className="m-row">
          <label>实际花了多久（分钟，可留空）{!item.estMinutes && <span className="m-hint-inline"> · 这件是不定时的</span>}</label>
          <input
            type="number"
            min="0"
            value={mins}
            onChange={(e) => setMins(e.target.value)}
            placeholder={item.estMinutes ? `预计 ${item.estMinutes} 分钟` : '这件没估时，现在记一下实际花了多久'}
          />
        </div>

        <div className="m-row">
          <label>产出描述（一句话，可留空）</label>
          <textarea
            ref={outRef}
            rows="2"
            value={output}
            onChange={(e) => setOutput(e.target.value)}
            placeholder="实际做完了什么？例：修好了登录流程的 token 过期问题"
          />
        </div>

        <div className="m-foot">
          <button className="m-skip" onClick={() => submit(true)}>跳过，直接打勾</button>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={() => submit(false)}>完成</button>
        </div>
      </div>
    </div>
  );
}
