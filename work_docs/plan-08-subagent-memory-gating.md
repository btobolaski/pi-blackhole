# Plan 08 — Subagent memory gating: disable OM workers in subagent sessions

**Date:** 2026-10-12
**Status:** OPEN-ENDED DRAFT — no code changes yet, will iterate. Not an exact design document.
**Inputs:** https://github.com/k0valik/pi-blackhole/issues/147 (+ comments), linked #146 (credential leak, closed — out of scope), local clones in `/tmp/pi-subagents-map/` (15 repos: 10 in the first wave + 5 in the second wave below, depth-1, Oct 2026), current `src/om/consolidation.ts` + `src/om/compaction-trigger.ts` + `src/om/runtime.ts` + `src/core/unified-config.ts` + `src/core/config-env.ts`
**Direction agreed:** combination of option 2 (builtin detection + config knob, best-effort per-event gating) and option 3 (explicit env passthrough contract + docs). Our side only. Docs-only and downscale/profile variants deferred (see §9).

---

## 1. Problem statement

Issue #147 (kunkun9527, 10 days of local sessions, fork with Chinese-language support + pipeline fixes being ported in #143):

- Scope: 163 sessions — 67 main, 96 subagents — with `compaction: auto`, `memory: true`, `debugLog` off.
- Main sessions: 259 blackhole compactions; 5,853/6,751 newly generated memories ever injected (86.7%); 1,295/944/195 observer/reflector/dropper runs; ~480k observation+reflection text tokens.
- Subagents: **1** blackhole compaction; **15/1,111** memories ever injected (**1.35%**); 185/108/10 observer/reflector/dropper runs; **~138k** tokens generated and almost never injected.
- Memory share of summary: median ~57% per session (91% per compaction — three long sessions dominate with 188/259 compactions).

Root cause: OM workers fire on token thresholds (`observeAfterTokens` 15k, `reflectAfterTokens` 25k) that subagents can hit, but subagent sessions are short-lived and (usually) never reach the compaction threshold — or lose the `agent_end` deferred-compaction race for non-persisted sessions (issue #92, cf. `src/om/compaction-trigger.ts:205-216` and the stale-ctx skip counter). Worker output is pure waste. On local-inference rigs (Skelectric's report) it additionally contends with the model serving the subagent itself.

Current workarounds (all manual, all confirmed in the thread):

1. Exclude blackhole from the subagent's extension list (kunkun's lean runner supports per-subagent `extensions`; most runners below have some allowlist variant) and rely on pi's built-in compaction in children.
2. `pi-blackhole-child-guard`-style shim (Skelectric): read `PI_SUBAGENT_CHILD=1` before blackhole's first `ensureConfig()` and set `PI_BLACKHOLE_PASSIVE=1` **plus** `PI_BLACKHOLE_MEMORY=false` — both, because the declarative env map (`src/core/config-env.ts:110`) is applied after the passive block (`src/core/unified-config.ts:825-841`), so an inherited `PI_BLACKHOLE_MEMORY=true` re-enables workers despite passive mode. (Strictly: with the var _unset_, `readBooleanEnv` returns the fallback and passive survives — `src/pi-base/config.ts:542-548` — but belt-and-braces is correct whenever the parent exports the var into the child env, which several runners do wholesale.)
3. `compaction: off|manual` + `compactionEngine: pi-default` + `memory: false` per child — same effect via config instead of env.

k0valik's open question: "how do I turn off the workers for the subagent sessions only" — answer from the thread: **there is no pi-level switch**, every subagent extension needs a different solution (fork-of-session vs headless detached vs in-process SDK), and some "inherit settings from the main agent" (kunkun). The `--blackhole-om off` flag idea (k0valik) only works for runners that forward CLI flags.

Out of scope: #146 (closed), the memory-share-of-summary numbers (informational), any change to main-session behavior.

## 2. North star

**"Subagent sessions cost zero OM tokens by default, main sessions are untouched, and anyone who wants OM in a child can re-enable it with one knob."** Detection is best-effort and fails closed (unknown → treat as main session). No global config mutation from a child event (see §6).

## 3. Hard constraints (from the codebase)

1. **Heterogeneous runners, no single signal.** 10 surveyed runners use at least 4 spawn mechanisms (see §4). Any detection is a tiered map, not one check.
2. **Process-wide shared runtime.** `Runtime.config` is a single object with cached `ensureConfig` (`src/om/runtime.ts:522`; call sites `src/om/consolidation.ts:613`, `src/om/compaction-trigger.ts:140,200,387`, hooks). Same-process in-memory children share it with the parent. Gating **must be per-event** (`ctx`-keyed early return), never `runtime.config` mutation.
3. **Shared config file + inherited env.** Children read the same `~/.pi/agent/pi-blackhole/pi-blackhole-config.json` and usually inherit `process.env`. Differentiation must come from child-only signals (env markers set at spawn, session metadata, loader lists), not from config content.
4. **`isPersisted() === false` is necessary but not sufficient.** It covers subagents _and_ SDK/flow runners _and_ unsaved user sessions. Precedent for branching on it exists (`src/om/compaction-trigger.ts:215-216` inline-mode resolution, stale-ctx handling) — reuse the pattern but always combine with a subagent-specific signal.
5. **Env precedence ordering.** Passive block runs before `applyEnvOverrides(merged, DECLARATIVE_ENV_OVERRIDES, ...)` (`src/core/unified-config.ts:886-892`). Any new subagent knob must have a documented precedence vs `PI_BLACKHOLE_MEMORY` / `PI_BLACKHOLE_COMPACTION` and vs the config file.
6. **Docs consistency rule** (AGENTS.md): every default number in README.md / docs/CONFIG.md / llms.txt must match `src/core/unified-config.ts` defaults. New knob defaults must be mirrored in all three.

