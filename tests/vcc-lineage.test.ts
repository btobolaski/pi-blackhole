import { describe, it, expect } from "vitest";
import { getActiveLineageEntryIds } from "../src/core/lineage.js";

describe("getActiveLineageEntryIds", () => {
  it("returns IDs from active branch", () => {
    const ids = getActiveLineageEntryIds({
      getBranch: () => [{ id: "a" }, { id: "b" }, { id: "c" }],
    });
    expect([...ids]).toEqual(["a", "b", "c"]);
  });

  it("fails closed on an empty branch instead of falling back to getEntries", () => {
    // Named variable (not an inline literal) so the getEntries stub stays
    // armed without tripping excess-property checks: the fallback must not
    // fire even though getEntries would return entries.
    const sessionManagerWithFallback = {
      getBranch: () => [],
      getEntries: () => [{ id: "x" }, { id: "y" }],
    };
    const ids = getActiveLineageEntryIds(sessionManagerWithFallback);
    expect(ids.size).toBe(0);
  });

  it("fails closed when getBranch throws, even with getEntries available", () => {
    const sessionManagerWithFallback = {
      getBranch: () => {
        throw new Error("boom");
      },
      getEntries: () => [{ id: "x" }, { id: "y" }],
    };
    const ids = getActiveLineageEntryIds(sessionManagerWithFallback);
    expect(ids.size).toBe(0);
  });
});
