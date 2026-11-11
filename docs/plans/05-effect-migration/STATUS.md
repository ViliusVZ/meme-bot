# 05 · Status

The one place that says where the migration stands. Every session reads this first and updates
it last. Keep it short: facts and numbers, newest entry at the top of each list.

## Where we are

- **Phase:** 0 (baseline and preparation), started 2026-11-11 15:00. Done: steps 1 (ledger), 2
  (harness), 3 (no import cycles), 4 (recorder, deterministic), 5 (Discord error fixtures), 6
  (`leftovers.mjs`, `soak_watch.py`, `gates.sh`, all self-checked). Left: step 7 (numbers: the
  live QA suites on the test bot, tap timings, memory), step 8 (ship), the audit, the phase note.
- **Workspace / branch:** `C:\p\meme-bot-effect`, branch `effect` (one branch for everything,
  owner's changes 2026-11-11). Local Postgres for the gates: see "Deviations".
- **Backstop task id:** `scheduled-task:a0b37a30-2113-485b-81c6-723823483b80` (every 6 h, bound to this thread)
- **Next step:** deploy `effect` to the test bot, run every QA suite for the baseline numbers
- **Waiting for:** nothing. Plan 02 is not waited for (owner, 2026-11-11); `origin/main` was at
  `f401685`, plan 02 still on `wow-news`, unmerged.
- **Blocked on the owner:** nothing. The cutover go was given in advance (2026-11-11).
- **Gotchas learned:** never write code containing a backslash-n escape through a Python heredoc (it becomes a
  real newline; use the Edit tool). `git checkout --` on a file added with `git add -N` empties
  it. Run long commands detached or in the background; a tool timeout kills its children.

## Phases

| # | Phase | State | Finished | Notes |
|---|---|---|---|---|
| 0 | Baseline and preparation | not started | | |
| 1 | Drizzle 1.0 under the old code | not started | | |
| 2 | Toolchain and spikes | not started | | |
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
| `effect` and the `@effect/*` packages | | |
| `drizzle-orm` / `drizzle-kit` | | |
| `@effect/language-service` | | |

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

## Declared exceptions

- **Unordered call groups** in the recordings (`verification.md` §2a), in `test/harness.ts`
  `UNORDERED`:
  - "panel copies": a run of consecutive `PATCH /webhooks/<app>/<token>/messages/@original`
    calls is sorted. `panels.ts` `push()` edits every live copy of a card in one `Promise.all`;
    shown order-only on 2026-11-11 (the b/c copies swapped between two otherwise identical runs).
- **Declared races** (`h.race(reason)`: no calls recorded, database as row counts only), each a
  test whose point is several callers at once: flows "17:00 posts one card per day, however many
  times it runs" (two daily jobs), flows "three people planning the same day at once" (three
  `startNight`), flows "rooms: one room per game even when two open at once" (two `openRoom`),
  spontaneous "two taps at the same moment open one room". Shown: the winner, and whether the
  loser got as far as posting, change with timing (tunnel run and jitter runs).
- **Body normalisation:** stack frames (indented `at …` lines) are dropped from request bodies before
  hashing; alert DMs quote the error's stack, whose frames depend on timing and code shape. The
  error's message line, the DM's wording and footer still count.
- **Tests that wait for background work between taps** (setup, not assertions): paths "clicking
  the card opens your private copy…", matrix "taps: Maybe on the card opens your panel…". Without
  it the next tap overlapped the previous tap's background work and the panel rows differed.
- **Timing-sensitive tests** (deterministic under the gate's conditions, five identical runs, but
  their recordings change under `JITTER=1`, because a tap's reply and its background work overlap
  and the stub hands out ids in arrival order): flows "a tap on your own panel keeps its note when
  the panels sync", "panels past Discord's 15 minutes, or dismissed, are let go", "private panels
  follow the card: one person's vote moves everyone's open panel on". If the migration changes
  their recordings, compare full dumps (`RECORD=full`): if only the interleaving and the ids that
  follow from it differ, declare it here with the evidence; anything else is a bug.
- **Assertion changes** (`verification.md` §2b): none yet
- **Diagnostics switched off** in boundary files: none yet

## Decisions taken along the way

Small technical choices the plan left open (which logger, the leader ping interval, each job's
timeout), with the evidence.

## Found on the way


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
