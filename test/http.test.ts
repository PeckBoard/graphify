import { describe, expect, it } from "vitest";
import { docStore, driverStdout, setHandlers } from "./fakeHost";
import { queryParam, serveAuthed } from "../src/http";
import { manifestJson } from "../src/manifest";

const API = "/api/plugin-ui/graphify";
const FOLDER = "folder-1";
// Core resolves the page's folder from its `x-peckboard-*` header before the
// plugin is called; `peckboard_caller_scope` is how the plugin reads it back.
const HEADERS = { "x-peckboard-session-id": "s1" };

/// Call an authed route and hand back the decoded JSON body.
function call(method: string, path: string, over: Record<string, unknown> = {}): any {
  const verdict = JSON.parse(
    serveAuthed({ method, path, query: "", body: "", headers: HEADERS, ...over }),
  );
  return JSON.parse(verdict.payload.body);
}

/// A store plus the host functions the routes lean on: the session lookup that
/// resolves the folder, and a driver that reports two repos.
function stub(seed: Record<string, unknown> = {}) {
  const store = docStore(seed);
  setHandlers({
    ...store.handlers,
    peckboard_caller_scope: () => ({ folder_id: FOLDER, authority: true }),
    peckboard_exec: () =>
      driverStdout({
        installed: true,
        repos: [
          { path: ".", name: "root", has_graph: false },
          { path: "apps/api", name: "api", has_graph: false },
        ],
      }),
  });
  return store;
}

describe("the manifest's page surfaces", () => {
  const m = JSON.parse(manifestJson());

  it("offers the page from a project, a session, AND a Folders page row", () => {
    for (const key of ["project_items", "session_items", "folder_items"]) {
      expect(m[key], key).toHaveLength(1);
      expect(m[key][0].id).toBe("graphify");
      expect(m[key][0].label).toBe("Graphify");
      // One page, three ways in — the switches are keyed by folder id, so all
      // three read back the same state.
      expect(m[key][0].path).toBe("/plugin-api/v1/graphify");
      expect(m[key][0].icon).toMatch(/^<svg /);
    }
  });

  it("declares no global sidebar entry, which would carry no folder scope", () => {
    expect(m.sidebar_items ?? []).toEqual([]);
  });

  it("holds contribute_sidebar, which core requires for those entries", () => {
    expect(m.permissions).toContain("contribute_sidebar");
  });
});

describe("the enable route", () => {
  it("reports both switches off before anything is flipped", () => {
    stub();
    const body = call("GET", `${API}/repos`);
    expect(body.folder_known).toBe(true);
    expect(body.folder_enabled).toBe(false);
    expect(body.repos.map((r: any) => r.enabled)).toEqual([false, false]);
  });

  it("turns the folder on, then one repo, and says so in the same answer", () => {
    const store = stub();
    let body = call("POST", `${API}/enable`, { body: JSON.stringify({ scope: "folder", enabled: true }) });
    expect(body.folder_enabled).toBe(true);
    expect(store.docs[`folders/${FOLDER}`]).toMatchObject({ enabled: true });

    body = call("POST", `${API}/enable`, {
      body: JSON.stringify({ scope: "repo", repo: "apps/api", enabled: true }),
    });
    expect(body.repos.find((r: any) => r.path === "apps/api").enabled).toBe(true);
    expect(body.repos.find((r: any) => r.path === ".").enabled).toBe(false);
  });

  it("refuses to write a switch it cannot attribute to a folder", () => {
    const store = docStore();
    setHandlers({ ...store.handlers, peckboard_caller_scope: () => ({ folder_id: null }) });
    const verdict = JSON.parse(
      serveAuthed({
        method: "POST",
        path: `${API}/enable`,
        query: "",
        headers: {},
        body: JSON.stringify({ scope: "folder", enabled: true }),
      }),
    );
    expect(verdict.payload.status).toBe(400);
    expect(JSON.parse(verdict.payload.body).error).toContain("could not be tied to a folder");
    expect(Object.keys(store.docs)).toEqual([]);
  });

  it("rejects an unknown scope rather than guessing", () => {
    stub();
    const verdict = JSON.parse(
      serveAuthed({
        method: "POST",
        path: `${API}/enable`,
        query: "",
        headers: HEADERS,
        body: JSON.stringify({ scope: "everything", enabled: true }),
      }),
    );
    expect(verdict.payload.status).toBe(400);
  });
});

describe("the gated read routes", () => {
  it("will not draw a graph for a repo that is switched off", () => {
    stub({ [`folders/${FOLDER}`]: { enabled: true } });
    const body = call("GET", `${API}/graph`, { query: "repo=apps/api" });
    expect(body.enabled).toBe(false);
    expect(body.error).toContain("'apps/api' repo");
  });

  it("lists repos even with everything off, because that is how you pick one", () => {
    stub();
    expect(call("GET", `${API}/repos`).repos).toHaveLength(2);
  });
});

describe("queryParam", () => {
  it("pulls a named value out of a &-separated query string", () => {
    expect(queryParam("repo=apps/api", "repo")).toBe("apps/api");
    expect(queryParam("a=1&repo=web&b=2", "repo")).toBe("web");
  });

  it("URL-decodes, treating + as a space", () => {
    expect(queryParam("repo=peck-plugins%2Fgraphify", "repo")).toBe("peck-plugins/graphify");
    expect(queryParam("label=Auth+Client", "label")).toBe("Auth Client");
    expect(queryParam("label=Auth%20Client", "label")).toBe("Auth Client");
  });

  it("returns undefined for anything it cannot find", () => {
    expect(queryParam("", "repo")).toBeUndefined();
    expect(queryParam("other=1", "repo")).toBeUndefined();
    // A bare flag has no '=', so there is no value to give back.
    expect(queryParam("repo", "repo")).toBeUndefined();
    // Prefix collisions must not match.
    expect(queryParam("repository=x", "repo")).toBeUndefined();
  });

  it("gives back an empty value rather than skipping the key", () => {
    expect(queryParam("repo=&a=1", "repo")).toBe("");
  });

  it("hands back the raw value when the escape is malformed", () => {
    expect(queryParam("repo=%E0%A4%A", "repo")).toBe("%E0%A4%A");
  });

  it("takes the first occurrence when a key repeats", () => {
    expect(queryParam("repo=one&repo=two", "repo")).toBe("one");
  });
});
