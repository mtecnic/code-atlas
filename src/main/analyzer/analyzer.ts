// Orchestrates: scan → build dir tree → parallel parse (Piscina) → import
// resolution → git history. Emits throttled progress and a final RepoSnapshot.
import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import os from 'node:os'
import Piscina from 'piscina'
import { app } from 'electron'
import type {
  AnalysisProgress,
  DirNode,
  FileId,
  FileNode,
  RepoSnapshot
} from '../../shared/model'
import { grammarFor, languageForPath } from '../../shared/languages'
import { scan, MAX_PARSE_BYTES } from './scanner'
import type { ParseResult, ParseTask } from './parse-worker'
import { ImportResolver } from './import-resolver'
import { readGitHistory } from '../git/churn'
import { analysisStore } from '../store'

export function grammarDir(): string {
  // dev: repo resources/; packaged: resources/grammars unpacked next to asar
  const dev = resolve(__dirname, '../../resources/grammars')
  if (!app.isPackaged && existsSync(dev)) return dev
  const inProject = resolve(process.cwd(), 'resources/grammars')
  if (!app.isPackaged && existsSync(inProject)) return inProject
  return join(process.resourcesPath, 'grammars')
}

function workerFile(): string {
  // electron-vite bundles extra main entries next to index.js
  return join(__dirname, 'parse-worker.js')
}

export interface AnalyzeCallbacks {
  onProgress: (p: AnalysisProgress) => void
  onSnapshot: (s: RepoSnapshot) => void
}

let activeAbort: AbortController | null = null

export function cancelAnalysis(): void {
  activeAbort?.abort()
}