## 4. Spawn-mechanism taxonomy (from the /tmp clones)

- **Detached child `pi` process** (own `process.env`, own argv): edxeth-pi-subagents, HenryQW-pi-harness, 1aboveio-pi-better-harness, Gentleman-Programming/gentle-shell, boadij-pi-herdsman, nicobailon-pi-subagents (background/runner mode). Env markers are reliable here; argv (`-p`, `--mode json|rpc`, `--session`, `--no-extensions`, `-e …`) corroborates.
- **In-process `AgentSession`, same OS process** (shares `process.env`, no argv): tintinweb-pi-subagents, gotgenes-pi-packages, ESSO0428-pi-subagents, bacnh85-pi-extensions (SDK path), nicobailon-pi-subagents (foreground mode). Only session metadata / loader lists / in-process registries are visible.
- **Mixed** (both modes in one repo): nicobailon-pi-subagents, bacnh85-pi-extensions (SDK + herdr panes).
- **Headless children** (`hasUI === false`, `pi -p` / `--mode json|rpc`): all detached runners. In-process children inherit the parent's `hasUI` — not a signal there.

## 5. Detection map (per repo; paths absolute under /tmp/pi-subagents-map/, lines from Oct 2026 checkout)

### 5.1 nicobailon-pi-subagents — `nicobailon-pi-subagents` (`pi-subagents`, `index.ts`)

- Foreground: in-process child via `ChildSessionFactory.create()` → `pi.createAgentSession(...)` — `src/runs/shared/child-session.ts:405-539`, `bindExtensions({mode:"print"})` at `:545-551`.
- Background: detached runner (`node:child_process.spawn`) — `src/runs/background/async-execution.ts:754-792`; runner entry `src/runs/background/subagent-runner-bootstrap.ts:247-279`; driven via `runChildSession()` (`src/runs/background/run-child-session.ts:672-723`).
- Signals: `PI_SUBAGENT_CHILD=1` (`src/runs/shared/child-runtime-config.ts:16`, checked at extension entry `src/extension/index.ts:281-283`) — **runner-process only**; `PI_SUBAGENT_PARENT_SESSION` in runner env (`async-execution.ts:784-785`); `PI_SUBAGENT_EXTENSION_BINDINGS` + `MCP_DIRECT_TOOLS` child env (`src/runs/shared/child-launch.ts:166-176`, applied `child-session.ts:246-252,494`); session header `parentSession=<parent file>` (`child-session.ts:510-522`); session root `<parentSessionDir>/<parentBase>/<runId>/` (`src/extension/index.ts:170-177`); prompt prefix `<active_agent name="..."/>` (`child-launch.ts:324-349`); inline hook paths `<inline:pi-subagents:prompt-runtime|prompt-boundary|commands>` always loaded (`child-session.ts:193-228,467-470`).
- Extension control: **rich** — per-agent frontmatter `extensions` / `subagentOnlyExtensions` (`src/agents/agents.ts:85-86,115-116,2263-2264,2354-2355`), defaults `subagents.defaultExtensions` / `defaultSubagentOnlyExtensions` + overrides. No arbitrary env/CLI passthrough.
- Blackhole detection: runner → env markers; foreground → loader list contains `<inline:pi-subagents:…>` or `pi-subagents` path, and/or `parentSession` header points at a different session file.

### 5.2 tintinweb-pi-subagents — `@tintinweb/pi-subagents` (`src/index.ts`)

- Always in-process: `manager.spawn(...)` → `runAgent()` → `createAgentSession({...})` + `session.bindExtensions()` — `src/agent-runner.ts:666-674,1054-1124`. "Background" is only a concurrency pool (`src/agent-manager.ts:1-15,99-112`). Mention-clone path: `SessionManager.inMemory(...)` (`src/mention-clone.ts:163`). No spawn/fork/execFile, no `pi` CLI.
- Signals: **none environmental** (`PI_*` hits are only `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR`). Persistence: `SessionManager.open(resumeFile)`/`create(...)` when `persistSession`, else `SessionManager.inMemory(effectiveCwd)` (`agent-runner.ts:1054-1074`); child records `parentSession` in create options (`:1072`); session name = agent name (`:1108-1111`). `AsyncLocalStorage` child flag (`src/child-context.ts:1-15`) is internal-only, invisible to blackhole. Loader identity: `pi-subagents`/`tintinweb-pi-subagents` (canonical-name matching, `agent-runner.ts:55-96`).
- Extension control: **yes** — per-agent `extensions: true|string[]|false` + `exclude_extensions` denylist (exclude wins; `isolated:true` forces `false`), enforced `agent-runner.ts:694-805`. No env/flag passthrough.
- Blackhole detection: inMemory (no session file) + session name is a known agent name + `globalThis[Symbol.for("pi-subagents:manager")]` registry (`src/index.ts:663,742-754`) knows the id / `rootSessionId` matches the carrier session.

### 5.3 Gentleman-Programming/gentle-shell — key file `extensions/gentle-agents.ts`

