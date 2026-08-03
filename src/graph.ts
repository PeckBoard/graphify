// Graph math. Everything here is pure — no host calls, no I/O — so the shapes
// the tools and the visualizer depend on are unit-testable without an Extism
// runtime.
//
// The input is NetworkX node-link JSON, written by `graphify.export.to_json`
// and read back with `json_graph.node_link_graph(data, edges="links")`: nodes
// under `nodes` carrying `id` / `label` / `source_file` / `source_location` /
// `community`, edges under `links` carrying `source` / `target` / `relation` /
// `confidence`. The driver's `graph` subcommand emits the same shape (trimmed
// and capped), so one parser serves both.

export interface GraphNode {
  id: string;
  label: string;
  community: number | null;
  source_file: string;
  source_location: string;
  degree: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  relation: string;
  confidence: string;
}

export interface ParsedGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/// The three confidence levels graphify puts on an edge: EXTRACTED = stated in
/// the source, INFERRED = deduced by the cross-file pass, AMBIGUOUS = uncertain.
export interface ConfidenceCounts {
  EXTRACTED: number;
  INFERRED: number;
  AMBIGUOUS: number;
}

export interface GodNode {
  label: string;
  degree: number;
}

export interface CommunityEntry {
  id: number;
  size: number;
  label: string;
}

export interface GraphSummary {
  nodes: number;
  edges: number;
  communities: number;
  confidence: ConfidenceCounts;
  god_nodes: GodNode[];
}

const CONFIDENCE_KEYS = ["EXTRACTED", "INFERRED", "AMBIGUOUS"] as const;

function emptyConfidence(): ConfidenceCounts {
  return { EXTRACTED: 0, INFERRED: 0, AMBIGUOUS: 0 };
}

function str(v: unknown, fallback = ""): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return fallback;
}

function community(v: unknown): number | null {
  if (typeof v === "number" && isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && v.trim() !== "" && isFinite(Number(v))) return Math.trunc(Number(v));
  return null;
}

// ── Parsing ──────────────────────────────────────────────────────────────────

/// Parse an already-decoded node-link value. `repo` only shapes the error text.
export function parseGraph(data: unknown, repo: string): ParsedGraph {
  if (data === null || data === undefined || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("graph.json is corrupted — rebuild");
  }
  const raw = data as Record<string, unknown>;
  const rawNodes = raw.nodes;
  if (!Array.isArray(rawNodes)) {
    throw new Error("graph.json is corrupted — rebuild");
  }
  // `links` is the key graphify writes; NetworkX's own default is `edges`, and
  // a hand-edited file may carry either.
  const rawEdges = Array.isArray(raw.links)
    ? raw.links
    : Array.isArray(raw.edges)
      ? raw.edges
      : [];

  const nodes: GraphNode[] = [];
  for (const entry of rawNodes) {
    if (entry === null || typeof entry !== "object") continue;
    const n = entry as Record<string, unknown>;
    const id = str(n.id);
    if (id === "") continue; // a node without an id can't be an edge endpoint
    nodes.push({
      id,
      label: str(n.label, id),
      community: community(n.community),
      source_file: str(n.source_file),
      source_location: str(n.source_location),
      degree: typeof n.degree === "number" ? n.degree : 0,
    });
  }

  const edges: GraphEdge[] = [];
  for (const entry of rawEdges) {
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const source = str(e.source);
    const target = str(e.target);
    if (source === "" || target === "") continue;
    edges.push({
      source,
      target,
      relation: str(e.relation),
      confidence: str(e.confidence).toUpperCase(),
    });
  }

  if (nodes.length === 0 && rawNodes.length > 0) {
    throw new Error(`graph for ${repo} has no usable nodes — rebuild`);
  }
  return { nodes, edges };
}

