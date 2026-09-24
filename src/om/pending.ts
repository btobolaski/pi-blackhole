/**
 * Pending OM state persistence.
 *
 * When `compaction: "manual"` is enabled (or legacy `noAutoCompact`), observations, reflections, and dropper
 * results are saved to disk instead of being appended to the conversation.
 * Each new pipeline run replaces the previous result (latest subsumes earlier
 * since every run processes all entries since the last actual branch append).
 *
 * On manual `/blackhole` trigger, pending batches are flushed to the branch.
 * Historical catch-up ranges are read only during the one-release migration to
 * branch-local session-history jobs; new catch-up state never writes here.
 *
 * Per-session files: each session gets its own <sessionId>-pending.json
 * under ~/.pi/agent/pi-blackhole/. This eliminates race conditions from
 * concurrent pi sessions writing to a shared file.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { entryIndexById, isSourceEntry } from "./ledger/progress.js";
import {
  OM_OBSERVER_CATCH_UP_JOB,
  isObserverCatchUpJobData,
  type Entry,
  type ObserverCatchUpJobData,
} from "./ledger/types.js";
// ── Types ───────────────────────────────────────────────────────────────────

export interface PendingObservation {
  coversUpToId: string;
  data: unknown;
}

export interface PendingReflection {
  coversUpToId: string;
  data: unknown;
}

export interface PendingDropped {
  coversUpToId: string;
  data: unknown;
}

/** Historical sidecar shape accepted for a safe, read-only cutover. */
export interface LegacyObserverCatchUpRange {
  branchId?: string;
  fromId?: string;
  throughId: string;
  /** UTF-16 offset into the serialized source at fromId. */
  offset?: number;
}

export interface PendingOMState {
  /** Latest observation run (replaced each time, not accumulated). */
  observation?: PendingObservation;
  /** Latest reflection run (replaced each time, not accumulated). */
  reflection?: PendingReflection;
  /** Latest dropper run (replaced each time, not accumulated). */
  dropped?: PendingDropped;
  /**
   * All observation batches accumulated across manual mode pipeline runs.
   * Each batch preserves per-run coverage (coversUpToId) matching the normal
   * branch-marker pattern. Used for LLM context and /blackhole flush.
   */
  observationBatches?: PendingObservation[];
  /**
   * All reflection batches accumulated across manual mode pipeline runs.
   * Preserves per-run coverage for LLM context and /blackhole flush.
   */
  reflectionBatches?: PendingReflection[];
  /**
   * All dropper batches accumulated across manual mode pipeline runs.
   * Each batch preserves which observations were dropped in that run.
   * Without accumulation, earlier drops are lost when the next dropper
   * run overwrites pending.dropped, causing them to be "un-dropped" on
   * /blackhole flush.
   */
  droppedBatches?: PendingDropped[];
  /** Legacy-only ranges from releases before branch-local history jobs. */
  observerCatchUpRanges?: LegacyObserverCatchUpRange[];
  /** Pipeline progress cursors — persist across restarts and fork recovery. */
  cursors?: {
    observer?: { entryId: string; state: string };
    reflector?: { entryId: string; state: string };
    dropper?: { entryId: string; state: string };
  };
}

// ── Persistence ─────────────────────────────────────────────────────────────

const PENDING_DIR = "pi-blackhole";
const PENDING_SUFFIX = "-pending.json";
const STALE_SUFFIX = "-pending.stale.json";

/** Build the path for a given session's pending file. */
function pendingPath(sessionId: string): string {
  return join(getAgentDir(), PENDING_DIR, `${sessionId}${PENDING_SUFFIX}`);
}

/** Build the path for a given session's stale pending file (backup of previous write). */
function stalePath(sessionId: string): string {
  return join(getAgentDir(), PENDING_DIR, `${sessionId}${STALE_SUFFIX}`);
}

