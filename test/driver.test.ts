import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_NODES,
  MANUAL_INSTALL_COMMAND,
  PYTHON_DRIVER,
  driverArgv,
  graphJsonPath,
  lastJsonLine,
  parseDriverOutput,
  resolveRepoPath,
  tail,
} from "../src/driver";

function execResult(over: Partial<Record<string, unknown>> = {}): any {
  return {
    exit_code: 0,
    stdout: "",
    stderr: "",
    stdout_truncated: false,
    stderr_truncated: false,
    timed_out: false,
    ...over,
  };
}

describe("repo path jail", () => {
  it("normalizes the ways of saying 'the folder root'", () => {
    for (const input of ["", "   ", ".", "./", "./.", undefined, null, 42]) {
      expect(resolveRepoPath(input as unknown)).toBe(".");
    }
  });

  it("normalizes descending paths, backslashes included", () => {
    expect(resolveRepoPath("peckboard")).toBe("peckboard");
    expect(resolveRepoPath("peck-plugins/graphify/")).toBe("peck-plugins/graphify");
    expect(resolveRepoPath("./a//b/./c")).toBe("a/b/c");
    expect(resolveRepoPath("a\\b")).toBe("a/b");
    expect(resolveRepoPath("a/../b")).toBe("b");
  });

  it("refuses anything that climbs out of the folder", () => {
    for (const escape of ["..", "../", "../etc", "a/../../b", "a/b/../../..", "./../x"]) {
      expect(() => resolveRepoPath(escape), escape).toThrow("escapes the folder root");
    }
  });

  it("refuses absolute paths", () => {
    for (const abs of ["/etc/passwd", "/", "\\\\server\\share", "C:/Windows", "c:\\temp"]) {
      expect(() => resolveRepoPath(abs), abs).toThrow("must be a path relative to the folder root");
    }
  });

  it("keeps the same jail on the argv the driver is handed", () => {
    expect(() => driverArgv({ sub: "summary", repo: "../secrets" })).toThrow(
      "escapes the folder root",
    );
    expect(() => driverArgv({ sub: "build", repo: "/etc", full: false })).toThrow(
      "must be a path relative to the folder root",
    );
    expect(() => driverArgv({ sub: "graph", repo: "a/../../b", maxNodes: 10 })).toThrow(
      "escapes the folder root",
    );
    expect(() =>
      driverArgv({ sub: "path", repo: "..", source: "a", target: "b", maxHops: 8 }),
    ).toThrow("escapes the folder root");
    expect(() => driverArgv({ sub: "explain", repo: "/", label: "x" })).toThrow(
      "must be a path relative to the folder root",
    );
  });

  it("locates a repo's graph.json", () => {
    expect(graphJsonPath(".")).toBe("graphify-out/graph.json");
    expect(graphJsonPath("apps/api/")).toBe("apps/api/graphify-out/graph.json");
    expect(() => graphJsonPath("../x")).toThrow("escapes the folder root");
  });
});

describe("driver argv", () => {
  it("passes the program on -c and the subcommand as the first positional", () => {
    const argv = driverArgv({ sub: "probe" });
    expect(argv[0]).toBe("-c");
    expect(argv[1]).toBe(PYTHON_DRIVER);
    expect(argv.slice(2)).toEqual(["probe"]);
    expect(driverArgv({ sub: "repos" }).slice(2)).toEqual(["repos"]);
  });

  it("builds each subcommand's arguments", () => {
    expect(driverArgv({ sub: "build", repo: "apps/api", full: false }).slice(2)).toEqual([
      "build",
      "apps/api",
    ]);
    expect(driverArgv({ sub: "build", repo: ".", full: true }).slice(2)).toEqual([
      "build",
      ".",
      "--full",
    ]);
    expect(driverArgv({ sub: "summary", repo: "./apps/api" }).slice(2)).toEqual([
      "summary",
      "apps/api",
    ]);
    expect(driverArgv({ sub: "graph", repo: ".", maxNodes: DEFAULT_MAX_NODES }).slice(2)).toEqual([
      "graph",
      ".",
      "--max-nodes",
      "1500",
    ]);
    expect(
      driverArgv({ sub: "path", repo: ".", source: "auth client", target: "db", maxHops: 4 }).slice(
        2,
      ),
    ).toEqual(["path", ".", "auth client", "db", "4"]);
    expect(driverArgv({ sub: "explain", repo: "web", label: "Auth Client" }).slice(2)).toEqual([
      "explain",
      "web",
      "Auth Client",
    ]);
  });

  it("never needs quoting — argv is an array, there is no shell", () => {
    const argv = driverArgv({ sub: "explain", repo: ".", label: "$(rm -rf /); `id`" });
    expect(argv[argv.length - 1]).toBe("$(rm -rf /); `id`");
  });
});