- Detached `pi --mode rpc` child per subagent: `deps.spawn(pi.command, [...pi.args, ...childArguments(request)], ...)` — `lib/agents-runner.ts:527-574`, shim `extensions/gentle-agents.ts:217-218`. Argv builder `childArguments()` (`lib/agents-runner.ts:305-327`): `--mode rpc --session-dir <dir>` + `-e/--no-extensions` + `--session <resume>` + `--model/--thinking` + `--tools` + `--append-system-prompt`. Parent drives over JSONL-RPC + Node IPC.
- Signals (strongest of batch A): `GENTLE_PI_AGENTS_CHILD=1` + `GENTLE_PI_AGENTS_OWNED_IPC=<token>` (`lib/agents-runner.ts:230,534-539`); `GENTLE_PI_AGENTS_REQUESTED_TOOLS=<csv>`; argv `--mode rpc --session-dir ~/.pi/agent/gentle-agents/sessions`; headless (`!ctx.hasUI`); child factory early-returns after `registerChildMessaging` (`gentle-agents.ts:466-475`); `GENTLE_SHELL_INTERACTIVE_HOST` stripped from every child env.
- Extension control: **host-only, no per-agent knob** — `TaskRequest.extensionPaths/noExtensions` are "Host-provided only" (`lib/agents-runner.ts:132-137`); `AgentDefinition` has no extensions field (`lib/agents-config.ts:45-55`). Env passthrough: **wholesale** (child env starts as parent copy, `gentle-agents.ts:1667`), so `PI_BLACKHOLE_*` flows through.
- Blackhole detection: `GENTLE_PI_AGENTS_CHILD==="1"` primary (+ `OWNED_IPC` confirm); fallback argv `--mode rpc` + `--session-dir` containing `gentle-agents/sessions`.

### 5.4 HenryQW-pi-harness — `extensions/pi-subagent` (`@henryqw/pi-subagent`, entry `./extensions/subagent.ts`)

- Detached child `pi` processes only, two transports, both `node:child_process.spawn` of a re-resolved `pi` CLI: ephemeral/direct (`src/ephemeral.ts:451,462-472`: `--mode json -p …`, `PI_CODING_AGENT=true` + `process.title pi|pi-rpc` required at `:231`) and herdr (`src/herdr-runtime.ts:975-981`, `herdr tab create … --env PI_SUBAGENT_PROCESS_LEASE=…`, `src/direct-herdr.ts:313`).
- Signals: `PI_SUBAGENT_EXECUTION_BUDGET` (JSON 豁`{maxTurns,maxMs,startedAt[,maxTokens]}`, const `src/ephemeral.ts:13`, injected `:467`) and `PI_SUBAGENT_PROCESS_LEASE` (const `src/index.ts:71`). No `PI_SUBAGENT_CHILD`. CLI: always `--no-session --no-extensions --no-skills --exclude-tools delegate_task,…` + `--<pi-subagent-role-mcps> <json>` + `--extension` per Role extension + `--model/--thinking/--approve/--append-system-prompt` (`src/index.ts:573-580,684-693`); herdr swaps one `--no-session` for `--session <lease>.session.jsonl`. Identity prefix `You are a delegated Pi Subagent, not Main…` (`src/index.ts:125,589`).
- Extension control: per-Role allowlist — children run `--no-extensions` by default, Role lists `--extension` paths (`src/index.ts:568-576`); excluding blackhole = omitting it from the Role (default excluded).
- Blackhole detection: `PI_SUBAGENT_EXECUTION_BUDGET` / `PI_SUBAGENT_PROCESS_LEASE`; fallback argv `--pi-subagent-role-tools` + `--pi-subagent-role-mcps` + `--no-extensions`.

### 5.5 gotgenes-pi-packages — `packages/pi-subagents` (`@gotgenes/pi-subagents`)

- In-process only: `SubagentManager.spawn/spawnAndWait` (`src/lifecycle/subagent-manager.ts:302,320`) → `createSubagentSession()` (`src/lifecycle/create-subagent-session.ts:210-334`) → SDK `createAgentSession({...})` (`src/index.ts:137-164`) + `session.bindExtensions({})` (`:319`). No child process/CLI.
- Signals: **no env**. Persisted `SessionManager.create(cwd, sessionDir)` + `newSession({parentSession: parentSessionId})` (`:281-283`); dir `<parentDir>/<parentBase>/tasks/` (`src/session/session-dir.ts:23-31`), tmpdir fallback when parent is inMemory. Lifecycle events `subagents:child:spawning|session-created|bound|completed|disposed` on `pi.events` (`src/lifecycle/child-lifecycle.ts:21-45,95-115`); service via `Symbol.for()` (`src/index.ts:201-204`). Child loads all parent package extensions minus `excludedExtensionPackages` + only needed builtins (`src/session/builtin-extensions.ts:33-65`); parent-only tools denylisted (`:42-49,295`); child gains `ask_parent`/`notify_parent` (`:198-204,285-294`).
- Extension control: **yes** — hand-edited `excludedExtensionPackages?: string[]` matched against the package source string (`src/settings.ts:40-45`), enforced at resolution time so the module is never imported (`src/session/package-exclusions.ts:9-12,29-51`).
- Blackhole detection: subscribe to `subagents:child:session-created/bound` (`{sessionId, parentSessionId}`) and compare with own sessionId at `session_start`; corroborate via toolset (no `subagent/get_subagent_result/steer_subagent`, has `ask_parent`).

