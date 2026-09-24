import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, test, expect, vi } from "vitest";
import { serializeSourceAddressedBranchEntries } from "../src/om/serialize.js";
import { Runtime } from "../src/om/runtime.js";
import { estimateStringTokens } from "../src/om/tokens.js";
import {
  makeModelResolver,
  maybeLaunchConsolidation,
  runConsolidationPipeline,
  runObserverStage,
  capSourceEntriesToTokens,
  capCatchUp,
  type ConsolidationCtx,
} from "../src/om/consolidation.js";
import {
  branchSummary,
  compactionEntry,
  customMessage,
  observation,
  observationsRecordedEntry,
  rawMessage,
  reflection,
  reflectionsRecordedEntry,
  textCustomMessage,
  type TestEntry,
} from "./fixtures/session.js";
import { unfinishedObserverCatchUps } from "../src/om/ledger/index.js";
import { createExtensionApiDouble } from "./fixtures/pi-extension-api.js";
import { readPendingState as readPendingStateRaw } from "../src/om/pending.js";

/** Cursor round trips write real pending files, so redirect the agent dir. */
const cursorTestDir = join(tmpdir(), `pi-blackhole-consolidation-cursors-${Date.now()}`);
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, getAgentDir: () => cursorTestDir };
});

interface ObserverAgentInput {
  chunk: string;
  allowedSourceEntryIds: string[];
  priorObservations: string[];
  priorReflections: string[];
}

const agents = vi.hoisted(() => ({
  runObserver: vi.fn<(input: ObserverAgentInput) => Promise<unknown>>(),
  runReflector: vi.fn(),
  runDropper: vi.fn(),
}));
vi.mock("../src/om/agents/observer/agent.js", () => ({ runObserver: agents.runObserver }));
vi.mock("../src/om/agents/reflector/agent.js", () => ({ runReflector: agents.runReflector }));
vi.mock("../src/om/agents/dropper/agent.js", () => ({ runDropper: agents.runDropper }));

function mockCtx(notifyCalls: Array<{ message: string; level?: string }>): ConsolidationCtx {
  return {
    cwd: "/tmp",
    hasUI: true,
    ui: {
      notify: (message: string, type?: "warning" | "info" | "error") => {
        notifyCalls.push({ message, level: type });
      },
    },
    model: undefined,
    modelRegistry: {
      find: () => undefined,
      getApiKeyAndHeaders: async () => ({ ok: false }),
    },
    sessionManager: {
      getBranch: () => [],
      getSessionId: () => "test-session",
    },
  };
}

describe("makeModelResolver — per-stage failure notifications", () => {
  test("each stage shows its own failure notification when no models are available", async () => {
    const runtime = new Runtime("/tmp");
    runtime.config.memory = true;
    // No observer/reflector/dropper models configured → all fail
    runtime.config.observerModel = undefined;
    runtime.config.reflectorModel = undefined;
    runtime.config.dropperModel = undefined;
    runtime.config.observerFallbackModels = [];
    runtime.config.reflectorFallbackModels = [];
    runtime.config.dropperFallbackModels = [];

    const notifyCalls: Array<{ message: string; level?: string }> = [];
    const ctx = mockCtx(notifyCalls);
    const generation = runtime.captureGeneration("test-session");
    const resolver = makeModelResolver(runtime, ctx, generation);

    // Observer stage fails → should show notification
    runtime.consolidationPhase = "observer";
    runtime.resolveFailureNotified = false;
    const observerResult = await resolver("observer");
    expect(observerResult).toBeUndefined();
    expect(notifyCalls.length).toBe(1);
    expect(notifyCalls[0]!.message).toContain("observer skipped");

    // Pipeline resets the flag at each stage boundary
    runtime.resolveFailureNotified = false;

    // Reflector stage ALSO fails → should show its own notification
    runtime.consolidationPhase = "reflector";
    const reflectorResult = await resolver("reflector");
    expect(reflectorResult).toBeUndefined();
    expect(notifyCalls.length).toBe(2);
    expect(notifyCalls[1]!.message).toContain("reflector skipped");
  });
});

describe("anyStageDue with cursors", () => {
  test("observer NOT due when cursor has advanced past all entries", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const { anyStageDue } = await import("../src/om/consolidation.js");
    const runtime = new Runtime();
    // Fake config - observe threshold is 100 tokens
    runtime.config.observeAfterTokens = 100;
    runtime.config.reflectAfterTokens = 100000; // keep reflector/dropper from being due
    runtime.config.observationsPoolMaxTokens = 1000;
    runtime.config.dropperPressureThreshold = 0.7;
    runtime.config.reflectorInputMaxTokens = 500;
    // Cursor has advanced past all entries → observer should NOT be due
    const entries = [
      {
        type: "message",
        id: "msg-1",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: "hello world this is a long message that should be over 100 tokens worth of characters",
            },
          ],
        },
      },
    ];
    runtime.advanceCursor("observer", "msg-1", "empty");
    expect(anyStageDue(entries, runtime, undefined)).toBe(false);
  });

  test("observer NOT due when no cursor and tokens below threshold (no observation markers)", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const { anyStageDue } = await import("../src/om/consolidation.js");
    const runtime = new Runtime();
    runtime.config.observeAfterTokens = 100;
    runtime.config.reflectAfterTokens = 100000;
    runtime.config.observationsPoolMaxTokens = 1000;
    runtime.config.dropperPressureThreshold = 0.7;
    runtime.config.reflectorInputMaxTokens = 500;
    // No cursor, tokens over threshold → observer should be due
    const entries = [
      {
        type: "message",
        id: "msg-1",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: "hello world this is a long message that should be over 100 tokens worth of characters and more stuff to make it longer and longer and longer",
            },
          ],
        },
      },
    ];
    expect(anyStageDue(entries, runtime, undefined)).toBe(false); // no observer markers → raw tokens counted from scratch
  });

  test("dropper NOT due when cursor advanced and no new data, no pressure", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const { anyStageDue } = await import("../src/om/consolidation.js");
    const runtime = new Runtime();
    runtime.config.observeAfterTokens = 100000;
    runtime.config.reflectAfterTokens = 5;
    runtime.config.observationsPoolMaxTokens = 100_000;
    runtime.config.dropperPressureThreshold = 0.7;
    runtime.config.reflectorInputMaxTokens = 500;
    // Cursor advanced past all entries, pool < 10%, no new data → dropper NOT due
    const entries = [
      {
        type: "custom",
        id: "obs-1",
        customType: "om.observations.recorded",
        data: {
          observations: [{ id: "o1", content: "a".repeat(100), tokenCount: 25 }],
        },
      },
    ];
    runtime.advanceCursor("dropper", "obs-1", "skipped");
    expect(anyStageDue(entries, runtime, undefined)).toBe(false);
  });

  test("dropper due when pool fullness passes a lowered fullness threshold", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const { anyStageDue } = await import("../src/om/consolidation.js");
    const runtime = new Runtime();
    runtime.config.observeAfterTokens = 100000;
    runtime.config.reflectAfterTokens = 5;
    runtime.config.observationsPoolMaxTokens = 100_000;
    runtime.config.dropperPoolFullnessThreshold = 0.01; // 1%
    runtime.config.dropperPressureThreshold = 0.7;
    runtime.config.reflectorInputMaxTokens = 10_000; // pressure needs 7,000 — pool only has 1,400
    // No dropper cursor → token condition is rawTokensSinceDropCoverage ≥ 5 (msg-1 ≈ 50 tokens).
    // Pool: 2 obs × 700 = 1,400 / 100,000 = 1.4% ≥ 1% → dropper due.
    // Reflector is silenced by advancing its cursor past all entries.
    const entries = [
      {
        type: "message",
        id: "msg-1",
        message: {
          role: "user",
          content: [{ type: "text", text: "a".repeat(200) }],
        },
      },
      {
        type: "custom",
        id: "obs-1",
        customType: "om.observations.recorded",
        data: {
          coversUpToId: "msg-1",
          observations: [
            {
              id: "aaaaaaaaaaaa",
              content: "x".repeat(100),
              timestamp: "2026-08-01T00:00:00.000Z",
              relevance: "low",
              sourceEntryIds: ["msg-1"],
              tokenCount: 700,
            },
            {
              id: "bbbbbbbbbbbb",
              content: "y".repeat(100),
              timestamp: "2026-08-01T00:00:00.001Z",
              relevance: "medium",
              sourceEntryIds: ["msg-1"],
              tokenCount: 700,
            },
          ],
        },
      },
    ];
    runtime.advanceCursor("reflector", "obs-1", "skipped");
    expect(anyStageDue(entries, runtime, undefined)).toBe(true);
  });

  test("dropper NOT due when pool fullness is below the configured threshold", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const { anyStageDue } = await import("../src/om/consolidation.js");
    const runtime = new Runtime();
    runtime.config.observeAfterTokens = 100000;
    runtime.config.reflectAfterTokens = 5;
    runtime.config.observationsPoolMaxTokens = 100_000;
    runtime.config.dropperPoolFullnessThreshold = 0.05; // 5% — pool at 1.4%
    runtime.config.dropperPressureThreshold = 0.7;
    runtime.config.reflectorInputMaxTokens = 10_000; // pressure needs 7,000 — pool only has 1,400
    const entries = [
      {
        type: "message",
        id: "msg-1",
        message: {
          role: "user",
          content: [{ type: "text", text: "a".repeat(200) }],
        },
      },
      {
        type: "custom",
        id: "obs-1",
        customType: "om.observations.recorded",
        data: {
          coversUpToId: "msg-1",
          observations: [
            {
              id: "aaaaaaaaaaaa",
              content: "x".repeat(100),
              timestamp: "2026-08-01T00:00:00.000Z",
              relevance: "low",
              sourceEntryIds: ["msg-1"],
              tokenCount: 700,
            },
            {
              id: "bbbbbbbbbbbb",
              content: "y".repeat(100),
              timestamp: "2026-08-01T00:00:00.001Z",
              relevance: "medium",
              sourceEntryIds: ["msg-1"],
              tokenCount: 700,
            },
          ],
        },
      },
    ];
    runtime.advanceCursor("reflector", "obs-1", "skipped");
    expect(anyStageDue(entries, runtime, undefined)).toBe(false);
  });

  test("reflector due when new observation batches exist AND token threshold met", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const { anyStageDue } = await import("../src/om/consolidation.js");
    const runtime = new Runtime();
    runtime.config.observeAfterTokens = 100000;
    runtime.config.reflectAfterTokens = 10;
    runtime.config.observationsPoolMaxTokens = 100_000;
    runtime.config.dropperPressureThreshold = 0.7;
    runtime.config.reflectorInputMaxTokens = 500;
    // Cursor at msg-1, enough tokens after cursor (msg-2 has 200 chars ~50 tokens) + new obs batch → reflector due
    const entries = [
      {
        type: "message",
        id: "msg-1",
        message: {
          role: "user",
          content: [{ type: "text", text: "cursor here" }],
        },
      },
      {
        type: "message",
        id: "msg-2",
        message: {
          role: "user",
          content: [{ type: "text", text: "x".repeat(200) }],
        },
      },
      {
        type: "custom",
        id: "obs-2",
        customType: "om.observations.recorded",
        data: { observations: [] },
      },
    ];
    runtime.advanceCursor("reflector", "msg-1", "recorded");
    expect(anyStageDue(entries, runtime, undefined)).toBe(true);
  });

  test("reflector NOT due when new obs batch exists but token threshold NOT met", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const { anyStageDue } = await import("../src/om/consolidation.js");
    const runtime = new Runtime();
    runtime.config.observeAfterTokens = 100000;
    runtime.config.reflectAfterTokens = 500; // need 500 tokens
    runtime.config.observationsPoolMaxTokens = 100_000;
    runtime.config.dropperPressureThreshold = 0.7;
    runtime.config.reflectorInputMaxTokens = 500;
    // Cursor at msg-1, only 50 chars (~12 tokens) after cursor (msg-2) → below 500 threshold
    const entries = [
      {
        type: "message",
        id: "msg-1",
        message: {
          role: "user",
          content: [{ type: "text", text: "cursor here" }],
        },
      },
      {
        type: "message",
        id: "msg-2",
        message: { role: "user", content: [{ type: "text", text: "tiny" }] },
      },
      {
        type: "custom",
        id: "obs-2",
        customType: "om.observations.recorded",
        data: { observations: [] },
      },
    ];
    runtime.advanceCursor("reflector", "msg-1", "recorded");
    expect(anyStageDue(entries, runtime, undefined)).toBe(false);
  });
});

