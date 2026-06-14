const {
  app, BrowserWindow, dialog, ipcMain,
} = require('electron');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');

// ── 路径 ────────────────────────────────────────────────────────
// 开发模式：app/ 在项目根目录下
const ROOT = path.resolve(__dirname, '..');
const APP_DIR = path.join(ROOT, 'crediscope-llm');
const SERVER_PY = path.join(APP_DIR, 'server.py');
// 打包模式：PyInstaller 产物在 extraResources/app/dist/ 下
const BUNDLED_SERVER = path.join(process.resourcesPath, 'crediscope-llm', 'dist',
  process.platform === 'win32' ? 'crediscope-server.exe' : 'crediscope-server');

// 平台日志目录
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

// ── 工具函数 ────────────────────────────────────────────────────

/** 查找 Python 可执行文件 */
function findPython() {
  const candidates = process.platform === 'win32'
    ? ['python', 'python3', 'py']
    : ['python3', 'python'];
  for (const cmd of candidates) {
    try {
      const result = execSync(
        `${cmd} --version 2>&1`, { encoding: 'utf-8' }
      );
      if (result.includes('Python 3')) return cmd;
    } catch (_) { /* not found */ }
  }
  return null;
}

/** 检查端口是否可用 */
function portInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(true));
    server.once('listening', () => {
      server.close();
      resolve(false);
    });
    server.listen(port, '127.0.0.1');
  });
}

/** 从 8720 开始扫描可用端口 */
async function findFreePort() {
  for (let port = 8720; port <= 8730; port++) {
    if (!(await portInUse(port))) return port;
  }
  throw new Error('No available port in range 8720–8730');
}

/** HTTP 健康检查 */
function healthCheck() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${backendPort}/api/health`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.status === 'ok');
        } catch (_) {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => { req.destroy(); resolve(false); });
  });
}

/** 写入日志 */
function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, 'backend.log'), line);
  } catch (_) { /* ignore */ }
}

/** 读取日志尾部 */
function logTail(lines = 30) {
  try {
    const logPath = path.join(LOG_DIR, 'backend.log');
    if (!fs.existsSync(logPath)) return '';
    const content = fs.readFileSync(logPath, 'utf-8');
    return content.split('\n').slice(-lines).join('\n');
  } catch (_) {
    return '';
  }
}

// ── 后端生命周期 ─────────────────────────────────────────────────

async function startBackend() {
  let cmd, args;

  if (app.isPackaged) {
    // 打包模式：使用 PyInstaller 产物，不需要系统 Python
    if (!fs.existsSync(BUNDLED_SERVER)) {
      dialog.showErrorBox('应用损坏', `未找到后端可执行文件:\n${BUNDLED_SERVER}`);
      app.quit();
      return false;
    }
    cmd = BUNDLED_SERVER;
    args = [];
  } else {
    // 开发模式：使用系统 Python 运行 server.py
    const python = findPython();
    if (!python) {
      dialog.showErrorBox(
        '未找到 Python',
        '请安装 Python 3.10 或更高版本。\n\nhttps://www.python.org/downloads/'
      );
      app.quit();
      return false;
    }
    cmd = python;
    args = [SERVER_PY];
  }

  backendPort = await findFreePort();

  log(`Starting backend: ${cmd} ${args.join(' ')} on port ${backendPort}`);

  // 确保必要目录存在
  const dataDir = process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'mainframe0x01')
    : path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'mainframe0x01');
  fs.mkdirSync(dataDir, { recursive: true });

  const env = {
    ...process.env,
    PORT: String(backendPort),
    MAINFRAME_DATA_DIR: process.env.MAINFRAME_DATA_DIR || dataDir,
    PYTHONUTF8: '1',  // Windows: 强制 Python 用 UTF-8，避免 GBK 乱码
  };

  pythonProcess = spawn(cmd, args, {
    cwd: APP_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  pythonProcess.stdout.on('data', (data) => {
    log(`[stdout] ${data.toString().trim()}`);
  });

  pythonProcess.stderr.on('data', (data) => {
    log(`[stderr] ${data.toString().trim()}`);
  });

  pythonProcess.on('exit', (code) => {
    log(`Backend exited with code ${code}`);
    if (!isQuitting && mainWindow) {
      mainWindow.webContents.send('backend-down');
    }
  });

  // 健康检查轮询（每 500ms，最长 15 秒）
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    // 进程提前退出 = 启动失败
    if (pythonProcess.exitCode !== null) {
      const tail = logTail(20);
      dialog.showErrorBox(
        '后端启动失败',
        `后端进程异常退出 (code ${pythonProcess.exitCode})。\n\n可能原因：架构不匹配（ARM/Intel）或缺少依赖。\n\n日志：\n${tail || '(无)'}`
      );
      app.quit();
      return false;
    }
    if (await healthCheck()) {
      log('Backend ready');
      return true;
    }
  }

  // 超时
  const tail = logTail(20);
  dialog.showErrorBox(
    '后端启动超时',
    `Python 服务在 15 秒内未就绪。\n\n最近日志：\n${tail || '(无)'}`
  );
  app.quit();
  return false;
}

function stopBackend() {
  if (!pythonProcess) return;
  const proc = pythonProcess;
  pythonProcess = null;
  isQuitting = true;

  if (process.platform === 'win32') {
    try {
      execSync(
        `taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' }
      );
    } catch (_) { /* may already be dead */ }
  } else {
    proc.kill('SIGTERM');
    const killer = setTimeout(() => {
      if (proc.exitCode === null) {
        proc.kill('SIGKILL');
      }
    }, 3000);
    proc.on('exit', () => clearTimeout(killer));
  }
}

