// FFI layer: the Peckboard core host functions this plugin calls, and the
// host_call marshaling helper. Host calls are kept LAZY (inside functions) so
// the pure modules load under vitest without an Extism runtime.

type HostFn = (offset: bigint) => bigint;

/// Call a host function and parse its JSON response, surfacing an
/// `{"error": ...}` envelope (or a trap) as a thrown Error.
export function hostCall(name: string, input: unknown): any {
  const f = (Host.getFunctions() as Record<string, HostFn>)[name];
  const mem = Memory.fromString(JSON.stringify(input));
  const out = f(mem.offset);
  const parsed = JSON.parse(Memory.find(out).readString());
  if (parsed && parsed.error !== undefined && parsed.error !== null) {
    throw new Error(String(parsed.error));
  }
  return parsed;
}

// ── Settings ────────────────────────────────────────────────────────────────

export function getSetting(key: string): any {
  const result = hostCall("peckboard_get_plugin_setting", { key });
  return result?.value ?? null;
}

// ── Plugin document store (data_store permission) ────────────────────────────

export function storePut(collection: string, key: string, data: unknown): void {
  hostCall("peckboard_store_put", { collection, key, data });
}

export function storeGet(collection: string, key: string): any {
  const result = hostCall("peckboard_store_get", { collection, key });
  return result?.value ?? null;
}

export function storeList(collection: string): Array<{ key: string; value: any }> {
  const result = hostCall("peckboard_store_list", { collection });
  return result?.items ?? [];
}

export function storeDelete(collection: string, key: string): void {
  hostCall("peckboard_store_delete", { collection, key });
}

// ── Command execution (process_exec permission) ──────────────────────────────

export interface ExecResult {
  exit_code: number | null;
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  timed_out: boolean;
}

/// Run an allowlisted command in the caller's folder. `command` must be a bare
/// executable name — args are an argv array, never a shell string, so there is
/// no shell to interpret metacharacters. cwd is pinned by core to the caller's
/// folder root; anything repo-scoped is addressed by a relative path argument
/// the driver re-validates. Output is capped at 1 MiB per stream and the child
/// is killed past `timeout_secs` (core clamps to 600).
export function exec(command: string, args: string[], timeoutSecs?: number): ExecResult {
  const input: Record<string, unknown> = { command, args };
  if (typeof timeoutSecs === "number") {
    input.timeout_secs = timeoutSecs;
  }
  return hostCall("peckboard_exec", input) as ExecResult;
}

// ── Project files (project_files_read permission) ────────────────────────────

/// Read one UTF-8 text file under the caller's folder. Throws if it is missing
/// or escapes the folder jail.
export function readFile(path: string): string {
  const result = hostCall("peckboard_read_file", { path });
  return typeof result?.content === "string" ? result.content : "";
}

// ── Sessions (session_read / session_prompt_write permissions) ───────────────

/// Read a session this plugin may see.
export function getSession(sessionId: string): any {
  const result = hostCall("peckboard_get_session", { session_id: sessionId });
  return result?.session ?? null;
}

/// The folder/project/session this call is running in, as core resolved it:
/// the verified MCP invocation scope, or the scope of the authenticated page
/// request. `{folder_id: null}` when the plugin is in neither (init, a public
/// request) — which the switches read as "disabled".
export function callerScope(): {
  folder_id: string | null;
  project_id: string | null;
  session_id: string | null;
  authority: boolean;
} {
  return hostCall("peckboard_caller_scope", {});
}
/// is appended AFTER the standing Peckboard prompt, and takes effect on the
/// session's next agent run — core reads `session.system_prompt` at every
/// dispatch (peckboard/src/provider/manager.rs).
export function setSessionSystemPrompt(sessionId: string, prompt: string | null): void {
  const input: Record<string, unknown> = { session_id: sessionId };
  if (prompt !== null) {
    input.system_prompt = prompt;
  }
  hostCall("peckboard_set_session_system_prompt", input);
}
