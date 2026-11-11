# 05 · Status

The one place that says where the migration stands. Every session reads this first and updates
it last. Keep it short: facts and numbers, newest entry at the top of each list.

## Where we are

- **Phase:** 2 done (spikes, report written); phase 0 and 1 have open items, run alongside:
  - phase 0: the live QA baseline is running on the test bot against `618cf73` (old code), see
    "Numbers"; then the tap baseline (needs the owner's Discord login in the T3 browser, which
    was logged out at 16:20), memory, the phase note
  - phase 1: deploy `drizzle-1` (`0efcba9`) to the test bot, `qa_all.py` + `qa_timing.py`, the
    rollback rehearsal (previous `main` over it), then tag `pre-effect`; land phases 0+1 on `main`
    when the deploy rule allows (or with the cutover)
  - the phase 1 and phase 2 audits (fresh subagents) are still to run
- **Workspace / branch:** `C:\p\meme-bot-effect`, branch `effect`; `drizzle-1` points at the
  phase 1 commit for test-bot deploys; tag `baseline` = phase 0 recordings and ledger (`1b83120`)
- **Backstop task id:** `scheduled-task:a0b37a30-2113-485b-81c6-723823483b80` (every 6 h, bound to this thread)
- **Next step:** phase 3 (foundations), after the drizzle-1 test-bot checks
- **Waiting for:** the QA baseline run (background, about an hour); the owner's Discord login in
  the T3 browser (tap timings and the browser test; everything else carries on)
- **Blocked on the owner:** nothing. The cutover go was given in advance (2026-11-11).
- **Gotchas learned:** never write code containing a backslash-n escape through a Python heredoc
  (use the Edit tool). `git checkout --` on a file added with `git add -N` empties it. Run long
  commands detached or in the background; a tool timeout kills its children (the local Postgres
  is started detached by `pg-start.ps1`). `git ls-tree` from a subdirectory filters its output
  even for `ref:path` (use `--full-tree`).

## Phases

| # | Phase | State | Finished | Notes |
|---|---|---|---|---|
| 0 | Baseline and preparation | in progress | | steps 1-6 done, audited, findings fixed; QA baseline running |
| 1 | Drizzle 1.0 under the old code | in progress | | code + tests done (recordings identical on old and new code); test-bot checks next |
| 2 | Toolchain and spikes | done | 2026-11-11 | all ten spikes pass; see spike-report.md |
| 3 | Foundations | not started | | |
| 4 | Feature services | not started | | |
| 5 | Entry points, lifecycle, removing the old stack | not started | | |
| 6 | Tests become Effect-native | not started | | |
| 7 | Hardening and observability | not started | | |
| 8 | Test bot: QA, drills, soak | not started | | |
| 9 | Cutover | not started | | |

## Numbers

<!-- leftovers -->
| Pattern | Outside boundary files | In boundary files |
|---|---|---|
| `async` | 197 | 5 |
| `await` | 664 | 19 |
| `.then(` | 23 | 1 |
| `.catch(` | 59 | 3 |
| `try {` | 38 | 2 |
| `new Promise` | 8 | 7 |
| `setTimeout/Interval` | 15 | 8 |
| `AbortController` | 1 | 2 |
| `AbortSignal` | 7 | 2 |
| `fetch(` | 4 | 0 |
| `console.` | 37 | 15 |
| `Date.now/new Date` | 82 | 0 |
| `Math.random` | 1 | 0 |
| `process.env` | 4 | 0 |
| `: any` | 12 | 0 |
| `as any` | 2 | 0 |
| `_reset` | 4 | 0 |
| `LEGACY-BRIDGE` | 0 | 0 |
| `Effect.promise` | 0 | 0 |
| `Effect.tryPromise` | 0 | 0 |
| `runPromise` | 0 | 0 |
| `runFork` | 0 | 0 |
| `Effect.orDie` | 0 | 0 |
| `@effect-diagnostics` | 0 | 0 |
| `@ts-` | 0 | 0 |
| **total** | **1158** | **64** |

