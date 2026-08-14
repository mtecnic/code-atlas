// Scene tool registry for the LLM agent — self-describing tools the model can
// call to operate the visualization (pattern: ToolDef {name, description,
// parameters, run} + dispatch() that wraps errors, per mtecnic/clusterspace).
import Fuse from 'fuse.js'
import { useAtlas } from '../store'
import * as graphops from '../graphops'
import { LENSES, type LensId } from '../lenses'
import type { FileId, RepoSnapshot } from '../../../shared/model'

export interface SceneToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
  run: (args: Record<string, unknown>) => unknown | Promise<unknown>
}

let fuseIndex: Fuse<{ id: number; path: string }> | null = null
let fuseSnapshot: RepoSnapshot | null = null

function resolvePath(path: string): FileId | null {
  const snapshot = useAtlas.getState().snapshot
  if (!snapshot) return null
  const cleaned = String(path).replace(/^\.?\//, '')
  const exact = snapshot.files.findIndex((f) => f.path === cleaned)
  if (exact >= 0) return exact
  const suffix = snapshot.files.findIndex((f) => f.path.endsWith('/' + cleaned) || f.name === cleaned)
  if (suffix >= 0) return suffix
  if (fuseSnapshot !== snapshot) {
    fuseIndex = new Fuse(
      snapshot.files.map((f, id) => ({ id, path: f.path })),
      { keys: ['path'], threshold: 0.3 }
    )
    fuseSnapshot = snapshot
  }
  const hits = fuseIndex!.search(cleaned, { limit: 1 })
  return hits.length ? hits[0].item.id : null
}

function needSnapshot(): RepoSnapshot {
  const s = useAtlas.getState().snapshot
  if (!s) throw new Error('No repository is loaded')
  return s
}

const TOOLS: SceneToolDef[] = [
  {
    name: 'fly_to',
    description:
      'Fly the 3D camera to a file and select it, opening its code preview and inspector. Use whenever you mention a specific important file.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'repo-relative file path' } },
      required: ['path']
    },
    run: ({ path }) => {
      const id = resolvePath(String(path))
      if (id === null) throw new Error(`No file matching "${path}"`)
      const st = useAtlas.getState()
      st.setSelected(id)
      st.requestFlyTo(id)
      return { flewTo: needSnapshot().files[id].path }
    }
  },
  {
    name: 'set_lens',
    description:
      'Recolor the city by an insight lens: language, complexity, hotspot (churn×complexity), age (freshness), todo (TODO debt), ownership (author territories), coverage.',
    parameters: {
      type: 'object',
      properties: { lens: { type: 'string', enum: LENSES.map((l) => l.id) } },
      required: ['lens']
    },
    run: ({ lens }) => {
      useAtlas.getState().setLens(lens as LensId)
      return { lens }
    }
  },
  {
    name: 'set_view',
    description: 'Switch the visualization metaphor: "city" (treemap districts) or "galaxy" (force-directed dependency clusters).',
    parameters: {
      type: 'object',
      properties: { mode: { type: 'string', enum: ['city', 'galaxy'] } },
      required: ['mode']
    },
    run: ({ mode }) => {
      const st = useAtlas.getState()
      st.setMolecule(null, null)
      st.setMode(mode as 'city' | 'galaxy')
      return { mode }
    }
  },
  {
    name: 'filter_files',
    description:
      'Filter the scene to files matching a glob (e.g. "vllm/attention/**") or a language (e.g. "python"). Everything else sinks away. Use to focus attention.',
    parameters: {
      type: 'object',
      properties: {
        glob: { type: 'string', description: 'path glob; * within segment, ** across' },
        language: { type: 'string' }
      }
    },
    run: ({ glob, language }) => {
      const s = needSnapshot()
      if (glob) {
        const count = graphops.filterByGlob(s, String(glob))
        if (!count) throw new Error(`Glob "${glob}" matched nothing`)
        return { matched: count }
      }
      if (language) {
        graphops.filterByLanguage(s, String(language))
        return { language }
      }
      throw new Error('Provide glob or language')
    }
  },
  {
    name: 'filter_related',
    description:
      'Show only files related to one file through imports: its dependencies, its dependents, or both (neighborhood). Depth-limited BFS.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        direction: { type: 'string', enum: ['deps', 'dependents', 'both'] },
        depth: { type: 'number', description: 'default 2' }
      },
      required: ['path', 'direction']
    },
    run: ({ path, direction, depth }) => {
      const s = needSnapshot()
      const id = resolvePath(String(path))
      if (id === null) throw new Error(`No file matching "${path}"`)
      const d = Number(depth) || 2
      if (direction === 'deps') graphops.filterDependencies(s, id, d)
      else if (direction === 'dependents') graphops.filterDependents(s, id, d)
      else graphops.isolateNeighborhood(s, id, d)
      const filter = useAtlas.getState().fileFilter
      return { kept: filter ? filter.label : 'unknown' }
    }
  },
  {
    name: 'clear_view',
    description: 'Clear all filters and highlights, returning to the full city.',
    parameters: { type: 'object', properties: {} },
    run: () => {
      const st = useAtlas.getState()
      st.setFileFilter(null)
      st.requestReframe()
      return { cleared: true }
    }
  },
  {
    name: 'get_file_info',
    description: 'Full dossier for one file: size, complexity, churn, ownership, imports, dependents, cycle membership.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path']
    },
    run: ({ path }) => {
      const s = needSnapshot()
      const id = resolvePath(String(path))
      if (id === null) throw new Error(`No file matching "${path}"`)
      const f = s.files[id]
      const imports: string[] = []
      const importedBy: string[] = []
      const e = s.importEdges
      for (let i = 0; i + 1 < e.length; i += 2) {
        if (e[i] === id && imports.length < 20) imports.push(s.files[e[i + 1]].path)
        if (e[i + 1] === id && importedBy.length < 20) importedBy.push(s.files[e[i]].path)
      }
      const health = useAtlas.getState().health
      return {
        path: f.path,
        language: f.language,
        loc: f.loc,
        complexity: f.complexity,
        todos: f.todoCount,
        commits: f.churn.commits,
        authors: f.churn.authors,
        topAuthor: f.churn.topAuthor,
        lastTouched: f.churn.lastTouched
          ? new Date(f.churn.lastTouched * 1000).toISOString().slice(0, 10)
          : null,
        imports,
        importedBy,
        inCycle: health ? health.cycleOf[id] >= 0 : false,
        transitiveDependents: health ? health.transitiveDependents[id] : 0
      }
    }
  },
  {
    name: 'search_files',
    description: 'Fuzzy-search files by name/path. Returns matching paths.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'number' } },
      required: ['query']
    },
    run: ({ query, limit }) => {
      const s = needSnapshot()
      if (fuseSnapshot !== s) {
        fuseIndex = new Fuse(
          s.files.map((f, id) => ({ id, path: f.path })),
          { keys: ['path'], threshold: 0.35 }
        )
        fuseSnapshot = s
      }
      return fuseIndex!.search(String(query), { limit: Math.min(Number(limit) || 8, 20) }).map(
        (h) => h.item.path
      )
    }
  },
  {
    name: 'get_health_report',
    description:
      'Architecture health summary: dependency cycles, most load-bearing files, possibly-dead files.',
    parameters: { type: 'object', properties: {} },
    run: () => {
      const s = needSnapshot()
      const h = useAtlas.getState().health
      if (!h) throw new Error('Health analysis not ready')
      return {
        cycles: h.cycles.slice(0, 5).map((c) => ({
          files: c.files.length,
          sample: c.files.slice(0, 5).map((f) => s.files[f].path)
        })),
        loadBearing: h.loadBearing.slice(0, 8).map((l) => ({
          path: s.files[l.file].path,
          transitiveDependents: l.transitiveDependents
        })),
        deadCount: h.dead.length,
        deadSample: h.dead.slice(0, 10).map((d) => s.files[d.file].path)
      }
    }
  }
]

export function toolSchemas(): { type: 'function'; function: Record<string, unknown> }[] {
  return TOOLS.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }))
}

export async function dispatchTool(
  name: string,
  args: Record<string, unknown>
): Promise<{ content: string; isError: boolean }> {
  const tool = TOOLS.find((t) => t.name === name)
  if (!tool) return { content: JSON.stringify({ error: `Unknown tool: ${name}` }), isError: true }
  try {
    const result = await tool.run(args ?? {})
    return {
      content: typeof result === 'string' ? result : JSON.stringify(result),
      isError: false
    }
  } catch (e) {
    return {
      content: JSON.stringify({ error: String(e instanceof Error ? e.message : e) }),
      isError: true
    }
  }
}
