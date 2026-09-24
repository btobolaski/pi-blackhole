/**
 * Observational memory ledger types — validated Entry, Observation, Reflection.
 *
 * Upstream: https://github.com/elpapi42/pi-observational-memory (src/session-ledger/types.ts)
 * Unmodified.
 */
export const OM_OBSERVATIONS_RECORDED = "om.observations.recorded";
export const OM_REFLECTIONS_RECORDED = "om.reflections.recorded";
export const OM_OBSERVATIONS_DROPPED = "om.observations.dropped";
/** Inert, branch-local observer work created after /blackhole compaction. */
export const OM_OBSERVER_CATCH_UP_JOB = "om.observer.catch-up.job";
/** Append-only checkpoints for an observer catch-up job. */
export const OM_OBSERVER_CATCH_UP_PROGRESS = "om.observer.catch-up.progress";
export const OM_FOLDED = "om.folded";

export const RELEVANCE_VALUES = ["low", "medium", "high", "critical"] as const;
export type Relevance = (typeof RELEVANCE_VALUES)[number];

export const MEMORY_ID_PATTERN = /^[a-f0-9]{12}$/i;

export type Entry = {
  type: string;
  id: string;
  timestamp?: string;
  message?: unknown;
  content?: unknown;
  customType?: string;
  summary?: unknown;
  fromId?: string;
  data?: unknown;
  details?: unknown;
  firstKeptEntryId?: string;
};

export type Observation = {
  id: string;
  content: string;
  timestamp: string;
  relevance: Relevance;
  sourceEntryIds: string[];
  tokenCount: number;
};

export type Reflection = {
  id: string;
  content: string;
  supportingObservationIds: string[];
  tokenCount: number;
};

export type ObservationsRecordedEntryData = {
  observations: Observation[];
  coversUpToId: string;
};

export type ReflectionsRecordedEntryData = {
  reflections: Reflection[];
  coversUpToId: string;
};

export type ObservationsDroppedEntryData = {
  observationIds: string[];
  coversUpToId: string;
};

export type ObserverCatchUpJobData = {
  version: 1;
  /** The compaction that created this branch-local unit of work. */
  compactionId: string;
  fromId: string;
  throughId: string;
  /** Initial body offset when importing a partially delivered legacy job. */
  offset?: number;
};

export type ObserverCatchUpProgressData = {
  version: 1;
  compactionId: string;
  nextSourceId?: string;
  /** UTF-16 offset into nextSourceId's serialized body. */
  offset?: number;
  complete?: true;
};

export type MemoryDetails = {
  type: typeof OM_FOLDED;
  version: 1;
  fullFold: boolean;
  observations: Observation[];
  reflections: Reflection[];
};

export type V3MemoryCustomType =
  | typeof OM_OBSERVATIONS_RECORDED
  | typeof OM_REFLECTIONS_RECORDED
  | typeof OM_OBSERVATIONS_DROPPED;