Import cycles: none.
Per file: gamenight.ts 278, spontaneous.ts 155, voice.ts 103, interactions.ts 76, app.ts 51, main.ts 46, activity.ts 37, live.ts 37, attendance.ts 33, late.ts 32, reddit.ts 32, jobs.ts 31, memes.ts 31, polls.ts 29, scheduler.ts 28, snooze.ts 28, db/index.ts 27, discord.ts 27, cleanup.ts 19, gateway.ts 18, alerts.ts 17, memeshame.ts 17, gemini.ts 15, panels.ts 15, games.ts 8, roasts.ts 8, background.ts 7, localtime.ts 5, presence.ts 5, nights.ts 3, hub.ts 2, channels.ts 1, env.ts 1.
<!-- /leftovers -->

Fill the baseline column in phase 0. Update "now" at the end of every session.

| Measure | Baseline (phase 0) | Now |
|---|---|---|
| Tests passed | 580 before any change; 586 with the Discord-error tests (10 files) | |
| Query sites found / executed | 210 / 210 | |
| Recordings differing | 0 | |
| Assertion ledger | 741 assertions (728 at the start, 13 from the Discord-error tests) | |
| Leftovers (G6 total; per-pattern table below) | 1158 outside boundary files, 64 inside (after the phase 0 moves) | |
| `qa_all.py` | | |
| `qa_timing.py` | | |
| `qa_rooms.py` | | |
| `qa_stats.py` | | |
| `qa_spontaneous.py` | | |
| `qa_late_ui.py` | | |
| `qa_leaveby.py` | | |
| `qa_slowpoke.py` | | |
| `qa_maybe_matrix.py` | | |
| Tap handling, median / 95th percentile (ms) | | |
| Memory after 1 h (MB) | | |

## Versions in use

| Package | Version | Since |
|---|---|---|
| `effect` and the `@effect/*` packages | 4.1.4 (`effect`, `@effect/platform-node`, `@effect/sql-pg`, `@effect/vitest`) | 2026-11-11 |
| `drizzle-orm` / `drizzle-kit` | 1.0.0-rc.5 (newest release candidate on 2026-11-11) | 2026-11-11 |
| `@effect/language-service` | 0.87.5 | 2026-11-11 |

## Modules moved (phases 3–5)

One line per module: date, commit, the three break-it changes tried (`verification.md` §6).

## Deviations from the plan

