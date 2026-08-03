import { describe, expect, it } from "vitest";
import {
  communityList,
  confidenceCounts,
  godNodes,
  nodeDegrees,
  parseGraph,
  parseGraphJson,
  summarize,
  summarizeTotals,
  withDegrees,
} from "../src/graph";

/// A small stand-in for `graphify-out/graph.json`: five nodes over two
/// communities, one edge of each confidence level, and `auth` deliberately the
/// best-connected node.
function fixture() {
  return {
    directed: false,
    multigraph: false,
    nodes: [
      { id: "auth", label: "AuthClient", source_file: "src/auth.py", source_location: "12", community: 0 },
      { id: "login", label: "login()", source_file: "src/auth.py", source_location: "40", community: 0 },
      { id: "token", label: "Token", source_file: "src/token.py", source_location: "3", community: 0 },
      { id: "db", label: "Database", source_file: "src/db.py", source_location: "8", community: 1 },
      { id: "orphan", label: "Unused", source_file: "src/x.py", source_location: "1", community: null },
    ],
    links: [
      { source: "auth", target: "login", relation: "contains", confidence: "EXTRACTED" },
      { source: "auth", target: "token", relation: "uses", confidence: "INFERRED" },
      { source: "auth", target: "db", relation: "calls", confidence: "AMBIGUOUS" },
      { source: "login", target: "token", relation: "uses", confidence: "EXTRACTED" },
    ],
  };
}

describe("parseGraphJson", () => {
  it("reads nodes and edges out of node-link JSON", () => {
    const g = parseGraphJson(JSON.stringify(fixture()), ".");
    expect(g.nodes).toHaveLength(5);
    expect(g.edges).toHaveLength(4);
    expect(g.nodes[0]).toEqual({
      id: "auth",
      label: "AuthClient",
      community: 0,
      source_file: "src/auth.py",
      source_location: "12",
      degree: 0,
    });
    expect(g.edges[2]).toEqual({
      source: "auth",
      target: "db",
      relation: "calls",
      confidence: "AMBIGUOUS",
    });
  });

  it("accepts an `edges` key as well as `links`", () => {
    const data: any = fixture();
    data.edges = data.links;
    delete data.links;
    expect(parseGraphJson(JSON.stringify(data), ".").edges).toHaveLength(4);
  });

  it("tells the caller to build when the file is missing or empty", () => {
    expect(() => parseGraphJson("", "peckboard")).toThrow(
      "no graph for peckboard — run graphify_build first",
    );
    expect(() => parseGraphJson("   ", "peckboard")).toThrow("run graphify_build first");
  });

  it("tells the caller to rebuild when the file is corrupt", () => {
    expect(() => parseGraphJson('{"nodes": [', ".")).toThrow("graph.json is corrupted — rebuild");
    expect(() => parseGraphJson("[1,2,3]", ".")).toThrow("graph.json is corrupted — rebuild");
    expect(() => parseGraphJson('{"links": []}', ".")).toThrow("graph.json is corrupted — rebuild");
  });

  it("survives an empty graph", () => {
    const g = parseGraphJson('{"nodes": [], "links": []}', ".");
    expect(g).toEqual({ nodes: [], edges: [] });
    expect(summarize(g)).toEqual({
      nodes: 0,
      edges: 0,
      communities: 0,
      confidence: { EXTRACTED: 0, INFERRED: 0, AMBIGUOUS: 0 },
      god_nodes: [],
    });
  });

  it("drops entries that cannot be an endpoint, and throws if that empties the graph", () => {
    const g = parseGraphJson(
      '{"nodes": [{"id": "a"}, {"label": "no id"}], "links": [{"source": "a"}, {"source": "a", "target": "a"}]}',
      ".",
    );
    expect(g.nodes.map((n) => n.id)).toEqual(["a"]);
    expect(g.edges).toHaveLength(1);
    expect(() => parseGraph({ nodes: [{ label: "no id" }] }, "repo-x")).toThrow(
      "graph for repo-x has no usable nodes",
    );
  });
});

