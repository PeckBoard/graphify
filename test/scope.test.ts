import { describe, expect, it } from "vitest";
import { docStore, hostCalls, setHandlers } from "./fakeHost";
import {
  callerFolder,
  folderEnabled,
  gate,
  repoEnabled,
  repoKey,
  setFolderEnabled,
  setRepoEnabled,
} from "../src/scope";

const FOLDER = "folder-1";

function on(repo = "."): Record<string, unknown> {
  return {
    [`folders/${FOLDER}`]: { folder: FOLDER, enabled: true },
    [`repos/${FOLDER}|${repo}`]: { repo, enabled: true },
  };
}

describe("resolving the caller's folder", () => {
  it("takes it from the MCP tool context, at no host-call cost", () => {
    setHandlers({});
    // Core sends it camelCased; snake_case is tolerated so a rename on either
    // side degrades to a lookup rather than to a blanket refusal.
    expect(callerFolder({ folderId: FOLDER })).toBe(FOLDER);
    expect(callerFolder({ folder_id: FOLDER })).toBe(FOLDER);
    expect(hostCalls).toEqual([]);
  });

  it("asks core for the scope when the call carries no context", () => {
    setHandlers({ peckboard_caller_scope: () => ({ folder_id: FOLDER, authority: true }) });
    // The page's authed routes take this path: there is no tool context there.
    expect(callerFolder()).toBe(FOLDER);
    expect(callerFolder({ folderId: "  " })).toBe(FOLDER);
    expect(hostCalls.map((c) => c.name)).toEqual([
      "peckboard_caller_scope",
      "peckboard_caller_scope",
    ]);
  });

  it("is null when the plugin is in no scope at all", () => {
    setHandlers({ peckboard_caller_scope: () => ({ folder_id: null }) });
    expect(callerFolder()).toBeNull();
    expect(callerFolder({})).toBeNull();
  });

  it("gives up rather than guessing when the host call fails", () => {
    setHandlers({ peckboard_caller_scope: () => ({ error: "no caller context" }) });
    expect(callerFolder()).toBeNull();
  });
});

describe("the switches", () => {
  it("are off until something turns them on", () => {
    const store = docStore();
    setHandlers(store.handlers);
    expect(folderEnabled(FOLDER)).toBe(false);
    expect(repoEnabled(FOLDER, ".")).toBe(false);
  });

  it("round-trip through the store, keyed by folder and repo", () => {
    const store = docStore();
    setHandlers(store.handlers);
    setFolderEnabled(FOLDER, true);
    setRepoEnabled(FOLDER, "apps/api/", true);
    expect(folderEnabled(FOLDER)).toBe(true);
    // The repo path is normalized on the way in, so the key is stable.
    expect(repoEnabled(FOLDER, "apps/api")).toBe(true);
    expect(store.docs[`repos/${FOLDER}|apps/api`]).toMatchObject({
      repo: "apps/api",
      enabled: true,
    });
    // A different folder is untouched: the key carries the folder id because
    // the document store itself is scoped only by plugin.
    expect(repoEnabled("folder-2", "apps/api")).toBe(false);
    expect(repoKey("folder-2", "apps/api")).not.toBe(repoKey(FOLDER, "apps/api"));
  });

  it("keeps a repo's build record when its switch is flipped", () => {
    const store = docStore({ [`repos/${FOLDER}|.`]: { repo: ".", nodes: 42, enabled: true } });
    setHandlers(store.handlers);
    setRepoEnabled(FOLDER, ".", false);
    expect(store.docs[`repos/${FOLDER}|.`]).toMatchObject({ nodes: 42, enabled: false });
  });
});

describe("the gate", () => {
  it("refuses a folder nobody switched on, and names the page", () => {
    setHandlers(docStore().handlers);
    const refusal = gate(FOLDER, ".");
    expect(refusal?.enabled).toBe(false);
    expect(refusal?.error).toContain("switched off for this folder");
    expect(refusal?.next_step).toContain("Graphify page");
  });

  it("refuses a repo that is off inside a folder that is on", () => {
    setHandlers(docStore({ [`folders/${FOLDER}`]: { enabled: true } }).handlers);
    const refusal = gate(FOLDER, "apps/api");
    expect(refusal?.error).toContain("'apps/api' repo");
    expect(refusal?.repo).toBe("apps/api");
  });

  it("fails closed when the folder cannot be resolved", () => {
    // Both switches on for SOME folder must not let an unscoped call through.
    setHandlers(docStore(on()).handlers);
    expect(gate(null, ".")?.error).toContain("could not tell which folder");
  });

  it("lets a call through only when both switches are on", () => {
    setHandlers(docStore(on()).handlers);
    expect(gate(FOLDER, ".")).toBeNull();
    // …and still refuses a sibling repo that was never switched on.
    expect(gate(FOLDER, "apps/api")).not.toBeNull();
  });
});
