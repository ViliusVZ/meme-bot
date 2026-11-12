# 05 · Status

The one place that says where the migration stands. Every session reads this first and updates
it last. Keep it short: facts and numbers, newest entry at the top of each list.

## Where we are

### Logins and browser tabs (2026-11-12, owner back)

- The only login the rest of the plan needs is **Discord in the T3 browser** (default profile),
  for the tap-timing measurement and the private-copy browser tap test (verification.md §9). gh
  and `ssh vps` use stored credentials; nothing else signs in.
- Tab `tab_1_214808b9-efd8-44f7-9870-09905495f612` (discord.com/login, opened 2026-11-12) is the
  one for it. **Keep it for the rest of the run: never close it, resize it, log out, clear its
  storage, or navigate it away from Discord** (closing a Discord tab logs him out). Reuse it; never
  open a second Discord tab. Before a login check, look at it: signed in → run the check; not →
  remind the owner once and do other work first. Both checks must be done before cutover.

### Browser checks (2026-11-12, owner signed in)

- **Private-copy browser tap test: passed on `52a14ba`.** In the T3 browser as Vithis on the test
  server: "I'm in" on a quiet QA card (2026-12-28, planned by K) opened the private copy; then
  quiet admin votes only (L yes; all three Enshrouded; all three 20:00) and the copy followed by
  itself: ask → "Pick a game" → "When can you start?" → "It's on: Enshrouded at 20:00" with the
  late buttons. Screenshot `C:/Users/viliu/.t3/userdata/browser-artifacts/browser-screenshot-discord-com-mwd6lqef-5e541e92.png`.
  Helper: `<scratchpad>/tapqa.py` (setup / vote / state / reset, test bot only, quiet).
- **Tap timings:** old code baseline taken (test bot on `aa49c52`, then `effect` put back:
  `bb61bb2`). Numbers in the Numbers table. Both to be repeated on the final code in phase 8.

### Resume here (paused 2026-11-11 ~22:55: the owner turned the PC off)

- **Step:** phase 5, step 4 (Ticker + start timers) is **done and committed**: code `d57d1fe`,
  tests 8 and 9 `745e3b8`, gates green (770 tests). Nothing is half-written. The only thing left
  of step 4 is its live check (below). **Next:** deploy `effect` to the test bot
  (`gh workflow run bot.yml --ref effect -f target=dev`, then `gh run watch <id>`), check
  `/bot-dev/health` shows the new version and `/bot-dev/nope` Fastify's 404 body, run `qa_all.py`
  and `qa_timing.py` (logs to `<scratchpad>/qa-effect/ticker-<sha>/`), record them here, then
  step 5 (Live on a Queue, test 10).
- **The HTTP step's live check never happened:** its deploy run 43095905535 ended
  `startup_failure` (GitHub never started it: zero jobs, no workflow change). The check that ran
  afterwards (qa_all 79/0, qa_timing 13/0, Fastify-style 404) hit the old `34f31cb`. The next
  deploy above covers the HTTP step and the Ticker together.
- **Deployed (2026-11-12 08:55):** test bot `bb61bb2` (= the Ticker step + test commits).
  Production `aa49c52` (phases 0+1, landed 2026-11-11 19:21). Nothing in flight.
- **Step 4's live check done** (`52a14ba`, logs `<scratchpad>/qa-effect/ticker-52a14ba/`): health
  ok with the version, the unknown route answers Fastify's 404 body, qa_timing 13/0 (ping 0.61 s),
  qa_all 78/1: "one roast in the channel" failed because the run was at 08:34 and a roast waits
  for 09:30 (`MORNING` in gamenight.ts, the same in the old code); every earlier run was in the
  evening. qa_all to be run again after 09:30 to show it.
- **Branch:** `effect` pushed to origin, at this STATUS commit (after `745e3b8`). Tags
  `baseline`, `pre-effect` and the branch `pre-effect-build` are on origin.
- **Gone after a reboot, and how to bring it back:**
  - Local Postgres on 127.0.0.1:55433 (stopped cleanly at the pause): `powershell -File
    <scratchpad>/pg-start.ps1`, where `<scratchpad>` =
    `C:/Users/viliu/AppData/Local/Temp/claude/C--p/bc4f4185-141d-4bbc-8d25-1a5596954346/scratchpad`
    (binaries in `pg-download/`, data in `pgdata/`). If that folder is gone: download Postgres 18
    portable again, `initdb -U postgres -A trust`, and start it with the flags in the script
    (port 55433, fsync off, max_connections 200).
  - **Always run the gates with `TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55433/postgres`.**
    Without it they fall back to `bot/.env.test` (the SSH tunnel to the VPS on 55432): slow
    (283 s), and five recordings in reddit/spontaneous/paths change under that latency, so G4
    goes red for no code reason (seen twice on 2026-11-11).
  - The SSH tunnel (`ssh` on 55432) isn't needed: the local Postgres replaces it.
  - No background runs are left. Logs in `<scratchpad>/qa-effect/` (per deploy) and the break-it
    script `<scratchpad>/breakit_ticker.py` are for reference only; nothing in them is needed to resume.
- **Still owed:** the phase 5 note to the owner (the phase 4 note went out at the pause); the
  browser tap-timing measurement and the private-copy browser tap test, deferred until the owner
  can log in to Discord in the T3 browser (list both as outstanding in the final message).

