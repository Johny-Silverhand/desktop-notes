'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut, ipcMain, screen, nativeTheme, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./store');
const desktopLayer = require('./desktop-layer');
const Model = require('../shared/model');

const HOTKEYS = ['CommandOrControl+Alt+N', 'CommandOrControl+Alt+Shift+N'];
let activeHotkey = null;

if (process.platform === 'linux') {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('in-process-gpu');
  app.commandLine.appendSwitch('use-gl', 'swiftshader');
}

const boardWindows = new Map();
const controlWindows = new Map();
const interacting = new Map();

let boardState = null;
let firstRun = false;
let tray = null;
let editMode = true;
let isQuitting = false;
let zOrderTimer = null;
let screenshotPath = null;
let trayClickTimer = null;
let displayTimer = null;
let notified = false;

function parseArgs() {
  const arg = process.argv.find((a) => a === '--screenshot' || a.startsWith('--screenshot='));
  if (!arg) return;
  if (arg === '--screenshot') {
    screenshotPath = path.join(process.cwd(), 'screenshot.png');
    const envPath = process.env.DESKTOP_NOTES_SCREENSHOT;
    if (envPath) screenshotPath = envPath;
    return;
  }
  screenshotPath = arg.slice('--screenshot='.length) || path.join(process.cwd(), 'screenshot.png');
}

function isScreenshot() {
  return !!screenshotPath;
}

function primaryId() {
  return String(screen.getPrimaryDisplay().id);
}

function listDisplays() {
  if (isScreenshot()) return [screen.getPrimaryDisplay()];
  return screen.getAllDisplays();
}

function displayAt(sx, sy) {
  const displays = listDisplays();
  const hit = displays.find((d) => {
    const b = d.bounds;
    return sx >= b.x && sy >= b.y && sx < b.x + b.width && sy < b.y + b.height;
  });
  return hit || screen.getPrimaryDisplay();
}

function hotkeyLabel(accel) {
  const key = accel || activeHotkey || HOTKEYS[0];
  return key.replace('CommandOrControl+', 'Ctrl+').replace('Command+', 'Ctrl+');
}

function iconPath() {
  return path.join(__dirname, '../../assets/icon.png');
}

function transparentPrefs() {
  return {
    frame: false,
    transparent: !isScreenshot(),
    // Fully transparent — never cover or tint the wallpaper.
    backgroundColor: isScreenshot() ? '#121018' : '#00000000',
    hasShadow: false
  };
}

function loadInitialState() {
  const loaded = store.load();
  if (loaded && loaded.items && loaded.items.length) {
    boardState = Model.normalizeState(loaded, { primaryId: primaryId() });
    firstRun = false;
  } else {
    boardState = Model.normalizeState(Model.demoBoard(), { primaryId: primaryId() });
    store.save(boardState);
    firstRun = !loaded;
  }
  reconcileState();
}

function reconcileState() {
  const displays = listDisplays().map((d) => ({
    id: String(d.id),
    bounds: { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height }
  }));
  boardState = Model.normalizeState(boardState, { primaryId: primaryId() });
  Model.reconcileDisplays(boardState, displays, primaryId());
  store.save(boardState);
}

function displaySlice(displayId) {
  const id = String(displayId);
  return {
    version: 2,
    theme: boardState.theme,
    items: Model.itemsForDisplay(boardState, id),
    layouts: boardState.layouts
  };
}

function scheduleDisplaySync() {
  clearTimeout(displayTimer);
  displayTimer = setTimeout(() => {
    try { syncDisplays(); } catch (err) { console.error('syncDisplays', err); }
  }, 250);
}

function syncDisplays() {
  reconcileState();
  const displays = listDisplays();
  const live = new Set(displays.map((d) => String(d.id)));

  for (const id of [...boardWindows.keys()]) {
    if (!live.has(id)) destroyBoard(id);
  }
  for (const d of displays) {
    const id = String(d.id);
    if (!boardWindows.has(id)) createBoardWindow(d);
    else layoutBoardWindow(d);
  }

  if (!isScreenshot()) {
    for (const id of [...controlWindows.keys()]) {
      if (!live.has(id)) destroyControl(id);
    }
    for (const d of displays) {
      const id = String(d.id);
      if (!controlWindows.has(id)) createControlWindow(d);
      else layoutControlWindow(d);
    }
  }

  for (const d of displays) {
    applyWindowMode(String(d.id));
  }
  sendEditMode();
  broadcastBoard();
}

