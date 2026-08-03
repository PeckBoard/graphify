// The plugin manifest JSON body — identity, hooks, permissions, the three MCP
// tools, the per-repo visualizer page + its authenticated data routes, the
// sidebar entry, and the settings schema.

const DESCRIPTION =
  "Graphify: turn each repo into a queryable knowledge graph. Builds the graph " +
  "with graphify's deterministic tree-sitter pass (no LLM), exposes it to the " +
  "agent as three MCP tools — build, shortest path, explain — sets a session " +
  "system prompt telling the agent the graph exists and when to prefer it over " +
  "reading files, and ships a per-repo visualizer.";
const VERSION = "0.1.0";
const REPOSITORY = "https://github.com/PeckBoard/graphify";

// Inline SVG (lucide "waypoints") for the sidebar entry; rendered sandboxed.
const ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<circle cx="12" cy="4.5" r="2.5"/><circle cx="4.5" cy="19.5" r="2.5"/>' +
  '<circle cx="19.5" cy="19.5" r="2.5"/><path d="M10.2 6.3 6.3 17.2"/>' +
  '<path d="M13.8 6.3l3.9 10.9"/><path d="M7 19.5h10"/></svg>';

// Every tool takes an optional `repo`: a path RELATIVE to the folder root
// (`.` = the folder itself), because core pins exec's cwd to the folder root.
const REPO_ARG =
  "Repo to act on, as a path relative to the folder root ('.' for the folder " +
  "itself). Defaults to '.'. Must stay inside the folder.";