// ── 窗口管理 ────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    title: 'Crediscope LLM',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 文件下载处理
  mainWindow.webContents.session.on('will-download', (_event, item) => {
    const filePath = dialog.showSaveDialogSync(mainWindow, {
      defaultPath: path.join(os.homedir(), 'Downloads', item.getFilename()),
      title: '保存报告',
    });
    if (filePath) {
      item.setSavePath(filePath);
      item.on('done', (_e, state) => {
        if (state === 'completed') {
          log(`Download completed: ${filePath}`);
        }
      });
    } else {
      item.cancel();
    }
  });

  // 生产环境禁用 DevTools
  if (app.isPackaged) {
    mainWindow.webContents.on('devtools-opened', () => {
      mainWindow.webContents.closeDevTools();
    });
  }

  // 渲染进程崩溃恢复
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log(`Renderer crashed: ${details.reason} (exit code: ${details.exitCode})`);
  });

  mainWindow.loadURL(`http://127.0.0.1:${backendPort}`);

  // 退出拦截
  mainWindow.on('close', (e) => {
    if (jobRunning && !isQuitting) {
      e.preventDefault();
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: 'warning',
        buttons: ['取消', '确定退出'],
        defaultId: 0,
        cancelId: 0,
        title: '分析任务正在进行',
        message: '分析任务正在进行中，退出将中断任务并丢失进度。确定要退出吗？',
      });
      if (choice === 1) {
        isQuitting = true;
        stopBackend();
        mainWindow.destroy();
      }
    } else {
      stopBackend();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── IPC 处理 ────────────────────────────────────────────────────

if (ipcMain) {
ipcMain.on('job-started', () => {
  jobRunning = true;
});

ipcMain.on('job-ended', () => {
  jobRunning = false;
});

ipcMain.handle('get-backend-url', () => {
  return `http://127.0.0.1:${backendPort}`;
});

ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});
} // ipcMain guard

