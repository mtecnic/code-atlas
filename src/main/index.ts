import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerIpc } from './ipc'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0a0e17',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => (mainWindow = null))

  // dev/test hooks: ATLAS_OPEN=<repo path> auto-analyzes on launch,
  // ATLAS_SHOT=<png path> captures the window (waits for analysis to settle)
  const autoOpen = process.env.ATLAS_OPEN
  const shotPath = process.env.ATLAS_SHOT
  if (autoOpen || shotPath) {
    mainWindow.webContents.once('did-finish-load', () => {
      if (autoOpen) {
        setTimeout(() => {
          mainWindow?.webContents.executeJavaScript(
            `window.atlas.analyze(${JSON.stringify(autoOpen)})`
          )
        }, 1500)
      }
      const shotDelay = Number(process.env.ATLAS_SHOT_DELAY ?? (autoOpen ? 16000 : 6000))
      const evalCode = process.env.ATLAS_EVAL
      if (evalCode) {
        setTimeout(async () => {
          try {
            const result = await mainWindow!.webContents.executeJavaScript(evalCode)
            console.log('[atlas] eval result:', JSON.stringify(result))
          } catch (e) {
            console.error('[atlas] eval failed:', e)
          }
        }, Math.max(3000, shotDelay - 10000))
      }
      const mode = process.env.ATLAS_MODE
      if (mode) {
        setTimeout(() => {
          mainWindow?.webContents.executeJavaScript(
            `window.__atlasDebug.store.getState().setMode(${JSON.stringify(mode)})`
          )
        }, Math.max(2000, shotDelay - 12000))
      }
      if (shotPath) {
        setTimeout(async () => {
          try {
            const stats = await mainWindow!.webContents.executeJavaScript(
              `(() => { const s = window.__atlasDebug.store.getState().snapshot; return s ? { files: s.stats.totalFiles, loc: s.stats.totalLoc, edges: s.importEdges.length / 2, commits: s.timeline.commits.length, langs: s.stats.languages } : null })()`
            )
            console.log('[atlas] snapshot stats:', JSON.stringify(stats))
            const image = await mainWindow!.webContents.capturePage()
            const { writeFileSync } = await import('node:fs')
            writeFileSync(shotPath, image.toPNG())
            console.log(`[atlas] screenshot saved to ${shotPath}`)
          } catch (e) {
            console.error('[atlas] screenshot failed:', e)
          }
        }, shotDelay)
      }
    })
  }

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.waive.code-atlas')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpc(() => mainWindow)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
