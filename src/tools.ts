// The three MCP tools. Each one validates its arguments against the schema in
// `manifest.ts`, makes sure graphify is installed, runs one driver subcommand,
// and returns a plain object — `lib.ts` wraps a throw into `{error}` for the
// agent, so a failure here reads as a tool result it can act on.

import { errMsg } from "./verdict";
import { storeGet, storePut } from "./host";
import {
  QUERY_TIMEOUT_SECS,
  buildTimeoutSecs,
  ensureGraphify,
  resolveRepoPath,
  runDriver,
} from "./driver";
import { summarizeTotals } from "./graph";

/// Document-store collection holding one record per repo we have built.
const REPOS = "repos";

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
/// good counts in place instead of erasing them.
function recordRepo(repo: string, patch: Partial<RepoRecord>): void {
  const prev = (storeGet(REPOS, repo) as RepoRecord | null) ?? {};
  storePut(REPOS, repo, { ...prev, repo, ...patch });
}

// ── graphify_build ───────────────────────────────────────────────────────────

export function graphifyBuild(args: any): any {
  const repo = resolveRepoPath(args?.repo);
  // `update` defaults to true: reuse graphify's per-file SHA256 cache and
  // re-extract only what changed. `false` means drop the cache first.
  const update = args?.update === undefined || args?.update === null ? true : args.update === true;

  ensureGraphify();
  try {
    const payload = runDriver({ sub: "build", repo, full: !update }, buildTimeoutSecs());
    const summary = summarizeTotals(payload);
    const builtAt = typeof payload?.built_at === "number" ? payload.built_at : Date.now();
    const filesParsed = typeof payload?.files_parsed === "number" ? payload.files_parsed : 0;
    recordRepo(repo, {
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
    recordRepo(repo, { last_error: errMsg(e), last_error_at: Date.now() });
    throw e;
  }
}

// ── graphify_path ────────────────────────────────────────────────────────────

export function graphifyPath(args: any): any {
  const repo = resolveRepoPath(args?.repo);
  const source = requiredString(args, "source");
  const target = requiredString(args, "target");
  const maxHops = boundedInt(args?.max_hops, 8, 1, 32);

  ensureGraphify();
  return withBuildHint(repo, () =>
    runDriver({ sub: "path", repo, source, target, maxHops }, QUERY_TIMEOUT_SECS),
  );
}

// ── graphify_explain ─────────────────────────────────────────────────────────

export function graphifyExplain(args: any): any {
  const repo = resolveRepoPath(args?.repo);
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