- **2026-11-11, the owner's changes** (README.md top block, pointers at the top of RUN,
  verification and phases; RUN.md §3 rewritten for one branch). A first message cut many checks;
  a correction the same day restored every one of them. What remains changed: no clock gates
  (no "evening in production", no waiting for a morning or N hours); the 48-hour soak is a forced
  soak in one sitting on the test bot (each scheduled thing forced through admin routes and QA
  helpers, exactly once, idempotent, restart-safe; a few hundred minute ticks under
  `soak_watch.py`; what can't be forced is proven with a `TestClock` test and listed here); one
  branch `effect`, phases 0 and 1 landing on `main` as fast-forwards when their checks pass (or
  with the cutover if the deploy rule blocks); plan 02 not waited for; the cutover go given in
  advance; test 16's timeouts from production's `minute … ms` log lines.

- **2026-11-11, phase 0 step 3:** `declare` needs the slip renderer and `Voice`, so `render` and
  `slip` moved to `attendance.ts` with it, and `Attendance` sits after `Voice` (layer 7), not in
  layer 6. `late.ts` keeps `watch`, `act` and re-exports the rest. `gamenight.ts` re-exports what
  moved out (`players`, `local`, `wallToUnix`, `pollHour`, `weekday`, `getNight`, `isOver`, the
  game list), so callers above it didn't change. architecture.md §4 amended.
- **2026-11-11, gates on a local Postgres 18.6** (the production major and minor) on port 55433,
  instead of the tunnel: 16 s for the suite instead of 290 s. Same recordings as the tunnel run
  apart from timing-dependent tests (below). Start it with
  `powershell -File <scratchpad>\pg-start.ps1`; gates with
  `TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55433/postgres bash scripts/gates.sh`.
  CI keeps its own Postgres service; the tunnel stays available.

- **2026-11-11, phase 1, tap timings:** the "interaction <ms> ms" line is written only for real,
  signed Discord taps; the QA scripts go through admin routes, so `qa_all.py` produces none (and
  production had 8 logged taps since the server rebuild). The tap baseline is taken from real taps
  in the T3 browser on the test server, the same sequence on the old code and on the new.
- **2026-11-11, phase 1:** `runMigrations` takes an optional `migrationsSchema` (default
  `drizzle`), so `test/migrations.test.ts` can run the real migrator on a throwaway schema; the
  test database role can't create databases.

- **2026-11-11, phase 0, from the audit:** `channels.list` became `discord.listChannels` plus
  `channels.cached()` (same behaviour: the cache when the gateway has sent one, else REST).
  Commits `7d9d239` and `17ed083` were made with G6 red (the cycles were still there and
  `leftovers.json` had the post-move counts): the work was split into commits afterwards. Not
  rewritten; noted for bisecting.
- **2026-11-11, G4 and G5 against a tagged baseline:** `scripts/recordings.mjs` and
  `assertions.mjs --base baseline` compare with the commit tagged `baseline`, not only with the
  last commit, so a commit that regenerates recordings or rewrites the ledger can't pass. G4
  deletes the recordings before each run, so a test file that stops recording shows up. The
  harness writes its file even when empty. Exceptions to the baseline go in
  `test/recordings.allowed.json`, each with a reason, and are listed here.

## Declared exceptions

Every place the recorder or a test's setup is looser or different than "record everything in
order". Evidence: the jitter runs (`JITTER=1` delays every stubbed answer and query by 0-4 ms);
with all of these in place, three normal runs and a jitter run of the whole suite give identical
recordings (see "Numbers").

- **Unordered call groups** (`verification.md` §2a), `test/harness.ts` `UNORDERED`:
  - "panel copies": a run of consecutive `PATCH /webhooks/<app>/<token>/messages/@original` is put
    in URL order, stably, so two edits of the same copy keep their order. `panels.ts` `push()`
    edits every live copy of a card or a poll in one `Promise.all` (polls go through it too:
    `polls.ts:129`). Shown order-only: the b/c copies swapped between two identical runs.
- **Background reads:** `GET /webhooks/<app>/<token>/messages/@original` (looking up a private
  copy's message right after the tap, in the background) is recorded as its own list after the
  other calls, in its own order. The stub answers these with ids from their own range (first id +
  700,000), so when the read lands doesn't shift the ids of everything else. Shown: three flows
  panel tests and the paths copy test changed under jitter only through this read's position and
  the ids that followed; stable with it.
- **Declared races** (`h.race(reason, { mask, bodies, calls })`), each a test whose point is
  several callers at once. A create the bot deletes again in the same test cancels out with its
  delete, ids in URLs are masked, calls sorted; the database is hashed in full except the named
  winner-dependent columns:
  - flows "17:00 posts one card per day, however many times it runs": `game_nights.message_id`
  - flows "three people planning the same day at once": `game_nights.started_by/message_id/
    nudge_id`, `game_night_votes.user_id`, bodies not hashed (the nudge names the winner)
  - flows "rooms: one room per game even when two open at once": `rooms.channel_id/game/
    created_by`; no calls (how many lookups happen depends on timing)
  - spontaneous "two taps at the same moment open one room": `lobby_prompts.id/message_id/by/
    game`, `rooms.channel_id/created_by/game`, bodies not hashed (whoever claims first picks the
    game)
  - paths "clicking the card opens your private copy…" and matrix "taps: Maybe on the card opens
    your panel…": their original bodies, unchanged, as races (the next tap comes before the
    previous tap's background work has landed): `panels.message_id`, no calls. Each has a twin
    "(each tap done before the next)" that waits between taps and is recorded in full.
  Evidence: full dumps (`RECORD=full`) of normal and jitter runs differ only in those columns.
- **Masked values:** `roast_bags.updated_at` and `settings.updated_at` only where the value is the
  database's own `now()` (within 10 minutes of the real wall clock); where the bot writes the
  column from the fake clock (`gemini.ts`, `reddit.ts`, `snooze.ts`) the value is recorded.
- **Body normalisation:** JSON keys sorted before hashing (key order is not behaviour); stack-frame
  lines (newline, indent, `at …`) removed from every string before hashing (alert DMs quote the
  error's stack; no user-facing text contains such a line today).
- **Setup changes:** the harness waits for background work to finish after every test before
  recording (the old stubs let a test's late calls land in the next test's list); `paths` now
  empties `panels` before each test (the racing copy test's rows leaked into five later tests);
  the stub's id counter restarts per test (it ran on across a file).
- **Assertion changes** (`verification.md` §2b): none
- **Diagnostics switched off** in boundary files: none

## Decisions taken along the way

Small technical choices the plan left open (which logger, the leader ping interval, each job's
timeout), with the evidence.

- **Leader lock:** a one-connection `PgClient.makeClient` in the term's scope, pinged every 5 s
  (spike S2: `sql.reserve` returns its connection to the pool still holding the lock; a killed
  backend fails the next statement at once, and nothing reports it without one).
- **int8:** a client type registry decodes int8 to a number (spike S1; `@effect/sql-pg` has its
  own protocol, so the old global `pg` parser doesn't apply).
- **Logger:** `Logger.consoleLogFmt`, each message one string (spike S10).
- **Test clock with a real database:** pool built and closed on the live clock, no acquire timeout
  in tests; the "advance until done" helper jumps to `TestClock`'s next pending sleep (reads the
  4.1.4 field `sleeps`; test-only) (spike S7).
- **Test HTTP client:** tests provide `FetchHttpClient.Fetch`; the default captures
  `globalThis.fetch` once (spike S5).

## Found on the way

- **`/meme` picks with Postgres `random()`** (`interactions.ts:244`): not seeded in tests, so the
  recordings only stay stable because the tests that reach it have one candidate.
- **Not under the harness:** `resilience.test.ts` (fake timers, its own pool) and `time.test.ts`
  (pure functions) have no recordings; their assertions are in the ledger.


- **Rollback and migrations (Drizzle 1.0, found in phase 1):** the 1.0 migrator writes
  `created_at` at whole seconds, while the old migrator (Drizzle 0.45, at the `pre-effect` tag)
  applies every journal entry whose millisecond `when` is greater than the latest `created_at`.
  So a migration that 1.0 applied and that is also in the old code's journal is re-run by the old
  code, and its startup fails ("already exists"). Proven locally: a database first built by 1.0
  makes the old migrator fail on `activity_guesses`. Production's and the test bot's databases
  were built by the old migrator, so rolling back to `pre-effect` is safe as long as no
  migration is added that the old journal also contains (a new migration after the upgrade is
  unknown to the old journal and is skipped by it). Keep this in mind if plan 02's migration
  lands: it must be in the old journal before any 1.0 migrator applies it, or rollback needs a
  manual `created_at` fix.
- **drizzle-kit 1.0 rc.5 and partial indexes:** `drizzle-kit generate` with no schema change
  proposes dropping and recreating the five partial indexes (`one_daily_per_day`,
  `memes_posted`, `memes_pool`, `voice_segments_one_open`, `lobby_prompts_current`): it writes
  their WHERE clause differently from the converted snapshots. Not a real change; deleted. Any
  future `generate` must drop those lines from its output.
Bugs and weak spots in the existing behaviour, noticed during the migration and deliberately not
fixed in it. For the owner to prioritise after the cutover.

## Drill and soak results (phase 8)
