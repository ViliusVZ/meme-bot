# 05 · How the migration proves itself

The migration rewrites the code and the tests that guard it. That is the main danger: a test
suite that is being rewritten can't vouch for the code being rewritten at the same time. This
file is the answer to that.

All commands run in `bot/` (Git Bash), with the database tunnel open.

## 1. The principle: never change code and its checks in the same step

| Phase | What changes | What stays fixed and judges it |
|---|---|---|
| 0 (old code, `main`) | test harness, module boundaries | every assertion; then the recordings are taken |
| 1 (Drizzle 1.0, `main`) | the database library under the old code | every test, assertion and recording, untouched |
| 2–5 (code moves to Effect) | `src`, and in tests only *how* a function is called | every assertion (§2b), every recording (§2a) |
| 6 (tests move to Effect) | test setup, wrappers, the clock | `src` (frozen), every assertion, every recording |
| 7 (hardening) | `src`, new tests | all earlier tests and recordings |

In phases 2–5 a diff to a test file may touch imports, setup, and the call expression
(`await gn.act(env, …)` → `await run(GameNight.use((s) => s.act(…)))`). It may not touch what is
asserted. In phase 6 a diff to `src` is allowed only to fix a bug a converted test exposed, and
only with a test that fails without the fix.

## 2. The baseline, taken from the old code in phase 0

The last old-style commit (the end of phase 1) is tagged `pre-effect`. It produces the same
recordings as the phase 0 baseline, and every baseline artifact can be regenerated from it.

**a. Recordings.** For every test, the harness records what the bot *did*, independent of what
the test asserts:

- every outbound HTTP request in order: method, full URL, a hash of the JSON body
- the database when the test ends: per table, the row count and a hash of all rows ordered by
  primary key, leaving out the migrations table and the three columns that take the database's
  own `now()` (`architecture.md` §10)

One file per test file under `test/__recordings__/`, keyed by test title, committed. Hashes keep
the files small (the Maybe matrix alone is 401 cases). To see *what* differs when a hash does,
run the same test with `RECORD=full` at the `pre-effect` tag in a `git worktree` and on the
branch, and diff the two full dumps (written to a gitignored folder).

The recordings must be deterministic before they are trusted. In phase 0: reset the stub's id
counter per test, seed `Math.random` per test, run the suite three times, and confirm the
recordings are byte-identical each time. Any test that isn't stable gets fixed (in the harness,
not by excluding it) before the baseline is committed.

Two things will legitimately need care later, and nothing else:

- **Order inside a concurrent group.** Where the code fans out (`Promise.all` today), the order
  of the calls may change. For those groups only, the harness may sort the calls before hashing.
  Each such group is declared by name in the harness with a comment, and listed in `STATUS.md`.
- **Randomness.** The roast shuffle must consume random numbers in the same order as today, so
  the test `Random` layer can replay the baseline's seeded sequence.

**b. The assertion ledger.** A script walks the test files with the TypeScript compiler API and
writes, per test title, the ordered list of matcher calls with the source text of their
arguments (`.toBe(401)`, `.toEqual({ ok: true })`, …). The ledger is committed. It must be
identical after every later commit. Tests may be added; an existing test's assertions may not
change, shrink or be reordered. A change that is truly needed (an intended difference from the
README list) is made in its own commit, with the reason, and listed in `STATUS.md`.

**c. Numbers.** Recorded in `STATUS.md`: tests passed, query sites found and executed
(`scripts/qcov.py`), the result line of every live QA suite on the test bot, the median and
95th-percentile handling time of taps during `qa_all.py` (from the `interaction <ms> ms` log
lines), and the container's memory after an hour.

**d. Real Discord errors.** For every place the old code matches error text, capture Discord's
actual response from the test bot (status and JSON body) into `test/fixtures/discord-errors/`:
an unknown voice state, an unknown channel, an unknown message, an event that was already ended
(the `INVALID_END_BY_STATUS` case), an edit to an expired interaction token, a rate limit. The
typed error model is built from these, not from memory of Discord's documentation.

## 3. The gates

Run all of them before every commit on the branch. A commit with a red gate doesn't happen.

