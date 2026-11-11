# 05 · Running it to the end

For the Opus session that carries this plan out. The owner agreed to the whole plan on
2026-11-11: the feature freeze, Drizzle 1.0 release candidate in production, the phases, and the
authority described here.

**The assignment:** take plan 05 from wherever `STATUS.md` says it stands to the end of phase 9,
without waiting to be told to continue. Finishing a step or a phase is not a reason to stop. The
only reasons to stop are in §9.

The other files say *what* to build and *how to check it*. This file says how to keep going.

## 1. First time only: set up

1. **Your own workspace.** Never work in `C:\p\meme-bot`: it is the owner's checkout, and other
   sessions use it. If your session already runs in its own git worktree, use that. Otherwise:
   `git -C /c/p/meme-bot fetch origin` and
   `git -C /c/p/meme-bot worktree add /c/p/meme-bot-effect -b effect-prep origin/main`.
2. **The ignored files** the tests and QA scripts need: copy `bot/.env.test` and `bot/.env.qa`
   (and `bot/.env` if it exists) from `C:\p\meme-bot\bot\` into your `bot/`. Never commit them,
   never print their contents.
3. `npm ci` in `bot/`, open the tunnel (`ssh -f -N -L 55432:127.0.0.1:5432 vps`), and run the
   tests once to prove the workspace works.
4. **Adopt the plan.** If `docs/plans/05-effect-migration/` isn't in your checkout yet, copy it
   from `C:\p\meme-bot\docs\plans\05-effect-migration\`, together with the plan-05 row and
   paragraph in `docs/plans/README.md`, and commit it as your first commit. From then on the copy
   on your branch is the only one that counts. Don't edit or delete anything in the owner's
   checkout; tell the owner once that the untracked copy there is now stale.
5. **The backstop** (§6).
6. Write the workspace path, the branch and the backstop's id into `STATUS.md`.

## 2. The loop

1. Read `STATUS.md`. Take the next step from `phases.md`.
2. Do it the way `verification.md` says (§5 there is the per-module loop).
3. Run the gates. Commit. Push the branch (branches deploy nothing; only `main` does).
4. Update `STATUS.md`.
5. Go to 1.

At the end of each phase, run the audit (§8), close its findings, post the phase note (§9), and
start the next phase in the same stretch of work.

## 3. Branches

| Work | Branch | Lands on `main` by |
|---|---|---|
| Phase 0 | `effect-prep` | `git push origin effect-prep:main` (fast-forward), when §4 allows |
| Phase 1 | `drizzle-1`, cut from `effect-prep` | the same |
| Phases 2–8 | `effect`, cut from the phase 1 commit | the phase 9 merge commit |

Rebase a preparation branch onto `origin/main` before it lands, and rerun the gates after the
rebase. After you push to `main`, the owner's checkout is simply behind; leave it.

**Plan 02 (the news channel) was still being finished on 2026-11-11**, on a `wow-news` branch.
Start phase 0 at once: steps 1, 2, 3, 5 and 6 don't depend on it. The baseline (steps 4 and 7)
and everything after it wait until plan 02 is on `origin/main`, because the baseline must include
its code, its tests and its migration. Rebase onto it, then take the baseline. If it still isn't
on `main` when you have nothing else left to do, say so to the owner and wait (§6).

**Waiting for "one evening in production" doesn't block the next phase's work.** After phase 0
lands, start phase 1 on its branch immediately; only its landing on `main` waits until phase 0's
evening was clean (the 17:00 Vilnius poll through midnight, logs clean the next morning). After
phase 1 lands, cut `effect` and start phase 2 immediately; place the `pre-effect` tag on the
phase 1 commit once its evening was clean. If that evening turns up a problem, fix it on `main`
as a production fix and merge it into `effect`, as `phases.md` describes.

## 4. What you may do without asking

- Anything in your workspace and on your branches. Push them as often as you like.
- **The test bot is yours** once plan 02 has landed: deploy any branch to it
  (`gh workflow run bot.yml --ref <branch> -f target=dev`), run every QA suite, run the fault
  drills (with `host-watch` paused, as `verification.md` §8 says). Until plan 02 has landed,
  check first that another session isn't mid-test on it (`gh run list --workflow bot.yml`, and
  the version in `/bot-dev/health`).
- **Phases 0 and 1 go to production** when all gates are green and the checks under "Deploying"
  in `../README.md` hold at that moment (nobody in voice, no night voting or about to start).
  If they don't hold, don't push; come back later (§6). After the deploy, do the "after" checks
  from the same section.
- **Rolling back your own change.** If something you shipped in phase 0, 1 or 9 hurts the trio:
  revert and push first, diagnose after, tell the owner what happened.
- Small technical choices the plan leaves open. Record each in `STATUS.md` under "Decisions
  taken along the way", with the evidence.
- Amending `architecture.md`, `verification.md` or `phases.md` when reality disagrees with them.
  Record each under "Deviations from the plan". This never covers §5 below.

**Not without the owner, whatever the circumstances:**

- the phase 9 merge (§10)
- anything that writes to production outside a deploy: no QA against production, no `BOT=prod`
  except read-only checks, no production database edits
- a database schema change
- anything in the owner's checkout or on another session's branch
- new features, and behaviour changes that aren't on the README's list of intended differences

## 5. Never weaken a check to get past it

An unattended run fails in one typical way: a check is red, and the cheapest way forward is to
change the check. Every one of these is forbidden:

- regenerating a recording or the assertion ledger so it matches the new behaviour
- declaring an "unordered call group" without having shown that only the order differs
- deleting, skipping, loosening or rewriting an existing test or assertion
- editing a gate script so it counts less
- switching a diagnostic off, or adding `as any`, `@ts-ignore`, `Effect.orDie` or a catch-all,
  to make an error go away
- raising a timeout or adding a sleep to hide a hang or a race
- marking a spike, drill or QA suite as passed on a partial run

The declared exceptions in `verification.md` (§2a, §2b, §3) exist for the few legitimate cases.
Each one used goes into `STATUS.md` under "Declared exceptions" with the evidence, and the
end-of-phase audit reads that list.

If the old behaviour itself looks wrong, it still has to be reproduced. Write it under "Found on
the way" and carry on.

## 6. Waiting, and not stalling

**Don't end your turn at a step or phase boundary.** When you do have to wait for something in
the world, don't sleep or poll. Schedule your own continuation and end the turn:

- `schedule_task` with `schedule: { type: "once", runAt: … }`, bound to this thread, with the
  prompt `Continue plan 05: read docs/plans/05-effect-migration/RUN.md and STATUS.md, then carry
  on.`
- Before ending the turn, write in `STATUS.md` what you are waiting for and until when.

| Waiting for | Meanwhile | Check again |
|---|---|---|
| Plan 02 to land | the phase 0 steps that don't need it | every 2 hours |
| Deploy conditions (someone in voice, a night voting) | the next phase's branch work | every hour, and not between 16:30 and 01:00 Vilnius |
| An evening in production (phases 0, 1) | the next phase's branch work | the next morning, 09:00 Vilnius |
| The 48-hour soak | anything left of phase 7; otherwise nothing | every 6 hours: read `soak_watch`'s log and the bot's logs |
| A long QA suite or a CI run | nothing short enough to matter | wait on it directly with the harness's background wait |
| The owner | every step that doesn't depend on the answer | when they answer |

**The backstop.** Models end turns they shouldn't, and sessions die. At setup, create one
repeating task: `schedule_task`, `{ type: "interval", everyMs: 21600000 }` (6 hours), bound to
this thread, with the prompt `Backstop for plan 05. If the plan isn't finished, nothing is
running and STATUS.md doesn't say you are waiting on the owner, continue per RUN.md. Otherwise
answer in one line and do nothing.` Pause it (`enabled: false`) while you are stopped for the
owner, re-enable it when work resumes, and delete it at the end of phase 9.

## 7. Staying sharp over a long run

- **`STATUS.md` is your memory.** Your context will be summarised many times. Anything you would
  hate to lose (a decision, a surprising finding, where you are mid-step) goes into `STATUS.md`
  before you rely on remembering it.
- **Re-read** the README's rules, this file, `STATUS.md` and the current phase's sections at the
  start of every phase, and whenever you notice your context was summarised.
- **Effect 4 from the package, not from memory.** This doesn't wear off with familiarity. Before
  using an API for the first time in a module, open its `.d.ts`.
- **Commit small and push often**, so a dead session loses minutes. If you start and find
  uncommitted changes from an earlier stretch: if the gates are green, commit them; if not,
  stash them, note it in `STATUS.md`, and redo the step.
- **Fresh eyes are cheap; use them.** Subagents start without your accumulated assumptions:
  - the end-of-phase audit (§8), always
  - a second opinion whenever you have failed at the same thing twice: give it the evidence, not
    your theory
  - a single module's translation in phase 4, if you want: give it the module, the loop
    (`verification.md` §5), the style and error rules (`architecture.md` §5, §6), and tell it
    not to commit. You run the gates and read the whole diff yourself.
  Never two writers in one working tree at the same time.
- **When something resists:** three honest attempts, each with a different idea. Then write down
  in `STATUS.md` what you tried and what you saw, re-read the relevant `.d.ts` files and docs
  from scratch, and get a second opinion. If it is on the stop list (§9), stop. If not and other
  steps don't depend on it, park it (say so in `STATUS.md`) and continue. Never work around a
  dependency by skipping it.

## 8. The end-of-phase audit

Before a phase counts as done, start a fresh subagent, read-only, with this brief (fill in the
phase and the commit range):

> You are auditing phase N of an Effect migration (`docs/plans/05-effect-migration/`). Read
> README.md, RUN.md §5, and the phase's section in phases.md. Then, for commits A..B:
> 1. **Checks intact.** Diff the gate scripts, `test/__recordings__/`, the assertion ledger and
>    `tsconfig.json`'s diagnostic settings against the phase 0 baseline. Every difference must
>    be listed in STATUS.md under "Declared exceptions" or be a pure addition.
> 2. **Forbidden moves.** Search the phase's diff for: catch-alls outside the five boundaries in
>    architecture.md §6, `Effect.orDie`, `as any`, `: any`, `@ts-`, `@effect-diagnostics`,
>    skipped or deleted tests, changed timeouts.
> 3. **Version 3 leftovers.** Any API from the right-hand column of architecture.md §2.
> 4. **Behaviour.** For each module moved in this phase, pick three functions and compare old
>    and new line by line (`git show <before>:<file>`): the order of side effects, every error
>    branch, what happens when a Discord call fails, what runs in the background.
> 5. **Interruption.** Every claim → post → record sequence in the diff is uninterruptible, and
>    claims are released only on a typed failure.
> 6. **Lost knowledge.** Comments explaining *why* that existed before and are gone.
> Report findings with file and line, most serious first. Don't fix anything.

Fix every finding, or record under "Found on the way" why it isn't one. Then the phase is done.

## 9. Talking to the owner

**Tell, don't ask.** At the end of every phase post a short note in the thread: what now runs on
what, what you checked and the numbers, anything that didn't go to plan, what you are starting
next. Plain words, outcome first. Then keep working; don't wait for a reply.

**Stop for the owner only when:**

1. it is time for the cutover (§10)
2. Discord is logged out in the T3 browser when you need it. Say so at once; never work around
   it, and carry on with everything else meanwhile.
3. one of the stop conditions in the README is met: Drizzle 1.0 misbehaves in phase 1; a spike
   fails with no sound answer; a recorded behaviour can't be reproduced after honest attempts
   and the difference isn't an intended one; identical behaviour would need a schema change; a
   production fix conflicts with migrated code in a way that isn't mechanical
4. something you shipped hurt the trio (after you have rolled it back)
5. plan 02 isn't landing, and nothing else is left to do

When you stop: say what you need in one or two sentences, what you recommend, and what you will
keep doing in the meantime. Pause the backstop if nothing is left to do.

**The browser test** in phase 8 is yours to do, not the owner's: use the T3 browser tools on the
test server, with the owner's logged-in Discord session. Never resize or close that tab, never
log out, never clear storage.

## 10. The cutover: the one planned question

When phase 8 has passed in full, post the summary (QA results against baseline, drills, soak,
the rollback rehearsal, the "Found on the way" list) and ask for the go. Propose a moment: the
next morning between 09:00 and 11:00 Vilnius on which the deploy checks hold.

After the go, the cutover is yours: schedule yourself for that moment, re-check the deploy
conditions, merge, and verify (`verification.md` §11). Schedule check-ins for 17:05 (the poll
posted once), 21:00, and 09:00 the next morning (logs). If anything the trio would notice goes
wrong and isn't fixed within minutes, roll back on your own judgment and report after.

## 11. Done

- every item under "What done means" in the README is true, and you have checked each one, not
  remembered it
- `STATUS.md` is complete; the plan is marked shipped in `docs/plans/README.md`
- the memory file `meme-bot-project.md` describes the new stack, the gates and the changed rules
- the backstop and every other scheduled task of yours is deleted
- the `effect`, `effect-prep` and `drizzle-1` branches are deleted; the `pre-effect` tag stays
- the final report to the owner: what changed for them (how to add a feature now, how failures
  show up, where traces would go), the numbers before and after, and the "Found on the way"
  list sorted by how much each item could hurt the trio. Mention that your worktree can be
  removed with `git worktree remove`.

## Kickoff prompt

To start, or to restart at any point in a new thread:

> Carry out plan 05, the full Effect migration of the meme bot, to the end. Read
> `C:\p\meme-bot\docs\plans\README.md`, then everything in
> `C:\p\meme-bot\docs\plans\05-effect-migration\`, starting with `README.md` and `RUN.md`. If a
> migration worktree already exists (`git -C /c/p/meme-bot worktree list`), its copy of the plan
> and its `STATUS.md` are the current ones: continue from there. Otherwise do the first-time
> setup in `RUN.md` §1. Then follow `RUN.md`: keep working through the phases without waiting
> for me, and stop only for the reasons in its §9.
