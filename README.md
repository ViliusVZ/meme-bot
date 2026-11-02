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
also has a 13:30 UTC fallback cron that posts from already-ingested memes.

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