| Gate | Command | Passes when |
|---|---|---|
| G1 Types | `npm run check` | no TypeScript errors and no Effect diagnostics at error level. TypeScript is patched by `effect-language-service patch` (in the `prepare` script), so plain `tsc` reports them |
| G2 Tests | `npx vitest run --coverage --coverage.reporter=json` | all pass; none skipped, `todo` or `only`; the count is at least the last count in `STATUS.md` |
| G3 Queries | `python scripts/qcov.py` | every query site is executed, and the number of sites equals the baseline (a difference is explained in `STATUS.md`) |
| G4 Recordings | part of G2 | no recording differs (`git status` shows `test/__recordings__` untouched) |
| G5 Assertions | `node scripts/assertions.mjs --check` | the ledger is identical |
| G6 Leftovers | `node scripts/leftovers.mjs` | counts never go up; the final phase requires zero outside the boundary files |
| G7 Build | `npm run build` | compiles; at each test-bot deploy named in `phases.md`, the image also builds and `/bot-dev/health` answers ok with the new version |

**G1 configuration** (in `tsconfig.json`, the `@effect/language-service` plugin's
`diagnosticSeverity`). Errors from the first Effect commit on: `floatingEffect`,
`missingStarInYieldEffectGen`, `missingReturnYieldStar`, `missingEffectContext`,
`missingEffectError`, `missingLayerContext`, `outdatedApi`, `anyUnknownInErrorContext`,
`globalErrorInEffectFailure`, `globalErrorInEffectCatch`, `unknownInEffectCatch`,
`effectInVoidSuccess`, `effectInFailure`, `tryCatchInEffectGen`, `runEffectInsideEffect`,
`multipleEffectProvide`, `scopeInLayerEffect`, `lazyPromiseInEffectSync`, `classSelfMismatch`,
`unsafeEffectTypeAssertion`, `deterministicKeys`.

Warnings while old code still exists, flipped to errors at the end of phase 5: `asyncFunction`,
`newPromise`, `globalConsole`, `globalConsoleInEffect`, `globalDate`, `globalDateInEffect`,
`globalFetch`, `globalFetchInEffect`, `globalTimers`, `globalTimersInEffect`, `globalRandom`,
`globalRandomInEffect`, `processEnv`, `processEnvInEffect`, `strictEffectProvide`,
`extendsNativeError`, `preferSchemaOverJson`, `schemaSyncInEffect`.

A diagnostic may be switched off with an `@effect-diagnostics` comment only in a boundary file
(`architecture.md` §16), with the reason on the same line.

**G6 counts**, per file, what the diagnostics don't: `async`, `await`, `.then(`, `.catch(`,
`try {`, `AbortController`, `AbortSignal`, `: any`, `as any`, `_reset`, `LEGACY-BRIDGE` (the
marker on temporary interop code, see `phases.md`), `Effect.promise`, `Effect.tryPromise`,
`runPromise`, `runFork`, `Effect.orDie`, `@effect-diagnostics`, `@ts-`. It prints a table and
writes it to `STATUS.md`'s numbers block.

## 4. Scripts to write (phase 0)

| Script | Does |
|---|---|
| `test/harness.ts` | The one shared test setup: throwaway schema, the HTTP stub with per-test handlers, the fixed clock, the seeded random, table cleanup, the recorder. Replaces the five copies in the test files |
| `scripts/assertions.mjs` | Writes and checks the assertion ledger (§2b) |
| `scripts/leftovers.mjs` | G6 |
| `scripts/qcov.py` | Exists. Its pattern is updated when the query form changes (phase 3), and the count must hold |
| `scripts/soak_watch.py` | Polls the test bot's `/health` every 30 s and logs anything off (§10) |

Each script gets a self-check: break one thing on purpose (change an assertion, delete a call,
add an `await`) and confirm the gate goes red. A gate that has never been seen failing is not a
gate.

## 5. The loop for each module (phases 3–5)

1. Read the module, its tests, and every caller. List its `catch` sites, timers, module state and
   Discord calls.
2. Translate it into its service. Same functions, same order of side effects, same queries.
3. Callers already on Effect call it directly; callers still on promises go through the
   temporary bridge.
