# Windowed + chronological `/blackhole-export`

## Goal

Extend `/blackhole-export` so it is useful for both:

1. the existing occasional **whole-project distilled memory export**, and
2. repeated **incremental-ish exports**, e.g. exporting only the last 7 days every week for ingestion into another memory system.

Two independent controls:

- **time scope** — all history vs the past N days;
- **export mode** — existing ranked/distilled output vs a simple chronological memory stream.

Existing behavior remains the default. A headless CLI-flag invocation for cron/sync jobs is a
follow-up phase in this same plan (§14), built on top of the windowed timeline export.

---

## Proposed CLI

```text
/blackhole-export [out:<path>.md] [days:<N>] [mode:distilled|timeline]
```

```text
/blackhole-export                          # unchanged: whole-project distilled export
/blackhole-export days:7                   # last 7×24h through the distilled pipeline
/blackhole-export days:7 mode:timeline     # weekly-integration form: recent memory, chronological
/blackhole-export days:7 mode:timeline out:memory/weekly.md
```

- No new persistent configuration. This is an explicit export operation; command arguments suffice.
- `days:N` is a rolling duration relative to one `now` captured by the command, not calendar days.
  Day granularity is fine (this runs at most daily); no millisecond-precision claims anywhere.
- `days` accepts positive integers only. Reject `0`, negatives, floats, NaN, garbage.
- `mode` accepts exactly `distilled` (default) or `timeline`, case-sensitive. Reject anything else.
- Tokens the parser doesn't recognize are ignored (preserves current behavior for stray text).
- `since:<ISO>` / `since-last-export` / export watermarks remain possible later without redesigning
  the corpus layer (§12).

---

## 1. Separate selection from presentation

`days:N` is implemented in the corpus layer, never in `format-export.ts`:

```text
candidate session discovery
        ↓
corpus extraction + time filtering   (sinceMs/untilMs)
        ↓
ProjectCorpus (+ window counters)
        ↓
 ┌────────────────────┬────────────────────┐
 │ distilled renderer │ timeline renderer  │
 │ current behavior   │ new behavior       │
 └────────────────────┴────────────────────┘
```

A recent-window corpus stays reusable by project recall or future features with no knowledge of
markdown ranking.

---

## 2. Drop the synchronous corpus builder

`buildProjectMemoryCorpus` (sync) has zero production callers — the command uses
`buildProjectMemoryCorpusAsync` exclusively (`src/commands/blackhole-export.ts:87`). The sync
variant is a leftover from the TUI-stall era and doubles every future corpus change.

- Delete the sync `buildProjectMemoryCorpus` from `src/project-recall/corpus.ts`.
- Keep `buildProjectMemoryCorpusAsync` under its current name (no rename churn in the command).
- Migrate the ~8 call sites in `tests/blackhole-export.test.ts` to `await
  buildProjectMemoryCorpusAsync(...)`. The sync/async parity test is deleted with the sync function;
  single-path tests replace it.
- `tests/lazy-command-imports.test.ts` mocks only the async builder — unaffected.

---

## 3. Corpus time window (`src/project-recall/corpus.ts`)

```ts
export interface BuildCorpusOptions {
  cwd: string;
  gitRoot?: string | null;
  activeSessionFile?: string;
  agentDir?: string;
  /** Inclusive lower bound (ms since epoch). Omitted = all history. */
  sinceMs?: number;
  /** Inclusive upper bound. Omitted = no upper bound; the command always passes explicit now. */
  untilMs?: number;
}
```

`days` is CLI syntax; the corpus deals in timestamps. The command computes
`sinceMs = now - days*86400000`, `untilMs = now` from its single captured `now` (the same `now`
feeds recency decay in distilled mode, so ranking and windowing never skew).

### Stage A — cheap session-file prefilter (mtime)

