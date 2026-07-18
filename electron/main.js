// Electron shell.
//
// In development it points at the `next dev` server. In a packaged build it
// forks the Next standalone server as a child process and waits for it to
// accept connections before showing a window, so the user never sees a blank
// page or a "connection refused" error.

const { app, BrowserWindow, Menu, ipcMain, session, shell, dialog } = require('electron')
const path = require('node:path')
const http = require('node:http')
const { fork, spawn } = require('node:child_process')

/**
 * Cookies live in their own persistent partition so a login survives restarts
 * and stays separate from anything the app itself loads.
 */
const POE_PARTITION = 'persist:poe'
const POE_LOGIN_URL = 'https://www.pathofexile.com/login'

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

/**
 * Log in to pathofexile.com in a real browser window we control.
 *
 * This is the only route that works on Chrome 127+, where cookies are sealed
 * with an app-bound key no other process can use. It also sidesteps the file
 * being locked, write-ahead-log recovery, and the User-Agent problem: the
 * cf_clearance is issued against this window's own agent, so the two match by
 * construction rather than by reconstruction.
 */
async function runLogin() {
  const ses = session.fromPartition(POE_PARTITION)

  // Do NOT override the User-Agent here. Spoofing a plain Chrome agent while
  // Chromium still sends its own Sec-CH-UA client hints (which name Electron)
  // produces a contradiction Cloudflare detects, and its check then loops
  // forever without ever issuing a clearance. Leaving the default agent alone
  // keeps the request internally consistent; whatever it is, it is what the
  // clearance gets issued against, and it is what we store.
  const win = new BrowserWindow({
    width: 1000,
    height: 820,
    title: 'Log in to pathofexile.com',
    autoHideMenuBar: true,
    webPreferences: { partition: POE_PARTITION, nodeIntegration: false, contextIsolation: true },
  })
  const browserUA = win.webContents.getUserAgent()

  const readCookies = async () => {
    const jar = await ses.cookies.get({ domain: '.pathofexile.com' })
    const pick = (name) => jar.find((c) => c.name === name)?.value ?? ''
    return {
      poesessid: pick('POESESSID'),
      poetoken: pick('POETOKEN'),
      cfClearance: pick('cf_clearance'),
    }
  }

  return new Promise((resolve) => {
    let settled = false
    const finish = async (result) => {
      if (settled) return
      settled = true
      clearInterval(poll)
      if (!win.isDestroyed()) win.destroy()
      resolve(result)
    }

    // Poll rather than guess at navigation events: the cookie can be set by a
    // redirect, an XHR, or a Cloudflare challenge the user solves by hand.
    const poll = setInterval(async () => {
      if (win.isDestroyed()) return
      try {
        const cookies = await readCookies()
        if (!cookies.poesessid) return

        const res = await postJson(`${baseUrl}/api/session`, {
          ...cookies,
          userAgent: browserUA,
          // The cookies came from this window, so its Electron agent is the
          // correct one and must not be replaced.
          trustUserAgent: true,
        })
        // A POESESSID exists before login completes; only stop once the API
        // actually accepts it.
        if (res?.valid) await finish({ ok: true, valid: true, found: Object.keys(cookies).filter((k) => cookies[k]) })
      } catch {
        // Keep polling; the user may still be logging in.
      }
    }, 1500)

    win.on('closed', () => {
      void finish({
        ok: false,
        valid: false,
        reason: 'Login window closed before a valid session appeared.',
      })
    })

    win.loadURL(POE_LOGIN_URL).catch((err) => {
      void finish({ ok: false, valid: false, reason: `Could not open the login page: ${err.message}` })
    })
  })
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const target = new URL(url)
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(data))
          } catch {
            resolve(null)
          }
        })
      },
    )
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

/**
 * Launch the platform uninstaller and quit.
 *
 * electron-builder's NSIS target leaves "Uninstall <ProductName>.exe" beside the
 * installed binary. It has to run detached: it deletes this very executable, so
 * it cannot be a child that dies with us.
 */
async function runUninstall() {
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['Uninstall', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Uninstall PoE Trade Notifier',
    message: 'Uninstall PoE Trade Notifier?',
    detail:
      'The app will close and the uninstaller will open. Your saved session and settings are kept, so reinstalling restores them.',
  })
  if (response !== 0) return { ok: false, cancelled: true }

  if (process.platform !== 'win32') {
    await dialog.showMessageBox({
      type: 'info',
      title: 'Uninstall',
      message: 'Nothing to uninstall',
      detail:
        'This build is a portable AppImage - delete the .AppImage file to remove it. Settings live in ~/.config/poe-trade-notifier.',
    })
    return { ok: false, unsupported: true }
  }

  const uninstaller = path.join(path.dirname(process.execPath), 'Uninstall PoE Trade Notifier.exe')
  try {
    spawn(uninstaller, [], { detached: true, stdio: 'ignore' }).unref()
  } catch (err) {
    dialog.showErrorBox('Uninstall failed', `Could not start the uninstaller: ${err.message}`)
    return { ok: false, error: String(err.message) }
  }

  app.isQuiting = true
  setTimeout(() => app.quit(), 500)
  return { ok: true }
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        ...(process.platform === 'win32'
          ? [{ label: 'Uninstall…', click: () => void runUninstall() }, { type: 'separator' }]
          : []),
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Project page',
          click: () => shell.openExternal('https://github.com/xedianddigital/poe-trade-notifier'),
        },
        {
          label: `Version ${app.getVersion()}`,
          enabled: false,
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
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
      // Node access of its own beyond the login bridge.
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
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

  ipcMain.handle('poe:version', () => app.getVersion())
  ipcMain.handle('poe:uninstall', () => runUninstall())

  ipcMain.handle('poe:login', async () => {
    try {
      return await runLogin()
    } catch (err) {
      return { ok: false, valid: false, reason: String(err && err.message ? err.message : err) }
    }
  })

  app.whenReady().then(async () => {
    try {
      baseUrl = await startServer()
      buildMenu()
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