describe("anyStageDue with pending state (manual mode)", () => {
  test("reflector due when pending observation batch exists after cursor", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const { anyStageDue } = await import("../src/om/consolidation.js");
    const runtime = new Runtime();
    runtime.config.observeAfterTokens = 100000;
    runtime.config.reflectAfterTokens = 10;
    runtime.config.observationsPoolMaxTokens = 100_000;
    runtime.config.dropperPressureThreshold = 0.7;
    runtime.config.reflectorInputMaxTokens = 500;
    const entries = [
      {
        type: "message",
        id: "msg-1",
        message: {
          role: "user",
          content: [{ type: "text", text: "x".repeat(200) }],
        },
      },
      {
        type: "message",
        id: "msg-2",
        message: {
          role: "user",
          content: [{ type: "text", text: "x".repeat(200) }],
        },
      },
    ];
    runtime.advanceCursor("reflector", "msg-1", "recorded");
    const pending: any = {
      observationBatches: [{ coversUpToId: "msg-2", data: { observations: [] } }],
    };
    expect(anyStageDue(entries, runtime, pending)).toBe(true);
  });

  test("dropper due when pending pool exceeds threshold (manual mode)", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const { anyStageDue } = await import("../src/om/consolidation.js");
    const runtime = new Runtime();
    runtime.config.observeAfterTokens = 100000;
    runtime.config.reflectAfterTokens = 100000;
    runtime.config.observationsPoolMaxTokens = 1000;
    runtime.config.dropperPressureThreshold = 0.99;
    runtime.config.reflectorInputMaxTokens = 1000;
    // Branch has conversation entries (normal manual mode), no OM markers.
    const entries = [
      {
        type: "message",
        id: "msg-1",
        message: {
          role: "user",
          content: [{ type: "text", text: "x".repeat(200) }],
        },
      },
    ];
    const pending: any = {
      observationBatches: [
        {
          coversUpToId: "msg-1",
          data: {
            observations: [{ id: "o1", content: "x".repeat(500), tokenCount: 125 }],
          },
        },
      ],
    };
    // No cursors → rawTokensSinceDropCoverage on entries with conversation
    // → some tokens > 0.  Pool from pending: 125/1000 = 12.5% > 10%.
    // Both gates pass → dropper due.
    expect(anyStageDue(entries, runtime, pending)).toBe(true);
  });

  test("pipeline launches when observer not due but pending has new data for reflector", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const { anyStageDue } = await import("../src/om/consolidation.js");
    const runtime = new Runtime();
    runtime.config.observeAfterTokens = 100000;
    runtime.config.reflectAfterTokens = 5;
    runtime.config.observationsPoolMaxTokens = 100_000;
    runtime.config.dropperPressureThreshold = 0.99;
    runtime.config.reflectorInputMaxTokens = 500;
    // Observer cursor advanced past all entries → not due
    // Reflector cursor is behind (at msg-1), new batch at msg-2
    const entries = [
      {
        type: "message",
        id: "msg-1",
        message: { role: "user", content: [{ type: "text", text: "old" }] },
      },
      {
        type: "message",
        id: "msg-2",
        message: {
          role: "user",
          content: [{ type: "text", text: "new message after reflector cursor" }],
        },
      },
    ];
    runtime.advanceCursor("observer", "msg-2", "recorded"); // advanced past all
    runtime.advanceCursor("reflector", "msg-1", "recorded"); // still at msg-1
    // Pending has a NEW batch (coversUpToId after the reflector cursor)
    const pending: any = {
      observationBatches: [
        { coversUpToId: "msg-1", data: { observations: [] } }, // old, cursor is here
        {
          coversUpToId: "msg-2",
          data: {
            observations: [{ id: "o2", content: "fresh", tokenCount: 10 }],
          },
        }, // new!
      ],
    };
    // Reflector should see the new batch at msg-2 (after cursor at msg-1)
    expect(anyStageDue(entries, runtime, pending)).toBe(true);
  });

  test("reflector due when cursor state 'initial' and pending batch exists after cursor", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const { anyStageDue } = await import("../src/om/consolidation.js");
    const runtime = new Runtime();
    runtime.config.observeAfterTokens = 100000;
    runtime.config.reflectAfterTokens = 10;
    runtime.config.observationsPoolMaxTokens = 100_000;
    runtime.config.dropperPressureThreshold = 0.7;
    runtime.config.reflectorInputMaxTokens = 500;

    // Branch entries - cursor fell back to msg-1 coverage marker (state "initial")
    const entries = [
      {
        type: "message",
        id: "msg-1",
        message: {
          role: "user",
          content: [{ type: "text", text: "x".repeat(200) }],
        },
      },
      {
        type: "message",
        id: "msg-2",
        message: {
          role: "user",
          content: [{ type: "text", text: "x".repeat(200) }],
        },
      },
    ];
    runtime.advanceCursor("reflector", "msg-1", "initial");

    // Pending has a new batch at msg-2 (after cursor at msg-1)
    const pending: any = {
      observationBatches: [
        {
          coversUpToId: "msg-2",
          data: {
            observations: [
              {
                id: "a1b2c3d4e5f6",
                content: "fresh",
                timestamp: "2025-01-01T00:00:00Z",
                relevance: "medium",
                sourceEntryIds: ["msg-2"],
                tokenCount: 10,
              },
            ],
          },
        },
      ],
    };

    // Reflector should see new pending batch even when cursor.state is "initial"
    expect(anyStageDue(entries, runtime, pending)).toBe(true);
  });
});