4. Change only the call expressions in its tests.
5. Run G1–G7.
6. Break it on purpose (§6).
7. Read your own diff against this checklist:
   - every old `catch` and `.catch` is accounted for: which errors it now handles by tag, or
     which boundary now owns it. Put this as a small table in the commit message.
   - nothing that used to be awaited is now floating, and nothing that ran in the background now
     blocks a reply to Discord (the 3-second limit)
   - every claim → post → record region is uninterruptible (`architecture.md` §15)
   - no value that must follow a per-call override is captured in the layer
   - the comments that explain *why* came across
8. Commit. Add one line to `STATUS.md`.

## 6. Break it on purpose

After a module is green, make three temporary changes, one at a time, and confirm each turns a
test or a recording red. Then undo them.

1. Skip one database write.
2. Make one error handler take the wrong branch (treat "already gone" as a failure, or a failure
   as "already gone").
3. Swap the order of two side effects (post before claim, or record before post).

If a change stays green, the module has a hole in its tests. Add the missing test first (it must
pass on the unbroken code and fail on the broken one), then continue. Record in `STATUS.md` which
three changes were tried per module.

## 7. Tests the migration must add

These cover what Effect makes newly possible to get wrong, and what it makes newly possible to
test. Each must be seen failing once (by breaking the code) before it counts.

| # | Test | Phase |
|---|---|---|
| 1 | A quiet admin call that defers a ping sends it with no mentions (overrides reach background work) | 3 |
| 2 | Stand-in players given to an admin call are the players deep code sees; the real players' rows are untouched | 3 |
| 3 | Each captured Discord error (§2d) becomes the right typed error; a 403 whose path contains `10065` is not "not in voice" | 3 |
| 4 | Retry rules: a POST that gets a 5xx or a network error is sent once; a GET is tried 4 times with the stated back-off; a 429 waits `retry_after` (capped); a hung call times out at 10 s. Driven by `TestClock` | 3 |
| 5 | Config: all missing variables are named in one message; a secret never appears in logs or in `String(config)` | 3 |
| 6 | Interrupting a claim → post → record sequence at each step leaves either nothing done and no claim, or everything done. Never a released claim with a sent post | 4 |
| 7 | Two syncs of one card run one after the other; syncs of two cards run together | 4 |
| 8 | A start timer interrupted while sleeping claims nothing; interrupted after its claim, it finishes | 5 |
| 9 | The ticker never fires early, never overlaps a slow minute, catches up once at start, and its watchdog reports once at 5 minutes (new tests beside the fake-timer ones in `resilience.test.ts`, which keep their assertions) | 5 |
| 10 | Voice events are handled in order; one failing event alerts and the next is still handled; a replaced timer never fires; a room's wrap-up fires at exactly its grace period | 5 |
| 11 | Leadership: of two runtimes on one database exactly one leads; when its lock connection is killed its term ends, everything in the term stops, and the other takes over | 5 |
| 12 | Shutdown runs its five steps in order (`architecture.md` §13), background work gets its 20 s, and the pool closes last | 5 |
| 13 | The HTTP contract, route by route: status and body for the good case, a bad token, a bad signature, a malformed body, an unknown admin action, an internal failure, and `/health` while shutting down | 5 |
| 14 | The complete `Main` layer builds with test config and fake Discord (catches missing and circular dependencies) | 5 |
| 15 | Time-driven behaviour that so far only live QA could check, now under `TestClock`: a start on the exact second, the Lobby question after 30 s, a private copy let go after 14 min, alert throttling over 3 h, the refill every 6 h, the gateway-down alert after 5 min | 6 |
| 16 | A job that hangs is interrupted at its timeout, alerts once, and the next job in the same minute still runs | 7 |

## 8. Fault drills on the test bot (phase 8)

Run `sudo host-watch pause 30m` on the server before any drill that stops a container by hand,
and `sudo host-watch resume` after. Before each drill, `qa_guard.require_idle()` conditions must
hold on the test server. For each drill, write the observed log lines and timings in `STATUS.md`.

