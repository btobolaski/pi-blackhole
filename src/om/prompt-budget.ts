/**
 * Measured worker prompt budget.
 *
 * The consolidation preflight used to price every worker prompt as content +
 * preamble + system + a flat AGENT_LOOP_RESERVE (8000), ignoring both ends of
 * the real first-turn prompt: the static overhead (system prompt + exactly one
 * tool schema + framing) is far smaller than 8000 — about 3.8k / 2.8k / 1.6k
 * tokens for observer / reflector / dropper — while the output allowance (up
 * to AGENT_LOOP_MAX_TOKENS) shares the same context window and was not priced
 * at all, so a prompt that "fit" could still 400 on output overflow.
 *
 * Static parts are measured once at import from the same objects the agents
 * send (system prompts, tool-schema modules); only genuinely unknowable
 * pre-hoc quantities stay estimated: later-turn tool traffic
 * (WORKER_TURN_HEADROOM_TOKENS) and a small safety margin. Variable content
 * terms (chunk text, observation/reflection contents) use the same CJK-aware
 * estimateStringTokens at every fit-check — never a flat chars/4, which
 * under-prices CJK ~3x relative to the measured side. (The measured schema
 * stringifies without typebox's symbol-keyed markers, so it prices slightly
 * below what the provider receives — the unsafe direction for a preflight
 * guard, but the delta is ~zero and the 1024-token safety margin absorbs it.
 * Host runtimes that shim typebox with callable schemas (omp/omptype) have
 * no toJSON, so JSON.stringify would yield `undefined`; schemaStaticJson
 * prices those at zero — or from toJsonSchema() when the shim exposes one —
 * instead of crashing extension load at import (#174).)
 */
import type { Model } from "@earendil-works/pi-ai";
import { DROPPER_SYSTEM } from "./agents/dropper/prompts.js";
import { DropObservationsSchema } from "./agents/dropper/tool-schema.js";
import { OBSERVER_SYSTEM } from "./agents/observer/prompts.js";
import { RecordObservationsSchema } from "./agents/observer/tool-schema.js";
import { buildReflectorSystem, REFLECTOR_SYSTEM } from "./agents/reflector/prompts.js";
import {
  RecordReflectionsWithSupersedesSchema,
  RecordReflectionsSchema,
} from "./agents/reflector/tool-schema.js";
import { AGENT_LOOP_MAX_TOKENS, boundedMaxTokens } from "./model-budget.js";
import { estimateStringTokens } from "./tokens.js";

export type WorkerPromptStage = "observer" | "reflector" | "dropper";

/**
 * Fixed user-text framing around the variable content: section headers plus
 * the instruction paragraph each agent builds inline (~100-150 tokens;
 * rounded up). Also absorbs the tool name/description lines (~50 tokens),
 * whose wording lives with the agent's tool definition. Re-measure if that
 * wording changes: this constant silently absorbs the difference today, with
 * roughly half its headroom still spare.
 */
export const WORKER_FRAMING_TOKENS = 256;

/** Headroom for turns after the first (tool calls + receipts), unknowable pre-hoc.
 * Sized for the shared agentMaxTurns budget (16 turns): a tool call plus its
 * receipt runs a few hundred tokens, so 2048 covers several follow-up turns
 * with margin while staying small enough not to squeeze the first-turn fit-check. */
export const WORKER_TURN_HEADROOM_TOKENS = 2048;

/** Safety margin applied on top of every fit-check. */
export const WORKER_SAFETY_MARGIN_TOKENS = 1024;

/**
 * JSON text of a tool schema for static pricing.
 *
 * Real typebox schemas are plain objects that stringify directly. Host
 * runtimes may swap typebox for a shim whose builders return callable
 * schemas (omp maps `typebox` to an omptype facade); a function has no
 * toJSON, so JSON.stringify yields the primitive `undefined` and pricing it
 * must not reach the token estimator — a throw here kills extension load at
 * import. Prefer the shim's toJsonSchema() for an accurate measurement,
 * fall back to zero otherwise: the largest worker schema is ~321 tokens,
 * well inside the 1024-token safety margin, so the underestimate stays
 * absorbed and the preflight guard keeps its safe direction.
 */
