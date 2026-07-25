/**
 * Observational memory usage logging — writes pi-format JSONL to
 * `{sessionDir}/{sessionId}_memory.jsonl`, alongside the main session log.
 *
 * The OM agents (observer/reflector/dropper) run via the low-level
 * `agentLoop()` API from `@earendil-works/pi-agent-core`, which bypasses pi's
 * session management entirely. The real `Usage` from each `AssistantMessage`
 * produced by these agents is otherwise discarded. This module captures it and
 * writes it in the pi session log format defined by
 * `moriarty-workspace-3/crates/pi_logs/src/parser.rs` so it can be parsed by
 * the same tooling as the main session log.
 *
 * Wire format (one JSON object per line):
 *
 *   {"type":"session","version":3,"id":"<sessionId>","timestamp":"<ISO>","cwd":"<cwd>"}
 *   {"type":"message","id":"<8hex>","parentId":"<prevId>","timestamp":"<ISO>",
 *    "message":{"role":"assistant","content":[...],"api":"...","provider":"...",
 *    "model":"...","usage":{...},"stopReason":"...","timestamp":<epoch>}}
 *
 * All writes are synchronous (`appendFileSync`) and best-effort: a logging
 * failure must never crash the consolidation pipeline, but it is surfaced via
 * `debugLog` so silent data loss is observable when debug logging is enabled.
 * Volume is low (a handful of assistant messages per consolidation run), so
 * sync I/O is acceptable and matches the `debug-log.ts` flush pattern.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { debugLog } from "./debug-log.js";

/** Context needed to resolve the log path and write the session header. */
export interface UsageLogContext {
  /** Directory holding the main session log (from `sessionManager.getSessionDir()`). */
  sessionDir: string;
  /** Pi session id (from `sessionManager.getSessionId()`). Used as the file
   *  name suffix and the session header `id` (pi session ids are UUIDs). */
  sessionId: string;
  /** Working directory for the session header (from `sessionManager.getCwd()`). */
  cwd: string;
}

/**
 * A per-message usage sink. The consolidation pipeline passes `undefined` to
 * disable logging (when `usageLog` config is false).
 */
export type UsageLogger = (message: AssistantMessage) => void;

const SESSION_VERSION = 3;

/**
 * Sanitize an `AssistantMessage` for the pi log parser.
 *
 * The parser's structs use `#[serde(deny_unknown_fields)]`, so fields not in
 * its schema cause a parse failure. Three such fields appear on OM agent
 * messages and must be stripped:
 *
 *  - `usage.cacheWrite1h` — a subset of `cacheWrite` (1h retention split,
 *    reported only by Anthropic). `cacheWrite` already includes these tokens,
 *    so dropping the split loses no accounting. Parser's `AssistantUsage` has
 *    no such field.
 *  - `content[].redacted` (on thinking blocks) — not in the parser's
 *    `ThinkingAssistantContent`. The opaque redacted payload remains in
 *    `thinkingSignature`, which the parser accepts as `ThinkingSignature::Opaque`.
 *  - `content[].thoughtSignature` (on tool-call blocks) — Google-specific
 *    opaque signature; not in the parser's `ToolCallContent`.
 *
 * Everything else (`thinkingSignature`, `textSignature`, `reasoning`,
 * `diagnostics`, `responseId`, etc.) is in the parser schema and is preserved.
 */
export function sanitizeForLog(msg: AssistantMessage): object {
  const clone = JSON.parse(JSON.stringify(msg)) as any;

  if (clone.usage && typeof clone.usage === "object") {
    delete clone.usage.cacheWrite1h;
  }

  if (Array.isArray(clone.content)) {
    for (const block of clone.content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "thinking") {
        delete block.redacted;
      } else if (block.type === "toolCall") {
        delete block.thoughtSignature;
      }
    }
  }

  return clone;
}

/**
 * Dispatch assistant messages from an `agent_end` event to a usage logger.
 *
 * The `agent_end` event's `messages` array mixes roles (assistant, toolResult);
 * only assistant messages carrying `usage` are forwarded. Centralized here so
 * the observer/reflector/dropper agents share one implementation and cannot
 * drift on the filtering/casting logic.
 */
export function emitAssistantMessages(
  cb: UsageLogger | undefined,
  msgs: ReadonlyArray<{ role?: string; usage?: unknown }>,
): void {
  if (!cb) return;
  for (const msg of msgs) {
    if (msg.role === "assistant" && msg.usage) {
      cb(msg as AssistantMessage);
    }
  }
}

