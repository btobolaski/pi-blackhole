/**
 * /pi-vcc command — triggers pi-vcc compaction.
 *
 * Upstream: https://github.com/sting8k/pi-vcc (src/commands/pi-vcc.ts)
 * Modified by pi-vcc-om:
 * - Flushes pending OM state (observations/reflections/dropped) when manual mode is active
 *   before triggering compaction, so the compaction summary includes all accumulated memory.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../om/runtime.js";
import {
  PI_VCC_COMPACT_INSTRUCTION,
  notifyMigrationReminder,
  formatCompactionStats,
} from "../hooks/before-compact";
import {
  clearPendingBatches,
  migrateLegacyObserverCatchUp,
  readPendingState,
} from "../om/pending.js";
import {
  entryIndexForId,
  findLastCompactionIndex,
  isSourceEntry,
  OM_OBSERVER_CATCH_UP_JOB,
  OM_OBSERVATIONS_DROPPED,
  OM_OBSERVATIONS_RECORDED,
  OM_REFLECTIONS_RECORDED,
  type Entry,
} from "../om/ledger/index.js";

export const registerPiVccCommand = (pi: ExtensionAPI, runtime: Runtime) => {
  const prefixMatch = (value: string, prefix: string): boolean => {
    return value.toLowerCase().startsWith(prefix.toLowerCase());
  };

  pi.registerCommand("blackhole", {
    description:
      "Manual compact with structural summary. Subcommands: [settings] config overlay, " +
      "[changelog] display changelog, [cleanup] remove orphaned files, [om-off]/[om-on] disable/enable observational memory.",
    getArgumentCompletions: (prefix: string) => {
      const subcommands = [
        {
          value: "settings",
          label: "Open configuration overlay [settings]",
        },
        {
          value: "changelog",
          label: "Display changelog [changelog]",
        },
        {
          value: "cleanup",
          label: "Remove orphaned pending files [cleanup]",
        },
        { value: "om-off", label: "Disable observational memory [om-off]" },
        { value: "om-on", label: "Enable observational memory [om-on]" },
      ];
      if (!prefix) return subcommands;
      // "configure" is an accepted alias for "settings" (routed by the
      // handler); surface the settings entry when the user types either.
      return subcommands.filter(
        (s) =>
          prefixMatch(s.value, prefix) ||
          (s.value === "settings" && prefixMatch("configure", prefix)),
      );
    },
    handler: async (args, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();

      // Handle subcommands
      const trimmed = (typeof args === "string" ? args : "").trim();
      if (trimmed === "configure" || trimmed === "settings") {
        // Open the config overlay ("configure" kept as a hidden alias)
        const { openBlackholeSettings, config, GLOBAL_CONFIG_DIR } =
          await import("../pi-base/blackhole-settings.js");
        await openBlackholeSettings(ctx);
        runtime.config = config.loadWithWarnings(ctx.cwd, GLOBAL_CONFIG_DIR).config;
        runtime.configLoaded = true;
        return;
      }
      if (trimmed === "changelog") {
        const { openChangelogView } = await import("../changelog/changelog.js");
        await openChangelogView(ctx);
        return;
      }
      if (trimmed === "cleanup") {
        const { handleCleanup } = await import("./cleanup.js");
        await handleCleanup(ctx);
        return;
      }
      if (trimmed === "om-off") {
        const { config, GLOBAL_CONFIG_DIR } = await import("../pi-base/blackhole-settings.js");
        try {
          config.save(
            { ...config.load(ctx.cwd, GLOBAL_CONFIG_DIR), memory: false },
            "global",
            ctx.cwd,
            GLOBAL_CONFIG_DIR,
          );
          runtime.config = config.loadWithWarnings(ctx.cwd, GLOBAL_CONFIG_DIR).config;
          ctx.ui.notify(
            "Observational memory disabled. Use /blackhole om-on to re-enable.",
            "info",
          );
        } catch {
          ctx.ui.notify(
            "Failed to save config — the config file may be read-only (e.g., managed by Nix). " +
              "Runtime state updated for this session only.",
            "warning",
          );
        }
        return;
      }
      if (trimmed === "om-on") {
        const { config, GLOBAL_CONFIG_DIR } = await import("../pi-base/blackhole-settings.js");
        try {
          config.save(
            { ...config.load(ctx.cwd, GLOBAL_CONFIG_DIR), memory: true },
            "global",
            ctx.cwd,
            GLOBAL_CONFIG_DIR,
          );
          runtime.config = config.loadWithWarnings(ctx.cwd, GLOBAL_CONFIG_DIR).config;
          ctx.ui.notify("Observational memory enabled.", "info");
        } catch {
          ctx.ui.notify(
            "Failed to save config — the config file may be read-only (e.g., managed by Nix). " +
              "Runtime state updated for this session only.",
            "warning",
          );
        }
        return;
      } // Warn if input starts with a known subcommand but isn't an exact match.
      // Prevents "/blackhole configure foo" from silently becoming a follow-up.
      const SUBCOMMAND_NAMES = ["configure", "settings", "changelog", "cleanup", "om-off", "om-on"];
      const nearMiss = SUBCOMMAND_NAMES.find(
        (name) =>
          trimmed.toLowerCase().startsWith(name.toLowerCase()) && trimmed.length > name.length,
      );
      if (nearMiss) {
        ctx.ui.notify(
          `/blackhole ${nearMiss} accepts no arguments. Did you mean "/blackhole ${nearMiss}"?`,
          "warning",
        );
        return;
      }

      // Extract follow-up prompt: everything after the subcommand check
      // that isn't a known subcommand is treated as follow-up text.
      const followUpPrompt = trimmed ? trimmed : null;

      runtime.ensureConfig(ctx.cwd, (message) => ctx.ui.notify(message, "warning"));
      const memoryEnabled = runtime.config.memory !== false;
      const pending =
        memoryEnabled || runtime.config.compaction === "manual"
          ? readPendingState(sessionId)
          : undefined;
      // If compaction is manual (or legacy noAutoCompact): flush pending OM entries
      // into the branch before compacting so the summary includes accumulated memory.
      if (runtime.config.compaction === "manual" && pending) {
        try {
          // Write all accumulated observation batches (or latest single batch
          // as fallback for legacy pending.json without batch arrays).
          const obsBatches = pending.observationBatches?.length
            ? pending.observationBatches
            : pending.observation
              ? [pending.observation]
              : [];
          for (const batch of obsBatches) {
            runtime.appendMemoryEntry(pi, OM_OBSERVATIONS_RECORDED, batch.data);
          }
          // Write all accumulated reflection batches (or latest single batch
          // as fallback for legacy pending.json without batch arrays).
          const reflBatches = pending.reflectionBatches?.length
            ? pending.reflectionBatches
            : pending.reflection
              ? [pending.reflection]
              : [];
          for (const batch of reflBatches) {
            runtime.appendMemoryEntry(pi, OM_REFLECTIONS_RECORDED, batch.data);
          }
          // Write all accumulated dropper batches (or latest single batch
          // as fallback for legacy pending.json without batch arrays).
          const dropBatches = pending.droppedBatches?.length
            ? pending.droppedBatches
            : pending.dropped
              ? [pending.dropped]
              : [];
          for (const batch of dropBatches) {
            runtime.appendMemoryEntry(pi, OM_OBSERVATIONS_DROPPED, batch.data);
          }
          if (obsBatches.length || reflBatches.length || dropBatches.length) {
            if (clearPendingBatches(sessionId)) {
              ctx.ui.notify("Observational memory: pending entries flushed", "info");
            } else {
              ctx.ui.notify(
                "Observational memory: pending state or stale backup could not be cleared; check permissions",
                "warning",
              );
            }
          }
        } catch (error) {
          ctx.ui.notify(
            `Observational memory: pending entries not flushed; ${String(error)}`,
            "warning",
          );
        }
      }

      const branch = memoryEnabled
        ? (ctx.sessionManager.getBranch?.() as Entry[] | undefined)
        : undefined;
      const lastCompactionIdx = branch ? findLastCompactionIndex(branch) : -1;
      const keptIdx =
        branch && lastCompactionIdx >= 0
          ? entryIndexForId(branch, branch[lastCompactionIdx].firstKeptEntryId)
          : -1;
      const firstSourceIdx = keptIdx >= 0 ? keptIdx : lastCompactionIdx + 1;
      // A cursor/marker cannot prove contiguous older coverage. Capture the
      // complete retained tail; the history job survives model projection.
      const currentRange = (() => {
        if (!branch) return undefined;
        const sources = branch.slice(firstSourceIdx).filter(isSourceEntry);
        const first = sources[0];
        const last = sources.at(-1);
        return first && last ? { fromId: first.id, throughId: last.id } : undefined;
      })();
      ctx.compact({
        customInstructions: PI_VCC_COMPACT_INSTRUCTION,
        onComplete: () => {
          if (memoryEnabled) {
            try {
              const postBranch = ctx.sessionManager.getBranch?.() as Entry[] | undefined;
              const compactionIndex = postBranch ? findLastCompactionIndex(postBranch) : -1;
              if (!postBranch || compactionIndex < 0) {
                ctx.ui.notify(
                  "Observational memory: post-compaction branch anchor unavailable; catch-up not queued",
                  "warning",
                );
              } else {
                migrateLegacyObserverCatchUp(postBranch, readPendingState(sessionId), (job) =>
                  runtime.appendMemoryEntry(pi, OM_OBSERVER_CATCH_UP_JOB, job),
                );
                if (currentRange) {
                  runtime.appendMemoryEntry(pi, OM_OBSERVER_CATCH_UP_JOB, {
                    version: 1,
                    compactionId: postBranch[compactionIndex].id,
                    ...currentRange,
                  });
                }
                // Existing jobs keep their own progress; compaction does not
                // remove them. Relaunch even when there is no new tail to queue.
                void import("../om/consolidation.js")
                  .then(({ maybeLaunchConsolidation }) =>
                    maybeLaunchConsolidation(pi, runtime, ctx),
                  )
                  .catch((error: unknown) => {
                    runtime.recordConsolidationStageError?.(ctx, "observer", error);
                  });
              }
            } catch (error) {
              ctx.ui.notify(
                `Observational memory: catch-up not queued; ${String(error)}`,
                "warning",
              );
            }
          }
          const stats = runtime.compactionStats;
          if (stats) {
            ctx.ui.notify(formatCompactionStats(stats), "info");
          } else {
            ctx.ui.notify("Compacted with blackhole", "info");
          }
          notifyMigrationReminder(sessionId, (msg, level) => ctx.ui.notify(msg, level as any));

          // Fire follow-up prompt after compaction completes
          if (followUpPrompt) {
            try {
              void Promise.resolve(pi.sendUserMessage(followUpPrompt)).catch(() => {});
            } catch {
              // The follow-up is optional; compaction already succeeded.
            }
          }
        },
        onError: (err) => {
          if (err.message === "Compaction cancelled" || err.message === "Already compacted") {
            ctx.ui.notify("Nothing to compact", "warning");
          } else {
            ctx.ui.notify(`Compaction failed: ${err.message}`, "error");
          }
        },
      });
    },
  });
};
