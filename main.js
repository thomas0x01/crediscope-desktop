const {
  app, BrowserWindow, dialog, ipcMain,
} = require('electron');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');

// ── Paths ──
const ROOT = path.resolve(__dirname, '..');
const APP_DIR = path.join(ROOT, 'crediscope-llm');
const SERVER_PY = path.join(APP_DIR, 'server.py');
const BUNDLED_SERVER = path.join(process.resourcesPath, 'crediscope-llm', 'dist',
  process.platform === 'win32' ? 'crediscope-server.exe' : 'crediscope-server');

const LOG_DIR = (() => {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Logs', 'crediscope-llm');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'crediscope-llm', 'logs');
  }
  return path.join(os.homedir(), '.local', 'share', 'crediscope-llm', 'logs');
})();

let mainWindow = null;
let pythonProcess = null;
let backendPort = 8720;
let jobRunning = false;
let isQuitting = false;

function findPython() {
  const candidates = process.platform === 'win32'
    ? ['python', 'python3', 'py']
    : ['python3', 'python'];
  for (const cmd of candidates) {
    try {
      const result = execSync(`${cmd} --version 2>&1`, { encoding: 'utf-8' });
      if (result.includes('Python 3')) return cmd;
    } catch (_) {}
  }
  return null;
}

function portInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(true));
    server.once('listening', () => { server.close(); resolve(false); });
    server.listen(port, '127.0.0.1');
  });
}

async function findFreePort() {
  for (let port = 8720; port <= 8730; port++) {
    if (!(await portInUse(port))) return port;
  }
  throw new Error('No available port in range 8720–8730');
}

function healthCheck() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${backendPort}/api/health`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data).status === 'ok'); } catch (_) { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => { req.destroy(); resolve(false); });
  });
}

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, 'backend.log'), line);
  } catch (_) {}
}

function logTail(lines = 30) {
  try {
    const logPath = path.join(LOG_DIR, 'backend.log');
    if (!fs.existsSync(logPath)) return '';
    const content = fs.readFileSync(logPath, 'utf-8');
    return content.split('\n').slice(-lines).join('\n');
  } catch (_) { return ''; }
}

// ── Backend lifecycle ──

async function startBackend() {
  let cmd, args;

  if (app.isPackaged) {
    if (!fs.existsSync(BUNDLED_SERVER)) {
      dialog.showErrorBox('应用损坏', `未找到后端可执行文件:\n${BUNDLED_SERVER}`);
      app.quit();
      return false;
    }
    cmd = BUNDLED_SERVER;
    args = [];
  } else {
    const python = findPython();
    if (!python) {
      dialog.showErrorBox('未找到 Python', '请安装 Python 3.10+。\n\nhttps://www.python.org/downloads/');
      app.quit();
      return false;
    }
    cmd = python;
    args = [SERVER_PY];
  }

  backendPort = await findFreePort();
  log(`Starting backend: ${cmd} ${args.join(' ')} on port ${backendPort}`);

  const dataDir = process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'mainframe0x01')
    : path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'mainframe0x01');
  fs.mkdirSync(dataDir, { recursive: true });

  const env = {
    ...process.env,
    PORT: String(backendPort),
    MAINFRAME_DATA_DIR: process.env.MAINFRAME_DATA_DIR || dataDir,
    PYTHONUTF8: '1',
  };

  pythonProcess = spawn(cmd, args, {
    cwd: APP_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  pythonProcess.stdout.on('data', (data) => log(`[stdout] ${data.toString().trim()}`));
  pythonProcess.stderr.on('data', (data) => log(`[stderr] ${data.toString().trim()}`));
  pythonProcess.on('exit', (code) => {
    log(`Backend exited with code ${code}`);
    if (!isQuitting && mainWindow) {
      mainWindow.webContents.send('backend-down');
    }
  });

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (pythonProcess.exitCode !== null) {
      const tail = logTail(20);
      dialog.showErrorBox('后端启动失败',
        `后端进程异常退出 (code ${pythonProcess.exitCode})。\n\n日志：\n${tail || '(无)'}`);
      app.quit();
      return false;
    }
    if (await healthCheck()) {
      log('Backend ready');
      return true;
    }
  }

  const tail = logTail(20);
  dialog.showErrorBox('后端启动超时', `Python 服务在 15 秒内未就绪。\n\n日志：\n${tail || '(无)'}`);
  app.quit();
  return false;
}

function stopBackend() {
  if (!pythonProcess) return;
  const proc = pythonProcess;
  pythonProcess = null;
  isQuitting = true;

  if (process.platform === 'win32') {
    try { execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch (_) {}
  } else {
    proc.kill('SIGTERM');
    const killer = setTimeout(() => { if (proc.exitCode === null) proc.kill('SIGKILL'); }, 3000);
    proc.on('exit', () => clearTimeout(killer));
  }
}

// ── Window ──

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400, height: 900,
    minWidth: 1024, minHeight: 680,
    title: 'Crediscope LLM',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.session.on('will-download', (_event, item) => {
    const filePath = dialog.showSaveDialogSync(mainWindow, {
      defaultPath: path.join(os.homedir(), 'Downloads', item.getFilename()),
      title: '保存文件',
    });
    if (filePath) { item.setSavePath(filePath); } else { item.cancel(); }
  });

  if (app.isPackaged) {
    mainWindow.webContents.on('devtools-opened', () => mainWindow.webContents.closeDevTools());
  }

  mainWindow.loadURL(`http://127.0.0.1:${backendPort}`);

  mainWindow.on('close', (e) => {
    if (jobRunning && !isQuitting) {
      e.preventDefault();
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: 'warning', buttons: ['取消', '确定退出'], defaultId: 0, cancelId: 0,
        title: '分析进行中', message: '分析任务正在进行中，退出将中断任务。确定退出吗？',
      });
      if (choice === 1) { isQuitting = true; stopBackend(); mainWindow.destroy(); }
    } else { stopBackend(); }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── IPC ──

ipcMain.on('job-started', () => { jobRunning = true; });
ipcMain.on('job-ended', () => { jobRunning = false; });
ipcMain.handle('get-backend-url', () => `http://127.0.0.1:${backendPort}`);
ipcMain.handle('get-app-version', () => app.getVersion());

// ── App lifecycle ──

app.whenReady().then(async () => {
  const ok = await startBackend();
  if (ok === false) return;
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => stopBackend());