Before the full buffered read of each candidate `.jsonl`, `statSync` it. When `sinceMs` is set and
`file mtime < sinceMs`, skip the full parse. Pi sessions are append-only, so mtime approximates the
latest write and this is where the runtime win comes from (a weekly export must not read hundreds
of historical files just to discard them).

Three rules:

1. **Header is still read for skipped files.** `knownSessionIds` drives pending →
   `pending`/`orphan`/`foreign` classification. Skipping the header too would make a skipped
   session's pending buffer misclassify as orphan/foreign. Read the ~4KB header, populate
   `knownSessionIds`, skip only the full parse.
2. **Active-session exclusion happens first**, unchanged (§12). An active-excluded file counts as
   discovered, not as window-skipped.
3. **Fix the `seenFiles` key** from basename to full path while touching this code (cwd-scope and
   git-root-scope files with the same basename currently collide).

Stat/IO failures fall back to the current behavior (parse the file) — a time filter must never
lose memory on a `statSync` error.

### Stage B — authoritative per-entry filter (timestamps)

A recently modified session can hold months of old memory (append-only/resumable), so file
selection alone is semantically wrong. After extraction, post-filter `corpus.observations` and
`corpus.reflections` on the **already-resolved** timestamp, reusing the existing parsers (no second
parser):

- observations: `parseTimestamp(o.timestamp) ?? entryTs` (the value already stored on the entry);
- branch reflections: `parseReflectionTimestamp(r.timestamp) ?? entryTs`;
- pending reflections: `parseReflectionTimestamp(r.timestamp) ?? maxObsTs` fallback (unchanged);
- keep entry iff `sinceMs == null || t >= sinceMs` **and** `untilMs == null || t <= untilMs`.

Post-filtering (rather than filtering inside the extractors) is deliberate: `droppedIds` collection
stays complete (see §4) and the diff stays small. Corpus scale makes the transient memory
negligible.

### §4. Dropper exclusion is timeless

The Dropper drops observations **in the current session**, but the corpus/export is project-wide.
Deletion state must not be time-scoped: a drop marker's entry timestamp falling outside the window
must not resurrect an in-window observation.

- `droppedIds` are collected **without time filtering** from every selected file and every
  processed pending buffer. No extra reads are needed (drops come from files already selected),
  so Stage A savings are unaffected and same-file observation/drop pairs can never split.
- Both renderers exclude `droppedIds` identically to today. No `include-dropped` option in v1.

### §5. Null/unparseable timestamps are retained, counted, and surfaced

Never silently discard memory for lack of a timestamp:

- valid timestamp → range filter applies normally;
- missing/unparseable → **retained** (iff its file/buffer was selected), counted in
  `entriesWithoutTimestamp`, rendered in the timeline's `Unknown timestamp` tail (§8);
- pending null-timestamp entries are always retained (pending is current by definition).

### §6. Window counters on `ProjectCorpus`

```ts
export interface ProjectCorpus {
  // ... unchanged fields ...
  /** All .jsonl candidates seen across scopes, before active-exclusion and window skip. */
  sessionsDiscovered: number;
  /** Candidates skipped by the Stage A mtime prefilter. */
  sessionsSkippedByWindow: number;
  /** Observations+reflections removed by the Stage B range filter. */
  entriesOutsideWindow: number;
  /** Retained entries with no usable timestamp. */
  entriesWithoutTimestamp: number;
}
```

- `sessionsConsidered` keeps its current meaning (files fully parsed) and `filesWithMarkers` is
  unchanged — default (unwindowed) output and existing assertions don't shift.
- New fields are required-with-`0`-default at construction; update the direct `ProjectCorpus`
  literals in tests accordingly (`tests/dedup-algorithms.test.ts`, lazy-imports mock).

---

## 7. Argument parser (`src/project-recall/export-options.ts`, new)

Pure, pi-free, directly unit-testable:

```ts
export interface BlackholeExportOptions {
  out?: string;
  days?: number;
  mode: "distilled" | "timeline";
}
export type ParseResult =
  | { ok: true; value: BlackholeExportOptions }
  | { ok: false; error: string };

export function parseBlackholeExportArgs(args: string): ParseResult;
```

