# 05 · Move the whole bot to Effect

> **Owner's change of plan, 2026-11-11 (overrides every file in this folder where they disagree).**
> The bot is not mission-critical; if production breaks, the owner asks for a fix. The migration
> is done in hours, not days: optimise for finishing.
>
> **Removed:** every calendar wait (no "one evening in production", no 48-hour soak, no waiting
> for a morning). The cutover question: the go is given in advance; when the work is done and
> green, merge to `main` and deploy to production, then tell the owner it is live. Waiting for
> plan 02: if it isn't on `origin/main` when the baseline is taken, take the baseline without it;
> when it lands, merge it in like any other change (port it to Effect if its module has moved,
> record its tests, re-run `drizzle-kit up` if its migration arrives in the old folder format).
> Separate production landings for phases 0 and 1: all work is on one branch, `effect`, shipped
> once at the end; phase 1 stays as a step, proven by the tests and one test-bot deploy. The
> rollback rehearsals, the fault drills, `scripts/soak_watch.py`, the tap-timing and memory
> comparisons. The audit after every phase: one audit, before the cutover. "Break it on purpose"
> only for modules with a claim → post → record sequence. Phase notes: one message at the end,
> plus one if genuinely stuck. `qa_maybe_matrix.py` (the 401-case vitest matrix covers it).
>
> **Kept:** the recordings, the assertion ledger, the type and diagnostic gates, the tests and
> query coverage, run before every commit. RUN.md §5 (never weaken a check). The phase 2 spikes,
> done quickly; if one fails, pick the sound alternative and note it; stop only if there is none.
> Everything in `architecture.md` and "done" as defined below: less ceremony, not a smaller
> migration. The new tests in `verification.md` §7 (test 16 uses a 60 s job timeout, no log
> research). Before the cutover: deploy the branch to the test bot and run `qa_all.py`,
> `qa_timing.py`, `qa_rooms.py`, `qa_stats.py`, `qa_spontaneous.py`; if they match their
> baseline, ship. The browser tap test if Discord is logged in in the T3 browser; otherwise skip
> it and say so. The rules that protect the trio: QA only against the test bot; no pings to real
> people from tests; claims stay in the database; no production deploy while someone is in voice
> or a night is about to start (check; if so, retry in 30 minutes); never touch `C:\p\meme-bot`
> or secrets. After the cutover, if production breaks, fix forward or revert, whichever is
> quicker, and tell the owner.
>
> **Stopping:** only when truly stuck with no sound alternative, or when a Discord login is
> needed for something that can't be skipped. Otherwise the run doesn't end until production runs
> the migrated bot. The backstop task stays.


Read `../README.md` first (the house rules still apply). Then read, in this order:

1. this file: the goal, the decisions already made, the rules that always apply
2. [`RUN.md`](RUN.md): how to carry the plan to the end without stopping, and what you may do
   without asking
3. [`architecture.md`](architecture.md): what the finished code looks like
4. [`verification.md`](verification.md): how the work proves itself at every step
5. [`phases.md`](phases.md): the order of work, with exit criteria per phase
6. [`STATUS.md`](STATUS.md): where the work stands right now (update it constantly)

This is a long job, done as one continuous run: the session works through the phases without
waiting to be told to continue (`RUN.md`). "Session" below means any stretch of that work.

## Why

