// Bridges the in-app PoE login to the page.
//
// The renderer is ordinary web UI with no Node access, so it can only ask the
// main process to run the login flow and hear back how it went.

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('poeDesktop', {
  /** True when the UI is running inside the desktop shell. */
  isDesktop: true,

  /** Installed app version, for the UI to display. */
  version: () => ipcRenderer.invoke('poe:version'),

  /**
   * Check GitHub for a newer release. Resolves to { available: false, current }
   * or { available: true, current, latest, url }. Never rejects - a failed
   * check (offline, GitHub down) just reports nothing available.
   */
  checkForUpdate: () => ipcRenderer.invoke('poe:check-update'),

  /** Surface a renderer-side crash in the main process's own logs, so it's diagnosable without DevTools open. */
  reportError: (message, stack) => ipcRenderer.invoke('poe:report-error', { message, stack }),

  /** Run the platform uninstaller, after confirming with the user. */
  uninstall: () => ipcRenderer.invoke('poe:uninstall'),

  /** Subscribe to File -> Options being chosen from the native menu. */
  onOpenOptions: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('poe:open-options', handler)
    return () => ipcRenderer.removeListener('poe:open-options', handler)
  },

  /**
   * Open a real browser window on pathofexile.com, wait for the user to log in,
   * then hand the resulting cookies to the local server.
   * Resolves to { ok, valid, reason?, found? }.
   */
  login: () => ipcRenderer.invoke('poe:login'),
})
