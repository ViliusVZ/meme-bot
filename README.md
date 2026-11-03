# Meme Bot 3000

Posts the top r/ProgrammerHumor image of the previous UTC day to Discord, with vote buttons,
a discussion thread, voting streaks, weekly/monthly recaps and slash commands.

    GitHub Actions (cron, 4x/day)          Cloudflare Worker + D1 (free tier)
    meme_bot.py: Reddit RSS  ── /ingest ──▶ stores memes, posts the daily one,
                                            handles buttons + slash commands

- **No duplicates, ever:** the database has a unique index allowing one daily meme per day, and a
  meme can only be claimed once (daily or `/meme`).
- **Votes:** 🔥 +3 · 😂 +2 · 💀 +2 · 🗑️ −1. Click again to remove; the message updates live.
- **Streaks:** vote on the daily meme on consecutive days.
- **Recaps:** Meme of the Week (Sun 18:00 UTC), Meme of the Month (1st, 09:00 UTC).
- **Commands:** `/meme` (random recent banger), `/top [week|month|all]`, `/stats [user]`, `/hall-of-fame`.

Reddit is fetched from GitHub Actions because Reddit's RSS works reliably from there. The Worker
posts the daily meme itself on its 15-minute tick (from 10:00 UTC), from memes already ingested, so a
late GitHub cron run doesn't delay it.

## Game night (`src/gamenight.ts`)
Every day at 17:00 Lithuanian time (or earlier, when anyone runs `/playtoday`) a card appears in
#game-night and walks through three stages, editing itself in place:

1. **Are we playing today?** ✅/✖️ buttons. It moves on only when all three players say yes. Votes can
   change until midnight; an unfinished poll closes itself at midnight.
2. **What are we playing?** A dropdown of games, sorted by how often they've been played, plus
   ➕ *Suggest a game*, which adds the game permanently. The first game to 2 votes wins; if all
   three pick different games, it's a ⚔️ tiebreaker (see below).
3. **What time?** Buttons with start times generated from when this stage began: three half-hour
   steps from ~45 min out, then two hourly ones (stage at 14:00 → 15:00 15:30 16:00 17:00 18:00;
   at 17:00 → 18:00 … 21:00). Passed times disappear; ✏️ *Other time* takes any HH:MM, and custom
   picks become buttons for the others. Everyone taps the *earliest* time they can start (tap again
   to take it back); the session starts at the latest of those, so there are no ties to break.
   Whoever picked the latest time is named 🐢 slowpoke of the night.
   **🏁 Leave by** (optional) records when you have to go. A night only locks if everyone gets at
   least an hour together (`MIN_TOGETHER`); otherwise the card shows a ⚠️ naming who has to leave
   and who can't start in time, pings those people once per distinct clash, and waits for someone to
   move a start, push a leave-by or bow out. Time is never settled by dice or rock-paper-scissors.
   The Discord event ends at the earliest leave-by.

Then it creates a Discord event and pings everyone once, and again at start time. Each stage that
needs the others' input sends one nudge ping, which is deleted when the next one replaces it.
🚪 *I'm out* / *Can't make it* cancels the night (and the event) at any stage.

- One poll per day is guaranteed by `game_nights.day` being the primary key; stage changes are
  compare-and-set, so simultaneous clicks can't double-advance.
- `/playtoday` starts today's poll early and counts as the starter's yes. If today already has a
  poll (manual or scheduled), it links to it instead; the 17:00 job never posts a second one.
- `/plan` opens a day picker (today + 6 days). Picking a day posts that day's card right away.
  Future-day cards offer 16:00–21:00 start times; the 17:00 job skips any day that's already planned.
- Anyone a stage has been waiting on for an hour gets one extra reminder ping.
- `/games list|add|remove` edits the game list.
- Time logic tests (DST, presets, parsing): `cd worker && node test/time.test.mjs`.
- Players, channel, timezone and poll hour are in `wrangler.toml` (`PLAYERS`, `GAME_CHANNEL_ID`,
  `TIMEZONE`, `GAME_POLL_HOUR`). One `*/15` cron handles both the poll and the reminders.
- Testing without pinging anyone: `/admin/gamenight` with `{"action": "start" | "tick" | "reset"}` or
  `{"action": "vote", "user": "<id>", "choice": "yes|no|game|suggest|time|custom|out", "value": "..."}`.
  `worker/scripts/dc.py` calls the Discord API as the bot (via `/admin/discord`).

## 🔊 Lobby and game rooms (`src/voice.ts`)
Hang out in **🛋️ Lobby**. When a locked-in game night starts, the bot opens a voice room for the
game right under the Lobby (96 kbps), moves every player who's in the Lobby into it, and links it
in the start ping. **🔊 Game room** on the panel (or `/room`) does the same on demand: pick a game
or type something else. One open room per game: asking again reuses it.

Rooms tidy themselves on the 5-minute tick: empty for 20 min (or an hour if nobody ever joined)
→ moved to **🗄️ Recent games** → deleted after 3 days. Joining an archived room brings it back.
The archive category exists only while it has something in it; rooms deleted by hand are simply
forgotten. The bot has no gateway, so occupancy comes from `GET /guilds/{id}/voice-states/{user}`
for each player; if that lookup fails, the tick skips room maintenance rather than archive on a
guess. QA: `scripts/qa_rooms.py`.

