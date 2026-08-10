import { beforeEach, describe, expect, it } from "vitest";
import { graphifyBuild, graphifyExplain, graphifyPath } from "../src/tools";
import { APP_MANAGER_LINK, APP_MANAGER_PAGE, MANUAL_INSTALL_COMMAND } from "../src/driver";

// tools.ts talks to core through the Extism FFI (Host.getFunctions() +
// Memory), so the boundary is faked here rather than the modules under test:
// what matters is what graphifyPath does with a driver payload, and that only
// shows through a real host call.

const memory = new Map<bigint, string>();
let nextOffset = 1n;
let handlers: Record<string, (input: any) => unknown> = {};
let hostCalls: { name: string; input: any }[] = [];

function alloc(text: string): bigint {
  const offset = nextOffset++;
  memory.set(offset, text);
  return offset;
}

(globalThis as any).Memory = {
  fromString: (s: string) => ({ offset: alloc(s) }),
  find: (offset: bigint) => ({ readString: () => memory.get(offset) ?? "" }),
};

(globalThis as any).Host = {
  getFunctions: () =>
    new Proxy(
      {},
      {
        get: (_target, name: string) => (offset: bigint) => {
          const input = JSON.parse(memory.get(offset) ?? "{}");
          hostCalls.push({ name, input });
          return alloc(JSON.stringify(handlers[name] ? handlers[name](input) : {}));
        },
      },
    ),
};

/// One `peckboard_exec` result: the driver's payload as its last stdout line.
function driverStdout(payload: unknown) {
  return {
    exit_code: 0,
    stdout: `import noise\n${JSON.stringify(payload)}\n`,
    stderr: "",
    stdout_truncated: false,
    stderr_truncated: false,
    timed_out: false,
  };
}

const PNG_B64 = "iVBORw0KGgo=";

const FOUND = {
  ok: true,
  repo: ".",
  found: true,
  hops: 1,
  source: "a",
  target: "b",
  steps: [{ from: "a", to: "b", relation: "calls", confidence: "EXTRACTED", source_file: "a.ts" }],
};
const FOLDER = "folder-1";
/// The caller context core hands a tool call.
const CTX = { folder_id: FOLDER };

/// graphify installed, settings at their manifest defaults, the driver
/// answering with `payload`, and a document store seeded with `store`.
function stubHost(
  payload: unknown,
  settings: Record<string, unknown> = {},
  store: Record<string, unknown> = {},
) {
  const key = (c: string, k: string) => `${c}/${k}`;
  const docs: Record<string, unknown> = { ...store };
  handlers = {
    peckboard_get_plugin_setting: ({ key: k }) => ({ value: settings[k] ?? null }),
    peckboard_store_get: ({ collection, key: k }) => ({ value: docs[key(collection, k)] ?? null }),
    peckboard_store_put: ({ collection, key: k, data }) => {
      docs[key(collection, k)] = data;
      return {};
    },
    peckboard_exec: ({ args }) =>
      args[2] === "probe"
        ? driverStdout({ installed: true, version: "0.9.0" })
        : driverStdout(payload),
  };
  return docs;
}

/// Both switches on for `repo` in FOLDER.
function switchedOn(repo = "."): Record<string, unknown> {
  return {
    [`folders/${FOLDER}`]: { folder: FOLDER, enabled: true },
    [`repos/${FOLDER}|${repo}`]: { repo, enabled: true },
  };
}

describe("the folder and repo switches", () => {
  beforeEach(() => {
    hostCalls = [];
  });

  it("refuses every tool when the folder was never switched on", () => {
    for (const call of [
      () => graphifyPath({ source: "a", target: "b" }, CTX),
      () => graphifyExplain({ label: "a" }, CTX),
      () => graphifyBuild({}, CTX),
    ]) {
      stubHost(FOUND);
      const result = call();
      expect(result.enabled).toBe(false);
      expect(result.error).toContain("switched off for this folder");
      expect(result.next_step).toContain("Graphify page");
      // Nothing ran: no probe, no install, no driver.
      expect(hostCalls.filter((c) => c.name === "peckboard_exec")).toEqual([]);
    }
  });

  it("refuses a repo that is off inside a folder that is on", () => {
    stubHost(FOUND, {}, { [`folders/${FOLDER}`]: { folder: FOLDER, enabled: true } });
    const result = graphifyPath({ source: "a", target: "b", repo: "apps/api" }, CTX);
    expect(result.enabled).toBe(false);
    expect(result.error).toContain("'apps/api' repo");
    expect(hostCalls.filter((c) => c.name === "peckboard_exec")).toEqual([]);
  });

  it("refuses a call that carries no folder at all", () => {
    stubHost(FOUND, {}, switchedOn());
    const result = graphifyPath({ source: "a", target: "b" }, {});
    expect(result.enabled).toBe(false);
    expect(result.error).toContain("could not tell which folder");
  });

  it("runs once both switches are on", () => {
    stubHost(FOUND, {}, switchedOn());
    expect(graphifyPath({ source: "a", target: "b" }, CTX).steps).toEqual(FOUND.steps);
  });

  it("keys build records by folder, so two folders cannot overwrite each other", () => {
    const docs = stubHost({ totals: { nodes: 3, edges: 2, communities: 1 } }, {}, switchedOn());
    graphifyBuild({}, CTX);
    expect((docs[`repos/${FOLDER}|.`] as any).nodes).toBe(3);
    // The old un-scoped key stays untouched.
    expect(docs["repos/."]).toBeUndefined();
  });
});