- Tokenize on whitespace. `out:<path>` / `days:<N>` / `mode:<m>`; duplicate keys → last wins;
  unrecognized tokens ignored.
- `days` must match `/^\d+$/` and be `> 0` (`days:0`, `days:-5`, `days:1.5`, `days:wat` → error).
  Absurd-but-valid values (e.g. `days:999999`) are harmless (≈ all history); no cap.
- `mode` must be `distilled` or `timeline` exactly (`mode:foo` → error).
- The parser extracts the raw `out:` string only. The existing `.md`-extension and
  escape-current-directory checks stay in the command handler, byte-for-byte, so path behavior
  cannot regress.
- The command runs the parser **first**, before the "Exporting…" notify and before any dynamic
  `import()` — invalid args must not load the pipeline (lazy-import test contract, §10).

---

## 8. Timeline renderer (`src/project-recall/format-timeline-export.ts`, new)

Selected by the command; `format-export.ts` keeps zero `mode` branches.

```ts
export interface TimelineExportStats {
  sessionsDiscovered: number;
  sessionsScanned: number;       // = corpus.sessionsConsidered
  filesWithMarkers: number;
  observationsExported: number;
  reflectionsExported: number;
  duplicatesCollapsed: number;   // exact-dup members folded into reps
  entriesOutsideWindow: number;
  entriesWithoutTimestamp: number;
  droppedExcluded: number;
  orphanedObservations: number;
  orphanedReflections: number;
  orphanedSessions: number;
  windowLabel: string;           // "all history" | "2026-10-09T…Z → 2026-10-16T…Z"
}

export function buildTimelineExportMarkdown(
  corpus: ProjectCorpus,
  opts: { now: number; title: string; sinceMs?: number; untilMs?: number },
): { markdown: string; stats: TimelineExportStats };

export async function buildTimelineExportMarkdownAsync(...): Promise<...>  // yields like format-export.ts:1145
```

### Timeline semantics

Bypassed (deliberately): relevance scoring, recency decay, recurrence boosting, consensus rerank,
coverage boosting, viability gate, Levenshtein clustering, Sørensen-Dice merge/deletion,
reflection-wins suppression, topic discovery, TF-IDF labels, tier-first ordering. An observation
never moves earlier because the algorithm finds it important.

Retained: project attribution, pending/orphan/foreign attribution, dropper exclusion (§4),
timestamp normalization (UTC ISO for display/grouping), deterministic ordering, exact-dup
collapsing, relevance-as-metadata, reflection/observation distinction, session provenance.

### Exact duplicates only — raw identity

Per the inspected `kunkun9527/pi-blackhole` fork (cloned 2026-10-16; reference copy at
`/tmp/opencode/kunkun-pi-blackhole`): `exactContentKey(content) = content`, exact-only grouping,
similarity retained solely as a ranking signal, never as deletion proof. Lift exactly that concept
and nothing else — the fork's corpus is older than ours (no unanchored batches, no
`parseReflectionTimestamp` validation) and must not be copied.

- Group key: `kind + "\0" + content` with raw `===` on the original string. No lowercasing, no
  punctuation stripping, no whitespace normalization, no 600-char cap. Observations and
  reflections never collapse into each other.
- `User wants X enabled by default.` vs `User wants X enabled only on Linux.` always both survive.
- Byte-identical repeats collapse to one event; metadata shows `recorded N×` and multi-session
  provenance. The group renders at its earliest timestamp.

### Ordering

One logical stream of observations + reflections, ascending by absolute timestamp. Deterministic
tie-breaks (no extraction ordinal — content comparison is free and byte-stable):

1. parsed timestamp, 2. session id, 3. kind (observation before reflection), 4. content.

