import { describe, expect, it } from "vitest";
import {
  CONFIDENCES,
  THEME,
  capGraph,
  communityColorMap,
  communityLegend,
  confidenceSplit,
  formatCount,
  neighborIndex,
  nodeRadius,
  normalizeConfidence,
  searchNodes,
  timeAgo,
} from "../page/logic.js";
import { buildQuadtree, createSim, mulberry32, tickSim } from "../page/sim.js";

const node = (id: string, degree = 1, community = 0, extra = {}) => ({
  id,
  label: id,
  degree,
  community,
  ...extra,
});
const edge = (source: string, target: string, confidence = "EXTRACTED", relation = "calls") => ({
  source,
  target,
  confidence,
  relation,
});

describe("capGraph", () => {
  it("passes small graphs through untouched", () => {
    const nodes = [node("a"), node("b")];
    const edges = [edge("a", "b")];
    const r = capGraph(nodes, edges, 10, 10);
    expect(r.nodes).toEqual(nodes);
    expect(r.edges).toEqual(edges);
    expect(r.nodeCapped).toBe(false);
    expect(r.edgeCapped).toBe(false);
  });

  it("keeps the top-N by degree and drops dangling edges, reporting totals", () => {
    const nodes = [node("a", 9), node("b", 5), node("c", 1), node("d", 7)];
    const edges = [edge("a", "b"), edge("a", "c"), edge("b", "d")];
    const r = capGraph(nodes, edges, 3, 100);
    expect(r.nodes.map((n: any) => n.id)).toEqual(["a", "d", "b"]);
    expect(r.edges.map((e: any) => [e.source, e.target])).toEqual([
      ["a", "b"],
      ["b", "d"],
    ]);
    expect(r.nodeCapped).toBe(true);
    expect(r.totalNodes).toBe(4);
    expect(r.totalEdges).toBe(3);
  });

  it("caps edges keeping EXTRACTED before INFERRED before AMBIGUOUS", () => {
    const nodes = [node("a"), node("b"), node("c")];
    const edges = [
      edge("a", "b", "AMBIGUOUS"),
      edge("b", "c", "EXTRACTED"),
      edge("a", "c", "INFERRED"),
    ];
    const r = capGraph(nodes, edges, 10, 2);
    expect(r.edges.map((e: any) => e.confidence)).toEqual(["EXTRACTED", "INFERRED"]);
    expect(r.edgeCapped).toBe(true);
  });
});

describe("community colours", () => {
  const comms = [
    { id: 3, size: 50, label: "big" },
    { id: 1, size: 40, label: "mid" },
    { id: 7, size: 5, label: "tiny" },
    { id: 2, size: 4, label: "tinier" },
  ];

  it("assigns slots to the largest communities in size order, rest fold to other", () => {
    const m = communityColorMap(comms, 2);
    expect(m.get(3)).toBe(0);
    expect(m.get(1)).toBe(1);
    expect(m.get(7)).toBe(-1);
    expect(m.get(2)).toBe(-1);
  });

  it("never hands out more slots than the palette has", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: i, size: 100 - i, label: "c" + i }));
    const m = communityColorMap(many);
    const slots = [...m.values()].filter((s) => s >= 0);
    expect(Math.max(...slots)).toBeLessThan(THEME.light.series.length);
    expect(slots.length).toBe(THEME.light.series.length);
  });

  it("legend folds the tail with counts", () => {
    const l = communityLegend(comms, 2);
    expect(l.top.map((c: any) => c.id)).toEqual([3, 1]);
    expect(l.otherCount).toBe(2);
    expect(l.otherSize).toBe(9);
  });
});

describe("confidenceSplit", () => {
  it("rounds to percentages that sum to exactly 100", () => {
    const split = confidenceSplit({ EXTRACTED: 1, INFERRED: 1, AMBIGUOUS: 1 });
    expect(split.reduce((a, s) => a + s.pct, 0)).toBe(100);
    expect(split.map((s) => s.key)).toEqual(CONFIDENCES);
  });

  it("handles zero totals and junk input", () => {
    expect(confidenceSplit(undefined).every((s) => s.pct === 0)).toBe(true);
    expect(confidenceSplit({ EXTRACTED: -5 }).every((s) => s.pct === 0)).toBe(true);
  });
});

describe("neighborIndex", () => {
  it("indexes both directions with relation and confidence", () => {
    const adj = neighborIndex([edge("a", "b", "INFERRED", "imports")]);
    expect(adj.get("a")).toEqual([{ id: "b", relation: "imports", confidence: "INFERRED", dir: "out" }]);
    expect(adj.get("b")).toEqual([{ id: "a", relation: "imports", confidence: "INFERRED", dir: "in" }]);
  });

  it("records self-loops once", () => {
    const adj = neighborIndex([edge("a", "a")]);
    expect(adj.get("a")).toHaveLength(1);
  });
});

