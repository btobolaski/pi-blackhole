# Plan — Issue #125: thin compaction-compat layer over `pi.events`

**Date:** 2026-10-12
**Status:** Planning — no code changes yet
**Inputs:** issue #125 discussion; pi 1.1 `docs/extensions.md` + `docs/compaction.md`; `dist/core/extensions/runner.js` + `types.d.ts` + `event-bus.d.ts`; local discovery below
**Constraint (from the author):** Jev / context-mode are a fad — out of scope as consumers. No first-class "compactor chaining API" and no new maintenance surface without a real second consumer. If anything ships, it is a **thin, reusable shim**: a bridge can **call us instead of fighting us for the hook**, plus a **minimal courtesy protocol** (result announcements, optionally diagnostic abort/error reasons for subscribers). Stale-ctx safety is non-negotiable throughout.

---

## 1. The problem, one paragraph

Pi owns compaction (trigger, cut, `CompactionEntry` persistence); extensions only supply content via `session_before_compact`, where the runner (`emit()` in `dist/core/extensions/runner.js:810-841`) runs handlers sequentially in load order, **last non-empty result wins**, and `{cancel:true}` short-circuits everything. Blackhole runs its full pipeline (`compile()` + OM fold + append chain, `src/hooks/before-compact.ts:302+`) and `pi-claude-bridge` then discards it with its own paid summary — or vice versa; a bridge error-cancel also loses blackhole's already-finished result. Reordering packages only flips the winner. `skipForProviders` (`src/core/provider-skip.ts`) is the only escape hatch today and it is all-or-nothing + deliberately undocumented. The #125 ask for a generic compactor API is rejected in that form; the remaining real need (raised by sonSunnoi, a genuine second party) is hook coexistence with the bridge.

## 2. Discovery log (evidence, not opinion)

### 2.1 `skipForProviders` — the existing shim

- Definition + matching: `src/core/provider-skip.ts:1-64` — bare `provider` or `provider:api` match against `ctx.model`; non-matching / missing model → `false`. Header comment states the maintenance policy explicitly: **do not extend/polish/document without a SECOND consumer**; correctness rests on an external unverifiable assumption about the other package's handler; deliberately absent from README/CONFIG.md.
- Config plumbing: default `[]` in `src/core/unified-config.ts:118,298,604-609`; env override `PI_BLACKHOLE_SKIP_PROVIDERS` in `src/core/config-env.ts:210`; surfaced only in `example-config.json:17-18` + CHANGELOG entry for #47 (`CHANGELOG.md:334`).
- Behavior: couples **no-compaction AND no-OM-consolidation** (`src/hooks/before-compact.ts:314-325`, early return before any pipeline work). Tests: `tests/provider-skip.test.ts`, `tests/vcc-before-compact-hook.test.ts:486-537`.
- Implication for this plan: the shim works for exactly-one-engine coexistence (codex case) but cannot express "bridge summarizes, blackhole keeps OM" or any merge — and per its own policy we must not grow it into that. Leave it untouched.

### 2.2 `pi-claude` / bridge mentions in our code

- `src/om/agents/observer/agent.ts:370-376` (mirrored in reflector/dropper): jiti-loaded consolidation agents (`moduleCache: false`) get a **separate pi-ai instance** whose registry lacks custom providers registered by other extensions (**explicitly names `claude-bridge`**). Workaround is `createBridgeStreamFn` → `src/om/provider-stream.ts:255-350`, a 4-layer dispatch: host facade `modelRegistry.streamSimple` → registry enumeration (exact `provider+api`, unambiguous api-only) → global `Symbol.for("pi-blackhole:provider-streams")` map populated in `index.ts:42-44,50-57` via `captureRegisteredProviderStreams` on every `agent_start` → `streamSimple` compat fallback. Plus `neverThrow` guard (`provider-stream.ts:352-435`) because pi's `agentLoop` is fire-and-forget.
- Takeaway: we already interoperate with the bridge **at the provider-transport layer** via a `Symbol.for` global + per-run capture (load-order independent). The missing layer is only the **compaction-hook layer**. Any new shim should follow the same load-order-independent philosophy.

