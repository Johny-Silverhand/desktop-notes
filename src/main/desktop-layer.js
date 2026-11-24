'use strict';

const { execFile } = require('child_process');

const HWND_BOTTOM = 1;
const HWND_TOPMOST = -1;
const HWND_NOTOPMOST = -2;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOACTIVATE = 0x0010;
const SWP_SHOWWINDOW = 0x0040;
const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_APPWINDOW = 0x00040000;

function hwndNumber(win) {
  const buf = win.getNativeWindowHandle();
  if (buf.length >= 8) return buf.readBigUInt64LE(0).toString(10);
  return buf.readUInt32LE(0).toString(10);
}

function runPowerShell(script) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 8000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          resolve({ ok: false, error: String(err.message || err), stderr: String(stderr || '') });
          return;
        }
        resolve({ ok: true, stdout: String(stdout || '').trim() });
      }
    );
  });
}

function win32Script(body) {
  return `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class SloyWin {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string c, string n);
  [DllImport("user32.dll")] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr c, string cl, string n);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll", SetLastError=true)]
  public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam, uint fuFlags, uint uTimeout, out IntPtr lpdwResult);
  [DllImport("user32.dll")] public static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
}
"@
${body}
`.trim();
}

// Never parent the board to WorkerW: on Windows 11 this often makes the
// window visible on the wallpaper but unable to receive mouse input.
async function detachFromDesktop(win) {
  if (process.platform !== 'win32') return { ok: true, method: 'noop' };
  const hwnd = hwndNumber(win);
  const script = win32Script(`
$hwnd = [IntPtr](${hwnd})
[SloyWin]::SetParent($hwnd, [IntPtr]::Zero) | Out-Null
Write-Output "detached"
`);
  return runPowerShell(script);
}

async function placeAboveDesktop(win) {
  if (process.platform !== 'win32') return { ok: false, method: 'unsupported' };
  const hwnd = hwndNumber(win);
  const script = win32Script(`
$hwnd = [IntPtr](${hwnd})
[SloyWin]::SetParent($hwnd, [IntPtr]::Zero) | Out-Null
$ex = [SloyWin]::GetWindowLong($hwnd, ${GWL_EXSTYLE})
$ex = $ex -bor ${WS_EX_TOOLWINDOW}
$ex = $ex -band (-bnot ${WS_EX_APPWINDOW})
[SloyWin]::SetWindowLong($hwnd, ${GWL_EXSTYLE}, $ex) | Out-Null
$flags = ${SWP_NOMOVE} -bor ${SWP_NOSIZE} -bor ${SWP_NOACTIVATE} -bor ${SWP_SHOWWINDOW}
[SloyWin]::SetWindowPos($hwnd, [IntPtr]${HWND_BOTTOM}, 0, 0, 0, 0, $flags) | Out-Null
Write-Output "bottom"
`);
  const res = await runPowerShell(script);
  return { ok: res.ok, method: res.stdout || 'bottom', error: res.error };
}

async function attachToDesktop(win) {
  return placeAboveDesktop(win);
}

async function sendToBack(win) {
  return placeAboveDesktop(win);
}

async function bringToFront(win) {
  if (process.platform !== 'win32') {
    win.setAlwaysOnTop(true);
    win.show();
    win.focus();
    win.setAlwaysOnTop(false);
    return { ok: true };
  }
  const hwnd = hwndNumber(win);
  const script = win32Script(`
$hwnd = [IntPtr](${hwnd})
[SloyWin]::SetParent($hwnd, [IntPtr]::Zero) | Out-Null
$ex = [SloyWin]::GetWindowLong($hwnd, ${GWL_EXSTYLE})
$ex = $ex -bor ${WS_EX_TOOLWINDOW}
$ex = $ex -band (-bnot ${WS_EX_APPWINDOW})
[SloyWin]::SetWindowLong($hwnd, ${GWL_EXSTYLE}, $ex) | Out-Null
$flags = ${SWP_NOMOVE} -bor ${SWP_NOSIZE} -bor ${SWP_SHOWWINDOW}
[SloyWin]::SetWindowPos($hwnd, [IntPtr]${HWND_TOPMOST}, 0, 0, 0, 0, $flags) | Out-Null
[SloyWin]::SetWindowPos($hwnd, [IntPtr]${HWND_NOTOPMOST}, 0, 0, 0, 0, $flags) | Out-Null
[SloyWin]::BringWindowToTop($hwnd) | Out-Null
[SloyWin]::SetForegroundWindow($hwnd) | Out-Null
Write-Output "ok"
`);
  const res = await runPowerShell(script);
  try {
    win.setAlwaysOnTop(true, 'pop-up-menu');
    win.show();
    win.focus();
    setTimeout(() => {
      try { if (win && !win.isDestroyed()) win.setAlwaysOnTop(false); } catch (_) { /* ignore */ }
    }, 200);
  } catch (_) { /* ignore */ }
  return res;
}

module.exports = {
  attachToDesktop,
  detachFromDesktop,
  placeAboveDesktop,
  sendToBack,
  bringToFront,
  hwndNumber
};