- **Phase:** 5 (entry points) in progress; phase 4 done (audit closed; after the audit fixes, on the test bot `34f31cb`: qa_all 79/0, qa_timing 12/1 once (the start ping 1.52 s after the start against a 1.5 s limit), then 13/0 twice (0.58 s, 0.82 s): Discord latency, not a regression; 0.92 s at baseline). Phase 5 so far: Jobs (`a11bdc4`, tests `6a06611`, test 6 `2493e6a`); Interactions (`f835117`, tests `bdc3332`: payload Schema, the custom_id union `Tap` in `tapOf`, a Match; GameNight's `act` hands `later` work with its services provided; `@original`'s channel_id optional as before; /meme's claim → reply → the record's scheduling is uninterruptible, the reply itself being the HTTP answer). **HTTP step done** (`27b8e7e`; test 13 `d5705d9`, `2b77fb3`; the verifier moved to `verify.ts`; its live check still to do, see Resume here). **Ticker step done** (`d57d1fe`, tests 8, 9 `745e3b8`). The HTTP design, for reference: `app.ts` becomes an
  `HttpRouter` (effect/http) on `NodeHttpServer` (@effect/platform-node), same routes and answers:
  GET /health (503 + `{ok:false, shuttingDown:true}` while shutting down; db `SELECT 1`, 503
  `{ok:false, db}` on failure; else `{ok, leader, clock: sinceTick, gateway: presence ready,
  background: in flight, uptime, version}`), GET / ("Meme Bot 3000 🔥"), POST /interactions
  (raw text, Ed25519 check → 401 "bad signature", the tap boundary: timing log line
  `interaction|slow interaction <ms> ms <what> <who> <where>`, the 3 s report, an apology on
  failure), POST /ingest (ingest secret, 401 "nope"), admin routes behind one bearer check (401
  "nope"), `/admin/gamenight` actions as a Match (unknown → 400 `{error:"action?"}`, quiet calls
  via `withOverrides({quiet:true, players})`), any unhandled failure → 500 `{error: String(e)}`
  and a report when ours, a body over 1 MB → 500 not reported, an unknown route → Fastify's JSON
  404 body. The routes read an `AppStatus` service (leader, shuttingDown, publicKey): production
  builds it from Lifecycle + config; the test delegate `build(env, status)` builds a web handler
  (`HttpRouter.toWebHandler`) with the status and key the test gives, over the installed
  runtime's services, and returns `{ inject }` shaped like Fastify's (statusCode, json(), body),
  so the tests change only their call expressions. Test 13: the contract route by route. HTTP, Ticker + start timers, Live, Gateway, Leadership/main/shutdown, then delete the transition. Phase 3 done: all six steps; live check on the
  test bot with `8e7c1f2`: qa_all 79/79, qa_timing 13/13, no failed/error log lines (= baseline);
  its audit done and its findings fixed. Phase 4 so far: LocalTime, Games, Nights, Memes, Roasts,
  Panels, Gemini, Snooze, Voice, Attendance, Reddit, Spontaneous; `qa_rooms.py` on the test bot
  (`07dd493`): 10 checks, no failures; `qa_spontaneous.py` (`e47a7b9`): 14 checks, "all good".
  Architecture §15 in the moved services (`13b7a83`): every claim → post → record region
  uninterruptible; test 6 is `test/interruption.test.ts` (`ddee640`), one table entry per
  sequence: GameNight's sequences (the card, the start ping, roasts) are added there as they move.
  Memes, Panels, Roasts hold no claim → post sequence inside a service (the daily meme's lives in
  `jobs.ts`/`gamenight.ts` callers, still promise code). GameNight in five commits: **1/5 done
  (`164d512`)**: readers, helpers, the card; **2/5 done** (`b230588`): the lifecycle; **3/5 done** (`ef1831d`): act
  (+ postRoast, dueRoasts, moved here rather than in 4/5: a two-line loop over postRoast);
  **4/5 done** (`f5cb909`): maintain; **5/5 done** (`85ab8cf`): the start + the `GameNight`
  service. On the test bot (`bdc5fed`, logs `qa-effect/gn-bdc5fed/`): qa_all 79/0, qa_timing
  13/0, qa_slowpoke exit 0, qa_leaveby output identical to the baseline's, no failed/error log
  lines. LateSlips (`78d83a6`), Polls (`cbd3b66`), Activity (`572bd89`), Hub (`8ee1b4c`),
  Cleanup (`b96dd12`), MemeShame (`dd1d940`) done: every module of phase 4 is moved. On the test
  bot (`3c7184d`): qa_stats 17/0, qa_late_ui output identical to the baseline's, no failed/error
  log lines. Second pass: named Durations done (`24ea65e`); explicit concurrency needed no change
  (every translated Promise.all states it: memes 4, the rest unbounded over ≤3 players or a few
  starts; presence's forEach replaces a plain loop, sequential as before). Next: `Match` (the
  stage switches in gamenight's render and your-vote, act's action, Activity's period kind, and
  the small action/choice comparisons in Spontaneous.answer, LateSlips.act, Polls.act): done
  (`bb296ea`, `cf8b260`, `8dc4b1e`, `23ea186`, `3ddb611`). Phase 4 exit holds (only the entry
  files, the signature verifier and the leader lock are promise-style).
- **Phase 4 audit (9c3e6fa..3ddb611) done; all ten findings closed** (`b1fa4f1` code, `322bb29`
  tests; the decisions and lists are below in their sections):
  1. [x] Claim → act sequences still interruptible: cleanup nightly (claim → deletes → clear ids),
     Spontaneous.answer (picked → room → delete), gamenight nudge (post → nudge_id), the warn and
     re-nudge claims in maintainNight, resumeNight, lockIn (event → id → ping), spontaneous
     finishSession, count, closePrompt. Make each uninterruptible.
  2. [x] Test 6 entries missing: recaps, meme-shame, ready room, auto-move, pull-in (+ the new
     regions from 1 where a test can reach them). STATUS said "one entry per sequence": make true.
  3. [x] claimStart gives the claim back when the plays update fails after the ping (a second
     ping next minute): old code too, but §15.2 says release only on the post's failure → release
     only when the start ping didn't go out; record as a decision; test.
  4. [x] Per-item loops (maintain per night, late per player, trackSessions per room, voice per
     room, lockIn's event block) catch typed errors only (§6), so a defect (the `!` on a vanished
     night row) aborts the whole job: turn the vanished-row cases into a typed NightGone so they
     stay per item; fix the comments; record the §6 decision.
  5. [x] `bot/scripts/import-d1.ts` imports the deleted `runMigrations`: fix or retire, record.
  6. [x] reddit's refill fiber uses catchCause: declare it as background work (§6 boundary).
  7. [x] §6 record rule: list the DiscordNotFound/DiscordRejected handlers that only log/ignore.
  8. [x] Phase 5 note: the daily meme, meme recaps and /meme (still promise code) must become one
     uninterruptible Effect each when they move.
  9. [x] Process: the G6 transition column under "Declared exceptions" too; note that 78d83a6
     and 85ab8cf put test 6 entries in the code's commit, and c97fb91 converted three config tests
     to it.effect in place (assertions unchanged).
  10. [x] Minor: the event-live PATCH fork must finish even if the moves fail (forkDetach);
     preciseStarts: one start's failure must not interrupt the others (mode "result"); Activity's
     Match on kind must keep the old fallback for an unchecked admin kind; Panels' lock map must
     be pruned (and the unused promise bridge removed); readyRoom/autoMove/answer regions include
     openRoom's wait (record: bounded by the 35 s exit, as the old code was); record the small
     undeclared differences (roast emoji inside the giveback, malformed snooze/reddit rows as
     empty, a listing that fails its schema fails the sweep, an empty legacy Gemini key spends
     budget, an unreadable webhook answer treated as none). How it's staged: the moved code is module-level
  Effect functions (their services in R); the promise code not moved yet calls them through
  `…P` wrappers (LEGACY-BRIDGE) and pure helpers over `When` (`W(env)` on the old side). The
  `GameNight` service itself comes in 5/5 and wires the public methods. Next: 2/5 the card's
  lifecycle (startNight, retryUnposted, refreshOpen, closeStale, close, refresh, syncPanels,
  trackPanel, resetNight, callOff, clearDay), 3/5 act (settle, hold, runningLate, startMoved,
  lockIn, afterBail, bailFromSlip, postRoast), 4/5 maintain (maintainNight, resume, dueRoasts),
  5/5 the start (claimStart, startReminder, startOnTime, preciseStarts, upcomingStarts) + the
  service. `act`'s `defer` takes Effects; its delegate runs each through the bridge into the
  caller's defer (keeps the tests' waits and the call's overrides). Test 6 entries for the card,
  the start ping and the roast go into `test/interruption.test.ts` with their stages.
  Phases 0+1 are on `main` and in production (below). Browser tap timings and the browser tap
  test: deferred by the owner.
