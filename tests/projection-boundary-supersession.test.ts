import { describe, expect, it } from "vitest";

import {
  buildCompactionProjection,
  latestFullFoldBoundaryId,
  visibleProjection,
  type Entry,
} from "../src/om/ledger/index.js";
import {
  compactionEntry,
  observation,
  observationsRecordedEntry,
  reflection,
  reflectionsRecordedEntry,
  textCustomMessage,
  type TestEntry,
} from "./fixtures/session.js";

const asEntries = (entries: TestEntry[]): Entry[] => entries;
const config = { observationsPoolMaxTokens: 100_000, fullFoldAlways: true };
const reflectionConfig = { observationsPoolMaxTokens: 100_000, fullFoldAlways: false };

function observationBranch(freshSource: string): TestEntry[] {
  return [
    textCustomMessage("raw-1", "old fact"),
    observationsRecordedEntry("om-old", {
      observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-1"] })],
      coversUpToId: "raw-1",
    }),
    textCustomMessage("raw-2", "cut"),
    textCustomMessage("raw-3", "later fact"),
    observationsRecordedEntry("om-straddling", {
      observations: [
        observation("bbbbbbbbbbbb", {
          sourceEntryIds: [freshSource],
          supersedes: ["aaaaaaaaaaaa"],
        }),
      ],
      coversUpToId: "raw-3",
    }),
  ];
}

describe("cut-aware projection with observation supersession", () => {
  it("admits a pre-cut observation from a straddling batch and retires its superseded fact", () => {
    const projection = buildCompactionProjection(
      asEntries(observationBranch("raw-1")),
      "raw-2",
      config,
    );
    expect(projection.observations.map((item) => item.id)).toEqual(["bbbbbbbbbbbb"]);
  });

  it("does not let a post-cut superseder retire the old projected fact", () => {
    const projection = buildCompactionProjection(
      asEntries(observationBranch("raw-3")),
      "raw-2",
      config,
    );
    expect(projection.observations.map((item) => item.id)).toEqual(["aaaaaaaaaaaa"]);
  });

  it("keeps the only valid fact when a straddling superseder has an unknown source", () => {
    const projection = buildCompactionProjection(
      asEntries(observationBranch("missing-source")),
      "raw-2",
      config,
    );
    expect(projection.observations.map((item) => item.id)).toEqual(["aaaaaaaaaaaa"]);
  });
});

function reflectionBranch(newSupportSource: string): TestEntry[] {
  return [
    textCustomMessage("raw-1", "old evidence"),
    observationsRecordedEntry("om-old", {
      observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-1"] })],
      coversUpToId: "raw-1",
    }),
    reflectionsRecordedEntry("rf-old", {
      reflections: [reflection("cccccccccccc", ["aaaaaaaaaaaa"])],
      coversUpToId: "raw-1",
    }),
    textCustomMessage("raw-2", "completed full fold boundary"),
    compactionEntry("compact-full", {
      firstKeptEntryId: "raw-2",
      details: {
        type: "om.folded",
        version: 1,
        fullFold: true,
        observations: [],
        reflections: [],
      },
    }),
    textCustomMessage("raw-3", "later evidence"),
    observationsRecordedEntry("om-later", {
      observations: [observation("dddddddddddd", { sourceEntryIds: [newSupportSource] })],
      coversUpToId: "raw-3",
    }),
    textCustomMessage("raw-4", "tail"),
    reflectionsRecordedEntry("rf-straddling", {
      reflections: [
        reflection("eeeeeeeeeeee", ["dddddddddddd"], {
          supersedes: ["cccccccccccc"],
        }),
      ],
      coversUpToId: "raw-4",
    }),
  ];
}

describe("cut-aware projection with reflection supersession", () => {
  it("arms the maintenance boundary from the recorded full fold", () => {
    expect(latestFullFoldBoundaryId(asEntries(reflectionBranch("raw-1")))).toBe("raw-2");
  });

  it("retires an old reflection when an eligible straddling superseder cites pre-boundary evidence", () => {
    const projection = buildCompactionProjection(asEntries(reflectionBranch("raw-1")), "raw-4", {
      ...reflectionConfig,
      reflectionSupersedes: true,
    });
    expect(projection.reflections.map((item) => item.id)).toEqual(["eeeeeeeeeeee"]);
  });

  it("keeps all eligible reflections when retirement is disabled", () => {
    const projection = buildCompactionProjection(
      asEntries(reflectionBranch("raw-1")),
      "raw-4",
      reflectionConfig,
    );
    expect(projection.reflections.map((item) => item.id)).toEqual(["cccccccccccc", "eeeeeeeeeeee"]);
  });

  it("applies the same boundary and retirement rule in the visible projection", () => {
    const projection = visibleProjection(asEntries(reflectionBranch("raw-1")), "raw-4", true);
    expect(projection.reflections.map((item) => item.id)).toEqual(["eeeeeeeeeeee"]);
  });

  it("does not admit or apply an ineligible straddling superseder supported after maintenance boundary", () => {
    const projection = buildCompactionProjection(asEntries(reflectionBranch("raw-3")), "raw-4", {
      ...reflectionConfig,
      reflectionSupersedes: true,
    });
    expect(projection.reflections.map((item) => item.id)).toEqual(["cccccccccccc"]);
  });

  it("keeps the old reflection when straddling superseder support is unknown", () => {
    const projection = buildCompactionProjection(
      asEntries(reflectionBranch("missing-source")),
      "raw-4",
      {
        ...reflectionConfig,
        reflectionSupersedes: true,
      },
    );
    expect(projection.reflections.map((item) => item.id)).toEqual(["cccccccccccc"]);
  });
});
