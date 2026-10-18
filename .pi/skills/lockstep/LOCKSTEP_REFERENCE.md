# Lockstep Reference

Full file topology mapping between upstream repos and pi-blackhole.

## Fork point (what version we file-copied)

| Upstream | Fork commit | Version | Evidence |
|---|---|---|---|
| pi-vcc | `1994b2611e9` | v0.3.15 | Our normalize.ts matches VCC at this commit (the next commit `a156870` removed `thinking` blocks and `isError` which we still have) |
| pi-observational-memory | `a41048bd7e9` | last audited: June 5, 2026 — ported `pct()` fix (remove Math.min(100,...) cap). Pipeline refactors (budgetTokens, pool.ts) still deferred. |

The VCC marker is at the fork point so `lockstep.js` shows un-reviewed commits. The OM marker is at HEAD because there's nothing to port.

## Topography

```
pi-vcc (sting8k/pi-vcc)          pi-observational-memory (elpapi42/pi-obs-mem)
├── index.ts                  ├── src/index.ts
├── src/core/                 ├── src/config.ts
│   ├── brief.ts              ├── src/runtime.ts
│   ├── build-sections.ts     ├── src/hooks/
│   ├── content.ts            │   ├── consolidation-trigger.ts
│   ├── filter-noise.ts       │   ├── compaction-trigger.ts
│   ├── format.ts             │   └── compaction-hook.ts
│   ├── format-recall.ts      ├── src/agents/
│   ├── lineage.ts            │   ├── observer/ (agent.ts, prompts.ts)
│   ├── load-messages.ts      │   ├── reflector/ (agent.ts, prompts.ts)
│   ├── normalize.ts          │   └── dropper/ (agent.ts, prompts.ts)
│   ├── recall-scope.ts       ├── src/session-ledger/
│   ├── render-entries.ts     │   ├── types.ts
│   ├── report.ts ← DELETED   │   ├── fold.ts
│   ├── sanitize.ts           │   ├── progress.ts
│   ├── search-entries.ts     │   ├── projection.ts
│   ├── settings.ts ← DELETED │   ├── recall.ts
│   ├── skill-collapse.ts     │   ├── render-summary.ts
│   ├── summarize.ts          │   └── index.ts
│   └── tool-args.ts          ├── src/commands/
├── src/extract/              │   ├── status.ts ← ELIMINATED
│   ├── commits.ts            │   └── view.ts ← ELIMINATED
│   ├── files.ts              ├── src/tools/
│   ├── goals.ts              │   └── recall-observation.ts ← MERGED
│   └── preferences.ts        ├── src/clipboard.ts
├── src/commands/             ├── src/debug-log.ts
│   ├── pi-vcc.ts             ├── src/ids.ts
│   └── vcc-recall.ts         ├── src/model-budget.ts
├── src/tools/recall.ts       ├── src/serialize.ts
├── src/types.ts              └── src/tokens.ts
├── src/sections.ts
└── src/details.ts



        ▼  ▼  ▼  FRANKENMERGE  ▼  ▼  ▼

pi-blackhole
├── index.ts                          ← MERGED (both entries combined)
├── src/core/                         ← DERIVED FROM VCC (mostly unmodified)
│   ├── brief.ts                      ← UNCHANGED
│   ├── build-sections.ts             ← UNCHANGED
│   ├── content.ts                    ← UNCHANGED
│   ├── filter-noise.ts               ← UNCHANGED
│   ├── format.ts                     ← UNCHANGED
│   ├── format-recall.ts              ← UNCHANGED
│   ├── lineage.ts                    ← UNCHANGED
│   ├── load-messages.ts              ← MODIFIED (silent JSON parse failure logging)
│   ├── normalize.ts                  ← UNCHANGED
│   ├── recall-scope.ts               ← UNCHANGED
│   ├── render-entries.ts             ← UNCHANGED
│   ├── sanitize.ts                   ← UNCHANGED
│   ├── search-entries.ts             ← MODIFIED (unified recall format)
│   ├── skill-collapse.ts             ← UNCHANGED
│   ├── summarize.ts                  ← UNCHANGED
│   ├── tool-args.ts                  ← UNCHANGED
│   └── unified-config.ts             ★ UNIQUE (replaces settings.ts)
├── src/extract/                      ← DERIVED FROM VCC (unmodified)
│   ├── commits.ts
│   ├── files.ts
│   ├── goals.ts
│   └── preferences.ts
├── src/hooks/
│   └── before-compact.ts             ← MODIFIED (VCC hook + OM injection)
├── src/commands/
│   ├── pi-vcc.ts                     ← MODIFIED (omRuntime for noAutoCompact flush)
│   ├── vcc-recall.ts                 ← UNCHANGED
│   └── memory.ts                     ★ UNIQUE (/blackhole-memory command)
├── src/tools/
│   └── recall.ts                     ← MODIFIED (unified: VCC recall + OM recall)
├── src/om/                           ← DERIVED FROM OM (renamed + modified)
│   ├── config.ts                     ← REWRITTEN (re-exports unified-config)
│   ├── runtime.ts                    ← MODIFIED (stage-local failures, fallbacks, retry gate)
│   ├── consolidation.ts              ← REWRITTEN (stage-local skips, fallback chains, pending, preambles)
│   ├── compaction-trigger.ts         ← MODIFIED (noAutoCompact, queueMicrotask, sessionId)
│   ├── usage-log.ts                  ★ UNIQUE
│   ├── pending.ts                    ★ UNIQUE
│   ├── reverse-recall.ts             ★ UNIQUE
│   ├── clipboard.ts                  ← UNCHANGED
│   ├── debug-log.ts                  ← UNCHANGED
│   ├── ids.ts                        ← MOVED from src/ids.ts
│   ├── model-budget.ts               ← MOVED from src/model-budget.ts
│   ├── serialize.ts                  ← MODIFIED (truncateRecordContent)
│   ├── tokens.ts                     ← MOVED from src/tokens.ts
│   ├── agents/
│   │   ├── observer/
│   │   │   ├── agent.ts              ← MODIFIED (error detection, empty diagnosis)
│   │   │   └── prompts.ts            ← UNCHANGED
│   │   ├── reflector/
│   │   │   ├── agent.ts              ← MODIFIED (staged context inputs)
│   │   │   └── prompts.ts            ← UNCHANGED
│   │   └── dropper/
│   │       ├── agent.ts              ← MODIFIED (staged context inputs)
│   │       └── prompts.ts            ← UNCHANGED
│   └── ledger/                       ← MOVED from session-ledger/
│       ├── types.ts                  ← MOVED
│       ├── fold.ts                   ← MOVED
│       ├── progress.ts               ← MODIFIED (added helpers)
│       ├── projection.ts             ← MODIFIED (preamble capping, visibleProjection)
│       ├── recall.ts                 ← MODIFIED (cross-reference annotations)
│       ├── render-summary.ts         ← MODIFIED (staged context builders)
│       └── index.ts                  ← MOVED
├── src/types.ts                      ← UNCHANGED (from VCC)
├── src/sections.ts                   ← UNCHANGED (from VCC)
├── src/details.ts                    ← MODIFIED (compactor field renamed)
└── package.json                      ← MODIFIED (name, version, deps)
```