## ⏰ Latecomers (`src/late.ts`)
Once a night has started (its room is open), every tick checks where each player is:
- **in the room** → here. A late slip, if they had one, becomes "✅ made it, 12 min late".
- **in the Lobby** → pulled into the room, once. Anyone already marked as here is never dragged
  back, so stepping out to the Lobby on purpose works.
- **anywhere else, 10 min after the start** → one late slip pings them: 🏃 5 / 15 / 30 min (an ETA)
  or 😴 can't make it. Only the late person can answer their slip.

"Can't make it" after the start (or once the start ping has gone out) only marks that person
absent: the others are already playing. Before the start it cancels the night as usual, and a
cancelled card offers 🔄 **Reopen** for the rest of that day. The Discord event goes live at the
start and is marked ended when the room is archived.

## Reliability notes
- One 5-minute tick runs every job; each job, each night and each player is isolated, so one
  failure can't stall the rest. A start ping that fails is retried on the next tick.
- Nothing is decided on a guess: if a voice lookup fails, rooms and latecomers wait a tick.
- POSTs are never auto-retried on 5xx (they may have gone through); everything that must happen
  once (cards, rooms, slips, reminders, tiebreak results) is claimed in the database first.
- Interaction follow-ups retry when Discord hasn't registered the reply yet. Smart Placement
  keeps the Worker near D1 so clicks answer well inside Discord's 3 seconds.
- Re-nudges respect quiet hours (none between 00:00 and 09:00).
- Time cards stay open after midnight for 🌙 starts (until 06:00); other cards close at midnight.

QA: `node test/time.test.mjs`, `node test/tiebreak.test.mjs` (unit), then `python scripts/qa_all.py`
(end-to-end against the live bot, quiet, cleans up), plus `qa_tiebreak.py` and `qa_rooms.py`.

## 🤫 Secret ballots
Every vote (are we playing, game, start time + leave-by, polls) is secret while it runs: the card
shows only who has voted (🗳️ / ⏳), never what, and no counts (in a group of three they'd give picks
away). Each voter gets an ephemeral receipt of their own ballot. A vote is revealed once it's
decided: everyone answered, a game won or tied into a tiebreaker, every start time is in (a clash
is shown with names so it can be fixed), or a poll closed. Locked and cancelled cards show how
everyone voted. A leave-by shows without its owner ("someone has to leave by 22:00") so nobody
picks a start that's too late. Rock-paper-scissors throws were already secret until each round ends.

## Polls, help and the HQ panel
- `/poll` (or 🗳️ on the panel) opens a form: question + answers (one per line; empty = Yes/No).
  Answers are buttons; one vote each, tap again to take it back. The first answer to a majority of
  the trio (2) wins automatically; 🔒 Close settles it early, and a tie gets a 🎲 button. (`src/polls.ts`)
- `/help` shows the guide privately. The same guide with action buttons (🎮 Play today · 📅 Plan a
  day · 🗳️ New poll · 🕹️ Games · ❓ Help) is pinned in #game-night, so nothing needs typing.
  Repost it with `/admin/gamenight {"action": "hub"}`. (`src/hub.ts`)
- `/games` opens the game list with ➕ Add (form) and a 🗑️ remove dropdown.

## ⚔️ Tiebreakers (`src/tiebreak.ts`)
A three-way game split, a poll where everyone voted without a majority, or a tied poll someone
🔒 closed all get a tiebreaker section on the card:
- **🎰 Spin the wheel:** anyone taps it; the card becomes a slot reel that spins (a few message
  edits) and lands on the winner, then returns to the card with the story.
- **✊✋✌️ Rock Paper Scissors** between the tied voters: throws are secret (ephemeral
  confirmation) until everyone's in, rounds are revealed on the card, draws replay, and with three
  players two can survive into a final. After 5 draws, or whenever anyone taps 🎰 *Just spin it*,
  the wheel decides.

One tiebreak per card (unique index), with compare-and-set updates, so double clicks can't produce
two winners. The tick heals a tiebreak whose card didn't move on. QA scripts: `scripts/qa_*.py`;
unit tests: `node test/tiebreak.test.mjs`.

## Deploy (`worker/`)
    npm install
    npx wrangler login
    npx wrangler d1 create meme-bot          # put database_id in wrangler.toml
    npm run db:init
    npx wrangler deploy
    npx wrangler secret put DISCORD_TOKEN      # also DISCORD_PUBLIC_KEY, DISCORD_APP_ID, INGEST_SECRET

Discord Developer Portal → General Information → Interactions Endpoint URL =
`https://<worker>.workers.dev/interactions`. Then register the slash commands:

    curl -X POST -H "Authorization: Bearer $INGEST_SECRET" https://<worker>.workers.dev/admin/register

GitHub repo secrets: `WORKER_URL`, `INGEST_SECRET`. Channel/guild/post hour are in `wrangler.toml`.

## Local test
    DRY_RUN=1 python meme_bot.py     # prints the first 3 parsed memes
    cd worker && npm run check && npm run logs

## Why RSS instead of the Reddit API
Reddit's `.json` endpoints return 403 without OAuth, and new API apps need manual approval
since Nov 2025. The Atom feed `/top/.rss?t=week` still works without auth and is sorted by score.
