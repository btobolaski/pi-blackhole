/**
 * Tests for the observational memory usage logger (`src/om/usage-log.ts`) and
 * the `onAssistantMessage` callback wiring in the observer/reflector/dropper
 * agents.
 *
 * The logger writes pi-format JSONL (a `session` header + `message` lines)
 * to `{sessionDir}/{sessionId}_memory.jsonl`, matching the schema in
 * `moriarty-workspace-3/crates/pi_logs/src/parser.rs`.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";

import { createUsageLogger, sanitizeForLog, type UsageLogger } from "../src/om/usage-log.js";
import { runObserver } from "../src/om/agents/observer/agent.js";
import { runReflector } from "../src/om/agents/reflector/agent.js";
import { runDropper } from "../src/om/agents/dropper/agent.js";
import type { Observation, Reflection } from "../src/om/ledger/index.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-blackhole-usage-log-"));
}

/** Read a JSONL file into an array of parsed objects (skipping blank lines). */
function readJsonl(path: string): any[] {
  const raw = readFileSync(path, "utf-8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

/** Build a realistic AssistantMessage with optional parser-incompatible fields. */
function makeAssistantMessage(
  overrides: Partial<AssistantMessage> & { cacheWrite1h?: number } = {},
): any {
  return {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4",
    usage: {
      input: 100,
      output: 50,
      cacheRead: 10,
      cacheWrite: 5,
      cacheWrite1h: 2,
      totalTokens: 165,
      reasoning: 20,
      cost: {
        input: 0.001,
        output: 0.002,
        cacheRead: 0.0001,
        cacheWrite: 0.0005,
        total: 0.0036,
      },
    },
    stopReason: "stop",
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

/**
 * Fake agentLoop that runs the handler (so tools execute and records accumulate)
 * and then yields a single `agent_end` event carrying the given messages.
 *
 * The real agentLoop streams events as they happen and terminates with
 * `agent_end`; this fake preserves that ordering so the agents' `for await`
 * loop sees the event before `result()` resolves.
 */
function fakeAgentLoopWithEnd(
  handler: (prompts: any[], context: any, config: any) => Promise<void> | void,
  endMessages: any[],
): any {
  return ((prompts: any[], context: any, config: any) => ({
    async *[Symbol.asyncIterator]() {
      await handler(prompts, context, config);
      yield { type: "agent_end", messages: endMessages };
    },
    result: async () => ({}),
  })) as any;
}

const SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

// ── createUsageLogger ───────────────────────────────────────────────────────

describe("createUsageLogger", () => {
  it("writes a session header then one message line per AssistantMessage", () => {
    const dir = makeTmpDir();
    try {
      const log = createUsageLogger({
        sessionDir: dir,
        sessionId: SESSION_ID,
        cwd: "/proj",
      });
      log(makeAssistantMessage());

      const path = join(dir, `${SESSION_ID}_memory.jsonl`);
      expect(existsSync(path)).toBe(true);
      const lines = readJsonl(path);

      expect(lines).toHaveLength(2);

      expect(lines[0]).toMatchObject({
        type: "session",
        version: 3,
        id: SESSION_ID,
        cwd: "/proj",
      });
      expect(typeof lines[0].timestamp).toBe("string");

      expect(lines[1].type).toBe("message");
      expect(lines[1].parentId).toBe(SESSION_ID);
      expect(lines[1].id).toMatch(/^[0-9a-f]{8}$/);
      expect(typeof lines[1].timestamp).toBe("string");
      expect(lines[1].message.role).toBe("assistant");
      expect(lines[1].message.usage.input).toBe(100);
      expect(lines[1].message.usage.totalTokens).toBe(165);
      expect(lines[1].message.stopReason).toBe("stop");
      expect(lines[1].message.timestamp).toBe(1_700_000_000_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes the header exactly once across multiple messages", () => {
    const dir = makeTmpDir();
    try {
      const log = createUsageLogger({
        sessionDir: dir,
        sessionId: SESSION_ID,
        cwd: "/proj",
      });
      log(makeAssistantMessage({ model: "m1" }));
      log(makeAssistantMessage({ model: "m2" }));
      log(makeAssistantMessage({ model: "m3" }));

      const lines = readJsonl(join(dir, `${SESSION_ID}_memory.jsonl`));
      expect(lines).toHaveLength(4);
      expect(lines.filter((l) => l.type === "session")).toHaveLength(1);
      expect(lines.filter((l) => l.type === "message")).toHaveLength(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("chains parentId: first → sessionId, rest → previous message id", () => {
    const dir = makeTmpDir();
    try {
      const log = createUsageLogger({
        sessionDir: dir,
        sessionId: SESSION_ID,
        cwd: "/proj",
      });
      log(makeAssistantMessage());
      log(makeAssistantMessage());
      log(makeAssistantMessage());

      const lines = readJsonl(join(dir, `${SESSION_ID}_memory.jsonl`));
      const messages = lines.filter((l) => l.type === "message");

      expect(messages[0].parentId).toBe(SESSION_ID);
      expect(messages[1].parentId).toBe(messages[0].id);
      expect(messages[2].parentId).toBe(messages[1].id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates the session directory if it does not exist", () => {
    const dir = makeTmpDir();
    const nested = join(dir, "deep", "nested");
    try {
      const log = createUsageLogger({
        sessionDir: nested,
        sessionId: SESSION_ID,
        cwd: "/proj",
      });
      log(makeAssistantMessage());

      expect(existsSync(join(nested, `${SESSION_ID}_memory.jsonl`))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not write a duplicate header or break the parent chain across two logger instances (repeated consolidation runs)", () => {
    // Each consolidation run creates a fresh logger against the same file.
    // The second logger must resume appending without a second session header
    // and must chain parentId from the last written entry.
    const dir = makeTmpDir();
    const path = join(dir, `${SESSION_ID}_memory.jsonl`);
    try {
      const log1 = createUsageLogger({
        sessionDir: dir,
        sessionId: SESSION_ID,
        cwd: "/proj",
      });
      log1(makeAssistantMessage({ model: "run1-a" }));
      log1(makeAssistantMessage({ model: "run1-b" }));

      const log2 = createUsageLogger({
        sessionDir: dir,
        sessionId: SESSION_ID,
        cwd: "/proj",
      });
      log2(makeAssistantMessage({ model: "run2-a" }));

      const lines = readJsonl(path);
      const headers = lines.filter((l) => l.type === "session");
      const messages = lines.filter((l) => l.type === "message");

      expect(headers).toHaveLength(1);
      expect(messages).toHaveLength(3);
      // Continuous chain: first → sessionId, run1-b → run1-a, run2-a → run1-b
      expect(messages[0].parentId).toBe(SESSION_ID);
      expect(messages[1].parentId).toBe(messages[0].id);
      expect(messages[2].parentId).toBe(messages[1].id);
      expect(messages[2].message.model).toBe("run2-a");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not write a duplicate header when the existing log is corrupt (nonempty but unparseable)", () => {
    // A nonempty but corrupt log must not get a second session header appended.
    // The logger skips the header and chains message lines from the session id.
    const dir = makeTmpDir();
    const path = join(dir, `${SESSION_ID}_memory.jsonl`);
    try {
      writeFileSync(path, "this is not valid json\n");

      const log = createUsageLogger({
        sessionDir: dir,
        sessionId: SESSION_ID,
        cwd: "/proj",
      });
      log(makeAssistantMessage({ model: "after-corruption" }));

      // Read raw and parse only valid JSON lines (the corrupt line stays in place).
      const raw = readFileSync(path, "utf-8")
        .split("\n")
        .filter((l) => l.trim().length > 0);
      const parsed = raw
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter((v) => v !== null);
      // No new session header was written; only the one valid message line was appended.
      expect(parsed.filter((l) => l.type === "session")).toHaveLength(0);
      expect(parsed.filter((l) => l.type === "message")).toHaveLength(1);
      expect(parsed[0].parentId).toBe(SESSION_ID);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── sanitizeForLog ──────────────────────────────────────────────────────────

describe("sanitizeForLog", () => {
  it("strips usage.cacheWrite1h (a subset of cacheWrite)", () => {
    const msg = makeAssistantMessage();

    const sanitized = sanitizeForLog(msg) as any;
    expect(sanitized.usage.cacheWrite1h).toBeUndefined();
    // cacheWrite itself is preserved (cacheWrite1h is already counted in it)
    expect(sanitized.usage.cacheWrite).toBe(5);
  });

  it("strips redacted from thinking blocks but keeps thinkingSignature", () => {
    const msg = makeAssistantMessage({
      content: [
        {
          type: "thinking",
          thinking: "[Reasoning redacted]",
          thinkingSignature: "opaque-data",
          redacted: true,
        },
      ],
    });

    const sanitized = sanitizeForLog(msg) as any;
    const block = sanitized.content[0];
    expect(block.redacted).toBeUndefined();
    expect(block.thinking).toBe("[Reasoning redacted]");
    expect(block.thinkingSignature).toBe("opaque-data");
  });

  it("strips thoughtSignature from toolCall blocks", () => {
    const msg = makeAssistantMessage({
      content: [
        {
          type: "toolCall",
          id: "call-1",
          name: "record_observations",
          arguments: {},
          thoughtSignature: "sig",
        },
      ],
    });

    const sanitized = sanitizeForLog(msg) as any;
    const block = sanitized.content[0];
    expect(block.thoughtSignature).toBeUndefined();
    expect(block.id).toBe("call-1");
    expect(block.name).toBe("record_observations");
  });

  it("preserves parser-compatible optional fields (reasoning, textSignature, responseId)", () => {
    const msg = makeAssistantMessage({
      responseId: "resp-1",
      responseModel: "claude-sonnet-4-5",
      content: [{ type: "text", text: "hi", textSignature: "ts" }],
    });

    const sanitized = sanitizeForLog(msg) as any;
    expect(sanitized.responseId).toBe("resp-1");
    expect(sanitized.responseModel).toBe("claude-sonnet-4-5");
    expect(sanitized.usage.reasoning).toBe(20);
    expect(sanitized.content[0].textSignature).toBe("ts");
  });

  it("does not mutate the original message", () => {
    const msg = makeAssistantMessage({
      content: [
        {
          type: "thinking",
          thinking: "x",
          thinkingSignature: "s",
          redacted: true,
        },
        {
          type: "toolCall",
          id: "c",
          name: "n",
          arguments: {},
          thoughtSignature: "t",
        },
      ],
    });

    sanitizeForLog(msg);

    // Original retains the parser-incompatible fields
    expect((msg.usage as any).cacheWrite1h).toBe(2);
    expect((msg.content[0] as any).redacted).toBe(true);
    expect((msg.content[1] as any).thoughtSignature).toBe("t");
  });
});

// ── Best-effort error handling ──────────────────────────────────────────────

describe("createUsageLogger error handling", () => {
  it("never throws when writes fail (sessionDir under an existing file)", () => {
    // Create a regular file, then use a subpath of it as sessionDir.
    // mkdirSync({recursive:true}) fails because an intermediate path
    // component is a file, not a directory.
    const dir = makeTmpDir();
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "x");
    const badSessionDir = join(blocker, "sub");
    try {
      const log = createUsageLogger({
        sessionDir: badSessionDir,
        sessionId: SESSION_ID,
        cwd: "/proj",
      });

      expect(() => {
        log(makeAssistantMessage());
        log(makeAssistantMessage());
      }).not.toThrow();

      // No file should have been created
      expect(existsSync(join(badSessionDir, `${SESSION_ID}_memory.jsonl`))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the parent chain valid when an append fails after the header is written", () => {
    // Write the header + first message, then make `appendFileSync` fail by
    // replacing the log file with a directory (EISDIR — deterministic and
    // permission-independent, unlike chmod). The failed write must not throw
    // and must not advance lastId, so a later successful message chains from
    // the last written entry rather than a phantom id.
    const dir = makeTmpDir();
    const path = join(dir, `${SESSION_ID}_memory.jsonl`);
    try {
      const log = createUsageLogger({
        sessionDir: dir,
        sessionId: SESSION_ID,
        cwd: "/proj",
      });
      log(makeAssistantMessage({ model: "ok-1" }));

      const beforeFailure = readFileSync(path, "utf-8");
      const ok1 = readJsonl(path).filter((l) => l.type === "message")[0];

      // Replace the file with a directory → appendFileSync fails with EISDIR.
      rmSync(path);
      mkdirSync(path);
      expect(() => log(makeAssistantMessage({ model: "dropped" }))).not.toThrow();

      // Restore the original file and append a third message.
      rmSync(path, { recursive: true });
      writeFileSync(path, beforeFailure);
      log(makeAssistantMessage({ model: "ok-2" }));

      const messages = readJsonl(path).filter((l) => l.type === "message");
      expect(messages).toHaveLength(2);
      expect(messages[0].message.model).toBe("ok-1");
      expect(messages[1].message.model).toBe("ok-2");
      // ok-2 chains from ok-1 (the last successfully-written id), not a phantom.
      expect(messages[1].parentId).toBe(ok1.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Agent onAssistantMessage wiring ─────────────────────────────────────────

/** A fake toolCall content block + usage-bearing assistant message for agent_end. */
function assistantEndMessage(model: string): any {
  return makeAssistantMessage({ model });
}

describe("observer onAssistantMessage", () => {
  const baseArgs = {
    model: {} as any,
    apiKey: "test",
    priorReflections: [],
    priorObservations: [],
    chunk: "[Source entry id: entry-a]\nUser asked for a memory update.",
    allowedSourceEntryIds: ["entry-a"],
  };

  it("fires onAssistantMessage for each assistant message in agent_end (skipping toolResults)", async () => {
    const captured: AssistantMessage[] = [];
    const onAssistantMessage: UsageLogger = (m) => captured.push(m);

    const endMessages = [
      // A toolResult message should be skipped (no role "assistant")
      {
        role: "toolResult",
        toolCallId: "tool-1",
        content: [],
        isError: false,
        timestamp: 1,
      },
      assistantEndMessage("claude-a"),
      assistantEndMessage("claude-b"),
    ];

    const loop = fakeAgentLoopWithEnd(async (_prompts, context) => {
      await context.tools[0].execute("tool-1", {
        observations: [
          {
            timestamp: "2026-05-02 10:30",
            content: "User asked for a memory update.",
            relevance: "high",
            sourceEntryIds: ["entry-a"],
          },
        ],
      });
    }, endMessages);

    await runObserver({ ...baseArgs, agentLoop: loop, onAssistantMessage });

    expect(captured).toHaveLength(2);
    expect(captured[0].model).toBe("claude-a");
    expect(captured[1].model).toBe("claude-b");
    // Each captured message carries usage
    expect(captured[0].usage.input).toBe(100);
  });

  it("does not call onAssistantMessage when absent", async () => {
    const loop = fakeAgentLoopWithEnd(
      async (_prompts, context) => {
        await context.tools[0].execute("tool-1", {
          observations: [
            {
              timestamp: "2026-05-02 10:30",
              content: "x",
              relevance: "high",
              sourceEntryIds: ["entry-a"],
            },
          ],
        });
      },
      [assistantEndMessage("claude-a")],
    );

    await expect(runObserver({ ...baseArgs, agentLoop: loop })).resolves.toBeDefined();
  });

  it("still surfaces API errors from agent_end alongside the callback", async () => {
    const captured: AssistantMessage[] = [];
    const endMessages = [
      {
        role: "assistant",
        content: [],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "m",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "error",
        errorMessage: "boom",
        timestamp: 1,
      },
    ];
    const loop = fakeAgentLoopWithEnd(() => {}, endMessages);

    // No observations recorded + error → runObserver throws
    await expect(
      runObserver({
        ...baseArgs,
        agentLoop: loop,
        onAssistantMessage: (m) => captured.push(m),
      }),
    ).rejects.toThrow("Observer API error: boom");
    // The usage-bearing assistant message was still captured before the throw
    expect(captured).toHaveLength(1);
  });
});

describe("reflector onAssistantMessage", () => {
  const observation: Observation = {
    id: "obs-1",
    content: "User prefers tabs.",
    timestamp: "2026-05-02 10:30",
    relevance: "high",
    sourceEntryIds: ["entry-a"],
    tokenCount: 5,
  };
  const baseArgs = {
    model: {} as any,
    apiKey: "test",
    reflections: [] as Reflection[],
    observations: [observation],
  };

  it("fires onAssistantMessage for assistant messages in agent_end", async () => {
    const captured: AssistantMessage[] = [];
    const endMessages = [assistantEndMessage("reflector-m")];

    const loop = fakeAgentLoopWithEnd(async (_prompts, context) => {
      await context.tools[0].execute("tool-1", {
        reflections: [
          {
            content: "User prefers tabs for formatting.",
            supportingObservationIds: ["obs-1"],
          },
        ],
      });
    }, endMessages);

    await runReflector({
      ...baseArgs,
      agentLoop: loop,
      onAssistantMessage: (m) => captured.push(m),
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].model).toBe("reflector-m");
    expect(captured[0].usage.output).toBe(50);
  });
});

describe("dropper onAssistantMessage", () => {
  // Build enough observations to exceed the drop threshold.
  const observations: Observation[] = Array.from({ length: 20 }, (_, i) => ({
    id: `obs-${i}`,
    content: `Stale fact number ${i}.`,
    timestamp: "2026-05-02 10:30",
    relevance: "low" as const,
    sourceEntryIds: ["entry-a"],
    tokenCount: 100,
  }));
  const baseArgs = {
    model: {} as any,
    apiKey: "test",
    reflections: [] as Reflection[],
    observations,
    existingObservationsSummary: undefined as string | undefined,
    budgetTokens: 1_000,
  };

  it("fires onAssistantMessage for assistant messages in agent_end", async () => {
    const captured: AssistantMessage[] = [];
    const endMessages = [assistantEndMessage("dropper-m")];

    const loop = fakeAgentLoopWithEnd(async (_prompts, context) => {
      await context.tools[0].execute("tool-1", { ids: ["obs-0", "obs-1"] });
    }, endMessages);

    await runDropper({
      ...baseArgs,
      agentLoop: loop,
      onAssistantMessage: (m) => captured.push(m),
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].model).toBe("dropper-m");
    expect(captured[0].usage.input).toBe(100);
  });
});
