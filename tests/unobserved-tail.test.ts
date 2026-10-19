import { describe, expect, test } from "vitest";
import { buildOwnCut, unobservedCompactionState } from "../src/hooks/before-compact.js";
import { DEFAULTS } from "../src/core/unified-config.js";
import {
  observation,
  observationsRecordedEntry,
  rawMessage,
  compactionEntry,
} from "./fixtures/session.js";

const covered = (id = "m2") =>
  observationsRecordedEntry("om1", {
    coversUpToId: id,
    observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["m1", "m2"] })],
  });
const history = () => [
  rawMessage("m1", "old request"),
  rawMessage("m2", "old answer", { message: { role: "assistant", content: "old answer" } }),
  rawMessage("m3", "pending request"),
  rawMessage("m4", "pending answer", { message: { role: "assistant", content: "pending answer" } }),
  rawMessage("m5", "latest request"),
];

describe("unobserved no-progress fingerprint", () => {
  const baseline = () => [...history(), covered()];
  const state = (
    entries = baseline(),
    config = DEFAULTS,
    model = { provider: "test", id: "test" },
    prompt = "system",
  ) => unobservedCompactionState(entries, config, model, prompt);

  test("raw suffix growth leaves the fingerprint unchanged", () => {
    expect(state([...baseline(), rawMessage("m6", "new raw suffix")])).toBe(state());
  });
  test("ledger changes invalidate the fingerprint", () => {
    const marker = observationsRecordedEntry("om2", {
      coversUpToId: "m4",
      observations: [observation("bbbbbbbbbbbb", { sourceEntryIds: ["m3", "m4"] })],
    });
    expect(state([...baseline(), marker])).not.toBe(state());
  });
  test("a same-cut compaction invalidates the lineage fingerprint", () => {
    const entries = baseline();
    expect(state([...entries, compactionEntry("c1", { firstKeptEntryId: "m3" })])).not.toBe(
      state(entries),
    );
  });
  test("configuration changes invalidate the fingerprint", () => {
    expect(state(undefined, { ...DEFAULTS, memory: false })).not.toBe(state());
  });
  test("model changes invalidate the fingerprint", () => {
    expect(state(undefined, undefined, { provider: "test", id: "other" })).not.toBe(state());
  });
  test("system prompt changes invalidate the fingerprint", () => {
    expect(state(undefined, undefined, undefined, "different system")).not.toBe(state());
  });
});

describe("unobserved tail", () => {
  test("cuts only completed OM coverage, not Pi's later cut", () => {
    expect(buildOwnCut([...history(), covered()], "m5", "unobserved")).toMatchObject({
      ok: true,
      firstKeptEntryId: "m3",
      selectedIds: ["m1", "m2"],
    });
  });
  test("a Pi metadata cut after the last source cannot replace the coverage cut", () => {
    expect(buildOwnCut([...history(), covered()], "om1", "unobserved")).toMatchObject({
      firstKeptEntryId: "m3",
      selectedIds: ["m1", "m2"],
    });
  });
  test.each([undefined, "missing", "om1"])(
    "without a valid source coverage anchor (%s), retains all originals",
    (id) => {
      const entries = history();
      if (id) entries.push(covered(id));
      expect(buildOwnCut(entries, "m5", "unobserved")).toMatchObject({
        ok: true,
        firstKeptEntryId: "m1",
        selectedIds: [],
      });
    },
  );
  test("prior compaction leaves the unobserved active window unsummarized", () => {
    expect(
      buildOwnCut(
        [
          ...history(),
          compactionEntry("c1", { firstKeptEntryId: "m5" }),
          compactionEntry("c2", { firstKeptEntryId: "m5" }),
        ],
        "m5",
        "unobserved",
      ),
    ).toMatchObject({ ok: true, firstKeptEntryId: "m5", selectedIds: [] });
  });
  test("backs up only to the tool call rather than the whole user turn", () => {
    const entries = history();
    entries[1] = rawMessage("m2", "", {
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call1", name: "read", arguments: {} }],
      },
    });
    entries[2] = rawMessage("m3", "", {
      message: {
        role: "toolResult",
        toolCallId: "call1",
        toolName: "read",
        content: [{ type: "text", text: "result" }],
      },
    });
    expect(buildOwnCut([...entries, covered()], "m5", "unobserved")).toMatchObject({
      ok: true,
      firstKeptEntryId: "m2",
      selectedIds: ["m1"],
    });
  });
  test("unanchored facts do not count as completed coverage", () => {
    const marker = covered();
    marker.customType = "om.observations.unanchored";
    expect(buildOwnCut([...history(), marker], "m5", "unobserved")).toMatchObject({
      ok: true,
      firstKeptEntryId: "m1",
    });
  });
  test("empty history cancels", () => {
    expect(buildOwnCut([], undefined, "unobserved")).toEqual({
      ok: false,
      reason: "no_live_messages",
    });
  });
});