## Divergence Notes

### Why certain files can't be blindly merged

| File | Upstream | Divergence | Risk |
|---|---|---|---|
| `src/hooks/before-compact.ts` | VCC | After VCC compile(), we call `buildCompactionProjection` + `renderSummary` to inject OM observations/reflections. Upstream has none of this. | HIGH — OM injection code would be lost |
| `src/om/consolidation.ts` | OM | Each stage (observer→reflector→dropper) has a fallback loop with stage-local in-memory failure skips (never persisted), noAutoCompact pending.json support, preamble capping, empty diagnosis. | HIGH — upstream is simpler, no fallback logic |
| `src/om/runtime.ts` | OM | Has `buildCandidateList`, `recordStageFailure` / `failedInCycle` (stage-local only, never persisted), `markConsolidationError`, `isConsolidationRetryGated`, `compactionStats`, `compactWasPiVcc`. | HIGH — fundamental architecture difference |
| `src/om/config.ts` | OM | Completely rewritten to re-export `UnifiedConfig` from `unified-config.ts`, which merges VCC settings + OM settings. | HIGH — different config structure |
| `src/om/compaction-trigger.ts` | OM | `queueMicrotask` instead of `setTimeout`, session ID identity validation, `noAutoCompact` gate, `memory=false` gate. | MEDIUM — core logic same, safety guards added |
| `src/om/agents/observer/agent.ts` | OM | Detects `stopReason="error"` on agent_end and throws to trigger fallback. Diagnoses empty results. | LOW — additive changes on top of same core |
| `src/om/agents/reflector/agent.ts` | OM | Added `existingReflectionsSummary` / `existingObservationsSummary` inputs. | LOW — extends input interface |
| `src/om/agents/dropper/agent.ts` | OM | Added `existingObservationsSummary` input. | LOW — extends input interface |
| `src/om/ledger/projection.ts` | OM | Added `selectPriorObservations`, `visibleProjection`. | LOW — additive |
| `src/om/ledger/progress.ts` | OM | Added `rawTokensAfterIndex`, `entryIndexForId`, `findLastCompactionIndex`, `observationsCreatedAfterIndex`, `reflectionsCreatedAfterIndex`. | LOW — additive |
| `src/om/ledger/render-summary.ts` | OM | Added `buildExistingObservationsSummary`, `buildExistingReflectionsSummary`. | LOW — additive |
| `src/core/load-messages.ts` | VCC | Added try/catch logging on JSON parse failures. | LOW — additive |
| `src/core/search-entries.ts` | VCC | Minor format changes for unified recall. | LOW |
| `src/commands/pi-vcc.ts` | VCC | Added `omRuntime` parameter and noAutoCompact flush on `/blackhole`. | MEDIUM |
| `src/tools/recall.ts` | VCC | Merged OM recall-observation tool into the same file. | MEDIUM |
| `src/details.ts` | VCC | `compactor: "blackhole"` instead of `"pi-vcc"`. | TRIVIAL |

