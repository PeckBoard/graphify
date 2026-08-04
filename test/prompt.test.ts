import { describe, expect, it } from "vitest";
import { docStore, hostCalls, setHandlers } from "./fakeHost";
import { composePrompt, hashBlock, syncSessionPrompt } from "../src/prompt";

const STATS = { nodes: 412, edges: 903, communities: 11 };

describe("composePrompt", () => {
  it("names the graph, its size, and all three tools", () => {
    const block = composePrompt(STATS, true);
    expect(block).toContain("412 nodes, 903 edges, 11 communities");
    expect(block).toContain("graphify-out/graph.json");
    for (const tool of ["graphify_explain", "graphify_path", "graphify_build"]) {
      expect(block, tool).toContain(tool);
    }
  });

  it("says what the graph is not, and where the multimodal pass lives", () => {
    const block = composePrompt(STATS, true);
    expect(block).toContain("code-only");
    expect(block).toContain("/graphify");
    // The agent has to know when reading files still wins.
    expect(block).toContain("exact text");
  });

  it("stays far under the 2000-char budget it is charged every turn", () => {
    for (const block of [
      composePrompt(STATS, true),
      composePrompt(null, true),
      composePrompt(null, false),
    ]) {
      expect(block.length).toBeLessThan(2000);
    }
  });

  it("drops the counts rather than lying when they are unknown", () => {
    const block = composePrompt(null, true);
    expect(block).toContain("has a graphify knowledge graph at");
    expect(block).not.toContain("nodes,");
    expect(block).toContain("graphify_explain");
  });

  it("tells the agent to build one when there is no graph", () => {
    const block = composePrompt(null, false);
    expect(block).toContain("no graphify knowledge graph yet");
    expect(block).toContain("graphify_build");
    expect(block).not.toContain("Query it instead of grepping");
  });
});

describe("hashBlock", () => {
  it("is stable for the same text and different for different text", () => {
    const a = composePrompt(STATS, true);
    expect(hashBlock(a)).toBe(hashBlock(composePrompt({ ...STATS }, true)));
    expect(hashBlock(a)).not.toBe(hashBlock(composePrompt({ ...STATS, nodes: 413 }, true)));
    expect(hashBlock(a)).not.toBe(hashBlock(composePrompt(null, false)));
  });

  it("is a fixed-width hex digest, empty string included", () => {
    for (const text of ["", "a", composePrompt(STATS, true)]) {
      expect(hashBlock(text)).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  it("notices a one-character change — the point is skipping the host call", () => {
    expect(hashBlock("graphify")).not.toBe(hashBlock("graphifY"));
  });
});

const FOLDER = "folder-1";

/// The store + host functions syncSessionPrompt leans on: the session lookup
/// that resolves the folder, and a folder-root graph that does exist.
function stub(seed: Record<string, unknown> = {}) {
  const store = docStore(seed);
  setHandlers({
    ...store.handlers,
    peckboard_caller_scope: () => ({ folder_id: FOLDER, authority: false }),
    peckboard_read_file: () => ({ content: '{"nodes":[{"id":"a"}],"links":[]}' }),
    peckboard_get_plugin_setting: () => ({ value: null }),
    peckboard_set_session_system_prompt: () => ({}),
  });
  return store;
}

function promptWrites() {
  return hostCalls.filter((c) => c.name === "peckboard_set_session_system_prompt");
}

describe("syncSessionPrompt and the switches", () => {
  it("says nothing to a session whose folder is switched off", () => {
    stub();
    syncSessionPrompt({ session_id: "s1" });
    // Nothing of ours was ever set, so there is nothing to clear either.
    expect(promptWrites()).toEqual([]);
  });

  it("says nothing when the folder is on but its root repo is not", () => {
    stub({ [`folders/${FOLDER}`]: { enabled: true } });
    syncSessionPrompt({ session_id: "s1" });
    expect(promptWrites()).toEqual([]);
  });

  it("describes the graph once both switches are on", () => {
    stub({
      [`folders/${FOLDER}`]: { enabled: true },
      [`repos/${FOLDER}|.`]: { repo: ".", enabled: true },
    });
    syncSessionPrompt({ session_id: "s1" });
    const writes = promptWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0].input.system_prompt).toContain("graphify_path");
  });

  it("takes its block back off when a folder is switched off again", () => {
    stub({ ["session_prompt/s1"]: { hash: "deadbeef" } });
    syncSessionPrompt({ session_id: "s1" });
    const writes = promptWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0].input.system_prompt).toBeUndefined(); // cleared
  });
});
