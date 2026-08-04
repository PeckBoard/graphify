# Peckboard Graphify plugin

A Peckboard WASM plugin that turns each repo in a folder into a **queryable
knowledge graph**, hands that graph to the agent as MCP tools, and ships a
per-repo visualizer.

- **Deterministic builds** — [graphify](https://pypi.org/project/graphifyy/)'s
  tree-sitter AST pass plus its cross-file call-graph second pass. No LLM, no
  network, no tokens spent.
- **MCP tools** — the agent builds a graph, walks the shortest path between two
  concepts, and explains one concept with its neighbours, community, and
  centrality.
- **A session system prompt** — every session in the folder is told the graph
  exists, how big it is, and when querying it beats opening files.
- **Off until you say otherwise** — a folder carries a Graphify switch, and
  each repo inside it carries its own. Both start off.
- **Visualizer** — a sidebar page ("Graphify") that lists every repo in the
  folder, carries those switches, shows its headline numbers, and draws the
  graph.

graphify runs as a **Python library**, not a service: the plugin ships a driver
program it executes through the `peckboard_exec` host function, so nothing is
installed globally and no daemon is left running.

## MCP tools

| Tool | What it does |
| --- | --- |
| `graphify_build` | Build or refresh the graph → `graphify-out/graph.json` + `GRAPH_REPORT.md`. Returns node/edge/community counts, the god nodes, and the confidence split. `update` (default `true`) reuses graphify's per-file SHA256 cache; `false` forces a full re-extract. |
| `graphify_path` | Shortest path between two concepts, hop by hop, with the relation and confidence on each edge, **plus a diagram of the chain the chat renders inline**. `source`/`target` match loosely against node labels and source files, so partial names work. |
| `graphify_explain` | One concept: where it is defined, every direct neighbour with relation + confidence, the community it belongs to with its other members, and its degree rank. |

Every tool takes an optional `repo` — a path **relative to the folder root**
(`.` = the folder itself), because core pins command execution to that root.
`graphify_path` and `graphify_explain` need a graph; both answer with an
explicit "call `graphify_build` first" when there isn't one.

Edges carry a confidence: **EXTRACTED** (stated in the source), **INFERRED**
(deduced by the cross-file pass), **AMBIGUOUS** (uncertain).

## Switching it on

Nothing runs until it is switched on, at two levels:

| Switch | Where | Default |
| --- | --- | --- |
| **Graphify in this folder** | top bar of the Graphify page | off |
| One repo inside that folder | the repo's card | off |

Installing the plugin therefore changes nothing on its own — including for a
folder that was already using it before the switches existed, which goes quiet
until someone turns it back on.

While a folder or repo is off:

- all three MCP tools answer `{enabled: false, error, next_step}` naming the
  switch to flip. `mcp_tools` is manifest-level, so a tool cannot be *hidden*
  per folder — refusing is the honest equivalent, and the refusal is a normal
  tool result the agent can act on;
- the session system prompt is not written (and an existing one is taken back
  off) — advertising tools that will refuse is worse than saying nothing;
- the page still **lists** repos, because that is how you choose one to enable,
  but it will not build or draw them.

The switches are written only from the authed page, under the operator's
authority. The agent reads them and stops; it cannot turn itself on.

Both live in the plugin document store, keyed by folder (`folders/<folder id>`)
and by folder-and-repo (`repos/<folder id>|<repo path>`). The folder id is part
of the key because core scopes that store by *plugin*, not by folder — which is
also why the old build records, keyed on the bare repo path, collided between
two folders that each had a `.` repo.

## The path diagram

A found `graphify_path` also comes back as a PNG: the hop chain drawn as a lit
polyline zig-zagging across a dim constellation, each node named and each
segment labelled with its relation and confidence. The tool result carries it as
`_image_base64`, which core (`peckboard/src/routes/mcp.rs`) turns into an MCP
image content block: the chat shows it in the tool card and a vision model sees
the route rather than parsing JSON. Turn it off with the **Draw the path in
chat** setting when the vision tokens aren't worth it.

The renderer (`src/pathimage.ts`, inlined into the driver) is standard-library
Python — `zlib` for the PNG stream, and antialiased lines, radial glows and a
5x7 bitmap font written by hand on a byte buffer. That is deliberate: the venv
is graphify's, and matplotlib only lands in it as a graspologic dependency. Two
things the layout does that are worth knowing before editing it:

- **Rows are serpentine, bands follow the column.** Five nodes a row, running
  left-to-right then right-to-left, and because `PER_ROW` is odd every row both
  starts and ends on the lower band — so a row change is a clean vertical drop
  rather than a diagonal across the labels.
- **Labels are placed, not just drawn.** Every node label reserves a box; each
  edge label then takes the first offset along its segment's perpendicular that
  lands clear of what is already there. Without it the row-seam labels stack.

The background field is decorative — a seeded LCG lays it out, not real
neighbours — so the picture is deterministic per query without pretending to
show graph structure it hasn't got. A render failure is swallowed, so a diagram
bug can never cost the caller the answer, and paths longer than 14 nodes are
drawn to that cap with the remainder stated in the footer.

## What the graph does *not* contain

`graphify_build` is graphify's **code-only** pass: source files parsed by
tree-sitter (`.py .ts .js .go .rs .java .cpp .c .rb .swift .kt .cs .scala .php
.cc .cxx .hpp .h .kts`). It does not read docs, PDFs, or images. For a
multimodal graph, run graphify's own `/graphify` skill — the session prompt says
so, so the agent doesn't ask this graph for prose it never ingested.

## Visualizer

The manifest contributes a global **sidebar** entry, `Graphify`, served at
`/plugin-api/v1/graphify` and framed in a sandboxed iframe. It reads its data
from the authenticated `/api/plugin-ui/graphify/*` routes through the standard
parent-proxied fetch bridge:

| Route | Returns |
| --- | --- |
| `GET …/status` | `{graphify_installed, python_bin, version, folder_known, folder_enabled}` |
| `GET …/repos` | Every graph target in the folder with its switch, counts, confidence split, god nodes, and build time — plus `folder_known` / `folder_enabled`. |
| `GET …/graph?repo=` | Nodes (with degree), edges, communities, and whole-graph `stats`; a refusal when that repo is switched off. |
| `POST …/build` | Same summary `graphify_build` returns — routed through the tool, so page and agent obey one gate. |
| `POST …/enable` | `{scope: "folder" \| "repo", repo?, enabled}` → the flipped state plus a fresh repo list. |
| `POST …/install` | `{installed, timed_out, output, manual_command}`. |

`/graph` returns the highest-degree slice of a large graph and flags it with
`truncated`; `stats` always describes the **whole** graph, so a capped drawing
never misreports its size.

## Installing graphify

The plugin runs `python3 -m pip install --user graphifyy` on the first build
when the `auto_install` setting is on. A cold install pulls graspologic
(scipy/numba) plus ~14 tree-sitter wheels and can legitimately outrun core's
600-second command ceiling; when it does, the result carries the exact command
to run by hand rather than reporting a success that never happened:

```bash
python3 -m pip install --user graphifyy
```

`python_bin` must name an interpreter on core's exec allowlist — `python3` or
`python`.

## Security

- The `repo` argument is **plugin-supplied**, so it is jailed twice: once in
  TypeScript before the driver is invoked, and once in the driver against the
  real filesystem. Relative segments only; an absolute path or a `..` that
  climbs above the folder root is refused either way.
- Commands run through `peckboard_exec`: a bare executable name from core's
  allowlist, an **argv array** (never a shell string, so there is nothing to
  interpret metacharacters), cwd pinned to the folder root, output capped at
  1 MiB per stream, and the child killed past the timeout.
- The driver reaches the network only when installing graphify. Building and
  querying a graph are local and offline.
- The plugin writes into the folder it is pointed at (`graphify-out/`) and reads
  nothing outside it.

## Settings

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `python_bin` | enum | `python3` | Interpreter that runs the driver. Must be on core's exec allowlist. |
| `auto_install` | boolean | `true` | Run `pip install --user graphifyy` when graphify is missing. |
| `prompt_mode` | enum | `when_graph_exists` | Whether to tell the agent about the graph: only when one exists, always, or never. |
| `path_image` | boolean | `true` | Return a found `graphify_path` as a diagram the chat renders inline. |
| `build_timeout_secs` | integer | `600` | How long one build may run before core kills it. |

## How it works

`src/driver.ts` holds one Python program, run as
`python3 -c "<driver>" <subcommand> [args]`. Its subcommands are `probe`,
`repos`, `build`, `summary`, `graph`, `path`, and `explain`; the last line of
stdout that parses as a JSON object is the result, so a chatty dependency can't
confuse the reader, and every failure path emits `{"error": …}` rather than
letting a traceback be the only output.

graphify ships **no build CLI** — its `__main__` only offers install / benchmark
/ hook — so the driver reimplements `graphify.watch._rebuild_code`: extract →
build → cluster → analyze → report → export. Reimplementing rather than calling
it buys three things: a build can target a subdirectory, a full rebuild can drop
the extraction cache, and files are filtered on their path *relative to the repo*
(graphify's own filter drops any file whose absolute path contains a dotted
part, which silently empties a repo checked out under `.peckboard/worktrees/`).

Aggregate counts are computed in Python, because a large graph does not fit
through the 1 MiB stdout cap. `src/graph.ts` owns everything that can be done on
the TypeScript side, and is pure so it can be unit-tested without an Extism host.

## Build

Targets the Extism js-pdk. Requires `extism-js` on `PATH` and Node/npm.

```bash
./build.sh
# or:
npm install && npm run build
# → dist/plugin.wasm
```

Run the unit tests with `npm test`. They need the page bundle generated first
(`npm run bundle`), because `src/page.ts` imports it.

## Install

Copy the built module into Peckboard's plugins directory, named to match its
config key (the file stem is the plugin id):

```bash
cp dist/plugin.wasm <dataDir>/plugins/graphify.wasm
```

Restart Peckboard, then approve the plugin (Settings → Plugins) — it declares
`provide_mcp_tools`, `process_exec`, `project_files_read`, `data_store`,
`session_read`, `session_prompt_write`, `user_authority`, and
`contribute_sidebar`.
