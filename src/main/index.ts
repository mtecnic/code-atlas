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

  // dev/test hooks, sequential pipeline:
  //   load → [ATLAS_OPEN: analyze + wait for snapshot] → [ATLAS_MODE] →
  //   [ATLAS_EVAL] → settle → [ATLAS_SHOT capture]
  const autoOpen2 = process.env.ATLAS_OPEN
  const shotPath2 = process.env.ATLAS_SHOT
  const evalCode2 = process.env.ATLAS_EVAL
  const mode2 = process.env.ATLAS_MODE
  if (autoOpen2 || shotPath2 || evalCode2) {
    mainWindow.webContents.once('did-finish-load', () => {
      void (async () => {
        const js = (code: string): Promise<unknown> =>
          mainWindow!.webContents.executeJavaScript(code)
        const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
        try {
          await sleep(1500)
          let hadSnapshot = false
          if (autoOpen2) {
            console.log('[atlas] auto-analyzing', autoOpen2)
            await js(`window.atlas.analyze(${JSON.stringify(autoOpen2)})`)
            const deadline = Date.now() + 150_000
            while (Date.now() < deadline) {
              if (await js(`!!(window.__atlasDebug && window.__atlasDebug.store.getState().snapshot)`)) {
                hadSnapshot = true
                break
              }
              await sleep(2500)
            }
            console.log('[atlas] snapshot ready:', hadSnapshot)
          }
          if (mode2) {
            await js(`window.__atlasDebug.store.getState().setMode(${JSON.stringify(mode2)})`)
            await sleep(4000)
          }
          if (evalCode2) {
            try {
              const result = await js(evalCode2)
              console.log('[atlas] eval result:', JSON.stringify(result))
            } catch (e) {
              console.error('[atlas] eval failed:', e)
            }
          }
          if (shotPath2) {
            await sleep(Number(process.env.ATLAS_SHOT_DELAY ?? (hadSnapshot ? 12_000 : 5_000)))
            const stats = await js(
              `(() => { const s = window.__atlasDebug.store.getState().snapshot; return s ? { files: s.stats.totalFiles, loc: s.stats.totalLoc, edges: s.importEdges.length / 2, commits: s.timeline.commits.length } : null })()`
            )
            console.log('[atlas] snapshot stats:', JSON.stringify(stats))
            const image = await mainWindow!.webContents.capturePage()
            const { writeFileSync } = await import('node:fs')
            writeFileSync(shotPath2, image.toPNG())
            console.log(`[atlas] screenshot saved to ${shotPath2}`)
          }
        } catch (e) {
          console.error('[atlas] hook pipeline failed:', e)
        }
      })()
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