Entries without a usable timestamp render last under `## Unknown timestamp`, sorted by the same
tie-breaks from (2). Never render relative ages (`3d ago`) as the principal timestamp; display
absolute UTC (`2026-10-14T18:42:16Z`, derived via `new Date(t).toISOString()`), grouped under
`## YYYY-MM-DD` UTC-date headers.

### Orphans

Orphaned pending memory renders **inline chronologically** with `(orphan session <id>)`
provenance — no separate section, no ≥2-session survivor gate (that gate is a heuristic filter of
exactly the kind timeline mode drops). The `pending` vs `orphan` vs `foreign` attribution itself
is unchanged.

### Markdown shape (boring, machine-readable)

```markdown
# Project memory timeline — pi-blackhole

_Generated 2026-10-16 00:40 UTC_
_Window: 2026-10-09T22:40:00Z → 2026-10-16T22:40:00Z (or `all history`)_
_Mode: chronological · exact duplicates only_

## 2026-10-12

- `14:31:08Z` **[observation/high]** `(session abc123)` User decided ...
- `14:43:51Z` **[reflection]** `(session abc123)` The project consistently ...

## Unknown timestamp

- **[observation/medium]** `(orphan session xyz)` ...
```

Relevance stays metadata (`[observation/high]`); there are no `Reflections / Critical / High / …`
sections — tier sections would destroy temporal order. A short Notes block records dropper-pruned
counts only. No viability/topic/consensus lines (those stages didn't run).

---

## 9. Command wiring (`src/commands/blackhole-export.ts`)

1. Parse args via `parseBlackholeExportArgs` before notify/imports. On `{ ok: false }`:
   `ctx.ui.notify(error, "error")` and return — no files read, no modules loaded.
2. Capture `now` once; derive `sinceMs`/`untilMs` (`days` set) or leave unset (default).
3. Existing progress reporting, `findGitRoot`, active-session exclusion: unchanged.
4. `buildProjectMemoryCorpusAsync({ cwd, gitRoot, activeSessionFile, agentDir, sinceMs, untilMs })`.
5. Empty-corpus notify must reflect the window: `No observational memory found …` vs `No
   observational memory in the last N days …` when `days` is set (a windowed empty result is
   normal, not alarming).
6. Renderer selection: `distilled` → `buildExportMarkdownAsync` + current summary;
   `timeline` → `buildTimelineExportMarkdownAsync` + timeline summary
   (`Window: …`, `Sessions: <discovered> → <scanned> (<with-memory> with memory)`,
   `Observations: N exported`, `Reflections: M exported`, plus outside-window/unknown-timestamp
   and dropper counts). Both formatter imports stay lazy behind the empty check.
7. Update the command `description` usage string with the new args.

---

## 10. Lazy-load contract (must not regress)

`tests/lazy-command-imports.test.ts:111` pins: invalid args import nothing; empty corpus imports
only `session-dir` + `corpus`, never a formatter. The new parser import is static-safe
(pure module) or lazily imported — either way it must add zero entries to the tracked `imports`
before validation, and the timeline formatter must follow the same deferred-`import()` pattern as
the distilled one.

---

## 11. Pending buffers

Per-entry time filtering with the same range; observation timestamps directly; reflections keep the
`maxObsTs` fallback; null → retain + flag unknown (§5). The `pending`/`orphan`/`foreign`
distinction and the global session-id disambiguation scan are unchanged (that scan reads headers
only and is unaffected by the window). No mtime prefilter for the pending dir in v1 — it is small
and per-entry filtering suffices. Do not let the window weaken attribution: attribution is
computed from unfiltered `knownSessionIds` (§3, rule 1).

---

## 12. Active-session caveat (document, don't solve)

The actively-written session file stays excluded (race safety). Consequence, to document in README
and the timeline header notes:

```text
days:7 is a rolling snapshot, not an exactly-once incremental replication protocol. A
long-running active session can hold events that were excluded while active and have aged out of
the window by the time the session becomes eligible.
```

Proper later fixes (snapshot active memory safely / export watermark-cursor / `since-last-export`)
are follow-ups. No overlap fudge constants.

---

## 13. What was lifted from the kunkun9527 fork (inspected, not copied)

- Source: `https://github.com/kunkun9527/pi-blackhole` (Chinese-language; reviewed via machine
  translation with ChatGPT assistance).
- Lifted concept: exact-content identity as the only deletion criterion; similarity as ranking
  signal only. Applies to timeline mode in v1; whether distilled export should adopt it is a
  separate future decision (distilled's fuzzy merging is load-bearing for its current snapshots —
  do not change it here).
- Explicitly **not** lifted: the fork's corpus (predates unanchored observations/batches and
  reflection-timestamp validation) and its full `dedup.ts`.
