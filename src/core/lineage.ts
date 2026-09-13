export interface LineageEntryLike {
  id?: string;
}

export interface LineageSessionManagerLike {
  getBranch: () => LineageEntryLike[];
}

/**
 * Entry IDs of the active lineage (current branch, including compacted
 * ancestors). Fails closed: an empty branch or a throwing `getBranch` yields
 * an empty allow-set, never all entries — recall must not widen to abandoned
 * rewind branches when lineage is unavailable.
 */
export const getActiveLineageEntryIds = (
  sessionManager: LineageSessionManagerLike,
): Set<string> => {
  try {
    const branch = sessionManager.getBranch() ?? [];
    return new Set(branch.map((e) => e.id).filter((id): id is string => Boolean(id)));
  } catch {
    return new Set();
  }
};
