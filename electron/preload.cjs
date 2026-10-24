'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hua', {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),

  items: {
    create: (p) => ipcRenderer.invoke('items:create', p),
    update: (p) => ipcRenderer.invoke('items:update', p),
    complete: (p) => ipcRenderer.invoke('items:complete', p),
    reopen: (p) => ipcRenderer.invoke('items:reopen', p),
    drop: (p) => ipcRenderer.invoke('items:drop', p),
    remove: (p) => ipcRenderer.invoke('items:delete', p),
    carry: (p) => ipcRenderer.invoke('items:carry', p),
    reorder: (p) => ipcRenderer.invoke('items:reorder', p),
    pin: (p) => ipcRenderer.invoke('items:pin', p),
    range: (p) => ipcRenderer.invoke('items:range', p)
  },

  journal: {
    day: (p) => ipcRenderer.invoke('journal:day', p),
    save: (p) => ipcRenderer.invoke('journal:save', p),
    add: (p) => ipcRenderer.invoke('journal:add', p),
    remove: (p) => ipcRenderer.invoke('journal:remove', p),
    pin: (p) => ipcRenderer.invoke('journal:pin', p),
    snapshot: (p) => ipcRenderer.invoke('journal:snapshot', p)
  },

  review: { days: (p) => ipcRenderer.invoke('review:days', p) },

  // 日志：一天一篇的写入口（磁盘上仍是周文件里的 reflections）
  log: {
    day: (p) => ipcRenderer.invoke('log:day', p),
    save: (p) => ipcRenderer.invoke('log:save', p),
    pin: (p) => ipcRenderer.invoke('log:pin', p),
    days: (p) => ipcRenderer.invoke('log:days', p)
  },

  sleep: {
    save: (p) => ipcRenderer.invoke('sleep:save', p),
    remove: (p) => ipcRenderer.invoke('sleep:remove', p),
    range: (p) => ipcRenderer.invoke('sleep:range', p),
    report: (p) => ipcRenderer.invoke('sleep:report', p)
  },

  // 备忘：不绑日期的常驻提醒条
  memos: {
    list: () => ipcRenderer.invoke('memos:list'),
    create: (p) => ipcRenderer.invoke('memos:create', p),
    update: (p) => ipcRenderer.invoke('memos:update', p),
    remove: (p) => ipcRenderer.invoke('memos:remove', p),
    reorder: (p) => ipcRenderer.invoke('memos:reorder', p)
  },

  // 周程：一周的 7 天 + 待分配池 + 负荷分析 + 完成率
  week: {
    board: (p) => ipcRenderer.invoke('week:board', p)
  },

  // 完成率总览（整体累计 + 逐周）
  stats: {
    overview: (p) => ipcRenderer.invoke('stats:overview', p)
  },

  search: (p) => ipcRenderer.invoke('search', p),
  settings: { set: (p) => ipcRenderer.invoke('settings:set', p) },

  // 界面缩放：主进程改 zoomFactor，并把结果广播回来让设置页的数字跟着走
  zoom: {
    set: (p) => ipcRenderer.invoke('zoom:set', p),
    onChanged: (cb) => {
      ipcRenderer.removeAllListeners('zoom:changed');
      ipcRenderer.on('zoom:changed', (_e, v) => cb(v));
    }
  },

  shell: {
    openDataDir: () => ipcRenderer.invoke('shell:openDataDir'),
    openJournalFile: (p) => ipcRenderer.invoke('shell:openJournalFile', p)
  },

  report: {
    generate: (p) => ipcRenderer.invoke('report:generate', p),
    list: () => ipcRenderer.invoke('report:list')
  },

  quick: {
    submit: (p) => ipcRenderer.invoke('quick:submit', p),
    hide: () => ipcRenderer.invoke('quick:hide'),
    // QuickCapture 每次挂载都会注册一次，先清掉旧的，避免监听器越攒越多、重复触发
    onFocus: (cb) => {
      ipcRenderer.removeAllListeners('quick:focus');
      ipcRenderer.on('quick:focus', () => cb());
    }
  },

  onDataChanged: (cb) => ipcRenderer.on('data:changed', () => cb())
});