- If the fork later gains windowed-export behavior of its own, re-compare before converging.

---

## 14. Follow-up phase: headless `--blackhole-export` flag for cron/sync jobs (after v1)

Goal: `pi --blackhole-export "days:7 mode:timeline out:memory/weekly.md"` usable from cron/systemd
timers, reusing the exact slash-command argument grammar.

### Host mechanism (verified against pi 0.87.0 + SDK types)

- `pi.registerFlag(name, { description, type: "string" })` (`types.d.ts:1213`) exposes
  `--<name>` on the pi CLI; `pi.getFlag(name)` (`types.d.ts:1224`) reads it back.
- `pi.on("session_start", handler)` fires at startup; the handler context carries `cwd` and
  `shutdown()` ("gracefully shutdown pi and exit", available in all contexts).
- Headless flow: on `session_start`, if `getFlag("blackhole-export")` is a non-empty string, run
  the export through the **same routine the slash command uses** (extract the handler core in §9
  into an importable `runBlackholeExport(argsString, ctx)` shared by both paths), then
  `ctx.shutdown()`.

### Design points

- Flag value is the verbatim argument string (`days:7 mode:timeline out:…`), parsed by
  `parseBlackholeExportArgs` — one grammar, two entry points.
- Cron recipe runs from the project root (git-root scoping covers sessions launched from
  subdirectories): `pi --blackhole-export "days:7 mode:timeline out:memory/weekly.md" -p`
  (exact `-p`/non-interactive interplay to verify).
- File output is the artifact; the console/summary line is the cron-observable result. Exit
  non-zero (and write nothing) on parse errors so failed syncs are visible to the scheduler.

### Must verify empirically before shipping this phase

1. `session_start` fires in non-interactive runs and the flag value (with spaces/quoting) arrives
   intact via `getFlag`.
2. `ctx.ui.notify` / `pi.sendMessage` behavior headless (no TUI to paint; must not throw or hang).
3. `shutdown()` timing — safe to call immediately after the write, no truncated flush.
4. Exit codes: success 0, parse/IO failure non-zero.
5. Session-file side effects per cron run — prefer `--no-session` if the export path tolerates it
   (`getSessionFile()` is already optional in the handler); otherwise document the session litter
   and its (lack of) impact on future exports.
6. Overlap with the §12 caveat: cron does not make `days:N` exactly-once; document the same
   snapshot semantics for scheduled runs.

---

## 15. Files involved

Primary:

```text
src/commands/blackhole-export.ts        # parser-first flow, window derivation, renderer selection, per-mode summary
src/project-recall/corpus.ts            # sinceMs/untilMs, Stage A+B, timeless drops, window counters, delete sync builder
src/project-recall/format-export.ts     # untouched (distilled)
src/project-recall/export-options.ts    # NEW: parseBlackholeExportArgs
src/project-recall/format-timeline-export.ts  # NEW: chronological renderer + TimelineExportStats
index.ts                                # v1: unchanged export registration comment; §14: registerFlag + session_start hook
tests/blackhole-export.test.ts          # async migration + window/timeline suites
tests/export-options.test.ts            # NEW: parser unit tests
tests/format-timeline-export.test.ts    # NEW: renderer unit tests (or folded into blackhole-export.test.ts)
```

