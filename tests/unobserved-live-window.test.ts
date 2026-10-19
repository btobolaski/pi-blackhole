import { expect, test } from "vitest";
import { buildOwnCut } from "../src/hooks/before-compact.js";
import {
  compactionEntry,
  customMessage,
  observation,
  observationsRecordedEntry,
  rawMessage,
} from "./fixtures/session.js";

const history = () => [
  rawMessage("m1", "already summarized request"),
  rawMessage("m2", "already summarized answer", {
    message: { role: "assistant", content: "already summarized answer" },
  }),
  rawMessage("m3", "retained request"),
  rawMessage("m4", "retained answer", {
    message: { role: "assistant", content: "retained answer" },
  }),
  rawMessage("m5", "latest request"),
];
const covered = (end: string) =>
  observationsRecordedEntry("coverage", {
    coversUpToId: end,
    observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["m1", end] })],
  });

test("unobserved cuts summarize only the active window after prior compaction", () => {
  expect(
    buildOwnCut(
      [...history(), compactionEntry("c1", { firstKeptEntryId: "m3" }), covered("m4")],
      "m5",
      "unobserved",
    ),
  ).toMatchObject({ ok: true, selectedIds: ["m3", "m4"], firstKeptEntryId: "m5" });
});

test("Pi's earlier cut cannot resurrect the summarized prefix", () => {
  expect(
    buildOwnCut(
      [...history(), compactionEntry("c1", { firstKeptEntryId: "m3" }), covered("m4")],
      "m1",
      "unobserved",
    ),
  ).toMatchObject({ firstKeptEntryId: "m5", selectedIds: ["m3", "m4"] });
});

test("lagging observation coverage cannot resurrect the summarized prefix", () => {
  expect(
    buildOwnCut(
      [...history(), covered("m2"), compactionEntry("c1", { firstKeptEntryId: "m3" })],
      "m5",
      "unobserved",
    ),
  ).toMatchObject({ ok: true, selectedIds: [], firstKeptEntryId: "m3" });
});

test.each([undefined, "", "missing"])(
  "a prior cut with unavailable kept id (%s) starts after the compaction entry",
  (firstKeptEntryId) => {
    expect(
      buildOwnCut(
        [
          ...history(),
          compactionEntry("c1", { firstKeptEntryId }),
          rawMessage("m6", "new request"),
          rawMessage("m7", "new answer", {
            message: { role: "assistant", content: "new answer" },
          }),
          rawMessage("m8", "latest request"),
          covered("m7"),
        ],
        "m8",
        "unobserved",
      ),
    ).toMatchObject({ ok: true, selectedIds: ["m6", "m7"], firstKeptEntryId: "m8" });
  },
);

test("orphan recovery without new messages cannot summarize retired messages", () => {
  expect(
    buildOwnCut(
      [...history(), compactionEntry("c1", { firstKeptEntryId: "" })],
      undefined,
      "unobserved",
    ),
  ).toEqual({ ok: false, reason: "no_live_messages" });
});

test("pending custom sources are retained only inside the active window", () => {
  expect(
    buildOwnCut(
      [
        customMessage("retired-custom", "already summarized"),
        ...history(),
        compactionEntry("c1", { firstKeptEntryId: "" }),
        customMessage("live-custom", "pending original"),
        rawMessage("m6", "new request"),
      ],
      undefined,
      "unobserved",
    ),
  ).toMatchObject({ ok: true, selectedIds: [], firstKeptEntryId: "live-custom" });
});

test("a custom-message kept boundary remains in the live suffix", () => {
  expect(
    buildOwnCut(
      [
        ...history(),
        customMessage("live-custom", "pending original"),
        rawMessage("m6", "new request"),
        compactionEntry("c1", { firstKeptEntryId: "live-custom" }),
      ],
      undefined,
      "unobserved",
    ),
  ).toMatchObject({ ok: true, selectedIds: [], firstKeptEntryId: "live-custom" });
});

test("repeated compaction advances the active window without repeating selected IDs", () => {
  expect(
    buildOwnCut(
      [
        ...history(),
        compactionEntry("c1", { firstKeptEntryId: "m3" }),
        covered("m4"),
        compactionEntry("c2", { firstKeptEntryId: "m5" }),
        rawMessage("m6", "next answer", {
          message: { role: "assistant", content: "next answer" },
        }),
        rawMessage("m7", "next request"),
        observationsRecordedEntry("coverage2", {
          coversUpToId: "m6",
          observations: [observation("bbbbbbbbbbbb", { sourceEntryIds: ["m5", "m6"] })],
        }),
      ],
      "m7",
      "unobserved",
    ),
  ).toMatchObject({ ok: true, selectedIds: ["m5", "m6"], firstKeptEntryId: "m7" });
});
