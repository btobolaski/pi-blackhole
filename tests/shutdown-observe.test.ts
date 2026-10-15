import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../src/om/runtime.js";
import { observeTailOnShutdown } from "../src/om/shutdown-observe.js";
import type { ConsolidationCtx } from "../src/om/consolidation.js";
import type { runObserver } from "../src/om/agents/observer/agent.js";
import { createExtensionApiDouble } from "./fixtures/pi-extension-api.js";
import { observation, rawMessage } from "./fixtures/session.js";
import { readPendingState } from "../src/om/pending.js";
const scratch = vi.hoisted(() => ({ dir: "" }));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
  getAgentDir: () => scratch.dir,
}));
const observer = vi.hoisted(() => vi.fn<typeof runObserver>());
vi.mock("../src/om/agents/observer/agent.js", () => ({ runObserver: observer }));
let runtime: Runtime;
let ctx: ConsolidationCtx;
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
  observer.mockResolvedValue({
    observations: [observation("aaaaaaaaaaaa", "Final fact", { sourceEntryIds: ["tail"] })],
  });
  vi.spyOn(runtime, "dispose");
});
afterEach(() => {
  runtime.dispose();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
  rmSync(scratch.dir, { recursive: true, force: true });
});
const run = () => observeTailOnShutdown(pi, runtime, ctx, "quit");
test("off disposes without observer", async () => {
  runtime.config.observeOnShutdown = false;
  await run();
  expect(observer).not.toHaveBeenCalled();
  expect(runtime.dispose).toHaveBeenCalled();
});
test("eligible calls once with one turn", async () => {
  await run();
  expect(observer).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ maxTurns: 1 }));
});
test("records coverage at tail", async () => {
  await run();
  expect(appended).toHaveBeenCalledWith(
    "om.observations.recorded",
    expect.objectContaining({ coversUpToId: "tail" }),
  );
});
test("saves recorded cursor", async () => {
  await run();
  expect(readPendingState("shutdown-test").cursors?.observer).toEqual({
    entryId: "tail",
    state: "recorded",
  });
});
test("short tail skipped", async () => {
  ctx.sessionManager.getBranch = () => [rawMessage("tail", "short")];
  await run();
  expect(observer).not.toHaveBeenCalled();
});
test("covered tail skipped", async () => {
  runtime.advanceCursor("observer", "tail", "recorded");
  await run();
  expect(observer).not.toHaveBeenCalled();
});
test("empty branch skipped", async () => {
  ctx.sessionManager.getBranch = () => [];
  await run();
  expect(observer).not.toHaveBeenCalled();
});
test("reload skipped", async () => {
  await observeTailOnShutdown(pi, runtime, ctx, "reload");
  expect(observer).not.toHaveBeenCalled();
});
test("non persisted skipped", async () => {
  ctx.sessionManager.isPersisted = () => false;
  await run();
  expect(observer).not.toHaveBeenCalled();
});
test("memory off skipped", async () => {
  runtime.config.memory = false;
  await run();
  expect(observer).not.toHaveBeenCalled();
});
test("legacy passive skipped", async () => {
  runtime.config.passive = true;
  runtime.config.compaction = undefined;
  runtime.config.compactionEngine = undefined;
  await run();
  expect(observer).not.toHaveBeenCalled();
});
test("retry gated skipped", async () => {
  vi.spyOn(runtime, "isConsolidationRetryGated").mockReturnValue(true);
  await run();
  expect(observer).not.toHaveBeenCalled();
});
test("observer error disposes without fallback", async () => {
  observer.mockRejectedValue(new Error("observer failed"));
  await run();
  expect(observer).toHaveBeenCalledTimes(1);
  expect(appended).not.toHaveBeenCalled();
  expect(runtime.dispose).toHaveBeenCalled();
});
test("deadline aborts observer and disposes", async () => {
  vi.useFakeTimers();
  observer.mockImplementation(() => new Promise(() => {}));
  const work = run();
  await vi.advanceTimersByTimeAsync(20000);
  await work;
  expect(observer.mock.calls[0]?.[0].signal?.aborted).toBe(true);
  expect(runtime.dispose).toHaveBeenCalled();
  expect(appended).not.toHaveBeenCalled();
});
test("awaits inflight coverage before checking tail", async () => {
  let complete: () => void = () => {};
  runtime.consolidationPromise = new Promise<void>((resolve) => {
    complete = () => {
      runtime.advanceCursor("observer", "tail", "recorded");
      resolve();
    };
  });
  const work = run();
  expect(runtime.dispose).not.toHaveBeenCalled();
  complete();
  await work;
  expect(observer).not.toHaveBeenCalled();
});
test("inflight consumes shared deadline", async () => {
  vi.useFakeTimers();
  runtime.consolidationPromise = new Promise(() => {});
  const work = run();
  await vi.advanceTimersByTimeAsync(20000);
  await work;
  expect(observer).not.toHaveBeenCalled();
  expect(runtime.dispose).toHaveBeenCalled();
});
test("manual mode saves pending observation", async () => {
  runtime.config.compaction = "manual";
  await run();
  expect(readPendingState("shutdown-test").observation?.coversUpToId).toBe("tail");
  expect(appended).not.toHaveBeenCalled();
});

test("skipped provider skips observer", async () => {
  runtime.config.skipForProviders = ["test"];
  await run();
  expect(observer).not.toHaveBeenCalled();
});

test("late observer completion after timeout cannot persist", async () => {
  vi.useFakeTimers();
  let complete: (value: Awaited<ReturnType<typeof runObserver>>) => void = () => {};
  observer.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const work = run();
  await vi.advanceTimersByTimeAsync(20000);
  await work;
  complete({
    observations: [observation("aaaaaaaaaaaa", "Late fact", { sourceEntryIds: ["tail"] })],
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(appended).not.toHaveBeenCalled();
});
test("large tail never drains another chunk", async () => {
  runtime.config.observerChunkMaxTokens = 300;
  ctx.sessionManager.getBranch = () => [
    rawMessage("first", "words ".repeat(250)),
    rawMessage("tail", "words ".repeat(250)),
  ];
  await run();
  expect(observer).toHaveBeenCalledTimes(1);
});
test("unavailable resolution makes no request", async () => {
  ctx.model = undefined;
  await run();
  expect(observer).not.toHaveBeenCalled();
});

test("host disposal during observer fails quietly and disposes once", async () => {
  let complete: (value: Awaited<ReturnType<typeof runObserver>>) => void = () => {};
  let started: () => void = () => {};
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  observer.mockImplementation(() => {
    started();
    return new Promise((resolve) => {
      complete = resolve;
    });
  });
  const work = run();
  await running;
  appended.mockImplementationOnce(() => {
    throw new Error("Extension context is no longer active");
  });
  ctx.sessionManager.getSessionId = () => {
    throw new Error("Extension context is no longer active");
  };
  complete({ observations: [observation("aaaaaaaaaaaa", "Fact", { sourceEntryIds: ["tail"] })] });
  await expect(work).resolves.toBeUndefined();
  expect(runtime.dispose).toHaveBeenCalledTimes(1);
  expect(readPendingState("shutdown-test").cursors).toBeUndefined();
});

test("manual mode does not persist after host context becomes stale", async () => {
  runtime.config.compaction = "manual";
  observer.mockImplementation(async () => {
    ctx.sessionManager.getSessionId = () => {
      throw new Error("Extension context is no longer active");
    };
    return { observations: [observation("aaaaaaaaaaaa", "Fact", { sourceEntryIds: ["tail"] })] };
  });
  await run();
  expect(readPendingState("shutdown-test").observation).toBeUndefined();
});