Docs: `README.md` (command row + windowed/timeline usage + active-session snapshot note),
`CHANGELOG.md` (`[Unreleased]` entry, keepachangelog style).

No changes to observer/reflector/dropper agents.

---

## 16. Tests

Pin behavior, not implementation (AGENTS.md T1–T8 apply: red-first while writing, explicit
preconditions, one behavior per case, `finally`/after-hook cleanup, no `any`-escapes, mocks shaped
like real output).

- **Backward compat**: bare `/blackhole-export` output unchanged; existing distilled assertions
  stay valid (migrate to async calls without touching expectations).
- **Parser**: `days:0`, `days:-5`, `days:1.5`, `days:wat`, `mode:foo` rejected; valid triples
  accepted; unknown tokens ignored; duplicates last-win. Pure unit tests, no fixtures.
- **Stage A**: old-mtime vs recent-mtime sessions with `days:7` — control mtime explicitly via
  `utimesSync` (fixtures are all born "now") and assert the old file's full read never happens
  (spy on `readFileSync` or equivalent), not just its absence from output.
- **Stage B (resumed session, the key test)**: one recent-mtime file holding a 30-day-old and a
  2-day-old observation — only the latter enters a 7-day export.
- **Timeless drops**: dropped observation stays absent in both modes even when the drop marker's
  entry timestamp is outside the window.
- **Pending**: recent vs old pending observations obey the cutoff; null-timestamp pending retained
  and flagged; orphan inline placement.
- **Timeline ordering**: multi-session obs/reflections strictly by timestamp; a low at 10:00
  precedes a critical at 11:00; tie-breaks byte-stable across repeated runs (render twice,
  compare bytes).
- **No viability gate**: single-session low-relevance observation removed by distilled mode
  survives timeline mode.
- **No fuzzy deletion**: two highly similar but non-identical facts both survive timeline mode
  (use the existing `FUZZY_A`/`FUZZY_B` pair shape).
- **Exact collapse**: byte-identical repeats collapse with `recorded N×`; near-identical
  (case/punctuation-only differences) do **not** collapse under raw equality.
- **Unknown timestamps**: retained, counted, rendered in the tail section — never silently lost.
- **Active session**: exclusion contract preserved, windowed or not.
- **Empty window**: `days:7` over memory-less range notifies the windowed message and writes nothing.
- **Lazy imports**: extend `tests/lazy-command-imports.test.ts` so the timeline formatter also
  stays unloaded on the empty path.

---

## 17. Suggested implementation order (loose)

1. Parser (`export-options.ts`) + unit tests.
2. Corpus options + Stage A/B + timeless drops + counters (async only); delete sync builder, migrate tests.
3. Window tests (mtime control, resumed session, pending, drops, unknown-ts).
4. Timeline renderer + exact dedup + stats; renderer tests.
5. Command wiring (selection, summaries, description); full existing suite green on default output.
6. README/CHANGELOG.
7. §14 headless flag (separate change after v1 lands).

Keep the ranking pipeline untouched until the new path works end to end.

---

## Acceptance criteria

V1 is complete when:

```text
/blackhole-export
```

behaves exactly like the current project-wide distilled export;

```text
/blackhole-export days:7
```

skips mtime-old session files without full reads and never leaks old entries from recently
resumed sessions; and

```text
/blackhole-export days:7 mode:timeline
```

produces a deterministic timestamp-ordered export of recent observations/reflections with no
relevance reranking, viability filtering, topic grouping, or fuzzy deletion. Distinct facts never
disappear for looking similar; dropped ids stay excluded; timestamp-less entries are retained and
reported.

The §14 headless phase is complete when the cron-form invocation reuses the same grammar,
writes the file, exits cleanly with scheduler-visible failures, and the six verification items in
§14 are evidenced (not assumed).
