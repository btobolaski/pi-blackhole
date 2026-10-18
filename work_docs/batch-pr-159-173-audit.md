# PR #159–#173 integration audit

Validated code revision: `806b6fdbeb4ac500ddd2dfe13e6257579393d787`. Baseline: `8ac87dd3922ad79c3f69de37ab26542ff558ff0f` (current `origin/dev`, including Dependabot #176).

All fifteen pinned original contributor commits are merge ancestors. No contributor branch was rebased or rewritten. #149 and #158 were excluded. The original dev working tree is unchanged. This staging branch is intended for one normal merge into dev after human review; do not squash away contributor ancestry.

[Exact pinned heads, bases, changed files, original commits and merge SHAs](batch-pr-159-173-snapshot.json) are recorded separately. PR bodies, discussion/inline reviews and issue #175 were checked as context; their claims were independently validated. Four GPT-6 Luna reviewers at High reasoning handled isolated workstreams; integration remained centralized.

## Ledger

| PR                                                       | Final classification | Original head | Integration merge | Pinned focused tests | Review result / correction                                                                             |
| -------------------------------------------------------- | -------------------- | ------------- | ----------------- | -------------------- | ------------------------------------------------------------------------------------------------------ |
| [#159](https://github.com/k0valik/pi-blackhole/pull/159) | ACCEPT               | `7010923`     | `82f0d30`         | 60 passed            | Later Pi cut retained in single-prompt minimal windows.                                                |
| [#160](https://github.com/k0valik/pi-blackhole/pull/160) | ACCEPT_WITH_FIX      | `45dc7fd`     | `5b2b2de`         | 40 passed            | Valid unknown-source fixture/control and combined cut/supersession tests.                              |
| [#161](https://github.com/k0valik/pi-blackhole/pull/161) | ACCEPT               | `fc68511`     | `3576d34`         | 38 passed            | Admit pre-boundary reflection evidence; preserve maintenance boundary.                                 |
| [#162](https://github.com/k0valik/pi-blackhole/pull/162) | ACCEPT_WITH_FIX      | `2630258`     | `0ec6aee`         | 76 passed            | Manual pending worker context fix 82e9815; later-source fixture f2f53e9; cross-boundary tests 86d46a6. |
| [#163](https://github.com/k0valik/pi-blackhole/pull/163) | ACCEPT               | `3dcdf59`     | `c9bf563`         | 46 passed            | Prompt allows full current-fact corrections; no new calls or schema.                                   |
| [#164](https://github.com/k0valik/pi-blackhole/pull/164) | ACCEPT_WITH_FIX      | `8d9eee2`     | `6809f7d`         | 90 passed            | Visible projection option threaded in 0ce3cb2; default remains false.                                  |
| [#165](https://github.com/k0valik/pi-blackhole/pull/165) | ACCEPT_WITH_FIX      | `19512ec`     | `c8493bc`         | 33 passed            | Cancellation authoritative, opaque preview status lines, eight-item merge cap: 6f4945a.                |
| [#166](https://github.com/k0valik/pi-blackhole/pull/166) | ACCEPT               | `7fa7c20`     | `5313c76`         | 64 passed            | Prompt/serialization checked; live-model compliance not established.                                   |
| [#167](https://github.com/k0valik/pi-blackhole/pull/167) | ACCEPT               | `8db7fcf`     | `cbcacd9`         | 103 passed           | Turn caps skip in-cycle; no persistent cooldown or coverage advance.                                   |
| [#168](https://github.com/k0valik/pi-blackhole/pull/168) | ACCEPT               | `3a24675`     | `b9395f3`         | 128 passed           | Local errors and active aborts skip in-cycle; provider/network controls preserved.                     |
| [#169](https://github.com/k0valik/pi-blackhole/pull/169) | ACCEPT               | `e77f4de`     | `4b16504`         | 98 passed            | Persistence-owner diagnostics remain sanitized; only successful writes log.                            |
| [#170](https://github.com/k0valik/pi-blackhole/pull/170) | ACCEPT               | `8372d6f`     | `bf72b3d`         | 98 passed            | Unsplittable output-length skips combine with turn-cap guard.                                          |
| [#171](https://github.com/k0valik/pi-blackhole/pull/171) | ACCEPT               | `b391c80`     | `5bfe5bb`         | 150 passed           | Request-local plus local predicates and persistence diagnostics combined.                              |
| [#172](https://github.com/k0valik/pi-blackhole/pull/172) | ACCEPT_WITH_FIX      | `c71d0ad`     | `9096ce1`         | 156 passed           | Reconciled with #173; shared stale-cursor fix 015d9b2 and docs placement.                              |
| [#173](https://github.com/k0valik/pi-blackhole/pull/173) | ACCEPT_WITH_FIX      | `5deec73`     | `3f44b38`         | 157 passed           | Reconciled both policy gates, candidate OM boundary, source continuity; stale cursor 015d9b2.          |

The final ACCEPT classifications for #167–#171 include successful semantic reconciliation. #160 has a test-fixture correction rather than a production implementation fix. The cursor fix applies to the shared preservation helper used by both #172 and #173. None were deferred or rejected.

## Reconciliation and corrections

- Landing order: 159 → 160 → 161 → 165 → 166 → 167 → 170 → 169 → 168 → 171 → 162 → 163 → 164 → 172 → 173. Independent work landed while the manual supersession repair was being completed. Every original contribution has its own merge commit.
- Cut-aware observation/reflection eligibility and both supersession passes coexist. The #162 outside-boundary fixture originally cited earlier evidence; #160 correctly admitted that evidence. Commit f2f53e9 gives that one test a genuinely later source. Commit 86d46a6 adds explicit before/after/missing-source and maintenance-boundary intersections, and repairs #160’s invalid-batch test control. Whole-covered-batch compatibility remains unchanged.
- `6f4945a`: five new assertions failed before the questionnaire correction. Structured cancellation is authoritative; preview/skipped status lines cannot overwrite answers; numbered questions require a supported boundary; repeated compactions retain eight decisions. Seven added regression cases and the adjacent suites pass.
- `82e9815`: a new manual-mode worker-context regression failed before replacing the three pending observation merges with the existing active-pool helper. Observer/reflector/dropper inputs now consistently omit retired pending facts.
- `0ce3cb2`: a new visible-projection regression failed before threading reflection retirement through visible memory commands and explicit-boundary projections. Default-off behavior remains.
- Cooldown reconciliation combines turn-cap and unsplittable output-length branches, local/request predicates, active abort handling, and persistence-owner diagnostics. Auth, missing-model and provider/network failure controls remain covered. No temporary size/local/request rejection advances coverage or becomes a model-wide cooldown.
- #172/#173 share source-history intent, safe tool cuts and completed-coverage helpers. Reconciliation retains both configuration gates, both cancellation paths, raw-tool-output protection, final/append capacity checks, and an OM candidate boundary matching the final unobserved projection. #159’s minimal-tail correction remains intact.
- `015d9b2`: the stale-cursor regression also failed on the cumulative branch (received m2/m3 instead of m3). Preservation mode now starts after the later of recorded coverage and a valid source cursor.
- `d130820`: production-only installation of the original built package failed with ERR_MODULE_NOT_FOUND for typebox. Move the same 1.3.37 version to dependencies; only the lockfile importer changes. No versions were upgraded. A separately packed final artifact installs and imports successfully with devDependencies omitted and hoisting disabled.
- `94b2900` reconciles the changelog, moves feature documentation out of License, clarifies partial-projection provenance and the UI’s new tail choice. `806b6fd` applies the current formatter to the new regression fixture.

## Validation

Environment: Linux, Node 26.1.0, pnpm 12.10.0. After setup repair, reviewer cumulative runs used the original PR lockfile (Pi 1.1.0 / Vitest 5.0.3); the final branch uses the current dev lockfile (Pi 1.3.0 / Vitest 5.0.5). `PI_CODING_AGENT_DIR` was unset for tests. Initial shared-dependency interference was eliminated by installing private, exact lockfiles; final gates used an independent real node_modules directory. Git hooks were bypassed during isolated merges to prevent implicit installs; their checks were run explicitly.

| Gate / workstream                                                   | Result                                                                                                                    |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Clean dev baseline: build, verify, format:check                     | Passed; 2,797 tests                                                                                                       |
| Compaction cluster on cumulative branch                             | 106 tests passed                                                                                                          |
| User decisions on cumulative branch                                 | Focused original, parser and observer regressions passed                                                                  |
| Cooldown cluster on cumulative branch                               | 198 tests passed                                                                                                          |
| Supersession plus boundaries and adjacent worker/command paths      | 370 tests passed                                                                                                          |
| Features plus decisions, source continuity and boundary regressions | 273 tests passed                                                                                                          |
| pnpm build                                                          | Passed; ESM bundle produced                                                                                               |
| pnpm verify                                                         | Passed: source typecheck, lint, format check, 3,007 tests in 158 files                                                    |
| pnpm format:check                                                   | Passed, including scripts                                                                                                 |
| Packed production artifact                                          | Installed with --prod --ignore-scripts and hoist:false; real bundle import exposes extension factory                      |
| Scope/provenance audit                                              | All 15 original SHAs are ancestors; baseline is ancestor; no unrelated contributor commits or dependency snapshot changes |

The first final gate attempt caught one formatting difference between the old and updated formatter; it was fixed and verify plus format:check passed afterward. Earlier failing assertions and repairs are recorded above; no test failures remain. Full repository gates were run outside the restricted subprocess sandbox, matching the project’s Git/Node-spawning tests. Tests under tests/ remain intentionally outside the source tsconfig, per AGENTS.md.

## Limits and follow-up

- Question-tool support is limited to the documented ask_user_question structured/text contract. Text fallback remains format-dependent; it is not a universal parser for arbitrary question tools. Notes on unselected options remain outside this PR’s extractor. The requested follow-up will inspect 5–8 widely used Pi question extensions and define explicit adapters/maps.
- Prompt and ledger tests prove behavior given a supersession link or answer, not that a live model will always infer the right link or interpret an answer correctly. No live-model evaluation was performed.
- Partial straddling projections fail closed on missing evidence. Once a whole recorded batch is covered, the existing whole-batch inclusion rule remains trusted; this batch does not redesign legacy provenance.
- Context estimates include the tested summary/raw/system costs, but provider-specific framing and tool schemas can still overflow. Unsafe or unknown capacity cancels the opt-in paths.
- The optional unobserved/pressure selectors can scan long histories repeatedly. The existing inline performance concern is retained as a scaling follow-up; no broad selection algorithm redesign is included.
- Local validation used Node 26; the PR’s normal CI also targets Node 22. Bot/CI results will be checked in the next session, as requested. Do not update dev or close original PRs before final human approval.
