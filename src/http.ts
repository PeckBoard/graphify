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
  resolveRepoPath,
  runDriver,
} from "./driver";
import {
  folderEnabled,
  callerFolder,
  gate,
  repoEnabled,
  setFolderEnabled,
  setRepoEnabled,
} from "./scope";
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
/// Serve the visualizer page (a project, session, or Folders-page item opens this).
export function serveHttp(payload: any): string {
  if (up(payload?.method) === "GET" && str(payload?.path) === PAGE_PATH) {
    return htmlResponse(200, PAGE);
  }
  return htmlResponse(404, "<!doctype html><title>Not found</title><p>Not found.</p>");
}
/// Authenticated app-UI endpoints under /api/plugin-ui/graphify/*.
///
/// This is the operator's surface, so it is the ONLY place the switches can be
/// flipped: the agent's tools read them and refuse, they never write them.
export function serveAuthed(payload: any): string {
  const method = up(payload?.method);
  const path = str(payload?.path);
  const query = str(payload?.query);
  const body = str(payload?.body);
  // Which folder's page is this? Core resolved it from the page's
  // `x-peckboard-*` header before handing us the request.
  const folderId = callerFolder();

  try {
    if (method === "GET" && path === `${API}/status`) {
      const p = probe();
      return jsonResponse(200, {
        graphify_installed: p.installed,
        python_bin: p.python_bin,
        version: p.version,
        folder_known: folderId !== null,
        folder_enabled: folderEnabled(folderId),
      });
    }
    if (method === "GET" && path === `${API}/repos`) {
      return jsonResponse(200, listRepos(folderId));
    }
    if (method === "POST" && path === `${API}/enable`) {
      return jsonResponse(200, setEnabled(folderId, parseBody(body)));
    }
    if (method === "GET" && path === `${API}/graph`) {
      const repo = queryParam(query, "repo") ?? ".";
      const refusal = gate(folderId, repo);
      return refusal ? jsonResponse(200, refusal) : jsonResponse(200, repoGraph(repo));
    }
    if (method === "POST" && path === `${API}/build`) {
      const b = parseBody(body);
      // Through the tool, so the page and the agent cannot disagree about what
      // a build is allowed to touch.
      return jsonResponse(200, graphifyBuild({ repo: b?.repo, update: b?.update }, { folder_id: folderId }));
    }
    if (method === "POST" && path === `${API}/install`) {
      return jsonResponse(200, installGraphify());
    }
  } catch (e) {
    return jsonResponse(400, { error: errMsg(e) });
  }
  return jsonResponse(404, { error: "not found" });
}

/// Flip one switch. `scope: "folder"` turns graphify on or off for the whole
/// folder; `scope: "repo"` does one repo inside it.
function setEnabled(folderId: string | null, body: any): any {
  if (folderId === null) {
    throw new Error(
      "this page could not be tied to a folder — open Graphify from the Folders page, " +
        "or from a project or session inside the folder",
    );
  }
  const enabled = body?.enabled === true;
  const scope = str(body?.scope) || "folder";
  if (scope === "folder") {
    setFolderEnabled(folderId, enabled);
  } else if (scope === "repo") {
    const repo = resolveRepoPath(body?.repo);
    setRepoEnabled(folderId, repo, enabled);
  } else {
    throw new Error(`unknown scope '${scope}' — expected 'folder' or 'repo'`);
  }
  return { ok: true, scope, folder_enabled: folderEnabled(folderId), ...listRepos(folderId) };
}

/// Every graph target in the folder, each with its switch, plus — for the ones
/// already built — their headline numbers. One driver call: the walk and every
/// summary share a single interpreter start.
///
/// The walk itself is NOT gated: an operator has to see the repos in order to
/// decide which ones to switch on, and listing directory names is not what the
/// switch is protecting.
function listRepos(folderId: string | null): any {
  const payload = runDriver({ sub: "repos" }, QUERY_TIMEOUT_SECS);
  const entries = Array.isArray(payload?.repos) ? payload.repos : [];
  return {
    graphify_installed: payload?.installed === true,
    folder_known: folderId !== null,
    folder_enabled: folderEnabled(folderId),
    repos: entries.map((entry: any) => {
      const summary = summarizeTotals(entry?.has_graph === true ? entry : { totals: {} });
      const path = str(entry?.path) || ".";
      return {
        path,
        name: str(entry?.name) || ".",
        enabled: repoEnabled(folderId, path),
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