describe("degrees and god nodes", () => {
  it("counts every endpoint, self-loops twice", () => {
    const g = parseGraphJson(JSON.stringify(fixture()), ".");
    expect(nodeDegrees(g)).toEqual({ auth: 3, login: 2, token: 2, db: 1, orphan: 0 });

    const loop = parseGraphJson(
      '{"nodes": [{"id": "a"}], "links": [{"source": "a", "target": "a"}]}',
      ".",
    );
    expect(nodeDegrees(loop)).toEqual({ a: 2 });
  });

  it("ignores edges pointing outside the node set", () => {
    const g = parseGraphJson(
      '{"nodes": [{"id": "a"}], "links": [{"source": "a", "target": "gone"}]}',
      ".",
    );
    expect(nodeDegrees(g)).toEqual({ a: 1 });
  });

  it("ranks by degree, breaking ties on label so runs agree", () => {
    const g = parseGraphJson(JSON.stringify(fixture()), ".");
    expect(godNodes(g, 3)).toEqual([
      { label: "AuthClient", degree: 3 },
      { label: "Token", degree: 2 },
      { label: "login()", degree: 2 },
    ]);
    expect(godNodes(g, 0)).toEqual([]);
  });

  it("fills degrees in without clobbering the ones the driver supplied", () => {
    const g = parseGraph(
      { nodes: [{ id: "a", degree: 99 }, { id: "b" }], links: [{ source: "a", target: "b" }] },
      ".",
    );
    expect(withDegrees(g).nodes.map((n) => n.degree)).toEqual([99, 1]);
  });
});

describe("confidence and communities", () => {
  it("counts the three levels, defaulting a missing one to EXTRACTED", () => {
    const g = parseGraphJson(JSON.stringify(fixture()), ".");
    expect(confidenceCounts(g)).toEqual({ EXTRACTED: 2, INFERRED: 1, AMBIGUOUS: 1 });

    const bare = parseGraph(
      { nodes: [{ id: "a" }, { id: "b" }], links: [{ source: "a", target: "b" }] },
      ".",
    );
    expect(confidenceCounts(bare)).toEqual({ EXTRACTED: 1, INFERRED: 0, AMBIGUOUS: 0 });
  });

  it("rebuilds communities from the node attribute, largest first", () => {
    const g = parseGraphJson(JSON.stringify(fixture()), ".");
    expect(communityList(g)).toEqual([
      { id: 0, size: 3, label: "Community 0" },
      { id: 1, size: 1, label: "Community 1" },
    ]);
  });
});

describe("summaries", () => {
  it("summarizes a graph held in full", () => {
    expect(summarize(parseGraphJson(JSON.stringify(fixture()), "."), 2)).toEqual({
      nodes: 5,
      edges: 4,
      communities: 2,
      confidence: { EXTRACTED: 2, INFERRED: 1, AMBIGUOUS: 1 },
      god_nodes: [
        { label: "AuthClient", degree: 3 },
        { label: "Token", degree: 2 },
      ],
    });
  });

  it("prefers the driver's whole-graph totals over the capped detail", () => {
    const payload = {
      repo: ".",
      totals: {
        nodes: 4200,
        edges: 9100,
        communities: 17,
        confidence: { EXTRACTED: 8000, INFERRED: 900, AMBIGUOUS: 200 },
      },
      top_nodes: [
        { label: "AuthClient", degree: 311 },
        { label: "Database", degree: 208 },
      ],
      // Only a slice of the graph made it through the 1 MiB stdout cap.
      nodes: [{ id: "auth", label: "AuthClient", degree: 311 }],
      links: [],
      truncated: true,
    };
    expect(summarizeTotals(payload)).toEqual({
      nodes: 4200,
      edges: 9100,
      communities: 17,
      confidence: { EXTRACTED: 8000, INFERRED: 900, AMBIGUOUS: 200 },
      god_nodes: [
        { label: "AuthClient", degree: 311 },
        { label: "Database", degree: 208 },
      ],
    });
  });

  it("zero-fills a payload whose totals are empty", () => {
    expect(summarizeTotals({ totals: {} })).toEqual({
      nodes: 0,
      edges: 0,
      communities: 0,
      confidence: { EXTRACTED: 0, INFERRED: 0, AMBIGUOUS: 0 },
      god_nodes: [],
    });
  });

  it("falls back to counting the detail when there are no totals", () => {
    expect(summarizeTotals(fixture())).toEqual(
      summarize(parseGraphJson(JSON.stringify(fixture()), ".")),
    );
  });
});