export function isRelevance(value: unknown): value is Relevance {
  return typeof value === "string" && (RELEVANCE_VALUES as readonly string[]).includes(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

export function isMemoryId(value: unknown): value is string {
  return typeof value === "string" && MEMORY_ID_PATTERN.test(value);
}

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

export function isObservation(value: unknown): value is Observation {
  if (!isPlainRecord(value)) return false;
  return (
    isMemoryId(value.id) &&
    isNonEmptyString(value.content) &&
    isNonEmptyString(value.timestamp) &&
    isRelevance(value.relevance) &&
    isNonEmptyStringArray(value.sourceEntryIds) &&
    isTokenCount(value.tokenCount)
  );
}

export function isReflection(value: unknown): value is Reflection {
  if (!isPlainRecord(value)) return false;
  return (
    isMemoryId(value.id) &&
    isNonEmptyString(value.content) &&
    !/\r|\n/.test(value.content) &&
    isNonEmptyStringArray(value.supportingObservationIds) &&
    isTokenCount(value.tokenCount)
  );
}

export function isObservationsRecordedData(value: unknown): value is ObservationsRecordedEntryData {
  if (!isPlainRecord(value)) return false;
  return (
    Array.isArray(value.observations) &&
    value.observations.length > 0 &&
    value.observations.every(isObservation) &&
    isNonEmptyString(value.coversUpToId)
  );
}

export function isReflectionsRecordedData(value: unknown): value is ReflectionsRecordedEntryData {
  if (!isPlainRecord(value)) return false;
  return (
    Array.isArray(value.reflections) &&
    value.reflections.length > 0 &&
    value.reflections.every(isReflection) &&
    isNonEmptyString(value.coversUpToId)
  );
}

export function isObservationsDroppedData(value: unknown): value is ObservationsDroppedEntryData {
  if (!isPlainRecord(value)) return false;
  return isNonEmptyStringArray(value.observationIds) && isNonEmptyString(value.coversUpToId);
}

export function isObserverCatchUpJobData(value: unknown): value is ObserverCatchUpJobData {
  if (!isPlainRecord(value)) return false;
  return (
    value.version === 1 &&
    isNonEmptyString(value.compactionId) &&
    isNonEmptyString(value.fromId) &&
    isNonEmptyString(value.throughId) &&
    (value.offset === undefined ||
      (typeof value.offset === "number" && Number.isSafeInteger(value.offset) && value.offset >= 0))
  );
}

export function isObserverCatchUpProgressData(
  value: unknown,
): value is ObserverCatchUpProgressData {
  if (!isPlainRecord(value)) return false;
  if (value.version !== 1 || !isNonEmptyString(value.compactionId)) return false;
  if (value.complete === true)
    return value.nextSourceId === undefined && value.offset === undefined;
  return (
    isNonEmptyString(value.nextSourceId) &&
    (value.offset === undefined ||
      (typeof value.offset === "number" && Number.isSafeInteger(value.offset) && value.offset >= 0))
  );
}

export function isMemoryDetails(value: unknown): value is MemoryDetails {
  if (!isPlainRecord(value)) return false;
  return (
    value.type === OM_FOLDED &&
    value.version === 1 &&
    typeof value.fullFold === "boolean" &&
    Array.isArray(value.observations) &&
    value.observations.every(isObservation) &&
    Array.isArray(value.reflections) &&
    value.reflections.every(isReflection)
  );
}

export function isObservationsRecordedEntry(entry: Entry): entry is Entry & {
  type: "custom";
  customType: typeof OM_OBSERVATIONS_RECORDED;
  data: ObservationsRecordedEntryData;
} {
  return (
    entry.type === "custom" &&
    entry.customType === OM_OBSERVATIONS_RECORDED &&
    isObservationsRecordedData(entry.data)
  );
}

export function isReflectionsRecordedEntry(entry: Entry): entry is Entry & {
  type: "custom";
  customType: typeof OM_REFLECTIONS_RECORDED;
  data: ReflectionsRecordedEntryData;
} {
  return (
    entry.type === "custom" &&
    entry.customType === OM_REFLECTIONS_RECORDED &&
    isReflectionsRecordedData(entry.data)
  );
}

export function isObservationsDroppedEntry(entry: Entry): entry is Entry & {
  type: "custom";
  customType: typeof OM_OBSERVATIONS_DROPPED;
  data: ObservationsDroppedEntryData;
} {
  return (
    entry.type === "custom" &&
    entry.customType === OM_OBSERVATIONS_DROPPED &&
    isObservationsDroppedData(entry.data)
  );
}

export function buildObservationsRecordedData(
  observations: Observation[],
  coversUpToId: string,
): ObservationsRecordedEntryData | undefined {
  if (observations.length === 0 || !isNonEmptyString(coversUpToId)) return undefined;
  return { observations, coversUpToId };
}

export function buildReflectionsRecordedData(
  reflections: Reflection[],
  coversUpToId: string,
): ReflectionsRecordedEntryData | undefined {
  if (reflections.length === 0 || !isNonEmptyString(coversUpToId)) return undefined;
  return { reflections, coversUpToId };
}

export function buildObservationsDroppedData(
  observationIds: string[],
  coversUpToId: string,
): ObservationsDroppedEntryData | undefined {
  if (observationIds.length === 0 || !isNonEmptyString(coversUpToId)) return undefined;
  return { observationIds, coversUpToId };
}
