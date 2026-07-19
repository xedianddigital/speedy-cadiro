// Electron shell.
//
// In development it points at the `next dev` server. In a packaged build it
// forks the Next standalone server as a child process and waits for it to
// accept connections before showing a window, so the user never sees a blank
// page or a "connection refused" error.

const { app, BrowserWindow, Menu, ipcMain, session, shell, dialog } = require('electron')
const path = require('node:path')
const http = require('node:http')
const https = require('node:https')
const { fork, spawn } = require('node:child_process')

/**
 * Cookies live in their own persistent partition so a login survives restarts
 * and stays separate from anything the app itself loads.
 */
const POE_PARTITION = 'persist:poe'
const POE_LOGIN_URL = 'https://www.pathofexile.com/login'

/**
 * The only outbound request this app makes that isn't to pathofexile.com on
 * the user's own behalf. It's a single anonymous GET against GitHub's public
 * releases API - no telemetry, no identifiers - just "what's the newest tag,"
 * so the UI can tell the user a newer build exists instead of leaving them to
 * notice on their own.
 */
const RELEASES_API_URL = 'https://api.github.com/repos/xedianddigital/speedy-cadiro/releases/latest'
const RELEASES_PAGE_URL = 'https://github.com/xedianddigital/speedy-cadiro/releases/latest'

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
    if (app.isQuiting) return
    console.error(`[next] server exited with code ${code}`)
    // The server can die mid-session (e.g. an unexpected error slipping past
    // its own guards). Left alone, the already-loaded window just stares at a
    // socket nothing answers on. Bring the server back and point the window
    // at it again rather than leaving that behind.
    void restartServer()
  })

  const url = `http://127.0.0.1:${port}`
  await waitForServer(url)
  return url
}

let restarting = false

async function restartServer() {
  if (restarting || isDev) return
  restarting = true
  try {
    baseUrl = await startServer()
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(baseUrl)
  } catch (err) {
    dialog.showErrorBox('Server stopped', `The background server exited and could not be restarted: ${err.message}`)
  } finally {
    restarting = false
  }
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

  // Start every login clean. pathofexile.com sets a guest POESESSID before you
  // actually sign in, and a persisted one from a failed attempt is what left a
  // user stuck on a 401 with no way to reset. Wiping first guarantees the
  // cookies we capture belong to a real, completed login.
  await ses.clearStorageData({ storages: ['cookies'] })

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

  // Detect login from *inside* the window, not with a separate request.
  //
  // A separate fetch/net.request has a different fingerprint than the window
  // that just solved the Cloudflare challenge, so Cloudflare blocks it and the
  // check never succeeds even though the user is plainly logged in. Asking the
  // page's own DOM avoids that entirely: pathofexile.com renders a logout link
  // in its header only when authenticated, and never on the login page or a
  // Cloudflare challenge screen.
  const isLoggedIn = async () => {
    if (win.isDestroyed()) return false
    try {
      return await win.webContents.executeJavaScript(
        `!!document.querySelector('a[href*="/logout"], form[action*="/logout"]')`,
        true,
      )
    } catch {
      return false
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

    // Poll rather than guess at navigation events: login can complete via a
    // redirect, an XHR, or an SSO round-trip. Settle only once the account is
    // genuinely authenticated, so the window stays open until the user has
    // actually signed in rather than closing on the guest session.
    const poll = setInterval(async () => {
      if (win.isDestroyed()) return
      try {
        // The window's DOM is the authority that the user is logged in.
        if (!(await isLoggedIn())) return
        const cookies = await readCookies()
        if (!cookies.poesessid) return

        // Store the real cookies with this window's own agent, which is what the
        // Cloudflare clearance was issued against.
        const res = await postJson(`${baseUrl}/api/session`, {
          ...cookies,
          userAgent: browserUA,
          trustUserAgent: true,
        })
        // Trust the DOM even if the server's own re-check is momentarily blocked
        // by Cloudflare; the session is stored either way.
        await finish({
          ok: true,
          valid: res?.valid !== false,
          found: Object.keys(cookies).filter((k) => cookies[k]),
        })
      } catch {
        // Keep polling; the user may still be logging in.
      }
    }, 2000)

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

/** true if `a` is a newer semver than `b` ("0.10.0" > "0.9.0", not string-order). */
function isNewerVersion(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0
    const y = pb[i] || 0
    if (x !== y) return x > y
  }
  return false
}

/** Ask GitHub for the latest release tag. Resolves to null on any failure - this must never block startup. */
function fetchLatestRelease() {
  return new Promise((resolve) => {
    const req = https.get(
      RELEASES_API_URL,
      { headers: { 'User-Agent': 'SpeedyCadiro', Accept: 'application/vnd.github+json' } },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          try {
            const json = JSON.parse(data)
            const tag = typeof json.tag_name === 'string' ? json.tag_name : null
            if (!tag) return resolve(null)
            resolve({ version: tag.replace(/^v/, ''), url: json.html_url || RELEASES_PAGE_URL })
          } catch {
            resolve(null)
          }
        })
      },
    )
    req.on('error', () => resolve(null))
    req.setTimeout(8000, () => req.destroy())
  })
}

async function checkForUpdate() {
  const current = app.getVersion()
  const latest = await fetchLatestRelease()
  if (!latest || !isNewerVersion(latest.version, current)) {
    return { available: false, current }
  }
  return { available: true, current, latest: latest.version, url: latest.url }
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
    title: 'Uninstall SpeedyCadiro',
    message: 'Uninstall SpeedyCadiro?',
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
        'This build is a portable AppImage - delete the .AppImage file to remove it. Settings live in ~/.config/speedy-cadiro.',
    })
    return { ok: false, unsupported: true }
  }

  const uninstaller = path.join(path.dirname(process.execPath), 'Uninstall SpeedyCadiro.exe')
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
        {
          label: 'Options…',
          accelerator: 'CmdOrCtrl+,',
          click: () => mainWindow?.webContents.send('poe:open-options'),
        },
        { type: 'separator' },
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
          click: () => shell.openExternal('https://github.com/xedianddigital/speedy-cadiro'),
        },
        {
          label: `Version ${app.getVersion()}`,
          enabled: false,
        },
        { type: 'separator' },
        ...(process.platform === 'win32'
          ? [{ label: 'Uninstall', click: () => void runUninstall() }]
          : []),
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
    title: 'SpeedyCadiro',
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

  // Chromium's built-in "page didn't load" screen is a dead end here: its
  // Reload/Back buttons rely on native Chrome plumbing Electron doesn't ship,
  // so once that screen shows up the user is stuck looking at it. Handle the
  // failure ourselves instead - wait for the local server to answer again and
  // reload the real page, so the user never sees that screen.
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, _desc, validatedURL, isMainFrame) => {
    // -3 is ERR_ABORTED: a normal cancelled navigation (e.g. the reload we
    // just issued superseding an in-flight one), not a real failure.
    if (!isMainFrame || errorCode === -3) return
    if (!validatedURL.startsWith(baseUrl)) return
    console.error(`[electron] main frame failed to load (${errorCode}); retrying once the server answers`)
    void waitForServer(baseUrl)
      .then(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return
        mainWindow.loadURL(baseUrl)
      })
      .catch(() => {
        // Server never came back on its own; the exit handler's restart path
        // will load the window once it does.
      })
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
  ipcMain.handle('poe:check-update', () => checkForUpdate())
  ipcMain.handle('poe:report-error', (_event, { message, stack }) => {
    console.error('[renderer]', message)
    if (stack) console.error(stack)
    return { ok: true }
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
