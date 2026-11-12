# Meme Bot 3000 · bot

The Terrible Trio's Discord bot: daily memes, game-night planning, game rooms, polls, spontaneous
play and 📊 stats. A long-running Node service on the VPS (`srv2140520.hstgr.cloud`, see the
[server repo](https://github.com/ViliusVZ/server)), written in [Effect](https://effect.website)
(version 4).

| | |
|---|---|
| Runtime | Node 24 LTS, TypeScript, Effect 4 (`NodeRuntime.runMain`) |
| HTTP | `effect/http` `HttpRouter` on `NodeHttpServer`: `/interactions` (Discord, signature-checked), `/ingest` (meme fetcher), `/admin/*` (scripts), `/health` |
| Database | Postgres 18 via `@effect/sql-pg` and Drizzle's Effect driver. Schema in `src/db/schema.ts`, migrations in `drizzle/`, applied on startup under an advisory lock |
| Live voice | Discord gateway via `@discordjs/ws` (`GUILDS`, `GUILD_VOICE_STATES`, and `GUILD_PRESENCES` when `PRESENCES=1`) |
| Deploys | GitHub Actions: test → image on GHCR → blue/green on the VPS (test bot first, then production) |

## How the code is built

Every module is a **service**: a `Context.Service` class with a `layer` that builds it from the
services it needs. `src/runtime.ts` stacks the layers bottom to top (each line may only use the
lines below it); `src/main.ts` runs the whole stack.

- **Configuration** (`config.ts`): read once with `Config`; secrets are `Redacted`. A missing
  variable fails startup with every missing name listed. `Overrides` carries a call's own
  settings (an admin QA call is `quiet`, and may name stand-in players).
- **Time** comes from Effect's `Clock` (`clock.ts`, `LocalTime`), randomness from `Random`, HTTP
  from `HttpClient` (`Discord`, `Reddit`, `Gemini`): nothing reads the global clock, `fetch` or
  `Math.random`, so tests control all three.
- **Errors**: expected failures are typed (`DiscordNotFound`, `DiscordRejected`,
  `DiscordUnavailable`, `DbError`, …) and appear in each method's signature; callers handle them
  by name. Defects are bugs: only the boundaries catch everything (the job runner per job, a tap,
  the voice and gateway event loops, background work, the alert sender, the ticker, each HTTP
  route, `main`), report it with `Alerts`, and carry on.
- **Claims**: anything that must happen once (a card, a ping, a roast, a recap) is claimed in the
  database first; the claim → post → record sequence is uninterruptible from the claim on.

## How it runs

Every running copy serves HTTP. Exactly one copy, the **leader**, also holds the gateway and runs
the clock (`leadership.ts`): a Postgres advisory lock on a connection of its own, pinged every
second, so it's released the instant that copy stops. During a deploy the new copy (say green)
starts and passes `/health`. Then the old one (blue) gets SIGTERM and shuts down in order
(`shutdown.ts`): `/health` answers 503, its leader term ends (green takes over within a second or
two), it finishes its in-flight requests, drains background work for up to 20 s, and exits. Caddy
only routes to healthy copies, so no click is dropped.

The leader's term:
- **Minute jobs** (`jobs.ts`, run by the `Ticker` in `scheduler.ts`): the daily meme, meme
  recaps, the 17:00 poll, closing stale cards, re-nudges, latecomers, room upkeep, stats recaps.
  Every job is idempotent and guarded by the database, so repeats and overlaps are harmless. Each
  job has a time limit; one that hangs is interrupted, reported, and the next job still runs.
- **Exact starts**: a game night starting within two minutes gets its own timer. The room opens
  10 s early, and the moves, live event and ping happen on the second.
- **Live voice** (`gateway.ts` → `presence.ts` → `live.ts`): every join, leave and move is recorded
  for stats right away (one queue, handled in order), with a heartbeat each minute while anyone is
  in voice. A Lobby join during a game night is pulled into the room at once. An emptied room's
  15-minute wrap-up fires exactly on time. Without the gateway, voice lookups fall back to REST.

Logs are one logfmt line each on stdout (journald keeps them): `ssh vps app-logs meme-bot 1h`.

## Develop

```sh
npm ci
npm run check          # types: src at error level for every Effect diagnostic, the tests too
npm test               # vitest, against a real Postgres (TEST_DATABASE_URL, or .env.test)
npm run db:generate    # after changing src/db/schema.ts: writes a migration to drizzle/
bash scripts/gates.sh  # every gate of the migration plan (see docs/plans/05-effect-migration)
```

Tests run against a real Postgres: each test file gets its own throwaway schema with the
migrations applied. A local Postgres is fastest (`TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55433/postgres`);
the server's test database works through an SSH tunnel too (`ssh -f -N -L 55432:localhost:5432 vps`,
`.env.test`), but its latency changes timing-dependent recordings.

**Writing a test** (`test/fx.ts`): `const h = harness({ tables, discord, clock })`, then
`it.effect("…", () => Effect.gen(function* () { … }).pipe(h.provide))`. The test gets the app's
services, fresh for every test; Discord (and Reddit, Gemini) answered by a stub behind the real
`HttpClient` (`h.override`, `h.calls`); the file's clock; a seeded `Random`; its log lines in
`h.logs`. The **recorder** writes what each test did (every outbound call, the database at the
end) to `test/__recordings__/`, committed: a test that behaves differently shows up in `git diff`.

**Adding a service**: a `Context.Service` with a `layer`, its methods `Effect.fn`, its errors
declared; add the layer to `runtime.ts` at the line above everything it uses. **Adding a job**:
an entry in `jobs.ts`'s table (it gets the runner's time limit and its catch-all). **Reporting a
failure**: `alerts.failed(what, error, ...context)`; it DMs the owner (throttled) and never fails.

## Deploy

Push to `main` (changes under `bot/`). The workflow tests, builds `ghcr.io/viliusvz/meme-bot:<sha>`,
deploys to the **test bot** (`/bot-dev`, the private "Bot Test Lab" server), then to **production**
(`/bot`). A branch goes to the test bot only by hand: Actions → Bot → Run workflow with
`target=dev`. Non-secret config is in `deploy/dev.env` / `deploy/prod.env`. Secrets
(`DISCORD_TOKEN`, `INGEST_SECRET`, `ADMIN_SECRET`, `GEMINI_API_KEY`) live only in
`/srv/apps/<app>/secrets.env` on the server. GitHub's SSH key can only run the deploy gate
(`deploy`, `config`, `compose`), nothing else.

Manual deploy or rollback: Actions → Bot → Run workflow, or on the server
`deploy-app meme-bot ghcr.io/viliusvz/meme-bot:<older sha>`.

## Scripts (`scripts/`)

All of them talk to the **test bot** unless you set `BOT=prod`. They read the admin secrets from `.env.qa`.

| Script | |
|---|---|
| `dc.py` | Discord API as the bot (`python scripts/dc.py GET /guilds/{guild}/channels`) |
| `sql.py` | SQL on the bot's database, via `ssh vps` |
| `qa_all.py` + `qa_*.py` | end-to-end QA on the test server (guarded by `qa_guard.py`); `qa_baseline.sh` runs every suite |
| `gates.sh` | the migration's gates (types, tests and recordings, query coverage, the assertion ledger, leftovers, build) |
| `setup_test_server.py` | channel layout for the test server |
| `export_d1.py`, `import-d1.ts` | the one-off move from Cloudflare D1 |
