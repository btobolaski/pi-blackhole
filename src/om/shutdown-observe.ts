/** Best-effort observer-only flush, bounded across waiting and model work. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesSkippedProvider } from "../core/provider-skip.js";
import { makeModelResolver, runObserverStage, type ConsolidationCtx } from "./consolidation.js";
import { debugLog, withDebugLogContext } from "./debug-log.js";
import type { Runtime } from "./runtime.js";
import { runWorkerAttempt } from "./worker-attempt.js";

export const SHUTDOWN_OBSERVE_TIMEOUT_MS = 20_000;
export const SHUTDOWN_OBSERVE_MIN_TOKENS = 200;

export async function observeTailOnShutdown(
  pi: ExtensionAPI,
  runtime: Runtime,
  ctx: ConsolidationCtx,
  reason: string,
): Promise<void> {
  try {
    const config = runtime.config;
    if (!config.observeOnShutdown) return;
    if (!["quit", "new", "resume", "fork"].includes(reason)) return;
    if (ctx.sessionManager.isPersisted?.() === false || config.memory === false) return;
    if (matchesSkippedProvider(config, ctx.model)) return;
    if (
      config.compaction === undefined &&
      config.compactionEngine === undefined &&
      config.passive === true
    )
      return;
    if (runtime.isConsolidationRetryGated()) return;
    const sessionId = ctx.sessionManager.getSessionId();
    const initial = runtime.captureGeneration(sessionId);
    await withDebugLogContext({ enabled: config.debugLog === true, cwd: ctx.cwd }, () =>
      runWorkerAttempt("observer", SHUTDOWN_OBSERVE_TIMEOUT_MS, initial.signal, async (signal) => {
        runtime.guardShutdownContext(
          () => !signal.aborted && ctx.sessionManager.getSessionId() === sessionId,
        );
        await runtime.consolidationPromise;
        signal.throwIfAborted();
        if (!runtime.isGenerationActive(initial) || runtime.isConsolidationRetryGated()) return;
        const generation = { ...runtime.captureGeneration(sessionId), signal };
        if (runtime.cursorsLoadedSessionId !== sessionId) runtime.loadCursorsFromPending(sessionId);
        // This is a new observer cycle, not a continuation of the last
        // reflector/dropper cycle (whose size and transient skips may linger).
        runtime.consolidationPhase = "observer";
        runtime.failedInCycle.clear();
        runtime.turnCapSkippedInCycle.clear();
        runtime.sizeSkippedInCycle.clear();
        runtime.resolveFailureNotified = false;
        const previousCursor = runtime.getCursor("observer");
        const resolve = makeModelResolver(runtime, ctx, generation);
        // Resolution may walk unavailable candidates, but shutdown never retries
        // a request or drains another chunk after this one attempt.
        const outcome = await runObserverStage(pi, runtime, ctx, generation, resolve, false, 0, {
          dueAfterTokens: SHUTDOWN_OBSERVE_MIN_TOKENS,
          maxAttempts: 1,
          maxTurns: 1,
          signal,
        });
        const cursor = runtime.getCursor("observer");
        if (
          outcome !== "abort" &&
          runtime.isGenerationActive(generation) &&
          cursor !== previousCursor &&
          cursor?.state === "recorded"
        ) {
          if (ctx.sessionManager.getSessionId() === sessionId)
            runtime.saveCursorsToPending(sessionId);
        }
      }),
    );
  } catch (error) {
    debugLog("observer.shutdown_error", { error: String(error) }, runtime.config.debugLog === true);
  } finally {
    runtime.dispose();
  }
}