function schemaStaticJson(schema: unknown): string {
  if (schema == null) return "";
  try {
    const toJson = (schema as { toJsonSchema?: () => unknown }).toJsonSchema;
    if (typeof toJson === "function") return JSON.stringify(toJson.call(schema)) ?? "";
    return JSON.stringify(schema) ?? "";
  } catch {
    return "";
  }
}

function measureStatic(system: string, schema: unknown): number {
  return (
    estimateStringTokens(system) +
    estimateStringTokens(schemaStaticJson(schema)) +
    WORKER_FRAMING_TOKENS
  );
}

/** Static first-turn overhead per worker, measured once at import. */
const STATIC_PROMPT_TOKENS: Record<WorkerPromptStage, number> = {
  observer: measureStatic(OBSERVER_SYSTEM, RecordObservationsSchema),
  reflector: measureStatic(REFLECTOR_SYSTEM, RecordReflectionsSchema),
  dropper: measureStatic(DROPPER_SYSTEM, DropObservationsSchema),
};

/** Measured static first-turn overhead (system + tool schema + framing). */
export function workerStaticPromptTokens(
  stage: WorkerPromptStage,
  options?: { timestamps: boolean; supersedes: boolean },
): number {
  if (stage === "reflector" && options)
    return measureStatic(
      buildReflectorSystem(options),
      options.supersedes ? RecordReflectionsWithSupersedesSchema : RecordReflectionsSchema,
    );
  return STATIC_PROMPT_TOKENS[stage];
}

/**
 * Output allowance sharing the context window with the prompt. The agent loop
 * caps generation at boundedMaxTokens, so a fit-check that ignores output
 * admits prompts the provider then rejects. An unknown model assumes the
 * maximum allowance (safe direction for a pre-flight guard).
 */
export function workerOutputReserveTokens(model: Model<any> | undefined): number {
  if (!model) return AGENT_LOOP_MAX_TOKENS;
  return boundedMaxTokens(model, AGENT_LOOP_MAX_TOKENS);
}

/**
 * Floor for the dispatched generation cap. The quarter-window clamp below has
 * no natural lower bound, and a zero/NaN cap dispatched verbatim yields an
 * empty completion (silent empty success with coverage advanced on some
 * providers) or a malformed request. The floor never inflates past the model
 * reserve itself, and the fit-check still admits nothing unhostable — it only
 * keeps generation valid where the clamp would collapse. The floor only binds
 * below ~4k windows, where static overhead (1.6k–3.8k) plus turn headroom
 * already exceeds any budget — so it never takes a usable window out of play.
 */
export const MIN_WORKER_OUTPUT_ALLOWANCE_TOKENS = 1024;

/**
 * Output allowance sharing the context window with the prompt. The agent loop
 * caps generation at this value, so the fit-check reserve and the dispatched
 * cap must be the same number — otherwise a prompt that "fits" still 400s on
 * generation overflow. Capped at a quarter of the window (registries
 * reporting maxTokens near the window — and small windows that can never
 * host the full allowance — would otherwise either disable the stages or
 * dispatch an unhonorable cap), floored at the minimum usable generation cap
 * above. An unknown model assumes the maximum allowance (safe direction for
 * a pre-flight guard). A non-finite window falls back to the reserve: there
 * is no window to clamp against.
 */
export function workerOutputAllowance(window: number, model: Model<any> | undefined): number {
  const reserve = workerOutputReserveTokens(model);
  if (!Number.isFinite(window) || window <= 0) return reserve;
  return Math.max(
    Math.min(MIN_WORKER_OUTPUT_ALLOWANCE_TOKENS, reserve),
    Math.min(reserve, Math.floor(window * 0.25)),
  );
}

/**
 * Largest prompt-input estimate a model can take: window minus output
 * allowance minus safety margin. Compare the stage's estimated input
 * (content + preamble + static + turn headroom) against this.
 */
export function workerInputBudget(window: number, model: Model<any> | undefined): number {
  return Math.max(0, window - workerOutputAllowance(window, model) - WORKER_SAFETY_MARGIN_TOKENS);
}