function boardOptions(area) {
  const icon = nativeImage.createFromPath(iconPath());
  return Object.assign({
    x: area.x,
    y: area.y,
    width: area.width,
    height: area.height,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: true,
    skipTaskbar: !isScreenshot(),
    show: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    icon,
    type: process.platform === 'win32' && !isScreenshot() ? 'toolbar' : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true
    }
  }, transparentPrefs());
}

function createBoardWindow(display) {
  const id = String(display.id);
  const area = display.workArea;
  const win = new BrowserWindow(boardOptions(area));
  win._sloyDisplayId = id;
  win.setMenuBarVisibility(false);
  if (!isScreenshot()) {
    try { win.setBackgroundColor('#00000000'); } catch (_) { /* ignore */ }
  }
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    console.log('renderer', id, level, message, sourceId + ':' + line);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('did-fail-load', id, code, desc, url);
  });
  win.webContents.on('preload-error', (_e, pathName, err) => {
    console.error('preload-error', id, pathName, err);
  });
  win.loadFile(path.join(__dirname, '../renderer/index.html'), { query: { display: id } });

  win.once('ready-to-show', async () => {
    layoutBoardWindow(display);
    win.show();
    if (isScreenshot()) {
      await runScreenshot(win);
      return;
    }
    applyWindowMode(id);
    if (!notified && String(screen.getPrimaryDisplay().id) === id) {
      notified = true;
      if (editMode) await enterEditMode();
      showStartupNotification();
    }
  });

  win.on('close', (e) => {
    if (!isQuitting && !isScreenshot()) {
      e.preventDefault();
      enterDesktopMode();
    }
  });

  win.on('blur', () => {
    if (!editMode && !interacting.get(id) && !isScreenshot()) {
      desktopLayer.placeAboveDesktop(win);
    }
  });

  boardWindows.set(id, win);
}

function layoutBoardWindow(display) {
  const id = String(display ? display.id : '');
  const win = boardWindows.get(id);
  if (!win || win.isDestroyed()) return;
  const d = display || listDisplays().find((x) => String(x.id) === id);
  if (!d) return;
  const area = d.workArea;
  win.setBounds({ x: area.x, y: area.y, width: area.width, height: area.height });
}

function destroyBoard(id) {
  const win = boardWindows.get(id);
  boardWindows.delete(id);
  interacting.delete(id);
  if (win && !win.isDestroyed()) {
    try { win.removeAllListeners('close'); win.close(); } catch (_) { /* ignore */ }
  }
  destroyControl(id);
}

function createControlWindow(display) {
  if (isScreenshot()) return;
  const id = String(display.id);
  if (controlWindows.has(id)) return;
  const area = display.workArea;
  const width = 220;
  const height = 48;
  const win = new BrowserWindow(Object.assign({
    width,
    height,
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + 14,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    closable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    icon: nativeImage.createFromPath(iconPath()),
    type: process.platform === 'win32' ? 'toolbar' : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  }, {
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false
  }));
  win._sloyDisplayId = id;
  win._sloyControl = true;
  try { win.setBackgroundColor('#00000000'); } catch (_) { /* ignore */ }
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(false);
  win.loadFile(path.join(__dirname, '../renderer/control.html'), { query: { display: id } });
  win.on('close', (e) => {
    if (!isQuitting) e.preventDefault();
  });
  controlWindows.set(id, win);
}

function layoutControlWindow(display) {
  const id = String(display ? display.id : '');
  const win = controlWindows.get(id);
  if (!win || win.isDestroyed()) return;
  const d = display || listDisplays().find((x) => String(x.id) === id);
  if (!d) return;
  const area = d.workArea;
  const { width, height } = win.getBounds();
  win.setBounds({
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + 14,
    width,
    height
  });
}

function destroyControl(id) {
  const win = controlWindows.get(id);
  controlWindows.delete(id);
  if (win && !win.isDestroyed()) {
    try { win.removeAllListeners('close'); win.close(); } catch (_) { /* ignore */ }
  }
}

