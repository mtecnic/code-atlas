// Maps raw import specifiers to FileIds with per-language heuristics.
// External/unresolvable packages are dropped (v1).
import type { FileId } from '../../shared/model'

export interface ResolverInput {
  /** relPath → FileId for every scanned file */
  byPath: Map<string, FileId>
  /** dir relPath ('' = root) → FileIds of files directly inside */
  filesInDir: Map<string, FileId[]>
  filePaths: string[] // index = FileId
}

const JS_EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json']
const JS_INDEXES = ['/index.ts', '/index.tsx', '/index.js', '/index.jsx']

function dirOf(rel: string): string {
  const i = rel.lastIndexOf('/')
  return i < 0 ? '' : rel.slice(0, i)
}

function normalize(path: string): string {
  const parts: string[] = []
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (parts.length === 0) return '\0invalid'
      parts.pop()
    } else parts.push(seg)
  }
  return parts.join('/')
}

export class ImportResolver {
  constructor(private input: ResolverInput) {}

  private lookup(rel: string): FileId | undefined {
    return this.input.byPath.get(rel)
  }

  private probe(base: string, exts: string[]): FileId | undefined {
    for (const ext of exts) {
      const hit = this.lookup(base + ext)
      if (hit !== undefined) return hit
    }
    return undefined
  }

  resolve(importerPath: string, language: string, spec: string): FileId[] {
    switch (language) {
      case 'javascript':
      case 'typescript':
      case 'tsx':
        return this.resolveJs(importerPath, spec)
      case 'python':
        return this.resolvePython(importerPath, spec)
      case 'go':
        return this.resolveGo(spec)
      case 'rust':
        return this.resolveRust(importerPath, spec)
      case 'c':
      case 'cpp':
        return this.resolveC(importerPath, spec)
      case 'java':
        return this.resolveJava(spec)
      default:
        return []
    }
  }

  private resolveJs(importer: string, spec: string): FileId[] {
    if (!spec.startsWith('.')) return [] // external package
    const base = normalize(dirOf(importer) + '/' + spec)
    const hit = this.probe(base, JS_EXTS) ?? this.probe(base, JS_INDEXES)
    return hit !== undefined ? [hit] : []
  }

  private resolvePython(importer: string, spec: string): FileId[] {
    let searchRoots: string[]
    let dotted = spec
    if (spec.startsWith('.')) {
      // relative import: one leading dot = importer's package, each extra dot ascends
      let dots = 0
      while (dots < spec.length && spec[dots] === '.') dots++
      dotted = spec.slice(dots)
      let dir = dirOf(importer)
      for (let i = 1; i < dots; i++) dir = dirOf(dir)
      searchRoots = [dir]
    } else {
      searchRoots = ['', 'src', dirOf(importer)]
    }
    const relModule = dotted.split('.').filter(Boolean).join('/')
    for (const root of searchRoots) {
      const base = normalize(root ? `${root}/${relModule}` : relModule)
      if (!base && !relModule) {
        // `from . import x` — the package __init__
        const init = this.lookup(normalize(searchRoots[0] + '/__init__.py'))
        return init !== undefined ? [init] : []
      }
      const hit = this.probe(base, ['.py', '.pyi']) ?? this.lookup(base + '/__init__.py')
      if (hit !== undefined) return [hit]
      // `from a.b import name` where name is a symbol: try parent module
      const parent = normalize(base.split('/').slice(0, -1).join('/'))
      if (parent) {
        const parentHit = this.probe(parent, ['.py']) ?? this.lookup(parent + '/__init__.py')
        if (parentHit !== undefined) return [parentHit]
      }
    }
    return []
  }

  private resolveGo(spec: string): FileId[] {
    // match by longest dir-path suffix of the import path (packages are dirs)
    const segs = spec.split('/').filter(Boolean)
    for (let take = Math.min(segs.length, 4); take >= 1; take--) {
      const suffix = segs.slice(-take).join('/')
      const files = this.input.filesInDir.get(suffix)
      if (files?.length) {
        return files.filter((f) => this.input.filePaths[f].endsWith('.go')).slice(0, 20)
      }
    }
    return []
  }

  private resolveRust(importer: string, spec: string): FileId[] {
    // handles `mod name;` (spec = bare name) and `use crate::a::b::c` paths
    const importerDir = dirOf(importer)
    const clean = spec.replace(/\s+/g, '').replace(/;$/, '')
    const segs = clean.split('::').filter(Boolean)
    if (segs.length === 0) return []

    const tryModule = (dir: string, name: string): FileId | undefined =>
      this.lookup(normalize(`${dir}/${name}.rs`)) ?? this.lookup(normalize(`${dir}/${name}/mod.rs`))

    if (segs.length === 1 && !clean.includes('::')) {
      // `mod foo;` — sibling file or subdir; mod.rs/lib.rs parents use their dir
      const hit =
        tryModule(importerDir, segs[0]) ??
        tryModule(importerDir + '/' + importer.split('/').pop()!.replace(/\.rs$/, ''), segs[0])
      return hit !== undefined ? [hit] : []
    }

    let baseDirs: string[]
    const first = segs[0]
    if (first === 'crate') baseDirs = ['src', importerDir.split('/')[0] === 'src' ? 'src' : '']
    else if (first === 'self') baseDirs = [importerDir]
    else if (first === 'super') baseDirs = [dirOf(importerDir)]
    else return [] // external crate
    const rest = segs.slice(1)
    for (const baseDir of baseDirs) {
      // walk down segments until a file matches (later segments are items)
      let dir = baseDir
      for (let i = 0; i < rest.length; i++) {
        const hit = tryModule(dir, rest[i])
        if (hit !== undefined) return [hit]
        dir = normalize(`${dir}/${rest[i]}`)
      }
    }
    return []
  }

  private resolveC(importer: string, spec: string): FileId[] {
    const candidates = [
      normalize(dirOf(importer) + '/' + spec),
      normalize(spec),
      normalize('include/' + spec),
      normalize('src/' + spec)
    ]
    for (const c of candidates) {
      const hit = this.lookup(c)
      if (hit !== undefined) return [hit]
    }
    return []
  }

  private resolveJava(spec: string): FileId[] {
    const rel = spec.split('.').join('/') + '.java'
    for (const root of ['src/main/java/', 'src/', 'app/src/main/java/', '']) {
      const hit = this.lookup(normalize(root + rel))
      if (hit !== undefined) return [hit]
    }
    return []
  }
}
