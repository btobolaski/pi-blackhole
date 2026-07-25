/**
 * Pipeline-level integration tests for usage logging wiring in
 * `runConsolidationPipeline`. Verifies the usage logger is constructed from
 * session context when `usageLog` is enabled (and not constructed when
 * disabled), and that it is forwarded as `onAssistantMessage` to the OM agents.
 *
 * The agent modules and `createUsageLogger` are mocked so the test exercises
 * the pipeline's construction + forwarding logic without real LLM calls or
 * stage gating getting in the way. Per-agent callback behavior is covered in
 * `usage-log.test.ts`; this file covers the pipeline seam.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// vi.mock factories are hoisted above imports, so shared spies must be created
// with vi.hoisted to be visible inside them.
const {
  createUsageLoggerSpy,
  sentinelLogger,
  observerCalls,
  reflectorCalls,
  dropperCalls,
} = vi.hoisted(() => ({
  createUsageLoggerSpy: vi.fn(() => vi.fn()),
  sentinelLogger: vi.fn(),
  observerCalls: [] as Array<{ onAssistantMessage?: unknown }>,
  reflectorCalls: [] as Array<{ onAssistantMessage?: unknown }>,
  dropperCalls: [] as Array<{ onAssistantMessage?: unknown }>,
}));

createUsageLoggerSpy.mockReturnValue(sentinelLogger);

vi.mock("../src/om/usage-log.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/om/usage-log.js")>();
  return {
    ...actual,
    createUsageLogger: createUsageLoggerSpy,
  };
});

vi.mock("../src/om/agents/observer/agent.js", () => ({
  runObserver: vi.fn(async (args: { onAssistantMessage?: unknown }) => {
    observerCalls.push(args);
    return { observations: undefined, emptyReason: { kind: "no_new_content" } };
  }),
}));

vi.mock("../src/om/agents/reflector/agent.js", () => ({
  runReflector: vi.fn(async (args: { onAssistantMessage?: unknown }) => {
    reflectorCalls.push(args);
    return undefined;
  }),
}));

vi.mock("../src/om/agents/dropper/agent.js", () => ({
  runDropper: vi.fn(async (args: { onAssistantMessage?: unknown }) => {
    dropperCalls.push(args);
    return undefined;
  }),
}));

import { Runtime } from "../src/om/runtime.js";
import {
  runConsolidationPipeline,
  type ConsolidationCtx,
} from "../src/om/consolidation.js";

const SESSION_ID = "pipe-test-session";
let sessionDir: string;

beforeEach(() => {
  sessionDir = mkdtempSync(join(tmpdir(), "pi-blackhole-pipe-"));
  observerCalls.length = 0;
  reflectorCalls.length = 0;
  dropperCalls.length = 0;
  createUsageLoggerSpy.mockClear();
  sentinelLogger.mockClear();
});

afterEach(() => {
  try {
    rmSync(sessionDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function makeCtx(): ConsolidationCtx {
  return {
    cwd: "/proj",
    hasUI: false,
    model: undefined,
    modelRegistry: {
      find: () => undefined,
      getApiKeyAndHeaders: async () => ({ ok: false }),
    },
    sessionManager: {
      getBranch: () => [],
      getSessionId: () => SESSION_ID,
      getSessionDir: () => sessionDir,
    },
  };
}

/** A runtime with a stubbed resolveModel returning a large-context model so the
 *  observer stage passes its context-window check and reaches runObserver. */
function makeRuntime(usageLog: boolean): Runtime {
  const runtime = new Runtime("/proj");
  runtime.config.memory = true;
  runtime.config.usageLog = usageLog;
  runtime.config.observeAfterTokens = 0;
  runtime.config.reflectAfterTokens = 0;
  runtime.config.observerChunkMaxTokens = 40_000;
  runtime.config.agentMaxTurns = 1;
  // Stub model resolution so stages don't need a real model registry.
  (runtime as any).resolveModel = async () => ({
    ok: true,
    model: {
      id: "m",
      provider: "anthropic",
      api: "anthropic-messages",
      contextWindow: 200_000,
      maxTokens: 8_000,
      reasoning: false,
    },
    apiKey: "k",
    headers: {},
  });
  return runtime;
}

