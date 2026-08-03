import { describe, expect, it } from "vitest";
import { queryParam } from "../src/http";

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
