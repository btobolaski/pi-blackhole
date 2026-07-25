/** Best-effort observer-only flush, bounded across waiting and model work. */
import type { ExtensionAPI, SessionShutdownEvent } from "@earendil-works/pi-coding-agent";
import { matchesSkippedProvider } from "../core/provider-skip.js";
import {
  createWorkerUsageLogger,
  makeModelResolver,
  runObserverStage,
  type ConsolidationCtx,
} from "./consolidation.js";
import { debugLog, withDebugLogContext } from "./debug-log.js";
import type { Runtime } from "./runtime.js";
import { runWorkerAttempt } from "./worker-attempt.js";

export const SHUTDOWN_OBSERVE_TIMEOUT_MS = 20_000;
export const SHUTDOWN_OBSERVE_MIN_TOKENS = 200;

export async function observeTailOnShutdown(
  pi: ExtensionAPI,
  runtime: Runtime,
  ctx: ConsolidationCtx,
  reason: SessionShutdownEvent["reason"],
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
    // A shutdown arriving on an already-disposed runtime (second shutdown for
    // the same session) has an aborted parent signal: runWorkerAttempt would
    // reject immediately and the catch below would log a benign sequence as
    // observer.shutdown_error. Return silently; finally still disposes.
    if (initial.signal.aborted) return;
    const runId = `shutdown-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
    await withDebugLogContext({ enabled: config.debugLog === true, cwd: ctx.cwd, runId }, () =>
      runWorkerAttempt("observer", SHUTDOWN_OBSERVE_TIMEOUT_MS, initial.signal, async (signal) => {
        // The host-context accessor must stay lazy inside the guard: pi
        // reports invalidation by throwing on `ctx.sessionManager` access,
        // so capturing the manager object up front would pin the
        // pre-invalidation target and the guard would never trip.
        runtime.guardShutdownContext(
          () => !signal.aborted && ctx.sessionManager.getSessionId() === sessionId,
        );
        await runtime.consolidationPromise;
        signal.throwIfAborted();
        if (!runtime.isGenerationActive(initial) || runtime.isConsolidationRetryGated()) return;
        const generation = { ...runtime.captureGeneration(sessionId), signal };
        if (runtime.cursorsLoadedSessionId !== sessionId) {
          runtime.loadCursorsFromPending(sessionId);
          runtime.cursorsLoadedSessionId = sessionId;
        }
        // This is a new observer cycle, not a continuation of the last
        // reflector/dropper cycle (whose size and transient skips may linger).
        runtime.consolidationPhase = "observer";
        runtime.failedInCycle.clear();
        runtime.turnCapSkippedInCycle.clear();
        runtime.sizeSkippedInCycle.clear();
        runtime.resolveFailureNotified = false;
        const previousCursor = runtime.getCursor("observer");
        const previousEntryId = previousCursor?.entryId;
        const previousState = previousCursor?.state;
        const resolve = makeModelResolver(runtime, ctx, generation);
        // Resolution may walk unavailable candidates, but shutdown never retries
        // a request or drains another chunk after this one attempt.
        const outcome = await runObserverStage(
          pi,
          runtime,
          ctx,
          generation,
          resolve,
          false,
          0,
          {
            dueAfterTokens: SHUTDOWN_OBSERVE_MIN_TOKENS,
            maxAttempts: 1,
            maxTurns: 1,
            signal,
          },
          createWorkerUsageLogger(runtime, ctx),
        );
        const cursor = runtime.getCursor("observer");
        if (
          outcome !== "abort" &&
          runtime.isGenerationActive(generation) &&
          (cursor?.entryId !== previousEntryId || cursor?.state !== previousState) &&
          (cursor?.state === "recorded" || cursor?.state === "empty")
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
