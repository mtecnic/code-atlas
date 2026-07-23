// Copies tree-sitter grammar wasm files (shipped inside the official grammar
// npm packages) plus the web-tree-sitter runtime wasm into resources/grammars.
// Run via `npm run grammars` (wired into postinstall).
import { copyFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'resources', 'grammars')
mkdirSync(out, { recursive: true })

const sources = [
  'tree-sitter-javascript/tree-sitter-javascript.wasm',
  'tree-sitter-typescript/tree-sitter-typescript.wasm',
  'tree-sitter-typescript/tree-sitter-tsx.wasm',
  'tree-sitter-python/tree-sitter-python.wasm',
  'tree-sitter-go/tree-sitter-go.wasm',
  'tree-sitter-rust/tree-sitter-rust.wasm',
  'tree-sitter-c/tree-sitter-c.wasm',
  'tree-sitter-cpp/tree-sitter-cpp.wasm',
  'tree-sitter-java/tree-sitter-java.wasm',
  'web-tree-sitter/web-tree-sitter.wasm'
]

let copied = 0
for (const rel of sources) {
  const src = join(root, 'node_modules', rel)
  if (!existsSync(src)) {
    console.error(`missing: ${rel} — did npm install run?`)
    process.exitCode = 1
    continue
  }
  copyFileSync(src, join(out, rel.split('/').pop()))
  copied++
}
console.log(`grammars: copied ${copied}/${sources.length} wasm files to resources/grammars`)