### Files we eliminated (upstream still has them)

| Upstream file | Why we removed it |
|---|---|
| `src/core/settings.ts` (VCC) | Replaced by `src/core/unified-config.ts` which combines VCC + OM settings in one file |
| `src/core/report.ts` (VCC) | Dead code — was an unreachable report generation path |
| `src/hooks/compaction-hook.ts` (OM) | Merged into `src/hooks/before-compact.ts` — OM compaction hook now runs inside the unified before-compact handler |
| `src/commands/status.ts` (OM) | Replaced by `src/commands/memory.ts` with richer display (pipeline status, pending counts, coverage details) |
| `src/commands/view.ts` (OM) | Folded into `src/commands/memory.ts` view/full subcommands |
| `src/tools/recall-observation.ts` (OM) | Merged into `src/tools/recall.ts` which handles both `#N` transcript expansion and `[12char]` hex ID observation recall |

### Files we added (unique to blackhole)

| File | Purpose |
|---|---|
| `src/core/unified-config.ts` | Single config schema that holds both VCC settings (overrideDefaultCompaction, debug) and OM settings (observeAfterTokens, etc.) plus blackhole-specific settings (noAutoCompact, memory, passive, fallback chains, usageLog) |
| `src/commands/memory.ts` | `/blackhole-memory [status|view|full]` — pipeline status display with token metrics, pending queue inspection |
| `src/om/usage-log.ts` | Best-effort pi-format worker usage logs in `{sessionDir}/memory-logs/`, outside shallow session discovery |
| `src/om/pending.ts` | Pending observation/reflection/dropper buffer for `noAutoCompact` mode — stores observations to disk instead of writing branch markers |
| `src/om/reverse-recall.ts` | Bi-directional recall coupling: hex ID → transcript entry, `#N` index → OM observation/reflection |
