/**
 * Tests for /blackhole command — compaction trigger, om-off/om-on, noAutoCompact flush.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { testRoot } = vi.hoisted(() => {
  // Use require() to avoid import-hoisting issues with vi.mock
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  return {
    testRoot: join(tmpdir(), `pi-blackhole-cmd-test-${process.pid}-${Date.now()}`),
  };
});

// Mock the pi SDK before importing our module
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
  getAgentDir: () => join(testRoot, "agent"),
}));

// Mock the canonical config-flow so openSettings doesn't mount a real UI.
// The canonical flow renders a scope-selector + modal via ctx.ui.custom,
// which doesn't exist in these command-level tests.
vi.mock("../src/pi-base/settings/config-flow.js", () => ({
  openConfigFlow: vi.fn(async () => {}),
}));

import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPiVccCommand } from "../src/commands/pi-vcc.js";
import { Runtime } from "../src/om/runtime.js";
import { openConfigFlow } from "../src/pi-base/settings/config-flow.js";
import { readPendingState as readPendingStateRaw } from "../src/om/pending.js";
import { isSourceEntry, OM_OBSERVER_CATCH_UP_JOB } from "../src/om/ledger/index.js";
import { createExtensionApiDouble } from "./fixtures/pi-extension-api.js";
import { observation, reflection } from "./fixtures/session.js";

function createMockEnvironment() {
  const compactCalls: Array<{
    customInstructions: string;
    onComplete: () => void;
    onError: (err: Error) => void;
  }> = [];
  const appendEntryCalls: Array<{ customType: string; data: unknown }> = [];
  const notifyCalls: Array<{ msg: string; level: string }> = [];

  const handlerMap = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>();
  const completionMap = new Map<
    string,
    NonNullable<Parameters<ExtensionAPI["registerCommand"]>[1]["getArgumentCompletions"]>
  >();
  const pi: ExtensionAPI = {
    ...createExtensionApiDouble({
      appendEntry: (customType, data) => {
        appendEntryCalls.push({ customType, data });
      },
    }),
    registerCommand: vi.fn((name, def) => {
      handlerMap.set(name, def.handler);
      if (def.getArgumentCompletions) completionMap.set(name, def.getArgumentCompletions);
    }),
  };

  const runtime: any = {
    appendMemoryEntry: Runtime.prototype.appendMemoryEntry,
    ensureConfig: vi.fn(),
    resetInfoGate: vi.fn(),
    tryEmitInfo: vi.fn((hasUI: boolean, ui: any, msg: string) => {
      if (!hasUI || !ui) return;
      try {
        ui.notify(msg, "info");
      } catch {
        /* stale ctx */
      }
    }),
    config: {
      memory: true,
      noAutoCompact: false,
    },
    compactionStats: null,
  };

  function makeHandlerArgs(overrides: Record<string, unknown> = {}) {
    const base = {
      cwd: testRoot,
      sessionManager: {
        getBranch: vi.fn(() => []),
        getSessionId: vi.fn(() => "test-session"),
      },
      compact: vi.fn(
        (opts: {
          customInstructions?: string;
          onComplete?: () => void;
          onError?: (err: Error) => void;
        }) => {
          compactCalls.push({
            customInstructions: opts.customInstructions ?? "",
            onComplete: opts.onComplete ?? (() => {}),
            onError: opts.onError ?? (() => {}),
          });
        },
      ),
      ui: {
        notify: vi.fn((msg: string, level: string) => {
          notifyCalls.push({ msg, level });
        }),
        custom: vi.fn(),
      },
      ...overrides,
    };
    return base as any;
  }

  return {
    pi,
    runtime,
    handlerMap,
    completionMap,
    makeHandlerArgs,
    compactCalls,
    appendEntryCalls,
    notifyCalls,
  };
}