describe("the single-line-JSON stdout contract", () => {
  it("takes the last line that parses as an object, past whatever the library logged", () => {
    const stdout = [
      "loading tree-sitter grammars…",
      "{not json at all}",
      "",
      '{"ok": true, "totals": {"nodes": 3}}',
      "",
    ].join("\n");
    expect(lastJsonLine(stdout)).toBe('{"ok": true, "totals": {"nodes": 3}}');
  });

  it("skips a trailing dict-shaped log line that is not JSON", () => {
    const stdout = '{"ok": true}\n{\'python\': \'repr\'}\n';
    expect(lastJsonLine(stdout)).toBe('{"ok": true}');
  });

  it("returns null when nothing on stdout is a JSON object", () => {
    expect(lastJsonLine("")).toBeNull();
    expect(lastJsonLine("Traceback (most recent call last):\n  File ...")).toBeNull();
    expect(lastJsonLine("[1, 2, 3]")).toBeNull();
  });

  it("parses a result", () => {
    const res = execResult({ stdout: 'noise\n{"ok": true, "repo": "."}\n' });
    expect(parseDriverOutput(res, "summary")).toEqual({ ok: true, repo: "." });
  });

  it("turns the driver's error envelope into a throw", () => {
    const res = execResult({
      stdout: '\n{"error": "ValueError: no graph for . — run graphify_build first"}\n',
    });
    expect(() => parseDriverOutput(res, "summary")).toThrow("run graphify_build first");
  });

  it("reports a timeout as a timeout, not as missing output", () => {
    expect(() => parseDriverOutput(execResult({ timed_out: true }), "build")).toThrow(
      "graphify build timed out",
    );
  });

  it("quotes what the process actually said when there is no result line", () => {
    const res = execResult({
      exit_code: 1,
      stderr: "python3: No module named pip\n",
    });
    expect(() => parseDriverOutput(res, "probe")).toThrow(
      "graphify probe produced no result (exit 1): python3: No module named pip",
    );
  });
});

describe("the Python program", () => {
  it("re-checks the repo jail on its own side", () => {
    expect(PYTHON_DRIVER).toContain("repo path escapes the folder root");
    expect(PYTHON_DRIVER).toContain("candidate.is_absolute()");
    expect(PYTHON_DRIVER).toContain("root not in target.parents");
  });

  it("routes every subcommand the argv builder can produce", () => {
    for (const sub of ["probe", "repos", "build", "summary", "graph", "path", "explain"]) {
      expect(PYTHON_DRIVER, sub).toContain(`"${sub}": cmd_`);
    }
  });

  it("survives the template literal intact — no stray interpolation", () => {
    expect(PYTHON_DRIVER).not.toContain("${");
    expect(PYTHON_DRIVER.startsWith('"""graphify driver')).toBe(true);
    expect(PYTHON_DRIVER.trimEnd().endsWith("main()")).toBe(true);
  });
});

describe("install reporting", () => {
  // The install goes through a private venv, not `pip install --user`: this
  // host's python3 has no pip module at all, and distro pythons that do are
  // usually marked externally-managed, where a --user install is refused.
  it("hands back a command a human can paste", () => {
    expect(MANUAL_INSTALL_COMMAND).toBe(
      "python3 -m venv .graphify-venv && .graphify-venv/bin/python -m pip install graphifyy",
    );
  });

  it("never suggests a --user install, which fails on externally-managed pythons", () => {
    expect(MANUAL_INSTALL_COMMAND).not.toContain("--user");
    expect(MANUAL_INSTALL_COMMAND).toContain("venv");
  });

  it("keeps the tail of a long log — the failure is at the end", () => {
    expect(tail("short", 100)).toBe("short");
    expect(tail(`${"x".repeat(50)}ERROR: boom`, 11)).toBe("…ERROR: boom");
  });
});