describe("graphify_path diagram", () => {
  beforeEach(() => {
    hostCalls = [];
  });

  it("hands the rendered path to core as an image, not as JSON noise", () => {
    stubHost({ ...FOUND, image_base64: PNG_B64 }, {}, switchedOn());
    const result = graphifyPath({ source: "a", target: "b" }, CTX);
    expect(result._image_base64).toBe(PNG_B64);
    expect(result._image_mime).toBe("image/png");
    expect(result.image_base64).toBeUndefined();
    // The answer itself is untouched.
    expect(result.steps).toEqual(FOUND.steps);
    expect(result.hops).toBe(1);
  });

  it("drops the image when the setting is off", () => {
    stubHost({ ...FOUND, image_base64: PNG_B64 }, { path_image: false }, switchedOn());
    const result = graphifyPath({ source: "a", target: "b" }, CTX);
    expect(result._image_base64).toBeUndefined();
    expect(result.image_base64).toBeUndefined();
    expect(result.steps).toEqual(FOUND.steps);
  });

  it("passes a path-less answer through unchanged", () => {
    const missing = { ok: true, repo: ".", found: false, message: "no node matching source 'a'" };
    stubHost(missing, {}, switchedOn());
    const result = graphifyPath({ source: "a", target: "b" }, CTX);
    expect(result).toEqual(missing);
    expect(result._image_base64).toBeUndefined();
  });

  it("still refuses a repo that climbs out of the folder", () => {
    stubHost({ ...FOUND, image_base64: PNG_B64 }, {}, switchedOn());
    expect(() => graphifyPath({ source: "a", target: "b", repo: "../etc" }, CTX)).toThrow(
      "escapes the folder root",
    );
  });
});

describe("the App Manager handoff when graphify is missing", () => {
  beforeEach(() => {
    hostCalls = [];
  });

  /// graphify NOT importable, both switches on, settings as given. `execImpl`
  /// overrides the driver exec (argv: ["-c", DRIVER, sub, ...]).
  function stubMissing(
    settings: Record<string, unknown> = {},
    execImpl?: (args: string[]) => unknown,
  ) {
    const docs: Record<string, unknown> = { ...switchedOn() };
    handlers = {
      peckboard_get_plugin_setting: ({ key: k }) => ({ value: settings[k] ?? null }),
      peckboard_store_get: ({ collection, key: k }) => ({
        value: docs[`${collection}/${k}`] ?? null,
      }),
      peckboard_store_put: ({ collection, key: k, data }) => {
        docs[`${collection}/${k}`] = data;
        return {};
      },
      peckboard_exec: ({ args }) =>
        execImpl
          ? execImpl(args)
          : args[2] === "probe"
            ? driverStdout({ installed: false, version: null })
            : driverStdout({ ok: true }),
    };
  }

  it("every tool returns the structured handoff — and installs nothing — by default", () => {
    for (const call of [
      () => graphifyBuild({}, CTX),
      () => graphifyPath({ source: "a", target: "b" }, CTX),
      () => graphifyExplain({ label: "x" }, CTX),
    ]) {
      stubMissing();
      hostCalls = [];
      const result = call();
      expect(result.installed).toBe(false);
      expect(result.error).toContain("graphify is not installed");
      // Actionable: names the App Manager page, what to install there, and
      // the manual fallback.
      expect(result.next_step).toContain(APP_MANAGER_PAGE);
      expect(result.next_step).toContain(MANUAL_INSTALL_COMMAND);
      expect(result.app_manager.page).toBe(APP_MANAGER_LINK);
      // The link prefills the App Manager's request bar; it cannot install.
      expect(APP_MANAGER_LINK).toBe(
        `${APP_MANAGER_PAGE}?install=python3,pip,graphifyy&from=graphify`,
      );
      expect(result.app_manager.install).toEqual(["python3", "pip", "graphifyy"]);
      // Honest wording: a handoff, never an auto-install.
      expect(result.app_manager.note).toContain("cannot invoke");
      // auto_install defaults OFF: the probe ran, the install subcommand
      // (which would create .graphify-venv) did not.
      const subs = hostCalls
        .filter((c) => c.name === "peckboard_exec")
        .map((c) => c.input.args[2]);
      expect(subs).toEqual(["probe"]);
    }
  });

  it("self-installs only when auto_install is explicitly on (legacy path)", () => {
    let installed = false;
    stubMissing({ auto_install: true }, (args) => {
      if (args[2] === "probe") {
        return driverStdout({ installed, version: installed ? "0.9.0" : null });
      }
      if (args[2] === "install") {
        installed = true;
        return driverStdout({ ok: true, installed: true, version: "0.9.0", exit_code: 0, output: "ok" });
      }
      return driverStdout({ totals: { nodes: 1, edges: 0, communities: 1 } });
    });
    const result = graphifyBuild({}, CTX);
    expect(result.nodes).toBe(1);
    const subs = hostCalls
      .filter((c) => c.name === "peckboard_exec")
      .map((c) => c.input.args[2]);
    expect(subs).toContain("install");
  });
});