/** Ensure the pending directory exists. */
function ensureDir(): void {
  const dir = join(getAgentDir(), PENDING_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function defaultState(): PendingOMState {
  return {};
}

function isEmptyState(s: PendingOMState): boolean {
  const hasCursors = s.cursors && (s.cursors.observer || s.cursors.reflector || s.cursors.dropper);
  if (hasCursors || s.observerCatchUpRanges?.length) return false;
  return (
    !s.observation &&
    !s.reflection &&
    !s.dropped &&
    (!s.observationBatches || s.observationBatches.length === 0) &&
    (!s.reflectionBatches || s.reflectionBatches.length === 0) &&
    (!s.droppedBatches || s.droppedBatches.length === 0)
  );
}

// ── Per-session file read/write ─────────────────────────────────────────────

/**
 * Read pending state for a specific session from its dedicated file.
 * Returns default (empty) state if file doesn't exist or is corrupt.
 */
function readSessionState(sessionId: string): PendingOMState {
  const path = pendingPath(sessionId);
  if (!existsSync(path)) return defaultState();

  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (isPendingOMState(raw)) return sanitizePendingState(raw);
    return defaultState();
  } catch {
    return defaultState();
  }
}

/**
 * Write pending state for a specific session to its dedicated file.
 * Empty state removes the main file and stale backup best-effort. Nonempty writes
 * replace atomically and propagate failures: history progress must never outpace
 * saved batches. Only discardStale removes an older backup. Writes without legacy
 * ranges retain the previous state as a best-effort <sessionId>-pending.stale.json backup.
 */
function writeSessionState(sessionId: string, state: PendingOMState, discardStale = false): void {
  const path = pendingPath(sessionId);
  if (isEmptyState(state)) {
    // Clear: remove both main and stale
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
      /* best-effort */
    }
    try {
      const stale = stalePath(sessionId);
      if (existsSync(stale)) unlinkSync(stale);
    } catch {
      /* best-effort */
    }
    return;
  }

  ensureDir();
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
    if (!discardStale && !state.observerCatchUpRanges?.length) {
      try {
        // Copy, never move: a failed replacement must leave the readable state intact.
        if (existsSync(path)) copyFileSync(path, stalePath(sessionId));
      } catch {
        /* best-effort — stale backup is optional */
      }
    }
    renameSync(temp, path);
    if (discardStale && existsSync(stalePath(sessionId))) unlinkSync(stalePath(sessionId));
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

/** Validate that unknown value is shape-compatible with PendingOMState. */
function isPendingOMState(value: unknown): value is PendingOMState {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const hasObs = !!(
    v.observation &&
    typeof v.observation === "object" &&
    typeof (v.observation as any).coversUpToId === "string"
  );
  const hasRef = !!(
    v.reflection &&
    typeof v.reflection === "object" &&
    typeof (v.reflection as any).coversUpToId === "string"
  );
  const hasDrop = !!(
    v.dropped &&
    typeof v.dropped === "object" &&
    typeof (v.dropped as any).coversUpToId === "string"
  );
  // Also accept states with only batch arrays (no singular fields)
  const hasBatches =
    Array.isArray(v.observationBatches) ||
    Array.isArray(v.reflectionBatches) ||
    Array.isArray(v.droppedBatches);
  // Accept cursor-only states (no observations/reflections yet, but persisted)
  const hasCursors = !!(v.cursors && typeof v.cursors === "object");
  return (
    hasObs ||
    hasRef ||
    hasDrop ||
    hasBatches ||
    hasCursors ||
    typeof v.observerCatchUpThroughId === "string" ||
    Array.isArray(v.observerCatchUpRanges)
  );
}

/**
 * Sanitize pending state: filter out corrupted batch entries (missing required fields).
 * Returns a clean copy; does not mutate the input.
 */
function sanitizePendingState(raw: PendingOMState): PendingOMState {
  const legacy: Record<string, unknown> = { ...raw };
  const candidates: unknown[] = Array.isArray(raw.observerCatchUpRanges)
    ? raw.observerCatchUpRanges
    : typeof legacy.observerCatchUpThroughId === "string" && legacy.observerCatchUpThroughId
      ? [{ throughId: legacy.observerCatchUpThroughId, fromId: legacy.observerCatchUpFromId }]
      : [];
  const ranges: LegacyObserverCatchUpRange[] = candidates.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const range = candidate as Record<string, unknown>;
    if (typeof range.throughId !== "string" || !range.throughId) return [];
    if (range.branchId !== undefined && (typeof range.branchId !== "string" || !range.branchId))
      return [];
    return [
      {
        throughId: range.throughId,
        branchId: typeof range.branchId === "string" && range.branchId ? range.branchId : undefined,
        fromId: typeof range.fromId === "string" && range.fromId ? range.fromId : undefined,
        offset:
          typeof range.offset === "number" &&
          Number.isSafeInteger(range.offset) &&
          range.offset >= 0
            ? range.offset
            : undefined,
      },
    ];
  });
  // Preserve the old fields only long enough to normalize them into the
  // read-only range shape. We never clear these ranges during migration: a
  // sibling path may not contain the replacement history job.
  for (const key of [
    "observerCatchUpFromId",
    "observerCatchUpThroughId",
    "observerCatchUpBranchId",
    "observerCatchUpOffset",
    "observerCatchUpOthers",
    "observerCatchUpCoveredBranches",
  ])
    delete legacy[key];
  const sanitized: PendingOMState = {
    ...legacy,
    observation: raw.observation ?? undefined,
    reflection: raw.reflection ?? undefined,
    dropped: raw.dropped ?? undefined,
    observerCatchUpRanges: ranges.length ? ranges : undefined,
  };
  // Filter batch arrays to only include valid entries with the required shape
  if (Array.isArray(raw.observationBatches)) {
    sanitized.observationBatches = raw.observationBatches.filter(
      (b): b is PendingObservation =>
        !!b &&
        typeof b === "object" &&
        typeof (b as any).coversUpToId === "string" &&
        (b as any).data !== undefined,
    );
  }
  if (Array.isArray(raw.reflectionBatches)) {
    sanitized.reflectionBatches = raw.reflectionBatches.filter(
      (b): b is PendingReflection =>
        !!b &&
        typeof b === "object" &&
        typeof (b as any).coversUpToId === "string" &&
        (b as any).data !== undefined,
    );
  }
  if (Array.isArray(raw.droppedBatches)) {
    sanitized.droppedBatches = raw.droppedBatches.filter(
      (b): b is PendingDropped =>
        !!b &&
        typeof b === "object" &&
        typeof (b as any).coversUpToId === "string" &&
        (b as any).data !== undefined,
    );
  }
  return sanitized;
}

