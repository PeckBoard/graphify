// Who is calling, and is graphify switched on for them.
//
// Graphify is off everywhere until someone turns it on: a folder carries an
// enabled flag, and inside an enabled folder each repo carries its own. Both
// default to OFF, so installing the plugin changes nothing until an operator
// says where it may run.
//
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

// ── The gate ─────────────────────────────────────────────────────────────────

/// Is this call allowed to touch `repo`? Returns null when it is, or the
/// refusal to hand back when it isn't.
///
/// The refusal is a normal tool result, not a throw: the agent reads it as an
/// instruction, the same way it reads "run graphify_build first". It cannot act
/// on that instruction itself — the switches live on the authed page, under the
/// operator's authority — which is the entire point of having them.
export function gate(folderId: string | null, repo: string): Refusal | null {
  const rel = resolveRepoPath(repo);
  if (folderId === null) {
    return {
      enabled: false,
      repo: rel,
      error: "graphify could not tell which folder this call belongs to",
      next_step:
        "run this from a session inside the folder you want graphed, then enable graphify " +
        "for it on the Graphify page (Folders → the folder's Graphify button)",
    };
  }
  if (!folderEnabled(folderId)) {
    return {
      enabled: false,
      repo: rel,
      error: "graphify is switched off for this folder",
      next_step:
        "open the Graphify page (Folders → the folder's Graphify button) and turn on " +
        `'Graphify in this folder', then switch on the '${rel}' repo`,
    };
  }
  if (!repoEnabled(folderId, rel)) {
    return {
      enabled: false,
      repo: rel,
      error: `graphify is switched off for the '${rel}' repo`,
      next_step:
        "open the Graphify page (Folders → the folder's Graphify button) and switch on " +
        `the '${rel}' repo`,
    };
  }
  return null;
}
