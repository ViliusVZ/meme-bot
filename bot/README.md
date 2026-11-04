# Meme Bot 3000 · bot

The Terrible Trio's Discord bot: daily memes, game-night planning, game rooms, polls, tiebreakers
and 📊 stats. A long-running Node service on the VPS (`srv2127148.hstgr.cloud`, see the
[server repo](https://github.com/ViliusVZ/server)).

| | |
|---|---|
| Runtime | Node 24 LTS, TypeScript |
| HTTP | Fastify: `/interactions` (Discord, signature-checked), `/ingest` (meme fetcher), `/admin/*` (scripts), `/health` |
| Database | Postgres 18 via Drizzle (node-postgres). Schema in `src/db/schema.ts`, migrations in `drizzle/`, applied on startup |
| Live voice | Discord gateway via `@discordjs/ws`, only the `GUILDS` + `GUILD_VOICE_STATES` intents |
| Deploys | GitHub Actions: test → image on GHCR → blue/green on the VPS (test bot first, then production) |

## How it runs

Every running copy serves HTTP. Exactly one copy, the **leader**, also holds the gateway and runs
the clock. Leadership is a Postgres advisory lock (`db/index.ts`), so it's released the instant
that copy stops. During a deploy the new copy (say green) starts and passes `/health`. Then the old
one (blue) gets SIGTERM: it stops leading, green takes over within a second or two, and blue finishes
its in-flight clicks and exits. Caddy only routes to healthy copies, so no click is dropped.

The leader:
- **Minute jobs** (`jobs.ts`): the daily meme, meme recaps, the 17:00 poll, closing stale cards,
  re-nudges, latecomers, room upkeep, stats recaps. Every job is idempotent and guarded by the
  database (unique keys, compare-and-set), so repeats and overlaps are harmless.
- **Exact starts** (`scheduler.ts`): a game night starting within two minutes gets its own timer.
  The room opens 10 s early, and the moves, live event and ping happen on the second.
- **Live voice** (`gateway.ts` → `presence.ts` → `live.ts`): every join, leave and move is recorded
  for stats right away, with a heartbeat each minute while anyone is in voice. A Lobby join during a
  game night is pulled into the room at once. An emptied room's 15-minute wrap-up timer fires exactly
  on time. Without the gateway (starting up, or reconnecting), voice lookups fall back to REST.

## Develop

```sh
npm ci
npm run check          # types
npm test               # vitest, against a real Postgres (TEST_DATABASE_URL, or .env.test)
npm run db:generate    # after changing src/db/schema.ts: writes a migration to drizzle/
```

Local tests use the server's test database through an SSH tunnel:
`ssh -f -N -L 55432:localhost:5432 vps`, with `.env.test` holding
`TEST_DATABASE_URL=postgres://…@localhost:55432/meme_bot_test`. Each test file gets its own
throwaway schema.

## Deploy

Push to `main` (changes under `bot/`). The workflow tests, builds `ghcr.io/viliusvz/meme-bot:<sha>`,
deploys to the **test bot** (`/bot-dev`, the private "Bot Test Lab" server), then to **production**
(`/bot`). Non-secret config is in `deploy/dev.env` / `deploy/prod.env`. Secrets (`DISCORD_TOKEN`,
`INGEST_SECRET`, `ADMIN_SECRET`) live only in `/srv/apps/<app>/secrets.env` on the server. GitHub's
SSH key can only run the deploy gate (`deploy`, `config`, `compose`), nothing else.

Manual deploy or rollback: Actions → Bot → Run workflow, or on the server
`deploy-app meme-bot ghcr.io/viliusvz/meme-bot:<older sha>`.

Logs: `ssh vps docker logs -f --since 1h meme-bot-blue` (or `-green`; `docker ps` shows which is up).

## Scripts (`scripts/`)

All of them talk to the **test bot** unless you set `BOT=prod`. They read the admin secrets from `.env.qa`.

| Script | |
|---|---|
| `dc.py` | Discord API as the bot (`python scripts/dc.py GET /guilds/{guild}/channels`) |
| `sql.py` | SQL on the bot's database, via `ssh vps` |
| `qa_all.py` + `qa_*.py` | end-to-end QA on the test server (guarded by `qa_guard.py`) |
| `setup_test_server.py` | channel layout for the test server |
| `export_d1.py`, `import-d1.ts` | the one-off move from Cloudflare D1 |
