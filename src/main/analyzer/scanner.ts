// File discovery. Prefers `git ls-files` (respects .gitignore, fast); falls
// back to a filtered fs walk for non-git folders.
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { promises as fs } from 'node:fs'
import { join, relative } from 'node:path'
import ignore, { Ignore } from 'ignore'

const execFileP = promisify(execFile)

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.mypy_cache',
  '.ruff_cache',
  '.next',
  '.nuxt',
  'coverage',
  '.idea',
  '.vscode'
])

const BINARY_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'svg', 'pdf',
  'zip', 'gz', 'tar', 'bz2', 'xz', 'zst', '7z', 'rar',
  'so', 'a', 'o', 'dylib', 'dll', 'exe', 'bin', 'wasm', 'class', 'jar', 'pyc',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp3', 'mp4', 'wav', 'ogg', 'avi', 'mov', 'webm', 'flac',
  'db', 'sqlite', 'sqlite3', 'parquet', 'npy', 'npz', 'pt', 'pth', 'onnx',
  'safetensors', 'gguf', 'ckpt', 'pkl', 'model', 'lock'
])

export const MAX_PARSE_BYTES = 1.5 * 1024 * 1024

export interface ScannedFile {
  /** repo-relative path with forward slashes */
  relPath: string
  sizeBytes: number
}

export async function isGitRepo(root: string): Promise<boolean> {
  try {
    await fs.stat(join(root, '.git'))
    return true
  } catch {
    return false
  }
}

function extOf(p: string): string {
  const dot = p.lastIndexOf('.')
  return dot < 0 ? '' : p.slice(dot + 1).toLowerCase()
}

export function looksBinaryByExt(relPath: string): boolean {
  return BINARY_EXTS.has(extOf(relPath))
}

/** NUL-byte sniff of the first 8KB; call only on ext-allowlisted files */
export async function sniffBinary(absPath: string): Promise<boolean> {
  const fh = await fs.open(absPath, 'r')
  try {
    const buf = Buffer.alloc(8192)
    const { bytesRead } = await fh.read(buf, 0, 8192, 0)
    for (let i = 0; i < bytesRead; i++) if (buf[i] === 0) return true
    return false
  } finally {
    await fh.close()
  }
}

async function gitListFiles(root: string): Promise<string[]> {
  const { stdout } = await execFileP(
    'git',
    ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { maxBuffer: 128 * 1024 * 1024 }
  )
  return stdout.split('\0').filter(Boolean)
}

async function walkFallback(root: string): Promise<string[]> {
  const ig: Ignore = ignore()
  try {
    ig.add(await fs.readFile(join(root, '.gitignore'), 'utf8'))
  } catch {
    /* no root .gitignore */
  }
  const results: string[] = []
  const stack: string[] = [root]
  while (stack.length) {
    const dir = stack.pop()!
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue
      const abs = join(dir, e.name)
      const rel = relative(root, abs).split('\\').join('/')
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.') || ig.ignores(rel + '/')) continue
        stack.push(abs)
      } else if (e.isFile()) {
        if (!ig.ignores(rel)) results.push(rel)
      }
    }
  }
  return results
}

export interface ScanResult {
  files: ScannedFile[]
  skipped: number
  usedGit: boolean
}

export async function scan(root: string, maxFiles: number): Promise<ScanResult> {
  const usedGit = await isGitRepo(root)
  let rels: string[]
  if (usedGit) {
    try {
      rels = await gitListFiles(root)
    } catch {
      rels = await walkFallback(root)
    }
  } else {
    rels = await walkFallback(root)
  }

  // git ls-files can include paths under skip dirs when committed (e.g. vendored deps)
  rels = rels.filter((r) => !r.split('/').some((part) => SKIP_DIRS.has(part)))

  let skipped = 0
  const files: ScannedFile[] = []
  for (const rel of rels) {
    if (files.length >= maxFiles) {
      skipped += 1
      continue
    }
    if (looksBinaryByExt(rel)) {
      skipped += 1
      continue
    }
    try {
      const st = await fs.lstat(join(root, rel))
      if (!st.isFile()) {
        skipped += 1
        continue
      }
      files.push({ relPath: rel, sizeBytes: st.size })
    } catch {
      skipped += 1
    }
  }
  return { files, skipped, usedGit }
}

/** stream helper for git log used by churn.ts */
export function spawnGit(root: string, args: string[]): ReturnType<typeof spawn> {
  return spawn('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
}
