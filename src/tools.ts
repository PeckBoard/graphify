// The three MCP tools. Each one checks that graphify is switched on for the
// caller's folder and repo, validates its arguments against the schema in
// `manifest.ts`, makes sure graphify is installed, runs one driver subcommand,
// and returns a plain object — `lib.ts` wraps a throw into `{error}` for the
// agent, so a failure here reads as a tool result it can act on.
//
// The gate comes FIRST, before argument validation and before `ensureGraphify`:
// a folder nobody switched on must not so much as trigger a pip install.

import { errMsg } from "./verdict";
import { storeGet, storePut } from "./host";
import {
  QUERY_TIMEOUT_SECS,
  buildTimeoutSecs,
  ensureGraphify,
  pathImageEnabled,
  resolveRepoPath,
  runDriver,
} from "./driver";
import { REPOS, callerFolder, gate, repoKey } from "./scope";
import { summarizeTotals } from "./graph";

/// What a query tool says when there is no graph yet. The driver raises the
/// same sentence, so the agent gets one consistent instruction either way.
const NEEDS_BUILD = "run graphify_build first";

export interface RepoRecord {
  repo: string;
  nodes?: number;
  edges?: number;
  communities?: number;
  built_at?: number | null;
  files_parsed?: number;
  last_error?: string | null;
  last_error_at?: number | null;
}

function requiredString(args: any, key: string): string {
  const v = args?.[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw new Error(`'${key}' is required and must be a non-empty string`);
  }
  return v.trim();
}

function boundedInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/// Merge a patch into a repo's build record, so a failed run leaves the last
/// good counts in place instead of erasing them. Keyed by folder AND repo:
/// the store is plugin-scoped, so two folders that each have a `.` repo would
/// otherwise overwrite each other's counts.
function recordRepo(folderId: string, repo: string, patch: Partial<RepoRecord>): void {
  const key = repoKey(folderId, repo);
  const prev = (storeGet(REPOS, key) as RepoRecord | null) ?? {};
  storePut(REPOS, key, { ...prev, repo, ...patch });
}

// ── graphify_build ───────────────────────────────────────────────────────────

export function graphifyBuild(args: any, context?: any): any {
  const repo = resolveRepoPath(args?.repo);
  const folderId = callerFolder(context);
  const refusal = gate(folderId, repo);
  if (refusal) return refusal;
  // `update` defaults to true: reuse graphify's per-file SHA256 cache and
  // re-extract only what changed. `false` means drop the cache first.
  const update = args?.update === undefined || args?.update === null ? true : args.update === true;

  ensureGraphify();
  try {
    const payload = runDriver({ sub: "build", repo, full: !update }, buildTimeoutSecs());
    const summary = summarizeTotals(payload);
    const builtAt = typeof payload?.built_at === "number" ? payload.built_at : Date.now();
    const filesParsed = typeof payload?.files_parsed === "number" ? payload.files_parsed : 0;
    recordRepo(folderId as string, repo, {
      nodes: summary.nodes,
      edges: summary.edges,
      communities: summary.communities,
      files_parsed: filesParsed,
      built_at: builtAt,
      last_error: null,
      last_error_at: null,
    });
    return {
      repo,
      ...summary,
      files_parsed: filesParsed,
      full_rebuild: payload?.full_rebuild === true,
      graph: joinRepo(repo, "graphify-out/graph.json"),
      report: joinRepo(repo, "graphify-out/GRAPH_REPORT.md"),
    };
  } catch (e) {
    recordRepo(folderId as string, repo, { last_error: errMsg(e), last_error_at: Date.now() });
    throw e;
  }
}

// ── graphify_path ────────────────────────────────────────────────────────────

export function graphifyPath(args: any, context?: any): any {
  const repo = resolveRepoPath(args?.repo);
  const refusal = gate(callerFolder(context), repo);
  if (refusal) return refusal;
  const source = requiredString(args, "source");
  const target = requiredString(args, "target");
  const maxHops = boundedInt(args?.max_hops, 8, 1, 32);

  ensureGraphify();
  const result = withBuildHint(repo, () =>
    runDriver({ sub: "path", repo, source, target, maxHops }, QUERY_TIMEOUT_SECS),
  );
  return withPathImage(result);
}

/// Move the driver's rendered diagram onto core's tool-image convention:
/// `_image_base64` (+ `_image_mime`) is stripped from the result by
/// peckboard/src/routes/mcp.rs and re-emitted as an MCP image content block, so
/// the chat shows the path and a vision model sees it. The raw field is dropped
/// either way — a base64 blob in the text block would be pure noise.
function withPathImage(result: any): any {
  if (!result || typeof result !== "object") return result;
  const { image_base64: image, ...rest } = result as Record<string, unknown>;
  if (typeof image !== "string" || image === "" || !pathImageEnabled()) return rest;
  return { ...rest, _image_base64: image, _image_mime: "image/png" };
}

// ── graphify_explain ─────────────────────────────────────────────────────────

export function graphifyExplain(args: any, context?: any): any {
  const repo = resolveRepoPath(args?.repo);
  const refusal = gate(callerFolder(context), repo);
  if (refusal) return refusal;
  const label = requiredString(args, "label");

  ensureGraphify();
  return withBuildHint(repo, () => runDriver({ sub: "explain", repo, label }, QUERY_TIMEOUT_SECS));
}

// ── Shared ───────────────────────────────────────────────────────────────────

/// Run a query and, when it fails because the repo has no graph, answer with an
/// instruction the agent can act on rather than a bare filesystem complaint.
function withBuildHint(repo: string, run: () => any): any {
  try {
    return run();
  } catch (e) {
    const message = errMsg(e);
    if (message.indexOf(NEEDS_BUILD) >= 0 || message.indexOf("no graph for") >= 0) {
      return {
        repo,
        found: false,
        error: `no graphify knowledge graph for '${repo}' yet`,
        next_step: `call graphify_build with repo='${repo}', then retry this query`,
      };
    }
    throw e;
  }
}

function joinRepo(repo: string, rel: string): string {
  return repo === "." ? rel : `${repo}/${rel}`;
}