describe("anyStageDue cursor vs branch-marker coversUpToId (auto mode)", () => {
  test("reflector NOT due: marker after cursor but coversUpToId IS the cursor entry", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const { anyStageDue } = await import("../src/om/consolidation.js");
    const runtime = new Runtime();
    runtime.config.observeAfterTokens = 100000;
    runtime.config.reflectAfterTokens = 10;
    runtime.config.observationsPoolMaxTokens = 100_000;
    runtime.config.dropperPressureThreshold = 0.7;
    runtime.config.reflectorInputMaxTokens = 500;

    // Cursor at msg-1. There's an OM_OBSERVATIONS_RECORDED marker AFTER msg-1
    // in the branch, but its coversUpToId IS msg-1 - data was already processed.
    const entries = [
      {
        type: "message",
        id: "msg-1",
        message: {
          role: "user",
          content: [{ type: "text", text: "x".repeat(200) }],
        },
      },
      {
        type: "custom",
        id: "obs-1",
        customType: "om.observations.recorded",
        data: {
          coversUpToId: "msg-1",
          observations: [{ id: "o1", content: "test", tokenCount: 10 }],
        },
      },
    ];
    runtime.advanceCursor("reflector", "msg-1", "empty");
    expect(anyStageDue(entries, runtime, undefined)).toBe(false);
  });

  test("reflector IS due: marker after cursor with coversUpToId truly past cursor", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const { anyStageDue } = await import("../src/om/consolidation.js");
    const runtime = new Runtime();
    runtime.config.observeAfterTokens = 100000;
    runtime.config.reflectAfterTokens = 10;
    runtime.config.observationsPoolMaxTokens = 100_000;
    runtime.config.dropperPressureThreshold = 0.7;
    runtime.config.reflectorInputMaxTokens = 500;

    // Cursor at msg-1. Marker's coversUpToId is msg-2 (truly after cursor) → new data.
    const entries = [
      {
        type: "message",
        id: "msg-1",
        message: {
          role: "user",
          content: [{ type: "text", text: "x".repeat(200) }],
        },
      },
      {
        type: "message",
        id: "msg-2",
        message: {
          role: "user",
          content: [{ type: "text", text: "x".repeat(200) }],
        },
      },
      {
        type: "custom",
        id: "obs-1",
        customType: "om.observations.recorded",
        data: {
          coversUpToId: "msg-2",
          observations: [{ id: "o1", content: "test", tokenCount: 10 }],
        },
      },
    ];
    runtime.advanceCursor("reflector", "msg-1", "empty");
    expect(anyStageDue(entries, runtime, undefined)).toBe(true);
  });

  test("dropper NOT due: marker after cursor but coversUpToId at cursor, pool too low", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const { anyStageDue } = await import("../src/om/consolidation.js");
    const runtime = new Runtime();
    runtime.config.observeAfterTokens = 100000;
    runtime.config.reflectAfterTokens = 100000;
    runtime.config.observationsPoolMaxTokens = 100_000;
    runtime.config.dropperPressureThreshold = 0.7;
    runtime.config.reflectorInputMaxTokens = 500;

    // Cursor at obs-1. Marker at obs-2 after it, but coversUpToId is obs-1.
    // Observer + reflector not due → dropper check runs.
    // Pool is tiny → below 10% → dropper NOT due.
    const entries = [
      {
        type: "custom",
        id: "obs-1",
        customType: "om.observations.recorded",
        data: {
          coversUpToId: "msg-0",
          observations: [{ id: "o1", content: "a", tokenCount: 1 }],
        },
      },
      {
        type: "custom",
        id: "obs-2",
        customType: "om.observations.recorded",
        data: {
          coversUpToId: "obs-1",
          observations: [{ id: "o2", content: "b", tokenCount: 1 }],
        },
      },
    ];
    runtime.advanceCursor("dropper", "obs-1", "empty");
    expect(anyStageDue(entries, runtime, undefined)).toBe(false);
  });

  test("dropper IS due: marker coversUpToId truly after cursor AND pool above threshold", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const { anyStageDue } = await import("../src/om/consolidation.js");
    const runtime = new Runtime();
    runtime.config.observeAfterTokens = 100000;
    runtime.config.reflectAfterTokens = 5; // low enough that 6 tokens (> msg-2) passes the guard
    runtime.config.observationsPoolMaxTokens = 1000;
    runtime.config.dropperPressureThreshold = 0.99;
    runtime.config.reflectorInputMaxTokens = 1000;

    // Cursor at msg-1, new obs batch at obs-1 with coversUpToId msg-2 (after cursor).
    // tokensSince ≈ 6 > reflectAfterTokens(5) → passes token guard.
    // Pool: 500 tokens / 1000 max = 50% > 10% → dropper due.
    const entries = [
      {
        type: "message",
        id: "msg-1",
        message: { role: "user", content: [{ type: "text", text: "old" }] },
      },
      {
        type: "message",
        id: "msg-2",
        message: {
          role: "user",
          content: [{ type: "text", text: "new data after cursor" }],
        },
      },
      {
        type: "custom",
        id: "obs-1",
        customType: "om.observations.recorded",
        data: {
          coversUpToId: "msg-2",
          observations: [
            {
              id: "a1b2c3d4e5f6",
              content: "x".repeat(2000),
              timestamp: "2025-01-01T00:00:00Z",
              relevance: "medium",
              sourceEntryIds: ["msg-2"],
              tokenCount: 500,
            },
          ],
        },
      },
    ];
    runtime.advanceCursor("dropper", "msg-1", "empty");
    expect(anyStageDue(entries, runtime, undefined)).toBe(true);
  });

  test("dropper NOT due: new batches exist after cursor but token threshold not met", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const { anyStageDue } = await import("../src/om/consolidation.js");
    const runtime = new Runtime();
    runtime.config.observeAfterTokens = 100000;
    runtime.config.reflectAfterTokens = 500; // need 500 tokens to pass guard
    runtime.config.observationsPoolMaxTokens = 1000;
    runtime.config.dropperPressureThreshold = 0.99;
    runtime.config.reflectorInputMaxTokens = 1000;

    // Cursor at msg-1. New obs batch at obs-1 with coversUpToId msg-2 (truly after cursor).
    // Pool: 500/1000 = 50% > 10%.
    // But only ~6 tokens since cursor < reflectAfterTokens(500) → dropper NOT due.
    const entries = [
      {
        type: "message",
        id: "msg-1",
        message: { role: "user", content: [{ type: "text", text: "old" }] },
      },
      {
        type: "message",
        id: "msg-2",
        message: {
          role: "user",
          content: [{ type: "text", text: "new data after cursor" }],
        },
      },
      {
        type: "custom",
        id: "obs-1",
        customType: "om.observations.recorded",
        data: {
          coversUpToId: "msg-2",
          observations: [
            {
              id: "a1b2c3d4e5f6",
              content: "x".repeat(2000),
              timestamp: "2025-01-01T00:00:00Z",
              relevance: "medium",
              sourceEntryIds: ["msg-2"],
              tokenCount: 500,
            },
          ],
        },
      },
    ];
    runtime.advanceCursor("dropper", "msg-1", "empty");
    expect(anyStageDue(entries, runtime, undefined)).toBe(false);
  });
  test("reflector NOT due when state 'empty' and marker coversUpToId at cursor (exact production scenario)", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const { anyStageDue } = await import("../src/om/consolidation.js");
    const runtime = new Runtime();
    runtime.config.observeAfterTokens = 100000;
    runtime.config.reflectAfterTokens = 10;
    runtime.config.observationsPoolMaxTokens = 100_000;
    runtime.config.dropperPressureThreshold = 0.7;
    runtime.config.reflectorInputMaxTokens = 500;

    // Production scenario: cursor at source entry aea5b9b7 (state 'empty'),
    // observation marker 13c906d0 exists AFTER it but has coversUpToId: aea5b9b7.
    // The reflector already processed this data → should NOT be due.
    const entries = [
      {
        type: "message",
        id: "source-1",
        message: {
          role: "user",
          content: [{ type: "text", text: "x".repeat(200) }],
        },
      },
      {
        type: "custom",
        id: "ref-1",
        customType: "om.reflections.recorded",
        data: { coversUpToId: "first-obs", reflections: [] },
      },
      {
        type: "custom",
        id: "obs-1",
        customType: "om.observations.recorded",
        data: {
          coversUpToId: "source-1",
          observations: [{ id: "o1", content: "test", tokenCount: 10 }],
        },
      },
    ];
    runtime.advanceCursor("reflector", "source-1", "empty");
    expect(anyStageDue(entries, runtime, undefined)).toBe(false);
  });
});

describe("observer zero-chunk backoff", () => {
  /**
   * TDD validation: Can the zero-chunk observer re-fire bug manifest in our codebase?
   *
   * Analysis: The upstream test (PR #57) uses getContextUsage() to report provider-
   * reported token growth, making the observer due despite zero source tokens.
   * Our codebase does NOT have getContextUsage — we only check source entry tokens
   * via rawTokensAfterIndex(). This means:
   *
   * - Zero-chunk entries (empty content) = 0 source tokens
   * - Observer is due only when source tokens >= observeAfterTokens
   * - These are contradictory: you can't be due AND have zero tokens
   *
   * Therefore: the zero-chunk re-fire bug CANNOT manifest in our current architecture.
   * The observer never runs on zero-token entries, so it never re-fires on them.
   *
   * Verdict: Fix 3 (zero-chunk backoff) is NOT needed for our codebase.
   * The upstream only needs it because they have getContextUsage-based triggering.
   */
  test("zero-chunk re-fire bug cannot manifest — observer not due on zero-token entries", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const { anyStageDue } = await import("../src/om/consolidation.js");
    const { observationsRecordedEntry, rawMessage } = await import("../tests/fixtures/session.js");

    const runtime = new Runtime();
    runtime.config.observeAfterTokens = 5;
    runtime.config.reflectAfterTokens = 999999;
    runtime.config.observationsPoolMaxTokens = 1000;
    runtime.config.dropperPressureThreshold = 0.7;
    runtime.config.reflectorInputMaxTokens = 500;

    // Entries: raw-1 (10 tokens) + raw-2 (assistant with EMPTY content = 0 tokens) + obs-marker
    // Cursor at raw-1 → rawTokensAfterIndex counts 0 tokens from raw-2
    const entries = [
      rawMessage("raw-1", "a".repeat(40)), // ~10 tokens
      rawMessage("raw-2", "", {
        message: { role: "assistant", content: [], stopReason: "end_turn" },
      }),
      observationsRecordedEntry("obs-marker", {
        observations: [{ id: "o1", content: "test", tokenCount: 10 }],
        coversUpToId: "raw-1",
      }),
    ];

    // Cursor at raw-1 (index 0)
    runtime.advanceCursor("observer", "raw-1", "recorded");

    // Observer should NOT be due — rawTokensAfterIndex from cursor = 0 tokens
    expect(anyStageDue(entries, runtime, undefined)).toBe(false);
  });
});

// ── Repeated pipeline cycles over append-only source entries ────────────────

interface PipelineFixture {
  runtime: Runtime;
  entries: TestEntry[];
  run(): Promise<void>;
  start(): void;
  launch(): Promise<void>;
}

/**
 * Full `runConsolidationPipeline` fixture with stubbed workers and model
 * resolution. Only the observer is configured below threshold, so each cycle
 * exercises real cursor resolution, coverage measurement and cursor advance
 * without reflect/drop work.
 */
