// HTTP surfaces: the served visualizer page (`http.request.before`) and the
// authenticated app-UI endpoints (`http.request.authed`) it reads its data
// from. The page has no same-origin access — it goes through the standard
// parent-proxied fetch bridge — so these routes are the whole contract between
// the two halves of the plugin. Their shapes are fixed; add fields, don't
// rename them.

import { htmlResponse, jsonResponse, errMsg } from "./verdict";
import { PAGE } from "./page";
import {
  DEFAULT_MAX_NODES,
  QUERY_TIMEOUT_SECS,
  installGraphify,
  probe,
  runDriver,
} from "./driver";
import { parseGraph, summarizeTotals, withDegrees, communityList } from "./graph";
import { graphifyBuild } from "./tools";

const PAGE_PATH = "/plugin-api/v1/graphify";
const API = "/api/plugin-ui/graphify";

function up(v: unknown): string {
  return (typeof v === "string" ? v : "").toUpperCase();
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function parseBody(body: string): any {
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch (e) {
    throw new Error("invalid request body: " + errMsg(e));
  }
}

/// Serve the visualizer page (the sidebar item opens this).
export function serveHttp(payload: any): string {
  if (up(payload?.method) === "GET" && str(payload?.path) === PAGE_PATH) {
    return htmlResponse(200, PAGE);
  }
  return htmlResponse(404, "<!doctype html><title>Not found</title><p>Not found.</p>");
}

/// Authenticated app-UI endpoints under /api/plugin-ui/graphify/*.
export function serveAuthed(payload: any): string {
  const method = up(payload?.method);
  const path = str(payload?.path);
  const query = str(payload?.query);
  const body = str(payload?.body);

  try {
    if (method === "GET" && path === `${API}/status`) {
      const p = probe();
      return jsonResponse(200, {
        graphify_installed: p.installed,
        python_bin: p.python_bin,
        version: p.version,
      });
    }
    if (method === "GET" && path === `${API}/repos`) {
      return jsonResponse(200, listRepos());
    }
    if (method === "GET" && path === `${API}/graph`) {
      return jsonResponse(200, repoGraph(queryParam(query, "repo") ?? "."));
    }
    if (method === "POST" && path === `${API}/build`) {
      const b = parseBody(body);
      return jsonResponse(200, graphifyBuild({ repo: b?.repo, update: b?.update }));
    }
    if (method === "POST" && path === `${API}/install`) {
      return jsonResponse(200, installGraphify());
    }
  } catch (e) {
    return jsonResponse(400, { error: errMsg(e) });
  }
  return jsonResponse(404, { error: "not found" });
}

/// Every graph target in the folder plus, for the ones already built, their
/// headline numbers. One driver call: the walk and every summary share a single
/// interpreter start.
function listRepos(): any {
  const payload = runDriver({ sub: "repos" }, QUERY_TIMEOUT_SECS);
  const entries = Array.isArray(payload?.repos) ? payload.repos : [];
  return {
    graphify_installed: payload?.installed === true,
    repos: entries.map((entry: any) => {
      const summary = summarizeTotals(entry?.has_graph === true ? entry : { totals: {} });
      return {
        path: str(entry?.path) || ".",
        name: str(entry?.name) || ".",
        has_graph: entry?.has_graph === true,
        nodes: summary.nodes,
        edges: summary.edges,
        communities: summary.communities,
        built_at: typeof entry?.built_at === "number" ? entry.built_at : null,
        confidence: summary.confidence,
        god_nodes: summary.god_nodes,
      };
    }),
  };
}

/// The drawable graph for one repo. `nodes`/`edges` are capped to the
/// highest-degree slice the 1 MiB stdout budget allows; `stats` always
/// describes the whole graph, so a truncated view never misreports its size.
function repoGraph(repo: string): any {
  const payload = runDriver({ sub: "graph", repo, maxNodes: DEFAULT_MAX_NODES }, QUERY_TIMEOUT_SECS);
  const parsed = withDegrees(parseGraph(payload, repo));
  const summary = summarizeTotals(payload);
  const communities = Array.isArray(payload?.communities)
    ? payload.communities
    : communityList(parsed);
  return {
    repo: str(payload?.repo) || repo,
    nodes: parsed.nodes,
    edges: parsed.edges,
    communities,
    stats: {
      nodes: summary.nodes,
      edges: summary.edges,
      communities: summary.communities,
      confidence: summary.confidence,
    },
    // True when the node/link detail was capped — the page should say so rather
    // than let the drawing pass for the whole graph.
    truncated: payload?.truncated === true,
  };
}

/// Extract and URL-decode `name`'s value from a `&`-separated query string.
export function queryParam(query: string, name: string): string | undefined {
  for (const pair of query.split("&")) {
    const idx = pair.indexOf("=");
    if (idx < 0) continue;
    if (pair.slice(0, idx) !== name) continue;
    const v = pair.slice(idx + 1);
    try {
      return decodeURIComponent(v.replace(/\+/g, "%20"));
    } catch (_e) {
      return v;
    }
  }
  return undefined;
}