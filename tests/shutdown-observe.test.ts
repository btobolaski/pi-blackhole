import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../src/om/runtime.js";
import { observeTailOnShutdown } from "../src/om/shutdown-observe.js";
import type { ConsolidationCtx } from "../src/om/consolidation.js";
import type { runObserver } from "../src/om/agents/observer/agent.js";
import { createExtensionApiDouble } from "./fixtures/pi-extension-api.js";
import { observation, rawMessage } from "./fixtures/session.js";
import { readPendingState } from "../src/om/pending.js";
import { SHUTDOWN_OBSERVE_TIMEOUT_MS } from "../src/om/shutdown-observe.js";
import { flushDebugLog, DEBUG_LOG_RELATIVE_PATH } from "../src/om/debug-log.js";
const scratch = vi.hoisted(() => ({ dir: "" }));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
  getAgentDir: () => scratch.dir,
}));
const observer = vi.hoisted(() => vi.fn<typeof runObserver>());
vi.mock("../src/om/agents/observer/agent.js", () => ({ runObserver: observer }));
let runtime: Runtime;
let ctx: ConsolidationCtx;
// Deferred work released in afterEach, so a failed assertion cannot leave it pending.
const releases: Array<() => void> = [];
const appended = vi.fn();
const pi = createExtensionApiDouble({ appendEntry: appended });
beforeEach(() => {
  scratch.dir = mkdtempSync(join(tmpdir(), "om-shutdown-test-"));
  runtime = new Runtime();
  runtime.config.observeOnShutdown = true;
  runtime.config.memory = true;
  runtime.config.compaction = "auto";
  runtime.config.observerModel = undefined;
  runtime.config.model = undefined;
  runtime.config.observerFallbackModels = [];
  runtime.config.sessionFallback = true;
  ctx = {
    cwd: scratch.dir,
    hasUI: false,
    model: { provider: "test", id: "primary", contextWindow: 200000, maxTokens: 10000 },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }) },
    sessionManager: {
      getSessionId: () => "shutdown-test",
      getBranch: () => [rawMessage("tail", "words ".repeat(250))],
      isPersisted: () => true,
    },
  };
  observer.mockResolvedValue(result());
  vi.spyOn(runtime, "dispose");
});
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  vi.useRealTimers();
  await new Promise((resolve) => setTimeout(resolve, 0));
  runtime.dispose();
  flushDebugLog();
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.useRealTimers();
  rmSync(scratch.dir, { recursive: true, force: true });
});
const run = () => observeTailOnShutdown(pi, runtime, ctx, "quit");
const result = () => ({
  observations: [observation("aaaaaaaaaaaa", { content: "Fact", sourceEntryIds: ["tail"] })],
});
const invalidate = () => {
  ctx.sessionManager.getSessionId = () => {
    throw new Error("Extension context is no longer active");
  };
};
test.each([
  "off",
  "short tail",
  "covered tail",
  "empty branch",
  "non persisted",
  "memory off",
  "legacy passive",
  "retry gated",
  "skipped provider",
  "unavailable model",
  "reload",
])("%s skips observer and disposes once", async (name) => {
  if (name === "off") runtime.config.observeOnShutdown = false;
  if (name === "short tail") ctx.sessionManager.getBranch = () => [rawMessage("tail", "short")];
  if (name === "covered tail") runtime.advanceCursor("observer", "tail", "recorded");
  if (name === "empty branch") ctx.sessionManager.getBranch = () => [];
  if (name === "non persisted") ctx.sessionManager.isPersisted = () => false;
  if (name === "memory off") runtime.config.memory = false;
  if (name === "legacy passive") {
    runtime.config.passive = true;
    Reflect.deleteProperty(runtime.config, "compaction");
    Reflect.deleteProperty(runtime.config, "compactionEngine");
  }
  if (name === "retry gated") vi.spyOn(runtime, "isConsolidationRetryGated").mockReturnValue(true);
  if (name === "skipped provider") runtime.config.skipForProviders = ["test"];
  if (name === "unavailable model") ctx.model = undefined;
  await observeTailOnShutdown(pi, runtime, ctx, name === "reload" ? "reload" : "quit");
  expect(observer).not.toHaveBeenCalled();
  expect(runtime.dispose).toHaveBeenCalledTimes(1);
});
test.each(["auto", "manual"] as const)(
  "%s flush records once with fresh cycle",
  async (compaction) => {
    runtime.config.compaction = compaction;
    runtime.config.passive = true; // Modern config must override legacy passive.
    runtime.sizeSkippedInCycle.add("test/primary");
    runtime.failedInCycle.add("test/primary");
    runtime.turnCapSkippedInCycle.add("test/primary");
    await run();
    expect(observer).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ maxTurns: 1 }));
    const pending = readPendingState("shutdown-test");
    expect(pending.cursors?.observer).toEqual({ entryId: "tail", state: "recorded" });
    if (compaction === "manual") {
      expect(pending.observation?.coversUpToId).toBe("tail");
      expect(appended).not.toHaveBeenCalled();
    } else {
      expect(appended).toHaveBeenCalledWith(
        "om.observations.recorded",
        expect.objectContaining({ coversUpToId: "tail" }),
      );
    }
  },
);
test.each(["error", "generation abort", "host disposal"])(
  "%s cannot save manual batch or old cursor",
  async (failure) => {
    runtime.config.compaction = "manual";
    runtime.startSession("shutdown-test");
    runtime.cursorsLoadedSessionId = "shutdown-test";
    runtime.advanceCursor("observer", "earlier", "recorded");
    ctx.sessionManager.getBranch = () => [
      rawMessage("earlier", "covered"),
      rawMessage("tail", "words ".repeat(250)),
    ];
    observer.mockImplementation(async () => {
      if (failure === "error") throw new Error("observer failed");
      if (failure === "generation abort") runtime.startSession("new-session");
      if (failure === "host disposal") invalidate();
      return result();
    });
    await expect(run()).resolves.toBeUndefined();
    expect(observer).toHaveBeenCalledTimes(1);
    expect(readPendingState("shutdown-test")).toEqual({});
    expect(appended).not.toHaveBeenCalled();
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
  },
);
test("errorAfterClose keeps its completed chunk on shutdown", async () => {
  runtime.config.compaction = "manual";
  runtime.startSession("shutdown-test");
  runtime.cursorsLoadedSessionId = "shutdown-test";
  runtime.advanceCursor("observer", "earlier", "recorded");
  ctx.sessionManager.getBranch = () => [
    rawMessage("earlier", "covered"),
    rawMessage("tail", "words ".repeat(250)),
  ];
  observer.mockImplementation(async () => ({
    ...result(),
    errorAfterClose: "provider failed after close",
  }));
  await expect(run()).resolves.toBeUndefined();
  expect(observer).toHaveBeenCalledTimes(1);
  const pending = readPendingState("shutdown-test");
  expect(pending.observation?.coversUpToId).toBe("tail");
  expect(pending.cursors?.observer).toEqual({ entryId: "tail", state: "recorded" });
  expect(appended).not.toHaveBeenCalled();
  expect(runtime.dispose).toHaveBeenCalledTimes(1);
});
test("shutdown errors reach enabled debug logging", async () => {
  runtime.config.debugLog = true;
  observer.mockRejectedValue(new Error("shutdown test failure"));
  await run();
  flushDebugLog();
  expect(readFileSync(join(scratch.dir, DEBUG_LOG_RELATIVE_PATH), "utf8")).toContain(
    '"event":"observer.shutdown_error"',
  );
});
test("queued cursor flush cannot write after host disposal", async () => {
  runtime.advanceCursor("observer", "tail", "recorded");
  runtime.scheduleCursorFlush("shutdown-test");
  const work = run();
  invalidate();
  await work;
  expect(readPendingState("shutdown-test").cursors).toBeUndefined();
});
test.each(["auto", "manual"] as const)(
  "%s deadline blocks late writes and abort-listener cursor flush",
  async (compaction) => {
    vi.useFakeTimers();
    runtime.config.compaction = compaction;
    let complete: (value: Awaited<ReturnType<typeof runObserver>>) => void = () => {};
    observer.mockImplementation(({ signal }) => {
      signal?.addEventListener("abort", () => {
        runtime.advanceCursor("observer", "tail", "recorded");
        runtime.scheduleCursorFlush("shutdown-test");
      });
      return new Promise((resolve) => {
        complete = resolve;
        releases.push(() => resolve(result()));
      });
    });
    const work = run();
    await vi.advanceTimersByTimeAsync(SHUTDOWN_OBSERVE_TIMEOUT_MS);
    await work;
    expect(observer.mock.calls[0]?.[0].signal?.aborted).toBe(true);
    complete(result());
    await vi.advanceTimersByTimeAsync(0);
    expect(readPendingState("shutdown-test")).toEqual({});
    expect(appended).not.toHaveBeenCalled();
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
  },
);
test.each(["covered", "timeout", "remaining deadline"])(
  "inflight %s shares shutdown budget",
  async (state) => {
    vi.useFakeTimers();
    let complete = () => {};
    runtime.consolidationPromise = new Promise<void>((resolve) => {
      complete = resolve;
      releases.push(resolve);
    });
    observer.mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve(result()));
        }),
    );
    const work = run();
    if (state !== "timeout") {
      await vi.advanceTimersByTimeAsync(15_000);
      if (state === "covered") runtime.advanceCursor("observer", "tail", "recorded");
      complete();
    }
    await vi.advanceTimersByTimeAsync(state === "timeout" ? SHUTDOWN_OBSERVE_TIMEOUT_MS : 5_000);
    await work;
    if (state === "remaining deadline")
      expect(observer.mock.calls[0]?.[0].signal?.aborted).toBe(true);
    else expect(observer).not.toHaveBeenCalled();
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
  },
);
