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
   three pick different games, a die decides.
3. **What time?** Buttons with start times generated from when this stage began: three half-hour
   steps from ~45 min out, then two hourly ones (stage at 14:00 → 15:00 15:30 16:00 17:00 18:00;
   at 17:00 → 18:00 … 21:00). Passed times disappear; ✏️ *Other time* takes any HH:MM, and custom
   picks become buttons for the others. Everyone taps the *earliest* time they can start (tap again
   to take it back); the session starts at the latest of those, so there are no ties to break.

Then it creates a Discord event and pings everyone once, and again at start time. Each stage that
needs the others' input sends one nudge ping, which is deleted when the next one replaces it.
🚪 *I'm out* / *Can't make it* cancels the night (and the event) at any stage.

- One poll per day is guaranteed by `game_nights.day` being the primary key; stage changes are
  compare-and-set, so simultaneous clicks can't double-advance.
- `/playtoday` starts today's poll early and counts as the starter's yes. If today already has a
  poll (manual or scheduled), it links to it instead; the 17:00 job never posts a second one.
- Anyone a stage has been waiting on for an hour gets one extra reminder ping.
- `/games list|add|remove` edits the game list.
- Time logic tests (DST, presets, parsing): `cd worker && node test/time.test.mjs`.
- Players, channel, timezone and poll hour are in `wrangler.toml` (`PLAYERS`, `GAME_CHANNEL_ID`,
  `TIMEZONE`, `GAME_POLL_HOUR`). One `*/15` cron handles both the poll and the reminders.
- Testing without pinging anyone: `/admin/gamenight` with `{"action": "start" | "tick" | "reset"}` or
  `{"action": "vote", "user": "<id>", "choice": "yes|no|game|suggest|time|custom|out", "value": "..."}`.
  `worker/scripts/dc.py` calls the Discord API as the bot (via `/admin/discord`).

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
