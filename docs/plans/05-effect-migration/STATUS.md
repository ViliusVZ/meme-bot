# 05 · Status

The one place that says where the migration stands. Every session reads this first and updates
it last. Keep it short: facts and numbers, newest entry at the top of each list.

## Where we are

- **Phase:** not started (plan written and agreed by the owner 2026-11-11)
- **Workspace / branch:** none yet (`RUN.md` §1 sets them up)
- **Backstop task id:** none yet
- **Next step:** `RUN.md` §1 (setup), then phase 0, step 1. On 2026-11-11 plan 02 (news) was
  still in progress on the `wow-news` branch in the owner's checkout, with uncommitted work;
  `origin/main` was at `f401685`. The baseline waits for it (`RUN.md` §3).
- **Waiting for:** nothing
- **Blocked on the owner:** nothing. The freeze, Drizzle 1.0 rc in production, and shipping
  phases 0 and 1 are agreed. The cutover go is asked for at the end of phase 8.

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
| Tests passed | | |
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

Every place the work departed from `architecture.md`, `verification.md` or `phases.md`, with the
reason, and whether the plan file was amended.

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
