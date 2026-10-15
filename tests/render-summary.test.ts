/**
 * Render-summary tests.
 *
 * Covers: renderSummary, observationToSummaryLine, reflectionToSummaryLine,
 * empty input handling.
 */

import { describe, it, expect } from "vitest";
import type { Observation, Reflection } from "../src/om/ledger/types.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeObservation(id: string, overrides: Partial<Observation> = {}): Observation {
  return {
    id,
    content: `User mentioned they prefer TypeScript over JavaScript`,
    timestamp: "2026-01-01 12:00",
    relevance: "medium" as const,
    sourceEntryIds: ["src00000000aa"],
    tokenCount: 100,
    ...overrides,
  };
}

function makeReflection(id: string, overrides: Partial<Reflection> = {}): Reflection {
  return {
    id,
    content: "User prefers TypeScript with strict mode enabled",
    supportingObservationIds: ["aaaaaaaaaaaa"],
    tokenCount: 200,
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("observationToSummaryLine", () => {
  it("formats an observation line", async () => {
    const { observationToSummaryLine } = await import("../src/om/ledger/render-summary.js");
    const obs = makeObservation("aaaaaaaaaaaa", { relevance: "high" as const });
    const line = observationToSummaryLine(obs);
    expect(line).toContain("[aaaaaaaaaaaa]");
    expect(line).toContain("2026-01-01 12:00");
    expect(line).toContain("[high]");
    expect(line).toContain("TypeScript over JavaScript");
  });

  it("handles critical relevance", async () => {
    const { observationToSummaryLine } = await import("../src/om/ledger/render-summary.js");
    const obs = makeObservation("bbbbbbbbbbbb", {
      relevance: "critical" as const,
    });
    const line = observationToSummaryLine(obs);
    expect(line).toContain("[critical]");
  });
});

describe("reflectionToSummaryLine", () => {
  it("formats a reflection line with id", async () => {
    const { reflectionToSummaryLine } = await import("../src/om/ledger/render-summary.js");
    const ref = makeReflection("ref00000000aa");
    const line = reflectionToSummaryLine(ref);
    expect(line).toContain("[ref00000000aa]");
    expect(line).toContain("strict mode");
  });
});

describe("selectPriorObservations", () => {
  const bigHigh = (id: string): Observation =>
    makeObservation(id, {
      content: "x".repeat(8000),
      relevance: "high" as const,
    });

  it("keeps all high observations and fills the rest when high fits the budget", async () => {
    const { selectPriorObservations } = await import("../src/om/ledger/render-summary.js");
    const obs = [bigHigh("high00000001"), bigHigh("high00000002")];
    const selected = selectPriorObservations(obs, 20_000);
    expect(selected.map((o) => o.id)).toEqual(["high00000001", "high00000002"]);
  });

  it("trims high observations newest-first when they alone exceed the budget (#69)", async () => {
    const { selectPriorObservations } = await import("../src/om/ledger/render-summary.js");
    const obs = [bigHigh("high00000001"), bigHigh("high00000002"), bigHigh("high00000003")];
    // Each line renders to ~2010 tokens; budget 5000 fits the newest two.
    const selected = selectPriorObservations(obs, 5_000);
    expect(selected.map((o) => o.id)).toEqual(["high00000002", "high00000003"]);
  });

  it("never renders more than the budget when every observation is critical (#69)", async () => {
    const { selectPriorObservations, observationToSummaryLine } =
      await import("../src/om/ledger/render-summary.js");
    const obs = [bigHigh("high00000001"), bigHigh("high00000002"), bigHigh("high00000003")];
    const selected = selectPriorObservations(obs, 5_000);
    const rendered = selected.reduce(
      (total, o) => total + Math.ceil(observationToSummaryLine(o).length / 4),
      0,
    );
    expect(rendered).toBeLessThanOrEqual(5_000);
  });
});

describe("renderSummary", () => {
  it("returns basic recall footer when both lists are empty", async () => {
    const { renderSummary } = await import("../src/om/ledger/render-summary.js");
    const result = renderSummary([], []);
    expect(result).toContain("Use `recall` with an id");
    expect(result).toContain("most recent entry");
    expect(result).not.toContain("## Reflections");
    expect(result).not.toContain("## Observations");
  });

  it("includes reflections section when reflections present", async () => {
    const { renderSummary } = await import("../src/om/ledger/render-summary.js");
    const ref = makeReflection("ref00000000aa");
    const result = renderSummary([ref], []);
    expect(result).toContain("## Reflections");
    expect(result).toContain("[ref00000000aa]");
    expect(result).not.toContain("## Observations");
  });

  it("includes observations section when observations present", async () => {
    const { renderSummary } = await import("../src/om/ledger/render-summary.js");
    const obs = makeObservation("obs00000000aa");
    const result = renderSummary([], [obs]);
    expect(result).toContain("## Observations");
    expect(result).toContain("[obs00000000aa]");
    expect(result).not.toContain("## Reflections");
  });

  it("includes both sections when both present", async () => {
    const { renderSummary } = await import("../src/om/ledger/render-summary.js");
    const ref = makeReflection("ref00000000aa");
    const obs = makeObservation("obs00000000aa");
    const result = renderSummary([ref], [obs]);
    expect(result).toContain("## Reflections");
    expect(result).toContain("## Observations");
    expect(result).toContain("Bracketed ids in reflections and observations");
  });

  it("includes full context instructions when observations/reflections present", async () => {
    const { renderSummary } = await import("../src/om/ledger/render-summary.js");
    const ref = makeReflection("ref00000000aa");
    const result = renderSummary([ref], []);
    expect(result).toContain("Bracketed ids in reflections and observations");
    expect(result).toContain("## Reflections");
    expect(result).toContain("most recent observation");
  });

  it("handles multiple reflections and observations in order", async () => {
    const { renderSummary } = await import("../src/om/ledger/render-summary.js");
    const ref1 = makeReflection("ref1111111111", {
      content: "First reflection",
    });
    const ref2 = makeReflection("ref2222222222", {
      content: "Second reflection",
    });
    const obs1 = makeObservation("obs1111111111", {
      content: "First observation",
    });
    const obs2 = makeObservation("obs2222222222", {
      content: "Second observation",
    });
    const result = renderSummary([ref1, ref2], [obs1, obs2]);

    const refSection = result.indexOf("## Reflections");
    const obsSection = result.indexOf("## Observations");
    expect(refSection).toBeGreaterThanOrEqual(0);
    expect(obsSection).toBeGreaterThan(refSection);

    expect(result.indexOf("First reflection")).toBeGreaterThan(refSection);
    expect(result.indexOf("Second reflection")).toBeGreaterThan(refSection);
    expect(result.indexOf("First observation")).toBeGreaterThan(obsSection);
    expect(result.indexOf("Second observation")).toBeGreaterThan(obsSection);
  });
});

describe("reflection output budget", () => {
  it("keeps newest whole records that fit, skipping oversized records", async () => {
    const { selectPriorReflections, reflectionToSummaryLine } =
      await import("../src/om/ledger/render-summary.js");
    const { estimateStringTokens } = await import("../src/om/tokens.js");
    const refs = ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc", "dddddddddddd"].map((id) =>
      makeReflection(id, { content: "x", tokenCount: 0 }),
    );
    refs[3].content = "x".repeat(1000);
    const budget = estimateStringTokens(refs.slice(1, 3).map(reflectionToSummaryLine).join("\n"));
    const selected = selectPriorReflections(refs, budget);
    expect(selected).toEqual(refs.slice(1, 3));
    expect(
      estimateStringTokens(selected.map(reflectionToSummaryLine).join("\n")),
    ).toBeLessThanOrEqual(budget);
    expect(refs).toHaveLength(4);
  });
});

describe("reflection annotations", () => {
  const ref = makeReflection("bbbbbbbbbbbb", {
    content: "tests pass",
    timestamp: "2026-10-03 14:20",
    supersedes: ["aaaaaaaaaaaa"],
  });
  it.each([
    [true, true, "[bbbbbbbbbbbb] 2026-10-03 14:20 tests pass (supersedes aaaaaaaaaaaa)"],
    [true, false, "[bbbbbbbbbbbb] 2026-10-03 14:20 tests pass"],
    [false, true, "[bbbbbbbbbbbb] tests pass (supersedes aaaaaaaaaaaa)"],
    [false, false, "[bbbbbbbbbbbb] tests pass"],
  ])("renders timestamps=%s supersedes=%s", async (timestamps, supersedes, expected) => {
    const { makeReflectionRenderer } = await import("../src/om/ledger/render-summary.js");
    expect(makeReflectionRenderer({ timestamps, supersedes })(ref)).toBe(expected);
  });
  it("renders legacy record unchanged", async () => {
    const { makeReflectionRenderer } = await import("../src/om/ledger/render-summary.js");
    expect(
      makeReflectionRenderer({ timestamps: true, supersedes: true })(
        makeReflection("aaaaaaaaaaaa", { content: "C" }),
      ),
    ).toBe("[aaaaaaaaaaaa] C");
  });
  it("uses timestamp conflict rule when enabled", async () => {
    const { renderSummary } = await import("../src/om/ledger/render-summary.js");
    expect(renderSummary([ref], [], { timestamps: true, supersedes: false })).toContain(
      "When entries conflict, the entry with the latest timestamp reflects the latest known state.",
    );
  });
  it("explains supersede suffix when enabled", async () => {
    const { renderSummary } = await import("../src/om/ledger/render-summary.js");
    expect(renderSummary([ref], [], { timestamps: false, supersedes: true })).toContain(
      "Supersedes notes identify earlier reflections replaced by this entry; all reflections remain available.",
    );
  });
  it("locks both-off legacy output", async () => {
    const { renderSummary } = await import("../src/om/ledger/render-summary.js");
    expect(renderSummary([ref], [], { timestamps: false, supersedes: false })).toBe(
      "## Reflections\n[bbbbbbbbbbbb] tests pass\n\n----\nBracketed ids in reflections and observations connect to their source session entries. These are condensed memories from earlier in this session.\nWhen entries conflict, the most recent observation reflects the latest known state.\nUse `recall` with an id to retrieve original context, or `#N:path` drill-down to explore file content from referenced entries.\nWhen exact source context is needed for precision or traceability, use the `recall` tool with the relevant observation or reflection id. This is especially useful when a reflection materially affects a decision or is too compressed to continue confidently.\n----",
    );
  });
  it("charges rendered time against reflection cap", async () => {
    const { selectPriorReflections, makeReflectionRenderer } =
      await import("../src/om/ledger/render-summary.js");
    const { estimateStringTokens } = await import("../src/om/tokens.js");
    const render = makeReflectionRenderer({ timestamps: true, supersedes: false });
    const budget = estimateStringTokens("[bbbbbbbbbbbb] tests pass\n[bbbbbbbbbbbb] tests pass");
    expect(selectPriorReflections([ref, ref], budget, render)).toHaveLength(1);
  });
  it("renders existing summary through same renderer", async () => {
    const { buildExistingReflectionsSummary, makeReflectionRenderer } =
      await import("../src/om/ledger/index.js");
    expect(
      buildExistingReflectionsSummary(
        [ref],
        100,
        makeReflectionRenderer({ timestamps: true, supersedes: false }),
      ),
    ).toBe("[bbbbbbbbbbbb] 2026-10-03 14:20 tests pass");
  });
});

describe("annotation compatibility and inclusion", () => {
  it.each([42, "", "unknown", null])("ignores malformed timestamp %s", async (timestamp) => {
    const { isReflection, makeReflectionRenderer } = await import("../src/om/ledger/index.js");
    const value = { ...makeReflection("aaaaaaaaaaaa", { content: "C" }), timestamp };
    if (!isReflection(value)) throw new Error("legacy validator rejected optional metadata");
    expect(makeReflectionRenderer({ timestamps: true, supersedes: true })(value)).toBe(
      "[aaaaaaaaaaaa] C",
    );
  });
  it.each(["aaaaaaaaaaaa", 42, null, ["not-an-id"]])(
    "ignores malformed supersedes %s",
    async (supersedes) => {
      const { isReflection, makeReflectionRenderer } = await import("../src/om/ledger/index.js");
      const value = { ...makeReflection("aaaaaaaaaaaa", { content: "C" }), supersedes };
      if (!isReflection(value)) throw new Error("legacy validator rejected optional metadata");
      expect(makeReflectionRenderer({ timestamps: true, supersedes: true })(value)).toBe(
        "[aaaaaaaaaaaa] C",
      );
    },
  );
  it("strips both-on OM without changing markers", async () => {
    const { renderSummary } = await import("../src/om/ledger/index.js");
    const { stripOMContent } = await import("../src/core/summarize.js");
    const text = renderSummary(
      [
        makeReflection("aaaaaaaaaaaa", {
          timestamp: "2026-10-03 14:05",
          supersedes: ["bbbbbbbbbbbb"],
        }),
      ],
      [],
      { timestamps: true, supersedes: true },
    );
    expect(stripOMContent(text)).not.toContain("[aaaaaaaaaaaa]");
  });
  it("keeps basic footer unchanged under both toggles", async () => {
    const { renderSummary, OM_FOOTER_BASIC } = await import("../src/om/ledger/index.js");
    expect(renderSummary([], [], { timestamps: true, supersedes: true })).toBe(OM_FOOTER_BASIC);
  });
  it("does not change earlier rendered line after supersession", async () => {
    const { makeReflectionRenderer } = await import("../src/om/ledger/index.js");
    const first = makeReflection("aaaaaaaaaaaa");
    const second = makeReflection("bbbbbbbbbbbb", { supersedes: [first.id] });
    const render = makeReflectionRenderer({ timestamps: true, supersedes: true });
    expect([first, second].map(render)[0]).toBe(render(first));
  });
  it("preserves both records in fold and projection", async () => {
    const { foldLedger, buildCompactionProjection } = await import("../src/om/ledger/index.js");
    const { rawMessage, observationsRecordedEntry, reflectionsRecordedEntry } =
      await import("./fixtures/session.js");
    const first = makeReflection("aaaaaaaaaaaa");
    const second = makeReflection("bbbbbbbbbbbb", { supersedes: [first.id] });
    const entries = [
      rawMessage("source", "source"),
      observationsRecordedEntry("obs", {
        observations: [makeObservation("aaaaaaaaaaaa", { sourceEntryIds: ["source"] })],
        coversUpToId: "source",
      }),
      reflectionsRecordedEntry("r1", { reflections: [first], coversUpToId: "source" }),
    ];
    const before = structuredClone(entries);
    entries.push(reflectionsRecordedEntry("r2", { reflections: [second], coversUpToId: "source" }));
    expect({
      prior: entries.slice(0, -1),
      added: entries.length - before.length,
      folded: foldLedger(entries).reflections.map((r) => r.id),
      projected: buildCompactionProjection(entries, "", {
        observationsPoolMaxTokens: 20000,
        reflectionTimestamps: true,
        reflectionSupersedes: true,
      }).reflections.map((r) => r.id),
    }).toEqual({
      prior: before,
      added: 1,
      folded: [first.id, second.id],
      projected: [first.id, second.id],
    });
  });
});