The owner decided on 2026-11-11 to move the entire bot (`bot/src`, about 7,000 lines, and
`bot/test`, about 3,100 lines) to [Effect](https://effect.website) version 4. The reason is how
the codebase behaves as it grows, not any single past bug:

- how a function can fail should be visible in its type, not discovered by reading `catch` blocks
- retries, timeouts, timers, background work and shutdown should use one shared vocabulary instead
  of a hand-written version in each module
- everything that crosses a boundary (Discord, Reddit, HTTP requests, the environment) should be
  validated where it enters
- time should be controllable in tests, so exact-second behaviour can be unit-tested
- every request, job and query should be traceable

The owner's instruction: a full migration with no shortcuts, which uses Effect's features wherever
they fit, not Effect syntax wrapped around the old design.

## What "done" means

All of these are true on `main`, in production:

1. **No promise-style code is left in `bot/src`.** No `async`/`await`, `try`/`catch`, `.then`,
   `.catch`, `new Promise`, `setTimeout`/`setInterval`, `AbortController`, global `fetch`,
   `console.*`, `Date.now()`/`new Date()`, `Math.random()`, `process.env` or `any`. The only
   exceptions are the boundary files listed in `architecture.md` §16, each with a comment saying why.
2. **No module-level mutable state.** Every `let`/`Map`/`Set` at module scope listed in
   `architecture.md` §4 lives inside a service, and every `_reset()` test hook is gone.
3. **Every feature in the adoption table (`architecture.md` §3) is in real use**, at the places
   that table names.
4. **Fastify, direct `pg` use and the `Env` object are gone.** HTTP runs on `effect/http`, the
   database on `@effect/sql-pg` with Drizzle's Effect driver, configuration on `Config`.
5. **Tests are Effect-native:** `@effect/vitest`, layers instead of global stubs, `TestClock`
   instead of fake `Date`. There are at least as many tests as at the baseline, plus the new ones
   `verification.md` §7 requires.
6. **Every gate in `verification.md` §3 is green**, the live QA suites pass on the test bot, the
   soak and the fault drills are done, and production has run one full evening on the new code.
7. **The trio noticed nothing**, except that it keeps working.

## Decisions already made

Don't reopen these without the owner. If one of them turns out to be impossible, stop and report.

| Decision | Choice | Why |
|---|---|---|
| Effect version | `effect` 4.1.x (exact pin), never 3.x | 4 is the current major; its packages share one version number |
| How to migrate | A long-lived `effect` branch, migrated bottom-up in phases, each phase green; one production cutover at the end. Two preparations ship earlier, on the old code: the test baseline (phase 0) and the Drizzle upgrade (phase 1) | Half-migrated code never has to be production-grade, rollback is one image, and the riskiest dependency is proven in production on its own |
| Features meanwhile | Frozen. Only production fixes go to `main`, and each is merged into `effect` the same day | A moving target would invalidate the baseline the migration is checked against |
| Database access | Keep the Drizzle schema and query builder; move to `drizzle-orm` 1.0 (release candidate, exact pin) and its Effect driver on `@effect/sql-pg` | Queries become Effects with typed errors and spans, without rewriting about 130 queries as raw SQL |
| HTTP server | Replace Fastify with `effect/http` `HttpRouter` on `NodeHttpServer` | Handlers are Effects; requests get spans and validated bodies |
| Discord REST | Our own `Discord` service on `effect/http` `HttpClient` | The retry rules ("never retry a POST that may have gone through") are business rules; they stay ours |
| Discord gateway | Keep `@discordjs/ws`, wrapped as a scoped resource | Proven heartbeat and resume logic; replacing the protocol client is a separate risk |
| Not adopted | `dfx` (an Effect Discord library), `HttpApi`, cluster, workflow, RPC, STM | Each changes behaviour or adds machinery this bot has no use for; see `architecture.md` §17 |
| Database schema | No schema change during the migration | The old and new code can run side by side, and rollback is always safe |
| Behaviour | Identical, except the six differences listed below | The migration is checked against recordings of the old behaviour |

## What must not change

- Anything the trio sees or taps: every message, card, ping, timing and rule.
- The database schema and the meaning of every column.
- The HTTP contract: paths, request bodies, response bodies and status codes of `/interactions`,
  `/ingest`, `/health` and every `/admin/*` route. The Python QA scripts and the server's
  watchdog depend on them. `/health` keeps exactly these fields: `ok`, `leader`, `clock`,
  `gateway`, `background`, `uptime`, `version` (and `shuttingDown`/`db` on a 503).
- Deployment: the same image layout, the same environment variables, blue/green, one leader.
- The durable guards. Claims, unique keys and stored timestamps stay in Postgres. An in-memory
  Effect primitive (a `Ref`, a `Queue`, a `Semaphore`) lives in one process and dies with it, and
  two copies run during every deploy. Never move a guard from the database into memory.

## Intended differences (the complete list)

Anything else that differs from the old behaviour is a bug.

1. Discord errors are told apart by HTTP status and Discord's error code, not by searching the
   error text. This removes false matches (today `voice.ts` treats any error whose text contains
   `10065` as "not in voice", and the text includes user and server ids).
2. Log lines are structured (level, message, annotations, span). The phrases a human greps for
   stay, see `architecture.md` §14.
3. Secrets are `Redacted` values and cannot be printed.
4. A request body that doesn't match its schema gets a `400` with an error, where today it is
   silently treated as an empty object.
5. A stuck job is interrupted after its timeout and the next job runs (phase 7). Today the only
   remedy is the whole-process restart after five minutes, which stays as the last resort.
6. On shutdown, sleeping timers are interrupted at once. The guarantees stay: a game-night start
   that has begun finishes, and background work gets 20 seconds to drain.

## Rules for every session

**Before touching anything**

- Read `STATUS.md`. Work in the migration's own worktree, on the branch for the current phase
  (`RUN.md` §1 and §3), never in the owner's checkout. `git status` must be clean.
- Open the database tunnel: `ssh -f -N -L 55432:127.0.0.1:5432 vps`.
- Run the gates (`verification.md` §3). They must be green before you start. If they aren't, that
  is the first thing to fix or report.

**Effect 4 is not the Effect you remember**

- Most Effect code you have seen is version 3. Version 4 renamed and removed a lot. Treat
  anything you write from memory as wrong until checked.
- The sources of truth, in this order: `bot/node_modules/effect/AGENTS.md`, the examples in
  `bot/node_modules/effect/ai-docs/src/`, the `.d.ts` files in `node_modules` (their doc comments
  are thorough), and the migration notes at `github.com/Effect-TS/effect/tree/main/migration`.
  Never use the documentation site or a web search for API shapes; much of it describes version 3.
- `architecture.md` §2 lists the version 3 habits that are wrong in version 4.
- The `outdatedApi` diagnostic is an error in this repo. Don't silence it.

**While working**

- Translate first, improve second. A module's first Effect version keeps the same functions, the
  same order of side effects and the same queries. Restructuring that Effect makes possible comes
  in a separate commit, after the translated module is green.
- Never change code and the checks that guard it in the same commit. `verification.md` §1 says
  what this means in each phase.
- One module per commit. Commit messages say what moved: "Effect: voice rooms run as a service".
- A behaviour question the old code doesn't answer is the owner's to decide. Ask; don't guess.
- If you find a bug in the old behaviour, don't fix it in the migration. Write it down in
  `STATUS.md` under "Found on the way". It gets fixed after the cutover, or on `main` now if it
  is hurting the trio.
- Never push `effect` to `main`, and never deploy it to production, before phase 9. A push to
  `main` deploys to production automatically.
- QA only ever runs against the test bot. Everything in `../README.md` about QA still holds.

**Before ending a turn** (only for the reasons in `RUN.md` §6 and §9)

- All gates green, everything committed and pushed, `STATUS.md` updated (what was done, the gate
  numbers, what comes next, anything surprising, what you are waiting for).
- At the end of a phase, tell the owner in plain words what moved and what you verified, leading
  with the outcome, and keep going.

**Stop and report to the owner when**

- Drizzle 1.0 misbehaves in phase 1, or a spike in phase 2 fails with no sound answer
- a recorded behaviour (`verification.md` §2) can't be reproduced after an honest attempt, and
  the difference isn't on the "intended differences" list
- keeping behaviour identical would require a database schema change
- a production fix on `main` conflicts with migrated code in a way that isn't mechanical

## The owner's part

Agreed on 2026-11-11, and not to be asked again:

- **The freeze**: no new bot features until the cutover (plan 03 waits and is then built
  Effect-native). Production fixes are fine.
- **A release candidate in production**: `drizzle-orm` 1.0 (`rc.5` on that day). Phase 1 puts it
  under the old code and into production on its own, with a rehearsed way back.
- **Phases 0 and 1 ship to production** when their gates are green and the house deploy checks
  hold, without a separate go.

Still the owner's, when the time comes:

1. **The go for the cutover** (phase 9), and the moment: a morning with nobody in voice and no
   night being voted on. Be reachable that evening. This is the one planned question.
2. **Stay logged in to Discord in the T3 browser**, so the session can tap through the
   private-copy path on the test server in phase 8. If it finds the browser logged out it will
   say so.
3. **Optional, later:** a trace viewer on the server. The bot will be able to export traces after
   phase 7; where to look at them is a separate decision (`architecture.md` §14).
