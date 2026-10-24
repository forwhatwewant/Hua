import { useEffect } from 'react';

/* 应用内确认框。
   不用 window.confirm —— Electron 的原生模态框关闭后，窗口常常拿不回焦点，
   键盘事件就全丢了（表现：删完一条事项后，输入框再也打不进字）。 */
export default function ConfirmDialog({ title, text, okLabel = '确定', danger, onCancel, onOk }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
      if (e.key === 'Enter') { e.preventDefault(); onOk(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, onOk]);

  return (
    <div className="modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="modal">
        <h3>{title}</h3>
        {text && <div className="m-sub">{text}</div>}
        <div className="m-foot">
          <button className="btn" onClick={onCancel}>取消</button>
          <button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={onOk}>{okLabel}</button>
        </div>
      </div>
    </div>
  );
}