- **Workspace / branch:** `C:\p\meme-bot-effect`, branch `effect`. `drizzle-1` = `pre-effect`
  (`aa49c52`): `0efcba9` (Drizzle 1.0) plus the phase 0 fixes cherry-picked, so the rollback
  target has the old code and the final phase 0 harness, and reproduces `baseline` exactly (all
  gates green there, 550 recordings identical). Tag `baseline` = `1b83120` (pinned in
  `scripts/gates.json`). Evidence branch `baseline-on-drizzle-0.45` (`90412d3`): the baseline
  harness on `618cf73` (Drizzle 0.45), three runs, all 550 recordings identical.
- **Baseline of what `main` was:** `origin/main` was at `f401685` on 2026-11-11 (plan 02 still on
  `wow-news`, unmerged); every baseline here is of that code.
- **Backstop task id:** `scheduled-task:a0b37a30-2113-485b-81c6-723823483b80` (every 6 h, bound to this thread)
- **Next step:** phase 3 (foundations), after the drizzle-1 test-bot checks
- **Tap timings without the browser (owner's fact 2):** the bot logs `interaction … ms` only for
  real Discord taps on `/interactions` (signed by Discord; QA can't make them), so neither the
  baseline nor any QA run has such lines. What is measured instead: `qa_timing`'s start-ping
  delay and room lead (above), and in phase 8 the round trip of the admin routes that run the
  same tap code (`/admin/…` act calls), timed on the new code and again on the old code during the
  rollback rehearsal (old over new on the test bot), same script both times.
- **Owner's facts, 2026-11-11 evening (verbatim intent):**
  1. No game night tonight: the trio won't play, so tonight's open poll is no reason to hold a
     production deploy. **For tonight (2026-11-11) only**, the deploy rule is just: nobody is in
     voice at that moment (check it). That clears landing phases 0+1 on `main` now and the
     cutover whenever it's reached tonight. From 2026-11-12 the normal rule applies again (no one
     in voice, no night voting, on or starting soon, not around the 17:00 poll; else retry in
     30 min).
  2. He's away from his PC and can't log in to Discord in the T3 browser tonight. Nothing waits
     for it, the cutover included. **Deferred, to list as outstanding in the final message:** the
     tap-timing measurement in the browser and the private-copy browser tap test. The private-copy
     path stays covered by its vitest tests; timings are compared without the browser, from the
     test bot's `interaction … ms` log lines during the QA suites, old code vs new. If the
     browser turns out to be logged in after all, do them.
- **Waiting for:** nothing.
- **Phases 0+1 landed on `main`** 2026-11-11 19:21 Vilnius (`f401685..aa49c52`, fast-forward), after a
  read-only check that none of the trio was in voice (fact 1). Run 43067418533: test, build, test
  bot, production all green. Production verified: health `version` aa49c52, leader, gateway ready,
  no failed/error lines in the first 10 min, migrations table 13 rows, all named (the 1.0 upgrade
  ran). The test bot was overwritten with aa49c52 by that run; `effect` goes back on it for QA.
- **Blocked on the owner:** nothing. The cutover go was given in advance (2026-11-11).
- **Gotchas learned:** never write code containing a backslash-n escape through a Python heredoc
  (use the Edit tool). `git checkout --` on a file added with `git add -N` empties it. Run long
  commands detached or in the background; a tool timeout kills its children (the local Postgres
  is started detached by `pg-start.ps1`). `git ls-tree` from a subdirectory filters its output
  even for `ref:path` (use `--full-tree`).

## How the work is done (read after a context summary)

- Gates: `TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55433/postgres bash scripts/gates.sh` in
  `bot/` (24 s). Local Postgres: `powershell -File <scratchpad>/pg-start.ps1` if it isn't running.
- A module: becomes a `Context.Service` (key from the `deterministicKeys` rule, e.g.
  `meme-bot/<file>`), methods `Effect.fn("Service.method")`, errors declared; queries `yield* db…`
  on `Db`; time from `clock.ts` (`nowSec`, `nowIso`) and `LocalTime`; HTTP through `Discord` or
  `HttpClient`; the old exported functions stay as one-line delegates marked `// LEGACY-BRIDGE`
  (`run(env, X.use(...))`, `runSync` for synchronous ones, `runDetached` without an env); the
  layer goes into `runtime.ts` (`AppServices` and `appLayer`, bottom to top).
- Before each commit: the suite, `node scripts/recordings.mjs` (550 identical to baseline), then
  three break-it changes (a skipped write, a wrong branch, a swapped/removed side effect); a break
  that stays green means a missing test: write it first, commit it before the code.
- Commits: checks and code apart. New tests that pass on the old code first, then the code; or
  the code first with the new test set aside, then the test. `node scripts/assertions.mjs --add`
  after adding tests. Never `git stash` bare (a tagged stash plus apply by SHA, or copies).
- A break-it must actually change the code: check the edit (a no-op "swap" proves nothing); a
  swap moves the side effect itself, not just an early return.
- Dead wrappers count as query sites (G3): delete a `…P` wrapper as soon as nothing calls it.
- Commit only on a green gate log: `bash scripts/gates.sh > $SP/gates.log 2>&1; grep -q "^ALL
  GATES GREEN" $SP/gates.log && git commit …` ($SP = the scratchpad). A pipe into `tail` hides the exit code (it let one
  commit through on a red G4 that was expected, the commit being amended).
- Python heredocs eat backslashes: write scripts with the Write tool, or edit with Edit.

## Phases

| # | Phase | State | Finished | Notes |
|---|---|---|---|---|
| 0 | Baseline and preparation | done, in production 2026-11-11 | 2026-11-11 | steps 1-6 done, audited, findings fixed; QA baseline done (numbers below); browser tap timings deferred by the owner (timings from `interaction … ms` log lines instead) |
| 1 | Drizzle 1.0 under the old code | done, in production 2026-11-11 | 2026-11-11 | test bot: qa_all 79/79, qa_timing 13/13; rollback rehearsal: old main over it started clean, qa_all 79/79; tag `pre-effect` = `aa49c52`; lands on `main` when production is clear |
| 2 | Toolchain and spikes | done, audited | 2026-11-11 | all ten spikes pass (spike-report.md); audit findings closed below |
| 3 | Foundations | done (audit running) | 2026-11-11 | live: qa_all 79/79, qa_timing 13/13 on `8e7c1f2` |
| 4 | Feature services | done | 2026-11-12 | every module moved; second pass done; audit closed (`b1fa4f1`, `322bb29`); QA on the test bot: qa_rooms, qa_spontaneous, qa_all, qa_leaveby, qa_slowpoke, qa_late_ui, qa_stats as baseline |
| 5 | Entry points, lifecycle, removing the old stack | in progress | | jobs, interactions, http, scheduler |
| 6 | Tests become Effect-native | not started | | |
| 7 | Hardening and observability | not started | | |
| 8 | Test bot: QA, drills, soak | not started | | |
| 9 | Cutover | not started | | |

## Numbers

Live QA baseline: the test bot on `618cf73` (the old code), 2026-11-11 16:13-17:30 Vilnius, every
suite one after another (`scripts/qa_baseline.sh`); logs in the scratchpad `qa-baseline/`. Runs on the
`effect` branch: logs in the scratchpad `qa-effect/`, named after the suite and the commit.

<!-- leftovers -->
| Pattern | Outside boundary files | In boundary files | In transition code (LEGACY-BRIDGE lines) |
|---|---|---|---|
| `async` | 2 | 6 | 8 |
| `await` | 6 | 19 | 13 |
| `.then(` | 0 | 1 | 4 |
| `.catch(` | 52 | 3 | 27 |
| `try {` | 1 | 2 | 0 |
| `new Promise` | 2 | 7 | 1 |
| `setTimeout/Interval` | 3 | 8 | 0 |
| `AbortController` | 0 | 2 | 0 |
| `AbortSignal` | 1 | 2 | 2 |
| `fetch(` | 0 | 0 | 0 |
| `console.` | 3 | 15 | 0 |
| `Date.now/new Date` | 6 | 0 | 3 |
| `Math.random` | 0 | 0 | 0 |
| `process.env` | 1 | 0 | 1 |
| `: any` | 2 | 0 | 0 |
| `as any` | 0 | 0 | 0 |
| `_reset` | 0 | 0 | 4 |
| `LEGACY-BRIDGE` | 421 | 15 | 0 |
| `Effect.promise` | 0 | 0 | 2 |
| `Effect.tryPromise` | 0 | 1 | 0 |
| `runPromise` | 0 | 0 | 1 |
| `runFork` | 0 | 0 | 1 |
| `Effect.orDie` | 0 | 0 | 0 |
| `@effect-diagnostics` | 0 | 0 | 0 |
| `@ts-` | 0 | 0 | 0 |
| **total** | **500** | **81** | **67** |

Import cycles: none.
Per file: legacy.ts 92, main.ts 60, gamenight.ts 45, spontaneous.ts 31, app.ts 29, discord.ts 23, voice.ts 22, presence.ts 21, db/index.ts 20, memes.ts 19, alerts.ts 18, gateway.ts 18, activity.ts 15, attendance.ts 14, live.ts 13, env.ts 12, polls.ts 11, scheduler.ts 11, channels.ts 10, jobs.ts 9, reddit.ts 9, late.ts 8, snooze.ts 8, interactions.ts 7, background.ts 6, cleanup.ts 6, games.ts 6, gemini.ts 6, memeshame.ts 6, lifecycle.ts 5, panels.ts 5, hub.ts 4, nights.ts 3, roasts.ts 3, verify.ts 3, runtime.ts 2, localtime.ts 1.
<!-- /leftovers -->

Fill the baseline column in phase 0. Update "now" at the end of every session.

| Measure | Baseline (phase 0) | Now |
|---|---|---|
| Tests passed | 580 before any change; 586 with the Discord-error tests (10 files) | |
| Query sites found / executed | 210 / 210 | |
| Recordings differing | 0 | |
| Assertion ledger | 741 assertions (728 at the start, 13 from the Discord-error tests) | |
| Leftovers (G6 total; per-pattern table below) | 1158 outside boundary files, 64 inside (after the phase 0 moves) | |
| `qa_all.py` | 79 passed, 0 failed (second run); the first run had 78/1, the cleanup check ("no QA messages left": two retired late slips have no buttons, so the cleanup can't find them) — flaky in the old code | 79 passed, 0 failed (`bdc5fed`, GameNight moved) |
| `qa_timing.py` | 13 passed, 0 failed; start ping 0.92 s after the start, room 9.8 s early | 13 passed, 0 failed; start ping 0.64 s after the start, room 9.8 s early (`bdc5fed`, GameNight moved) |
| `qa_rooms.py` | 10 checks, no failures | 10 checks, no failures (`07dd493`, phase 4 after Voice and Attendance) |
| `qa_stats.py` | 17 passed, 0 failed | 17 passed, 0 failed (`3c7184d`, phase 4 done) |
| `qa_spontaneous.py` | 14 checks, "all good" | 14 checks, "all good" (`e47a7b9`, phase 4 after Spontaneous and Reddit) |
| `qa_late_ui.py` | fixed sequence (setup, tick, state, offcard) ran clean; output kept for comparison | identical to the baseline's output (ids and times masked), `3c7184d` |
| `qa_leaveby.py` | fixed sequence (setup, three time/leave-by votes, clear, state) ran clean; output kept | identical to the baseline's output (ids and times masked), `bdc5fed` |
| `qa_slowpoke.py` | ran clean (exit 0), card and ping printed | ran clean (exit 0), `bdc5fed` (its printout lists the channel's latest messages, so it differs with whatever ran before it) |
| `qa_maybe_matrix.py` | 897 passed, 0 failed, 46.5 min | |
| Tap handling, median / 95th percentile (ms) | old code `aa49c52` on the test bot, 2026-11-12, real taps in the T3 browser (card I'm in, then six taps on the private copy): 49 / 101 (63, 101, 69, 49, 29, 32, 22) | `52a14ba` (phase 5, HTTP + Ticker), same sequence: 21 / 49 (49, 18, 27, 23, 16, 21, 17); none near 1,500 ms. To repeat on the final code in phase 8 |
| Memory after 1 h (MB) | 58.7 MiB at 56 min uptime (after every suite) | |

## Versions in use

| Package | Version | Since |
|---|---|---|
| `effect` and the `@effect/*` packages | 4.1.4 (`effect`, `@effect/platform-node`, `@effect/sql-pg`, `@effect/vitest`) | 2026-11-11 |
| `drizzle-orm` / `drizzle-kit` | 1.0.0-rc.5 (newest release candidate on 2026-11-11) | 2026-11-11 |
| `@effect/language-service` | 0.87.5 | 2026-11-11 |

## Modules moved (phases 3–5)

One line per module: date, commit, the three break-it changes tried (`verification.md` §6).

- 2026-11-11 `d57d1fe` scheduler (Ticker, start timers in a FiberMap; tests 8 `starts.test.ts`, 9
  `ticker.test.ts`): broken: firing a second early (red), no catch-up (red), a minute forked so
  minutes overlap (red), the watchdog repeating (red) or never firing (red), a start timer armed
  again each minute (red), start timers outliving the term (red), no net on the minute (red),
  sinceTick kept after stop (red).
- 2026-11-11 `27b8e7e` http (HttpRouter; test 13 `d5705d9`, `2b77fb3`): broken: an unknown action
  answered 200 (red), no body limit (red), the admin check skipped (red), a shutting-down copy
  saying it's fine (red); our failures not reported and a broken tap's apology lost stayed green:
  tests added, red since.
- 2026-11-11 `f835117` interactions (payload Schema, `Tap` union, Match): broken: /meme's message
  not stored (recordings red), a refused tap on your panel not tracked (recordings red); a
  stranger's poll vote, a changed vote touching the streak row, an unclamped stats offset, the
  retired tiebreaker reply and a blank room form stayed green: tests `bdc3332`, red since.
- 2026-11-11 `a11bdc4` jobs (Jobs, the per-job boundary): broken: the daily's message not stored
  (recordings red), a failed post keeping its claim (red), a no-votes recap keeping its claim
  (red); one failing job stopping the rest, posting an hour early and a failed thread failing the
  post stayed green: tests `6a06611`, red since.
- 2026-11-11 `ae0c46e` config (AppConfig, Overrides, the bridge): tests 1, 2, 5. Broken: `quiet`
  ignoring Overrides (red), the bridge dropping stand-in players (red), a secret not redacted (red).
- 2026-11-11 `35b4a40` logging (logfmt): broken by dropping the logger layer (red).
- 2026-11-11 `6fa6110` db (PgClient pool, Drizzle Effect database, Effect migrator): broken: no
  int8 codec (red), no statement_timeout (red), migrator without its lock (red).
- 2026-11-11 `a292296` channels + discord (tests 3, 4): broken: POST retried on 5xx (red), back-off
  300 → 200 ms (red), `isFinished` not reading the errors tree (red).
- 2026-11-11 `dd1d940` memeshame (MemeShame): broken: the person's claim skipped (red), no cooldown
  (red), from 18:00 (red). Stayed green, tests added (`b319b5b`), red since: a failed call-out
  keeping the day's claim, three in a row not enough, a fresh meme counted.
- 2026-11-11 `b96dd12` cleanup (Cleanup): broken: deleted cards not forgotten (red), recaps swept
  (red), old messages bulk-deleted (red). Stayed green, tests added (`582aa5a`), red since: a
  failed sweep keeping its claim, only the first page looked at, a started night's card swept.
- 2026-11-11 `8ee1b4c` hub (Hub): nothing tested hub.ts; all three breaks (the top 25 only, the
  remove menu's order, the guide's channels) stayed green until `9449280` added tests, red since.
- 2026-11-11 `572bd89` activity (Activity): broken: a stay not extended (red), an unseen end taken
  as seen (red), a quiet period posted (red), recaps from 09:00 (red). Stayed green, tests added
  (`068e972`), red since: a failed recap keeping its claim, the month's recap on the 2nd.
- 2026-11-11 `cbd3b66` polls (Polls): broken: the message not remembered (red), one vote as a
  decision (red), a split closed (red), a split kept secret (red), not everyone needed to decide
  (red). Stayed green, test added (`a1f80c3`), red since: the vote kept on a second tap.
- 2026-11-11 `78d83a6` late (LateSlips): broken: the slip id not saved (red), a failed slip keeping
  its claim (red), one player's trouble stopping the others (red), anyone answering a slip (red).
  Stayed green, tests added (`aae5f7c`), red since: moving someone again after they arrived,
  marking a latecomer arrived before the move. Test 6 entry: the late watcher's slip.
- 2026-11-11 `85ab8cf` gamenight 5/5 (the start, the service): broken: the night not counted as
  played (red), a moved start started at the old time (red), a failed start keeping its claim
  (red), the ping before the moves (recordings red). Stayed green, tests added (`a0f867e`), red
  since: the ping before its second, a failed merge stopping the start. Test 6 entries: the card,
  the start, the roast (each red with its region interruptible).
- 2026-11-11 `f5cb909` gamenight 4/5 (maintain, maintainNight, resume): broken: the
  maybes kept after a hold (red), the roast before the card shows it's off (recordings red), the
  split warning to nobody (red). Stayed green, tests added (`9230ea2`), red since: reminders from
  08:00, one night's failure stopping the others, the catch-up window halved, the times refreshed
  every 10 min. An unused vote read in maintainNight was dropped (nothing used its result).
- 2026-11-11 `ef1831d` gamenight 3/5 (act, settle, hold, late, lock-in, bails, the roast): broken:
  reopen keeping the old votes (red), a maybe saving a no (red), a failed roast keeping its claim
  (red), the hold not counted (red), a live event deleted instead of ended (red), a second tap not
  taking a delay back (red), the it's-on ping before the event (recordings red). Stayed green,
  test added (`f7b5f8b`), red since: the moved event's new end not stored.
- 2026-11-11 `b230588` gamenight 2/5 (the card's lifecycle): broken: a hand-deleted
  card not forgotten (red), a quiet close roasting anyway (red), the racing duplicate kept (red),
  open cards closed as stale (red). Stayed green, tests added (`c2df056`), red since: the nudge
  cleared before a stage flip that loses, no alert for a card that can't post. The card's
  claim → post → record is uninterruptible from here; its test 6 entry comes with the service
  (5/5), which gives a test a way to call it.
- 2026-11-11 `164d512` gamenight 1/5 (readers, helpers, the card): broken: the nudge id not
  stored (recordings red), the new nudge before the old one goes (recordings red), a planned day
  closing before noon (red). Stayed green, tests added (`848c389`), red since: a gone nudge
  failing the next one, start times revealed after the first pick, the leave-by prefill.
- 2026-11-11 `40adbeb` spontaneous (Spontaneous): broken: the line id not saved (red), a swept
  line as a failure (recordings red), the question not given back (red), a ready room with
  detection off (red). Stayed green, tests added (`f2ec221`), red since: moving before the
  pull-in claim, plays counted without the claim, a failed note failing the pull-in, a failed
  move back stopping the others. (A first "swap" there only moved the early return; the claim
  still ran first. A swap must move the side effect itself.)
- 2026-11-11 `c12e747` reddit (Reddit: Ref + FiberHandle, retry Schedule): broken: the try not
  remembered (red), a failure stale at once (red), lastOk set before the refill (red). Stayed
  green, test added (`821e8e4`), red since: 503 not retried, the back-off doubled, a 429's reset
  ignored.
- 2026-11-11 `70c21e4` attendance (Attendances): broken: the slip id not saved
  (red), rendering before the ETA is written (red). Stayed green, tests added (`f0e40c9`), red
  since: a failed voice lookup as in the room, a failed slip edit failing the tap, retiring the
  slip of someone who made it.
- 2026-11-11 `21033ad` voice (Voice): broken: last_seen not written after a move (recordings
  red), a 404 voice state as a failure (red), a hand-deleted room as still there (red), the event
  not ended (red), the placeholder kept after a failed creation (red). Stayed green, tests added
  (`e9379ac`), red since: moving only when asked, the 3-day TTL off by one, marking a room
  archived before Discord moved it, slotting a new room under the Lobby before its row has the id.
- 2026-11-11 `b327d0e` snooze (Snoozes): broken: snooze row not written (red), the until-day
  boundary `day <= until` (stayed green: test `abafb58` added, red since), wake not announced (red).
- 2026-11-11 `696ded5` gemini: broken: budget not counted (red), budget off by one (red), answer
  dropped (red). The per-call key of the old env travels through `LegacyGeminiKey` (bridge).
- 2026-11-11 `a355258` panels (test 7 `2cc538e`): broken: expired copies kept (red), a failed
  edit's branch (red), a tap not renewing (red); test 7 red without the per-card lock and with
  one shared lock.
- 2026-11-11 `d0ba22e` roasts (Random): broken: bag not saved (red), refill every draw (red);
  "may open a cycle with the last line" stayed green: test added (`cc1104e`), red since.
- 2026-11-11 `152c71f` memes: broken: claim counting a refusal (red), the vote toggle (red),
  setMessage skipped (red); streaks never growing stayed green: test added (`3bd2409`), red
  since. Exposed: `unclaimRecap` was never executed by any test (G3); tested now.
- 2026-11-11 `3c31df2` localtime, games, nights: broken: game insert skipped (red), blank-name
  branch flipped (red), isOver's stage branch (red), Friday as weekend (red), emoji ignored (red).
- 2026-11-11 `740e1f6` alerts, background, presence, lifecycle: broken: a repeat not counted (red),
  the burst cap's branch (red), the DM channel not remembered (recordings red), a background
  failure not reported (red); presence emitting before a snapshot and a snapshot reporting no
  changes, and the channel cache's `remove` doing nothing, stayed green: tests added
  (`test/presence.test.ts`), red on each since. The channel cache ignoring `upsert` before its
  snapshot is unobservable (not ready reads as null, and only a snapshot makes it ready, replacing
  everything): an equivalent change. Lifecycle is only reached from main.ts: tests 11-13 (phase 5).

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

- **2026-11-12, G6: the signature verifier moved into its boundary file** (phase 5, the HTTP step):
  `verifySignature` left `discord.ts` for `src/verify.ts`, the boundary file architecture §16 names
  for it ("crypto.subtle calls wrapped once in Effect.tryPromise"). The outside counts fell by the
  same amount; the saved inside counts were raised by hand for exactly this move (`async` 5 → 6,
  `Effect.tryPromise` 0 → 1). No other count changed.
- **2026-11-11, G6's transition column (`8194406`), declared here as well as under Deviations:**
  lines marked `LEGACY-BRIDGE` are counted in a column of their own that may grow until phase 5;
  `--final` requires it empty, and the NEVER moves are refused there.
- **2026-11-11, gate changes in phase 3 (from its audit):**
  - G6 (`leftovers.mjs`): lines marked `LEGACY-BRIDGE` are counted in a column of their own
    ("in transition code"), not as old-style code; that column may grow until phase 5 and must be
    empty at `--final`. `: any`, `as any`, `Effect.orDie`, `@ts-` and `@effect-diagnostics` are
    refused on marked lines too.
  - G4 (`recordings.mjs`): every recording at the tag `baseline` and at HEAD must be produced again
    unchanged, key by key; new test files and new tests may add recordings (verification.md §3
    said "`git status` shows the recordings untouched", which can't allow a new test's recording).
  - G3 (`qcov.py`): the pattern also counts the Effect database's queries (`db.select…`); still
    210 sites. A one-line exported arrow (`export const f = (env) => env.db…`) was counted as run
    because its declaration runs at module load, so moving such a query into a service can expose
    an untested query (it did: `unclaimRecap`, now tested).
- **2026-11-11, setup changes in phase 3:** the harness builds the app's runtime once per test
  file, from that file's env (a test that changes `GUILD_ID`, `DISCORD_APP_ID` or the token per
  call isn't seen by the services; none does); its pool keeps the 5 s acquire timeout until the
  tests run under TestClock (phase 6, spike S7). `resilience.test.ts` and `time.test.ts` use the
  harness for its runtime.
- **2026-11-11, small behaviour differences found by the phase 3 audit, kept:** an empty optional
  variable (`PORT`, `POST_HOUR_UTC`, `GAME_POLL_HOUR`, `TIMEZONE`, `SUBREDDIT`) now gets its default
  (the old code kept `""`, so `Number("")` gave hour 0); a failed body read on a Discord 4xx gives
  empty text (the old code threw another error); the "X failed" log line prints its context with
  `String()`, and "presence listener failed" loses the stack.

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
  copy's message right after the tap, in the background; the same lookup also serves the poll
  card and `/meme`, interactions.ts, whose ids are then stored) is recorded as its own list after the
  other calls, in its own order. The stub answers these with ids from their own range (first id +
  700,000), so when the read lands doesn't shift the ids of everything else. Shown: three flows
  panel tests and the paths copy test changed under jitter only through this read's position and
  the ids that followed; stable with it.
- **Declared races** (`h.race(reason, { mask, bodies, calls })`), each a test whose point is
  several callers at once. A create the bot deletes again in the same test cancels out with its
  delete, ids in URLs are masked, calls sorted; the database is hashed in full except the named
  winner-dependent columns (every numeric URL segment of three digits or more is masked, not
  only the racing ids):
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
- **Masked values:** `roast_bags.updated_at` and `settings.updated_at` where the value is within 10
  minutes of the real wall clock: the database's own `now()` (a heuristic: a value the bot wrote
  from the real clock would be masked too; under the fake clock the bot writes 2026-11-06..10); where the bot writes the
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
- **`ignoreEffectWarningsInTscExitCode: true`** (tsconfig), so the old-code warnings don't fail G1
  until they flip to errors at the end of phase 5; then the option goes. Rules that default to
  warning and matter now (`duplicatePackage`, `layerMergeAllWithDependencies`) are set to error.
- **Leader loss detection (audit of phase 2; supersedes the "5 s ping" wording above):** today `pg`'s `end` event ends the term at once;
  the Effect client reports nothing until a statement fails. The term pings every **1 s** (not 5)
  with a 2 s timeout and TCP keepalive on, so two copies lead at the same time for about a second
  at most (the other copy's lock poll is 1 s anyway). Every guard is in the database, so a brief
  overlap can't duplicate anything; noted as a near-difference, not an intended one.
- **HTTP during shutdown (audit of phase 2):** Fastify (`return503OnClosing`) answered 503 to a
  request on a connection still open while closing; the Effect server stops accepting connections
  and finishes those in flight. Caddy retries a refused connection on the other copy, so this is
  at least as good; `/health` still answers 503 first, as today.
- **An oversized body (audit of phase 2):** answers 500 `{ "error": ... }` as today, and is not
  alerted (Fastify's statusCode for it was 413; only 500s alerted).
- **int8 beyond `Number.MAX_SAFE_INTEGER`:** the codec fails the query where `pg` silently
  rounded; no column comes close (unix seconds and counts).
- **Service keys:** the `deterministicKeys` rule (error level) wants `meme-bot/<path>` and adds the
  class name only when it differs from the file name (`meme-bot/db/db` for `Db`), close to the
  plan's `meme-bot/<file>/<Class>`; the rule is followed.
- **No trace headers outbound** (`HttpClient.TracerPropagationEnabled` false): our trace ids are
  no business of Discord's. Found because the tracer draws span ids from `Math.random`, which the
  harness seeds per test for the roast shuffle: with propagation on, every request consumed
  random numbers and shifted the roasts (654 recordings differed). Until roasts use Effect's
  `Random` (phase 4), anything in Effect that draws from `Math.random` during a test would shift
  them again; the recordings would show it.
- **Discord retries give up without a final sleep:** the old loop slept its back-off after the
  last failed attempt too, then gave up; the schedule gives up at once. Same attempts and the same
  delays between them; a failing call returns 2.4 s sooner.
- **The alert time is when the problem was reported**, not when the queued DM goes out (the old
  promise chain read the clock in the same tick as the report, so the meaning is unchanged).
- **`legacy.runDetached`** for promise code calling Effect code that needs no per-call overrides
  (the tests' `_settle`, `drain`); `legacy.run` carries the old env's QUIET and PLAYERS.
- **The alert sender is a sixth boundary** (architecture.md §6 amended): it catches everything a
  send lets through, logs it and goes on, as the old promise chain's `.catch` did, because a
  defect there must not stop every later alert.
- **Discord: the whole attempt is timed** (request and reading the answer, as `AbortSignal.timeout`
  covered `r.json()`); a 2xx that can't be read fails at once as `DiscordUnexpected` (the old code
  threw at once and never re-sent a request that had gone through). The passthrough upper-cases
  the method (`dc.py get …` worked through fetch). Found by the phase 3 audit; tested.
- **The migrator's connection has the pool's limits** (statement_timeout 30 s, idle in transaction
  60 s): a migration stuck behind a lock during a deploy fails startup after 30 s instead of
  stalling the copy still serving. Found by the phase 3 audit.
- **`withOverrides`** merges an override into the current ones; providing `Overrides` replaces the
  whole value, which would drop an outer call's stand-in players. **`allowedMentions`** is the
  quiet-aware "who may be pinged" every ping uses.
- **GameNight is module-level Effect functions plus a thin service** (`85ab8cf`): each function
  takes its services from R; `GameNight.layer` captures them once and provides them to each
  method (`Effect.provideContext` merges over the caller's context, so per-call `Overrides`
  still come from the caller; checked in effect's source). The other services use closures in
  their layer; this shape let GameNight move in five green commits.
- **Discord answers read only the fields the bot uses** (phase 4, Voice): `editChannel` reads
  nothing, `createChannel` only the id, a voice state's `channel_id` may be missing (= not in
  voice, as `s?.channel_id ?? null` had it). The old code read nothing else, so a short answer
  must not become `DiscordUnexpected`.
- **A claim is given back only when the post failed, even where the old code gave it back later**
  (phase 4 audit): `claimStart` released its claim when anything after the start ping failed (the
  play count), so the next minute ran the whole start again and pinged twice. Now only a failed
  ping releases it; a later failure is reported ("counting the night as played") and the claim
  stays (architecture §15.2, and the no-duplicates rule). Test `322bb29`.
- **Per-item loops isolate typed failures, not defects** (§6; phase 4 audit): the old per-night,
  per-player and per-room `try/catch` caught everything. The new ones handle typed errors (a defect
  reaches the job runner's boundary, which reports it and runs the next minute). The one defect a
  loop used to meet in practice, a night row that vanished mid-run (`!` on the lookup), is a typed
  `NightGone` now, so it stays that night's. The "one night's trouble…" comments hold for that.
- **Uninterruptible regions can include waits** (phase 4 audit): a ready room, an auto-move and a
  pick on the Lobby question call `openRoom` inside their region, so its wait for another tap's
  room (up to 14 s) and Discord's retries are uninterruptible there too (the claim before them must
  be followed through). Shutdown's 35 s cap still ends the process, as it ended the old promises.
- **The ticker is a §6 boundary** (phase 5, step 4; architecture.md §6 amended): today each minute
  (`tick().catch(…"the minute jobs")`) and each start timer (`.catch(…"starting the game night on
  time")`) reports whatever it lets through and the clock goes on. Kept: one `catchCause` for each,
  same wording, interrupts re-raised. Without it a defect would end the leader's clock silently
  (the watchdog only sees a minute that runs too long, not one that never comes).
- **A term's end interrupts the running minute** (phase 5, step 4): the old `stop()` waited for it.
  Every claim in the minute's jobs is uninterruptible from the claim on (test 6), so an interrupted
  minute leaves each job done or not started, and `stop` returns once nothing of the term runs
  (the old one could hand over while a slow minute still ran past shutdown's 15 s).
- **Reddit's refill fiber is background work** (a §6 boundary, like `Background`'s tasks): its
  `catchCause` reports any failure with the refill's own rule (logged while the pool is fresh, a DM
  after 12 h). architecture.md §6 amended.

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
- **Recordings depend on a test's place in its file:** tables with serial ids (`games`) are
  emptied between tests but their sequences run on, so a test added in the middle of a file
  changes every later test's database snapshot. New tests go at the end of their file.
- **`scripts/import-d1.ts` (the one-off D1 move) was already broken before plan 05:** it uses
  `s.tiebreaks`, a table gone since before the baseline. Plan 05 also removed the migrator it
  called; that part is fixed (`b1fa4f1`: it checks the database is migrated and says how). The
  tiebreaks part is left as found.
- **Discord answers handled by logging or ignoring them** (architecture §6's record rule):
  - ignored: a slip edit (attendance `etaOnSlip`, `retireSlips`; late `updateSlip`), the old nudge's
    delete (`clearNudge`), the racing duplicate card's delete (`openNight`), a bail's event end or
    delete (`afterBail`), `resetNight`'s deletes, the sweep's one-by-one deletes, the empty archive
    category's delete and the archived room's event end (voice), the Spontaneous message deletes
    (`deleteMessage`: a 404 is fine, anything else is logged);
  - a 404 taken as "gone": a hand-deleted card (`refreshCard` forgets its id), a session line swept
    at 03:00 (`editLine`), a voice state (not in voice), a room's channel (`openRoom` recreates
    it), an archived room's delete;
  - logged only: the event going live (`startReminder`), the card refresh at the start, a room
    note (`note`), a move back to the Lobby (`goBack`), a failed voice lookup (late, Spontaneous).
- **Phase 5 must make these one uninterruptible Effect each** (phase 4 audit): the daily meme
  (`jobs.ts`), the meme recaps (`jobs.ts`) and `/meme` (`interactions.ts`) are still promise code,
  each step its own bridge call, so today an interrupted run would release the claim. When they
  move, claim → post → record is one region and a claim is released only on a typed failure.
- **Small differences the audit listed, kept:** the roast's emoji lookup is inside the claim's
  giveback (a failure there retries the roast instead of losing it); a malformed snooze row or
  reddit times count as empty; a channel listing that fails its schema fails the sweep (retried
  the next minute); an empty legacy Gemini key on an old env spends a budget request; a webhook
  answer whose body can't be read is treated as none (re-sent; the private copy's row goes).
- **Process: the catch tables (verification.md §5 step 7) weren't put in the phase 3 and 4 commit
  messages.** Every old `catch` was accounted for in the code (each became a tagged handler or is
  owned by a boundary) and the phase 4 audit checked them line by line; from phase 5 on each
  module's commit message carries the table.
- **Process notes (phase 4 audit):** `78d83a6` and `85ab8cf` put test 6 entries in the code's own
  commit (pure additions); `c97fb91` converted three phase 3 config tests to `it.effect` in place
  (assertions unchanged, the ledger says identical).
- **The assertion ledger keys assertions by enclosing function:** a test file's table of cases at
  top level is one entry, which may not grow; new cases go in a function of their own.
- **`secret()` has a branch nothing reaches:** the game stage's (the card's game stage decides
  "split" itself and never asks). Harmless; noted, not changed.
- **`vi.waitFor` moves the fake clock** on every poll when fake timers are on (Date only, here),
  so a long wait shifts any time the code stores. Waits that long poll on real `setTimeout`.
- **Not under the harness:** `resilience.test.ts` (fake timers, its own pool) and `time.test.ts`
  (pure functions) have no recordings; their assertions are in the ledger.


- **Migrations across Drizzle 0.45 and 1.0 (found in phase 1, corrected after the audit):**
  the rollback target `pre-effect` is Drizzle 1.0 code, so rolling back after the cutover meets no
  0.45 migrator. The 0.45 migrator is the old `main` (`f401685`) and older; three hazards apply
  only if one of those runs on a database 1.0 has touched, or 1.0 runs after them:
  - 1.0 writes `created_at` at whole seconds; 0.45 applies every journal entry whose millisecond
    `when` is greater than the latest `created_at`, so a migration both know, applied by 1.0, is
    re-run by 0.45 ("already exists"). Proven locally on a database first built by 1.0.
  - 1.0's one-time upgrade of the migrations table throws when a row matches no local migration.
    **This happened on the test bot:** the paused `wow-news` branch had applied its
    `0013_news.sql` there (row id 15), so the first `drizzle-1` deploy failed its health check
    (blue/green kept the old copy). The row was set aside (copied to
    `drizzle.plan05_set_aside` in `meme_bot_dev`, then deleted from the migrations table); the
    `news_items` table and its data stay. When plan 02 is merged, its migration must be converted
    to the 1.0 layout, and on the test bot either that table is dropped first or the row is put
    back with its `name`. Production has the 13 known rows only (checked read-only).
  - After the upgrade, rows the 0.45 migrator writes have `name` NULL and are never backfilled;
    1.0 matches by name, so it would re-run such a migration. Only if old code with a new
    migration is deployed after 1.0 has run.
- **drizzle-kit 1.0 rc.5 and partial indexes:** `drizzle-kit generate` with no schema change
  proposes dropping and recreating the five partial indexes (`one_daily_per_day`,
  `memes_posted`, `memes_pool`, `voice_segments_one_open`, `lobby_prompts_current`): it writes
  their WHERE clause differently from the converted snapshots. Not a real change; deleted. Any
  future `generate` must drop those lines from its output.
Bugs and weak spots in the existing behaviour, noticed during the migration and deliberately not
fixed in it. For the owner to prioritise after the cutover.

## Drill and soak results (phase 8)
