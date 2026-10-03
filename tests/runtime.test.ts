/**
 * Runtime model resolution tests — fallback chain + stage-local failures.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const testDir = join(tmpdir(), `pi-blackhole-runtime-test-${Date.now()}`);

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => testDir,
  estimateTokens: () => 250, // ~1 token per 4 chars
}));

// ── Helpers ────────────────────────────────────────────────────────────────

function writeConfig(data: unknown, filename = "pi-blackhole/pi-blackhole-config.json"): string {
  const dir = join(testDir, dirname(filename));
  mkdirSync(dir, { recursive: true });
  const path = join(testDir, filename);
  writeFileSync(path, JSON.stringify(data, null, 2));
  return path;
}

function cooldownFile() {
  return join(testDir, "pi-blackhole", "pi-blackhole-cooldown.json");
}

function readCooldownFile(): Record<string, unknown> {
  const p = cooldownFile();
  if (!existsSync(p)) return {};
  return JSON.parse(readFileSync(p, "utf-8"));
}

function makeModel(id: string, provider = "openrouter", overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider,
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
    ...overrides,
  };
}

type RegistryOptions = {
  requestBaseUrl?: string;
  providerBaseUrl?: string;
  env?: Record<string, string>;
};

function makeRegistry(models: ReturnType<typeof makeModel>[], options: RegistryOptions = {}) {
  return {
    models,
    find: vi.fn((p: string, id: string) => models.find((m) => m.provider === p && m.id === id)),
    hasConfiguredAuth: vi.fn(() => true),
    getApiKeyAndHeaders: vi.fn(async () => ({
      ok: true,
      apiKey: "sk-test",
      headers: undefined,
      ...(options.env ? { env: options.env } : {}),
      ...(options.requestBaseUrl ? { baseUrl: options.requestBaseUrl } : {}),
    })),
    getProviderAuth: vi.fn(async () =>
      options.providerBaseUrl ? { auth: { baseUrl: options.providerBaseUrl } } : undefined,
    ),
  };
}

beforeEach(() => {
  mkdirSync(testDir, { recursive: true });
});
afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  vi.resetAllMocks();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Runtime.resolveModel — fallback chain", () => {
  it("forwards environment substitutions from model auth", async () => {
    writeConfig({
      observerModel: { provider: "cloudflare-workers-ai", id: "model" },
    });
    const model = makeModel("model", "cloudflare-workers-ai");
    const registry = makeRegistry([model], {
      env: { CLOUDFLARE_ACCOUNT_ID: "account-123" },
    });
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.ensureConfig(testDir);

    const result = await runtime.resolveModel({
      model: undefined,
      modelRegistry: registry,
      hasUI: false,
      stageModel: { provider: "cloudflare-workers-ai", id: "model" },
    });

    expect(result).toMatchObject({
      ok: true,
      env: { CLOUDFLARE_ACCOUNT_ID: "account-123" },
    });
  });

  it("refreshes a stale ambient credential snapshot once", async () => {
    writeConfig({
      observerModel: { provider: "amazon-bedrock", id: "model" },
    });
    const model = makeModel("model", "amazon-bedrock");
    let configured = false;
    const registry = {
      ...makeRegistry([model]),
      hasConfiguredAuth: vi.fn(() => configured),
      getApiKeyAndHeaders: vi.fn(async () => ({ ok: true })),
      refresh: vi.fn(async () => {
        configured = true;
      }),
      isUsingOAuth: vi.fn(() => false),
    };
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.ensureConfig(testDir);

    const result = await runtime.resolveModel({
      model: undefined,
      modelRegistry: registry,
      hasUI: false,
      stageModel: { provider: "amazon-bedrock", id: "model" },
    });

    expect(result.ok).toBe(true);
    expect(registry.refresh).toHaveBeenCalledWith(
      expect.objectContaining({
        allowNetwork: false,
        providers: ["amazon-bedrock"],
      }),
    );
  });
  it("resolves primary stage model when available", async () => {
    writeConfig({
      observerModel: { provider: "openrouter", id: "primary-model:free" },
      observerFallbackModels: [{ provider: "openrouter", id: "fallback-model:free" }],
    });
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.ensureConfig(testDir);

    const registry = makeRegistry([
      makeModel("primary-model:free", "openrouter"),
      makeModel("fallback-model:free", "openrouter"),
    ]);

    const result = await runtime.resolveModel({
      model: undefined,
      modelRegistry: registry,
      hasUI: false,
      stageModel: { provider: "openrouter", id: "primary-model:free" },
      stageFallbacks: [{ provider: "openrouter", id: "fallback-model:free" }],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model.id).toBe("primary-model:free");
    }
  });
  it("preserves a credential-resolved endpoint from provider auth on configured candidate", async () => {
    writeConfig({
      observerModel: {
        provider: "github-copilot",
        id: "gpt-5.6-luna",
      },
    });
    const model = makeModel("gpt-5.6-luna", "github-copilot", {
      baseUrl: "https://api.individual.githubcopilot.com",
    });
    const registry = makeRegistry([model], {
      providerBaseUrl: "https://api.enterprise.githubcopilot.com",
    });
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.ensureConfig(testDir);

    const result = await runtime.resolveModel({
      model: undefined,
      modelRegistry: registry,
      hasUI: false,
      stageModel: {
        provider: "github-copilot",
        id: "gpt-5.6-luna",
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model.baseUrl).toBe("https://api.enterprise.githubcopilot.com");
    }
    expect(registry.getProviderAuth).toHaveBeenCalledWith("github-copilot");
  });

  it("falls back to provider auth for registries without request baseUrl", async () => {
    writeConfig({
      observerModel: {
        provider: "github-copilot",
        id: "cooled-model",
      },
    });
    const sessionModel = makeModel("session-model", "github-copilot", {
      baseUrl: "https://api.individual.githubcopilot.com",
    });
    const registry = makeRegistry([sessionModel], {
      providerBaseUrl: "https://api.enterprise.githubcopilot.com",
    });
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.ensureConfig(testDir);
    runtime.recordStageFailure({
      provider: "github-copilot",
      id: "cooled-model",
    });

    const result = await runtime.resolveModel({
      model: sessionModel,
      modelRegistry: registry,
      hasUI: false,
      stageModel: {
        provider: "github-copilot",
        id: "cooled-model",
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model.baseUrl).toBe("https://api.enterprise.githubcopilot.com");
    }
    expect(registry.getProviderAuth).toHaveBeenCalledWith("github-copilot");
  });

  it("returns original model reference when resolved baseUrl equals model.baseUrl", async () => {
    writeConfig({
      observerModel: {
        provider: "github-copilot",
        id: "gpt-5.6-luna",
      },
    });
    const model = makeModel("gpt-5.6-luna", "github-copilot", {
      baseUrl: "https://api.enterprise.githubcopilot.com",
    });
    const registry = makeRegistry([model], {
      providerBaseUrl: "https://api.enterprise.githubcopilot.com",
    });
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.ensureConfig(testDir);

    const result = await runtime.resolveModel({
      model: undefined,
      modelRegistry: registry,
      hasUI: false,
      stageModel: {
        provider: "github-copilot",
        id: "gpt-5.6-luna",
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model).toBe(model);
    }
  });

  it("treats whitespace-only baseUrl from provider auth as absent", async () => {
    writeConfig({
      observerModel: {
        provider: "github-copilot",
        id: "gpt-5.6-luna",
      },
    });
    const model = makeModel("gpt-5.6-luna", "github-copilot", {
      baseUrl: "https://api.individual.githubcopilot.com",
    });
    const registry = makeRegistry([model], {
      providerBaseUrl: "  ",
    });
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.ensureConfig(testDir);

    const result = await runtime.resolveModel({
      model: undefined,
      modelRegistry: registry,
      hasUI: false,
      stageModel: {
        provider: "github-copilot",
        id: "gpt-5.6-luna",
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model.baseUrl).toBe("https://api.individual.githubcopilot.com");
      expect(result.model).toBe(model);
    }
  });

  it("gracefully handles getProviderAuth throwing", async () => {
    writeConfig({
      observerModel: {
        provider: "github-copilot",
        id: "gpt-5.6-luna",
      },
    });
    const model = makeModel("gpt-5.6-luna", "github-copilot", {
      baseUrl: "https://api.individual.githubcopilot.com",
    });
    const registry = makeRegistry([model], {});
    registry.getProviderAuth = vi.fn(async () => {
      throw new Error("auth service down");
    });
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.ensureConfig(testDir);

    const result = await runtime.resolveModel({
      model: undefined,
      modelRegistry: registry,
      hasUI: false,
      stageModel: {
        provider: "github-copilot",
        id: "gpt-5.6-luna",
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model.baseUrl).toBe("https://api.individual.githubcopilot.com");
      expect(result.model).toBe(model);
    }
  });

  it("skips a failed primary within the stage, uses fallback", async () => {
    writeConfig({
      observerModel: {
        provider: "openrouter",
        id: "primary-model:free",
      },
      observerFallbackModels: [{ provider: "openrouter", id: "fallback-model:free" }],
    });

    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.ensureConfig(testDir);
    runtime.recordStageFailure({
      provider: "openrouter",
      id: "primary-model:free",
    });

    const registry = makeRegistry([
      makeModel("primary-model:free", "openrouter"),
      makeModel("fallback-model:free", "openrouter"),
    ]);

    const result = await runtime.resolveModel({
      model: undefined,
      modelRegistry: registry,
      hasUI: false,
      stageModel: { provider: "openrouter", id: "primary-model:free" },
      stageFallbacks: [{ provider: "openrouter", id: "fallback-model:free" }],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model.id).toBe("fallback-model:free");
    }
  });

  it("falls through to config.model when stage models failed", async () => {
    writeConfig({
      observerModel: {
        provider: "openrouter",
        id: "primary:free",
      },
      observerFallbackModels: [{ provider: "openrouter", id: "fallback:free" }],
      model: { provider: "openrouter", id: "base:free" },
    });

    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.ensureConfig(testDir);
    runtime.recordStageFailure({ provider: "openrouter", id: "primary:free" });
    runtime.recordStageFailure({ provider: "openrouter", id: "fallback:free" });

    const registry = makeRegistry([
      makeModel("primary:free", "openrouter"),
      makeModel("fallback:free", "openrouter"),
      makeModel("base:free", "openrouter"),
    ]);

    const result = await runtime.resolveModel({
      model: undefined,
      modelRegistry: registry,
      hasUI: false,
      stageModel: { provider: "openrouter", id: "primary:free" },
      stageFallbacks: [{ provider: "openrouter", id: "fallback:free" }],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model.id).toBe("base:free");
    }
  });

  it("falls through to session model when all candidates exhausted", async () => {
    writeConfig({
      observerModel: { provider: "openrouter", id: "primary:free" },
    });

    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.ensureConfig(testDir);
    runtime.recordStageFailure({ provider: "openrouter", id: "primary:free" });

    const registry = makeRegistry([
      makeModel("primary:free", "openrouter"),
      makeModel("session-model", "openrouter"),
    ]);

    const result = await runtime.resolveModel({
      model: makeModel("session-model", "openrouter"),
      modelRegistry: registry,
      hasUI: false,
      stageModel: { provider: "openrouter", id: "primary:free" },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model.id).toBe("session-model");
    }
  });

  it("skips session model fallback when sessionFallback is false", async () => {
    writeConfig({
      observerModel: { provider: "openrouter", id: "primary:free" },
      sessionFallback: false,
    });

    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.ensureConfig(testDir);
    runtime.recordStageFailure({ provider: "openrouter", id: "primary:free" });

    const registry = makeRegistry([makeModel("primary:free", "openrouter")]);

    const result = await runtime.resolveModel({
      model: makeModel("session-model", "openrouter"),
      modelRegistry: registry,
      hasUI: false,
      stageModel: { provider: "openrouter", id: "primary:free" },
    });

    // Should NOT fall through to session model — returns ok: false
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("sessionFallback disabled");
    }
  });

  it("skips model in failedInCycle, uses fallback", async () => {
    writeConfig({
      observerModel: {
        provider: "openrouter",
        id: "primary:free",
      },
      observerFallbackModels: [{ provider: "openrouter", id: "fallback:free" }],
    });

    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.ensureConfig(testDir);

    // Simulate: primary model failed this cycle → tracked in-memory
    runtime.recordStageFailure({ provider: "openrouter", id: "primary:free" });

    const registry = makeRegistry([
      makeModel("primary:free", "openrouter"),
      makeModel("fallback:free", "openrouter"),
    ]);

    const result = await runtime.resolveModel({
      model: undefined,
      modelRegistry: registry,
      hasUI: false,
      stageModel: { provider: "openrouter", id: "primary:free" },
      stageFallbacks: [{ provider: "openrouter", id: "fallback:free" }],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Should skip primary (in failedInCycle) and use fallback
      expect(result.model.id).toBe("fallback:free");
    }
    // No cooldown was written to disk for the primary model
    const data = readCooldownFile();
    expect(data["openrouter/primary:free"]).toBeUndefined();
  });

  it("clears failedInCycle between stages so model retried fresh", async () => {
    writeConfig({
      observerModel: {
        provider: "openrouter",
        id: "primary:free",
      },
    });

    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.ensureConfig(testDir);

    // Simulate failure in observer stage
    runtime.recordStageFailure({ provider: "openrouter", id: "primary:free" });
    expect(runtime.failedInCycle.has("openrouter/primary:free")).toBe(true);

    // Clear as pipeline does between stages
    runtime.failedInCycle.clear();

    const registry = makeRegistry([makeModel("primary:free", "openrouter")]);

    // After clear, primary should be available again
    const result = await runtime.resolveModel({
      model: undefined,
      modelRegistry: registry,
      hasUI: false,
      stageModel: { provider: "openrouter", id: "primary:free" },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model.id).toBe("primary:free");
    }
  });
});

// ── Phase 9: Consolidation trigger guards ─────────────────────────────────

describe("Consolidation trigger — guards with new config keys", () => {
  function createConsolidationContext(configOverrides: Record<string, unknown> = {}) {
    let agentStartHandler: ((event: any, ctx: any) => void) | undefined;
    const pi = {
      on: vi.fn((name: string, cb: any) => {
        if (name === "agent_start") agentStartHandler = cb;
      }),
    };
    const launchConsolidationTask = vi.fn();
    let mockGeneration = 0;
    const mockController = new AbortController();
    const runtime = {
      ensureConfig: vi.fn(),
      resetInfoGate: vi.fn(),
      tryEmitInfo: vi.fn(),
      captureGeneration: vi.fn((identity: string | undefined) => ({
        generation: mockGeneration,
        sessionIdentity: identity,
        signal: mockController.signal,
      })),
      isGenerationActive: vi.fn(
        (gen: { generation: number; sessionIdentity: string | undefined; signal: AbortSignal }) =>
          gen.generation === mockGeneration && !gen.signal.aborted,
      ),
      startSession: vi.fn((identity: string | undefined) => {
        mockSessionIdentity = identity;
      }),
      dispose: vi.fn(() => {
        mockGeneration += 1;
        mockController.abort();
      }),
      config: {
        memory: true,
        observeAfterTokens: 1, // always due
        reflectAfterTokens: 999999, // never due
        compactAfterTokens: 1000,
        passive: false,
        noAutoCompact: false,
        debugLog: true,
        observerChunkMaxTokens: 10000,
        observerPreambleMaxTokens: 500,
        observationsPoolMaxTokens: 50000,
        reflectorInputMaxTokens: 10000,
        dropperInputMaxTokens: 10000,
        agentMaxTurns: 5,
        model: undefined,
        observerModel: undefined,
        observerFallbackModels: [],
        reflectorModel: undefined,
        reflectorFallbackModels: [],
        dropperModel: undefined,
        dropperFallbackModels: [],
        ...configOverrides,
      },
      consolidationInFlight: false,
      isConsolidationRetryGated: vi.fn(() => false),
      launchConsolidationTask,
    };
    const ctx = {
      cwd: testDir,
      hasUI: false,
      sessionManager: {
        getBranch: vi.fn(() => [
          {
            id: "m1",
            type: "message",
            message: {
              role: "user",
              content: [{ type: "text", text: "x".repeat(1000) }],
            },
          },
          {
            id: "m2",
            type: "message",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "y".repeat(1000) }],
            },
          },
        ]),
        getSessionId: vi.fn(() => "test-session"),
      },
    };
    return {
      pi,
      runtime,
      ctx,
      agentStartHandler: () => agentStartHandler!({}, ctx),
    };
  }

  it("T38: memory:false skips consolidation even with sufficient tokens", async () => {
    const { pi, runtime, agentStartHandler } = createConsolidationContext({
      memory: false,
    });
    const { registerConsolidationTrigger } = await import("../src/om/consolidation.js");
    registerConsolidationTrigger(pi as any, runtime as any);

    agentStartHandler();

    expect(runtime.launchConsolidationTask).not.toHaveBeenCalled();
  });

  it("T39: memory:true + compaction:off runs consolidation", async () => {
    const { pi, runtime, agentStartHandler } = createConsolidationContext({
      memory: true,
      compaction: "off",
    });
    const { registerConsolidationTrigger } = await import("../src/om/consolidation.js");
    registerConsolidationTrigger(pi as any, runtime as any);

    agentStartHandler();

    expect(runtime.launchConsolidationTask).toHaveBeenCalled();
  });

  it("T40: passive:true (legacy, no new keys) blocks consolidation via legacy guard", async () => {
    const { pi, runtime, agentStartHandler } = createConsolidationContext({
      passive: true,
      compaction: undefined,
      compactionEngine: undefined,
    });
    const { registerConsolidationTrigger } = await import("../src/om/consolidation.js");
    registerConsolidationTrigger(pi as any, runtime as any);

    agentStartHandler();

    expect(runtime.launchConsolidationTask).not.toHaveBeenCalled();
  });
});

describe("Runtime — failures never persist across stages", () => {
  it.each(["configured", "session"])(
    "ignores legacy cooldown entries for %s models",
    async (route) => {
      const provider = "openrouter";
      writeConfig({});
      const model = makeModel("legacy-model", provider);
      writeConfig(
        {
          [`${provider}/${model.id}`]: {
            until: new Date(Date.now() + 3_600_000).toISOString(),
            reason: "Observer API error: Request timed out.",
            stage: "observer",
          },
        },
        "pi-blackhole/pi-blackhole-cooldown.json",
      );
      const { Runtime } = await import("../src/om/runtime.js");
      const runtime = new Runtime();
      runtime.ensureConfig(testDir);

      const result = await runtime.resolveModel({
        model: route === "session" ? model : undefined,
        modelRegistry: makeRegistry([model]),
        hasUI: false,
        stageModel: route === "configured" ? { provider, id: model.id } : undefined,
      });

      expect(result).toMatchObject({ ok: true, model: { provider, id: model.id } });
    },
  );

  it("does not write a cooldown after a model failure", async () => {
    writeConfig({});
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.ensureConfig(testDir);
    runtime.recordStageFailure({ provider: "openrouter", id: "worker" });

    expect(existsSync(cooldownFile())).toBe(false);
  });

  it("does not retry a failed candidate as the session model in the same stage", async () => {
    writeConfig({});
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.ensureConfig(testDir);
    const model = makeModel("shared-model");
    runtime.recordStageFailure(model);

    const result = await runtime.resolveModel({
      model,
      modelRegistry: makeRegistry([model]),
      hasUI: false,
      stageModel: { provider: model.provider, id: model.id },
    });

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("failed this cycle"),
    });
  });

  it("resolves a previously failed model after failedInCycle is cleared", async () => {
    writeConfig({});
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.ensureConfig(testDir);
    const model = makeModel("retry-next-stage");
    runtime.recordStageFailure(model);
    runtime.failedInCycle.clear();

    const result = await runtime.resolveModel({
      model: undefined,
      modelRegistry: makeRegistry([model]),
      hasUI: false,
      stageModel: { provider: model.provider, id: model.id },
    });

    expect(result).toMatchObject({ ok: true, model: { id: model.id } });
  });
});

describe("Runtime — retry gating", () => {
  it("isConsolidationRetryGated returns false initially", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    expect(runtime.isConsolidationRetryGated()).toBe(false);
  });

  it("isConsolidationRetryGated returns true after markConsolidationError", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.markConsolidationError();
    expect(runtime.isConsolidationRetryGated()).toBe(true);
  });

  it("markConsolidationError also sets recorded error on Runtime state", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    expect(runtime.lastConsolidationErrorAt).toBeUndefined();
    runtime.markConsolidationError();
    expect(runtime.lastConsolidationErrorAt).toBeGreaterThan(0);
  });
});

describe("Runtime.resolveModel — resolution provenance", () => {
  it("returns the exact selected stage candidate config", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.ensureConfig(testDir);
    const stageModel = {
      provider: "openrouter",
      id: "obs-primary:free",
      cooldownHours: 0,
    };

    const result = await runtime.resolveModel({
      model: undefined,
      modelRegistry: makeRegistry([makeModel(stageModel.id, stageModel.provider)]),
      hasUI: false,
      stageModel,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe("candidate");
      if (result.source === "candidate") expect(result.candidateConfig).toBe(stageModel);
    }
  });

  it("marks the base config model as a candidate", async () => {
    writeConfig({
      model: { provider: "openrouter", id: "base-fallback:free" },
    });
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.ensureConfig(testDir);

    const result = await runtime.resolveModel({
      model: undefined,
      modelRegistry: makeRegistry([makeModel("base-fallback:free", "openrouter")]),
      hasUI: false,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe("candidate");
      if (result.source === "candidate") {
        expect(result.candidateConfig).toMatchObject({
          provider: "openrouter",
          id: "base-fallback:free",
        });
      }
    }
  });

  it("marks the session fallback without a candidate config", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.ensureConfig(testDir);
    const sessionModel = makeModel("session-only", "openrouter");

    const result = await runtime.resolveModel({
      model: sessionModel,
      modelRegistry: makeRegistry([]),
      hasUI: false,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe("session");
      expect("candidateConfig" in result).toBe(false);
    }
  });
});

describe("Runtime — stage-local failure tracking", () => {
  it.each(["failure", "size"] as const)(
    "normalizes a %s skip before matching the session fallback",
    async (kind) => {
      const { Runtime } = await import("../src/om/runtime.js");
      writeConfig({});
      const runtime = new Runtime();
      runtime.ensureConfig(testDir);
      const identity = { provider: " OpenAI ", id: " SHARED-MODEL " };
      if (kind === "failure") runtime.recordStageFailure(identity);
      else runtime.skipOversizedForCycle(identity);
      const model = makeModel("shared-model", "openai");

      const result = await runtime.resolveModel({
        model,
        modelRegistry: makeRegistry([model]),
        hasUI: false,
      });

      expect(result).toMatchObject({
        ok: false,
        reason: expect.stringContaining(kind === "failure" ? "failed this cycle" : "too small"),
      });
    },
  );

  it.each([{ provider: "openrouter" }, { provider: 1, id: "model" }])(
    "ignores malformed model identities: %j",
    async (model) => {
      const { Runtime } = await import("../src/om/runtime.js");
      const runtime = new Runtime();

      runtime.recordStageFailure(model);

      expect(runtime.failedInCycle.size).toBe(0);
    },
  );

  it("skips a failed session-only model within the current stage", async () => {
    writeConfig({});
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.ensureConfig(testDir);
    const model = makeModel("session-only");
    runtime.recordStageFailure(model);

    const result = await runtime.resolveModel({
      model,
      modelRegistry: makeRegistry([]),
      hasUI: false,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("failed this cycle"),
    });
  });
});

describe("Runtime — sessionFallback notification", () => {
  it("fires info notification when sessionFallback disabled and failed models exhausted chain", async () => {
    writeConfig({
      observerModel: {
        provider: "openrouter",
        id: "primary:free",
      },
      sessionFallback: false,
    });

    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.ensureConfig(testDir);

    // Simulate: primary model failed → added to failedInCycle
    runtime.recordStageFailure({ provider: "openrouter", id: "primary:free" });

    const notify = vi.fn();
    const registry = makeRegistry([]);

    const result = await runtime.resolveModel({
      model: makeModel("session-model", "openrouter"),
      modelRegistry: registry,
      hasUI: true,
      ui: { notify },
      stageModel: { provider: "openrouter", id: "primary:free" },
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("sessionFallback disabled");
    // The first info notification fires ("failed this cycle"), the
    // second ("sessionFallback disabled") is gated by tryEmitInfo
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]).toEqual([expect.stringContaining("failed this cycle"), "info"]);
  });
});

describe("Runtime — model not found in registry (falls to next)", () => {
  it("skips candidate not found in registry, uses next available", async () => {
    writeConfig({
      observerModel: { provider: "openrouter", id: "nonexistent:free" },
      observerFallbackModels: [{ provider: "openrouter", id: "exists:free" }],
    });
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.ensureConfig(testDir);

    const registry = makeRegistry([makeModel("exists:free", "openrouter")]);

    const result = await runtime.resolveModel({
      model: undefined,
      modelRegistry: registry,
      hasUI: false,
      stageModel: { provider: "openrouter", id: "nonexistent:free" },
      stageFallbacks: [{ provider: "openrouter", id: "exists:free" }],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model.id).toBe("exists:free");
    }
  });
});

describe("Runtime.resolveModel — OAuth/ADC auth", () => {
  it("accepts stage candidate with hasConfiguredAuth=true and no static apiKey", async () => {
    writeConfig({
      observerModel: { provider: "vertex", id: "vertex-model" },
    });
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.ensureConfig(testDir);

    const registry = {
      models: [makeModel("vertex-model", "vertex", { api: "google-vertex" })],
      find: vi.fn((p: string, id: string) => makeModel(id, p, { api: "google-vertex" })),
      hasConfiguredAuth: vi.fn(() => true),
      getApiKeyAndHeaders: vi.fn(async () => ({
        ok: true,
        apiKey: undefined,
        headers: undefined,
      })),
    };

    const result = await runtime.resolveModel({
      model: undefined,
      modelRegistry: registry,
      hasUI: false,
      stageModel: { provider: "vertex", id: "vertex-model" },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model.id).toBe("vertex-model");
    }
    expect(result.apiKey).toBe(""); // type-safe default when no static key
  });

  it("accepts session model with hasConfiguredAuth=true and no static apiKey", async () => {
    writeConfig({
      observerModel: { provider: "openrouter", id: "primary:free" },
      sessionFallback: true,
    });
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.ensureConfig(testDir);

    // Skip the failed primary within this stage.
    runtime.recordStageFailure({ provider: "openrouter", id: "primary:free" });

    const registry = {
      models: [makeModel("primary:free", "openrouter")],
      find: vi.fn((p: string, id: string) => makeModel(id, p)),
      hasConfiguredAuth: vi.fn(() => true),
      getApiKeyAndHeaders: vi.fn(async () => ({
        ok: true,
        apiKey: undefined,
        headers: undefined,
      })),
    };

    const result = await runtime.resolveModel({
      model: makeModel("session-model", "vertex", { api: "google-vertex" }),
      modelRegistry: registry,
      hasUI: false,
      stageModel: { provider: "openrouter", id: "primary:free" },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model.id).toBe("session-model");
    }
    expect(result.apiKey).toBe("");
  });

  it("falls through candidate with no configured auth to next candidate", async () => {
    writeConfig({
      observerModel: { provider: "vertex", id: "vertex-no-auth" },
      observerFallbackModels: [{ provider: "openrouter", id: "openrouter-ok" }],
    });
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.ensureConfig(testDir);

    const registry = {
      models: [
        makeModel("vertex-no-auth", "vertex", { api: "google-vertex" }),
        makeModel("openrouter-ok", "openrouter"),
      ],
      find: vi.fn((p: string, id: string) => {
        const m = makeModel(id, p);
        if (p === "vertex") m.api = "google-vertex";
        return m;
      }),
      hasConfiguredAuth: vi.fn((m: any) => m.provider === "openrouter"),
      getApiKeyAndHeaders: vi.fn(async () => ({
        ok: true,
        apiKey: "sk-test",
        headers: undefined,
      })),
    };

    const result = await runtime.resolveModel({
      model: undefined,
      modelRegistry: registry,
      hasUI: false,
      stageModel: { provider: "vertex", id: "vertex-no-auth" },
      stageFallbacks: [{ provider: "openrouter", id: "openrouter-ok" }],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model.id).toBe("openrouter-ok");
    }
  });

  it("fails session model when it has no configured auth", async () => {
    writeConfig({
      observerModel: { provider: "openrouter", id: "primary:free" },
      sessionFallback: true,
    });
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.ensureConfig(testDir);

    // Skip the failed primary within this stage.
    runtime.recordStageFailure({ provider: "openrouter", id: "primary:free" });

    const registry = {
      models: [makeModel("primary:free", "openrouter")],
      find: vi.fn((p: string, id: string) => makeModel(id, p)),
      hasConfiguredAuth: vi.fn(() => false),
      getApiKeyAndHeaders: vi.fn(async () => ({
        ok: true,
        apiKey: undefined,
        headers: undefined,
      })),
    };

    const result = await runtime.resolveModel({
      model: makeModel("session-model", "vertex", { api: "google-vertex" }),
      modelRegistry: registry,
      hasUI: false,
      stageModel: { provider: "openrouter", id: "primary:free" },
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("no auth");
  });

  it("rejects candidate when getApiKeyAndHeaders returns ok:false even if hasConfiguredAuth is true", async () => {
    writeConfig({
      observerModel: { provider: "openrouter", id: "primary:free" },
      sessionFallback: true,
    });
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.ensureConfig(testDir);

    const registry = makeRegistry([makeModel("primary:free", "openrouter")]);
    // Override: auth call fails — hasConfiguredAuth doesn't bypass ok:false
    registry.getApiKeyAndHeaders = vi.fn(async () => ({
      ok: false,
      error: "network error",
    }));
    registry.hasConfiguredAuth = vi.fn(() => true);

    const result = await runtime.resolveModel({
      model: makeModel("session-model", "openrouter"),
      modelRegistry: registry,
      hasUI: false,
      stageModel: { provider: "openrouter", id: "primary:free" },
    });

    // Candidate rejected (auth.ok:false), then session model also rejected (auth.ok:false)
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("no auth");
  });

  it("uses legacy behavior when registry has no hasConfiguredAuth (older pi versions)", async () => {
    writeConfig({
      observerModel: { provider: "openrouter", id: "primary:free" },
    });
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.ensureConfig(testDir);

    // Registry without hasConfiguredAuth (pre-0.80.x pi)
    const registry = makeRegistry([makeModel("primary:free", "openrouter")]);
    registry.hasConfiguredAuth = undefined;
    registry.getApiKeyAndHeaders = vi.fn(async () => ({
      ok: true,
      apiKey: "sk-legacy",
      headers: undefined,
    }));

    const result = await runtime.resolveModel({
      model: undefined,
      modelRegistry: registry,
      hasUI: false,
      stageModel: { provider: "openrouter", id: "primary:free" },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.apiKey).toBe("sk-legacy");
    }
  });
});

describe("Runtime pipeline cursors", () => {
  it("starts with no cursors", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    expect(runtime.getCursor("observer")).toBeUndefined();
    expect(runtime.getCursor("reflector")).toBeUndefined();
    expect(runtime.getCursor("dropper")).toBeUndefined();
  });

  it("advances cursor and tracks state", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.advanceCursor("observer", "entry-1", "recorded");
    const cursor = runtime.getCursor("observer");
    expect(cursor).toBeDefined();
    expect(cursor!.entryId).toBe("entry-1");
    expect(cursor!.state).toBe("recorded");
  });

  it("progresses through states correctly", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    // Empty run advances cursor
    runtime.advanceCursor("observer", "entry-2", "empty");
    expect(runtime.getCursor("observer")!.state).toBe("empty");
    // Next run records output
    runtime.advanceCursor("observer", "entry-3", "recorded");
    expect(runtime.getCursor("observer")!.state).toBe("recorded");
    expect(runtime.getCursor("observer")!.entryId).toBe("entry-3");
  });

  it("skipped state is tracked", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.advanceCursor("dropper", "entry-4", "skipped");
    expect(runtime.getCursor("dropper")!.state).toBe("skipped");
  });

  it("each stage cursor is independent", async () => {
    const { Runtime } = await import("../src/om/runtime.js");
    const runtime = new Runtime();
    runtime.advanceCursor("observer", "obs-1", "recorded");
    runtime.advanceCursor("reflector", "ref-1", "empty");
    runtime.advanceCursor("dropper", "drop-1", "skipped");
    expect(runtime.getCursor("observer")!.entryId).toBe("obs-1");
    expect(runtime.getCursor("reflector")!.entryId).toBe("ref-1");
    expect(runtime.getCursor("dropper")!.entryId).toBe("drop-1");
  });
});

it("loads cursors from pending state", async () => {
  const { Runtime } = await import("../src/om/runtime.js");
  // Pre-populate a pending file with cursors
  const pendingDir = join(testDir, "pi-blackhole");
  mkdirSync(pendingDir, { recursive: true });
  const pending = {
    cursors: {
      observer: { entryId: "obs-loaded", state: "recorded" },
      reflector: { entryId: "ref-loaded", state: "empty" },
    },
  };
  writeFileSync(join(pendingDir, "test-session-pending.json"), JSON.stringify(pending));

  const runtime = new Runtime();
  runtime.loadCursorsFromPending("test-session");
  expect(runtime.getCursor("observer")!.entryId).toBe("obs-loaded");
  expect(runtime.getCursor("observer")!.state).toBe("recorded");
  expect(runtime.getCursor("reflector")!.entryId).toBe("ref-loaded");
  expect(runtime.getCursor("reflector")!.state).toBe("empty");
  expect(runtime.getCursor("dropper")).toBeUndefined();
});

it("saves cursors to pending state", async () => {
  const { Runtime } = await import("../src/om/runtime.js");
  const runtime = new Runtime();
  runtime.advanceCursor("observer", "obs-save", "recorded");
  runtime.advanceCursor("dropper", "drop-save", "skipped");

  // Save cursors synchronously (test helper)
  runtime.saveCursorsToPending("test-session");

  // Read back from file
  const raw = JSON.parse(
    readFileSync(join(testDir, "pi-blackhole", "test-session-pending.json"), "utf-8"),
  );
  expect(raw.cursors.observer.entryId).toBe("obs-save");
  expect(raw.cursors.observer.state).toBe("recorded");
  expect(raw.cursors.dropper.entryId).toBe("drop-save");
  expect(raw.cursors.dropper.state).toBe("skipped");
  expect(raw.cursors.reflector).toBeUndefined();
});

it("cursor deletion is persisted across save/load", async () => {
  const { Runtime } = await import("../src/om/runtime.js");
  const runtime = new Runtime();
  runtime.advanceCursor("observer", "obs-keep", "recorded");
  runtime.advanceCursor("reflector", "ref-keep", "empty");
  runtime.advanceCursor("dropper", "drop-del", "skipped");
  runtime.saveCursorsToPending("test-session");

  // Simulate validateCursors: after a fork, dropper entryId no longer
  // exists in branch → cursor is deleted from in-memory map.
  delete (runtime as any).cursors.dropper;
  runtime.saveCursorsToPending("test-session");

  // Reload: deletion must be persisted - dropper should be absent.
  // Bug: writePendingCursors does { ...state.cursors, ...cursors }
  // which preserves deleted keys from the old state on disk.
  const fresh = new Runtime();
  fresh.loadCursorsFromPending("test-session");
  expect(fresh.getCursor("observer")!.entryId).toBe("obs-keep");
  expect(fresh.getCursor("reflector")!.entryId).toBe("ref-keep");
  expect(fresh.getCursor("dropper")).toBeUndefined();
});

it("handles corrupt pending file gracefully", async () => {
  const { Runtime } = await import("../src/om/runtime.js");
  const pendingDir = join(testDir, "pi-blackhole");
  mkdirSync(pendingDir, { recursive: true });
  writeFileSync(join(pendingDir, "test-session-pending.json"), "not valid json");

  const runtime = new Runtime();
  // Should not throw
  expect(() => runtime.loadCursorsFromPending("test-session")).not.toThrow();
  expect(runtime.getCursor("observer")).toBeUndefined();
});

it("handles missing pending file gracefully", async () => {
  const { Runtime } = await import("../src/om/runtime.js");
  const runtime = new Runtime();
  expect(() => runtime.loadCursorsFromPending("nonexistent-session")).not.toThrow();
  expect(runtime.getCursor("observer")).toBeUndefined();
});
