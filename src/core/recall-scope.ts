export type RecallMode = "hybrid" | "file" | "touched";

const MODE_RE = /\bmode:(hybrid|file|touched)\b/i;

const VALID_MODES = new Set(["hybrid", "file", "touched"]);

export const normalizeRecallMode = (mode?: unknown): RecallMode =>
  typeof mode === "string" && VALID_MODES.has(mode.toLowerCase())
    ? (mode.toLowerCase() as RecallMode)
    : "hybrid";

export const parseRecallMode = (text: string): { mode: RecallMode; text: string } => {
  const modeMatch = text.match(MODE_RE);
  return {
    mode: normalizeRecallMode(modeMatch?.[1]),
    text: text.replace(MODE_RE, "").replace(/\s+/g, " ").trim(),
  };
};
