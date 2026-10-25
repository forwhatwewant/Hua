import { useEffect, useRef, useState } from 'react';

/* 修改事项：标题 / 日期 / 开始时间 / 预计耗时 / 时段 / 说明。
   说明（note）是「这件事到底指什么」的小字注解 —— 想写点补充就写在这里，
   列表里以更小更淡的字显示在标题下面。

   标签（tags）已经撤掉了：它当初想解决「归类」，实际用起来只是多一个要维护的框，
   而且删不掉（用过的标签会一直留在候选列表里）。归类靠时段 + 搜索就够了。
   数据库里的 tags 列没删，老数据还在，只是界面不再读写它。 */
export default function EditItemModal({ item, onClose, onSaved }) {
  const [title, setTitle] = useState(item.title);
  const [date, setDate] = useState(item.date);
  const [est, setEst] = useState(item.estMinutes ?? '');
  const [start, setStart] = useState(item.startTime ?? '');
  const [note, setNote] = useState(item.note ?? '');
  const [slot, setSlot] = useState(item.slot ?? '');
  const titleRef = useRef(null);

  useEffect(() => {
    titleRef.current?.focus();
    titleRef.current?.select();
  }, []);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = async () => {
    const t = title.trim();
    if (!t) return;
    await window.hua.items.update({
      id: item.id,
      patch: {
        title: t,
        // 留空 = 待分配（date = ''）。
        // **不能写成 `date || item.date`** —— 空字符串是假值，会被还原成原日期，
        // 用户清空日期后看着「改了没反应」（踩过：明天的事项改不成待分配）。
        date,
        estMinutes: est === '' || est === null ? null : Number(est),
        startTime: start || null,
        note: note.trim(),
        slot
      }
    });
    onSaved();
  };

  return (
    <div className="modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal modal-wide">
        <h3>修改事项</h3>
        <div className="m-sub">改完按「保存」；Esc 取消。</div>

        <div className="m-row">
          <label>标题</label>
          <input ref={titleRef} type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>

        <div className="m-grid">
          <div className="m-row">
            <label>日期</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            {!date && <div className="m-hint">留空就是「待分配」——还没定哪天做</div>}
          </div>
          <div className="m-row">
            <label>开始时间（可留空）</label>
            <input type="time" value={start} onChange={(e) => setStart(e.target.value)} />
          </div>
          <div className="m-row">
            <label>预计耗时（分钟）</label>
            <input
              type="number"
              min="0"
              value={est}
              onChange={(e) => setEst(e.target.value)}
              placeholder="留空"
              title="留空 = 不定时，做完在完成弹窗里填实际耗时"
            />
          </div>
        </div>

        {/* 时段：上午 / 下午 / 晚上。留空则按开始时间自动归 */}
        <div className="m-row">
          <label>时段（可留空）</label>
          <div className="slotpick">
            {[{ k: '', l: '不指定' }, { k: 'am', l: '上午' }, { k: 'pm', l: '下午' }, { k: 'eve', l: '晚上' }].map(({ k, l }) => (
              <button
                key={k || 'none'}
                className={`slotchip${slot === k ? ' on' : ''}`}
                onClick={() => setSlot(k)}
              >
                {l}
              </button>
            ))}
          </div>
          <div className="m-hint">留空就按开始时间自动归到上午 / 下午 / 晚上</div>
        </div>

        <div className="m-row">
          <label>说明 / 补充（可留空）</label>
          <textarea
            className="m-note"
            rows={2}
            value={note}
            placeholder="这件事具体指什么、有什么要交代的……"
            onChange={(e) => setNote(e.target.value)}
          />
        </div>

        <div className="m-foot">
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={save}>保存</button>
        </div>
      </div>
    </div>
  );
}