export async function analyze(
  rootPath: string,
  opts: { maxFiles: number; maxCommits: number },
  cb: AnalyzeCallbacks
): Promise<void> {
  activeAbort?.abort()
  const abort = (activeAbort = new AbortController())
  const signal = abort.signal
  analysisStore.reset(rootPath)

  const progress = throttle(cb.onProgress, 66)
  try {
    // ---- scan ----
    progress({ phase: 'scan', done: 0, total: 0 })
    const scanned = await scan(rootPath, opts.maxFiles)
    if (signal.aborted) return

    // ---- dir tree + file nodes ----
    const dirs: DirNode[] = [{ path: '', name: '/', parent: -1, children: [], fileIds: [] }]
    const dirIdByPath = new Map<string, number>([['', 0]])
    const ensureDir = (path: string): number => {
      const known = dirIdByPath.get(path)
      if (known !== undefined) return known
      const slash = path.lastIndexOf('/')
      const parentPath = slash < 0 ? '' : path.slice(0, slash)
      const parent = ensureDir(parentPath)
      const id = dirs.length
      dirs.push({
        path,
        name: slash < 0 ? path : path.slice(slash + 1),
        parent,
        children: [],
        fileIds: []
      })
      dirs[parent].children.push(id)
      dirIdByPath.set(path, id)
      return id
    }

    const files: FileNode[] = []
    const byPath = new Map<string, FileId>()
    const filesInDir = new Map<string, FileId[]>()
    for (const sf of scanned.files) {
      const slash = sf.relPath.lastIndexOf('/')
      const dirPath = slash < 0 ? '' : sf.relPath.slice(0, slash)
      const dirId = ensureDir(dirPath)
      const id = files.length
      files.push({
        path: sf.relPath,
        name: slash < 0 ? sf.relPath : sf.relPath.slice(slash + 1),
        dir: dirId,
        language: languageForPath(sf.relPath),
        loc: 0,
        sizeBytes: sf.sizeBytes,
        complexity: 0,
        todoCount: 0,
        churn: { commits: 0, lastTouched: 0, authors: 0, heat: 0, topAuthor: '', topShare: 0 },
        analyzed: false,
        symbolCount: 0
      })
      dirs[dirId].fileIds.push(id)
      byPath.set(sf.relPath, id)
      const arr = filesInDir.get(dirPath) ?? []
      arr.push(id)
      filesInDir.set(dirPath, arr)
    }
    progress({ phase: 'scan', done: files.length, total: files.length })

    // ---- parse pool ----
    const gDir = grammarDir()
    // capped: parse is sub-second at 8 threads, and this machine often runs a
    // memory-hungry LLM — spawning cpus-2 wasm workers under pressure can stall
    const pool = new Piscina<ParseTask, ParseResult>({
      filename: workerFile(),
      maxThreads: Math.max(2, Math.min(8, os.cpus().length - 2))
    })
    let parsed = 0
    const rawImports: string[][] = new Array(files.length)
    try {
      await Promise.all(
        files.map(async (file, id) => {
          if (signal.aborted) return
          const tooBig = file.sizeBytes > MAX_PARSE_BYTES
          const grammar = tooBig ? null : grammarFor(file.language)
          const result = await pool.run({
            absPath: join(rootPath, file.path),
            language: file.language,
            grammar,
            grammarDir: gDir
          })
          file.loc = result.loc
          file.analyzed = result.analyzed
          file.complexity = result.cx
          file.todoCount = result.todoCount
          file.symbolCount = result.defs.length
          rawImports[id] = result.imports
          if (result.analyzed) {
            analysisStore.extractions.set(id, { defs: result.defs, refs: result.refs })
          }
          parsed++
          progress({ phase: 'parse', done: parsed, total: files.length, currentPath: file.path })
        })
      )
    } finally {
      void pool.destroy()
    }
    if (signal.aborted) return

    // ---- import resolution ----
    progress({ phase: 'link', done: 0, total: files.length })
    const resolver = new ImportResolver({
      byPath,
      filesInDir,
      filePaths: files.map((f) => f.path)
    })
    const edgeSet = new Set<number>()
    const edgePairs: number[] = []
    for (let id = 0; id < files.length; id++) {
      const specs = rawImports[id]
      const lang = files[id].language
      if (!specs?.length || !lang) continue
      for (const spec of specs) {
        for (const target of resolver.resolve(files[id].path, lang, spec)) {
          if (target === id) continue
          const key = id * 1_000_000 + target
          if (edgeSet.has(key)) continue
          edgeSet.add(key)
          edgePairs.push(id, target)
          let n = analysisStore.importNeighbors.get(id)
          if (!n) analysisStore.importNeighbors.set(id, (n = new Set()))
          n.add(target)
        }
      }
    }

    // ---- git history ----
    progress({ phase: 'git', done: 0, total: opts.maxCommits })
    let timeline: RepoSnapshot['timeline'] = { commits: [], events: [] }
    if (scanned.usedGit && !signal.aborted) {
      try {
        const history = await readGitHistory(rootPath, byPath, opts.maxCommits, (n) =>
          progress({ phase: 'git', done: n, total: opts.maxCommits })
        )
        timeline = history.timeline
        for (const [fileId, info] of history.churn) files[fileId].churn = info
      } catch (e) {
        console.warn('git history failed:', e)
      }
    }
    if (signal.aborted) return

    // ---- snapshot ----
    const languages: Record<string, number> = {}
    let totalLoc = 0
    for (const f of files) {
      totalLoc += f.loc
      const key = f.language ?? 'other'
      languages[key] = (languages[key] ?? 0) + 1
    }
    const snapshot: RepoSnapshot = {
      rootPath,
      dirs,
      files,
      importEdges: Uint32Array.from(edgePairs),
      timeline,
      stats: { totalLoc, totalFiles: files.length, languages, skipped: scanned.skipped }
    }
    analysisStore.snapshot = snapshot
    cb.onProgress({ phase: 'done', done: files.length, total: files.length })
    cb.onSnapshot(snapshot)
  } catch (e) {
    if (!signal.aborted) {
      cb.onProgress({ phase: 'error', done: 0, total: 0, error: String(e) })
    }
  } finally {
    if (activeAbort === abort) activeAbort = null
  }
}

function throttle<T>(fn: (arg: T) => void, ms: number): (arg: T) => void {
  let last = 0
  return (arg: T) => {
    const now = Date.now()
    if (now - last >= ms) {
      last = now
      fn(arg)
    }
  }
}
