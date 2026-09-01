import { describe, expect, it } from "vitest";
import { manifestJson } from "../src/manifest";
import pkg from "../package.json";

// The registry compares its version against what the LOADED wasm manifest
// reports. If the manifest lags package.json, every upgrade "succeeds" but
// the upgrade-available chip never clears (project-planner 0.3.0 did this).
describe("manifest version source", () => {
  it("matches package.json exactly", () => {
    expect(JSON.parse(manifestJson()).version).toBe(pkg.version);
  });
});
