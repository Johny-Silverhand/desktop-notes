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

let mainWindow = null;
let controlWindow = null;
let tray = null;
let editMode = true;
let isQuitting = false;
let zOrderTimer = null;
let screenshotPath = null;
let interacting = false;
let trayClickTimer = null;

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

function workArea() {
  const display = screen.getPrimaryDisplay();
  return display.workArea;
}

function hotkeyLabel(accel) {
  const key = accel || activeHotkey || HOTKEYS[0];
  return key.replace('CommandOrControl+', 'Ctrl+').replace('Command+', 'Ctrl+');
}

function iconPath() {
  return path.join(__dirname, '../../assets/icon.png');
}

function createWindow() {
  const area = workArea();
  const icon = nativeImage.createFromPath(iconPath());

  mainWindow = new BrowserWindow({
    x: area.x,
    y: area.y,
    width: area.width,
    height: area.height,
    frame: false,
    transparent: !isScreenshot(),
    backgroundColor: isScreenshot() ? '#121018' : '#00000000',
    hasShadow: false,
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
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    console.log('renderer', level, message, sourceId + ':' + line);
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('did-fail-load', code, desc, url);
  });
  mainWindow.webContents.on('preload-error', (_e, pathName, err) => {
    console.error('preload-error', pathName, err);
  });
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  mainWindow.once('ready-to-show', async () => {
    layoutToWorkArea();
    mainWindow.show();
    if (isScreenshot()) {
      await runScreenshot();
      return;
    }
    await enterEditMode();
    showStartupNotification();
  });

  mainWindow.on('close', (e) => {
    if (!isQuitting && !isScreenshot()) {
      e.preventDefault();
      enterDesktopMode();
    }
  });

  mainWindow.on('blur', () => {
    if (!editMode && !interacting && !isScreenshot()) {
      desktopLayer.placeAboveDesktop(mainWindow);
    }
  });

  screen.on('display-metrics-changed', () => {
    layoutToWorkArea();
    layoutControlWindow();
  });
  screen.on('display-added', layoutToWorkArea);
  screen.on('display-removed', layoutToWorkArea);
}

function createControlWindow() {
  if (isScreenshot()) return;
  const area = workArea();
  const width = 220;
  const height = 48;
  controlWindow = new BrowserWindow({
    width,
    height,
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + 14,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
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
  });
  controlWindow.setAlwaysOnTop(true, 'screen-saver');
  controlWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  controlWindow.setIgnoreMouseEvents(false);
  controlWindow.loadFile(path.join(__dirname, '../renderer/control.html'));
  controlWindow.on('close', (e) => {
    if (!isQuitting) e.preventDefault();
  });
}

function layoutToWorkArea() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const area = workArea();
  mainWindow.setBounds({ x: area.x, y: area.y, width: area.width, height: area.height });
}

function layoutControlWindow() {
  if (!controlWindow || controlWindow.isDestroyed()) return;
  const area = workArea();
  const { width, height } = controlWindow.getBounds();
  controlWindow.setBounds({
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + 14,
    width,
    height
  });
}

function showControlWindow() {
  if (!controlWindow || controlWindow.isDestroyed() || isScreenshot()) return;
  layoutControlWindow();
  controlWindow.setAlwaysOnTop(true, 'screen-saver');
  controlWindow.setIgnoreMouseEvents(false);
  controlWindow.showInactive();
}

function hideControlWindow() {
  if (!controlWindow || controlWindow.isDestroyed()) return;
  controlWindow.hide();
}

function sendEditMode() {
  const payload = { editMode, hotkey: hotkeyLabel() };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('edit-mode', editMode);
    mainWindow.webContents.send('app-meta', payload);
  }
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.send('edit-mode', editMode);
    controlWindow.webContents.send('app-meta', payload);
  }
  updateTrayMenu();
  if (editMode) hideControlWindow();
  else showControlWindow();
}

async function enterEditMode() {
  editMode = true;
  interacting = true;
  stopZWatcher();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  layoutToWorkArea();
  mainWindow.setIgnoreMouseEvents(false);
  await desktopLayer.detachFromDesktop(mainWindow);
  await desktopLayer.bringToFront(mainWindow);
  sendEditMode();
}

async function enterDesktopMode() {
  editMode = false;
  interacting = false;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  layoutToWorkArea();
  if (isScreenshot()) return;
  mainWindow.setAlwaysOnTop(false);
  mainWindow.setIgnoreMouseEvents(true, { forward: true });
  if (process.platform === 'win32') {
    await desktopLayer.detachFromDesktop(mainWindow);
    await desktopLayer.placeAboveDesktop(mainWindow);
    startZWatcher();
  }
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
    if (editMode || interacting) return;
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) {
      desktopLayer.placeAboveDesktop(mainWindow);
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
      ? `Наведите курсор на карточку, чтобы править её прямо на столе. Полный режим: ${key}, кнопка «Редактировать» или значок в трее.`
      : 'Наведите курсор на карточку, чтобы править её. Горячая клавиша не зарегистрировалась — откройте режим правки кнопкой «Редактировать» или значком в трее.';
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
  ipcMain.handle('load-board', () => {
    const loaded = store.load();
    if (loaded && loaded.items && loaded.items.length) return { state: loaded, firstRun: false };
    const demo = Model.demoBoard();
    store.save(demo);
    return { state: demo, firstRun: !loaded };
  });

  ipcMain.handle('save-board', (_e, state) => {
    store.save(state);
    return { ok: true };
  });

  ipcMain.handle('export-board', async (_e, state) => {
    if (!mainWindow) return { ok: false };
    return store.exportBoard(mainWindow, state);
  });

  ipcMain.handle('import-board', async () => {
    if (!mainWindow) return { ok: false };
    return store.importBoard(mainWindow);
  });

  ipcMain.handle('set-edit-mode', async (_e, value) => {
    if (value) await enterEditMode();
    else await enterDesktopMode();
    return { editMode, hotkey: hotkeyLabel() };
  });

  ipcMain.handle('get-edit-mode', () => ({
    editMode,
    screenshot: isScreenshot(),
    hotkey: hotkeyLabel()
  }));

  ipcMain.handle('get-paths', () => ({
    dataDir: store.dataDir(),
    boardPath: store.boardPath()
  }));

  ipcMain.on('ignore-mouse', (_e, ignore) => {
    if (!mainWindow || mainWindow.isDestroyed() || isScreenshot()) return;
    if (editMode) {
      interacting = true;
      mainWindow.setIgnoreMouseEvents(false);
      return;
    }
    interacting = !ignore;
    mainWindow.setIgnoreMouseEvents(!!ignore, { forward: true });
  });

  ipcMain.handle('system-theme', () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'));
}

async function runScreenshot() {
  try {
    editMode = true;
    sendEditMode();
    mainWindow.setIgnoreMouseEvents(false);
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        const n = await mainWindow.webContents.executeJavaScript(
          'document.querySelectorAll(".item").length'
        );
        console.log('items-on-board', n);
        if (n > 0) break;
      } catch (err) {
        console.log('wait-board', err.message);
      }
    }
    await new Promise((r) => setTimeout(r, 400));
    const image = await mainWindow.webContents.capturePage();
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
  createWindow();
  if (!isScreenshot()) {
    createControlWindow();
    createTray();
    registerHotkeys();
    updateTrayMenu();
  }
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
