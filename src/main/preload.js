'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sloy', {
  loadBoard: () => ipcRenderer.invoke('load-board'),
  saveBoard: (state) => ipcRenderer.invoke('save-board', state),
  exportBoard: (state) => ipcRenderer.invoke('export-board', state),
  importBoard: () => ipcRenderer.invoke('import-board'),
  setEditMode: (value) => ipcRenderer.invoke('set-edit-mode', value),
  getEditMode: () => ipcRenderer.invoke('get-edit-mode'),
  getPaths: () => ipcRenderer.invoke('get-paths'),
  systemTheme: () => ipcRenderer.invoke('system-theme'),
  ignoreMouse: (ignore) => ipcRenderer.send('ignore-mouse', ignore),
  onEditMode: (cb) => {
    const listener = (_e, value) => cb(value);
    ipcRenderer.on('edit-mode', listener);
    return () => ipcRenderer.removeListener('edit-mode', listener);
  }
});