function catchUpContext(
  env: ReturnType<typeof createMockEnvironment>,
  branch: Array<Record<string, unknown>> = [
    { type: "message", id: "summary", message: { role: "assistant", content: "important" } },
  ],
) {
  const lastSourceId = branch.filter(isSourceEntry).at(-1)?.id;
  return env.makeHandlerArgs({
    sessionManager: {
      getSessionId: () => "test-session",
      getBranch: vi
        .fn()
        .mockReturnValueOnce(branch)
        .mockReturnValue([
          ...branch,
          {
            type: "compaction",
            id: `compact-${lastSourceId ?? "none"}`,
            firstKeptEntryId: lastSourceId ?? "",
          },
        ]),
    },
  });
}

async function runCatchUpCommand(
  env: ReturnType<typeof createMockEnvironment>,
  ctx = catchUpContext(env),
  args = "",
) {
  registerPiVccCommand(env.pi, env.runtime);
  const handler = env.handlerMap.get("blackhole");
  if (!handler) throw new Error("/blackhole was not registered");
  await handler(args, ctx);
  return ctx;
}

describe("/blackhole command", () => {
  beforeEach(() => {
    mkdirSync(join(testRoot, "agent", "pi-blackhole"), { recursive: true });
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it("registers the blackhole command", () => {
    const { pi, runtime } = createMockEnvironment();
    registerPiVccCommand(pi as any, runtime as any);
    expect(pi.registerCommand).toHaveBeenCalledWith(
      "blackhole",
      expect.objectContaining({
        description: expect.stringContaining("Manual compact"),
      }),
    );
  });

  it("surfaces a single 'settings' completion (with 'configure' alias matching)", () => {
    const { pi, runtime, completionMap } = createMockEnvironment();
    registerPiVccCommand(pi as any, runtime as any);

    // Exactly one configuration entry — the settings handle, no separate
    // "configure" entry in the dropdown
    const completions = completionMap.get("blackhole")!("");
    const values = completions.map((c) => c.value);
    expect(values).toContain("settings");
    expect(values).not.toContain("configure");

    // Typing /blackhole config… surfaces the settings entry via its alias
    const configMatches = completionMap.get("blackhole")!("config").map((c) => c.value);
    expect(configMatches).toEqual(["settings"]);
  });

  it("refreshes runtime config after saving settings", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs } = createMockEnvironment();
    vi.mocked(openConfigFlow).mockImplementationOnce(async (params: any) => {
      await params.save({ retainedToolOutputMaxTokens: 9_000 }, "global");
    });
    registerPiVccCommand(pi as any, runtime as any);

    await handlerMap.get("blackhole")!("settings", makeHandlerArgs());

    expect(runtime.config.retainedToolOutputMaxTokens).toBe(9_000);
  });

  it("calls ctx.compact with PI_VCC_COMPACT_INSTRUCTION", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs } = createMockEnvironment();
    registerPiVccCommand(pi as any, runtime as any);

    const ctx = makeHandlerArgs();
    await handlerMap.get("blackhole")!("", ctx);

    expect(ctx.compact).toHaveBeenCalledTimes(1);
    const call = ctx.compact.mock.calls[0][0];
    expect(call.customInstructions).toBe("__pi_vcc__");
  });

  it("appends an inert branch-local catch-up job only after successful compaction", async () => {
    const env = createMockEnvironment();
    const { pi, runtime, handlerMap, appendEntryCalls } = env;
    registerPiVccCommand(pi as any, runtime as any);
    const ctx = catchUpContext(env);

    await handlerMap.get("blackhole")!("", ctx);
    expect(ctx.compact).toHaveBeenCalledTimes(1);
    expect(appendEntryCalls).toEqual([]);

    ctx.compact.mock.calls[0][0].onComplete();
    expect(appendEntryCalls).toContainEqual({
      customType: OM_OBSERVER_CATCH_UP_JOB,
      data: {
        version: 1,
        compactionId: "compact-summary",
        fromId: "summary",
        throughId: "summary",
      },
    });
    expect(readPendingStateRaw("test-session").observerCatchUpRanges).toBeUndefined();
  });

  it("persists a raw-history job when a real SessionManager compaction hides the pre-tail projection", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "pi-blackhole-command-history-"));
    try {
      const manager = SessionManager.create("/tmp", sessionDir);
      const firstSourceId = manager.appendMessage({
        role: "user",
        content: "PRE-COMPACTION-TAIL",
        timestamp: Date.now(),
      });
      const lastSourceId = manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "TAIL-REPLY" }],
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
      const env = createMockEnvironment();
      env.pi.appendEntry = (type, data) => manager.appendCustomEntry(type, data);
      const ctx = env.makeHandlerArgs({ sessionManager: manager });
      await runCatchUpCommand(env, ctx);
      expect(manager.getBranch().some((entry) => entry.type === "custom")).toBe(false);
      manager.appendCompaction("folded", undefined, 1);
      ctx.compact.mock.calls[0][0].onComplete();

      const job = manager
        .getBranch()
        .find((entry) => entry.type === "custom" && entry.customType === OM_OBSERVER_CATCH_UP_JOB);
      expect(job?.data).toMatchObject({
        version: 1,
        fromId: firstSourceId,
        throughId: lastSourceId,
      });
      expect(JSON.stringify(manager.buildSessionContext().messages)).not.toContain(
        "PRE-COMPACTION-TAIL",
      );
      expect(env.notifyCalls.some(({ msg }) => msg.includes("Compacted with blackhole"))).toBe(
        true,
      );
      const file = manager.getSessionFile();
      if (!file) throw new Error("expected a persisted session");
      expect(SessionManager.open(file, sessionDir).getBranch()).toEqual(manager.getBranch());
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it("queues only the current tail without merging or resetting an older sliced job", async () => {
    const env = createMockEnvironment();
    const ctx = catchUpContext(env, [
      { type: "message", id: "old", message: { role: "user", content: "old work" } },
      {
        type: "custom",
        id: "job-old",
        customType: OM_OBSERVER_CATCH_UP_JOB,
        data: { version: 1, compactionId: "old-compact", fromId: "old", throughId: "old" },
      },
      {
        type: "custom",
        id: "progress-old",
        customType: "om.observer.catch-up.progress",
        data: { version: 1, compactionId: "old-compact", nextSourceId: "old", offset: 20 },
      },
      {
        type: "message",
        id: "excluded",
        message: { role: "user", content: "not queued or in tail" },
      },
      { type: "message", id: "tail", message: { role: "user", content: "current tail" } },
      { type: "compaction", id: "previous", firstKeptEntryId: "tail" },
    ]);
    await runCatchUpCommand(env, ctx);
    ctx.compact.mock.calls[0][0].onComplete();
    expect(env.appendEntryCalls).toEqual([
      {
        customType: OM_OBSERVER_CATCH_UP_JOB,
        data: { version: 1, compactionId: "compact-tail", fromId: "tail", throughId: "tail" },
      },
    ]);
  });

  it("does not create a history job when memory is disabled", async () => {
    const env = createMockEnvironment();
    env.runtime.config.memory = false;
    const ctx = await runCatchUpCommand(env);

    ctx.compact.mock.calls[0][0].onComplete();

    expect(env.appendEntryCalls).toEqual([]);
    expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
  });

  it("loads disabled memory before the first command snapshots config", async () => {
    const env = createMockEnvironment();
    env.runtime = new Runtime();
    mkdirSync(join(testRoot, ".pi"));
    writeFileSync(
      join(testRoot, ".pi", "pi-blackhole-config.json"),
      JSON.stringify({ memory: false }),
    );
    const ctx = await runCatchUpCommand(env);
    // Emulate the later session_before_compact config load: it cannot repair
    // a memoryEnabled value already captured by the command.
    env.runtime.ensureConfig(ctx.cwd);
    ctx.compact.mock.calls[0][0].onComplete();
    expect(env.runtime.config.memory).toBe(false);
    expect(env.appendEntryCalls).toEqual([]);
    expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
  });

  it("reports compaction success even when history-job persistence fails", async () => {
    const env = createMockEnvironment();
    const sendUserMessage = vi.fn();
    Object.assign(env.pi, { sendUserMessage });
    const ctx = catchUpContext(env);
    Object.assign(env.pi, {
      appendEntry: () => {
        throw new Error("history unavailable");
      },
    });

    await runCatchUpCommand(env, ctx, "continue");
    expect(() => ctx.compact.mock.calls[0][0].onComplete()).not.toThrow();

    expect(env.notifyCalls.some(({ msg }) => msg.includes("catch-up not queued"))).toBe(true);
    expect(env.notifyCalls.some(({ msg }) => msg.includes("Compacted with blackhole"))).toBe(true);
    expect(sendUserMessage).toHaveBeenCalledWith("continue");
  });

  it("launches existing work even when this compaction has no new tail", async () => {
    const env = createMockEnvironment();
    env.runtime.isConsolidationRetryGated = () => {
      throw new Error("background launch reached");
    };
    env.runtime.recordConsolidationStageError = vi.fn();
    const ctx = catchUpContext(env, [
      { type: "message", id: "old", message: { role: "user", content: "queued work" } },
      {
        type: "custom",
        id: "job",
        customType: OM_OBSERVER_CATCH_UP_JOB,
        data: { version: 1, compactionId: "old-compact", fromId: "old", throughId: "old" },
      },
      { type: "compaction", id: "previous", firstKeptEntryId: "previous" },
    ]);
    await runCatchUpCommand(env, ctx);
    ctx.compact.mock.calls[0][0].onComplete();
    expect(env.appendEntryCalls).toEqual([]);
    await vi.waitFor(() =>
      expect(env.runtime.recordConsolidationStageError).toHaveBeenCalledWith(
        ctx,
        "observer",
        expect.objectContaining({ message: "background launch reached" }),
      ),
    );
  });

  it.each([
    { state: "missing", postBranch: undefined },
    { state: "empty", postBranch: [] },
  ])(
    "warns without queueing when the $state post-compaction branch has no anchor",
    async ({ postBranch }) => {
      const env = createMockEnvironment();
      const ctx = await runCatchUpCommand(env);
      ctx.sessionManager.getBranch.mockReturnValue(postBranch);
      ctx.compact.mock.calls[0][0].onComplete();
      expect(env.notifyCalls).toContainEqual({
        msg: "Observational memory: post-compaction branch anchor unavailable; catch-up not queued",
        level: "warning",
      });
      expect(env.appendEntryCalls).toEqual([]);
    },
  );

  it("does not queue new work when compaction fails", async () => {
    const env = createMockEnvironment();
    const ctx = await runCatchUpCommand(env);
    ctx.compact.mock.calls[0][0].onError(new Error("failed"));
    expect(env.appendEntryCalls).toEqual([]);
  });

  it("reports compaction success and follow-up when the post-compaction context is stale", async () => {
    const env = createMockEnvironment();
    const sendUserMessage = vi.fn();
    env.pi.sendUserMessage = sendUserMessage;
    const ctx = catchUpContext(env);
    await runCatchUpCommand(env, ctx, "continue");
    ctx.sessionManager.getBranch.mockImplementation(() => {
      throw new Error("stale context");
    });
    ctx.compact.mock.calls[0][0].onComplete();
    expect(env.notifyCalls.some(({ msg }) => msg.includes("catch-up not queued"))).toBe(true);
    expect(env.notifyCalls.some(({ msg }) => msg.includes("Compacted with blackhole"))).toBe(true);
    expect(sendUserMessage).toHaveBeenCalledWith("continue");
  });

  it("sends onComplete notification with stats when available", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs, notifyCalls } = createMockEnvironment();
    runtime.compactionStats = { summarized: 42, kept: 10, keptTokensEst: 5000 };
    registerPiVccCommand(pi as any, runtime as any);

    const ctx = makeHandlerArgs();
    await handlerMap.get("blackhole")!("", ctx);

    const call = ctx.compact.mock.calls[0][0];
    call.onComplete();

    expect(notifyCalls[notifyCalls.length - 1].msg).toContain("42 source entries");
    expect(notifyCalls[notifyCalls.length - 1].msg).toContain("5.0k tok");
  });

  it("sends onComplete fallback notification without stats", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs, notifyCalls } = createMockEnvironment();
    registerPiVccCommand(pi as any, runtime as any);

    const ctx = makeHandlerArgs();
    await handlerMap.get("blackhole")!("", ctx);

    const call = ctx.compact.mock.calls[0][0];
    call.onComplete();

    expect(notifyCalls[notifyCalls.length - 1].msg).toContain("Compacted with blackhole");
  });

  it("handles onError for cancellation", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs, notifyCalls } = createMockEnvironment();
    registerPiVccCommand(pi as any, runtime as any);

    const ctx = makeHandlerArgs();
    await handlerMap.get("blackhole")!("", ctx);

    const call = ctx.compact.mock.calls[0][0];
    call.onError(new Error("Compaction cancelled"));

    expect(notifyCalls[notifyCalls.length - 1].level).toBe("warning");
    expect(notifyCalls[notifyCalls.length - 1].msg).toContain("Nothing to compact");
  });

  it("handles onError for general failure", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs, notifyCalls } = createMockEnvironment();
    registerPiVccCommand(pi as any, runtime as any);

    const ctx = makeHandlerArgs();
    await handlerMap.get("blackhole")!("", ctx);

    const call = ctx.compact.mock.calls[0][0];
    call.onError(new Error("Model API error"));

    expect(notifyCalls[notifyCalls.length - 1].level).toBe("error");
    expect(notifyCalls[notifyCalls.length - 1].msg).toContain("Compaction failed: Model API error");
  });

  it("/blackhole om-off disables memory and saves config", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs, notifyCalls } = createMockEnvironment();
    registerPiVccCommand(pi as any, runtime as any);
    runtime.config.memory = true;

    const ctx = makeHandlerArgs();
    await handlerMap.get("blackhole")!("om-off", ctx);

    expect(runtime.config.memory).toBe(false);
    expect(notifyCalls[0].msg).toContain("Observational memory disabled");
  });

  it("/blackhole om-on enables memory and saves config", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs, notifyCalls } = createMockEnvironment();
    registerPiVccCommand(pi as any, runtime as any);
    runtime.config.memory = false;

    const ctx = makeHandlerArgs();
    await handlerMap.get("blackhole")!("om-on", ctx);

    expect(runtime.config.memory).toBe(true);
    expect(notifyCalls[0].msg).toContain("Observational memory enabled");
  });

  it("flushes manual batches while retaining queued catch-up and cursor", async () => {
    const env = createMockEnvironment();
    const { pi, runtime, handlerMap, appendEntryCalls } = env;
    runtime.config.compaction = "manual";
    registerPiVccCommand(pi as any, runtime as any);
    const pendingFile = join(testRoot, "agent", "pi-blackhole", "test-session-pending.json");
    writeFileSync(
      pendingFile,
      JSON.stringify({
        observerCatchUpFromId: "summary",
        observerCatchUpThroughId: "summary",
        cursors: { observer: { entryId: "earlier", state: "recorded" } },
        observation: { coversUpToId: "earlier", data: { observations: [{ id: "o1" }] } },
      }),
    );

    const ctx = catchUpContext(env);
    await handlerMap.get("blackhole")!("", ctx);
    ctx.compact.mock.calls[0][0].onError(new Error("failed"));

    expect(appendEntryCalls).toHaveLength(1);
    expect(readPendingStateRaw("test-session").observation).toBeUndefined();
    expect(readPendingStateRaw("test-session").observerCatchUpRanges?.[0]?.throughId).toBe(
      "summary",
    );
    expect(readPendingStateRaw("test-session").cursors?.observer?.entryId).toBe("earlier");
    const staleFile = join(testRoot, "agent", "pi-blackhole", "test-session-pending.stale.json");
    expect(existsSync(staleFile)).toBe(false);
  });

  it.each(
    [
      { field: "observation", data: { observations: [observation("aaaaaaaaaaaa")] } },
      { field: "reflection", data: { reflections: [reflection("bbbbbbbbbbbb")] } },
      { field: "dropped", data: { observationIds: ["aaaaaaaaaaaa"] } },
    ].flatMap((batch) => ["paused", "failing"].map((state) => ({ ...batch, state }))),
  )(
    "retains manual $field batches when history writes are $state",
    async ({ field, data, state }) => {
      const env = createMockEnvironment();
      env.runtime.config.compaction = "manual";
      env.runtime.memoryWritesPaused = state === "paused";
      const batch = { coversUpToId: "summary", data: { ...data, coversUpToId: "summary" } };
      const pendingFile = join(testRoot, "agent", "pi-blackhole", "test-session-pending.json");
      writeFileSync(pendingFile, JSON.stringify({ [field]: batch }));
      const before = readPendingStateRaw("test-session");
      if (state === "failing") {
        const append = env.pi.appendEntry;
        vi.spyOn(env.pi, "appendEntry").mockImplementationOnce((type, value) => {
          append(type, value); // Pi may keep a failed disk append in memory.
          throw new Error("history disk write failed");
        });
      }
      const ctx = await runCatchUpCommand(env);
      expect(readPendingStateRaw("test-session")).toEqual(before);
      expect(env.runtime.memoryWritesPaused).toBe(true);
      expect(env.appendEntryCalls).toHaveLength(state === "paused" ? 0 : 1);
      expect(ctx.compact).toHaveBeenCalledTimes(1);
      expect(env.notifyCalls).toContainEqual({
        msg: expect.stringContaining("pending entries not flushed"),
        level: "warning",
      });
    },
  );

  it("warns but still compacts when stale-backup cleanup fails", async () => {
    const env = createMockEnvironment();
    const { pi, runtime, handlerMap, notifyCalls } = env;
    runtime.config.compaction = "manual";
    registerPiVccCommand(pi as any, runtime as any);
    const dir = join(testRoot, "agent", "pi-blackhole");
    writeFileSync(
      join(dir, "test-session-pending.json"),
      JSON.stringify({
        observation: { coversUpToId: "summary", data: { observations: [{ id: "o1" }] } },
        cursors: { observer: { entryId: "summary", state: "recorded" } },
      }),
    );
    mkdirSync(join(dir, "test-session-pending.stale.json"));

    const ctx = catchUpContext(env);
    await handlerMap.get("blackhole")!("", ctx);

    expect(ctx.compact).toHaveBeenCalledTimes(1);
    expect(
      notifyCalls.some(({ level, msg }) => level === "warning" && msg.includes("pending state")),
    ).toBe(true);
  });

  it("flush pending entries when noAutoCompact is active and pending data exists", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs, notifyCalls } = createMockEnvironment();
    runtime.config.compaction = "manual";
    registerPiVccCommand(pi as any, runtime as any);

    // Write a pending state file — name pattern is <sessionId>-pending.json
    const pendingDir = join(testRoot, "agent", "pi-blackhole");
    const pendingFile = join(pendingDir, "test-session-pending.json");
    writeFileSync(
      pendingFile,
      JSON.stringify({
        // isPendingOMState checks for .observation/.reflection with coversUpToId
        observation: {
          coversUpToId: "raw-1",
          data: { observations: [{ id: "aaaaaaaaaaaa", content: "test obs" }] },
        },
        reflection: {
          coversUpToId: "raw-1",
          data: {
            reflections: [
              {
                id: "eeeeeeeeeeee",
                content: "test ref",
                supportingObservationIds: ["aaaaaaaaaaaa"],
              },
            ],
          },
        },
        observationBatches: [
          {
            data: {
              observations: [{ id: "aaaaaaaaaaaa", content: "test obs" }],
              coversUpToId: "raw-1",
            },
          },
        ],
        reflectionBatches: [
          {
            data: {
              reflections: [
                {
                  id: "eeeeeeeeeeee",
                  content: "test ref",
                  supportingObservationIds: ["aaaaaaaaaaaa"],
                },
              ],
              coversUpToId: "raw-1",
            },
          },
        ],
      }),
    );

    const ctx = makeHandlerArgs();
    await handlerMap.get("blackhole")!("", ctx);

    expect(notifyCalls[0].msg).toContain("pending entries flushed");
    expect(existsSync(pendingFile)).toBe(false); // cleared after flush
    // Should call compact after flush
    expect(ctx.compact).toHaveBeenCalledTimes(1);
  });
});