function makePipelineFixture(options: {
  observeAfterTokens: number;
  runtime?: Runtime;
  entries?: TestEntry[];
}): PipelineFixture {
  const runtime = options.runtime ?? new Runtime();
  runtime.configLoaded = true;
  runtime.config.memory = true;
  runtime.config.observeAfterTokens = options.observeAfterTokens;
  runtime.config.reflectAfterTokens = 1_000_000;
  runtime.resolveModel = async () => ({
    ok: true as const,
    model: { provider: "test", id: "model", contextWindow: 1_000_000 },
    apiKey: "test",
  });
  const entries = options.entries ?? [];
  const pi = createExtensionApiDouble({
    appendEntry: (customType, data) => {
      entries.push({
        type: "custom",
        id: `appended-${entries.length}`,
        parentId: entries.at(-1)?.id ?? null,
        timestamp: "2026-05-02T10:00:00.000Z",
        customType,
        data,
      });
    },
  });
  const ctx = {
    cwd: "/tmp",
    hasUI: false,
    model: undefined,
    modelRegistry: {},
    sessionManager: {
      getBranch: () => entries,
      getSessionId: () => "cursor-session",
      getSessionDir: () => "/tmp",
    },
  };
  return {
    runtime,
    entries,
    run: async () => {
      await runConsolidationPipeline(pi, runtime, ctx, runtime.captureGeneration("cursor-session"));
    },
    start: () => {
      maybeLaunchConsolidation(pi, runtime, ctx);
    },
    launch: async () => {
      maybeLaunchConsolidation(pi, runtime, ctx);
      const task = runtime.consolidationPromise;
      if (!task) throw new Error("catch-up was not launched");
      await task;
    },
  };
}

/** One pipeline observer call input, failing loudly when the call never happened. */
function observerChunkArg(callIndex = 0): ObserverAgentInput {
  const call = agents.runObserver.mock.calls[callIndex];
  if (!call) {
    throw new Error(`observer ran ${agents.runObserver.mock.calls.length} time(s)`);
  }
  return call[0];
}

const smallSource = (id: string) => rawMessage(id, `SMALL-${id} ${"x".repeat(120)}`);
const catchUpEntries = (...ids: string[]) => [
  ...ids.map(smallSource),
  compactionEntry("compact", { firstKeptEntryId: ids.at(-1), summary: "folded" }),
];
function launchCtx(entries: TestEntry[], notify?: ReturnType<typeof vi.fn>): ConsolidationCtx {
  return {
    cwd: "/tmp",
    hasUI: !!notify,
    ui: notify ? { notify } : undefined,
    model: undefined,
    modelRegistry: {},
    sessionManager: {
      getBranch: () => entries,
      getSessionId: () => "cursor-session",
      getSessionDir: () => "/tmp",
    },
  };
}
function appendCatchUpJob(
  entries: TestEntry[],
  compactionId: string,
  fromId: string,
  throughId: string,
) {
  entries.push({
    type: "custom",
    id: `job-${compactionId}`,
    parentId: entries.at(-1)?.id ?? null,
    timestamp: "2026-05-02T10:00:00.000Z",
    customType: "om.observer.catch-up.job",
    data: { version: 1, compactionId, fromId, throughId },
  });
}

function recordObservations(input: ObserverAgentInput) {
  const firstSourceId = input.allowedSourceEntryIds[0];
  if (!firstSourceId) throw new Error("observer received no source IDs");
  return {
    observations: [
      {
        id: `aaaa${firstSourceId.padEnd(8, "a").slice(0, 8)}`,
        content: "fact",
        timestamp: "2026-05-02T10:00:00.000Z",
        relevance: "medium" as const,
        sourceEntryIds: input.allowedSourceEntryIds,
        tokenCount: 1,
      },
    ],
  };
}

function catchUpFixture(entries: TestEntry[], through: string, from = through, cap?: number) {
  const fixture = makePipelineFixture({ observeAfterTokens: 5_000, entries });
  if (cap !== undefined) fixture.runtime.config.observerChunkMaxTokens = cap;
  appendCatchUpJob(entries, "compact", from, through);
  return fixture;
}

