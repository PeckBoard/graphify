// Shared response helpers: verdict envelopes and small HTTP wrappers. Pure —
// safe to import under vitest without an Extism runtime.

/// A `Verdict::Skip` — this plugin has no opinion, pass through unchanged.
export function skip(): string {
  return JSON.stringify({ verdict: "skip" });
}

/// A `Verdict::Allow` carrying an MCP tool result value.
export function allow(value: unknown): string {
  return JSON.stringify({ verdict: "allow", payload: value });
}

/// A `Verdict::Allow` with no payload — used on `session.message.before`, where
/// this plugin only ever observes. It must never rewrite the message text: the
/// rewritten string becomes the *visible* user event in the transcript
/// (peckboard/src/routes/sessions/dispatch.rs), and the agent hint belongs in
/// the session's system prompt instead.
export function allowUnchanged(): string {
  return JSON.stringify({ verdict: "allow" });
}

/// A `Verdict::Cancel` with a reason (an MCP tool error / refusal).
export function cancel(reason: string): string {
  return JSON.stringify({ verdict: "cancel", reason });
}

/// Wrap a JSON value as a `Verdict::Allow` HTTP response.
export function jsonResponse(status: number, value: unknown): string {
  return JSON.stringify({
    verdict: "allow",
    payload: {
      status,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    },
  });
}

/// Wrap an HTML body as a `Verdict::Allow` HTTP response.
export function htmlResponse(status: number, body: string): string {
  return JSON.stringify({
    verdict: "allow",
    payload: {
      status,
      headers: { "content-type": "text/html; charset=utf-8" },
      body,
    },
  });
}

/// Stringify a caught error to a message string.
export function errMsg(e: unknown): string {
  if (e instanceof Error) {
    return e.message;
  }
  return String(e);
}