export function manifestJson(): string {
  const manifest = {
    description: DESCRIPTION,
    version: VERSION,
    repository: REPOSITORY,

    // A cold `pip install graphifyy` pulls graspologic (scipy/numba) plus ~14
    // tree-sitter wheels, and a first graph build on a large repo parses every
    // source file. Both legitimately outrun the extism default 2s budget, so
    // ask for the ceiling; core clamps to its MAX_CALL_TIMEOUT (610s).
    call_timeout_secs: 610,

    hooks: [
      "mcp.tool.invoke",
      "http.request.before",
      "http.request.authed",
      // Observed, never rewritten — the trigger for syncing the session's
      // graphify system prompt. See `allowUnchanged` in verdict.ts.
      "session.message.before",
    ],

    permissions: [
      "provide_mcp_tools", // graphify_build / graphify_path / graphify_explain
      "process_exec", // peckboard_exec — python3 (allowlisted) runs the driver
      "project_files_read", // peckboard_read_file — graphify-out/graph.json
      "data_store", // per-repo build state + which sessions carry the prompt
      "session_read", // peckboard_get_session — resolve the session's folder
      "session_prompt_write", // peckboard_set_session_system_prompt
      "user_authority", // serve the authenticated visualizer data routes
      "contribute_sidebar", // the Graphify sidebar page
    ],

    // Deliberately NOT a global `sidebar_items` entry. A global plugin page is
    // rendered with `scope={{}}` (peckboard/web/src/App.tsx), so its authed
    // fetches carry no `x-peckboard-project-id` / `x-peckboard-session-id`
    // header, `InvocationContext.folder_id` is None, and every scoped host
    // function fails with "caller has no folder scope" — which is every route
    // this page has. Project- and session-scoped items DO carry that id, so the
    // exec + read_file calls resolve to that folder's repos. Scoping the
    // visualizer to a project is also simply the right model: the repos it
    // lists are the ones under that project's folder.
    project_items: [
      { id: "graphify", label: "Graphify", icon: ICON, path: "/plugin-api/v1/graphify" },
    ],

    session_items: [
      { id: "graphify", label: "Graphify", icon: ICON, path: "/plugin-api/v1/graphify" },
    ],

    http_routes: ["GET /plugin-api/v1/graphify"],

    ui_routes: [
      "GET /api/plugin-ui/graphify/repos",
      "GET /api/plugin-ui/graphify/graph",
      "GET /api/plugin-ui/graphify/status",
      "POST /api/plugin-ui/graphify/build",
      "POST /api/plugin-ui/graphify/install",
    ],

    settings: [
      {
        key: "python_bin",
        title: "Python executable",
        type: "enum",
        default: "python3",
        options: [
          { value: "python3", label: "python3" },
          { value: "python", label: "python" },
        ],
        description:
          "Which interpreter runs the graphify driver. Must be one of core's allowlisted executables.",
      },
      {
        key: "auto_install",
        title: "Install graphify automatically",
        type: "boolean",
        default: true,
        description:
          "When graphify is missing, run 'pip install --user graphifyy' before the first build. " +
          "A cold install can exceed the 600s command ceiling; if it does, the page shows the " +
          "command to run by hand.",
      },
      {
        key: "prompt_mode",
        title: "Tell the agent about the graph",
        type: "enum",
        default: "when_graph_exists",
        options: [
          { value: "when_graph_exists", label: "Only when the repo has a graph" },
          { value: "always", label: "Always (even before a graph is built)" },
          { value: "off", label: "Never" },
        ],
        description:
          "Sets a session system prompt describing the repo's graph and the three tools. " +
          "Appended after the standing Peckboard prompt; takes effect on the session's next run.",
      },
      {
        key: "build_timeout_secs",
        title: "Build timeout (seconds)",
        type: "integer",
        default: 600,
        min: 30,
        max: 600,
        description: "How long a single graph build may run before core kills it.",
      },
    ],

    mcp_tools: [
      {
        name: "graphify_build",
        description:
          "Build (or refresh) this repo's graphify knowledge graph, writing graphify-out/graph.json " +
          "and graphify-out/GRAPH_REPORT.md. This is graphify's DETERMINISTIC pass: tree-sitter AST " +
          "extraction over source files plus a call-graph second pass, no LLM and no network. It does " +
          "NOT extract from docs, PDFs, or images — for a multimodal graph run the /graphify skill " +
          "instead. Returns node/edge/community counts, the highest-degree 'god nodes', and the " +
          "EXTRACTED/INFERRED/AMBIGUOUS confidence split. Run this once before querying, and again " +
          "after substantial code changes.",
        input_schema: {
          type: "object",
          properties: {
            repo: { type: "string", description: REPO_ARG },
            update: {
              type: "boolean",
              description:
                "Reuse the SHA256 cache and re-extract only changed files. Defaults to true; " +
                "pass false to force a full rebuild.",
            },
          },
          required: [],
          additionalProperties: false,
        },
      },
      {
        name: "graphify_path",
        description:
          "Find the shortest path between two concepts in this repo's knowledge graph — how a symbol, " +
          "file, or idea actually connects to another. Each hop names the relation (calls, imports, " +
          "uses, …) and its confidence (EXTRACTED = stated in the source, INFERRED = deduced, " +
          "AMBIGUOUS = uncertain). Use this instead of grepping when the question is 'how does A reach " +
          "B?'. Source and target are matched loosely against node labels and source files, so partial " +
          "names work. Requires a graph — run graphify_build first.",
        input_schema: {
          type: "object",
          properties: {
            source: { type: "string", description: "Starting concept: a node label, symbol, or keyword." },
            target: { type: "string", description: "Destination concept: a node label, symbol, or keyword." },
            repo: { type: "string", description: REPO_ARG },
            max_hops: {
              type: "integer",
              description: "Longest path to consider before giving up. Defaults to 8.",
            },
          },
          required: ["source", "target"],
          additionalProperties: false,
        },
      },
      {
        name: "graphify_explain",
        description:
          "Explain one concept from this repo's knowledge graph: where it is defined, every direct " +
          "neighbour with the relation and confidence on each edge, the community (cluster) it belongs " +
          "to with its other members, and how central it is by degree rank. Use this to orient in " +
          "unfamiliar code before opening files — it answers 'what is X and what touches it?' in one " +
          "call. Requires a graph — run graphify_build first.",
        input_schema: {
          type: "object",
          properties: {
            label: { type: "string", description: "The concept to explain: a node label, symbol, or keyword." },
            repo: { type: "string", description: REPO_ARG },
          },
          required: ["label"],
          additionalProperties: false,
        },
      },
    ],
  };
  return JSON.stringify(manifest);
}
