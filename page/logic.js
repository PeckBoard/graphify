// Pure helpers for the graphify visualizer page: theme tokens, graph capping,
// community colours, formatting, search. No DOM and no bridge access — every
// function here is exercised directly by test/page.test.ts.

// Render budget. Graphs can reach tens of thousands of nodes; past these caps
// we draw the top-N by degree and SAY so in the UI (never silently truncate).
export const MAX_NODES = 1500;
export const MAX_EDGES = 6000;

export const CONFIDENCES = ["EXTRACTED", "INFERRED", "AMBIGUOUS"];

// The colour system mirrors the app's design tokens (peckboard/web/src/index.css).
// The six `series` slots are the app's --chart-1..6 categorical ramp, already
// validated with the dataviz palette checks in both themes; slot ORDER is the
// colour-blind-safety mechanism — never reorder, never cycle. Communities past
// six fold into the neutral `other`. `conf` is a single-hue ordinal blue ramp
// for the EXTRACTED/INFERRED/AMBIGUOUS meter (always paired with text counts).
export const THEME = {
  light: {
    bg: "#f8f9fb",
    surface: "#ffffff",
    surface2: "#f3f4f6",
    surfaceHover: "#f0f1f4",
    text: "#1a1d23",
    text2: "#4b5563",
    text3: "#616875",
    border: "#e5e7eb",
    borderStrong: "#d1d5db",
    accent: "hsl(220, 72%, 50%)",
    accentHover: "hsl(220, 72%, 44%)",
    accentSubtle: "hsl(220, 60%, 95%)",
    ring: "hsl(220, 72%, 30%)",
    danger: "#dc2626",
    dangerBg: "#fef2f2",
    dangerBorder: "#fecaca",
    warnText: "#8a5a00",
    warnBg: "#fffbeb",
    warnBorder: "#fde9c0",
    series: ["#006ebe", "#a43600", "#c03e86", "#967600", "#6731a8", "#00672c"],
    other: "#8a919e",
    edge: "#848b97",
    halo: "#f8f9fb",
    conf: { EXTRACTED: "#1c5cab", INFERRED: "#3987e5", AMBIGUOUS: "#86b6ef" },
  },
  dark: {
    bg: "#0f1117",
    surface: "#1a1d27",
    surface2: "#22252f",
    surfaceHover: "#2f323e",
    text: "#e5e7eb",
    text2: "#9ca3af",
    text3: "#8f97a5",
    border: "#2a2d38",
    borderStrong: "#3a3d48",
    accent: "hsl(220, 65%, 62%)",
    accentHover: "hsl(220, 65%, 56%)",
    accentSubtle: "hsl(220, 30%, 16%)",
    ring: "hsl(220, 65%, 68%)",
    danger: "#f87171",
    dangerBg: "rgba(239, 68, 68, 0.1)",
    dangerBorder: "rgba(239, 68, 68, 0.25)",
    warnText: "#fbbf24",
    warnBg: "rgba(245, 158, 11, 0.1)",
    warnBorder: "rgba(245, 158, 11, 0.25)",
    series: ["#0071c3", "#c54300", "#db589e", "#a78400", "#a170eb", "#007f38"],
    other: "#6e7683",
    edge: "#59606e",
    halo: "#0f1117",
    conf: { EXTRACTED: "#6da7ec", INFERRED: "#3987e5", AMBIGUOUS: "#1c5cab" },
  },
};

// Edge line styles by confidence — dash pattern carries the meaning alongside
// alpha, so confidence is never colour-alone. Patterns are in screen px.
export const CONF_STYLE = {
  EXTRACTED: { dash: [], alpha: 0.5 },
  INFERRED: { dash: [5, 4], alpha: 0.4 },
  AMBIGUOUS: { dash: [1.5, 3.5], alpha: 0.3 },
};

export function normalizeConfidence(c) {
  const u = String(c || "").toUpperCase();
  return CONFIDENCES.indexOf(u) >= 0 ? u : "EXTRACTED";
}

// Cap a graph for rendering: top maxNodes by degree, then edges between the
// survivors, EXTRACTED-first when the edge budget also overflows. Reports what
// was dropped so the UI can state it plainly.
export function capGraph(nodes, edges, maxNodes = MAX_NODES, maxEdges = MAX_EDGES) {
  nodes = nodes || [];
  edges = edges || [];
  let keptNodes = nodes;
  let nodeCapped = false;
  if (nodes.length > maxNodes) {
    keptNodes = nodes
      .slice()
      .sort((a, b) => (b.degree || 0) - (a.degree || 0))
      .slice(0, maxNodes);
    nodeCapped = true;
  }
  const ids = new Set(keptNodes.map((n) => n.id));
  let keptEdges = edges.filter((e) => ids.has(e.source) && ids.has(e.target));
  let edgeCapped = false;
  if (keptEdges.length > maxEdges) {
    const rank = { EXTRACTED: 0, INFERRED: 1, AMBIGUOUS: 2 };
    keptEdges = keptEdges
      .slice()
      .sort(
        (a, b) => rank[normalizeConfidence(a.confidence)] - rank[normalizeConfidence(b.confidence)],
      )
      .slice(0, maxEdges);
    edgeCapped = true;
  }
  return {
    nodes: keptNodes,
    edges: keptEdges,
    totalNodes: nodes.length,
    totalEdges: edges.length,
    nodeCapped,
    edgeCapped,
  };
}