beforeEach(() => {
  agents.runObserver.mockReset();
  agents.runObserver.mockResolvedValue({
    observations: [],
    emptyReason: { kind: "no_new_content" },
  });
  agents.runReflector.mockReset();
  agents.runDropper.mockReset();
});
afterEach(() => {
  rmSync(cursorTestDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("branch-local observer catch-up jobs", () => {
  test("a newest-first manual batch cannot hide older queued sources", async () => {
    const entries = catchUpEntries("older", "summary");
    const fixture = catchUpFixture(entries, "summary", "older");
    fixture.runtime.config.compaction = "manual";
    const { savePendingObservation } = await import("../src/om/pending.js");
    savePendingObservation("cursor-session", {
      coversUpToId: "summary",
      data: { observations: [] },
    });
    agents.runObserver.mockResolvedValue({
      observations: [],
      emptyReason: { kind: "no_new_content" },
    });
    await fixture.run();
    expect(observerChunkArg().allowedSourceEntryIds).toEqual(["older", "summary"]);
  });
  test("runs a post-compaction job without blocking launch and records completion in history", async () => {
    const entries = catchUpEntries("summary");
    const fixture = catchUpFixture(entries, "summary");
    agents.runObserver.mockImplementation(async (input) => recordObservations(input));

    fixture.start();
    expect(agents.runObserver).not.toHaveBeenCalled();
    await fixture.runtime.consolidationPromise;

    expect(observerChunkArg().allowedSourceEntryIds).toEqual(["summary"]);
    expect(
      entries.filter((entry) => entry.customType === "om.observer.catch-up.progress").at(-1)?.data,
    ).toEqual({
      version: 1,
      compactionId: "compact",
      complete: true,
    });
    expect(readPendingStateRaw("cursor-session").observerCatchUpRanges).toBeUndefined();
  });

  test("drains bounded CJK slices oldest-first and resumes from history after restart", async () => {
    const entries = [
      rawMessage("huge", `START-${"中".repeat(400)}-END`),
      smallSource("summary"),
      compactionEntry("compact", { firstKeptEntryId: "summary", summary: "folded" }),
    ];
    const first = catchUpFixture(entries, "summary", "huge", 40);
    let calls = 0;
    agents.runObserver.mockImplementation(async (input) => {
      calls += 1;
      if (calls === 1) return recordObservations(input);
      throw new Error("stop after persisted slice");
    });
    await first.run();
    const firstProgress = entries.find(
      (entry) => entry.customType === "om.observer.catch-up.progress",
    );
    if (
      !firstProgress ||
      typeof firstProgress.data !== "object" ||
      firstProgress.data === null ||
      !("nextSourceId" in firstProgress.data) ||
      !("offset" in firstProgress.data)
    ) {
      throw new Error("missing persisted source-slice progress");
    }
    expect(firstProgress.data.nextSourceId).toBe("huge");
    expect(firstProgress.data.offset).toBeGreaterThan(0);

    agents.runObserver.mockImplementation(async (input) => recordObservations(input));
    const resumed = makePipelineFixture({ observeAfterTokens: 5_000, entries });
    resumed.runtime.config.observerChunkMaxTokens = 40;
    await resumed.launch();

    expect(
      agents.runObserver.mock.calls.every(([input]) => estimateStringTokens(input.chunk) <= 40),
    ).toBe(true);
    expect(agents.runObserver.mock.calls.at(-1)?.[0].allowedSourceEntryIds).toEqual(["summary"]);
    expect(
      entries.filter((entry) => entry.customType === "om.observer.catch-up.progress").at(-1)?.data,
    ).toEqual({
      version: 1,
      compactionId: "compact",
      complete: true,
    });
  });

  test("completes a job offered to an observer that returns no observations", async () => {
    const entries = catchUpEntries("summary");
    const fixture = catchUpFixture(entries, "summary");
    agents.runObserver.mockResolvedValue({
      observations: [],
      emptyReason: { kind: "no_new_content" },
    });

    await fixture.run();

    expect(agents.runObserver).toHaveBeenCalledTimes(1);
    expect(unfinishedObserverCatchUps(entries)).toEqual([]);
  });

  test("retains work after a model failure without a same-cycle fallback call", async () => {
    const entries = catchUpEntries("summary");
    const fixture = catchUpFixture(entries, "summary");
    agents.runObserver.mockImplementation(async () => {
      fixture.runtime.resolveModel = async () => ({ ok: false, reason: "provider unavailable" });
      throw new Error("provider unavailable");
    });

    await fixture.run();

    expect(agents.runObserver).toHaveBeenCalledTimes(1);
    expect(
      entries.filter((entry) => entry.customType === "om.observer.catch-up.progress"),
    ).toHaveLength(0);
  });

  test("retains work after a progress append failure without a same-cycle retry", async () => {
    const entries = catchUpEntries("summary");
    appendCatchUpJob(entries, "compact", "summary", "summary");
    const runtime = new Runtime();
    runtime.config.memory = true;
    runtime.config.observeAfterTokens = 5_000;
    runtime.config.reflectAfterTokens = 1_000_000;
    runtime.resolveModel = async () => ({
      ok: true as const,
      model: { provider: "test", id: "model", contextWindow: 1_000_000 },
      apiKey: "test",
    });
    agents.runObserver.mockImplementation(async (input) => recordObservations(input));
    const pi = createExtensionApiDouble({
      appendEntry: (customType, data) => {
        if (customType === "om.observer.catch-up.progress") {
          throw new Error("progress write failed");
        }
        entries.push({
          type: "custom",
          id: `appended-${entries.length}`,
          parentId: entries.at(-1)?.id ?? null,
          timestamp: "2026-05-02T10:00:00.000Z",
          customType,
          data,
        });
      },
    });

    await runConsolidationPipeline(
      pi,
      runtime,
      launchCtx(entries),
      runtime.captureGeneration("cursor-session"),
    );

    expect(agents.runObserver).toHaveBeenCalledTimes(1);
    expect(
      entries.filter((entry) => entry.customType === "om.observer.catch-up.progress"),
    ).toHaveLength(0);
    expect(runtime.lastObserverError).toContain("progress write failed");
  });

  test("runs reflector once after all queued observer chunks have drained", async () => {
    const entries = ["a", "b", "c"].map((id) => rawMessage(id, id + "x".repeat(200)));
    const first = entries[0];
    if (!first) throw new Error("missing first source");
    const cap = estimateStringTokens(serializeSourceAddressedBranchEntries([first]).text);
    const fixture = catchUpFixture(entries, "c", "a", cap);
    fixture.runtime.config.reflectAfterTokens = 1;
    const order: string[] = [];
    agents.runObserver.mockImplementation(async (input) => {
      order.push(`observe:${input.allowedSourceEntryIds.join(",")}`);
      return recordObservations(input);
    });
    agents.runReflector.mockImplementation(async () => {
      order.push("reflect");
      return [];
    });
    await fixture.launch();
    expect(order).toEqual(["observe:a", "observe:b", "observe:c", "reflect"]);
  });

  test("packs whole serialized sources before slicing", async () => {
    const sources = ["a", "b", "c"].map((id) => rawMessage(id.repeat(44), "x"));
    const [first, second, last] = sources;
    if (!first || !second || !last) throw new Error("missing test source");
    const expected = serializeSourceAddressedBranchEntries([first, second]);
    const cap = estimateStringTokens(expected.text);
    const fixture = catchUpFixture(sources, last.id, first.id, cap);
    await fixture.launch();
    expect(observerChunkArg()).toMatchObject({
      chunk: expected.text,
      allowedSourceEntryIds: expected.sourceEntryIds,
      sourceEntryTimestamps: expected.sourceEntryTimestamps,
    });
    expect(
      agents.runObserver.mock.calls.every(([input]) => estimateStringTokens(input.chunk) <= cap),
    ).toBe(true);
  });

  test("non-renderable sources cannot strand subsequent queued sources", async () => {
    const entries = [
      rawMessage("hidden", "", {
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "redacted", redacted: true }],
        },
      }),
      smallSource("summary"),
    ];
    const fixture = catchUpFixture(entries, "summary", "hidden", 40);
    await fixture.launch();
    expect(observerChunkArg().allowedSourceEntryIds).toEqual(["summary"]);
    expect(unfinishedObserverCatchUps(entries)).toEqual([]);
  });

  test("retains a job when no model can fit a source header", async () => {
    const entries = catchUpEntries("summary");
    const fixture = catchUpFixture(entries, "summary", "summary", 1);
    await fixture.run();
    expect(agents.runObserver).not.toHaveBeenCalled();
    expect(unfinishedObserverCatchUps(entries)).toHaveLength(1);
  });

  test("uses the existing model fallback for a failed observer call", async () => {
    const entries = catchUpEntries("summary");
    const fixture = catchUpFixture(entries, "summary");
    agents.runObserver.mockRejectedValueOnce(new Error("temporary provider error"));
    await fixture.run();
    expect(agents.runObserver).toHaveBeenCalledTimes(2);
    expect(unfinishedObserverCatchUps(entries)).toEqual([]);
  });

  test("keeps a missing job unresolved and warns instead of reanchoring it", async () => {
    const entries: TestEntry[] = [smallSource("visible")];
    appendCatchUpJob(entries, "missing", "gone", "gone");
    const fixture = makePipelineFixture({ observeAfterTokens: 5_000, entries });
    const notify = vi.fn();

    maybeLaunchConsolidation(
      createExtensionApiDouble(),
      fixture.runtime,
      launchCtx(entries, notify),
    );

    await fixture.runtime.consolidationPromise;
    expect(agents.runObserver).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("source is missing"), "warning");
    expect(
      entries.find((entry) => entry.customType === "om.observer.catch-up.job")?.data,
    ).toMatchObject({
      fromId: "gone",
      throughId: "gone",
    });
  });

  test("resolves only jobs on the current branch and preserves jobs before a fork point", async () => {
    const shared: TestEntry[] = [smallSource("shared")];
    appendCatchUpJob(shared, "before", "shared", "shared");
    const afterJob = [...shared, smallSource("after")];
    appendCatchUpJob(afterJob, "after", "after", "after");
    const beforeFork = shared;

    const { unfinishedObserverCatchUps } = await import("../src/om/ledger/index.js");
    expect(unfinishedObserverCatchUps(afterJob).map(({ job }) => job.compactionId)).toEqual([
      "before",
      "after",
    ]);
    expect(unfinishedObserverCatchUps(beforeFork).map(({ job }) => job.compactionId)).toEqual([
      "before",
    ]);
  });

  test("completion on a child path does not complete its sibling job", async () => {
    const base: TestEntry[] = [smallSource("shared")];
    appendCatchUpJob(base, "before", "shared", "shared");
    const completedChild = [
      ...base,
      {
        type: "custom" as const,
        id: "done-before",
        parentId: "job-before",
        timestamp: "2026-05-02T10:00:00.000Z",
        customType: "om.observer.catch-up.progress",
        data: { version: 1, compactionId: "before", complete: true },
      },
    ];
    const { unfinishedObserverCatchUps } = await import("../src/om/ledger/index.js");
    expect(unfinishedObserverCatchUps(completedChild)).toEqual([]);
    expect(unfinishedObserverCatchUps(base).map(({ job }) => job.compactionId)).toEqual(["before"]);
  });

  test("real SessionManager forks retain only jobs on the copied path", () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "pi-blackhole-catch-up-fork-"));
    try {
      const manager = SessionManager.create("/tmp", sessionDir);
      const sourceId = manager.appendMessage({
        role: "user",
        content: "PRE-COMPACTION-SOURCE",
        timestamp: Date.now(),
      });
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "assistant response" }],
        timestamp: Date.now(),
      });
      const compactionId = manager.appendCompaction("folded", sourceId, 1);
      const jobId = manager.appendCustomEntry("om.observer.catch-up.job", {
        version: 1,
        compactionId,
        fromId: sourceId,
        throughId: sourceId,
      });
      const original = manager.getSessionFile();
      if (!original) throw new Error("expected persisted source session");
      const beforeJob = SessionManager.open(original, sessionDir).createBranchedSession(
        compactionId,
      );
      const afterJob = SessionManager.open(original, sessionDir).createBranchedSession(jobId);
      if (!beforeJob || !afterJob) throw new Error("expected persisted fork paths");

      const beforeBranch = SessionManager.open(beforeJob, sessionDir).getBranch();
      const afterBranch = SessionManager.open(afterJob, sessionDir).getBranch();
      expect(beforeBranch.some((entry) => entry.id === sourceId)).toBe(true);
      expect(unfinishedObserverCatchUps(beforeBranch)).toEqual([]);
      expect(unfinishedObserverCatchUps(afterBranch).map(({ job }) => job.compactionId)).toEqual([
        compactionId,
      ]);
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  test("tree-navigation invalidation prevents a deferred observer from appending to a new leaf", async () => {
    const branchA = catchUpEntries("a");
    appendCatchUpJob(branchA, "compact", "a", "a");
    const branchB = catchUpEntries("b");
    appendCatchUpJob(branchB, "compact-b", "b", "b");
    let current = branchA;
    const runtime = new Runtime();
    runtime.config.memory = true;
    runtime.config.observeAfterTokens = 1;
    runtime.startSession("tree-session");
    let release: (() => void) | undefined;
    agents.runObserver.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve(
              recordObservations({
                chunk: "",
                allowedSourceEntryIds: ["a"],
                priorObservations: [],
                priorReflections: [],
              }),
            );
        }),
    );
    const appended: string[] = [];
    const ctx = launchCtx(current);
    ctx.sessionManager.getBranch = () => current;
    ctx.sessionManager.getSessionId = () => "tree-session";
    const stage = runObserverStage(
      createExtensionApiDouble({ appendEntry: (type) => appended.push(type) }),
      runtime,
      ctx,
      runtime.captureGeneration("tree-session"),
      async () => ({
        ok: true,
        model: { provider: "test", id: "model", contextWindow: 1_000_000 },
        apiKey: "test",
      }),
      undefined,
    );
    await vi.waitFor(() => expect(agents.runObserver).toHaveBeenCalledTimes(1));
    current = branchB;
    runtime.invalidateSessionTree();
    if (!release) throw new Error("observer did not start");
    release();

    await expect(stage).resolves.toBe("abort");
    expect(appended).toEqual([]);
  });

  test("legacy sidecar migration is read-only and a history job suppresses replay on its path", async () => {
    const dir = join(cursorTestDir, "pi-blackhole");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "cursor-session-pending.json"),
      JSON.stringify({ observerCatchUpRanges: [{ throughId: "summary", fromId: "summary" }] }),
    );
    const entries = catchUpEntries("summary");
    const fixture = makePipelineFixture({ observeAfterTokens: 5_000, entries });
    agents.runObserver.mockImplementation(async (input) => recordObservations(input));

    await fixture.launch();

    expect(
      entries.find((entry) => entry.customType === "om.observer.catch-up.job")?.data,
    ).toMatchObject({
      compactionId: "legacy:unscoped:summary",
      fromId: "summary",
    });
    expect(readPendingStateRaw("cursor-session").observerCatchUpRanges).toEqual([
      { throughId: "summary", fromId: "summary", branchId: undefined, offset: undefined },
    ]);
  });
});

