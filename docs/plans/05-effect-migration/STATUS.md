# 05 · Status

The one place that says where the migration stands. Every session reads this first and updates
it last. Keep it short: facts and numbers, newest entry at the top of each list.

## Where we are

- **Phase:** 0 (baseline and preparation), started 2026-11-11 15:00
- **Workspace / branch:** `C:\p\meme-bot-effect`, branch `effect` (one branch for everything,
  owner's change of plan 2026-11-11)
- **Backstop task id:** (see below once created)
- **Next step:** phase 0 step 1 (qcov.py into the repo, then the assertion ledger)
- **Waiting for:** nothing. Plan 02 is not waited for (owner, 2026-11-11); `origin/main` was at
  `f401685`, plan 02 still on `wow-news`, unmerged.
- **Blocked on the owner:** nothing. The cutover go was given in advance (2026-11-11).

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

Fill the baseline column in phase 0. Update "now" at the end of every session.

| Measure | Baseline (phase 0) | Now |
|---|---|---|
| Tests passed | 580 (9 files, 2026-11-11, before any change) | |
| Query sites found / executed | | |
| Recordings differing | 0 | |
| Assertion ledger | identical | |
| Leftovers (G6 total; per-pattern table below) | | |
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

- **2026-11-11, the owner's change of plan** (README.md top block; RUN.md §3 and phases.md
  amended, pointers at the top of RUN, verification, phases): no calendar waits, no soak, drills,
  rollback rehearsals, tap-timing or memory comparisons, no `soak_watch.py`, no
  `qa_maybe_matrix.py`; one branch `effect`, shipped once at the end, the go given in advance;
  plan 02 not waited for; one audit before the cutover; break-it only for claim → post → record
  modules; one message to the owner at the end. Test 16 uses a 60 s job timeout.

## Declared exceptions

- **Unordered call groups** in the recordings (`verification.md` §2a): none yet
- **Assertion changes** (`verification.md` §2b): none yet
- **Diagnostics switched off** in boundary files: none yet

## Decisions taken along the way

Small technical choices the plan left open (which logger, the leader ping interval, each job's
timeout), with the evidence.

## Found on the way

Bugs and weak spots in the existing behaviour, noticed during the migration and deliberately not
fixed in it. For the owner to prioritise after the cutover.

## Drill and soak results (phase 8)