test("disconnected completed batch cannot skip an earlier unobserved source", () => {
  const marker = observationsRecordedEntry("om1", {
    coversUpToId: "m4",
    observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["m3", "m4"] })],
  });
  expect(buildOwnCut([...history(), marker], "m5", "unobserved")).toMatchObject({
    firstKeptEntryId: "m1",
    selectedIds: [],
  });
});
test("pending custom source before first message stays in the raw suffix", () => {
  const entries = [
    { id: "custom1", type: "custom_message", content: "pending original", customType: "test" },
    ...history(),
  ];
  expect(buildOwnCut(entries, "m5", "unobserved")).toMatchObject({
    firstKeptEntryId: "custom1",
    selectedIds: [],
  });
});

test("a user message inside an unfinished tool interaction is not a safe cut", () => {
  const entries = [
    rawMessage("m1", "start"),
    rawMessage("m2", "", {
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "t", name: "read", arguments: {} }],
      },
    }),
    rawMessage("m3", "interruption"),
    rawMessage("m4", "", {
      message: {
        role: "toolResult",
        toolCallId: "t",
        toolName: "read",
        content: [{ type: "text", text: "result" }],
      },
    }),
    covered(),
  ];
  expect(buildOwnCut(entries, "m3", "unobserved")).toMatchObject({
    firstKeptEntryId: "m2",
    selectedIds: ["m1"],
  });
});

test("retains Pi's token-sized tail when it starts before the unobserved suffix", () => {
  expect(buildOwnCut([...history(), covered("m4")], "m2", "unobserved")).toMatchObject({
    firstKeptEntryId: "m2",
    selectedIds: ["m1"],
  });
});

test.each([undefined, "missing"])(
  "without a usable Pi cut (%s), uses the safe coverage cut",
  (piCut) => {
    expect(buildOwnCut([...history(), covered()], piCut, "unobserved")).toMatchObject({
      firstKeptEntryId: "m3",
      selectedIds: ["m1", "m2"],
    });
  },
);

test("one user turn can shed covered tool cycles", () => {
  const entries = history();
  entries[2] = rawMessage("m3", "result", {
    message: { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "result" }] },
  });
  entries[1] = rawMessage("m2", "", {
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }],
    },
  });
  entries[3] = rawMessage("m4", "", {
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "t2", name: "read", arguments: {} }],
    },
  });
  entries[4] = rawMessage("m5", "result", {
    message: { role: "toolResult", toolCallId: "t2", content: [{ type: "text", text: "result" }] },
  });
  expect(buildOwnCut([...entries, covered("m3")], "m4", "unobserved")).toMatchObject({
    firstKeptEntryId: "m4",
    selectedIds: ["m1", "m2", "m3"],
  });
});

test("partial coverage of multiple calls retains the shared assistant and every result", () => {
  const entries = [
    rawMessage("m1", "start"),
    rawMessage("m2", "", {
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "t1", name: "read", arguments: {} },
          { type: "toolCall", id: "t2", name: "read", arguments: {} },
        ],
      },
    }),
    rawMessage("m3", "", { message: { role: "toolResult", toolCallId: "t1", content: [] } }),
    rawMessage("m4", "", { message: { role: "toolResult", toolCallId: "t2", content: [] } }),
    covered("m3"),
  ];
  expect(buildOwnCut(entries, "m4", "unobserved")).toMatchObject({
    firstKeptEntryId: "m2",
    selectedIds: ["m1"],
  });
});