### 2.3 Stale-ctx catalog — when it occurs, how we handle it today

Pi's `ctx` accessors **throw** (`"extension ctx is stale"` / `"ctx is stale"`) after session replacement / reload / dispose, or when deferred work outlives its ctx. Occurrences in this repo:

- **Deferred auto-compaction microtask** (`src/om/compaction-trigger.ts:32-67,494-498,540-553,657-668`): `agent_end` schedules idle-poll + `ctx.compact()`; non-persisted (in-memory subagent/SDK) sessions are disposed by the parent right after `agent_end` and **reliably lose the race** (issue #92). Handling: capture `hasUI/ui/sessionId` synchronously; per-iteration `getSessionId()` in try/catch; stale → `recordStaleCtxSkip` (process counter + warn-once-per-session, `STALE_SKIP_WARN_MAX_SESSIONS = 100`) + `debug.ndjson` trace; `docs/mid-run-compaction.md:44-83` documents the fail-closed collapse to inline for non-persisted sessions.
- **Event-handler entry guards**: every `agent_end` / `turn_end` / `session_compact_failed` handler wraps in try/catch and swallows only stale-ctx (`compaction-trigger.ts:171-193`, `compact-failed.ts:59-67`); `notifySafely` never lets a dead UI throw (`compact-failed.ts:34-46`, `compaction-trigger.ts:69-81`).
- **Consolidation pipeline**: stale-ctx is classified as _not a model error_ — excluded from cooldowns (`src/om/retryable-error.ts:166-178`), debug-logged per stage (`consolidation.ts` `pipeline/observer/reflector/dropper.stale_ctx` sites), counted in `/blackhole-memory` (`src/commands/memory.ts:284`).
- **Startup race** (`index.ts:62-78`, `CHANGELOG.md:155`, issue #91): `session_start` dynamic import + quit/reload/new in the window → catch-terminated, never fatal.
- **Runtime generation guard** (`src/om/runtime.ts:270-328`, PR #58): `startSession` / `captureGeneration` / `isGenerationActive` invalidate deferred work across session identity changes — the in-memory counterpart to the ctx-throw guard.
- Rulebook distilled for any new code (§6): capture primitives sync, never touch `ctx` in async continuations without a stale guard, fail-open (`return undefined`, never `{cancel:true}` on internal error), never throw out of handlers, warn-once + debug-log.

### 2.4 Pi 1.1 architecture (verified locally, not from memory)

- Hook semantics: `emit()` loop as described above; `isSessionBeforeEvent` covers `switch/fork/compact/tree`; `cache_warming_decision` is the only "last action wins" documented sibling (`extensions.md:121`). Handlers run in **extension load and registration order** (`extensions.md:97`).
- Custom summarization contract: `docs/compaction.md:292-383` — `session_before_compact` receives `{preparation, branchEntries, customInstructions, reason, willRetry, signal}`; may return `{cancel}` or `{compaction: {summary, firstKeptEntryId, tokensBefore, usage?, details?}}`; `session_compact_failed` (`reason, errorMessage, aborted, willRetry, fromExtension`) and `session_compact` exist for pairing attempts with outcomes. `fromExtension` is content-based (our `compact-failed.ts:93-102` attribution fix exists because hook `{cancel:true}` is mislabeled `false`).
- Cross-extension channel: `pi.events: EventBus` (`types.d.ts:1382`) with exactly `{emit(channel, data), on(channel, handler)}` (`event-bus.d.ts`) — **fire-and-forget, void-returning, untyped `unknown` payloads**, handler `(data) => void` (no ctx, no reply, no backpressure). `extensions.md:86` lists it as _the_ "communicate with another extension" point. No other extension-call mechanism exists in core (no RPC between extensions; `registerProvider`/`registerVirtualModel` are model-plane, not hook-plane).
- Current usage in this repo: **none** — `grep pi.events` hits zero; cross-extension today is `Symbol.for` globals only (`provider-streams`, `inline-compaction-adapter:v1` at `src/om/inline-compaction.ts:7`, `DISCARDED_COUNT`). So a `pi.events` protocol is greenfield and must define its own versioning/correlation/validation.

## 3. Goals / non-goals

- Goals: (a) bridge calls blackhole instead of racing it; (b) minimal courtesy announcements (claimed / produced / cancelled+reason / failed+error) any extension can subscribe to; (c) optional diagnostic propagation (abort reasons, caught errors) behind subscription — no polling, no new config required for the read-only half.
- Non-goals: generic multi-compactor chaining/merge/ordering engine; Jev/context-mode support; touching `skipForProviders` semantics; worker-input trimming (the author's preferred internal fix — separate track); any network/LLM work in the shim itself.

## 4. Design space (three options, then a recommendation)

- **A. `pi.events` request/response (user's pick).** Bridge emits `blackhole:compact:request` with `{nonce, replyTo, sessionId, reason, firstKeptEntryId?, payloadRef?}`; blackhole responds on `replyTo` with `{nonce, ok, summary?, details?, error?, reason?}`. Pros: sanctioned channel, no globals, works across jiti/host boundaries that share the host's bus. Cons: bus is untyped + spoofable (any extension can emit/listen), no timeout/backpressure built in, correlation + timeout + session-scoping must be hand-rolled, summaries must **not** be broadcast — only on a directed reply (privacy: conversation content on a shared bus is a leak to any installed extension). **And, decisively after cloning the bridge (see §4bis): it requires the other side to implement a caller — which will not happen (no PRs, no outreach). Speculative RPC with no caller is dead code.**
- **B. `Symbol.for` function registry (precedent: provider-streams, inline adapter).** Blackhole publishes `{version, summarize(...), claim/release}` under e.g. `Symbol.for("pi-blackhole:compact:v1")`; bridge calls it synchronously with its own timeout. Pros: typed-ish, zero protocol overhead, already proven for jiti duplication, natural request/response. Cons: not the documented extension-communication path; globally mutable; still needs versioning + fail-open wrappers. **Same caller problem as A.**
- **C. Announce-only + document ordering (cheapest).** Blackhole emits lifecycle announcements; no callable. Bridge uses them to stand down (`if blackhole claimed → return undefined`). Fixes the discard race for cooperative parties with ~30 lines, zero RPC, zero privacy risk (metadata only). Doesn't let the bridge _reuse_ our summary. **Emit-only half needs no cooperation and stays valid.**
- **Recommendation (revised after §4bis discovery): unilateral yield first (§4bis), emit-only C second, A/B demoted to appendix.** The efficient step needs no other extension to do anything.

## 4bis. Discovery round 2 — cloned `pi-claude-bridge` + `pi-subagents` (2026-10-12, `/tmp/opencode/`, read-only)

- **Bridge `session_before_compact` (`src/index.ts:2483-2514`) is already self-gating:**
  `if (ctx.model?.baseUrl !== "claude-bridge") return undefined;` — on foreign models it stands down; on its own models it runs pi's `compact()` with its `isolatedStreamFn` (CC-subprocess summary, `maxTurns: 1`, `persistSession: false`) and returns `{compaction}`; **on failure it returns `{cancel: true}`** ("cancelling to avoid native compact fallback", `:2505-2512`) — so a failed bridge takeover also kills blackhole's already-finished result. Same pattern on `session_before_tree` (`:2544-2566`). Provider registration pins `baseUrl: "claude-bridge"`, id `"claude-bridge"` (`convert.ts:9`, `index.ts:2595-2607`), so active bridge models carry `model.baseUrl === "claude-bridge"`. Bridge uses **`pi.events` nowhere** — there is nothing to subscribe to on its side.
- **Subagents is not a compactor.** Its `session_before_compact` (`src/extension/index.ts:1071-1073`) only suspends widgets and returns `undefined`; `session_compact` (`:1078-1104`) only resumes on manual compactions. No takeover, no conflict. Its heavy `pi.events` use (`SUBAGENT_*`) is a disjoint domain. Its children run as non-persisted sessions — already covered by our #92 stale-ctx paths, not by this plan. **No action needed; one regression test that our handlers ignore its events suffices.**
- **Consequence: the race is solvable unilaterally.** The two guards are complementary by construction — if blackhole mirrors the bridge's gate, exactly one engine acts per turn **regardless of load order**, with no protocol, no config, no cooperation:
  - bridge model → bridge acts, blackhole returns `undefined` (new);
  - any other model → bridge returns `undefined` (already), blackhole acts (unchanged);
  - bridge absent → no `claude-bridge` models exist (the provider comes from the bridge), so the gate is vacuous — fail-open by construction.

## 4ter. The unilateral step (the efficient one — no cooperation, no PR, no outreach)

**Model-gated yield in `registerBeforeCompactHook`, before any pipeline work (next to the `skipForProviders` early-return, `src/hooks/before-compact.ts:314-325`):**

1. **Gate on model identity, not extension presence.** New predicate (own module next to `provider-skip.ts`, hardcoded single-entry table — precedent: `OPENCODE_PROVIDERS` in `provider-stream.ts:107`): yield when `model.provider === "claude-bridge" || model.baseUrl === "claude-bridge"`, duck-typed defensively (unknown shape → no yield, existing `isProviderModel` style). Note `provider-skip.ts` currently ignores `baseUrl` — the bridge gates on `baseUrl`, so the new predicate must check it.
2. **Yield = `return undefined`, synchronously at entry** — zero pipeline work (today we burn a full `compile()`+OM fold that gets discarded), zero new stale-ctx surface (no async, no ctx retention). Trace `before_compact.yield_foreign_owner { provider, baseUrl }` to `debug.ndjson`.
3. **Scope: auto paths only (`threshold`/`overflow`).** Explicit `/blackhole` (`PI_VCC_COMPACT_INSTRUCTION`) keeps handling — the user explicitly invoked our engine; residual last-wins there is accepted and documented, not solved. `session_before_tree`: we don't handle it — nothing to do. `context` projection hook: bridge registers no `context` handler — nothing to do.
4. **Decouple from `skipForProviders` semantics.** That shim steps aside _entirely_ (compaction + OM consolidation) per user config. The auto-yield skips **compaction ownership only**; OM consolidation keeps running (workers use worker models, not the session model), so observations accumulate in the ledger and fold at the next blackhole-owned compaction. Rationale: the coupling reason in `provider-skip.ts:19-21` ("split the key then") now applies — this _is_ the "then". Do not touch `skipForProviders` behavior.
5. **Failure asymmetry accepted deliberately.** Bridge's `{cancel:true}`-on-error can still void our result on bridge models — but with the yield we never produce one there, so there is nothing to void. On non-bridge models the bridge returns `undefined` before doing anything fallible.
6. **Tests (repo rules T1–T8, fake ctx, no LLM):** yield on `baseUrl`-only / `provider`-only / both bridge models; no yield on normal models, on malformed `model` (null/string/`{provider:42}` — mirror `provider-skip.test.ts` style), on explicit `/blackhole` marker with bridge model; consolidation still scheduled on bridge models; trace emitted. Red-first against untouched `before-compact.ts`.

## 4quater. Optional analogue: the `pi-bash-live-view` yield pattern (not the default path)

The author's own `pi-bash-live-view` (`index.ts:38-76`) solves the same _class_ of problem on the tool plane: `bash` tool registration is **deferred to `session_start`** (because `pi.getAllTools()` is unavailable during extension load), ownership is inspected (`owned.sourceInfo?.source !== "builtin"`), and if another extension already owns `bash`, registration is **skipped entirely** — while ownership-independent surfaces (`user_bash` PTY ops, `/bash-pty`) register immediately regardless.

Transfer assessment — what carries over to the hook plane and what does not:

1. **Does not transfer directly: there is no hook-owner introspection API.** Tools have `pi.getAllTools()` + `sourceInfo`; `session_before_compact` handlers have neither a registry query nor owner metadata. Presence of the bridge cannot be observed from our side at any lifecycle point — only its _effects_ (registered provider ids, active model identity) are visible.
2. **The per-event model gate (§4ter) strictly dominates a session_start-time check.** A deferred "is the competitor present, then (un)register" decision would miss mid-session `/model` switches to/from `claude-bridge`, while the §4ter gate evaluates the actual owning model on every attempt. Withdrawing via the `pi.on()` unsubscribe handle is possible but buys nothing over `return undefined` and adds lifecycle edge cases (re-registration on reload, missed first compaction). **Not recommended; recorded so nobody re-derives it.**
3. **Transfers as an optional diagnostic (cheap, read-only): provider-presence probe at `session_start`.** Analogous to the `getAllTools()` check in spirit: `ctx.modelRegistry.getRegisteredProviderIds?.()` / `getProvider("claude-bridge")` (guarded try/catch — registry shape varies across hosts and subagent child sessions, cf. bridge's own per-session registry policy) → `debug.ndjson` trace `compat.foreign_provider_present { provider }`. No behavior change; purely explains "who could own this turn" in post-mortems. Optional because the §4ter gate already acts correctly without knowing presence.
4. **Transfers as a principle: separate ownership-dependent from ownership-independent surfaces.** Mirror of the bash-live-view split (tool defers, command/ops register immediately): our `session_before_compact` return is ownership-dependent (yields on foreign models); OM consolidation, `context` projection, recall tool, and `/blackhole*` commands are ownership-independent and keep running unconditionally — except the explicit carve-outs already decided (§4ter.3–4). This framing should be stated in the docs page so the yield reads as principled, not ad-hoc.

Status: optional. §4ter ships without it; (3) may ride along as a ~10-line trace if convenient.

## 5. Strawman protocol (to be finalized, not implemented)

Scope note: after §4bis, only the **announcement half** is Phase-2 material; the request/reply half is demoted to the Appendix until a caller exists.

- Channel namespace `blackhole:` + `v1` version segment on every message; unknown versions ignored (fail-open). Tentative channels: `blackhole:v1:compact:claimed` (we returned/will return content: `{sessionId, reason, firstKeptEntryId, tokensBefore, hasOMFold, trigger}`), `blackhole:v1:compact:done` (`{sessionId, reason, firstKeptEntryId, usage?, detailKinds}` — **no summary text**), `blackhole:v1:compact:cancelled` (`{sessionId, reason: ownCutReason|guardName, message?}`), `blackhole:v1:compact:failed` (`{sessionId, reason, errorMessage?, aborted, willRetry, attributedFromExtension}` — mirrors `session_compact_failed` + our attribution fix), and `blackhole:v1:compact:request` / reply for the callable half (`{nonce, replyTo, sessionId, reason, want: "summary"|"claim", ...}` → `{nonce, ok, summary?, details?, error?}` with caller-owned timeout; requester validates `nonce` + `sessionId` match, ignores late/foreign replies).
- Courtesy rule: a cooperative engine that sees `claimed` for the **current** session+reason returns `undefined` (stand down) instead of overwriting; blackhole does the symmetric check for a `bridge:v1:compact:claimed` announcement if the bridge adopts the mirror half — neither side ever emits `{cancel:true}` on behalf of the protocol. All emits wrapped so a throwing bus/subscriber cannot fail compaction (fail-open, trace to `debug.ndjson`).
- Privacy: announcements carry **metadata + reasons only**; summary text travels solely on the directed reply to the requesting channel, never broadcast; requests should carry entry ids / budget hints rather than full transcripts where possible (full `messagesToSummarize` passthrough is the expensive fallback — needs an explicit size cap decision).

## 6. Stale-ctx hardening rules for the new code (musts, from §2.3)

1. Capture `hasUI/ui/sessionId/cwd/model` synchronously at handler entry; never dereference `ctx` inside bus callbacks, timeouts, or reply continuations. 2. Every `ctx.*` access in a guard (`isStaleExtensionContextError` from `retryable-error.ts:168`); every `ui.notify` via `notifySafely`. 3. Handlers never throw; internal errors → `return undefined` (+ trace), never `{cancel:true}`. 4. Generation/session-identity check (`captureGeneration`/`isGenerationActive`) before answering a deferred request; stale → silent drop + `stale_ctx` trace. 5. Attribution flags (`compactWasPiVcc`, `lastCompactCancelled`) keep their establish-at-entry / consume-on-terminal-event discipline — the protocol layer must not reset them. 6. Request timeouts owned by the caller; blackhole never holds a ctx across the reply.

## 7. Open questions (for the author — deliberately undecided)

1. Default posture: announce-only default-on (my lean) vs. everything behind a flag? 2. Who may request summary text — any installed extension, or an allowlist (bridge package id)? Bus has no auth; allowlist-by-`provider` is spoofable but raises the bar — worth it? 3. Callable shape: full `compile()+OM fold` summary, or narrow "claim/release + reason" coordination only? 4. Payload cap for transcript passthrough on requests (or ids-only + bridge refetches from its own ctx?). 5. Mirror obligation: ~~do we require the bridge to emit `bridge:v1:*` for symmetric stand-down, or is one-sided courtesy enough?~~ **Answered by §4bis: no mirror needed — the bridge already self-gates on its models; our mirror gate completes the pair.** 6. Docs policy: `skipForProviders` stays hidden, but the bus contract must be documented _somewhere_ for adoption — `docs/` page + `example-config.json` comment only, or a exported `protocol.ts` with versioned types as the contract? 7. `Symbol.for` fallback: probe host bus identity first, or just build on `Symbol.for` from the start?

## 8. Phased rollout (each phase independently shippable, tests-first per repo rules T1–T8)

- **Phase 0 — done:** this discovery (§2 + §4bis). No code.
- **Phase 1 — unilateral yield (§4ter, the efficient step).** New predicate module + early `return undefined` in `before-compact.ts` + traces + tests. No bus, no config, no cooperation needed. Fixes the real race (wasted pipeline + discarded results + surprise `{cancel:true}` voiding) for the only genuine second party.
- **Phase 2 — announce-only (§5 strawman minus request/reply, i.e. old option C).** New `src/compat/bus.ts` (channel constants + payload validators + safe emit helpers) + emit `claimed/done/cancelled/failed` from `before-compact.ts` / `compact-failed.ts` terminal paths. Emit-only: useful to the author's own harness SDK and any future consumer, harmless if nobody listens. No handler-return changes.
- **Phase 3 — subagents non-interference regression test.** Assert our handlers ignore `SUBAGENT_*` traffic and non-persisted child sessions keep current #92 behavior. No production change expected.
- **Phase 4 — docs + policy:** `docs/` compat page, `example-config.json` comment, CHANGELOG entry; record in `provider-skip.ts`'s header that the bus (§5), not `skipForProviders`, is the second-consumer answer — without changing its behavior.

## Appendix — demoted: directed summarize-on-request (old option A/B, do NOT build speculatively)

Kept as a sketch only, for the day a real caller appears (a second consumer implementing the caller side — not Jev/context-mode). Requirements if revived: caller-owned timeout, `nonce`+`sessionId` validation, transcript size caps, summary text on directed replies only, runtime bus-identity probe across hosts (oh-my-pi class-style API caveat, cf. `compact-failed.ts:51-53`), `Symbol.for` fallback evaluation. Until then, §5's channel strawman stays a strawman.

## 9. Test strategy (repo constraints)

Pure unit tests with fake agent loops — no LLM/network (`AGENTS.md` testing quirks; `.js`-suffixed source imports). Cover every branch incl. malformed payloads, version mismatch, subscriber throws, stale ctx at each await point, session-changed mid-request, double-claim races. One behavior per case; cleanup in `finally`/after-hooks.

## 10. Risks

- Bus identity/shape variance across hosts (pi vs. oh-my-pi class-style API) — probe at runtime, degrade to no-op with trace. - Spoofed channels from untrusted extensions — validate + ignore, never act on `cancel` semantics from the bus. - Summary-text exfiltration to any listener — mitigated by directed-reply-only + caps, but remains a trust decision (extensions already run in-process with full transcript access — `extensions.md:5` — so this is consistent with the threat model, still document it). - Scope creep back into a generic chaining API — the phase gates + non-goals exist to prevent exactly this.
