// Who is calling, and is graphify switched on for them.
//
// A folder carries an enabled flag, and inside an enabled folder each repo
// carries its own. Both default to OFF, so installing the plugin runs nothing
// on its own — but a session can switch them on: `graphify_build` flips both
// switches for the caller's folder and repo before it builds (see
// `switchOn`). The query tools still refuse until then, and their refusal
// tells the agent to call `graphify_build`.
// The state lives in the plugin document store, which core scopes by PLUGIN
// only (`peckboard_store_put` → `store_put_impl(&db, &plugin_id, …)`) — there
// is no per-folder partition. So the folder id has to be part of the key, and
// the caller's folder has to be resolved on every entry point. Core already
// knows it in all of them — the verified MCP invocation scope, or the scope it
// resolves for an authed page request — and `peckboard_caller_scope` is the one
// host call that reports it. The alternatives don't cover the page: the tool
// context is absent there, and `peckboard_get_session` is invocation-only AND
// ownership-gated, so a plugin serving its own UI cannot look a session up.
//
// A caller whose folder cannot be resolved is treated as DISABLED. Failing
// closed matters here: the alternative is a build running somewhere nobody
// asked for one.

import { callerScope, storeGet, storePut } from "./host";
import { resolveRepoPath } from "./driver";

/// Document-store collections. `folders` is keyed by folder id; `repos` by
/// `<folder id>|<repo path>` — the repo path alone would collide between two
/// folders that each have a `.` repo.
export const FOLDERS = "folders";
export const REPOS = "repos";

export interface FolderRecord {
  folder: string;
  enabled: boolean;
  at?: number;
}

export interface Refusal {
  enabled: false;
  repo: string;
  error: string;
  next_step: string;
}

// ── Resolving the caller's folder ────────────────────────────────────────────

function nonEmpty(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/// The folder this call is running in, whatever kind of call it is.
///
/// An MCP tool invocation carries its own verified context (camelCased by
/// core), which costs nothing to read; everything else — the page's authed
/// routes above all — asks core what scope it landed. Null means "nowhere in
/// particular", which the gate reads as disabled.
export function callerFolder(context?: any): string | null {
  const fromContext = nonEmpty(context?.folderId) ?? nonEmpty(context?.folder_id);
  if (fromContext !== null) return fromContext;
  try {
    return nonEmpty(callerScope()?.folder_id);
  } catch (_e) {
    return null;
  }
}

// ── Reading and writing the switches ─────────────────────────────────────────

export function repoKey(folderId: string, repo: string): string {
  return `${folderId}|${resolveRepoPath(repo)}`;
}

export function folderEnabled(folderId: string | null): boolean {
  if (folderId === null) return false;
  return (storeGet(FOLDERS, folderId) as FolderRecord | null)?.enabled === true;
}

export function setFolderEnabled(folderId: string, enabled: boolean): void {
  storePut(FOLDERS, folderId, { folder: folderId, enabled, at: Date.now() });
}

export function repoEnabled(folderId: string | null, repo: string): boolean {
  if (folderId === null) return false;
  return storeGet(REPOS, repoKey(folderId, repo))?.enabled === true;
}
/// Flip one repo's switch, keeping whatever build record it already carries.
export function setRepoEnabled(folderId: string, repo: string, enabled: boolean): void {
  const rel = resolveRepoPath(repo);
  const key = repoKey(folderId, rel);
  const prev = storeGet(REPOS, key) ?? {};
  storePut(REPOS, key, { ...prev, repo: rel, enabled, enabled_at: Date.now() });
}

/// Switch graphify on for `repo` and its folder — what `graphify_build` does
/// when a session asks for a graph somewhere nobody enabled yet. Returns
/// whether anything actually changed.
export function switchOn(folderId: string, repo: string): boolean {
  let changed = false;
  if (!folderEnabled(folderId)) {
    setFolderEnabled(folderId, true);
    changed = true;
  }
  if (!repoEnabled(folderId, repo)) {
    setRepoEnabled(folderId, repo, true);
    changed = true;
  }
  return changed;
}

// ── The gate ─────────────────────────────────────────────────────────────────

/// Is this call allowed to touch `repo`? Returns null when it is, or the
/// refusal to hand back when it isn't.
///
/// The refusal is a normal tool result, not a throw: the agent reads it as an
/// instruction, the same way it reads "run graphify_build first" — and a
/// switched-off folder or repo is one `graphify_build` call away from on.
export function gate(folderId: string | null, repo: string): Refusal | null {
  const rel = resolveRepoPath(repo);
  if (folderId === null) {
    return {
      enabled: false,
      repo: rel,
      error: "graphify could not tell which folder this call belongs to",
      next_step:
        "run this from a session inside the folder you want graphed, then call graphify_build",
    };
  }
  if (!folderEnabled(folderId)) {
    return {
      enabled: false,
      repo: rel,
      error: "graphify is switched off for this folder",
      next_step:
        `call graphify_build with repo='${rel}' — it switches graphify on for this folder and ` +
        "builds the graph — then retry this query",
    };
  }
  if (!repoEnabled(folderId, rel)) {
    return {
      enabled: false,
      repo: rel,
      error: `graphify is switched off for the '${rel}' repo`,
      next_step:
        `call graphify_build with repo='${rel}' — it switches the repo on and builds its ` +
        "graph — then retry this query",
    };
  }
  return null;
}
