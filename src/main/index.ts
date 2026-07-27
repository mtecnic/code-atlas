import { app, shell, BrowserWindow, dialog } from 'electron'
import { join } from 'path'
import { readFileSync, statSync } from 'node:fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerIpc } from './ipc'
import { saveSettings } from './store'
import { CHANNELS } from '../shared/ipc-contract'

let mainWindow: BrowserWindow | null = null

// ---- GL mode ladder: default → egl (ANGLE straight to the GPU driver, works
// without X acceleration, e.g. under xrdp/RDP) → swiftshader (software, always
// correct). Chosen mode is health-probed after load; failures relaunch with
// the next rung. Last-good mode persists in settings.
type GlMode = 'default' | 'egl' | 'swiftshader'
const GL_LADDER: GlMode[] = ['default', 'egl', 'swiftshader']

function savedGlMode(): GlMode | null {
  try {
    const raw = readFileSync(join(app.getPath('userData'), 'settings.json'), 'utf8')
    const mode = JSON.parse(raw).glMode
    return GL_LADDER.includes(mode) ? mode : null
  } catch {
    return null
  }
}

const glArgv = process.argv.find((a) => a.startsWith('--atlas-gl='))
const glMode: GlMode = (() => {
  const fromArg = glArgv?.split('=')[1] as GlMode | undefined
  if (fromArg && GL_LADDER.includes(fromArg)) return fromArg
  return savedGlMode() ?? 'default'
})()
if (glMode === 'egl') {
  app.commandLine.appendSwitch('use-angle', 'gl-egl')
} else if (glMode === 'swiftshader') {
  app.commandLine.appendSwitch('enable-unsafe-swiftshader')
}

const GL_PROBE_JS = `(() => { try {
  const c = document.createElement('canvas'); c.width = 4; c.height = 4;
  const gl = c.getContext('webgl2') || c.getContext('webgl');
  if (!gl) return { ok: false, renderer: 'no-context' };
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  gl.clearColor(1, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  const px = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return { ok: px[0] > 200 && px[1] < 60, renderer };
} catch (e) { return { ok: false, renderer: String(e) } } })()`

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

  // GL health probe → heal by relaunching one rung down the ladder
  mainWindow.webContents.once('did-finish-load', () => {
    void (async () => {
      let probe: { ok: boolean; renderer: string }
      try {
        probe = (await mainWindow!.webContents.executeJavaScript(GL_PROBE_JS)) as {
          ok: boolean
          renderer: string
        }
      } catch (e) {
        probe = { ok: false, renderer: String(e) }
      }
      console.log(`[atlas] gl: ${glMode} — ${probe.renderer} ${probe.ok ? 'OK' : 'FAILED'}`)
      if (probe.ok) {
        void saveSettings({ glMode })
        if (!mainWindow!.isDestroyed()) {
          mainWindow!.webContents.send(CHANNELS.glInfo, {
            mode: glMode,
            renderer: probe.renderer,
            software: /swiftshader|llvmpipe|softpipe|software/i.test(probe.renderer)
          })
        }
        return
      }
      const next = GL_LADDER[GL_LADDER.indexOf(glMode) + 1]
      if (next) {
        console.log(`[atlas] gl: relaunching with --atlas-gl=${next}`)
        const args = process.argv.slice(1).filter((a) => !a.startsWith('--atlas-gl='))
        app.relaunch({ args: [...args, `--atlas-gl=${next}`] })
        app.exit(0)
      } else {
        dialog.showErrorBox(
          'Code Atlas',
          `WebGL could not be initialized in any mode (last: ${probe.renderer}).`
        )
      }
    })()
  })

  // dev/test hooks, sequential pipeline:
  //   load → [ATLAS_OPEN: analyze + wait for snapshot] → [ATLAS_MODE] →
  //   [ATLAS_EVAL] → settle → [ATLAS_SHOT capture]
  // CLI: `code-atlas /path/to/repo` (also via code-atlas.sh passthrough)
  const cliArgs = process.argv.slice(app.isPackaged ? 1 : 2)
  const cliRepo = cliArgs.find((a) => {
    if (a.startsWith('-') || a.endsWith('.js')) return false
    try {
      return statSync(a).isDirectory()
    } catch {
      return false
    }
  })
  const autoOpen2 = process.env.ATLAS_OPEN ?? cliRepo
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
