// Hook + tool dispatch. Parses the `{ hook, payload }` envelope and routes each
// call to its handler. The wasm export functions live in `index.ts`.

import { skip, allow, allowUnchanged, cancel, errMsg } from "./verdict";
import { serveHttp, serveAuthed } from "./http";
import { graphifyBuild, graphifyPath, graphifyExplain } from "./tools";
import { syncSessionPrompt } from "./prompt";

/// The three MCP tools, keyed by the name declared in the manifest. Every
/// handler is synchronous: the driver runs through `peckboard_exec`, which
/// blocks in core, so there is no need for the defer protocol ssh-fleet uses.
/// Each takes the caller `context` as its second argument — that is where the
/// folder id comes from, and the folder is what says whether graphify may run
/// at all.
const TOOLS: Record<string, (args: any, context: any) => any> = {
  graphify_build: graphifyBuild,
  graphify_path: graphifyPath,
  graphify_explain: graphifyExplain,
};

export function dispatch(hook: string, payload: any): string {
  switch (hook) {
    case "mcp.tool.invoke":
      return handleInvoke(payload);
    case "http.request.before":
      return serveHttp(payload);
    case "http.request.authed":
      return serveAuthed(payload);
    case "session.message.before":
      return handleMessageBefore(payload);
    default:
      return skip();
  }
}

/// `session.message.before` is used purely as a "this session is about to run"
/// trigger: we sync its graphify system prompt and then let the message through
/// UNCHANGED. Rewriting `text` here would put the hint in the visible user
/// bubble, and a throw would stall the user's turn — so failures degrade to a
/// plain pass-through.
function handleMessageBefore(payload: any): string {
  try {
    syncSessionPrompt(payload);
  } catch (_e) {
    // Best-effort: never block a chat turn because the graph is unreadable.
  }
  return allowUnchanged();
}

function handleInvoke(payload: any): string {
  if (payload === null || payload === undefined || typeof payload !== "object") {
    return cancel("malformed invoke payload: not an object");
  }
  const tool: string = typeof payload.tool === "string" ? payload.tool : "";
  const args = payload.arguments ?? {};
  // Built by core from the verified ToolCallContext (peckboard/src/routes/mcp.rs),
  // so the session/folder a plugin is treated as calling from cannot be forged
  // by the agent.
  const context = payload.context ?? {};

  const fn = TOOLS[tool];
  if (!fn) {
    return cancel(`graphify does not provide tool '${tool}'`);
  }
  try {
    return allow(fn(args, context));
  } catch (e) {
    // A handler error is a normal tool result (the agent sees the message and
    // can correct itself), not a plugin cancel.
    return allow({ error: errMsg(e) });
  }
}