describe("catch-up with persisted SessionManager history", () => {
  let sessionDir: string;
  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), "blackhole-history-"));
  });
  afterEach(() => {
    rmSync(sessionDir, { recursive: true, force: true });
  });

  function history(manager = SessionManager.create("/tmp", sessionDir)) {
    if (!manager.getBranch().length)
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "ready" }],
        api: "openai-completions",
        provider: "test",
        model: "test",
        stopReason: "stop",
        timestamp: 0,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      });
    const runtime = makePipelineFixture({ observeAfterTokens: 999_999 }).runtime;
    runtime.config.usageLog = false;
    runtime.startSession(manager.getSessionId());
    const pi = createExtensionApiDouble({
      appendEntry: (type, data) => manager.appendCustomEntry(type, data),
    });
    const notify = vi.fn();
    const ctx: ConsolidationCtx = { ...launchCtx([], notify), sessionManager: manager };
    const file = manager.getSessionFile();
    if (!file) throw new Error("expected a persisted session");
    return {
      manager,
      runtime,
      pi,
      ctx,
      file,
      notify,
      source: (content: string) => manager.appendMessage({ role: "user", content, timestamp: 0 }),
      queue(fromId: string, throughId = fromId) {
        const compactionId = manager.appendCompaction("folded", undefined, 1);
        const entryId = manager.appendCustomEntry("om.observer.catch-up.job", {
          version: 1,
          compactionId,
          fromId,
          throughId,
        });
        return { compactionId, entryId };
      },
      async run() {
        maybeLaunchConsolidation(pi, runtime, ctx);
        await runtime.consolidationPromise;
      },
      pending: () => unfinishedObserverCatchUps(manager.getBranch()),
    };
  }

  test("keeps sources and job progress through repeated compactions with no new source", async () => {
    const h = history();
    const first = h.source("OLDER-CAPPED-SOURCE");
    const last = h.source("RECENT-SOURCE");
    h.runtime.advanceCursor("observer", last, "recorded");
    h.queue(first, last);
    h.manager.appendCompaction("later", undefined, 1);
    expect(JSON.stringify(h.manager.buildSessionContext().messages)).not.toContain(
      "OLDER-CAPPED-SOURCE",
    );
    await h.run();
    expect(observerChunkArg().allowedSourceEntryIds).toEqual([first, last]);
    expect(h.pending()).toEqual([]);
  });

  test.each(["auto", "manual"] as const)(
    "restarts bounded CJK/emoji slices from disk in %s mode without gaps",
    async (mode) => {
      const h = history();
      h.runtime.config.compaction = mode;
      h.runtime.config.observerChunkMaxTokens = 40;
      const source = h.source("START-" + "中😀".repeat(100) + "-END");
      h.queue(source);
      agents.runObserver.mockImplementationOnce(async () => {
        h.runtime.resolveModel = async () => ({ ok: false, reason: "interrupt after checkpoint" });
        return { observations: [], emptyReason: { kind: "no_new_content" } };
      });
      await h.run();
      expect(h.pending()[0]?.progress?.offset).toBeGreaterThan(0);
      const resumed = history(SessionManager.open(h.file, sessionDir));
      resumed.runtime.config.compaction = mode;
      resumed.runtime.config.observerChunkMaxTokens = 40;
      await resumed.run();
      const sourceEntry = resumed.manager.getEntry(source);
      if (!sourceEntry) throw new Error("source was lost");
      const serialized = serializeSourceAddressedBranchEntries([sourceEntry]).text;
      const prefixLength = serialized.indexOf("\n") + 1;
      const chunks = agents.runObserver.mock.calls.map(([input]) => input.chunk);
      expect(chunks.map((chunk) => chunk.slice(prefixLength)).join("")).toBe(
        serialized.slice(prefixLength),
      );
      expect(
        chunks.every(
          (chunk) => estimateStringTokens(chunk) <= 40 && !/[\uD800-\uDBFF]$/.test(chunk),
        ),
      ).toBe(true);
      expect(resumed.pending()).toEqual([]);
    },
  );

  test("forks copy pending work but not a sibling's later completion", async () => {
    const h = history();
    const source = h.source("FORKED-WORK");
    const job = h.queue(source);
    const forkManager = SessionManager.open(h.file, sessionDir);
    forkManager.createBranchedSession(job.entryId);
    const fork = history(forkManager);
    expect(fork.manager.getSessionId()).not.toBe(h.manager.getSessionId());
    await fork.run();
    expect(fork.pending()).toEqual([]);
    expect(h.pending()).toHaveLength(1);
    await h.run();
    expect(agents.runObserver.mock.calls.map(([input]) => input.allowedSourceEntryIds)).toEqual([
      [source],
      [source],
    ]);
  });

  test("manual pending-write failure retains the catch-up job on disk", async () => {
    const h = history();
    h.runtime.config.compaction = "manual";
    const source = h.source("MANUAL-PENDING-WRITE-FAILURE");
    h.queue(source);
    agents.runObserver.mockImplementation(async (input) => recordObservations(input));
    const dir = join(cursorTestDir, "pi-blackhole");
    const pendingFile = join(dir, `${h.manager.getSessionId()}-pending.json`);
    const staleFile = join(dir, `${h.manager.getSessionId()}-pending.stale.json`);
    // Both destinations must be blocked: otherwise the old writer moves the
    // directory to .stale and successfully creates a new pending file.
    mkdirSync(pendingFile, { recursive: true });
    mkdirSync(staleFile);
    writeFileSync(join(staleFile, "block-rename"), "occupied");
    try {
      await h.run();
      expect(
        unfinishedObserverCatchUps(SessionManager.open(h.file, sessionDir).getBranch()),
      ).toHaveLength(1);
      expect(agents.runObserver).toHaveBeenCalledTimes(1);
      expect(h.notify).toHaveBeenCalledWith(
        expect.stringContaining("Observational memory: observer failed:"),
        "warning",
      );
    } finally {
      rmSync(pendingFile, { recursive: true, force: true });
      rmSync(staleFile, { recursive: true, force: true });
    }
    const resumed = history(SessionManager.open(h.file, sessionDir));
    resumed.runtime.config.compaction = "manual";
    await resumed.run();
    expect(resumed.pending()).toEqual([]);
    expect(readPendingStateRaw(resumed.manager.getSessionId()).observationBatches).toHaveLength(1);
  });

  test.each([
    ["reflector", "save"],
    ["dropper", "save"],
    ["reflector", "model"],
    ["dropper", "model"],
  ] as const)("manual %s retries only model failures (%s error)", async (stage, failure) => {
    const h = history();
    h.runtime.config.compaction = "manual";
    h.runtime.config.reflectAfterTokens = 1;
    h.runtime.config.observationsPoolMaxTokens = 1;
    const source = h.source("MANUAL-STAGE-WRITE-FAILURE");
    const sessionId = h.manager.getSessionId();
    const obs = observation("aaaaaaaaaaaa", { sourceEntryIds: [source] });
    const ref = reflection("bbbbbbbbbbbb", [obs.id]);
    const { savePendingObservation, savePendingReflection } = await import("../src/om/pending.js");
    savePendingObservation(sessionId, { coversUpToId: source, data: { observations: [obs] } });
    // Skip the reflector in the dropper case so its save is the first failure.
    if (stage === "dropper")
      savePendingReflection(sessionId, { coversUpToId: source, data: { reflections: [ref] } });
    const before = readPendingStateRaw(sessionId);
    const pendingFile = join(cursorTestDir, "pi-blackhole", `${sessionId}-pending.json`);
    const savedFile = pendingFile + ".saved";
    const agent = stage === "reflector" ? agents.runReflector : agents.runDropper;
    const result = stage === "reflector" ? [ref] : [obs.id];
    agent.mockResolvedValue(result);
    if (failure === "model") agent.mockRejectedValueOnce(new Error("model unavailable"));
    else
      agent.mockImplementationOnce(async () => {
        // Block persistence only after the stage has read its required inputs.
        renameSync(pendingFile, savedFile);
        mkdirSync(pendingFile);
        return result;
      });
    const modelFailure = vi.spyOn(h.runtime, "recordRetryableError");
    try {
      await h.run();
      expect(agent).toHaveBeenCalledTimes(failure === "save" ? 1 : 2);
      if (failure === "save") {
        expect(modelFailure).not.toHaveBeenCalled();
        expect(h.notify).toHaveBeenCalledWith(
          expect.stringContaining(`Observational memory: ${stage} failed:`),
          "warning",
        );
        expect(h.runtime.cursors[stage]?.state).not.toBe("recorded");
      } else {
        expect(modelFailure).toHaveBeenCalledTimes(1);
        expect(h.runtime.cursors[stage]?.state).toBe("recorded");
      }
    } finally {
      modelFailure.mockRestore();
      if (existsSync(savedFile)) {
        rmSync(pendingFile, { recursive: true, force: true });
        renameSync(savedFile, pendingFile);
      }
    }
    if (failure === "save") expect(readPendingStateRaw(sessionId)).toEqual(before);
  });

  test.each(["empty", "observations"])(
    "pauses after a real failed %s progress write and resumes from disk",
    async (outcome) => {
      const h = history();
      const source = h.source("DISK-FAILURE-WORK");
      h.queue(source);
      if (outcome === "observations")
        agents.runObserver.mockImplementation(async (input) => recordObservations(input));
      const append = h.pi.appendEntry;
      h.pi.appendEntry = (type, data) => {
        if (type !== "om.observer.catch-up.progress") return append(type, data);
        // Exercise Pi's actual append-before-persist behavior, not a pre-append throw.
        renameSync(h.file, h.file + ".backup");
        mkdirSync(h.file);
        try {
          append(type, data);
        } finally {
          rmSync(h.file, { recursive: true });
          renameSync(h.file + ".backup", h.file);
        }
      };
      await h.run();
      expect(h.runtime.memoryWritesPaused).toBe(true);
      expect(h.notify).toHaveBeenCalledWith(
        expect.stringContaining("reopen the session from disk"),
        "warning",
      );
      expect(h.pending()).toEqual([]); // Pi's phantom in-memory completion is NOT durable.
      const resumed = history(SessionManager.open(h.file, sessionDir));
      expect(resumed.pending()).toHaveLength(1);
      h.runtime.lastConsolidationErrorAt = undefined;
      await h.run();
      expect(agents.runObserver).toHaveBeenCalledTimes(1);
      await resumed.run();
      expect(agents.runObserver).toHaveBeenCalledTimes(2);
      expect(resumed.pending()).toEqual([]);
    },
  );

  test.each(["start", "end", "progress"])(
    "keeps a missing %s checkpoint unresolved on disk",
    async (missing) => {
      const h = history();
      const source = h.source("REACHABLE");
      const { compactionId } = h.queue(
        missing === "start" ? "absent" : source,
        missing === "end" ? "absent" : source,
      );
      if (missing === "progress")
        h.manager.appendCustomEntry("om.observer.catch-up.progress", {
          version: 1,
          compactionId,
          nextSourceId: "absent",
        });
      const before = h.manager.getBranch();
      await h.run();
      expect(agents.runObserver).not.toHaveBeenCalled();
      expect(h.notify).toHaveBeenCalledWith(
        expect.stringContaining("source is missing"),
        "warning",
      );
      expect(SessionManager.open(h.file, sessionDir).getBranch()).toEqual(before);
      expect(h.pending()).toHaveLength(1);
    },
  );

  test.each(["start", "end", "progress"])(
    "an unreachable %s does not block a later valid job",
    async (missing) => {
      const h = history();
      const source = h.source("LATER-VALID-WORK");
      const bad = h.queue(
        missing === "start" ? "absent" : source,
        missing === "end" ? "absent" : source,
      );
      if (missing === "progress")
        h.manager.appendCustomEntry("om.observer.catch-up.progress", {
          version: 1,
          compactionId: bad.compactionId,
          nextSourceId: "absent",
        });
      h.queue(source);
      await h.run();
      expect(observerChunkArg().allowedSourceEntryIds).toEqual([source]);
      expect(h.pending().map(({ job }) => job.compactionId)).toEqual([bad.compactionId]);
    },
  );

  test("warns once for unchanged unreachable work even after retry cooldown expires", async () => {
    const h = history();
    h.queue("absent");
    await h.run();
    h.runtime.lastConsolidationErrorAt = undefined;
    await h.run();
    expect(
      h.notify.mock.calls.filter(([message]) => message.includes("source is missing")),
    ).toHaveLength(1);
  });

  test("an in-flight task hands off to queued work once it settles", async () => {
    const h = history();
    let release: () => void = () => {
      throw new Error("gate not armed");
    };
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prior = h.runtime.launchConsolidationTask(h.ctx, () => gate);
    const source = h.source("QUEUED-DURING-RUN");
    h.queue(source);
    maybeLaunchConsolidation(h.pi, h.runtime, h.ctx);
    maybeLaunchConsolidation(h.pi, h.runtime, h.ctx);
    release();
    await prior;
    await vi.waitFor(() => expect(agents.runObserver).toHaveBeenCalledTimes(1));
    await h.runtime.consolidationPromise;
    expect(observerChunkArg().allowedSourceEntryIds).toEqual([source]);
    expect(h.pending()).toEqual([]);
  });

  test("tree navigation discards an observer result belonging to the old leaf", async () => {
    const h = history();
    const source = h.source("OLD-LEAF");
    const { compactionId } = h.queue(source);
    let release: () => void = () => {
      throw new Error("observer not armed");
    };
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    agents.runObserver.mockImplementationOnce(async (input) => {
      await gate;
      return recordObservations(input);
    });
    const run = h.run();
    await vi.waitFor(() => expect(agents.runObserver).toHaveBeenCalledTimes(1));
    h.runtime.invalidateSessionTree();
    h.manager.branch(compactionId);
    const newLeaf = h.source("NEW-LEAF");
    release();
    await run;
    expect(h.manager.getLeafId()).toBe(newLeaf);
    expect(h.manager.getBranch().filter((entry) => entry.type === "custom")).toEqual([]);
  });

  test("migrates every visible legacy job once and leaves sibling paths recoverable", async () => {
    const h = history();
    const first = h.source("LEGACY-FIRST");
    const through = h.source("LEGACY-SECOND");
    const anchor = h.manager.appendCompaction("legacy anchor", undefined, 1);
    const sidecar = join(cursorTestDir, "pi-blackhole", `${h.manager.getSessionId()}-pending.json`);
    mkdirSync(join(cursorTestDir, "pi-blackhole"), { recursive: true });
    writeFileSync(
      sidecar,
      JSON.stringify({
        observerCatchUpRanges: [
          { branchId: anchor, fromId: first, throughId: first },
          { fromId: through, throughId: through },
        ],
      }),
    );
    await h.run();
    expect(agents.runObserver.mock.calls.map(([input]) => input.allowedSourceEntryIds)).toEqual([
      [first],
      [through],
    ]);
    await h.run();
    expect(agents.runObserver).toHaveBeenCalledTimes(2);
    h.manager.branch(anchor); // no migration records on this sibling path
    h.runtime.invalidateSessionTree();
    await h.run();
    expect(
      agents.runObserver.mock.calls.slice(2).map(([input]) => input.allowedSourceEntryIds),
    ).toEqual([[first], [through]]);
    expect(readPendingStateRaw(h.manager.getSessionId()).observerCatchUpRanges).toHaveLength(2);
  });
});

