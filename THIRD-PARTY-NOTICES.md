# Third-party notices

Code Atlas is [MIT licensed](LICENSE). The polyglot parsing that makes the molecule view and
the symbol graph possible is not our work — it is [tree-sitter](https://tree-sitter.github.io/)
and its per-language grammars. Credit where it's due.

## Redistributed in this repository

`resources/grammars/` contains prebuilt WebAssembly binaries compiled from the tree-sitter
projects below. They are third-party software, not Code Atlas code, and each remains under
its own licence.

| File | Project | Licence |
|---|---|---|
| `web-tree-sitter.wasm` | [tree-sitter/tree-sitter](https://github.com/tree-sitter/tree-sitter) — the parser runtime | MIT |
| `tree-sitter-c.wasm` | [tree-sitter/tree-sitter-c](https://github.com/tree-sitter/tree-sitter-c) | MIT |
| `tree-sitter-cpp.wasm` | [tree-sitter/tree-sitter-cpp](https://github.com/tree-sitter/tree-sitter-cpp) | MIT |
| `tree-sitter-go.wasm` | [tree-sitter/tree-sitter-go](https://github.com/tree-sitter/tree-sitter-go) | MIT |
| `tree-sitter-java.wasm` | [tree-sitter/tree-sitter-java](https://github.com/tree-sitter/tree-sitter-java) | MIT |
| `tree-sitter-javascript.wasm` | [tree-sitter/tree-sitter-javascript](https://github.com/tree-sitter/tree-sitter-javascript) | MIT |
| `tree-sitter-python.wasm` | [tree-sitter/tree-sitter-python](https://github.com/tree-sitter/tree-sitter-python) | MIT |
| `tree-sitter-rust.wasm` | [tree-sitter/tree-sitter-rust](https://github.com/tree-sitter/tree-sitter-rust) | MIT |
| `tree-sitter-typescript.wasm`, `tree-sitter-tsx.wasm` | [tree-sitter/tree-sitter-typescript](https://github.com/tree-sitter/tree-sitter-typescript) | MIT |

All of the above are MIT-licensed. The MIT notice each requires is reproduced below; the
copyright holders are the respective tree-sitter project authors, principally
Max Brunsfeld and contributors.

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

For the authoritative, per-project copyright lines, see each repository's `LICENSE` file at
the links above.

## Principal runtime dependencies

Installed via npm rather than redistributed here:

| Project | Licence | What it does for Code Atlas |
|---|---|---|
| [tree-sitter](https://github.com/tree-sitter/tree-sitter) (`web-tree-sitter`) | MIT | All real parsing — every symbol, call edge and import the molecule and galaxy views draw. |
| [three.js](https://github.com/mrdoob/three.js) | MIT | The city, galaxy and molecule rendering, and the morphs between them. |
| [Electron](https://github.com/electron/electron) | MIT | Desktop application shell. |
| [React](https://github.com/facebook/react) | MIT | UI. |
| [Piscina](https://github.com/piscinajs/piscina) | MIT | The worker pool that parses a repository in parallel. |

## Bundled font

| Asset | Project | Licence |
|---|---|---|
| UI font | [DejaVu Sans](https://dejavu-fonts.github.io/) | [DejaVu Fonts Licence](https://dejavu-fonts.github.io/License.html) — a permissive free licence derived from the Bitstream Vera Fonts copyright |

Licence texts for npm dependencies are installed under `node_modules/` and are included in
packaged builds.
