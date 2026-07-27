<div align="center">

# ⛩ Code Atlas

### Your codebase is a place. Go there.

**A desktop app that turns any repository into a living, navigable 3D world** — fly through your code as a neon city, watch it cluster into a dependency galaxy, and explode any file into a molecule of its functions.

[![Electron](https://img.shields.io/badge/Electron-39-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![three.js](https://img.shields.io/badge/three.js-r185-000000?logo=three.js&logoColor=white)](https://threejs.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![tree-sitter](https://img.shields.io/badge/tree--sitter-WASM-8CC84B)](https://tree-sitter.github.io/)
[![Platform](https://img.shields.io/badge/platform-Linux%20arm64%20%7C%20x64-orange?logo=linux&logoColor=white)](#install)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

<img src="docs/screenshots/city-night.png" alt="A repository rendered as a night city — buildings are files, height is lines of code, lit windows glow on every tower" width="100%" />

*vLLM (~6,000 files, 1.5M LOC, 23,574 resolved imports) — analyzed and rendered in seconds.*

</div>

---

## Three worlds, one codebase

| 🏙 **City** | 🌌 **Galaxy** | 🧬 **Molecule** |
|---|---|---|
| Folders are districts, files are buildings. Height = lines of code, color = language, glowing windows = git churn. | Files become stars, imports become gravity. Watch your architecture cluster itself in 3D space. | Double-click any building: its functions, classes and variables become atoms; calls become bonds. |
| <img src="docs/screenshots/city-day.png" alt="Day-theme city view" /> | <img src="docs/screenshots/galaxy.png" alt="Force-directed dependency galaxy with labeled clusters" /> | <img src="docs/screenshots/molecule.png" alt="A file exploded into labeled symbol atoms" /> |

The three views **morph into each other** — buildings lift off and fly into orbit, then collapse back into streets. Same objects, same selection, same picking; only the physics change.

## 🔬 Not just a picture — an instrument

| **Insight lenses** | **Architecture health** |
|---|---|
| Recolor the whole city by what you need to know: **complexity**, **hotspots** (churn × complexity), **freshness**, **TODO debt**, **ownership** (bus-factor glow), **coverage** (lcov import). | Tarjan-SCC **cycle detection** drawn as red arc webs, **load-bearing files** ranked by transitive dependents, **dead-code candidates** — every finding is a click-to-fly row. |
| <img src="docs/screenshots/lens-hotspot.png" alt="Hotspot lens: churn times complexity glows orange" /> | <img src="docs/screenshots/health.png" alt="A 962-file dependency cycle drawn as red arcs over the city" /> |

| **AI copilot that flies the scene** | **Built-in AI editor** |
|---|---|
| The chat doesn't just answer — it **operates the visualization** through tools: *"show me the hottest files in the scheduler"* switches the lens, filters the city, and flies you there. Works with native OpenAI tool-calling **or** prompt-based fallback on any endpoint. | Click a building, edit the real file in **CodeMirror 6** — save re-parses it and the building rescales and flashes live. Select code → **AI improve** streams a rewrite into a side-by-side diff with accept/reject. |
| <img src="docs/screenshots/tour.png" alt="AI-guided tour stop with narration card" /> | <img src="docs/screenshots/editor.png" alt="In-app editor with inspector dossier" /> |

**⇆ Diff mode** — drag two handles on the timeline and the city becomes a review: added files glow green, modified amber, deleted sink red.

<img src="docs/screenshots/diff-mode.png" alt="Diff mode: amber modified buildings across a darkened city" width="100%" />

Plus: **🎓 AI-guided tours** (the model plans a narrated camera flight through the architecture), a **file inspector** dossier (metrics, symbols, imports, cycle membership), **right-click graph ops** (isolate a subsystem, show dependents — everything else sinks away), **meaning-based search** backed by cached one-line AI summaries of every file, camera bookmarks, hi-res screenshot export, recent-repos launch screen, `code-atlas /path` CLI, and an optional watch mode that re-analyzes on save.

## ⏪ Scrub through time

<img src="docs/screenshots/timescrub.png" alt="Timeline scrubber replaying repository history — buildings grow as commits land" width="100%" />

Drag the timeline and watch the city **replay its own git history** — buildings rise from empty lots as files are born, grow with every commit, and sink away when deleted. Keyframed folding keeps even a hard slider yank instant.

## ✨ Everything else in the box

- **🔍 Polyglot analysis** — real parsing via tree-sitter (WASM) for **JS / TS / TSX / Python / Go / Rust / C / C++ / Java**, with graceful stats-only fallback for everything else. Zero native modules; nothing to rebuild, ever.
- **🕸 Dependency arcs** — hover any file and glowing bezier arcs light up everything it imports and everything that imports it.
- **🛸 Two flight modes** — orbit with **zoom-to-cursor**, or hit `Tab` for pointer-locked WASD free-flight with altitude-scaled speed: crawl the streets, sprint the skyline.
- **⌨️ Fly-to search** — `Ctrl+K`, fuzzy-match any file, and the camera sweeps you to its rooftop.
- **📖 Real editing** — click a building and the file opens in a full CodeMirror editor with AI assist; Ctrl+S writes to disk and the city updates.
- **🤖 Local-AI native** — point it at an IP and it auto-detects **vLLM, llama.cpp, LM Studio (OpenAI-compatible) or Ollama**. The copilot chat operates the scene with tools, plans guided tours, powers the editor, and builds the semantic search index. No cloud, no keys, no telemetry.
- **🏷 Ambient intelligence** — district and cluster name labels, file labels that fade in when you stop to look, a language legend, a live stats HUD, a minimap, day/night themes, bloom, fog and drifting particles.
- **🏠 Never lost** — `H` reframes any view perfectly; idle in the galaxy and the camera begins a slow cinematic orbit.

## Install

Grab a build from [Releases](../../releases), or build from source:

```bash
git clone https://github.com/mtecnic/code-atlas.git
cd code-atlas
npm install        # Node ≥ 20
npm run dev        # hot-reloading dev app
```

Package for Linux (`.deb` + AppImage):

```bash
npm run build:linux
sudo dpkg -i dist/code-atlas_*_arm64.deb
```

> Analysis quality is best on a git repository (churn heat + timeline need history), but any plain folder works.

> **Remote desktop (RDP / VNC / xrdp):** these sessions usually lack GPU-accelerated GL. Code Atlas detects a broken WebGL context at startup and automatically relaunches itself into a working renderer (GPU-over-EGL first, then software). If the view still looks off, pick **Settings → Renderer → Software**. Software rendering is fully correct, just slower — a physical display gives the full effect.

### Hook up a local LLM

Open **⚙ Settings**, type an IP or host (port optional — common ports are probed automatically), hit **Detect**. That's it. vLLM, llama.cpp's `llama-server`, LM Studio and Ollama are all recognized; pick a model from the dropdown and the **✨ Explain** button and **💬 Ask AI** chat go live.

## Keyboard & mouse

| Input | Action |
|---|---|
| `Drag` / `Wheel` | Orbit / zoom toward cursor |
| `Click` | Select file → editor + inspector |
| `Double-click` | Explode file into molecule view |
| `Tab` | Toggle fly mode (`WASD` move, `Q/E` down/up, `Shift` boost) |
| `Ctrl+K` | Fuzzy search → fly to file |
| `H` | Reframe current view |
| `Esc` | Back out (molecule → city, close panels) |

## How it works

```
┌─ Electron main ──────────────────────────────┐   ┌─ Renderer ─────────────────────────┐
│ scanner        git ls-files / walk           │   │ zustand store ⇄ React panels       │
│ parse pool     Piscina × web-tree-sitter     │   │ SceneManager                       │
│ import resolver per-language heuristics      │──▶│  ├ WorldLayer   city ⇄ galaxy morph│
│ symbol graph   defs + call sites             │IPC│  ├ MoleculeLayer atoms & bonds     │
│ git history    streamed numstat + renames    │   │  ├ CameraRig    orbit/fly/framing  │
│ LLM proxy      probe + SSE streaming         │   │  └ TimeMachine  history folding    │
└──────────────────────────────────────────────┘   └────────────────────────────────────┘
```

- **One snapshot crosses IPC** (flat typed arrays, ~10 MB for 10k files); symbol graphs are fetched lazily per file.
- **10k buildings = 1 draw call** — a single `InstancedMesh` with per-instance color, heat, and glow attributes; the lit windows are procedural shader work (per-instance scale recovered from the instance matrix, so window size stays constant in world units on every building).
- **View morphs are free** — every entity exponentially smooths toward its current view's target arrays; the transition *is* the animation system.
- **Force layouts run in a Web Worker** (d3-force-3d), posting transferable position frames so the galaxy visibly settles into place.

## Dev

```bash
npm run typecheck      # strict TS, main + renderer
npm run dev            # electron-vite HMR
npm run build:linux    # package
```

Headless testing hooks (used for automated screenshots):

```bash
ATLAS_OPEN=/path/to/repo ATLAS_MODE=galaxy ATLAS_SHOT=/tmp/shot.png \
ATLAS_SHOT_DELAY=45000 xvfb-run -a npx electron out/main/index.js
```

---

<div align="center">

**Built for people who think codebases are worth seeing.**

*Bundled UI font: [DejaVu Sans](https://dejavu-fonts.github.io/) (free license).*

</div>
