# Meme Bot 3000

Posts the day's top image post from r/ProgrammerHumor to a Discord channel. It's a single
Python script with only the standard library. It runs once a day on GitHub Actions and posts
through a Discord webhook, so nothing runs between posts.

## Setup
1. Discord: channel settings → Integrations → Webhooks → New Webhook → copy URL.
2. Push this folder to a GitHub repo (public repos get unlimited Actions minutes).
3. Repo → Settings → Secrets and variables → Actions → new secret `DISCORD_WEBHOOK_URL`.
4. Actions tab → "Daily meme" → Run workflow, to test.

Change the time in `.github/workflows/daily-meme.yml` (cron is UTC).

## Local test
    DRY_RUN=1 python meme_bot.py          # prints payload only
    DISCORD_WEBHOOK_URL=... python meme_bot.py

## Why RSS instead of the Reddit API
Reddit's `.json` endpoints return 403 without OAuth, and new API apps need manual approval
since Nov 2025. The Atom feed `/top/.rss?t=day` still works without auth and is sorted by score.