// Map community id -> categorical slot. The `slots` largest communities get
// series colours in size order; every other community gets -1 ("other").
export function communityColorMap(communities, slots = 6) {
  const bySize = (communities || []).slice().sort((a, b) => (b.size || 0) - (a.size || 0));
  const map = new Map();
  bySize.forEach((c, i) => map.set(c.id, i < slots ? i : -1));
  return map;
}

// Legend model: the slotted communities plus a folded "other" bucket.
export function communityLegend(communities, slots = 6) {
  const bySize = (communities || []).slice().sort((a, b) => (b.size || 0) - (a.size || 0));
  const top = bySize.slice(0, slots);
  const rest = bySize.slice(slots);
  return {
    top,
    otherCount: rest.length,
    otherSize: rest.reduce((a, c) => a + (c.size || 0), 0),
  };
}

// Adjacency: id -> [{id, relation, confidence, dir}]. Self-loops appear once.
export function neighborIndex(edges) {
  const adj = new Map();
  const add = (a, b, e, dir) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push({ id: b, relation: e.relation || "", confidence: normalizeConfidence(e.confidence), dir });
  };
  for (const e of edges || []) {
    add(e.source, e.target, e, "out");
    if (e.target !== e.source) add(e.target, e.source, e, "in");
  }
  return adj;
}

// 12345 -> "12,345" (locale-independent so tests are stable).
export function formatCount(n) {
  if (typeof n !== "number" || !isFinite(n)) return "0";
  const neg = n < 0;
  let s = String(Math.abs(Math.round(n)));
  let out = "";
  while (s.length > 3) {
    out = "," + s.slice(-3) + out;
    s = s.slice(0, -3);
  }
  return (neg ? "-" : "") + s + out;
}

// built_at may be epoch seconds, epoch ms, or an ISO string.
export function timeAgo(value, nowMs) {
  let t = NaN;
  if (typeof value === "number" && isFinite(value)) {
    t = value < 1e12 ? value * 1000 : value;
  } else if (typeof value === "string" && value.trim()) {
    if (/^\d+(\.\d+)?$/.test(value.trim())) {
      const n = Number(value.trim());
      t = n < 1e12 ? n * 1000 : n;
    } else {
      const p = Date.parse(value);
      if (!isNaN(p)) t = p;
    }
  }
  if (isNaN(t)) return "";
  const d = Math.max(0, nowMs - t);
  const min = 60000;
  const hr = 3600000;
  const day = 86400000;
  if (d < 45000) return "just now";
  if (d < hr) return Math.max(1, Math.round(d / min)) + "m ago";
  if (d < day) return Math.round(d / hr) + "h ago";
  if (d < 14 * day) return Math.round(d / day) + "d ago";
  return new Date(t).toISOString().slice(0, 10);
}

// Rank label matches: exact > prefix > substring > file-path hit; ties by
// degree. Case-insensitive.
export function searchNodes(nodes, query, limit = 8) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return [];
  const scored = [];
  for (const n of nodes || []) {
    const label = String(n.label || "").toLowerCase();
    const file = String(n.source_file || "").toLowerCase();
    let score;
    if (label === q) score = 0;
    else if (label.startsWith(q)) score = 1;
    else if (label.indexOf(q) >= 0) score = 2;
    else if (file.indexOf(q) >= 0) score = 3;
    else continue;
    scored.push([score, -(n.degree || 0), n]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return scored.slice(0, limit).map((s) => s[2]);
}

// {EXTRACTED: n, ...} -> [{key, count, pct}] with pcts that sum to exactly 100
// (largest-remainder rounding) unless the total is zero.
export function confidenceSplit(conf) {
  const counts = CONFIDENCES.map((k) => Math.max(0, Number((conf || {})[k]) || 0));
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return CONFIDENCES.map((k, i) => ({ key: k, count: counts[i], pct: 0 }));
  const exact = counts.map((c) => (c * 100) / total);
  const floors = exact.map(Math.floor);
  let left = 100 - floors.reduce((a, b) => a + b, 0);
  const order = exact
    .map((e, i) => [e - floors[i], i])
    .sort((a, b) => b[0] - a[0]);
  for (let j = 0; j < order.length && left > 0; j++, left--) floors[order[j][1]]++;
  return CONFIDENCES.map((k, i) => ({ key: k, count: counts[i], pct: floors[i] }));
}

// Node radius in world units: perceptible floor, sqrt growth, sane ceiling.
export function nodeRadius(degree) {
  const d = Math.max(0, Number(degree) || 0);
  return Math.min(16, 2.5 + 1.2 * Math.sqrt(d));
}