// ── API ─────────────────────────────────────────────────────────────────────

/**
 * Save (replace) the latest observation result for a session.
 * Each new run covers all entries since last branch append, so the latest
 * result fully subsumes any previous one.
 */
export function savePendingObservation(sessionId: string, entry: PendingObservation): void {
  const state = readSessionState(sessionId);
  state.observation = entry;
  // Append to accumulated batches for LLM context and /blackhole flush.
  // Each batch preserves per-run coverage (coversUpToId) matching the
  // normal branch-marker pattern.
  state.observationBatches = [...(state.observationBatches ?? []), entry];
  writeSessionState(sessionId, state);
}

/**
 * Save (replace) the latest reflection result for a session.
 */
export function savePendingReflection(sessionId: string, entry: PendingReflection): void {
  const state = readSessionState(sessionId);
  state.reflection = entry;
  // Append to accumulated batches for LLM context and /blackhole flush.
  state.reflectionBatches = [...(state.reflectionBatches ?? []), entry];
  writeSessionState(sessionId, state);
}

/**
 * Save (replace) the latest dropper result for a session and
 * append to droppedBatches so no drops are lost across cycles
 * before /blackhole flush.
 */
export function savePendingDropped(sessionId: string, entry: PendingDropped): void {
  const state = readSessionState(sessionId);
  state.dropped = entry;
  state.droppedBatches = [...(state.droppedBatches ?? []), entry];
  writeSessionState(sessionId, state);
}

/**
 * Check whether a coversUpToId matches the already-pending observation
 * for the given session. Returns true if the chunk was already processed.
 */
export function isObservationChunkPending(sessionId: string, coversUpToId: string): boolean {
  const s = readSessionState(sessionId);
  return s.observation?.coversUpToId === coversUpToId;
}

/**
 * Check whether a coversUpToId matches the already-pending reflection
 * for the given session.
 */
