# 05 · Phases

> **Owner's change of plan, 2026-11-11:** see the block at the top of `README.md`. It overrides
> this file wherever they disagree (no calendar waits, one `effect` branch shipped once at the
> end, no soak, drills or rollback rehearsals, one audit before the cutover, the go given in
> advance).


Ten phases. Phases 0 and 1 change the old code and ship to production like any other change
(prepared on their own branches, then landed on `main`). Phases 2 to 8 happen on the `effect`
branch and reach only the test bot. Phase 9 is the cutover. `RUN.md` §3 has the branch for each
phase and what may overlap.

Sizes are rough guides, in units of "one long working session"; they are not deadlines and not
stopping points. The run is continuous (`RUN.md`): when a phase's exit criteria and its audit
are met, the next phase starts.

| # | Phase | Where | Size |
|---|---|---|---|
| 0 | Baseline and preparation | `main`, ships | 2 |
| 1 | Drizzle 1.0 under the old code | `main`, ships | 1 |
| 2 | Toolchain and spikes | `effect` | 1–2 |
| 3 | Foundations | `effect` | 2–3 |
| 4 | Feature services | `effect` | 4–6 |
| 5 | Entry points, lifecycle, removing the old stack | `effect` | 3–4 |
| 6 | Tests become Effect-native | `effect` | 2–3 |
| 7 | Hardening and observability | `effect` | 2 |
| 8 | Test bot: QA, drills, soak | `effect` | 2, plus 48 h of waiting |
| 9 | Cutover | `main` | 1 |

**Production fixes while this runs.** Fix on `main` in the old style, with a test. If the fix
changes recorded behaviour, regenerate the affected recordings on `main` in the same commit.
Merge `main` into `effect` the same day. If the module is already migrated, port the fix to its
Effect version by hand; the merged recordings must pass on the branch.

---

## Phase 0 · Baseline and preparation

On the `effect-prep` branch, in the old style. No Effect yet. Steps 1, 2, 3, 5 and 6 can start
at once. Steps 4 and 7 (the baseline) and step 8 wait until plan 02 (the news channel, still in
progress on 2026-11-11) is on `origin/main`; rebase onto it first, so the baseline includes it
(`RUN.md` §3).

1. **The assertion ledger first.** Write `scripts/assertions.mjs` and commit the ledger, before
   touching any test file.
2. **One shared test harness.** Move the five copies of the setup (throwaway schema, the
   `fetch` stub, the fixed clock, table cleanup) into `test/harness.ts`. Per-test stub overrides
   stay possible. The ledger must be identical afterwards.
3. **Remove the import cycles by moving code** (`architecture.md` §4): the local-time helpers,
   the players helper, the game-list functions and the night-row readers out of `gamenight.ts`;
   `late.ts` split into attendance data and late slips; the "list channels over REST" fallback
   out of `channels.ts`. Moves only: no logic edits, no renames beyond the file. Add an
   import-cycle check to `scripts/leftovers.mjs`; it must report none.
4. **The recorder** in the harness, made deterministic, run three times, recordings committed
   (`verification.md` §2a).
5. **Real Discord errors** captured from the test bot into fixtures (`verification.md` §2d), and
   tests added that feed each fixture through today's string matchers, proving the fixtures are
   the cases the code handles.
6. **The remaining scripts** (`leftovers.mjs`, `soak_watch.py`), each with its self-check.
7. **Numbers**: tests, query sites, every live QA suite on the test bot, tap timings, memory.
   Into `STATUS.md`.
8. ~~Ship it~~ (owner, 2026-11-11: nothing ships before the cutover; phase 0 stays on `effect`).

