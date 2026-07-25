/** Real shutdown registration, host context, observer, agent loop and local persistence.
 * Only model lookup/auth and provider stream are stubbed. No network requests. */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createExtensionRuntime,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  type ExtensionHandler,
  type SessionShutdownEvent,
  type TurnEndEvent,
  type TurnEndEventResult,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type Model,
} from "@earendil-works/pi-ai";
import { Runtime } from "../src/om/runtime.js";
import * as usageLog from "../src/om/usage-log.js";
import { registerConsolidationTrigger } from "../src/om/consolidation.js";
import { readPendingState } from "../src/om/pending.js";
import { createExtensionApiDouble } from "./fixtures/pi-extension-api.js";

import { createScriptedStream } from "./fixtures/scripted-stream.js";

const scratch = vi.hoisted(() => ({ dir: "" }));
vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
  ...(await original<typeof import("@earendil-works/pi-coding-agent")>()),
  getAgentDir: () => scratch.dir,
}));
const model: Model<"openai-completions"> = {
  id: "shutdown-test",
  name: "Shutdown test",
  provider: "test",
  api: "openai-completions",
  baseUrl: "https://unused.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 10_000,
};
let runtime: Runtime;
let manager: SessionManager;
let runner: ExtensionRunner;
let registry: ModelRegistry;
let tail: string;
const requests = vi.fn();
let providerCompletion: Promise<void>;
// Deferred work released in afterEach, so a failed assertion cannot leave it pending.
const releases: Array<() => void> = [];
let outstanding: Promise<unknown>[] = [];
const turnEndHandlers: ExtensionHandler<TurnEndEvent, TurnEndEventResult>[] = [];
const handlers: ExtensionHandler<SessionShutdownEvent>[] = [];

beforeEach(async () => {
  providerCompletion = Promise.resolve();
  scratch.dir = mkdtempSync(join(tmpdir(), "shutdown-integration-"));
  manager = SessionManager.create(scratch.dir, scratch.dir);
  tail = manager.appendMessage({
    role: "user",
    content: "words ".repeat(250),
    timestamp: Date.now(),
  });
  registry = new ModelRegistry(
    await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      allowModelNetwork: false,
    }),
  );
  vi.spyOn(registry, "find").mockImplementation((provider, id) => {
    if (provider !== model.provider || id !== model.id) throw new Error("Unexpected model lookup");
    return model;
  });
  vi.spyOn(registry, "getApiKeyAndHeaders").mockResolvedValue({ ok: true, apiKey: "test" });
  vi.spyOn(registry, "hasConfiguredAuth").mockReturnValue(true);
  vi.spyOn(registry, "streamSimple").mockImplementation((selected) => {
    if (selected.id !== model.id) throw new Error("Unexpected provider request");
    requests();
    const message = {
      ...createScriptedStream("record_observations").toolCallTurn({
        observations: [{ content: "Final state saved", relevance: "high", sourceEntryIds: [tail] }],
        complete: false,
      }),
      provider: model.provider,
      model: model.id,
    };
    const stream = createAssistantMessageEventStream();
    void providerCompletion.then(() => {
      stream.push({ type: "done", reason: "toolUse", message });
      stream.end(message);
    });
    return stream;
  });
  runner = new ExtensionRunner([], createExtensionRuntime(), scratch.dir, manager, registry);
  runtime = new Runtime();
  runtime.config.observeOnShutdown = true;
  runtime.config.memory = true;
  runtime.config.compaction = "auto";
  runtime.config.observerModel = { provider: model.provider, id: model.id };
  runtime.config.observerFallbackModels = [];
  const pi = createExtensionApiDouble({
    shutdownHandlers: handlers,
    turnEndHandlers,
    appendEntry: (type, data) => manager.appendCustomEntry(type, data),
  });
  registerConsolidationTrigger(pi, runtime);
  vi.spyOn(runtime, "dispose");
});
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.allSettled(outstanding);
  outstanding = [];
  runtime.dispose();
  runner.invalidate();
  handlers.length = 0;
  turnEndHandlers.length = 0;
  vi.restoreAllMocks();
  vi.resetAllMocks();
  rmSync(scratch.dir, { recursive: true, force: true });
});
function shutdown(reason: SessionShutdownEvent["reason"] = "quit") {
  const handler = handlers[0];
  if (!handler) throw new Error("Shutdown handler not registered");
  return handler({ type: "session_shutdown", reason }, runner.createContext());
}

test.each([true, false])("shutdown honors usageLog=%s", async (enabled) => {
  runtime.config.usageLog = enabled;
  const logger = vi.fn<usageLog.UsageLogger>();
  vi.spyOn(usageLog, "createUsageLogger").mockReturnValue(logger);

  await shutdown();

  expect(requests).toHaveBeenCalledTimes(1);
  expect(logger).toHaveBeenCalledTimes(enabled ? 1 : 0);
});

test.each(["quit", "new", "resume", "fork"] as const)(
  "%s hook caps real agent loop at one provider request",
  async (reason) => {
    runtime.config.observerChunkMaxTokens = 300;
    manager.appendMessage({ role: "user", content: "more ".repeat(250), timestamp: Date.now() });
    await shutdown(reason);
    expect(requests).toHaveBeenCalledTimes(1);
  },
);
test("host invalidation blocks pending writes from consolidation awaited at shutdown", async () => {
  runtime.config.compaction = "manual";
  runtime.config.observeAfterTokens = 1;
  runtime.config.agentMaxTurns = 1;
  vi.spyOn(runtime, "ensureConfig").mockImplementation(() => {});
  let complete = () => {};
  providerCompletion = new Promise<void>((resolve) => {
    complete = resolve;
    releases.push(resolve);
  });
  let started = () => {};
  const running = new Promise<void>((resolve) => {
    started = resolve;
    releases.push(resolve);
  });
  requests.mockImplementationOnce(started);
  const turnEnd = turnEndHandlers[0];
  if (!turnEnd) throw new Error("Turn-end handler missing");
  await turnEnd(
    {
      type: "turn_end",
      turnIndex: 0,
      messageEntryId: tail,
      toolResultEntryIds: [],
      entries: [],
      continue: false,
      outcome: "completed",
      context: {
        contextEntries: [],
        contextMessages: [],
        llmMessages: [],
        pendingMessages: [],
        canContinue: false,
      },
      message: {
        role: "user",
        content: "trigger",
        timestamp: Date.now(),
      },
      toolResults: [],
    },
    runner.createContext(),
  );
  await running;
  const work = shutdown();
  outstanding.push(Promise.resolve(work), runtime.consolidationPromise ?? Promise.resolve());
  runner.invalidate();
  complete();
  await work;
  expect(readPendingState(manager.getSessionId()).observation).toBeUndefined();
});