export function isReflectionChunkPending(sessionId: string, coversUpToId: string): boolean {
  const s = readSessionState(sessionId);
  return s.reflection?.coversUpToId === coversUpToId;
}

/**
 * Import legacy sidecar ranges for the active path. A range is never mutated
 * or completed here: history jobs take ownership on the path that migrates it,
 * while siblings keep their recoverable legacy record for this release.
 */
export function migrateLegacyObserverCatchUp(
  entries: Entry[],
  state: PendingOMState,
  append: (job: ObserverCatchUpJobData) => void,
): void {
  if (!state.observerCatchUpRanges?.length) return;
  const indices = entryIndexById(entries);
  const migrated = new Set(
    entries.flatMap((entry) =>
      entry.type === "custom" &&
      entry.customType === OM_OBSERVER_CATCH_UP_JOB &&
      isObserverCatchUpJobData(entry.data)
        ? [entry.data.compactionId]
        : [],
    ),
  );
  for (const range of state.observerCatchUpRanges) {
    if (range.branchId && !indices.has(range.branchId)) continue;
    const compactionId = `legacy:${range.branchId ?? "unscoped"}:${range.throughId}`;
    if (migrated.has(compactionId)) continue;
    // An old flat queue had no start: it meant all source entries through its
    // endpoint, not just the endpoint. Missing explicit sources stay unresolved.
    const fromId =
      range.fromId ??
      entries.slice(0, (indices.get(range.throughId) ?? -1) + 1).find(isSourceEntry)?.id ??
      range.throughId;
    append({ version: 1, compactionId, fromId, throughId: range.throughId, offset: range.offset });
    migrated.add(compactionId);
  }
}

/** Read the pending OM state for a specific session. */
export function readPendingState(sessionId: string): PendingOMState {
  return readSessionState(sessionId);
}

/** Clear flushed manual-mode batches without discarding durable cursors or catch-up. */
export function clearPendingBatches(sessionId: string): boolean {
  const state = readSessionState(sessionId);
  delete state.observation;
  delete state.reflection;
  delete state.dropped;
  delete state.observationBatches;
  delete state.reflectionBatches;
  delete state.droppedBatches;
  try {
    writeSessionState(sessionId, state, true);
    return (
      !existsSync(stalePath(sessionId)) &&
      (!isEmptyState(state) || !existsSync(pendingPath(sessionId)))
    );
  } catch {
    // Keep compaction nonfatal; the caller warns that pending data may remain.
    return false;
  }
}

/** Clear the pending OM state for a specific session after flushing to branch. */
export function clearPendingState(sessionId: string): void {
  writeSessionState(sessionId, defaultState());
}

/** Check whether there is any pending OM state for a specific session. */
export function hasPendingData(sessionId: string): boolean {
  return !isEmptyState(readSessionState(sessionId));
}

/** Read cursors from pending state for a session. */
export function readPendingCursors(sessionId: string): PendingOMState["cursors"] {
  const state = readSessionState(sessionId);
  return state.cursors;
}

/** Write cursors to pending state for a session (replaces existing cursors).
 *  Uses assignment (not merge) so deletions from validateCursors persist. */
export function writePendingCursors(sessionId: string, cursors: PendingOMState["cursors"]): void {
  const state = readSessionState(sessionId);
  state.cursors = { ...cursors };
  writeSessionState(sessionId, state);
}

/**
 * List all session IDs that have pending data by scanning the pending directory
 * for *-pending.json files.
 */
export function listPendingSessions(): string[] {
  const dir = join(getAgentDir(), PENDING_DIR);
  if (!existsSync(dir)) return [];

  try {
    const files = readdirSync(dir);
    const sessions: string[] = [];
    for (const file of files) {
      if (!file.endsWith(PENDING_SUFFIX)) continue;
      const sessionId = file.slice(0, -PENDING_SUFFIX.length);
      if (!sessionId) continue;
      // Verify the file actually has non-empty data
      const state = readSessionState(sessionId);
      if (!isEmptyState(state)) sessions.push(sessionId);
    }
    return sessions;
  } catch {
    return [];
  }
}