function showControlWindow(id) {
  const win = controlWindows.get(id);
  if (!win || win.isDestroyed() || isScreenshot()) return;
  const d = listDisplays().find((x) => String(x.id) === id);
  if (d) layoutControlWindow(d);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(false);
  win.showInactive();
}

function hideControlWindow(id) {
  const win = controlWindows.get(id);
  if (!win || win.isDestroyed()) return;
  win.hide();
}

function boardWinByEvent(e) {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed()) return null;
  return win;
}

function displayIdForEvent(e) {
  const win = boardWinByEvent(e);
  return win && win._sloyDisplayId ? String(win._sloyDisplayId) : null;
}

function sendEditMode() {
  const payload = { editMode, hotkey: hotkeyLabel() };
  for (const [id, win] of boardWindows) {
    if (win.isDestroyed()) continue;
    const d = listDisplays().find((x) => String(x.id) === id);
    const extra = Object.assign({}, payload, {
      displayId: id,
      workArea: d ? d.workArea : null,
      screenshot: isScreenshot()
    });
    win.webContents.send('edit-mode', editMode);
    win.webContents.send('app-meta', extra);
  }
  for (const [id, win] of controlWindows) {
    if (win.isDestroyed()) continue;
    win.webContents.send('edit-mode', editMode);
    win.webContents.send('app-meta', Object.assign({ displayId: id }, payload));
  }
  updateTrayMenu();
  for (const id of new Set([...boardWindows.keys(), ...controlWindows.keys()])) {
    if (editMode) hideControlWindow(id);
    else showControlWindow(id);
  }
}

function broadcastBoard() {
  for (const [id, win] of boardWindows) {
    if (win.isDestroyed()) continue;
    win.webContents.send('board-sync', {
      state: displaySlice(id),
      displayId: id,
      firstRun
    });
  }
}

async function applyWindowMode(id) {
  const win = boardWindows.get(id);
  if (!win || win.isDestroyed() || isScreenshot()) return;
  layoutBoardWindow(listDisplays().find((d) => String(d.id) === id));
  if (editMode) {
    win.setIgnoreMouseEvents(false);
    await desktopLayer.detachFromDesktop(win);
    await desktopLayer.bringToFront(win);
  } else {
    win.setAlwaysOnTop(false);
    win.setIgnoreMouseEvents(true, { forward: true });
    if (process.platform === 'win32') {
      await desktopLayer.detachFromDesktop(win);
      await desktopLayer.placeAboveDesktop(win);
    }
  }
}

async function enterEditMode() {
  editMode = true;
  stopZWatcher();
  for (const id of boardWindows.keys()) interacting.set(id, true);
  for (const id of boardWindows.keys()) await applyWindowMode(id);
  sendEditMode();
}

async function enterDesktopMode() {
  editMode = false;
  for (const id of interacting.keys()) interacting.set(id, false);
  if (isScreenshot()) return;
  for (const id of boardWindows.keys()) await applyWindowMode(id);
  if (process.platform === 'win32') startZWatcher();
  sendEditMode();
}

async function toggleEditMode() {
  if (editMode) await enterDesktopMode();
  else await enterEditMode();
}

function startZWatcher() {
  stopZWatcher();
  if (process.platform !== 'win32') return;
  zOrderTimer = setInterval(() => {
    if (editMode) return;
    for (const [id, win] of boardWindows) {
      if (interacting.get(id)) continue;
      if (!win.isDestroyed() && !win.isFocused()) {
        desktopLayer.placeAboveDesktop(win);
      }
    }
  }, 1500);
}

function stopZWatcher() {
  if (zOrderTimer) {
    clearInterval(zOrderTimer);
    zOrderTimer = null;
  }
}

function trayIcon() {
  const p = path.join(__dirname, '../../assets/tray.png');
  let img = nativeImage.createFromPath(p);
  if (process.platform === 'win32') {
    img = img.resize({ width: 16, height: 16 });
  }
  return img;
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('Слой — заметки на рабочем столе');
  tray.on('click', () => {
    if (trayClickTimer) return;
    trayClickTimer = setTimeout(() => {
      trayClickTimer = null;
      toggleEditMode();
    }, 280);
  });
  tray.on('double-click', () => {
    if (trayClickTimer) {
      clearTimeout(trayClickTimer);
      trayClickTimer = null;
    }
    toggleEditMode();
  });
  updateTrayMenu();
}