// ── Feature 1: Follow-up prompt after compaction ────────────────────────────

describe("/blackhole follow-up prompt", () => {
  beforeEach(() => {
    mkdirSync(join(testRoot, "agent", "pi-blackhole"), { recursive: true });
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it("extracts follow-up text from /blackhole <args> and sends it after compaction", async () => {
    const sendUserMessageCalls: Array<{ content: string }> = [];
    const { pi, runtime, handlerMap, makeHandlerArgs } = createMockEnvironment();
    (pi as any).sendUserMessage = vi.fn((content: string) => {
      sendUserMessageCalls.push({ content });
    });
    registerPiVccCommand(pi as any, runtime as any);

    const ctx = makeHandlerArgs();
    await handlerMap.get("blackhole")!("fix the auth bug", ctx);

    expect(ctx.compact).toHaveBeenCalledTimes(1);
    const call = ctx.compact.mock.calls[0][0];
    expect(call.customInstructions).toBe("__pi_vcc__");
    // Simulate compaction completion — follow-up should fire
    call.onComplete();
    expect(sendUserMessageCalls).toHaveLength(1);
    expect(sendUserMessageCalls[0].content).toBe("fix the auth bug");
  });

  it("does NOT extract subcommands as follow-up", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs } = createMockEnvironment();
    registerPiVccCommand(pi as any, runtime as any);

    const ctx = makeHandlerArgs();
    await handlerMap.get("blackhole")!("configure", ctx);

    // Should NOT compact — subcommand handled separately
    expect(ctx.compact).not.toHaveBeenCalled();
  });

  it("treats 'settings' as an alias for 'configure'", async () => {
    const { pi, runtime, handlerMap, makeHandlerArgs } = createMockEnvironment();
    registerPiVccCommand(pi as any, runtime as any);

    const ctx = makeHandlerArgs();
    await handlerMap.get("blackhole")!("settings", ctx);

    // Should open the config overlay (like configure), not compact
    expect(ctx.compact).not.toHaveBeenCalled();
  });

  it("no args → no follow-up prompt sent", async () => {
    const sendUserMessageCalls: Array<{ content: string }> = [];
    const { pi, runtime, handlerMap, makeHandlerArgs } = createMockEnvironment();
    (pi as any).sendUserMessage = vi.fn((content: string) => {
      sendUserMessageCalls.push({ content });
    });
    registerPiVccCommand(pi as any, runtime as any);

    const ctx = makeHandlerArgs();
    await handlerMap.get("blackhole")!("", ctx);

    expect(ctx.compact).toHaveBeenCalledTimes(1);
    const call = ctx.compact.mock.calls[0][0];
    call.onComplete();
    expect(sendUserMessageCalls).toHaveLength(0);
  });

  it("fires follow-up via sendUserMessage after compaction completes", async () => {
    const sendUserMessageCalls: Array<{ content: string }> = [];
    const { pi, runtime, handlerMap, makeHandlerArgs } = createMockEnvironment();
    (pi as any).sendUserMessage = vi.fn((content: string) => {
      sendUserMessageCalls.push({ content });
    });
    registerPiVccCommand(pi as any, runtime as any);

    const ctx = makeHandlerArgs();
    await handlerMap.get("blackhole")!("continue the refactor", ctx);

    const call = ctx.compact.mock.calls[0][0];
    // Simulate compaction completion
    call.onComplete();

    // The follow-up should be sent as a user message
    expect(sendUserMessageCalls).toHaveLength(1);
    expect(sendUserMessageCalls[0].content).toBe("continue the refactor");
  });

  it("does not fire follow-up when compaction fails", async () => {
    const sendUserMessageCalls: Array<{ content: string }> = [];
    const { pi, runtime, handlerMap, makeHandlerArgs } = createMockEnvironment();
    (pi as any).sendUserMessage = vi.fn((content: string) => {
      sendUserMessageCalls.push({ content });
    });
    registerPiVccCommand(pi as any, runtime as any);

    const ctx = makeHandlerArgs();
    await handlerMap.get("blackhole")!("continue", ctx);

    const call = ctx.compact.mock.calls[0][0];
    // Simulate compaction failure
    call.onError(new Error("context overflow"));

    expect(sendUserMessageCalls).toHaveLength(0);
  });
});
