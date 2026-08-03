// The session system prompt. `session.message.before` fires once per user turn,
// so this module's job is to keep each session's graphify block in sync with
// the folder's graph and otherwise do nothing at all — the block is prepended
// to every turn's context, so it stays short, and the host call only happens
// when the text actually changed.

import { getSetting, readFile, setSessionSystemPrompt, storeGet, storePut } from "./host";
import { parseGraphJson, summarize } from "./graph";

/// Document-store collection: session id → the hash of the block we last wrote.
const SESSION_PROMPT = "session_prompt";

/// Where the folder root's graph lives. The prompt describes the folder, not a
/// nested repo — the agent's cwd is the folder root.
const FOLDER_GRAPH = "graphify-out/graph.json";

export type PromptMode = "off" | "when_graph_exists" | "always";

export interface GraphStats {
  nodes: number;
  edges: number;
  communities: number;
}

export function promptMode(): PromptMode {
  const v = getSetting("prompt_mode");
  return v === "off" || v === "always" || v === "when_graph_exists" ? v : "when_graph_exists";
}

// ── The block ────────────────────────────────────────────────────────────────

/// Compose the system prompt block.
///
/// Deliberately concrete and deliberately small: it names the three tools, says
/// when each beats opening files, and says what the graph does NOT cover, so
/// the agent doesn't ask it for prose it never ingested. Well under 2 KB —
/// every token here is paid on every turn of every session in the folder.
export function composePrompt(stats: GraphStats | null, hasGraph: boolean): string {
  const lines: string[] = ["## Graphify knowledge graph", ""];

  if (!hasGraph) {
    lines.push(
      "This folder has no graphify knowledge graph yet. Call `graphify_build` to create one:",
      "it runs a deterministic tree-sitter pass over the source files (no LLM, no network) and",
      "writes `graphify-out/graph.json`. After that, `graphify_explain` and `graphify_path`",
      "answer structural questions far faster than reading files.",
    );
  } else {
    const size = stats
      ? ` (${stats.nodes} nodes, ${stats.edges} edges, ${stats.communities} communities)`
      : "";
    lines.push(
      `This folder has a graphify knowledge graph${size} at \`graphify-out/graph.json\`.`,
      "",
      "Query it instead of grepping when the question is structural:",
      "- `graphify_explain(label)` — what X is, where it is defined, every direct neighbour with",
      "  the relation and confidence on each edge, and the cluster it belongs to. The fastest way",
      "  to orient in unfamiliar code before opening a single file.",
      "- `graphify_path(source, target)` — how A actually reaches B, hop by hop.",
      "- `graphify_build()` — refresh after substantial code changes.",
      "",
      "Read files when you need exact text, line numbers, comments, or anything an AST does not",
      "carry; the graph tells you where to look, not what the code says.",
    );
  }

  lines.push(
    "",
    "The graph is code-only: a tree-sitter AST pass over source files, with no docs, PDFs or",
    "images in it. For a multimodal graph that covers those too, run the `/graphify` skill.",
  );
  return lines.join("\n");
}

/// Stable 32-bit FNV-1a, hex. Only ever compared against itself, so the point
/// is determinism across runs, not collision resistance.
export function hashBlock(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `0000000${h.toString(16)}`.slice(-8);
}

// ── Syncing ──────────────────────────────────────────────────────────────────

/// Called from `session.message.before`. Never throws out of `lib.ts`'s guard,
/// but it also never blocks a turn on its own account: every step degrades to
/// "leave the prompt alone".
export function syncSessionPrompt(payload: any): void {
  const sessionId = typeof payload?.session_id === "string" ? payload.session_id.trim() : "";
  if (sessionId === "") return;

  const mode = promptMode();
  if (mode === "off") return;

  const graph = readFolderGraph();
  if (mode === "when_graph_exists" && !graph.exists) {
    // The graph was deleted (or never built) — take our block back off, so the
    // session stops being told about tools that have nothing to answer from.
    clearPrompt(sessionId);
    return;
  }

  writePrompt(sessionId, composePrompt(graph.stats, graph.exists));
}

function writePrompt(sessionId: string, block: string): void {
  const hash = hashBlock(block);
  const prev = storeGet(SESSION_PROMPT, sessionId);
  if (prev && prev.hash === hash) return; // already current — no host call
  setSessionSystemPrompt(sessionId, block);
  storePut(SESSION_PROMPT, sessionId, { hash, at: Date.now() });
}

function clearPrompt(sessionId: string): void {
  const prev = storeGet(SESSION_PROMPT, sessionId);
  if (!prev || !prev.hash) return; // nothing of ours is set
  setSessionSystemPrompt(sessionId, null);
  storePut(SESSION_PROMPT, sessionId, { hash: null, at: Date.now() });
}

/// Does the folder have a graph, and how big is it?
///
/// Existence is a `peckboard_read_file` that either returns or throws — core
/// exposes no cheaper stat. The counts come from the build record first, so the
/// common path never parses the JSON; parsing is the fallback for a graph built
/// outside the plugin, and a graph too large for the 1 MiB read cap still
/// counts as present, just without numbers.
export function readFolderGraph(): { exists: boolean; stats: GraphStats | null } {
  let text = "";
  try {
    text = readFile(FOLDER_GRAPH);
  } catch (_e) {
    return { exists: false, stats: null };
  }
  if (text.trim() === "") return { exists: false, stats: null };

  const record = storeGet("repos", ".");
  if (record && typeof record.nodes === "number") {
    return {
      exists: true,
      stats: {
        nodes: record.nodes,
        edges: typeof record.edges === "number" ? record.edges : 0,
        communities: typeof record.communities === "number" ? record.communities : 0,
      },
    };
  }
  try {
    const s = summarize(parseGraphJson(text, "."));
    return { exists: true, stats: { nodes: s.nodes, edges: s.edges, communities: s.communities } };
  } catch (_e) {
    return { exists: true, stats: null };
  }
}
