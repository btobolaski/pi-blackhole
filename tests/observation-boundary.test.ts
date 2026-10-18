import { describe, expect, test } from "vitest";

import { observedPrefixIndex } from "../src/core/observation-boundary.js";
import { latestCoverageIndex } from "../src/om/ledger/progress.js";
import { OM_OBSERVATIONS_RECORDED, type Entry } from "../src/om/ledger/types.js";
import { observation, rawMessage } from "./fixtures/session.js";

describe("persisted observer delivery coverage", () => {
  test("a complete range advances even when the observation cites only a later routine source", () => {
    const entries: Entry[] = [
      rawMessage("routine", "routine context delivered to observer"),
      rawMessage("fact", "the fact worth retaining"),
      {
        type: "custom",
        id: "recorded",
        customType: OM_OBSERVATIONS_RECORDED,
        data: {
          observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["fact"] })],
          coversFromId: "routine",
          coversUpToId: "fact",
        },
      },
    ];

    expect(observedPrefixIndex(entries)).toBe(1);
  });

  test("a successfully delivered empty chunk persists a coverage-only range", () => {
    const entries: Entry[] = [
      rawMessage("routine", "nothing new in this delivered source"),
      {
        type: "custom",
        id: "empty-coverage",
        customType: "om.observations.coverage",
        data: { coversFromId: "routine", coversUpToId: "routine" },
      },
    ];

    expect(observedPrefixIndex(entries)).toBe(0);
    expect(latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED)).toBe(0);
  });

  test("legacy markers without a delivered range still require a head citation", () => {
    const entries: Entry[] = [
      rawMessage("routine", "routine context delivered to observer"),
      rawMessage("fact", "the fact worth retaining"),
      {
        type: "custom",
        id: "legacy-recorded",
        customType: OM_OBSERVATIONS_RECORDED,
        data: {
          observations: [observation("bbbbbbbbbbbb", { sourceEntryIds: ["fact"] })],
          coversUpToId: "fact",
        },
      },
    ];

    expect(observedPrefixIndex(entries)).toBe(-1);
  });
});