ipcMain?.handle('submit-feedback', async (_event, note) => {
  try {
    const pkg = require('./package.json');
    const token = pkg.feedbackToken || process.env.FEEDBACK_TOKEN;
    if (!token) {
      log('Feedback skipped: feedbackToken not configured');
      return { ok: false, error: 'Token not configured' };
    }

    const crypto = require('crypto');
    const zlib = require('zlib');

    // 收集日志（明文拼接）
    const lines = [];
    lines.push(`=== Agent Log ===`);
    const clientsDir = path.join(os.homedir(), 'Library', 'Application Support', 'crediscope-llm', 'clients');
    try {
      const dirs = fs.readdirSync(clientsDir).filter(d => !d.startsWith('未命名'));
      let latestLog = null, latestTime = 0;
      for (const dir of dirs) {
        const p = path.join(clientsDir, dir, 'outputs', 'agent.log');
        try { const s = fs.statSync(p); if (s.mtimeMs > latestTime) { latestTime = s.mtimeMs; latestLog = p; } } catch (_) {}
      }
      if (latestLog) lines.push(fs.readFileSync(latestLog, 'utf-8'));
    } catch (_) {}

    lines.push(`\n=== Backend Log ===`);
    lines.push(logTail(200));
    lines.push(`\n=== System ===`);
    lines.push(`App: ${app.getVersion()}\nOS: ${os.type()} ${os.release()}\nArch: ${os.arch()}\nDate: ${new Date().toISOString()}`);
    if (note) { lines.push(`\n=== User Note ===`); lines.push(note); }

    const plaintext = lines.join('\n');

    // gzip → AES-256-CBC 加密
    const gzipped = zlib.gzipSync(plaintext);
    const key = crypto.createHash('sha256').update('mainframe-feedback-key').digest();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    const encrypted = Buffer.concat([iv, cipher.update(gzipped), cipher.final()]);
    const b64 = encrypted.toString('base64');

    // 创建 secret Gist
    const https = require('https');
    const gistData = JSON.stringify({
      description: `Feedback ${app.getVersion()} — ${new Date().toISOString().slice(0, 10)}`,
      public: false,
      files: { 'feedback.enc': { content: b64 } },
    });

    const gistUrl = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.github.com', path: '/gists', method: 'POST',
        headers: { 'Authorization': `token ${token}`, 'User-Agent': 'crediscope-desktop', 'Content-Type': 'application/json' },
      }, (res) => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => {
          if (res.statusCode === 201) resolve(JSON.parse(d).html_url);
          else { log(`Gist failed: ${res.statusCode}`); reject(new Error(`Gist ${res.statusCode}`)); }
        });
      });
      req.on('error', reject);
      req.write(gistData);
      req.end();
    });

    // 创建 Issue（只含非敏感信息）
    const issueBody = [
      `**日志附件（加密）：** ${gistUrl}`,
      ``,
      `> 解密：下载 \`.enc\` 文件后用 \`node decrypt-feedback.js feedback.enc\` 解密`,
      `> 解密脚本：https://github.com/thomas0x01/crediscope-desktop/blob/master/desktop/decrypt-feedback.js`,
      ``,
      `## System Info`,
      `- App: ${app.getVersion()}`,
      `- OS: ${os.type()} ${os.release()}`,
      `- Arch: ${os.arch()}`,
      note ? `\n## User Note\n${note}` : '',
    ].join('\n');

    await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.github.com', path: '/repos/thomas0x01/crediscope-desktop/issues', method: 'POST',
        headers: { 'Authorization': `token ${token}`, 'User-Agent': 'crediscope-desktop', 'Content-Type': 'application/json' },
      }, (res) => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => {
          if (res.statusCode === 201) { log('Feedback submitted'); resolve(true); }
          else { log(`Issue failed: ${res.statusCode}`); reject(new Error(`Issue ${res.statusCode}`)); }
        });
      });
      req.on('error', reject);
      req.write(JSON.stringify({ title: `[Feedback] ${app.getVersion()} — ${new Date().toISOString().slice(0, 10)}`, body: issueBody, labels: ['feedback'] }));
      req.end();
    });

    return { ok: true };
  } catch (e) {
    log(`Feedback error: ${e.message}`);
    return { ok: false, error: e.message };
  }
});

// ── 应用生命周期 ────────────────────────────────────────────────

app.whenReady().then(async () => {
  const ok = await startBackend();
  if (ok === false) return; // startBackend already called app.quit()

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  stopBackend();
});
