// Electron shell.
//
// In development it points at the `next dev` server. In a packaged build it
// forks the Next standalone server as a child process and waits for it to
// accept connections before showing a window, so the user never sees a blank
// page or a "connection refused" error.

const { app, BrowserWindow, shell, dialog } = require('electron')
const path = require('node:path')
const http = require('node:http')
const { fork } = require('node:child_process')

const isDev = !app.isPackaged
const DEV_URL = 'http://localhost:3000'

let serverProcess = null
let mainWindow = null
let baseUrl = DEV_URL

/** Ask the OS for a free port so two instances can't collide. */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume()
        resolve()
      })
      req.on('error', () => {
        if (Date.now() > deadline) {
          reject(new Error(`Server did not start within ${timeoutMs / 1000}s.`))
        } else {
          setTimeout(attempt, 250)
        }
      })
      req.setTimeout(2000, () => req.destroy())
    }
    attempt()
  })
}

async function startServer() {
  if (isDev) return DEV_URL

  const port = await findFreePort()
  // Built with asar disabled, so these are real files on disk - which the
  // forked Node process and its native module both need.
  const appRoot = path.join(app.getAppPath(), 'server')
  const serverPath = path.join(appRoot, 'server.js')

  serverProcess = fork(serverPath, [], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      HOSTNAME: '127.0.0.1',
      // Cookies and settings belong in the per-user data dir, not next to the
      // read-only install.
      POE_DATA_DIR: path.join(app.getPath('userData'), 'data'),
    },
    cwd: appRoot,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })

  serverProcess.stdout?.on('data', (d) => console.log('[next]', d.toString().trim()))
  serverProcess.stderr?.on('data', (d) => console.error('[next]', d.toString().trim()))
  serverProcess.on('exit', (code) => {
    if (code !== 0 && !app.isQuiting) {
      dialog.showErrorBox('Server stopped', `The background server exited with code ${code}.`)
    }
  })

  const url = `http://127.0.0.1:${port}`
  await waitForServer(url)
  return url
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0a0a0a',
    show: false,
    title: 'PoE Trade Notifier',
    webPreferences: {
      // The renderer only talks to the local server over HTTP; it needs no
      // Node access of its own.
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Trade links and anything else external belong in the real browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(baseUrl)) {
      event.preventDefault()
      shell.openExternal(url)
    }
  })

  mainWindow.loadURL(baseUrl)
}

// One instance only: a second launch focuses the existing window instead of
// starting a second server and a second set of sockets to GGG.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    try {
      baseUrl = await startServer()
      createWindow()
    } catch (err) {
      dialog.showErrorBox('Failed to start', String(err && err.message ? err.message : err))
      app.quit()
    }
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

app.on('before-quit', () => {
  app.isQuiting = true
  // Close the live sockets to GGG cleanly rather than leaving them to time out.
  if (serverProcess && !serverProcess.killed) serverProcess.kill()
})
