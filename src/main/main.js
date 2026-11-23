'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut, ipcMain, screen, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./store');
const desktopLayer = require('./desktop-layer');
const Model = require('../shared/model');

const HOTKEY = 'CommandOrControl+Alt+N';

if (process.platform === 'linux') {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('in-process-gpu');
  app.commandLine.appendSwitch('use-gl', 'swiftshader');
}

let mainWindow = null;
let tray = null;
let editMode = false;
let isQuitting = false;
let zOrderTimer = null;
let screenshotPath = null;

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

function createWindow() {
  const area = workArea();
  const icon = nativeImage.createFromPath(path.join(__dirname, '../../assets/icon.png'));

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
    if (process.platform === 'win32') {
      await enterDesktopMode();
    } else {
      editMode = true;
      sendEditMode();
    }
  });

  mainWindow.on('close', (e) => {
    if (!isQuitting && !isScreenshot()) {
      e.preventDefault();
      enterDesktopMode();
    }
  });

  screen.on('display-metrics-changed', layoutToWorkArea);
  screen.on('display-added', layoutToWorkArea);
  screen.on('display-removed', layoutToWorkArea);
}

function layoutToWorkArea() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const area = workArea();
  mainWindow.setBounds({ x: area.x, y: area.y, width: area.width, height: area.height });
}

function sendEditMode() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('edit-mode', editMode);
  }
  updateTrayMenu();
}

async function enterEditMode() {
  editMode = true;
  stopZWatcher();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  layoutToWorkArea();
  mainWindow.setIgnoreMouseEvents(false);
  await desktopLayer.bringToFront(mainWindow);
  sendEditMode();
}

async function enterDesktopMode() {
  editMode = false;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  layoutToWorkArea();
  if (isScreenshot()) return;
  mainWindow.setAlwaysOnTop(false);
  mainWindow.setIgnoreMouseEvents(true, { forward: true });
  if (process.platform === 'win32') {
    const attached = await desktopLayer.attachToDesktop(mainWindow);
    if (!attached.ok || attached.method === 'bottom') {
      startZWatcher();
    }
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
    if (!editMode && mainWindow && !mainWindow.isDestroyed()) {
      desktopLayer.sendToBack(mainWindow);
    }
  }, 1200);
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
  tray.on('click', () => toggleEditMode());
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
  const template = [
    {
      label: editMode ? 'Вернуть на рабочий стол' : 'Режим правки',
      accelerator: 'Ctrl+Alt+N',
      click: () => toggleEditMode()
    },
    {
      label: 'Показать доску',
      click: () => enterEditMode()
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
    return { editMode };
  });

  ipcMain.handle('get-edit-mode', () => ({ editMode, screenshot: isScreenshot() }));

  ipcMain.handle('get-paths', () => ({
    dataDir: store.dataDir(),
    boardPath: store.boardPath()
  }));

  ipcMain.on('ignore-mouse', (_e, ignore) => {
    if (!mainWindow || mainWindow.isDestroyed() || isScreenshot()) return;
    if (editMode) {
      mainWindow.setIgnoreMouseEvents(false);
      return;
    }
    mainWindow.setIgnoreMouseEvents(!!ignore, { forward: true });
  });

  ipcMain.handle('system-theme', () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'));
}

async function runScreenshot() {
  try {
    editMode = true;
    sendEditMode();
    mainWindow.setIgnoreMouseEvents(false);
    mainWindow.webContents.on('console-message', (_e, level, message) => {
      console.log('renderer', level, message);
    });
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        const n = await mainWindow.webContents.executeJavaScript(
          'document.querySelectorAll(".item").length'
        );
        console.log('items-on-board', n);
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
    createTray();
    const ok = globalShortcut.register(HOTKEY, () => toggleEditMode());
    if (!ok) console.error('Failed to register hotkey', HOTKEY);
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