describe("formatting", () => {
  it("formatCount groups thousands", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(999)).toBe("999");
    expect(formatCount(12345)).toBe("12,345");
    expect(formatCount(1234567)).toBe("1,234,567");
    expect(formatCount(NaN as any)).toBe("0");
  });

  it("timeAgo handles epoch seconds, ms, ISO, and junk", () => {
    const now = Date.parse("2026-08-03T12:00:00Z");
    expect(timeAgo(now / 1000 - 120, now)).toBe("2m ago");
    expect(timeAgo(now - 3 * 3600000, now)).toBe("3h ago");
    expect(timeAgo("2026-08-01T12:00:00Z", now)).toBe("2d ago");
    expect(timeAgo("2026-01-01T00:00:00Z", now)).toBe("2026-01-01");
    expect(timeAgo(now, now)).toBe("just now");
    expect(timeAgo("garbage", now)).toBe("");
    expect(timeAgo(undefined as any, now)).toBe("");
  });

  it("nodeRadius has a floor and a ceiling", () => {
    expect(nodeRadius(0)).toBeCloseTo(2.5);
    expect(nodeRadius(10000)).toBe(16);
    expect(nodeRadius(9)).toBeGreaterThan(nodeRadius(4));
  });

  it("normalizeConfidence defaults junk to EXTRACTED", () => {
    expect(normalizeConfidence("inferred")).toBe("INFERRED");
    expect(normalizeConfidence("wat")).toBe("EXTRACTED");
    expect(normalizeConfidence(undefined)).toBe("EXTRACTED");
  });
});

describe("searchNodes", () => {
  const nodes = [
    node("alpha", 3),
    node("alphabet", 9),
    node("beta_alpha", 1),
    { id: "x", label: "gamma", degree: 2, community: 0, source_file: "src/alpha.rs" },
  ];

  it("ranks exact > prefix > substring > file hit, ties by degree", () => {
    expect(searchNodes(nodes, "alpha").map((n: any) => n.label)).toEqual([
      "alpha",
      "alphabet",
      "beta_alpha",
      "gamma",
    ]);
  });

  it("is case-insensitive, respects the limit, and ignores blanks", () => {
    expect(searchNodes(nodes, "ALPHA", 2)).toHaveLength(2);
    expect(searchNodes(nodes, "  ")).toEqual([]);
    expect(searchNodes(nodes, "zzz")).toEqual([]);
  });
});

describe("force simulation", () => {
  function clusteredGraph() {
    const nodes: any[] = [];
    const edges: any[] = [];
    for (const c of [0, 1]) {
      for (let i = 0; i < 6; i++) nodes.push(node(`c${c}n${i}`, 3, c));
      for (let i = 0; i < 6; i++)
        for (let j = i + 1; j < 6; j++) edges.push(edge(`c${c}n${i}`, `c${c}n${j}`));
    }
    return { nodes, edges };
  }

  function run(sim: any, maxTicks = 5000) {
    let t = 0;
    while (tickSim(sim) && t++ < maxTicks) {
      /* run to settle */
    }
    return t;
  }

  it("settles (alpha cools below the floor) with finite positions", () => {
    const { nodes, edges } = clusteredGraph();
    const sim = createSim(nodes, edges, { seed: 7 });
    run(sim);
    expect(sim.done).toBe(true);
    expect(sim.alpha).toBeLessThan(sim.opts.alphaMin);
    for (const n of sim.nodes) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
  });

  it("pulls connected nodes closer than unconnected ones", () => {
    const { nodes, edges } = clusteredGraph();
    const sim = createSim(nodes, edges, { seed: 7 });
    run(sim);
    const pos = new Map(sim.nodes.map((n: any) => [n.ref.id, n]));
    const dist = (a: string, b: string) => {
      const p = pos.get(a)!;
      const q = pos.get(b)!;
      return Math.hypot(p.x - q.x, p.y - q.y);
    };
    let intra = 0;
    let inter = 0;
    let ni = 0;
    let nj = 0;
    for (let i = 0; i < 6; i++)
      for (let j = i + 1; j < 6; j++) {
        intra += dist(`c0n${i}`, `c0n${j}`) + dist(`c1n${i}`, `c1n${j}`);
        ni += 2;
      }
    for (let i = 0; i < 6; i++)
      for (let j = 0; j < 6; j++) {
        inter += dist(`c0n${i}`, `c1n${j}`);
        nj++;
      }
    expect(intra / ni).toBeLessThan(inter / nj);
  });

  it("is deterministic for a given seed", () => {
    const { nodes, edges } = clusteredGraph();
    const a = createSim(nodes, edges, { seed: 42 });
    const b = createSim(nodes, edges, { seed: 42 });
    run(a);
    run(b);
    for (let i = 0; i < a.nodes.length; i++) {
      expect(a.nodes[i].x).toBe(b.nodes[i].x);
      expect(a.nodes[i].y).toBe(b.nodes[i].y);
    }
  });

  it("survives duplicate/coincident positions and empty input", () => {
    const nodes = Array.from({ length: 5 }, (_, i) => node("n" + i));
    const sim = createSim(nodes, [], { seed: 1 });
    for (const n of sim.nodes) {
      n.x = 1;
      n.y = 1;
    }
    tickSim(sim);
    for (const n of sim.nodes) expect(Number.isFinite(n.x)).toBe(true);

    const empty = createSim([], [], {});
    expect(tickSim(empty)).toBe(false);
  });

  it("quadtree mass equals the node count and bbox contains every node", () => {
    const rng = mulberry32(9);
    const pts = Array.from({ length: 200 }, () => ({ x: rng() * 100 - 50, y: rng() * 80 - 40 }));
    const tree = buildQuadtree(pts as any);
    expect(tree.mass).toBe(200);
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(tree.x0);
      expect(p.y).toBeGreaterThanOrEqual(tree.y0);
      expect(p.x).toBeLessThanOrEqual(tree.x1);
      expect(p.y).toBeLessThanOrEqual(tree.y1);
    }
  });
});