### 5.6 boadij-pi-herdsman — `pi-herdsman` (entry `./dist/index.js`)

- Detached herdr panes/tabs running full `pi` agents (`herdr agent start --kind pi`), never in-process: `delegate_agent` (`src/agent-controller.ts:5521-5793`) → `startHerdrAgent()` (`src/herdr.ts:1275-1617`) → `herdr tab create … --env <topologyEnv>` + `herdr agent start … -- [--extension …] <agentArgs…>` (`:1524-1554`); args from `agentLaunchArgs()` (`src/agent-definitions.ts:906-1029`).
- Signals (authoritative): `PI_SUBAGENT_CHILD=1` + `PI_SUBAGENT_PARENT_SESSION=<forwardingSession>` injected by `structuredTopologyEnvironment()` (`src/herdr.ts:587-626`, reserved set stripped `:603-612`, override asserted by tests `:75-94`); plus `PI_HERDSMAN_MAILBOX/RUN_ID/OWNER_SESSION_ID/LABEL/WORKSPACE_ID/AGENT_DEFINITION/...` (`src/agent-controller.ts:5737-5753`). Self-identity custom entry `pi-herdsman-agent-definition` (`:695`, write `src/managed-agent-runtime.ts:167`, read `src/agent-controller.ts:1061-1142`). Herdr topology `HERDR_ENV/WORKSPACE_ID/TAB_ID/PANE_ID` present.
- Extension control: per-agent-definition allowlist (`src/agent-definitions.ts:1022-1025`, `src/herdr.ts:1537-1543`); no global exclude toggle.
- Blackhole detection: `PI_SUBAGENT_CHILD==="1"` + herdsman vars; fallback own session entries for `customType==="pi-herdsman-agent-definition"`.

### 5.7 ESSO0428-pi-subagents — `@esso0428/pi-subagents`

- In-process only: `src/agent-manager.ts:364-446` `spawn(...)` → `startAgent` (same Node process); `src/agent-runner.ts:830-832` builds `SessionManager.inMemory` by default (`persist_session` frontmatter persists); `createAgentSession({... sessionStartEvent: {reason:"fork"} ...})` (`:844-870`) wrapped in `runInChildSessionContext()`.
- Signals: **no env/CLI/process**. `session_start` reason `"fork"` (`:857-860`); default `isPersisted()===false`; singleton `globalThis[Symbol.for("pi-subagents:manager")]` (`src/index.ts:523-534`); session name `Name#<id8>` (`:873-876`); record `{rootSessionId,sessionId,depth,parentAgentId}` (`agent-manager.ts:396-401`); canonical loader name `pi-subagents` (`agent-runner.ts:119-123`).
- Extension control: **rich** — frontmatter `extensions` / `exclude_extensions` (denylist wins), `isolated`, `persist_session`, `session_dir` (`src/custom-agents.ts:67-68`, `src/agent-runner.ts:549-553,604-658`); documented contract `src/index.ts:2282`. No env/flag passthrough.
- Blackhole detection: `reason==="fork"` + manager singleton present; corroborate inMemory + name suffix; loader canonical names / tool names (`Agent/get_subagent_result/steer_subagent` absent in fork children).

### 5.8 1aboveio-pi-better-harness — `packages/pi-better-subagents` (`pi-better-subagents@0.18.0`)