describe("runConsolidationPipeline usageLog wiring", () => {
  it("stops cleanly when the session context becomes stale while creating the logger", async () => {
    const runtime = makeRuntime(true);
    const ctx = makeCtx();
    ctx.sessionManager.getSessionDir = () => {
      throw new Error("extension ctx is stale after reload");
    };

    await expect(
      runConsolidationPipeline({ appendEntry: () => {} } as any, runtime, ctx),
    ).resolves.toBeUndefined();

    expect(createUsageLoggerSpy).not.toHaveBeenCalled();
    expect(observerCalls).toHaveLength(0);
  });

  it("rethrows non-stale errors encountered while creating the logger", async () => {
    const runtime = makeRuntime(true);
    const ctx = makeCtx();
    const error = new TypeError("session directory unavailable");
    ctx.sessionManager.getSessionDir = () => {
      throw error;
    };

    await expect(
      runConsolidationPipeline({ appendEntry: () => {} } as any, runtime, ctx),
    ).rejects.toBe(error);

    expect(createUsageLoggerSpy).not.toHaveBeenCalled();
    expect(observerCalls).toHaveLength(0);
  });

  it("constructs a usage logger from session context when usageLog is true and forwards it to the observer", async () => {
    const runtime = makeRuntime(true);
    const entries: any[] = [
      {
        type: "message",
        id: "msg-1",
        message: {
          role: "user",
          timestamp: Date.now(),
          content: [{ type: "text", text: "x".repeat(50) }],
        },
      },
    ];
    const ctx: ConsolidationCtx = {
      ...makeCtx(),
      sessionManager: {
        getBranch: () => entries,
        getSessionId: () => SESSION_ID,
        getSessionDir: () => sessionDir,
      },
    };

    await runConsolidationPipeline(
      { appendEntry: () => {} } as any,
      runtime,
      ctx,
    );

    expect(createUsageLoggerSpy).toHaveBeenCalledOnce();
    expect(createUsageLoggerSpy).toHaveBeenCalledWith({
      sessionDir,
      sessionId: SESSION_ID,
      cwd: "/proj",
    });
    // The observer received the sentinel logger (not undefined).
    expect(observerCalls).toHaveLength(1);
    expect(observerCalls[0].onAssistantMessage).toBe(sentinelLogger);
  });

  it("forwards the same logger to every observer fallback attempt", async () => {
    const runtime = makeRuntime(true);
    const entries: any[] = [
      {
        type: "message",
        id: "msg-1",
        message: {
          role: "user",
          timestamp: Date.now(),
          content: [{ type: "text", text: "x".repeat(50) }],
        },
      },
    ];
    const ctx: ConsolidationCtx = {
      ...makeCtx(),
      sessionManager: {
        getBranch: () => entries,
        getSessionId: () => SESSION_ID,
        getSessionDir: () => sessionDir,
      },
    };
    const { runObserver } = await import("../src/om/agents/observer/agent.js");
    (runObserver as any).mockImplementationOnce(
      async (args: { onAssistantMessage?: unknown }) => {
        observerCalls.push(args);
        throw new Error("429 Too Many Requests");
      },
    );

    await runConsolidationPipeline(
      { appendEntry: () => {} } as any,
      runtime,
      ctx,
    );

    expect(createUsageLoggerSpy).toHaveBeenCalledOnce();
    expect(observerCalls).toHaveLength(2);
    expect(
      observerCalls.every((call) => call.onAssistantMessage === sentinelLogger),
    ).toBe(true);
  });

  it("does not construct a logger and passes undefined when usageLog is false", async () => {
    const runtime = makeRuntime(false);
    const ctx = makeCtx();

    await runConsolidationPipeline(
      { appendEntry: () => {} } as any,
      runtime,
      ctx,
    );

    expect(createUsageLoggerSpy).not.toHaveBeenCalled();
    // Observer still ran (empty branch → no agent call expected), but if it
    // had, it would receive undefined. Assert via the construction gate:
    // no logger exists to forward.
    // The reflector/dropper stages don't reach their agent calls on an empty
    // branch, so only the construction assertion is meaningful here.
    expect(observerCalls).toHaveLength(0);
  });

  it("forwards the same logger to reflector and dropper stages", async () => {
    // Drive reflector + dropper to their agent calls by giving the observer
    // a recorded observation (appended via a fake pi.appendEntry) so the
    // later stages find observation coverage and proceed.
    const runtime = makeRuntime(true);
    const entries: any[] = [
      {
        type: "message",
        id: "msg-1",
        message: {
          role: "user",
          timestamp: Date.now(),
          content: [{ type: "text", text: "x".repeat(50) }],
        },
      },
    ];
    const ctx: ConsolidationCtx = {
      ...makeCtx(),
      sessionManager: {
        getBranch: () => entries,
        getSessionId: () => SESSION_ID,
        getSessionDir: () => sessionDir,
      },
    };
    // Fake pi: appendEntry pushes a custom marker onto the entries array so
    // later stages see the observation coverage marker.
    const fakePi = {
      appendEntry: (customType: string, data: any) => {
        entries.push({
          type: "custom",
          customType,
          data,
          id: `marker-${entries.length}`,
        });
      },
    } as any;

    // Override the observer mock for this test so it records the call AND
    // returns one observation (mockResolvedValueOnce skips the implementation,
    // so use mockImplementationOnce to keep observerCalls populated).
    const { runObserver } = await import("../src/om/agents/observer/agent.js");
    (runObserver as any).mockImplementationOnce(
      async (args: { onAssistantMessage?: unknown }) => {
        observerCalls.push(args);
        return {
          observations: [
            {
              id: "obs-1",
              content: "fact",
              timestamp: "2026-05-02 10:30",
              relevance: "low",
              sourceEntryIds: ["msg-1"],
              tokenCount: 10,
            },
          ],
        };
      },
    );

    await runConsolidationPipeline(fakePi, runtime, ctx);

    expect(createUsageLoggerSpy).toHaveBeenCalledOnce();
    expect(observerCalls[0].onAssistantMessage).toBe(sentinelLogger);
    // Reflector and dropper both received the same shared logger.
    expect(reflectorCalls.length).toBeGreaterThanOrEqual(1);
    expect(reflectorCalls[0].onAssistantMessage).toBe(sentinelLogger);
    expect(dropperCalls.length).toBeGreaterThanOrEqual(1);
    expect(dropperCalls[0].onAssistantMessage).toBe(sentinelLogger);
  });
});