| Drill | How | Expect |
|---|---|---|
| Leader loses its database connection | Find the backend holding advisory lock `4242002` in the dev database (`pg_locks` joined to `pg_stat_activity`), `pg_terminate_backend` it | `leader: stepped down`, then `took over` within about 20 s; `/health` shows `leader: true` again; nothing posted twice |
| All database connections drop | Terminate every backend whose `application_name` starts with `meme-bot-dev` | No process restart; `/health` is ok again within seconds; the next minute's jobs run |
| Handover | Deploy the same image twice in a row | In the logs, never two leaders at once and never more than a few seconds with none; `/health.clock` stays under 120 |
| Stop during a start | Schedule a test night 60 s out (as `qa_timing.py` does); `docker stop` the leader 5 s before the start, and in a second run half a second after it | The night starts exactly once, with one ping, on time or within the next minute |
| Hard kill | `docker kill` the leader mid-minute | It restarts; nothing is reposted; Reddit is not refetched (the log shows no refill) |
| Restart loop | Restart the container five times in two minutes | No Reddit fetch, no duplicate card, no alert storm |

## 9. Live QA on the test bot (phases 5 and 8)

Deploy the branch to the test bot only: `gh workflow run bot.yml --ref effect -f target=dev`.
Never `BOT=prod`. Run every suite and compare its result line with the baseline:

`qa_all.py`, `qa_timing.py`, `qa_rooms.py`, `qa_stats.py`, `qa_spontaneous.py`, `qa_late_ui.py`,
`qa_leaveby.py`, `qa_slowpoke.py`, and `qa_maybe_matrix.py` (about 41 minutes; one case at a
time, never in parallel).

Then the one path no script reaches. Do it yourself with the T3 browser tools, in the owner's
logged-in Discord session: tap a game-night card on the test server and watch the private copy
follow the card through ask → game → time → locked in without another tap. Never resize or close
that tab, never log out. If Discord is logged out there, tell the owner at once and carry on
with everything else.

Compare tap handling time with the baseline (§2c): the median and the 95th percentile must be
within 20 %, and no tap may pass 1,500 ms that didn't before.

## 10. Soak (phase 8)

The branch runs on the test bot for at least 48 hours, covering two daily polls and two daily
memes, with `scripts/soak_watch.py` running. It passes when:

- every scheduled thing happened exactly once, at its time (the poll card, the daily meme, the
  refills every 6 hours, the 03:00 sweep)
- `/health` was never not-ok outside a drill; `clock` never passed 90; exactly one leader
- no line matching `failed` in `ssh vps app-logs meme-bot-dev 48h` that the baseline run didn't
  also have
- memory after 48 hours is within 30 MB of memory after one hour, and within the container limit
  by a wide margin
- `ssh vps server-status` shows no problems

## 11. Cutover and rollback (phases 8 and 9)

**Rehearse rollback on the test bot first (phase 8):** deploy the branch, then deploy the
`pre-effect` commit over it. The old code must start, find nothing to migrate, take the lead,
and pass `qa_all.py` on data the new code wrote. Then deploy the branch again.

**Before the cutover:** the checks in `../README.md` under "Deploying" (nobody in voice, no night
voting or about to start), the owner's go, and a moment at least six hours before the daily poll.

**Cutover:** merge `effect` into `main` with a merge commit (not a squash, so one
`git revert -m 1` undoes it). The push deploys the test bot, then production.

**After:** `/bot/health` shows the new version and `leader: true`; `ssh vps app-logs meme-bot
10m` is clean; `ssh vps server-status` shows no problems. Watch the daily poll post, and stay
available through that evening's game night. Read the logs again the next morning.

**Roll back when:** anything the trio would notice goes wrong and isn't fixed within a few
minutes. `git revert -m 1 <merge>` and push; the pipeline puts the old code back in about ten
minutes. No database step is needed, because the schema never changed. Then find the cause on the
branch, with a test that reproduces it, before trying again.

## 12. Reporting

At the end of every phase, to the owner, in plain words and leading with the outcome: what now
runs on Effect, what was checked and how (gate numbers), anything that didn't go to plan, what
is next. Don't wait for an answer (`RUN.md` §9). At the end of phases 1, 5, 8 and 9, also update the memory file `meme-bot-project.md`.
