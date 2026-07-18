// Electron shell.
//
// In development it points at the `next dev` server. In a packaged build it
// forks the Next standalone server as a child process and waits for it to
// accept connections before showing a window, so the user never sees a blank
// page or a "connection refused" error.

const { app, BrowserWindow, ipcMain, session, shell, dialog } = require('electron')
const path = require('node:path')
const http = require('node:http')
const { fork } = require('node:child_process')

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

  // Electron's default agent advertises "Electron/x" and the app name, which
  // Cloudflare may challenge or refuse. Present the ordinary Chrome agent for
  // the Chromium actually embedded here - it is the honest version string, just
  // without the tokens that mark this as an embedded browser. The clearance is
  // issued against this agent and we store the same one, so they stay matched.
  const chromeMajor = (process.versions.chrome || '140').split('.')[0]
  const platformToken =
    process.platform === 'win32'
      ? 'Windows NT 10.0; Win64; x64'
      : process.platform === 'darwin'
        ? 'Macintosh; Intel Mac OS X 10_15_7'
        : 'X11; Linux x86_64'
  const browserUA = `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`
  ses.setUserAgent(browserUA)

  const win = new BrowserWindow({
    width: 1000,
    height: 820,
    title: 'Log in to pathofexile.com',
    autoHideMenuBar: true,
    webPreferences: { partition: POE_PARTITION, nodeIntegration: false, contextIsolation: true },
  })
  win.webContents.setUserAgent(browserUA)

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
