# Plans, November 2026

Four features for Meme Bot 3000, agreed with Vithis (the owner) on 2026-11-11. Each plan is
self-contained: read this file, then the plan, then the code it names. Build one plan per session.

| # | Plan | Size | Depends on |
|---|------|------|------------|
| 01 | [Spontaneous play](01-spontaneous-play.md): the Lobby question, auto-move, unplanned nights count | **shipped 2026-11-11**, all 3 phases | nothing |
| 02 | [WoW: Forever news](02-wow-forever-news.md): a quiet #wow-news channel | **shipped 2026-11-12**; replaced by 06 | nothing |
| 03 | [The bot speaks](03-bot-voice.md): jingle, spoken roasts, the spoken Lobby question | large, risky | 01 phase 1 for one of its three moments |
| 04 | [AI roast trial](04-ai-roast-trial.md): a sample sheet from a free model, then go/no-go | **no-go 2026-11-11**: keep the hand-written pools | done |
| 05 | [Move the whole bot to Effect](05-effect-migration/README.md): every module, the tests, the HTTP and database layers | **shipped 2026-11-12** (cutover 15:18) | 02 finished first; 03 waits until after it |
| 06 | [WoW news, second version](06-wow-news-v2.md): what blows up on the WoW subreddits, read and written up (what, the mood, why it matters) | medium; judged by a backtest sheet | 02 (replaces it) |
| 07 | [Early birds](07-early-birds.md): a locked-in night knows when people show up early (starts early, a card for two, the start pings only who's missing) | small | 01 |

Suggested order: 01 phase 1, 02, 01 phase 2, 04 (any time the user has two minutes for the key), 03.

Plan 05 (decided 2026-11-11) changes that order: once 02 is in, the bot's features are frozen
until 05 is cut over (production fixes excepted), and 03 is then built on the new code. Plan 05
is the exception to "one plan per session": it has its own folder, and its `STATUS.md` says
where it stands.

## The product rule

The owner's words: "as automatic as possible and get out of our way as much as possible. But also
be present." In practice:

- Act without asking when the situation is obvious; ask with one tap when it isn't; never make
  anyone type.
- No pings and no notification sounds for anything in these plans, unless a plan says otherwise.
  Send messages silently (message flag `1 << 12`) with `allowed_mentions: { parse: [] }`.
- Everything the bot does on its own must be undoable in one tap, and must clean up after itself
  (messages deleted or edited to a final state, never left dangling).
- Three people use this bot every evening and one of them watches the server closely. A visible
  glitch is a bug.

## House rules (all of them have bitten before)

- **QA never touches production.** Scripts in `bot/scripts` target the test bot by default;
  `BOT=prod` is for read-only checks. Every QA script calls `qa_guard.require_idle()`. Never add an
  unscoped cleanup. Test in the "Bot Test Lab" server, not the trio's.
- **No duplicates, enforced by database keys.** Anything the bot posts once (a question, a line, a
  news item) is claimed in the database first (unique key), then posted, and the claim is released
  if the post fails. Look at how the daily meme and the start ping do it (`test/paths.test.ts`:
  "a failed post gives the meme back", "a failed start ping releases the claim").
- **The code is Effect (version 4).** Read `bot/README.md` first ("How the code is built"), and take
  every API from `bot/node_modules/effect` (`AGENTS.md`, the `.d.ts` files), never from memory of
  Effect 3. New work is a service (`Context.Service` with a `layer`, its methods `Effect.fn`, its
  errors declared and handled by name), added to `src/runtime.ts` above everything it uses. No
  `async`/`await`, `Promise`, `Date`, `fetch`, `setTimeout` or `console` in `src/`: the gates fail
  on them (`bash bot/scripts/gates.sh`, G1 and G6), except in the boundary files listed in
  `05-effect-migration/architecture.md` §16.
- **Leader only.** One copy holds the Postgres advisory lock (`leadership.ts`) and runs, inside its
  term, the gateway, the `Ticker` and `Live`. Anything that reacts to voice goes through `Live`'s
  queue, so changes are handled one at a time.
- **Never act on a guess.** If the gateway has no snapshot (`Presence`'s `hasSnapshot` /
  `isReady`), do nothing and try again later. This rule already exists; keep it.
- **Restarts happen** (every deploy is a restart, and the leader can change). All state that
  matters lives in Postgres; timers are rebuilt from stored timestamps on `resync`. Nothing may be
  refetched or reposted just because the process restarted (the Reddit rate-limit incident).
- **Failures:** use `alerts.failed(what, error, ...context)` for anything the trio would notice.
  Expected refusals from Discord (already gone, already ended) are typed errors
  (`DiscordNotFound`, `DiscordRejected`): handle them by name, quietly. Never catch everything
  outside the boundaries (architecture §6); a bug reaches its boundary and is reported there.
- **Once means uninterruptible:** a claim → post → record sequence runs in `Effect.uninterruptible`
  from the claim on, so a shutdown or a lost leadership never leaves a claim with its post sent and
  no record (test 6, `test/interruption.test.ts`, has an entry per sequence: add yours).
- **Tests:** `@effect/vitest` against real Postgres, on the harness in `bot/test/fx.ts` (see
  `bot/README.md`, "Writing a test"). Every database query in `src/` must be executed by a test
  (`python bot/scripts/qcov.py` after a coverage run; the gates do both). The recorder keeps what
  each test did in `bot/test/__recordings__/`: a change there is a change in behaviour, and must be
  meant. Each new test must fail without the change it covers (break the code on purpose and see
  it go red).
- **UI-first:** buttons, menus and forms. A slash command may only open UI.
- **Copy:** short, mixed Lithuanian/English like the existing lines, in the bot's dry voice. Read
  `roasts.ts` and the game-night card before writing any text.
- **Deploying:** a push to `main` that touches `bot/**` deploys the test bot, then production.
  `gh workflow run bot.yml --ref <branch> -f target=dev` deploys the test bot only. Before anything
  reaches production: nobody in voice (`BOT=prod MSYS_NO_PATHCONV=1 python bot/scripts/dc.py GET
  "/guilds/{guild}/voice-states/<user>"` returns 404 for all three), no night voting or about to
  start. After: `/bot/health` shows the new version, `ssh vps app-logs meme-bot 10m` is clean,
  `ssh vps server-status` shows no problems.
- **The server:** `ssh vps`. Run `sudo host-watch pause 30m` before anything that stops containers
  by hand, and `sudo host-watch resume` after. Secrets go into the server's `secrets.env` from a
  file or a secure prompt, never through chat or logs.
- **Git:** don't commit `bot/scripts/__pycache__`. Commit messages are one plain sentence saying
  what changed for the players, like the existing history.
- **Discord in the T3 browser:** the owner's login there must be preserved. Never log out, clear
  storage, or resize that tab. If it's logged out, ask the owner to log in.

## What the owner has to do

1. **Presence switch (plan 01 phase 2):** be logged in to Discord in the T3 browser when it's time
   to flip "Presence Intent" for both bot applications in the Developer Portal.
2. **Tell Koral and Ieva** to leave Discord's "Share your detected activities with others" on
   (Settings → Activity Privacy; on by default).
3. **Gemini key (plan 04):** create a free key at Google AI Studio and enter it in the secure
   prompt.
4. **Ears (plan 03):** pick a voice and a jingle from samples, then join one listening test on the
   test server.
5. **Go or no-go** on the roast sample sheet (plan 04).

## Reporting back

When a plan (or a phase) is done, tell the owner in plain words: what the trio will see, what was
tested and how, what is live where, and anything that didn't go to plan. Lead with the outcome.
Then update the memory files (`meme-bot-project.md`) with what shipped and any new rule learned.
