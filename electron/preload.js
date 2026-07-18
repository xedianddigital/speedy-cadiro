// Bridges the in-app PoE login to the page.
//
// The renderer is ordinary web UI with no Node access, so it can only ask the
// main process to run the login flow and hear back how it went.

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('poeDesktop', {
  /** True when the UI is running inside the desktop shell. */
  isDesktop: true,

  /**
   * Open a real browser window on pathofexile.com, wait for the user to log in,
   * then hand the resulting cookies to the local server.
   * Resolves to { ok, valid, reason?, found? }.
   */
  login: () => ipcRenderer.invoke('poe:login'),
})