type ExistingLogState =
  | { state: "fresh" } // absent or empty — write a new header
  | { state: "resumable"; lastId?: string } // parsed — resume the chain
  | { state: "corrupt" }; // nonempty but unparseable — don't add a header

/**
 * Read the current state of an existing memory log so a freshly-created logger
 * can resume appending without writing a duplicate `session` header or breaking
 * the `parentId` chain.
 *
 *  - absent or empty file → `fresh` (caller writes the header)
 *  - parseable nonempty file → `resumable` with the last line's `id` to seed
 *    `lastId`. Both `session` header and `message` lines carry an `id`, so the
 *    last line's `id` is always a valid `parentId` for the next message.
 *  - nonempty but unparseable file → `corrupt`. The caller must NOT write a new
 *    header (that would duplicate one onto a nonempty file); it appends message
 *    lines chained from the session id. The failure is surfaced via `debugLog`.
 */
function readExistingState(logPath: string): ExistingLogState {
  try {
    if (!existsSync(logPath)) return { state: "fresh" };
    const content = readFileSync(logPath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0) return { state: "fresh" };
    const last = JSON.parse(lines[lines.length - 1]);
    return {
      state: "resumable",
      lastId: typeof last.id === "string" ? last.id : undefined,
    };
  } catch (error) {
    // Nonempty but unreadable/corrupt. Don't treat as fresh — writing a new
    // header would duplicate one onto existing content. Skip the header and
    // chain from the session id. Surface the failure so it's not silent.
    debugLog("usageLog.existing_corrupt", {
      path: logPath,
      error: String(error),
    });
    return { state: "corrupt" };
  }
}

/**
 * Create a usage logger that appends pi-format lines for each `AssistantMessage`
 * produced by an OM agent run.
 *
 * The session header is written once per file (not per logger instance): if the
 * file already exists from a prior consolidation run, the new logger resumes
 * appending message lines and chains `parentId` from the last written entry.
 * This keeps the log a single linear session across the many consolidation
 * runs that occur within one pi session.
 *
 * `lastId` is advanced only after a successful append, so a transient write
 * failure never leaves a later message chained to an entry that was never
 * written.
 */
export function createUsageLogger(ctx: UsageLogContext): UsageLogger {
  const logPath = join(ctx.sessionDir, `${ctx.sessionId}_memory.jsonl`);
  const existing = readExistingState(logPath);
  // Fresh: write a new header on first message. Resumable: skip header, chain
  // from the last id. Corrupt: skip header (avoid duplicating onto nonempty
  // content), chain from the session id.
  let headerWritten = existing.state !== "fresh";
  let lastId = existing.state === "resumable" ? existing.lastId : undefined;

  return (message: AssistantMessage): void => {
    try {
      if (!headerWritten) {
        mkdirSync(dirname(logPath), { recursive: true });
        const header = {
          type: "session",
          version: SESSION_VERSION,
          id: ctx.sessionId,
          timestamp: new Date().toISOString(),
          cwd: ctx.cwd,
        };
        appendFileSync(logPath, `${JSON.stringify(header)}\n`, "utf-8");
        headerWritten = true;
      }

      const id = randomEntryId();
      const parentId = lastId ?? ctx.sessionId;

      const line = {
        type: "message",
        id,
        parentId,
        timestamp: new Date().toISOString(),
        message: { role: "assistant", ...sanitizeForLog(message) },
      };
      appendFileSync(logPath, `${JSON.stringify(line)}\n`, "utf-8");
      // Advance only after a successful append so a failed write cannot
      // orphan the parent chain of a subsequent message.
      lastId = id;
    } catch (error) {
      // Best-effort: never crash the consolidation pipeline. Surface the
      // failure via debugLog so silent data loss is observable when debug
      // logging is enabled.
      debugLog("usageLog.write_failed", {
        path: logPath,
        error: String(error),
      });
    }
  };
}

/**
 * Generate an 8-char hex id, matching pi's short entry id format.
 * `randomBytes(4)` guarantees exactly 8 hex characters and uniform randomness
 * (unlike `Math.random().toString(16).slice(2, 10)`, which can yield fewer
 * than 8 chars for small random values).
 */
function randomEntryId(): string {
  return randomBytes(4).toString("hex");
}
