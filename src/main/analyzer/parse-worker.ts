// Piscina worker: reads a file, counts LOC, and — when a grammar exists —
// parses with web-tree-sitter and extracts imports/definitions/references.
// web-tree-sitter and grammars initialize lazily once per worker thread.
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { Parser, Language, Query } from 'web-tree-sitter'
import { QUERIES } from './queries'
import type { SymbolKind } from '../../shared/model'

export interface ParseTask {
  absPath: string
  language: string | null
  /** tree-sitter grammar name, null → stats only */
  grammar: string | null
  grammarDir: string
}

export interface RawDef {
  name: string
  kind: SymbolKind
  startLine: number
  endLine: number
}

export interface RawRef {
  name: string
  line: number
}

export interface ParseResult {
  loc: number
  analyzed: boolean
  imports: string[]
  defs: RawDef[]
  refs: RawRef[]
}

let initialized = false
const languages = new Map<string, Language>()
const queries = new Map<string, Query>()
let parser: Parser | null = null

async function ensureLanguage(grammar: string, grammarDir: string): Promise<Language | null> {
  if (!initialized) {
    await Parser.init({
      locateFile: (name: string) => join(grammarDir, name)
    })
    parser = new Parser()
    initialized = true
  }
  if (languages.has(grammar)) return languages.get(grammar)!
  try {
    const lang = await Language.load(join(grammarDir, `tree-sitter-${grammar}.wasm`))
    languages.set(grammar, lang)
    const src = QUERIES[grammar]
    if (src) queries.set(grammar, new Query(lang, src))
    return lang
  } catch {
    return null
  }
}

function countLoc(source: string): number {
  let loc = 0
  let sawChar = false
  for (let i = 0; i < source.length; i++) {
    const c = source.charCodeAt(i)
    if (c === 10) {
      if (sawChar) loc++
      sawChar = false
    } else if (c !== 32 && c !== 9 && c !== 13) {
      sawChar = true
    }
  }
  if (sawChar) loc++
  return loc
}

const KIND_BY_CAPTURE: Record<string, SymbolKind> = {
  'def.function': 'function',
  'def.class': 'class',
  'def.method': 'method',
  'def.variable': 'variable',
  'def.type': 'type'
}

function cleanImport(text: string): string {
  // strip quotes (c/go string literals arrive with them) and rust `use` noise
  return text.replace(/^["'<]|[">']$/g, '').trim()
}

export default async function parseFile(task: ParseTask): Promise<ParseResult> {
  const empty: ParseResult = { loc: 0, analyzed: false, imports: [], defs: [], refs: [] }
  let source: string
  try {
    source = await fs.readFile(task.absPath, 'utf8')
  } catch {
    return empty
  }
  const loc = countLoc(source)
  const base: ParseResult = { ...empty, loc }
  if (!task.grammar) return base
  // skip minified/bundled artifacts: telltale filename or huge average line length
  if (/\.(min|bundle)\./.test(task.absPath) || source.length / Math.max(1, loc) > 250) {
    return base
  }

  const lang = await ensureLanguage(task.grammar, task.grammarDir)
  const query = queries.get(task.grammar)
  if (!lang || !query || !parser) return base

  try {
    parser.setLanguage(lang)
    const tree = parser.parse(source)
    if (!tree) return base
    const imports: string[] = []
    const defs: RawDef[] = []
    const refs: RawRef[] = []
    for (const capture of query.captures(tree.rootNode)) {
      const name = capture.name
      const node = capture.node
      if (name.startsWith('import.')) {
        imports.push(cleanImport(node.text))
      } else if (name.startsWith('def.')) {
        const kind = KIND_BY_CAPTURE[name]
        if (!kind) continue
        // the capture is the name node; the enclosing definition is its
        // nearest named ancestor, which carries the full body range
        const scope = node.parent ?? node
        defs.push({
          name: node.text,
          kind,
          startLine: scope.startPosition.row,
          endLine: scope.endPosition.row
        })
      } else if (name.startsWith('ref.')) {
        refs.push({ name: node.text, line: node.startPosition.row })
      }
    }
    tree.delete()
    return { loc, analyzed: true, imports, defs, refs }
  } catch {
    return base
  }
}
