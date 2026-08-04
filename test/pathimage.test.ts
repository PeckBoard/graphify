import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { PYTHON_DRIVER } from "../src/driver";
import { PATH_IMAGE_PY } from "../src/pathimage";

/// Run the renderer's Python source with a harness appended, and return what
/// the harness printed. The module is standard-library-only by design, so this
/// needs no venv and no graphify.
function runPython(harness: string): string {
  const res = spawnSync("python3", ["-c", `${PATH_IMAGE_PY}\n${harness}`], {
    encoding: "utf8",
  });
  if (res.error) throw res.error;
  expect(res.status, `python3 failed: ${res.stderr}`).toBe(0);
  return res.stdout.trim();
}

/// Render a payload and hand back the PNG bytes.
function render(payload: unknown): Buffer {
  const out = runPython(
    `import json\nprint(render_path_base64(json.loads(${JSON.stringify(JSON.stringify(payload))})) or "")`,
  );
  return Buffer.from(out, "base64");
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/// Width/height out of the IHDR chunk, which always starts at byte 16.
function dimensions(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function step(from: string, to: string, over: Record<string, string> = {}) {
  return {
    from,
    to,
    relation: "calls",
    confidence: "EXTRACTED",
    source_file: "src/thing.rs",
    ...over,
  };
}

const THREE_HOPS = {
  ok: true,
  repo: "peckboard",
  found: true,
  hops: 3,
  source: "graphifyPath",
  target: "ToolUseBlock",
  steps: [
    step("graphifyPath", "runDriver"),
    step("runDriver", "peckboard_exec", { relation: "invokes", confidence: "INFERRED" }),
    step("peckboard_exec", "ToolUseBlock", { relation: "renders", confidence: "AMBIGUOUS" }),
  ],
};

/// Layout constants mirrored from src/pathimage.ts.
const WIDTH = 1050;
const ROW_TOP = 96;
const ROW_H = 250;
const DOWN_DY = 175;
const BOTTOM_PAD = 112;
const rowsHigh = (rows: number) => ROW_TOP + (rows - 1) * ROW_H + DOWN_DY + BOTTOM_PAD;

describe("path diagram renderer", () => {
  it("draws a real PNG, one serpentine row per five nodes", () => {
    const png = render(THREE_HOPS);
    expect(png.subarray(0, 8)).toEqual(PNG_MAGIC);
    // 4 nodes → a single row.
    expect(dimensions(png)).toEqual({ width: WIDTH, height: rowsHigh(1) });
    // The image rides back inside the driver's JSON payload, which
    // `peckboard_exec` caps at 1 MiB — antialiasing costs compression, so
    // this is the assertion that keeps the budget honest.
    expect(png.length).toBeLessThan(128 * 1024);
  });

  it("is byte-for-byte deterministic", () => {
    // Including the decorative field, which is laid out by a seeded LCG.
    expect(render(THREE_HOPS).equals(render(THREE_HOPS))).toBe(true);
  });

  it("varies the decorative field with the query", () => {
    const other = render({ ...THREE_HOPS, repo: "somewhere-else" });
    expect(render(THREE_HOPS).equals(other)).toBe(false);
  });

  it("renders a single hop", () => {
    const png = render({ ...THREE_HOPS, hops: 1, steps: [step("a", "b")] });
    expect(dimensions(png)).toEqual({ width: WIDTH, height: rowsHigh(1) });
  });

  it("caps a long path instead of drawing a 20-row constellation", () => {
    const steps = Array.from({ length: 32 }, (_, i) => step(`n${i}`, `n${i + 1}`));
    const png = render({ ...THREE_HOPS, hops: 32, steps });
    // 14 nodes drawn at 5 a row, and the footer states what was dropped.
    expect(dimensions(png)).toEqual({ width: WIDTH, height: rowsHigh(3) });
  });

  it("survives long, empty, and non-ASCII labels", () => {
    const png = render({
      ...THREE_HOPS,
      source: "x".repeat(400),
      target: "",
      steps: [
        step("x".repeat(400), "café ☕", { relation: "", confidence: "", source_file: "" }),
        step("café ☕", "", { relation: "y".repeat(300), confidence: "WEIRD" }),
      ],
    });
    expect(png.subarray(0, 8)).toEqual(PNG_MAGIC);
  });

  it("declines to draw a result with no hops", () => {
    expect(runPython(`print(render_path_base64({"steps": []}) or "")`)).toBe("");
    expect(runPython(`print(render_path_base64({}) or "")`)).toBe("");
  });

describe("the renderer inside the driver", () => {
  it("is embedded, and the driver still parses as Python", () => {
    expect(PYTHON_DRIVER).toContain("def render_path_base64(");
    const res = spawnSync("python3", ["-c", "import ast, sys; ast.parse(sys.stdin.read())"], {
      input: PYTHON_DRIVER,
      encoding: "utf8",
    });
    expect(res.status, res.stderr).toBe(0);
  });
});
});
