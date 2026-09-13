import { describe, it, expect } from "vitest";
import { parseRecallMode } from "../src/core/recall-scope.js";

describe("normalizeRecallMode", () => {
  it("defaults to hybrid", async () => {
    const { normalizeRecallMode } = await import("../src/core/recall-scope.js");
    expect(normalizeRecallMode()).toBe("hybrid");
    expect(normalizeRecallMode("unknown")).toBe("hybrid");
    expect(normalizeRecallMode(123)).toBe("hybrid");
  });

  it("accepts file mode", async () => {
    const { normalizeRecallMode } = await import("../src/core/recall-scope.js");
    expect(normalizeRecallMode("file")).toBe("file");
    expect(normalizeRecallMode("FILE")).toBe("file");
  });

  it("accepts hybrid mode", async () => {
    const { normalizeRecallMode } = await import("../src/core/recall-scope.js");
    expect(normalizeRecallMode("hybrid")).toBe("hybrid");
  });

  it("accepts touched mode", async () => {
    const { normalizeRecallMode } = await import("../src/core/recall-scope.js");
    expect(normalizeRecallMode("touched")).toBe("touched");
    expect(normalizeRecallMode("TOUCHED")).toBe("touched");
  });
});

describe("parseRecallMode", () => {
  it("parses mode token from command text", () => {
    expect(parseRecallMode("login mode:file")).toEqual({
      mode: "file",
      text: "login",
    });
  });

  it("defaults to hybrid when no mode token is present", () => {
    expect(parseRecallMode("login page:2")).toEqual({
      mode: "hybrid",
      text: "login page:2",
    });
  });

  it("parses touched mode from command text", () => {
    expect(parseRecallMode("mode:touched")).toEqual({
      mode: "touched",
      text: "",
    });
  });

  it("treats legacy scope:all text as ordinary query text (no compatibility parsing)", () => {
    // scope is removed: the token must survive into the query untouched
    expect(parseRecallMode("license scope:all page:2")).toEqual({
      mode: "hybrid",
      text: "license scope:all page:2",
    });
  });
});
