// Streams `git log --numstat` (oldest → newest) and produces per-file churn
// plus the timeline used by the time-scrub. Rename notation `a/{b => c}/d.ts`
// is resolved so a file keeps one identity across history.
import { createInterface } from 'node:readline'
import type {
  ChurnInfo,
  FileId,
  GitCommitMeta,
  GitTimeline,
  GitTimelineEvent
} from '../../shared/model'
import { spawnGit } from '../analyzer/scanner'

export interface GitHistoryResult {
  timeline: GitTimeline
  /** churn keyed by FileId (only files present in the scan) */
  churn: Map<FileId, ChurnInfo>
}

/** `a/{old => new}/z.ts` or `old.ts => new.ts` → [oldPath, newPath] */
export function parseRename(path: string): [string, string] {
  const braced = path.match(/^(.*)\{(.*) => (.*)\}(.*)$/)
  if (braced) {
    const [, pre, oldMid, newMid, post] = braced
    const clean = (s: string): string => (pre + s + post).replace(/\/\//g, '/')
    return [clean(oldMid), clean(newMid)]
  }
  const arrow = path.split(' => ')
  if (arrow.length === 2) return [arrow[0], arrow[1]]
  return [path, path]
}

export async function readGitHistory(
  root: string,
  byPath: Map<string, FileId>,
  maxCommits: number,
  onProgress?: (commitsSeen: number) => void
): Promise<GitHistoryResult> {
  const commits: GitCommitMeta[] = []
  const events: GitTimelineEvent[] = []
  const churn = new Map<FileId, ChurnInfo>()
  const authorsPerFile = new Map<FileId, Set<string>>()
  // maps a historical path forward to its current (HEAD) path
  const pathForward = new Map<string, string>()

  const resolveId = (histPath: string): FileId | undefined =>
    byPath.get(pathForward.get(histPath) ?? histPath)

  const child = spawnGit(root, [
    'log',
    '--reverse',
    `--max-count=${maxCommits}`,
    '--numstat',
    '--no-color',
    '--format=%x01%H%x09%at%x09%an%x09%s'
  ])

  const seenFirstAdd = new Set<FileId>()
  let current: GitCommitMeta | null = null
  let currentIdx = -1

  const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity })
  for await (const line of rl) {
    if (line.startsWith('\x01')) {
      const [hash, time, author, subject = ''] = line.slice(1).split('\t')
      current = { hash, time: Number(time), author, subject }
      currentIdx = commits.length
      commits.push(current)
      if (currentIdx % 200 === 0) onProgress?.(currentIdx)
      continue
    }
    if (!current || !line.trim()) continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const [addsRaw, delsRaw] = parts
    const rawPath = parts.slice(2).join('\t')
    if (addsRaw === '-' || delsRaw === '-') continue // binary
    const adds = Number(addsRaw)
    const dels = Number(delsRaw)

    let histPath = rawPath
    let isRename = false
    if (rawPath.includes(' => ')) {
      const [oldP, newP] = parseRename(rawPath)
      // repoint every historical alias of oldP at newP
      const target = pathForward.get(oldP) ?? oldP
      for (const [k, v] of pathForward) if (v === target) pathForward.set(k, newP)
      pathForward.set(oldP, newP)
      histPath = newP
      isRename = true
    }

    const fileId = resolveId(histPath)
    if (fileId === undefined) continue // deleted before HEAD or unscanned

    const info =
      churn.get(fileId) ?? ({ commits: 0, lastTouched: 0, authors: 0, heat: 0 } as ChurnInfo)
    info.commits += 1
    info.lastTouched = Math.max(info.lastTouched, current.time)
    churn.set(fileId, info)
    let authors = authorsPerFile.get(fileId)
    if (!authors) authorsPerFile.set(fileId, (authors = new Set()))
    authors.add(current.author)

    let kind: GitTimelineEvent['kind']
    if (isRename) kind = 'R'
    else if (!seenFirstAdd.has(fileId) && dels === 0) {
      kind = 'A'
      seenFirstAdd.add(fileId)
    } else kind = 'M'
    events.push({ commit: currentIdx, file: fileId, kind, locDelta: adds - dels })
  }

  await new Promise<void>((resolve) => child.on('close', () => resolve()))

  // finalize authors + recency-decayed heat
  const now = commits.length ? commits[commits.length - 1].time : Date.now() / 1000
  const HALF_LIFE = 90 * 24 * 3600 // 90 days
  let maxScore = 0
  const scores = new Map<FileId, number>()
  for (const [fileId, info] of churn) {
    info.authors = authorsPerFile.get(fileId)?.size ?? 0
    const age = Math.max(0, now - info.lastTouched)
    const score = info.commits * Math.pow(0.5, age / HALF_LIFE)
    scores.set(fileId, score)
    if (score > maxScore) maxScore = score
  }
  for (const [fileId, info] of churn) {
    info.heat = maxScore > 0 ? Math.sqrt((scores.get(fileId) ?? 0) / maxScore) : 0
  }

  return { timeline: { commits, events }, churn }
}
