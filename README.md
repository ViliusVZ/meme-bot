# Meme Bot 3000

Posts the top r/ProgrammerHumor image of the previous UTC day to Discord, with vote buttons,
a discussion thread, voting streaks, weekly/monthly recaps and slash commands, and runs the
Terrible Trio's game nights (polls, rooms, latecomers, tiebreakers, 📊 stats).

    Hostinger VPS (srv2127148.hstgr.cloud)                         Discord
    Caddy ─▶ bot (Node, blue/green) ◀── gateway: live voice ──────  
                │  Fastify: /interactions ◀── button clicks ───────
                ▼
             Postgres 18          Reddit RSS ◀── the bot fetches memes itself

**The bot lives in [`bot/`](bot/README.md)** (Node 24, Fastify, Drizzle/Postgres, `@discordjs/ws`),
deployed by GitHub Actions to the VPS ([server config](https://github.com/ViliusVZ/server)).
It moved off Cloudflare Workers on 2026-11-04 (the old Worker is in git history). File references
below like `src/gamenight.ts` mean `bot/src/`.

- **No duplicates, ever:** the database has a unique index allowing one daily meme per day, and a
  meme can only be claimed once (daily or `/meme`).
- **Votes:** 🔥 +3 · 😂 +2 · 💀 +2 · 🗑️ −1. Click again to remove; the message updates live.
- **Streaks:** vote on the daily meme on consecutive days.
- **Recaps:** Meme of the Week (Sun 18:00 UTC), Meme of the Month (1st, 09:00 UTC).
- **Commands:** `/meme` (random recent banger), `/top [week|month|all]`, `/stats [user]`, `/hall-of-fame`.

The bot refills the meme pool from Reddit's RSS every 6 hours (and right before the daily post),
then posts the daily meme from 10:00 UTC, once per day.

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
- 🔥 **Deadlines and roasts:** every vote closes 3 h after it opens (never between midnight and
  09:30; days planned ahead get until noon on the day), with a ⏳ last call 30 min before. Votes
  stay secret until everyone's in or time's up. Then a ❌ no, a missing vote or a 🚪 bail calls the
  night off and the culprits get roasted (`src/roasts.ts`: LT/EN, pools for one person with
  personal lines, each pair, and all three; a shuffle-bag in the database keeps lines from repeating).
- Players, channels, timezone and poll hour are in `bot/deploy/prod.env`.
- Testing without pinging anyone: `/admin/gamenight` with `{"action": "start" | "tick" | "reset"}` or
  `{"action": "vote", "user": "<id>", "choice": "yes|no|game|suggest|time|custom|out", "value": "..."}`,
  on the test bot. `bot/scripts/dc.py` calls the Discord API as the bot (via `/admin/discord`).

## 🔊 Lobby and game rooms (`src/voice.ts`)
Hang out in **🛋️ Lobby**. When a locked-in game night starts, the bot opens a voice room for the
game right under the Lobby (96 kbps), moves every player who's in the Lobby into it, and links it
in the start ping. Starts are on the dot: a timer armed two minutes ahead opens the room ~10 s
early, then moves everyone and pings at the exact second (the minute job is only the fallback). **🔊 Game room** on the panel (or `/room`) does the same on demand: pick a game
or type something else. One open room per game: asking again reuses it.

Rooms tidy themselves: 15 min after the last person leaves (an hour if nobody ever joined) →
moved to **🗄️ Recent games**, and the night's Discord event ends → deleted after 3 days. The bot
sees voice live through the Discord gateway: the moment the last person leaves, a timer is set for
exactly 15 minutes later. While people are still playing near the event's planned end, the end is
pushed back so Discord doesn't end it early. Joining an archived room brings it back. The archive
category exists only while it has something in it; rooms deleted by hand are simply forgotten.
While the gateway is reconnecting, voice lookups fall back to REST, and nothing is archived on a
guess. QA: `bot/scripts/qa_rooms.py`, `qa_timing.py`.

## ⏰ Latecomers (`src/late.ts`)
Once a night has started (its room is open), every minute and the moment anyone joins the Lobby,
the bot checks where each player is:
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
- A minute job runs every job; each job, each night and each player is isolated, so one
  failure can't stall the rest. A start ping that fails is retried the next minute.
- Nothing is decided on a guess: if a voice lookup fails, rooms and latecomers wait a minute.
- POSTs are never auto-retried on 5xx (they may have gone through); everything that must happen
  once (cards, rooms, slips, reminders, tiebreak results) is claimed in the database first.
- Interaction follow-ups retry when Discord hasn't registered the reply yet. The database sits next
  to the bot, so clicks are answered in tens of milliseconds.
- Re-nudges respect quiet hours (none between 00:00 and 09:00).
- Time cards stay open after midnight for 🌙 starts (until 06:00); other cards close at midnight.

QA: `cd bot && npm test` (100 tests against a real Postgres, every query runs), then
`python scripts/qa_all.py` (end-to-end on the test bot, cleans up), plus `qa_tiebreak.py`,
`qa_rooms.py`, `qa_stats.py` and `qa_timing.py`.

## 📊 Voice time and game stats (`src/activity.ts`)
The bot sees every voice join, leave and move live (Discord gateway) and records it as segments
(who, which channel, which game room, from when to when), accurate to the second. A **call** is a stretch with at least two of us in the same channel;
hopping from the Lobby into a game room together, or a gap under 3 minutes, doesn't end it. Game
time is time together in that game's room; together time elsewhere counts as hanging out.

**📊 Stats** on the panel (or `/gamestats`) shows, for this week / month / year / all time (◀️ ▶️ to
step through periods, 📣 to share): time together, calls (count, longest, average, change vs the
previous period), time per game and game nights played / called off / coming up, voice time per
person and who's usually first in, and when we play (busiest weekday, usual start, latest finish).
Weeks run Monday–Sunday in Vilnius time. A recap of last week is posted in #game-night on Monday
from 10:00, last month's on the 1st, last year's on 1 January (quiet periods are skipped).
Limits: the game is only known from game rooms (playing in the Lobby counts as hanging out), and
only the three players are tracked. QA: `bot/scripts/qa_stats.py` (stand-in players),
`bot/test/activity.test.ts`.

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
two winners. The minute job heals a tiebreak whose card didn't move on. QA: `bot/scripts/qa_tiebreak.py`;
unit tests: `bot/test/tiebreak.test.ts`.

## Deploy
Push to `main`: tests → image → the test bot → production. See [`bot/README.md`](bot/README.md).

## Why RSS instead of the Reddit API
Reddit's `.json` endpoints return 403 without OAuth, and new API apps need manual approval
since Nov 2025. The Atom feed `/top/.rss?t=week` still works without auth and is sorted by score.