/// Parse a raw `graphify-out/graph.json` body.
export function parseGraphJson(text: string, repo: string): ParsedGraph {
  if (typeof text !== "string" || text.trim() === "") {
    throw new Error(`no graph for ${repo} — run graphify_build first`);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (_e) {
    throw new Error("graph.json is corrupted — rebuild");
  }
  return parseGraph(decoded, repo);
}

// ── Degrees, god nodes, communities ──────────────────────────────────────────

/// Edge count per node id. A self-loop counts twice, matching `nx.Graph.degree`.
export function nodeDegrees(graph: ParsedGraph): Record<string, number> {
  const degrees: Record<string, number> = {};
  for (const node of graph.nodes) degrees[node.id] = 0;
  for (const edge of graph.edges) {
    if (edge.source in degrees) degrees[edge.source] += 1;
    if (edge.target in degrees) degrees[edge.target] += 1;
  }
  return degrees;
}

/// Fill in each node's `degree` from the edge list. The driver already ships
/// degrees (it has the whole graph, including edges the cap dropped); this is
/// for a graph.json read directly, where nothing has counted yet.
export function withDegrees(graph: ParsedGraph): ParsedGraph {
  const degrees = nodeDegrees(graph);
  return {
    nodes: graph.nodes.map((n) => ({ ...n, degree: n.degree || degrees[n.id] || 0 })),
    edges: graph.edges,
  };
}

/// The most connected nodes — graphify calls these the graph's "god nodes",
/// the core abstractions everything else hangs off. Ties break on label so the
/// ranking is stable between runs.
export function godNodes(graph: ParsedGraph, topN = 10): GodNode[] {
  const degrees = nodeDegrees(graph);
  return graph.nodes
    .map((n) => ({ label: n.label, degree: n.degree || degrees[n.id] || 0 }))
    .sort((a, b) => b.degree - a.degree || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
    .slice(0, Math.max(0, topN));
}

/// Edge counts per confidence level. An edge with no confidence is treated as
/// EXTRACTED, the same default `graphify/serve.py` uses for its stats; anything
/// outside the three known levels is not counted.
export function confidenceCounts(graph: ParsedGraph): ConfidenceCounts {
  const counts = emptyConfidence();
  for (const edge of graph.edges) {
    const key = edge.confidence === "" ? "EXTRACTED" : edge.confidence;
    if ((CONFIDENCE_KEYS as readonly string[]).includes(key)) {
      counts[key as keyof ConfidenceCounts] += 1;
    }
  }
  return counts;
}

/// Communities reconstructed from the `community` attribute on each node —
/// exactly how `graphify/serve.py` rebuilds them. Largest first.
export function communityList(graph: ParsedGraph): CommunityEntry[] {
  const sizes = new Map<number, number>();
  for (const node of graph.nodes) {
    if (node.community === null) continue;
    sizes.set(node.community, (sizes.get(node.community) ?? 0) + 1);
  }
  return [...sizes.entries()]
    .map(([id, size]) => ({ id, size, label: `Community ${id}` }))
    .sort((a, b) => b.size - a.size || a.id - b.id);
}

// ── Summaries ────────────────────────────────────────────────────────────────

/// Summarize a graph we hold in full.
export function summarize(graph: ParsedGraph, topN = 10): GraphSummary {
  return {
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    communities: communityList(graph).length,
    confidence: confidenceCounts(graph),
    god_nodes: godNodes(graph, topN),
  };
}

/// Summarize a driver payload.
///
/// The driver aggregates over the WHOLE graph and sends only `totals` +
/// `top_nodes`, because a large graph does not fit through the 1 MiB stdout
/// cap — so these counts stay right even when the node/link detail was capped.
/// A payload without `totals` (an empty or unexpected result) falls back to
/// counting whatever detail did arrive.
export function summarizeTotals(payload: any, topN = 10): GraphSummary {
  const totals = payload?.totals;
  if (!totals || typeof totals !== "object") {
    return summarize(parseGraph(payload ?? {}, str(payload?.repo, ".")), topN);
  }
  const confidence = emptyConfidence();
  for (const key of CONFIDENCE_KEYS) {
    const v = totals.confidence?.[key];
    confidence[key] = typeof v === "number" ? v : 0;
  }
  const top = Array.isArray(payload?.top_nodes) ? payload.top_nodes : [];
  return {
    nodes: typeof totals.nodes === "number" ? totals.nodes : 0,
    edges: typeof totals.edges === "number" ? totals.edges : 0,
    communities: typeof totals.communities === "number" ? totals.communities : 0,
    confidence,
    god_nodes: top
      .filter((n: any) => n && typeof n === "object")
      .map((n: any) => ({ label: str(n.label), degree: typeof n.degree === "number" ? n.degree : 0 }))
      .slice(0, Math.max(0, topN)),
  };
}