**Exit:** tests, ledger, recordings and query coverage green on `main`; recordings identical over
three runs; numbers recorded; production running this commit for one evening. (Phase 1's branch
work starts as soon as phase 0 has landed; only phase 1's own landing waits for that evening.)

## Phase 1 · Drizzle 1.0 under the old code

On the `drizzle-1` branch, still promise-style. The point is to put the riskiest dependency
into production on its own, weeks before the cutover, where a problem is easy to attribute.

1. Pin `drizzle-orm` and `drizzle-kit` to the newest 1.0 release (rc.5 on 2026-11-11; use a newer
   release candidate or the final release if one exists, and note which).
2. Convert the migrations folder with `drizzle-kit up`. Adapt `db/index.ts` to the 1.0 API, still
   on the `node-postgres` driver. Adapt the harness (it applies the migration SQL files itself)
   and `drizzle.config.ts`. Confirm the image still contains the folder the migrator reads.
3. All gates. The recordings and the query count must be identical: the upgrade changes no
   behaviour.
4. Deploy the branch to the test bot only. Run `qa_all.py` and `qa_timing.py`.
5. ~~**Rehearse going back:**~~ (removed by the owner, 2026-11-11) deploy the previous `main` commit over it on the test bot. The old
   migrator must start cleanly although 1.0 has added two columns to the migrations table, and
   `qa_all.py` must pass. Deploy the branch again.
6. ~~Land it on `main`~~ (owner, 2026-11-11: it stays on `effect`; one test-bot deploy proves it).
7. Tag the commit `pre-effect` (no waiting for an evening). It is the last old-style commit and
   the rollback target. (The `effect` branch is cut from this commit right after it lands;
   phase 2 doesn't wait for the tag.)

**Exit:** production has run on Drizzle 1.0 for one game night; the tag exists.

**Stop and report if** any query returns something different, or the old code can't start after
the new migrator has run. The options are then the owner's (wait for the final release, or
another route).

## Phase 2 · Toolchain and spikes

On `effect`, cut from the phase 1 commit.

1. Install the Effect packages (`architecture.md` §1), the language service, the `tsconfig`
   plugin and the `prepare` patch. Set the severities (`verification.md` §3). Prove G1 works:
   a throwaway file with a floating Effect must fail `npm run check`.
2. Read `node_modules/effect/AGENTS.md` and every example under `ai-docs/src/` for: basics,
   services, errors, resources, running, PubSub, managed runtime, schedules, DateTime,
   observability, testing, SQL, HTTP client, HTTP server basics.
3. **Spikes.** Throwaway code in `bot/spikes/` (outside the build). Each answers one question
   with a pass or a fail, written to `spike-report.md` in this folder with the evidence.

| # | Question | Passes when |
|---|---|---|
| S1 | Does Drizzle's Effect driver on `PgClient` do everything the bot's queries need? | select / insert / update / delete with `returning` and `onConflict…`; raw `sql` aggregates; `bigint` columns and aggregates arrive as numbers; `jsonb` and `citext` round-trip; a transaction commits, and rolls back on a typed failure, on a defect and on interruption; a test schema can be selected per pool (`startupOptions` with `search_path`); `statement_timeout` reads back as `30s`; each statement gets a span |
| S2 | Can the leader lock live on a dedicated connection? | the lock holds across statements; a second runtime can't take it; closing the scope releases it; killing the backend is noticed, and how fast is measured (this sets the ping interval) |
| S3 | Do migrations run through the Effect migrator under our advisory lock? | two starters at once: one migrates, the other waits and finds nothing to do |
| S4 | Does `HttpRouter` on `NodeHttpServer` cover the HTTP contract? | raw body text and headers readable; Ed25519 verification passes and fails correctly; an oversized body is refused; a dying handler gives a controllable 500; on shutdown an in-flight request finishes and new ones are refused; `toWebHandler` works in a test without a port |
| S5 | How does `FetchHttpClient` behave under test and under timeouts? | whether a replaced `globalThis.fetch` is seen per request or captured once (decides how phase 3's harness feeds the stub); a timeout and an interruption both abort the underlying request |
| S6 | Do per-call overrides travel? | a `Context.Reference` provided around a call is seen by a fiber started through `FiberSet.run` inside that call, after an `Effect.sleep`, and by a `FiberHandle` timer. Where one isn't, the service captures the override explicitly, and `architecture.md` §7 is amended |
| S7 | How do `TestClock` and a real database mix? | an `it.effect` test runs real queries, and a sleep in the code under test is advanced by `TestClock.adjust`; a helper "run this, advancing time until it finishes" exists and never hangs; `TestClock.setTime` moves `DateTime.now` |
| S8 | Does an uninterruptible region hold? | an interrupt sent during "post, then record" lets both finish and takes effect after |
| S9 | Can old and new code share one set of services during the transition? | promise code calling Effect through a `ManagedRuntime`, and Effect calling promise code, see the same `Presence` state |
| S10 | What do logs look like? | one line per entry with annotations, readable through `app-logs`; a `Redacted` value prints as redacted |

4. Where a spike disagrees with `architecture.md` and there is a sound local answer, amend
   `architecture.md` in the same commit and note it in `STATUS.md`. The plan files are living
   documents; a silent deviation is not allowed.
5. Delete `bot/spikes/`. Keep the report.

**Exit:** G1 configured and proven; the report written; `architecture.md` agrees with reality.

**Stop and report if** S1, S2 or S3 fails without a sound answer.

## Phase 3 · Foundations

New services go in; old modules keep their exported functions, now as thin delegates. The whole
old test suite, untouched except for setup, then runs against the new foundations. That run is
the proof that the foundations behave like what they replace.

Temporary interop code is marked `// LEGACY-BRIDGE` on every line that exists only for the
transition. G6 counts the marker; phase 5 deletes every one.

In order, one commit each, using the loop in `verification.md` §5:

1. **The bridge.** `runtime.ts` (the app layer and one `ManagedRuntime`) and `legacy.ts`: `run`
   for promise code that needs to call an Effect, and a `LegacyEnv` service so Effect code can
   call a function that still takes `env`. The harness builds the runtime per test file with test
   config and the throwaway schema.
2. **`AppConfig` and `Overrides`.** The old `Env` object is still built, from `AppConfig`.
   Tests 1, 2 and 5 (`verification.md` §7).
3. **Logging.**
4. **`Db`.** `PgClient` plus the Drizzle Effect database; migrations through the Effect
   migrator. The old `env.db` pool stays for modules not yet moved (two pools during the
   transition, both on the same schema in tests). Update `scripts/qcov.py` to count both query
   forms; the total must equal the baseline.
5. **`Channels`, then `Discord`.** Typed endpoints, response schemas, the error classes, the
   retry schedules, the interaction webhooks. The old `api`, `followup`, `editOriginal`,
   `originalMessage` and `isNotFound` become delegates that turn the typed errors back into
   today's error text, so old callers that match text keep working. Tests 3 and 4.
6. **`Alerts`, `Background`, `Presence`, `Lifecycle`.** Old functions delegate.

Then deploy the branch to the test bot and run `qa_all.py` and `qa_timing.py`: the first live run
with Effect underneath.

**Exit:** all gates; recordings identical; the two QA suites equal to baseline.

## Phase 4 · Feature services

One module per commit, bottom-up along the layer list in `architecture.md` §4, with the loop in
`verification.md` §5 and the break-it check in §6 for each:

1. `LocalTime`, `Games`, `Nights`, `Attendance`, `Memes`, `Roasts` (with `Random`), `Panels`
   (test 7), `Gemini`
2. `Snooze`, `Voice` → deploy to the test bot, `qa_rooms.py`
3. `Spontaneous`, `Reddit`, `News` → deploy, `qa_spontaneous.py`
4. `GameNight`, in several commits because it is 1,600 lines: the readers and small helpers; the
   card's lifecycle (`startNight`, `retryUnposted`, `closeStale`, `refresh`); `act`, the vote
   state machine; `maintain`, deadlines and roasts; the start (`startOnTime`, `claimStart`,
   `startReminder`). `render` and the builders stay pure functions. Test 6 arrives with the first
   claim → post → record sequence. → deploy, `qa_all.py`, `qa_timing.py`, `qa_leaveby.py`,
   `qa_slowpoke.py`
5. `LateSlips`, `Polls`, `Activity`, `Hub`, `Cleanup`, `MemeShame` → deploy, `qa_late_ui.py`,
   `qa_stats.py`

Then a second pass, in separate commits, module by module, still under the gates: `Match` with
exhaustive cases where a stage, an action or a choice is compared as a string today; every
translated `Promise.all` given its explicit concurrency; every delay given a named `Duration`.

**Exit:** only `interactions.ts`, `app.ts`, `jobs.ts`, `scheduler.ts`, `live.ts`, `gateway.ts`,
`main.ts` and the leader lock are still promise-style.

## Phase 5 · Entry points, lifecycle, and removing the old stack

1. **Jobs.** The runner gives each job a span, catches everything a job lets through, reports it
   with today's wording (`the “<name>” job`), and returns the same result map.
2. **Interactions.** The payload schema, the `custom_id` union, the `Match`.
3. **HTTP.** `HttpRouter`; Fastify removed; tests call the web handler. Test 13.
4. **`Ticker` and start timers.** Tests 8 and 9.
5. **`Live`**, on a queue, with `Presence` publishing changes. Test 10.
6. **`Gateway`** as a scoped resource.
7. **`Leadership`, `main`, shutdown.** Tests 11, 12 and 14.
8. **Delete the transition.** `legacy.ts`, every `LEGACY-BRIDGE` line, the `Env` type, the old
   pool, every `_reset` hook (the harness gives each test fresh state by building the state
   services fresh), and the dependencies `fastify`, `pg`, `@types/pg`. Flip the warning-level
   diagnostics to errors (`verification.md` §3).
9. Deploy to the test bot and run every live QA suite (`verification.md` §9). This is the first
   complete run of the all-Effect bot.

**Exit:** items 1 to 4 of "done" in the README hold; G6 is zero outside the boundary files; every
QA suite equals its baseline.

## Phase 6 · Tests become Effect-native

`src` is frozen (`verification.md` §1).

1. **The harness becomes layers:** a throwaway-schema database layer; a fake Discord at the
   `HttpClient` level, so the real `Discord` service code (retries, decoding, error mapping)
   stays under test, with per-test handlers and the recorder; a `Background` that tests can wait
   on; a test config.
2. **Convert the files one at a time:** `test(…)` → `it.effect(…)`, the fake `Date` →
   `TestClock.setTime`, `await run(x)` → `yield* x`. Keep `expect`: the ledger must stay
   identical, and so must the recordings.
3. **Remove** `vi.useFakeTimers`, the `globalThis.fetch` stub and the `console` spies (a test
   logger captures entries instead; the expected strings stay as they are).
4. **Add test group 15**: the time-driven behaviour that only live QA could check before.

**Exit:** item 5 of "done" holds.

## Phase 7 · Hardening and observability

1. **Interruption audit.** Walk the list in `architecture.md` §15 region by region. Each kind is
   uninterruptible and covered by test 6 or 8.
2. **Job timeouts** (test 16). Read the longest job times from production's `minute … ms` log
   lines; set each job's limit at five times the longest seen, and not under 60 seconds. The
   Reddit refill and Gemini already run in the background with their own limits.
3. **Read the traces.** On the test bot, follow one tap, one minute and one game-night start end
   to end through logs and spans. Fix missing names and annotations. Add the metrics and the
   OTLP layer behind `OTLP_URL` (`architecture.md` §14).
4. **Read every service interface's declared errors** and ask of each caller: does it do
   something deliberate with each one? Collect the places that only log or alert when Discord
   says a recorded thing is gone or refused, under "Found on the way".
5. **Rewrite the docs for the new world:** `bot/README.md`, and the house rules in
   `docs/plans/README.md` (how to add a service, a job, a test; how failures are reported; the
   gates). Plans 02 and 03 get a note that new work is Effect-native.

**Exit:** all gates, with the new tests.

## Phase 8 · Test bot: QA, drills, soak

Owner, 2026-11-11: only the live QA remains: `qa_all.py`, `qa_timing.py`, `qa_rooms.py`,
`qa_stats.py`, `qa_spontaneous.py` on the test bot, plus the browser tap if Discord is logged in.
No drills, no soak, no rollback rehearsal, no question to the owner; then phase 9 at once, under
the house deploy checks (nobody in voice, no night about to start; else retry in 30 minutes).

`verification.md` §8 (fault drills), §9 (live QA and the browser tap), §10 (the 48-hour soak) and
the rollback rehearsal in §11. Every result goes into `STATUS.md`.

**Exit:** everything in those sections passed; the owner has the summary and has been asked for
the go (`RUN.md` §10).

## Phase 9 · Cutover

`verification.md` §11. Afterwards:

- delete the `effect` branch; keep the `pre-effect` tag
- update the memory file `meme-bot-project.md`: the stack, the gates, the rules that changed
- mark this plan shipped in `docs/plans/README.md`
- give the owner the "Found on the way" list, sorted by how much each item could hurt the trio