describe("ordinary observer cursor lifecycle", () => {
  test.each(["summary", "older"])(
    "manual pending coverage at %s skips only the matching chunk",
    async (coversUpToId) => {
      const fixture = makePipelineFixture({
        observeAfterTokens: 1,
        entries: [smallSource("older"), smallSource("summary")],
      });
      fixture.runtime.config.compaction = "manual";
      const { savePendingObservation } = await import("../src/om/pending.js");
      savePendingObservation("cursor-session", { coversUpToId, data: { observations: [] } });
      await fixture.run();
      expect(agents.runObserver).toHaveBeenCalledTimes(coversUpToId === "summary" ? 0 : 1);
    },
  );

  test("never observes below threshold, then covers every accumulated source entry", async () => {
    const fixture = makePipelineFixture({ observeAfterTokens: 5_000 });
    for (let cycle = 0; cycle < 5; cycle += 1) {
      fixture.entries.push(smallSource(`small-${cycle}`));
      await fixture.run();
      expect(agents.runObserver).not.toHaveBeenCalled();
      expect(fixture.runtime.getCursor("observer")).toBeUndefined();
    }
    const lowTokens = fixture.entries.map((entry) => entry.id);
    fixture.entries.push(rawMessage("big-1", `BIG-1 ${"y".repeat(40_000)}`));
    await fixture.run();
    expect(agents.runObserver).toHaveBeenCalledTimes(1);
    expect(observerChunkArg().allowedSourceEntryIds).toEqual([...lowTokens, "big-1"]);
    expect(fixture.runtime.getCursor("observer")).toEqual({ entryId: "big-1", state: "empty" });
  });

  test("a not-due cycle keeps later small additions pending for the next due cycle", async () => {
    const fixture = makePipelineFixture({ observeAfterTokens: 5_000 });
    fixture.entries.push(rawMessage("big-1", `BIG-1 ${"y".repeat(40_000)}`));
    await fixture.run();
    expect(agents.runObserver).toHaveBeenCalledTimes(1);
    expect(fixture.runtime.getCursor("observer")).toEqual({ entryId: "big-1", state: "empty" });
    fixture.entries.push(smallSource("pending"));
    await fixture.run();
    expect(agents.runObserver).toHaveBeenCalledTimes(1);
    expect(fixture.runtime.getCursor("observer")).toEqual({ entryId: "big-1", state: "not_due" });
    fixture.entries.push(rawMessage("big-2", `BIG-2 ${"z".repeat(40_000)}`));
    await fixture.run();
    expect(agents.runObserver).toHaveBeenCalledTimes(2);
    expect(observerChunkArg(1).allowedSourceEntryIds).toEqual(["pending", "big-2"]);
  });

  test("records coverage from a recorded outcome and does not re-observe it", async () => {
    const fixture = makePipelineFixture({ observeAfterTokens: 5_000 });
    agents.runObserver.mockImplementation(async (input) => recordObservations(input));
    fixture.entries.push(rawMessage("big-1", `BIG-1 ${"y".repeat(40_000)}`));
    await fixture.run();
    expect(agents.runObserver).toHaveBeenCalledTimes(1);
    expect(fixture.runtime.getCursor("observer")).toEqual({ entryId: "big-1", state: "recorded" });
    const recorded = fixture.entries.filter(
      (entry) => entry.customType === "om.observations.recorded",
    );
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.data).toMatchObject({ coversUpToId: "big-1" });
    await fixture.run();
    expect(agents.runObserver).toHaveBeenCalledTimes(1);
  });

  test("a restored not-due cursor still owns its unobserved backlog", async () => {
    const entries: TestEntry[] = [
      compactionEntry("c0", { firstKeptEntryId: "m1", summary: "prior work" }),
      smallSource("m1"),
    ];
    const first = makePipelineFixture({ observeAfterTokens: 5_000, entries });
    await first.run();
    expect(agents.runObserver).not.toHaveBeenCalled();
    expect(first.runtime.getCursor("observer")).toEqual({ entryId: "c0", state: "not_due" });
    first.runtime.saveCursorsToPending("cursor-session");
    const restored = makePipelineFixture({ observeAfterTokens: 5_000, entries });
    restored.runtime.loadCursorsFromPending("cursor-session");
    expect(restored.runtime.getCursor("observer")).toEqual({ entryId: "c0", state: "not_due" });
    entries.push(rawMessage("big-1", `BIG-1 ${"y".repeat(40_000)}`));
    await restored.run();
    expect(agents.runObserver).toHaveBeenCalledTimes(1);
    expect(observerChunkArg().allowedSourceEntryIds).toEqual(["m1", "big-1"]);
    expect(restored.runtime.getCursor("observer")).toEqual({ entryId: "big-1", state: "empty" });
  });
});

