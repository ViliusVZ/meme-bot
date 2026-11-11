# Plans, November 2026

Four features for Meme Bot 3000, agreed with Vithis (the owner) on 2026-11-11. Each plan is
self-contained: read this file, then the plan, then the code it names. Build one plan per session.

| # | Plan | Size | Depends on |
|---|------|------|------------|
| 01 | [Spontaneous play](01-spontaneous-play.md): the Lobby question, auto-move, unplanned nights count | large, 3 phases | nothing |
| 02 | [WoW: Forever news](02-wow-forever-news.md): a quiet #wow-news channel | small | nothing |
| 03 | [The bot speaks](03-bot-voice.md): jingle, spoken roasts, the spoken Lobby question | large, risky | 01 phase 1 for one of its three moments |
| 04 | [AI roast trial](04-ai-roast-trial.md): a sample sheet from a free model, then go/no-go | tiny | a key from the user |

Suggested order: 01 phase 1, 02, 01 phase 2, 04 (any time the user has two minutes for the key), 03.

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
- **Leader only.** One copy holds the Postgres advisory lock and runs the gateway, the minute
  scheduler and `live.ts`. Anything that reacts to voice goes through the `enqueue` queue in
  `live.ts`, so changes are handled one at a time.
- **Never act on a guess.** If the gateway has no snapshot (`presence.hasSnapshot()` /
  `isReady()`), do nothing and try again later. This rule already exists; keep it.
- **Restarts happen** (every deploy is a restart, and the leader can change). All state that
  matters lives in Postgres; timers are rebuilt from stored timestamps on `resync`. Nothing may be
  refetched or reposted just because the process restarted (the Reddit rate-limit incident).
- **Failures:** use `alerts.failed(what, error, ...context)` for anything the trio would notice.
  Expected refusals from Discord (already gone, already ended) are handled quietly.
- **Tests:** vitest against real Postgres. Open the tunnel first:
  `ssh -f -N -L 55432:127.0.0.1:5432 vps`. Every database query in `src/` must be executed by a
  test: run `npx vitest run --coverage --coverage.reporter=json`, then the query-coverage checker.
  That checker currently lives only at `C:\Users\viliu\AppData\Local\Temp\qcov.py`: as the very
  first task, copy it to `bot/scripts/qcov.py` and commit it. Each new test must fail without the
  change it covers (check by stashing the source change).
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