- Detached headless `pi` CLI: `spawnDetached()` (`spawn.ts:20-59`: `spawn(file,args,{detached:true, env:{...process.env,...env}})`, `unref()`); caller `spawnSubagentRun()` (`index.ts:1673-1857`): `pi -p --mode json --session-dir <dir> --session-id <id> --no-extensions -e <needed>… --extension <child-steer.ts> … <prompt>`.
- Signals: **only env var `PI_SUBAGENT_STEER_FILE=<runDir>/steer** (`index.ts:1849-1850`, `child-steer.ts:23,57-58`); argv `-p --mode json --session-id/--session-dir`, always `--no-extensions`unless operator`inheritExtensions` (`extensions.mjs:137-146`, default false); persisted per-run session dir + `meta`JSON`{pid, spawnPid, sessionId}` (`:1866-1881`); never `hasUI`.
- Extension control: **yes** (operator + derived): `inheritExtensions` / `clean` / isolated tool-mapped specs (`extensions.mjs:85-128`); unmapped tools reported, never silently loaded. Per-child env: only steer file.
- Blackhole detection: `PI_SUBAGENT_STEER_FILE` non-empty (unique across all surveyed repos); corroborate argv + loaded `child-steer.ts`. Note: `inheritExtensions:true` children load everything with no allowlist trace — steer-file env is then the only marker.

### 5.9 bacnh85-pi-extensions/pi-subagent — `@bacnh85/pi-subagent@0.23.3`

- In-process SDK session by design ("no `pi` process", `extensions/runner.ts:1-15`): `createAgentSession({... sessionManager: SessionManager.inMemory(childCwd), settingsManager: SettingsManager.inMemory({compaction:{enabled:false}, retry:{maxRetries:1}}) ...})` (`:206,256-262`); `session.prompt(task)` raced against `agent_end` (`:304`), `session.dispose()` in finally (`:338`). Second runner: herdr tab/pane (out-of-process `pi`, not `child_process.spawn`). Optional `sandbox:"worktree"` (`.pi-worktrees/pi-subagent-*`).
- Signals: SDK path **none** (no env/CLI/process; in-memory; `projectTrusted` forwarded only). Herdr path only: `PI_SUBAGENT_HERDR=off` (`herdr.ts:38,190,376-383,430-435`; disables `herdr` tool in child). Loader: lean (`noSkills/noPromptTemplates/noContextFiles/noThemes`, `:86-95`) or empty stub when `loadExtensions=false` (`:196-205`).
- Extension control: **boolean only** — `resolveChildTools()` (`extensions/index.ts:992-1005`): any non-builtin tool need → `loadExtensions=true` loads **all** parent extensions (`needsExtensions`, `extensions/security.ts:363-366`); `DENIED_CHILD_TOOLS` stripped (`:384-386`). No allowlist, no env passthrough. Hardest repo for fine-grained exclusion.
- Blackhole detection: herdr → `PI_SUBAGENT_HERDR==="off"` definitive; SDK → inMemory + the distinctive settings combo (compaction disabled + `retry.maxRetries===1`) + loader contains `pi-subagent/extensions/index.ts` + worktree/sibling-dir corroboration. If `loadExtensions=false`, blackhole isn't running there at all.

### 5.10 edxeth-pi-subagents — `pi-subagents@2.9.2`

- Always detached headless `pi` CLI, background + interactive (mux) variants: background `src/launch/background.ts:131-157` (`spawn(..., {detached:true, env: getSubagentChildProcessEnv(...)})`, `unref()`); interactive via mux surfaces (`src/launch/interactive.ts:45+`, capsule `src/launch/run-child.mjs:1-127`). Binary `getPiInvocation()` (`src/launch/child-command.ts:59-79`): `PI_SUBAGENT_PI_COMMAND` override > `process.execPath+argv[1]` > `pi`. Argv (`background.ts:89-119`, `prep.ts:224-286`): `-p [--session <file> [--no-session]] [-e <subagent-done.ts> (-e <allowlist>…) …] [--model/--tools/--exclude-tools/--no-context-files/--approve] @<taskArtifact>`.
- Signals (richest): child env `PI_SUBAGENT_NAME/AGENT/SESSION/PARENT_SESSION/SURFACE/SPAWN_BUDGET/.../TIMEOUT/.../EXTENSIONS/...` (`src/launch/prep.ts:420-481`, `launch-coordinator.ts:108-117`; background adds `PI_SUBAGENT_TIMEOUT_STARTED_AT`, interactive adds `PI_SUBAGENT_SURFACE=pane:<id>` + mux pane identity). Ships canonical detector `isSubagentChildEnvironment()` (`src/runtime/orchestrator-policy.ts:7-18`): any of `PI_SUBAGENT_AGENT/_PARENT_SESSION/_NAME/_SESSION/_SURFACE` non-empty. CLI/session: `--session <file>` (+ mandatory `-e …/tools/subagent-done.ts`), persisted `launchMetadata` JSON, capsule dir `pi-subagent-env-*/capsule.json`.
- Extension control: **yes** — per-agent allowlist (`launch/policy.ts:151-168`: unset/`all` → inherit, `none` → `[]`, else list; `prep.ts:224-242` always prepends `--no-extensions` when specified + mandatory `subagent-done`); plus `tools:/deny-tools:`, `skills:`, free `flags:`, `env:` frontmatter (reserved `PI_SUBAGENT_SPAWN_*` stripped, `prep.ts:483-493`).
- Blackhole detection: call the same disjunction; `PI_SUBAGENT_SESSION` + `PI_SUBAGENT_PARENT_SESSION` give lineage; `PI_SUBAGENT_EXTENSIONS` echoes the allowlist decision.

### 5.11 dnouri/pi-submarine — `pi-submarine@0.4.0`

- In-process only: `runSubagent()` → `prepareRun()` → `createChildSession()` → `childSession.prompt(task)` (`src/runner.ts:236-266,935-951,1061-1106`); production deps direct SDK calls (`:1333-1341`). Fork mode branches the parent manager: `plan.sourceSessionManager.createBranchedSession(plan.currentLeafId)` (`:899-911`).
- Signals: **no env/CLI/argv**. Parent must be persisted (`ctx.sessionManager.getSessionFile()` required, `:566-567,614-615`). Child JSONL under `<parentSessionFile>.subagents/` (`resolveSubagentsRoot()`, `src/sessions.ts:15-35`); manifest `<dir>/manifest.jsonl` (`:37-39`); nested depth capped at 4 (`src/runner.ts:119,847-850`). Prompt wrapped in `<subagent-context>…You are a child subagent…</subagent-context><task>…` (`src/tool-prompts.ts:56-72`) — first child message contains literal `<subagent-context>`. Child **re-loads submarine itself** (`src/index.ts:52-53,64-65`, merged `src/runner.ts:183-190,212-220`).
- Extension control: **none** — no allowlist/denylist, no env/flag passthrough. Only prompt-level knobs (`noContextFiles` when `agentsMd==="none"`, `noSkills`/`skillsOverride`, cwd override). Quote `src/index.ts:52-53`: `return runSubagent(params, signal, onUpdate, ctx, { extensionFactories: [register] });` (additive only — otherwise the default loader still loads the user's full extension set, so **blackhole loads in children by default and currently cannot be excluded**).
- Blackhole detection: session file path ends `.subagents/*.jsonl` + sibling `manifest.jsonl`; and/or loaded-extension paths include `pi-submarine/src/index.ts`; and/or first message starts with `<subagent-context>`. `isPersisted()` does NOT discriminate (both sides persisted).

### 5.12 AlexParamonov/pi-subagents-lite — `pi-subagents-lite@1.16.0`

- In-process on in-memory session: `runAgent()` brackets `runAgentImpl()` with `enterSubagentSpawn()/exitSubagentSpawn()`; `createChildSession()` (`src/agents/agent-runner.ts:781-850`) builds `SettingsManager.create(...)` (`:795-797`) + `DefaultResourceLoader`, then `createAgentSession({…, sessionManager: SessionManager.inMemory(cwd), …})` (`:552`). No child process/CLI.
- Signals: **no `PI_SUBAGENT_*` env, no CLI/argv**. Strongest: in-memory/ephemeral (no `getSessionFile()`). Session name = agent name `[#<shortid>]` (`:604-605`). Same-process re-entrancy guard `subagentSpawnDepth` (`src/shell.ts:98-111`); factory early-returns while set (`src/index.ts:16-19`: _"Subagents re-load this extension under their own pi/runtime. Stay inert…"_). Child loader gets only pi built-ins (`BUILTIN_EXTENSION_FACTORIES`: codemode, tool-search, mcp — `src/agents/builtin-extensions.ts:23-27`, `:486-493`), so the spawner itself is normally absent from the child list.
- Extension control: **yes** — frontmatter `extensions?: true|string[]|false` + `excludeExtensions?: string[]` (mutually exclusive, `src/agents/types.ts:24-27`), applied `src/agents/agent-runner.ts:475-512` (`noExtensions` / whitelist / blacklist, case-insensitive name match `:418-436`). No env/flag passthrough.
- Blackhole detection: inMemory + sibling live `Agent` tool session owned by `pi-subagents-lite` (near-unique — the other in-process repos persist children); corroborate: child inventory is builtins + allowlisted subset, spawner absent via its own early-return.

### 5.13 championswimmer/pi-subagent-manager — `pi-subagent-manager@0.27.0`

- In-process isolated `AgentSession`s, no child process/CLI: `createDriver()` builds a fresh `SessionManager` per thread — `SessionManager.create(ctx.cwd, sessionDir, {parentSession})` or `SessionManager.open(...)` for resume (`src/orch/runtime.ts:250-319,515-529`), where `sessionDir = ctx.sessionManager.getSessionDir()` (`:260`, persisted JSONL alongside root). `bindExtensions({ mode: "print" })` (`:687`) — children are non-interactive print mode (`docs/subagent-extension-limitations.md:22`).
- Signals: **no child env var** (only parent-side `PI_SUBAGENT_EXTRA_AGENT_DIRS`, `src/prefs/import-discovery.ts:23,97`). Ownership custom entries (strongest): child head `pi-subagent:thread:v1` `{rootId, threadPath, inheritedCount}` (`:50,290-294`, read `:790-802`); root `pi-subagent:registry:v1` `{version, rootSessionId, threads}` (`src/index.ts:26,244-250,607-622`), `pi-subagent:root-mailbox:v1`, `pi-subagent:cost:v1` (`src/orch/cost-ledger.ts:4`), mailbox `pi-subagent:mailbox:accepted/consumed/migration:v2`, bridge `pi-subagent:update/final-recap/wake`. Child name via `appendSessionInfo(type.name + path)` (`:289`), paths `/root/<slug>-<n>` (`src/orch/paths.ts:4-15`); child system prompt contains `Your thread path is ${path}.` (`:458-471`).
- Extension control: **global boolean only** — `subagentExtensions` (default `false`, `src/prefs/settings.ts:55,76`); child loader hard-codes `noExtensions: true` (`:421`) + `additionalExtensionPaths` from `discoverSubagentExtensions()` when on (`:404-406`); manager always excluded by path/name (`src/orch/extensions.ts:12-28,47-49`). No per-agent list, no env/flag passthrough.
- Blackhole detection: branch scan for `customType==="pi-subagent:thread:v1"` (works from parent or child); parent-side `pi-subagent:registry:v1` with `rootSessionId` match. Secondary: `mode:"print"` binding, `hasUI`-absent child, loader has `child-codemode`/`child-tool-search`/`<subagent-inherited-tools>` but never the manager itself. Note: with default `subagentExtensions=false`, blackhole is absent from children — detection is then parent-side confirmation, not gating.

### 5.14 pifydev/subagent — `@pify/subagent` (entry `./extensions/subagent.ts`)

- In-process `createAgentSession`, same process, no child/CLI/RPC (`extensions/subagent.ts:337-347`): `sessionManager: SessionManager.inMemory(workDir ?? ctx.cwd)`; loader hand-built with **`noExtensions: true` unconditional** (`:313-317`). Optional `isolation:"worktree"` only changes cwd. Parent persists only a `RESULT_ENTRY` via `pi.appendEntry` (`:480-489`, `src/persist.ts`).
- Signals: **none** — zero `PI_SUBAGENT_*` hits; no argv; non-persisted child; child gets `ask_supervisor` tool `if ctx.hasUI` (`:273-305`); parent widget only (`:120-135`); run ids `reviewer-1`/`worker-2` (`src/ids.ts`); worktree `~/.worktrees/<repo>/<slug>` + branch `agent/<slug>[-N]` (`src/isolate.ts:41-62`); child system prompt contains `You are a subagent running a single delegated task…` (`src/prompts.ts:40-53`).
- Extension control: **none by construction** — `noExtensions:true` has no parameter (`:313-324`); knobs are only agent-def `tools:/model:/thinking:/max_turns:/system_prompt_mode:/inherit_skills:` (README:92-120).
- Blackhole relevance: **child never loads any extension — auto-disable is free, nothing to gate.** Parent-side "session uses pify-subagent" check (for bookkeeping only): loaded tools/paths contain `agent_run` / `@pify/subagent`, or branch has `RESULT_ENTRY` / `subagent-mention` (`:82`). Do not use env/argv/`isPersisted()` alone here.

### 5.15 narumiruna/pi-extensions — `packages/pi-subagents` (`@narumitw/pi-subagents`, entry `./dist/index.ts`)

- Detached headless `pi` CLI over RPC/stdin-stdout JSONL: `runChild` → `resolvePiInvocation(buildPiArgs())` → `executeProcess` (`src/process.ts:67-85,408-414`, `detached:true` posix); parent drives `prompt/steer/get_state/get_commands` RPC (`:469-505`); teardown SIGTERM→SIGKILL. No in-process sharing.
- Signals: `PI_SUBAGENT_DEPTH` = parent+1 (`src/process.ts:405`; nesting refused when >0, `src/tools.ts:456-460` — persists, most useful); `PI_SUBAGENT_BROKER_FD=3` + `PI_SUBAGENT_READINESS_FD=4` (`src/broker-credentials.ts:24-29`) — **visible only very early**, `captureChildBootstrap()` deletes both on import (`:48-52`); real broker token travels via fd-3 pipe, never env/cmdline. CLI `buildPiArgs` (`:92-116`): `--mode rpc --no-session --no-extensions --no-skills --no-prompt-templates -e <child-communication-bridge> [-e builtin:codemode] [-e <attached>…] … --model … --tools <csv incl. subagent_send,subagent_wait>` (verified `test/process.test.ts:48-119`). Always headless; `--no-session` (no persistence, README:201/231). Job ids `job_<t36>_<n36>` (`runtime.ts:133`); readiness attestation `{ok,sources:[sha256…]}` over fd 4; `globalThis[Symbol.for("@narumitw/pi-subagents/child-readiness")]` residue (`broker-credentials.ts:13,89-99`).
- Extension control: **yes, opt-in per job** — `subagent_spawn({ extensions?: [{path, tools}] })` (`src/tools.ts:70-99`, max 16; empty `tools:[]` = lifecycle-only); default child has zero non-bridge extensions. Omitting blackhole from the job's `extensions:` keeps it out (expected posture: "bridge present + self absent").
- Blackhole detection: `PI_SUBAGENT_DEPTH > 0` (read at factory top-level); tool-shape (child has `subagent_send`+`subagent_wait`, lacks `subagent_spawn`/`subagent_inspect`); argv `--mode rpc` + `--no-session` + `-e …child-communication-bridge.ts…`.

## 6. Proposed builtin marker set (Tier 1 — always works, env only)

Non-empty value ⇒ subagent session. Identity markers (not parent-side config knobs):

```text
PI_SUBAGENT_CHILD
PI_SUBAGENT_PARENT_SESSION
PI_SUBAGENT_AGENT
PI_SUBAGENT_NAME
PI_SUBAGENT_SESSION
PI_SUBAGENT_SURFACE
PI_SUBAGENT_EXECUTION_BUDGET
PI_SUBAGENT_PROCESS_LEASE
PI_SUBAGENT_STEER_FILE
PI_SUBAGENT_HERDR
GENTLE_PI_AGENTS_CHILD
GENTLE_PI_AGENTS_OWNED_IPC (confirming, gentle-shell)
PI_SUBAGENT_DEPTH (narumiruna — persists; nesting guard, read at factory top-level)
```

Env present-but-unreliable (do NOT gate on these alone): `PI_SUBAGENT_BROKER_FD` / `PI_SUBAGENT_READINESS_FD` (deleted on import, visible only very early); `PI_SUBAGENT_HERDR` is reliable but herdr-path-only.

Deliberately excluded: `PI_SUBAGENT_TIMEOUT/IDLE_TIMEOUT/*_MINUTES`, `PI_SUBAGENT_DEADLINE/...` (parent-side config, not identity); `PI_SUBAGENTS_DEBUG`, `PI_CODING_AGENT_DIR/SESSION_DIR` (ambient); `PI_HERDSMAN_*`/`HERDR_*` alone (topology, keep as corroboration only); `GENTLE_PI_AGENTS_REQUESTED_TOOLS` (corroboration only).

Plus user-extensible `PI_BLACKHOLE_SUBAGENT_MARKERS` (comma-separated extra env names) for runners not yet surveyed.

## 7. Tier 2 — best-effort in-process heuristics (no env)

Evaluated only when Tier 1 is negative and the new knob is engaged. Any single positive ⇒ subagent (OR semantics), each fails closed on exception:

1. `session_start` event `reason === "fork"` (ESSO; nicobailon uses `"startup"` — do not generalize).
2. `parentSession` session-file header set and pointing at a different session file (nicobailon foreground, gotgenes).
3. Known in-process manager registries present AND own sessionId listed: `Symbol.for("pi-subagents:manager")` (tintinweb, ESSO variants) / gotgenes `Symbol.for()` service / `subagents:child:*` lifecycle events.
4. Loader extension paths/names match a known spawner (`pi-subagents`, `tintinweb-pi-subagents`, `pi-subagent`, `gentle-agents`, `pi-better-subagents`, `<inline:pi-subagents:…>`, `child-steer.ts`, `subagent-done.ts`) while the current session is not the carrier session.
5. `isPersisted() === false` **combined with** one of 1–4 or the bacnh85 settings combo (compaction disabled + `retry.maxRetries===1`) — never standalone.
6. Session-file location markers (persisted children): path under `<parent>.subagents/` + sibling `manifest.jsonl` (dnouri); first message contains `<subagent-context>` (dnouri); branch custom entries `pi-subagent:thread:v1` / `pi-subagent:registry:v1` with `rootSessionId` match (championswimmer).
7. Loader/tool-shape markers (detached opt-in children): `-e …child-communication-bridge…` + `subagent_send`/`subagent_wait` present without `subagent_spawn` (narumiruna); child inventory is builtins + allowlisted subset with the spawner absent via its own early-return (AlexParamonov-lite).
8. No-gating-needed postures (blackhole absent by construction — detection is parent-side confirmation only): pifydev/subagent (`noExtensions:true` unconditional); narumiruna default jobs (zero non-bridge extensions); championswimmer default (`subagentExtensions=false`).

`hasUI`, bare `isPersisted()===false`, session-name patterns, and worktree/sibling dirs are corroboration only.

## 8. Config knob sketch (to be iterated — NOT final)

- Candidate shape: `subagentMemory: "off" | "inherit"` (default `"off"`), or minimal boolean `disableMemoryForSubagents` (default `true`). Covers OM workers + OM injection; compaction in children keeps flowing to pi-native (`compactionEngine: pi-default` equivalent) rather than being forced off.
- Env: `PI_BLACKHOLE_SUBAGENT_MEMORY` (`off|inherit`, case-insensitive); extra markers `PI_BLACKHOLE_SUBAGENT_MARKERS` (comma list). File + settings-modal + env must agree (docs-consistency rule, §3.6).
- Precedence sketch (to confirm in design): explicit `PI_BLACKHOLE_MEMORY=false` ⇒ off everywhere (unchanged); Tier-1/2 positive + knob `off` ⇒ memory off for that session even if file says `true`; knob `inherit` ⇒ detection runs but does not gate (log-only); explicit `PI_BLACKHOLE_MEMORY=true` in a detected child ⇒ ??? (open: declarative map currently wins over passive — decide whether child-gate outranks it; Skelectric's double-set suggests users expect off to win).
- Gating points (per-event, no `runtime.config` writes): `maybeLaunchConsolidation` early return (`src/om/consolidation.ts:612-625` region) + `autoCompactionSkipReason` pi-default equivalence (`src/om/compaction-trigger.ts:87-102`) + status-bar O/P gauge suppression follows the existing `memory` gate. New `isSubagentSession(ctx)` helper (e.g. `src/core/subagent-detect.ts`), pure `(env, ctx)` ⇒ `{isSubagent, reason}` for testability and `debugLog("subagent.skip", …)` + one per-session info toast.

## 9. Deferred / rejected (for now)

- Docs-only alone (rejected as sole fix — doesn't change defaults).
- `--blackhole-om off` CLI flag (deferred — only helps flag-forwarding runners; env contract covers more).
- Subagent-optimized pipeline / downscaled thresholds (deferred — still burns tokens for a 1.35% hit rate; revisit if long-subagent use appears).
- Parent-side harvesting of subagent transcripts via project-recall corpus/orphan attribution (`src/project-recall/corpus.ts`) — noted as the async recovery path, not a substitute for stopping inline waste.
- `compaction: off` forcing in children (rejected sketch — children still benefit from pi-native compaction; gate OM, not compaction).

## 10. Verification sketch (to be iterated)

- Unit tests per AGENTS.md T1–T8 (red-first while writing, branch coverage incl. empty vs populated marker values, cleanup in finally/after-hooks, mocks matching real `ctx.sessionManager`/`loader` shapes, no `any` escapes): Tier-1 each marker; Tier-2 fork/registry/header/loader paths; negatives (plain inMemory session, unset/empty markers); precedence (inherit wins, explicit memory=false everywhere); per-event gating leaves `runtime.config` unmutated for the parent.
- Manual: `debugLog` on; one in-process runner (tintinweb or ESSO0428) + one detached runner (edxeth or gentle-shell); confirm `subagent.skip` with reason, zero observer/reflector/dropper calls in the child, parent pipeline unaffected; `/blackhole-memory status` surfaces skips.
- Docs check: `pnpm check` + README/CONFIG/llms.txt default parity.

## 11. Open questions (iteration entry points)

1. Knob name/scope: `subagentMemory` (OM-only) vs `subagentBehavior: off|memory-off|inherit` (also compaction)? Current lean: OM-only.
2. Does explicit `PI_BLACKHOLE_MEMORY=true` in a detected child outrank the child-gate? (Passive-vs-declarative ordering question from §1.)
3. Should Tier 2 be on by default, or Tier-1-only by default with Tier 2 opt-in (`PI_BLACKHOLE_SUBAGENT_MARKERS` / `subagentDetect: strict|lax`)? False-positive cost is a silently memory-less session.
4. Where does `isSubagentSession` get its `ctx` shape guarantee across pi versions (loader listing API, `session_start` reason values, `Symbol.for` registries are all unversioned)?
5. Do we need per-runner recipes in CONFIG.md immediately (option 3 docs, §1 workaround 1), or wait for the knob?