describe("capSourceEntriesToTokens", () => {
  test("catch-up cap retains oldest entries before the first over-budget entry", () => {
    const entries = [smallSource("first"), smallSource("middle"), smallSource("last")];
    expect(capCatchUp(entries, 70).map((entry) => entry.id)).toEqual(["first", "middle"]);
  });

  test("catch-up cap retains an oversized first entry", () => {
    expect(
      capCatchUp([smallSource("first"), smallSource("next")], 1).map((entry) => entry.id),
    ).toEqual(["first"]);
  });

  test("custom_message with string content contributes tokens (not 0)", () => {
    // Before the fix, custom_message counted as 0 tokens, so the cap
    // would keep all of these. After the fix, each custom_message is sized
    // correctly and the cap drops older ones once the budget is exceeded.
    const entries = [
      rawMessage("m0", "x".repeat(200)),
      textCustomMessage("cm-1", "y".repeat(100)),
      textCustomMessage("cm-2", "y".repeat(100)),
      textCustomMessage("cm-3", "y".repeat(100)),
      textCustomMessage("cm-4", "y".repeat(100)),
      textCustomMessage("cm-5", "y".repeat(100)),
    ];
    const result = capSourceEntriesToTokens(entries, 80);
    // 5 custom_message entries × ~25 tokens each = 125 tokens. rawMessage ≈ 50 tokens.
    // Total ≈ 175 > 80. Newest (cm-5) always kept; cm-4 → 50; cm-3 → 75;
    // cm-2 would push to 100 > 80 and kept.length > 0 → stop.
    expect(result.map((e) => e.id)).toEqual(["cm-3", "cm-4", "cm-5"]);
  });

  test("custom_message with array content contributes tokens", () => {
    const entries = [
      rawMessage("m0", "x".repeat(200)),
      customMessage("cm-1", [
        { type: "text", text: "part one " },
        { type: "text", text: "part two" },
      ]),
      customMessage("cm-2", [
        { type: "text", text: "part three " },
        { type: "text", text: "part four" },
      ]),
    ];
    const result = capSourceEntriesToTokens(entries, 8);
    // Each array custom_message ≈ 5 tokens. rawMessage ≈ 50 tokens.
    // Budget 8: cm-2 (5) kept; cm-1 would push to 10 > 8 → stop.
    expect(result.map((e) => e.id)).toEqual(["cm-2"]);
  });

  test("message entries are still capped correctly", () => {
    const entries = [
      rawMessage("old", "ignored old message"),
      rawMessage("new", "x".repeat(1200)), // ~300 tokens
    ];
    const result = capSourceEntriesToTokens(entries, 100);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("new");
  });

  test("branch_summary entries are still capped correctly", () => {
    const entries = [
      rawMessage("old", "ignored old message"),
      branchSummary("bs-1", "x".repeat(800)), // ~200 tokens
    ];
    const result = capSourceEntriesToTokens(entries, 100);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("bs-1");
  });

  test("cap respects maxTokens across mixed entry types", () => {
    const entries = [
      rawMessage("m1", "a".repeat(400)), // ~100 tokens
      textCustomMessage("cm1", "b".repeat(400)), // ~100 tokens
      branchSummary("bs1", "c".repeat(400)), // ~100 tokens
      rawMessage("m2", "d".repeat(400)), // ~100 tokens — newest, should be kept
    ];
    // 300 token budget: newest (m2) always kept, then walk backwards
    const result = capSourceEntriesToTokens(entries, 300);
    expect(result.map((e) => e.id)).toEqual(["cm1", "bs1", "m2"]);
  });

  test("oversized newest entry is still included (first-entry guard)", () => {
    const entries = [
      rawMessage("old", "ignored"),
      rawMessage("new", "x".repeat(12_000)), // ~3000 tokens, far exceeds budget
    ];
    const result = capSourceEntriesToTokens(entries, 100);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("new");
  });

  test("blackhole-pre-compaction-output custom entries contribute 0 tokens", () => {
    // PR #103 cosmetic entries are plain `custom` entries, never `custom_message`.
    // They must not add to the token budget, even if present in the input.
    const cosmeticEntry = {
      type: "custom" as const,
      id: "cosmetic-1",
      parentId: null,
      timestamp: "2026-09-19T16:00:00.000Z",
      customType: "blackhole-pre-compaction-output",
      data: {
        text: "x".repeat(4000),
        sourceEntryId: "src-1",
        compactionEntryId: "c1",
        truncated: true,
      },
    };
    const entries = [
      rawMessage("old", "y".repeat(200)), // ~50 tokens
      cosmeticEntry, // 0 tokens
      rawMessage("new", "x".repeat(200)), // ~50 tokens
    ];
    const result = capSourceEntriesToTokens(entries, 50);
    // cosmeticEntry contributes 0 tokens, so it does not displace the new message.
    // The cap keeps the newest source entry; older source entries are dropped once
    // the budget is exceeded.
    expect(result.map((e) => e.id)).toEqual(["cosmetic-1", "new"]);
  });
});

/** The observer preamble cap must apply in auto/off mode, not only manual mode. */
describe("observer preamble cap", () => {
  test("caps priorObservations in auto mode via observerPreambleMaxTokens", async () => {
    const fixture = makePipelineFixture({ observeAfterTokens: 100 });
    fixture.runtime.config.compaction = "auto";
    fixture.runtime.config.observerPreambleMaxTokens = 500;
    fixture.runtime.config.observerChunkMaxTokens = 10_000;

    const observations = Array.from({ length: 20 }, (_, i) => ({
      id: Math.abs(i).toString(16).padStart(12, "0"),
      content: `Observation ${i} ` + "x".repeat(200),
      timestamp: "2026-05-02 10:00",
      relevance: "medium" as const,
      sourceEntryIds: ["src-1"],
      tokenCount: 0,
    }));
    fixture.entries.push(rawMessage("src-1", "Source entry " + "y".repeat(100_000)));
    fixture.entries.push(
      observationsRecordedEntry("obs-marker", {
        observations,
        coversUpToId: "src-1",
      }),
    );
    // Add a second source entry so there is unobserved content after the marker.
    fixture.entries.push(rawMessage("src-2", "More source " + "z".repeat(100_000)));

    await fixture.run();

    expect(agents.runObserver).toHaveBeenCalledTimes(1);
    const input = observerChunkArg();
    // 20 medium observations would exceed the 500-token preamble budget;
    // the auto-mode cap must trim them down.
    expect(input.priorObservations.length).toBeLessThan(observations.length);
    expect(input.priorObservations.length).toBeGreaterThan(0);
  });

  test("defaults to 30% of observerChunkMaxTokens when observerPreambleMaxTokens is 0", async () => {
    const fixture = makePipelineFixture({ observeAfterTokens: 100 });
    fixture.runtime.config.compaction = "auto";
    fixture.runtime.config.observerPreambleMaxTokens = 0;
    fixture.runtime.config.observerChunkMaxTokens = 4_000; // 30% = 1200 tokens

    const observations = Array.from({ length: 20 }, (_, i) => ({
      id: Math.abs(i).toString(16).padStart(12, "0"),
      content: `Observation ${i} ` + "x".repeat(200),
      timestamp: "2026-05-02 10:00",
      relevance: "medium" as const,
      sourceEntryIds: ["src-1"],
      tokenCount: 0,
    }));
    fixture.entries.push(rawMessage("src-1", "Source entry " + "y".repeat(100_000)));
    fixture.entries.push(
      observationsRecordedEntry("obs-marker", {
        observations,
        coversUpToId: "src-1",
      }),
    );
    // Add a second source entry so there is unobserved content after the marker.
    fixture.entries.push(rawMessage("src-2", "More source " + "z".repeat(100_000)));

    await fixture.run();

    expect(agents.runObserver).toHaveBeenCalledTimes(1);
    const input = observerChunkArg();
    // With a 1200-token default budget, 20 medium observations (~63 tokens each)
    // should be capped well below the 20 created.
    expect(input.priorObservations.length).toBeLessThan(observations.length);
    expect(input.priorObservations.length).toBeGreaterThan(0);
  });

  test("caps priorReflections in auto mode via observerPreambleMaxTokens", async () => {
    const fixture = makePipelineFixture({ observeAfterTokens: 100 });
    fixture.runtime.config.compaction = "auto";
    fixture.runtime.config.observerPreambleMaxTokens = 500;
    fixture.runtime.config.observerChunkMaxTokens = 10_000;

    const reflections = Array.from({ length: 20 }, (_, i) =>
      reflection((100 + i).toString(16).padStart(12, "0"), ["src-1"], {
        content: `Reflection ${i} ` + "x".repeat(200),
      }),
    );
    fixture.entries.push(rawMessage("src-1", "Source entry " + "y".repeat(100_000)));
    fixture.entries.push(
      reflectionsRecordedEntry("refl-marker", {
        reflections,
        coversUpToId: "src-1",
      }),
    );
    // Add a second source entry so there is unobserved content after the marker.
    fixture.entries.push(rawMessage("src-2", "More source " + "z".repeat(100_000)));

    await fixture.run();

    expect(agents.runObserver).toHaveBeenCalledTimes(1);
    const input = observerChunkArg();
    // 20 reflections at ~60 tokens each would exceed the 500-token preamble
    // budget; the newest-first cap must trim them down without emptying them.
    expect(input.priorReflections.length).toBeLessThan(reflections.length);
    expect(input.priorReflections.length).toBeGreaterThan(0);
  });

  test("skips observer when chunk fits but full prompt with preamble exceeds context window", async () => {
    const fixture = makePipelineFixture({ observeAfterTokens: 100 });
    fixture.runtime.config.compaction = "auto";
    fixture.runtime.config.observerPreambleMaxTokens = 500;
    fixture.runtime.config.observerChunkMaxTokens = 10_000;
    // Small model window: chunk (~600 tokens) + 8k reserve fits in 11k, but
    // adding the preamble (~500 tokens) and the ~3.3k system prompt does not.
    // The old chunk-only guard would have passed this call through.
    fixture.runtime.resolveModel = async () => ({
      ok: true as const,
      model: { provider: "test", id: "model", contextWindow: 11_000 },
      apiKey: "test",
    });

    const observations = Array.from({ length: 20 }, (_, i) => ({
      id: Math.abs(i).toString(16).padStart(12, "0"),
      content: `Observation ${i} ` + "x".repeat(200),
      timestamp: "2026-05-02 10:00",
      relevance: "medium" as const,
      sourceEntryIds: ["src-1"],
      tokenCount: 0,
    }));
    fixture.entries.push(rawMessage("src-1", "Source entry " + "y".repeat(100_000)));
    fixture.entries.push(
      observationsRecordedEntry("obs-marker", {
        observations,
        coversUpToId: "src-1",
      }),
    );
    // Small follow-up chunk: ~600 tokens, well under the window on its own.
    fixture.entries.push(rawMessage("src-2", "More source " + "z".repeat(2400)));

    await fixture.run();

    expect(agents.runObserver).not.toHaveBeenCalled();
  });
});
