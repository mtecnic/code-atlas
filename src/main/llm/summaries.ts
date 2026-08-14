// AI search index: batched one-line file summaries from the chat endpoint,
// cached to disk keyed by content hash so rebuilding is incremental.
import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import type { WebContents } from 'electron'
import type { LlmEndpoint } from '../../shared/model'
import { analysisStore } from '../store'
import { CHANNELS } from '../../shared/ipc-contract'

export interface SummaryEntry {
  hash: string
  summary: string
}

let building = false
let cancelRequested = false

function cachePath(rootPath: string): string {
  const key = createHash('sha1').update(rootPath).digest('hex').slice(0, 16)
  return path.join(app.getPath('userData'), 'summaries', `${key}.json`)
}

export async function loadSummaryCache(rootPath: string): Promise<Record<string, SummaryEntry>> {
  try {
    return JSON.parse(await fs.readFile(cachePath(rootPath), 'utf8'))
  } catch {
    return {}
  }
}

export function cancelSummaries(): void {
  cancelRequested = true
}

async function askBatch(
  endpoint: LlmEndpoint,
  batch: { path: string; head: string }[],
  apiKey?: string
): Promise<Map<string, string>> {
  const prompt =
    'For each file below, write ONE line: `<path> :: <what this file does, max 14 words>`. ' +
    'No other output.\n\n' +
    batch.map((b) => `--- ${b.path}\n${b.head}`).join('\n\n')
  const res = await fetch(`${endpoint.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({
      model: endpoint.model,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      max_tokens: 40 * batch.length,
      chat_template_kwargs: { enable_thinking: false }
    })
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json()
  const text: string = json.choices?.[0]?.message?.content ?? ''
  const out = new Map<string, string>()
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*`?([^\s:`][^:]*?)`?\s*::\s*(.+)$/)
    if (!m) continue
    const p = m[1].trim()
    const hit = batch.find((b) => b.path === p || b.path.endsWith(p))
    if (hit) out.set(hit.path, m[2].trim().slice(0, 140))
  }
  return out
}

export async function buildSummaries(
  wc: WebContents,
  endpoint: LlmEndpoint,
  apiKey?: string,
  maxFiles = 600
): Promise<{ built: number; cached: number; total: number } | { error: string }> {
  const snapshot = analysisStore.snapshot
  const root = analysisStore.rootPath
  if (!snapshot || !root) return { error: 'no repository loaded' }
  if (building) return { error: 'already building' }
  building = true
  cancelRequested = false
  try {
    const cache = await loadSummaryCache(root)
    // rank: analyzed code files, biggest/most-important first
    const candidates = snapshot.files
      .map((f, id) => ({ f, id }))
      .filter(({ f }) => f.analyzed && f.loc > 10)
      .sort((a, b) => b.f.loc - a.f.loc)
      .slice(0, maxFiles)

    const todo: { path: string; head: string; hash: string }[] = []
    let cached = 0
    for (const { f, id } of candidates) {
      const abs = analysisStore.absPathOf(id)
      if (!abs) continue
      let source: string
      try {
        source = await fs.readFile(abs, 'utf8')
      } catch {
        continue
      }
      const hash = createHash('sha1').update(source).digest('hex').slice(0, 12)
      if (cache[f.path]?.hash === hash) {
        cached++
        continue
      }
      todo.push({ path: f.path, head: source.slice(0, 700), hash })
    }

    const send = (done: number, total: number): void => {
      if (!wc.isDestroyed()) {
        wc.send(CHANNELS.summariesProgress, { done, total })
      }
    }
    let built = 0
    const BATCH = 20
    for (let i = 0; i < todo.length; i += BATCH) {
      if (cancelRequested) break
      const batch = todo.slice(i, i + BATCH)
      try {
        const results = await askBatch(endpoint, batch, apiKey)
        for (const b of batch) {
          const summary = results.get(b.path)
          if (summary) {
            cache[b.path] = { hash: b.hash, summary }
            built++
          }
        }
      } catch {
        /* batch failed — skip it, keep going */
      }
      send(Math.min(i + BATCH, todo.length), todo.length)
      // persist incrementally so a cancel keeps progress
      await fs.mkdir(path.dirname(cachePath(root)), { recursive: true })
      await fs.writeFile(cachePath(root), JSON.stringify(cache))
    }
    send(todo.length, todo.length)
    return { built, cached, total: candidates.length }
  } catch (e) {
    return { error: String(e) }
  } finally {
    building = false
  }
}