function isAutostart() {
  try {
    return !!app.getLoginItemSettings().openAtLogin;
  } catch (_) {
    return false;
  }
}

function setAutostart(enabled) {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      path: process.execPath,
      args: []
    });
  } catch (err) {
    console.error('autostart', err);
  }
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  const auto = isAutostart();
  const accel = hotkeyLabel();
  const template = [
    {
      label: 'Режим правки',
      type: 'checkbox',
      checked: editMode,
      accelerator: accel,
      click: () => toggleEditMode()
    },
    {
      label: editMode ? 'Вернуть на рабочий стол' : 'Редактировать',
      click: () => toggleEditMode()
    },
    { type: 'separator' },
    {
      label: 'Запускать вместе с Windows',
      type: 'checkbox',
      checked: auto,
      click: (item) => setAutostart(item.checked)
    },
    { type: 'separator' },
    {
      label: 'Выход',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function registerHotkeys() {
  activeHotkey = null;
  for (const key of HOTKEYS) {
    let ok = false;
    try {
      ok = globalShortcut.register(key, () => toggleEditMode());
    } catch (err) {
      console.error('Hotkey threw', key, err);
      ok = false;
    }
    if (ok) {
      activeHotkey = key;
      console.log('Registered hotkey', key);
      return key;
    }
    console.error('Failed to register hotkey', key);
  }
  console.error('No global hotkey registered; use the tray icon or the «Редактировать» button');
  return null;
}

function showStartupNotification() {
  try {
    if (!Notification.isSupported()) return;
    const key = hotkeyLabel();
    const body = activeHotkey
      ? `Наведите курсор на карточку, чтобы править её. Можно перетащить на другой монитор. Полный режим: ${key} или кнопка «Редактировать».`
      : 'Наведите курсор на карточку, чтобы править её. Можно перетащить на другой монитор. Режим правки — кнопка «Редактировать» или значок в трее.';
    const n = new Notification({
      title: 'Слой',
      body,
      icon: nativeImage.createFromPath(iconPath()),
      silent: true
    });
    n.show();
  } catch (err) {
    console.error('notification', err);
  }
}

function registerIpc() {
  ipcMain.handle('load-board', (e) => {
    const id = displayIdForEvent(e) || primaryId();
    return {
      state: displaySlice(id),
      firstRun,
      displayId: id,
      workArea: (listDisplays().find((d) => String(d.id) === id) || screen.getPrimaryDisplay()).workArea
    };
  });

  ipcMain.handle('save-board', (e, partial) => {
    const id = displayIdForEvent(e);
    if (!boardState) return { ok: false };
    if (partial && (partial.theme === 'light' || partial.theme === 'dark' || partial.theme === 'system')) {
      if (boardState.theme !== partial.theme) {
        boardState.theme = partial.theme;
        broadcastBoard();
      } else {
        boardState.theme = partial.theme;
      }
    }
    if (id && partial && Array.isArray(partial.items)) {
      Model.setDisplayItems(boardState, id, partial.items);
    }
    store.save(boardState);
    return { ok: true };
  });

  ipcMain.handle('export-board', async (e) => {
    const win = boardWinByEvent(e);
    if (!win) return { ok: false };
    return store.exportBoard(win, boardState);
  });

  ipcMain.handle('import-board', async (e) => {
    const win = boardWinByEvent(e);
    if (!win) return { ok: false };
    const res = await store.importBoard(win);
    if (res && res.ok && res.state) {
      boardState = Model.normalizeState(res.state, { primaryId: primaryId() });
      reconcileState();
      broadcastBoard();
    }
    return res;
  });

  ipcMain.handle('set-edit-mode', async (_e, value) => {
    if (value) await enterEditMode();
    else await enterDesktopMode();
    return { editMode, hotkey: hotkeyLabel() };
  });

  ipcMain.handle('get-edit-mode', (e) => {
    const id = displayIdForEvent(e) || primaryId();
    const d = listDisplays().find((x) => String(x.id) === id) || screen.getPrimaryDisplay();
    return {
      editMode,
      screenshot: isScreenshot(),
      hotkey: hotkeyLabel(),
      displayId: id,
      workArea: d.workArea
    };
  });

  ipcMain.handle('get-paths', () => ({
    dataDir: store.dataDir(),
    boardPath: store.boardPath()
  }));

  ipcMain.handle('display-under-cursor', () => {
    const pt = screen.getCursorScreenPoint();
    const d = displayAt(pt.x, pt.y);
    const wa = d.workArea;
    return {
      displayId: String(d.id),
      localX: pt.x - wa.x,
      localY: pt.y - wa.y
    };
  });

  ipcMain.handle('transfer-item', (e, payload) => {
    const fromId = displayIdForEvent(e);
    if (!payload || !payload.id) return { ok: false };
    const cursorX = Number(payload.cursorX);
    const cursorY = Number(payload.cursorY);
    if (!Number.isFinite(cursorX) || !Number.isFinite(cursorY)) return { ok: false };
    const target = displayAt(cursorX, cursorY);
    const toId = String(target.id);
    if (!fromId || toId === String(fromId)) return { ok: false, same: true };
    const wa = target.workArea;
    const x = Number.isFinite(Number(payload.screenX)) ? Number(payload.screenX) - wa.x : cursorX - wa.x;
    const y = Number.isFinite(Number(payload.screenY)) ? Number(payload.screenY) - wa.y : cursorY - wa.y;
    const item = Model.transferItem(boardState, payload.id, toId, x, y);
    if (!item) return { ok: false };
    store.save(boardState);
    broadcastBoard();
    return { ok: true, displayId: toId, x: item.x, y: item.y };
  });

  ipcMain.handle('create-on-display', (e, payload) => {
    if (!payload || !payload.displayId) return { ok: false };
    const id = String(payload.displayId);
    const win = boardWindows.get(id);
    if (!win || win.isDestroyed()) return { ok: false };
    win.webContents.send('create-item', {
      type: payload.type === 'block' ? 'block' : 'note',
      x: payload.x,
      y: payload.y
    });
    return { ok: true };
  });

  ipcMain.on('ignore-mouse', (e, ignore) => {
    const win = boardWinByEvent(e);
    if (!win || win.isDestroyed() || isScreenshot() || win._sloyControl) return;
    const id = win._sloyDisplayId;
    if (editMode) {
      interacting.set(id, true);
      win.setIgnoreMouseEvents(false);
      return;
    }
    interacting.set(id, !ignore);
    win.setIgnoreMouseEvents(!!ignore, { forward: true });
  });

  ipcMain.handle('system-theme', () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'));
}

async function runScreenshot(win) {
  try {
    editMode = true;
    sendEditMode();
    if (win) win.setIgnoreMouseEvents(false);
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        const n = await win.webContents.executeJavaScript(
          'document.querySelectorAll(".item").length'
        );
        console.log('items-on-board', n);
        if (n > 0) break;
      } catch (err) {
        console.log('wait-board', err.message);
      }
    }
    await new Promise((r) => setTimeout(r, 400));
    const image = await win.webContents.capturePage();
    const out = path.resolve(screenshotPath);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, image.toPNG());
    console.log('screenshot-saved', out, image.getSize());
  } catch (err) {
    console.error('screenshot-failed', err);
  } finally {
    isQuitting = true;
    app.quit();
  }
}

app.setName('Sloy');
app.setAppUserModelId('com.johnysilverhand.sloy');

parseArgs();

function startApp() {
  if (process.platform === 'win32' && !isScreenshot()) {
    try {
      app.setLoginItemSettings({
        openAtLogin: isAutostart(),
        path: process.execPath
      });
    } catch (_) { /* ignore */ }
  }
  registerIpc();
  loadInitialState();
  syncDisplays();
  if (!isScreenshot()) {
    createTray();
    registerHotkeys();
    updateTrayMenu();
  }
  screen.on('display-metrics-changed', scheduleDisplaySync);
  screen.on('display-added', scheduleDisplaySync);
  screen.on('display-removed', scheduleDisplaySync);
}

if (!isScreenshot()) {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    app.on('second-instance', () => {
      enterEditMode();
    });
    app.whenReady().then(startApp);
  }
} else {
  app.whenReady().then(startApp);
}

app.on('will-quit', () => {
  stopZWatcher();
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (isQuitting || isScreenshot() || process.platform !== 'darwin') {
    app.quit();
  }
});
