'use strict';

const fs = require('fs');
const path = require('path');
const { app, dialog } = require('electron');
const Model = require('../shared/model');

function dataDir() {
  return path.join(app.getPath('appData'), 'desktop-notes');
}

function boardPath() {
  return path.join(dataDir(), 'board.json');
}

function ensureDir() {
  fs.mkdirSync(dataDir(), { recursive: true });
}

function load() {
  try {
    const raw = fs.readFileSync(boardPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return Model.normalizeState(parsed);
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      console.error('Failed to load board:', err.message);
    }
    return null;
  }
}

function save(state) {
  ensureDir();
  const normalized = Model.normalizeState(state);
  const tmp = boardPath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2), 'utf8');
  fs.renameSync(tmp, boardPath());
  return normalized;
}

async function exportBoard(win, state) {
  const result = await dialog.showSaveDialog(win, {
    title: 'Экспорт доски',
    defaultPath: 'sloy-backup.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  fs.writeFileSync(
    result.filePath,
    JSON.stringify(Model.normalizeState(state), null, 2),
    'utf8'
  );
  return { ok: true, path: result.filePath };
}

async function importBoard(win) {
  const result = await dialog.showOpenDialog(win, {
    title: 'Импорт доски',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (result.canceled || !result.filePaths || !result.filePaths[0]) {
    return { ok: false, canceled: true };
  }
  try {
    const raw = fs.readFileSync(result.filePaths[0], 'utf8');
    const state = Model.normalizeState(JSON.parse(raw));
    save(state);
    return { ok: true, state };
  } catch (err) {
    dialog.showErrorBox('Не удалось импортировать', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { dataDir, boardPath, load, save, exportBoard, importBoard };
