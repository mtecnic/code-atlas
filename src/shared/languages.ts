// Extension → language mapping and per-language visual identity.
// `grammar` names the tree-sitter wasm (tree-sitter-<grammar>.wasm) when deep
// analysis is supported; languages without one render from file stats alone.

export interface LanguageInfo {
  id: string
  grammar: string | null
  color: string // hex, building/node base color
}

const L = (id: string, grammar: string | null, color: string): LanguageInfo => ({ id, grammar, color })

export const LANGUAGES: Record<string, LanguageInfo> = {
  javascript: L('javascript', 'javascript', '#f7df1e'),
  typescript: L('typescript', 'typescript', '#3178c6'),
  tsx: L('tsx', 'tsx', '#61dafb'),
  python: L('python', 'python', '#4b8bbe'),
  go: L('go', 'go', '#00add8'),
  rust: L('rust', 'rust', '#f74c00'),
  c: L('c', 'c', '#a8b9cc'),
  cpp: L('cpp', 'cpp', '#f34b7d'),
  java: L('java', 'java', '#e76f00'),
  // stats-only languages still get identity colors
  ruby: L('ruby', null, '#cc342d'),
  php: L('php', null, '#777bb4'),
  csharp: L('csharp', null, '#68217a'),
  swift: L('swift', null, '#f05138'),
  kotlin: L('kotlin', null, '#7f52ff'),
  shell: L('shell', null, '#89e051'),
  html: L('html', null, '#e34c26'),
  css: L('css', null, '#563d7c'),
  json: L('json', null, '#8bc34a'),
  yaml: L('yaml', null, '#cb171e'),
  toml: L('toml', null, '#9c4221'),
  markdown: L('markdown', null, '#6a737d'),
  sql: L('sql', null, '#e38c00'),
  lua: L('lua', null, '#000080'),
  zig: L('zig', null, '#ec915c'),
  other: L('other', null, '#546e7a')
}

export const EXT_TO_LANGUAGE: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'tsx',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  py: 'python',
  pyi: 'python',
  go: 'go',
  rs: 'rust',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  hxx: 'cpp',
  cu: 'cpp',
  cuh: 'cpp',
  java: 'java',
  rb: 'ruby',
  php: 'php',
  cs: 'csharp',
  swift: 'swift',
  kt: 'kotlin',
  kts: 'kotlin',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'css',
  less: 'css',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  md: 'markdown',
  markdown: 'markdown',
  sql: 'sql',
  lua: 'lua',
  zig: 'zig'
}

export function languageForPath(path: string): string | null {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return null
  const lang = EXT_TO_LANGUAGE[path.slice(dot + 1).toLowerCase()]
  return lang ?? null
}

export function languageColor(language: string | null): string {
  return (language && LANGUAGES[language]?.color) || LANGUAGES.other.color
}

/** languages with a tree-sitter grammar we ship */
export function grammarFor(language: string | null): string | null {
  return (language && LANGUAGES[language]?.grammar) || null
}
