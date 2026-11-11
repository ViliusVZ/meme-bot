# 05 · Target architecture

What the code looks like when the migration is done. Where this file says "must", it is a
requirement. Where it says "check", the API detail has to be confirmed against `node_modules`
before use. Everything stated as fact here was checked against `effect` 4.1.4, `@effect/sql-pg`
4.1.4 and `drizzle-orm` 1.0.0-rc.5 on 2026-11-11.

## 1. Packages and versions

Add, all pinned to an exact version (no `^`), and all Effect packages on the same version:

| Package | For |
|---|---|
| `effect` | the core, plus `effect/http`, `effect/sql`, `effect/testing`, `effect/observability` |
| `@effect/platform-node` | `NodeRuntime.runMain`, `NodeHttpServer` |
| `@effect/sql-pg` | `PgClient` (the Postgres pool; it speaks the Postgres protocol itself, with no `pg` underneath: spike S1) |
| `drizzle-orm` 1.0.0-rc.5, `drizzle-kit` 1.0.0-rc.5 | schema, query builder, `drizzle-orm/effect-postgres` |
| `@effect/vitest` (dev) | `it.effect`, `layer`, `TestClock` wiring |
| `@effect/language-service` (dev) | Effect diagnostics inside `tsc` |

Remove by the end: `fastify`, `pg` and `@types/pg` as direct dependencies. Keep `@discordjs/ws`,
`@discordjs/rest` (the gateway needs it), `discord-api-types`, `fast-xml-parser`.

Version upgrades of any of these during the migration are a deliberate, separate commit with all
gates run, never a side effect of `npm install`.

## 2. Effect 4 facts, and the version 3 habits that are wrong

Sources of truth: `node_modules/effect/AGENTS.md`, `node_modules/effect/ai-docs/src/**`, the
`.d.ts` doc comments, and `github.com/Effect-TS/effect/tree/main/migration`.

| Topic | Version 4 (use this) | Version 3 habit (wrong now) |
|---|---|---|
| Imports | `effect/http`, `effect/sql`, `effect/testing`, `effect/observability` | `@effect/platform`, `@effect/sql`, `@effect/experimental`, any `effect/unstable/*` path |
| Defining a service | `class X extends Context.Service<X, Shape>()("meme-bot/x/X") { static readonly layer = Layer.effect(X, …) }`, built with `X.of({…})` | `Context.Tag`, `Effect.Tag`, `Effect.Service`, static accessor proxies |
| A value with a default | `Context.Reference<T>("id", { defaultValue })`, overridden with `Effect.provideService` | `FiberRef`, `Effect.locally` |
| Tagged errors | `class E extends Schema.TaggedError<E>()("E", { … }) {}`, raised with `return yield* new E({…})` | `Data.TaggedError` for anything that crosses a boundary |
| Catching | `Effect.catch` (all typed errors), `catchTag`, `catchTags`, `catchCause`, `catchDefect`, `catchFilter`, `catchReason(s)` | `catchAll`, `catchAllCause`, `catchAllDefect`, `catchSome` |
| Defects and typed errors together | When a cause holds both, typed handlers do **not** run; the defect wins | Assuming `catchTag` still recovers |
| Forking | `Effect.forkChild`, `forkDetach`, `forkScoped`, `forkIn` | `Effect.fork`, `forkDaemon` |
| Reading a `Ref`, `Deferred`, `Fiber` | `Ref.get(ref)`, `Deferred.await(d)`, `Fiber.join(f)` | `yield* ref`, `yield* deferred`, `yield* fiber` |
| `Option` in a generator | `yield* Effect.fromOption(o)` | `yield* o` |
| Reusable functions | `Effect.fn("Service.method")(function*(…) {…}, …combinators)`; never `.pipe` on an `Effect.fn`; `Effect.fnUntraced` for hot helpers | functions that only return `Effect.gen(...)` |
| Running | `NodeRuntime.runMain(Layer.launch(Main))`; `ManagedRuntime.make(layer)` at foreign edges; `Effect.context<R>()` + `Effect.runForkWith(ctx)` from callbacks | `Runtime<R>`, `Effect.runtime()`, `Runtime.runFork` |
| Layer sharing | A layer built by an enclosing provide or runtime is reused by nested provides; sibling provides build their own copy. `Effect.provide(layer, { local: true })` or `Layer.fresh` forces a fresh build | Assuming every `Effect.provide` rebuilds, or that siblings share |
| Semaphores | `Semaphore.make(n)`, `Semaphore.withPermit` (and `PartitionedSemaphore` for keyed permits; check) | `Effect.makeSemaphore` |
| Config | `Config.String`, `Config.Port`, `Config.Boolean`, `Config.Redacted`, `Config.withDefault`, `Config.schema` | lower-case `Config.string` etc. |
| Schedules | `Schedule.exponential`, `spaced`, `recurs`, `jittered`, `upTo`, `cron`, `min`, `max`, `while`, `setInputType`; `Effect.retry`, `Effect.repeat`; `HttpClient.retryTransient` | `Schedule.intersect`/`union` spelled the old way; check before use |
| Fiber collections | `FiberSet`, `FiberHandle`, `FiberMap` (its `run` takes an `onlyIfMissing` option), each with `awaitEmpty` | hand-kept arrays of fibers |
| Tests | `it.effect` (runs under `TestClock`), `it.live` (real clock), `layer(L)("name", (it) => …)`, `assert` from `@effect/vitest`; `TestClock.adjust`, `TestClock.setTime` | `Effect.runPromise` inside plain `test` |
| Dates | `DateTime.now`, `DateTime.nowInCurrentZone`, `DateTime.layerCurrentZoneNamed("Europe/Vilnius")`, `Clock.currentTimeMillis` | `Date.now()`, `new Date()` |

Three more that bite:

- **A floating Effect does nothing.** An Effect that is created and not yielded never runs, where
  a forgotten `await` still ran the promise. The `floatingEffect` diagnostic is an error; never
  silence it.
- **`FetchHttpClient` reads the fetch function from a `Context.Reference`** (`FetchHttpClient.Fetch`)
  whose default, `globalThis.fetch`, is captured once (spike S5): a replaced global is not seen.
  Tests provide `FetchHttpClient.Fetch` themselves (a function that reads `globalThis.fetch` on
  every call, or a fake). A timeout or an interruption aborts the underlying request.
- **Drizzle 1.0's migrator refuses the old folder layout** (`drizzle/meta/_journal.json`): the
  folder must be converted with `drizzle-kit up`. On first run it also adds two columns (`name`,
  `applied_at`) to `drizzle.__drizzle_migrations`.

## 3. Feature adoption table

"Done" (README) requires every row to be in real use at the named places.

| Effect feature | Where it must be used |
|---|---|
| Typed errors (`Schema.TaggedError`) | Discord, Reddit, the Blizzard feed, Gemini, the database, configuration, incoming requests (§6) |
| `Schema` at every boundary | Discord responses we read fields from, incoming interactions, `custom_id` strings, `/ingest` and `/admin/*` bodies, feed entries, Gemini answers, JSON stored in `settings` (§9, §12) |
| Services and layers | Every module with state or I/O (§4); tests swap layers instead of stubbing globals |
| `Config` + `Redacted` | All environment reading; every secret (§7) |
| `Schedule` | Every retry and every repeating loop: Discord, interaction webhooks, Reddit, gateway connect, leader lock, minute clock, heartbeats (§9, §11) |
| Structured concurrency (`Scope`, `FiberSet`, `FiberHandle`, `FiberMap`, interruption) | Background work, start timers, voice timers, the leader's term, the gateway, shutdown (§11, §13) |
| Explicit concurrency (`Effect.forEach` with `concurrency`) | Every former `Promise.all` (§11) |
| `Semaphore` | One-at-a-time panel syncs per card, the alert DM queue (§11) |
| `Clock` / `DateTime` / `TestClock` | All time reading and all local-time arithmetic; all time-dependent tests (§10) |
| `Random` | The roast shuffle (`roasts.ts`) |
| `effect/http` server | All routes (§12) |
| `effect/http` client | Discord, Reddit, Blizzard, Gemini (§9) |
| `effect/sql` + Drizzle's Effect driver | All queries, transactions, migrations, the leader lock (§8) |
| Logging, spans, metrics | Every former `console.log`; spans on every service method, request, job, query and outbound call (§14) |
| `Match` | The game-night stage machine, `custom_id` routing, admin actions, voice events: exhaustive, so a new case fails to compile until handled |

## 4. Service map

Every module with state or I/O becomes one `Context.Service` class with a `static readonly layer`.
Pure modules stay plain functions (rendering in `ui.ts`, the roast line pools, `fit()`, the
time-option arithmetic, modal builders). Effect is for effects; don't wrap pure code in it.

Service identifiers follow `"meme-bot/<file>/<Class>"`.

**Module-level state that moves into a service** (this is the complete list as of 2026-11-11;
re-run the search at the start of phase 3 because `news.ts` is new):

| Today | State | Becomes |
|---|---|---|
| `alerts.ts` | `owner`, `seen`, `recent`, `heldBack`, `queue`, `dmChannels`, `gatewayDown`, `gatewayReported` | `Alerts` service: `Ref` state, a one-at-a-time sender |
| `background.ts` | `pending` | `Background` service: a `FiberSet` |
| `channels.ts` | `cache`, `ready` | `Channels` service: `Ref` |
| `presence.ts` | `states`, `ready`, `known`, `listeners`, `games`, `playingListeners` | `Presence` service: `Ref` state, a `PubSub` of changes |
| `discord.ts` | `keys` (imported public keys) | inside the signature verifier (a cached Effect) |
| `gateway.ts` | `presencesRefused` | `Ref` in the `Gateway` layer (must outlive one connection, so it lives at app scope) |
| `main.ts` | `leader`, `shuttingDown` | `Lifecycle` service: `Ref`s read by `/health` |
| `scheduler.ts` | `lastTick` | `Ticker` service: `Ref` |
| `panels.ts` | `syncing` | `Panels` service: keyed permits |
| `reddit.ts` | `lastOk`, `lastTry`, `restored`, `running` | `Reddit` service: `Ref` + `FiberHandle`; the stored copy in `settings` stays |
| `news.ts` | `running` | `News` service |

**Layers, bottom to top.** A layer may depend only on layers above its own line in this list.
Today's import graph has one cycle (`gamenight` ↔ `late`, `snooze`, `voice`, `spontaneous`,
`gemini`) and one hidden one (`discord` ↔ `channels`, through a dynamic import). Phase 0 removes
both by moving code, before any Effect is written:

1. `AppConfig`, `Overrides` (§7), logging
2. `Db` (§8), the HTTP client
3. `Channels` (cache only, no I/O)
4. `Discord` (§9; reports its own channel changes into `Channels`). "List channels: from the
   cache, else over REST" moves here from `channels.ts` (phase 0: `discord.ts` `listChannels`).
5. `Alerts`, `Background`, `Presence`, `Lifecycle`
6. `LocalTime` (today `local`, `wallToUnix`, `pollHour`, `weekday` in `gamenight.ts`),
   `Games` (today `games`, `addGame`, `removeGame`, `emojiFor`, `gameLabel` in `gamenight.ts`),
   `Nights` (today `getNight`, `isOver`: reading a night's row),
   `Memes`, `Roasts`, `Panels`, `Gemini`
7. `Snooze`, `Voice`, then `Attendance` (today the data half of `late.ts`, now `attendance.ts`:
   `get`, `expect`, `etas`, `declare`, `markArrived`, `retireSlips`, and the slip's `render`,
   because `declare` posts the slip and asks `Voice` where the person is; amended in phase 0)
8. `Spontaneous`, `Reddit`, `News`
9. `GameNight` (the rest of `gamenight.ts`)
10. `LateSlips` (today the other half of `late.ts`: `watch`, `act`; it calls
    `GameNight.bailFromSlip`), `Polls`, `Activity`, `Hub`, `Cleanup`, `MemeShame`
11. `Jobs`, `Interactions`
12. `HttpApp`, and the leader-only group: `Gateway`, `Ticker`, `Live`
13. `Leadership`, `Main`

If a dependency turns out to point upward, don't paper over it with a lazy lookup. Move the
function to the lower layer, or split the service, and note it in `STATUS.md`.

## 5. Code style

Follow `node_modules/effect/AGENTS.md`. On top of it:

- Keep the existing comment style: every non-obvious rule keeps its comment, in the words the
  code has today. Those comments record hard-won reasons; don't lose them in translation.
- Service methods are `Effect.fn("Service.method")`. The span name is the method name.
- Service interfaces declare their error types by hand. That is the point of the exercise: a
  reader sees how each call can fail.
- A service method must not require anything (`R = never`) except per-call context that is a
  `Context.Reference`. Dependencies are taken in the layer.
- `Effect.provide` appears only at entry points: `main.ts`, the HTTP handler edge, test setup.
- Plain data stays plain: rows are Drizzle's inferred types, `null` stays `null`. Don't convert
  the domain to `Option`, `HashMap`, `Chunk` or `effect/Array`; use them only where a specific
  API needs them.
- No `Effect.promise`, `Effect.tryPromise`, `Effect.callback`, `runPromise` or `runFork` outside
  the boundary files (§16).

## 6. Errors

Three kinds, and the rule for each:

**Expected failures are typed** and appear in signatures:

| Error | Raised when | Notes |
|---|---|---|
| `DiscordNotFound` | Discord answers 404 | carries method, path, Discord's `code` (10003 channel, 10008 message, 10065 voice state, …) |
| `DiscordRejected` | any other 4xx | carries status, `code`, `message`, and the parsed `errors` tree; permanent: retrying the same request can't work |
| `DiscordUnavailable` | gave up after retries: network, timeout, 5xx, rate limit | transient: a later attempt may work |
| `RedditError`, `FeedError`, `GeminiError` | their HTTP or parsing failed | `Gemini.ask` still answers `null` on any trouble, as today |
| `DbError` | a query or transaction failed | one alias for Drizzle's `EffectDrizzleQueryError` and `SqlError` |
| `BadRequest`, `BadSignature` | an incoming request fails its schema or its signature | become 400 / 401 at the HTTP edge |
| `ConfigError` | the environment is incomplete | fails startup with the missing names, as today |

Helpers replace today's string matching, and are built from real captured responses (phase 0):
`isFinished` (an event that was ended or deleted) must be a predicate over `DiscordNotFound |
DiscordRejected` that looks at the `errors` tree for `INVALID_END_BY_STATUS`, not at text.

**Database errors stay typed** (they are not turned into defects). Reason: the claim patterns
("claim, post, release the claim if the post failed") must also release when the failure is a
database error, and in version 4 a typed handler does not run when the cause contains a defect.

**Defects are bugs.** Nothing catches them except the outermost boundaries, which are exactly:
the job runner (per job), the interaction handler (per tap), the voice event loop (per event),
background work (per task), the alert sender (per DM: a defect there must not stop every later
alert; amended in phase 3), and `main`. Each of those uses `Effect.catchCause`, reports through
`Alerts` with the same `what` text as today, and carries on. There must be no other catch-all in
the codebase; a typed handler names the errors it handles.

**The record rule.** When code handles `DiscordNotFound` or `DiscordRejected` for a thing the bot
keeps a record of (an event, a room, a message, a private copy), the handler must update that
record. The migration keeps today's behaviour in each such place, but list every handler that
only logs or alerts in `STATUS.md` under "Found on the way": those are the ended-event bug's
relatives.

## 7. Configuration and per-call context

- `AppConfig` is a service built from `Config`: the fields of today's `Config` type in `env.ts`,
  with the same names, defaults and required set. The secrets are `Redacted`: `DISCORD_TOKEN`,
  `INGEST_SECRET`, `ADMIN_SECRET`, `GEMINI_API_KEY` and `DATABASE_URL`. (`DISCORD_PUBLIC_KEY` is
  public and stays a plain string.) Numbers that are strings today (`POST_HOUR_UTC`,
  `GAME_POLL_HOUR`, `GAME_POLL_HOUR_WEEKEND`) become numbers at this boundary; `PLAYERS` becomes
  an array.
- A missing variable fails startup with a message naming every missing variable, as today.
- `Overrides` is a `Context.Reference` with the default `{ quiet: false }` and an optional
  `players`. It replaces `{ ...env, QUIET: true }` and `{ ...quiet, PLAYERS: … }` in the admin
  routes: the route wraps the call in `Effect.provideService(Overrides, …)`.
- Code reads the players through one helper that returns `overrides.players ?? config.players`,
  and reads `quiet` the same way. Both are read **inside the method body at call time**, never
  captured when the layer is built. A value captured in the layer would ignore the override.
- **Overrides must reach background work.** A quiet admin call that defers a ping must send that
  ping quietly. Spike S6 (phase 2) finds out how `FiberSet.run` passes context to the fiber it
  starts; test 1 in `verification.md` §7 guards it. Getting this wrong means QA pings the real
  trio.

## 8. Database

- One `PgClient` layer (pool) with today's settings: at most 10 connections, 30 s idle timeout,
  5 s to get a connection, `application_name` from `APP_NAME`, and `statement_timeout = 30s` and
  `idle_in_transaction_session_timeout = 60s` (through `startupParameters`). The test in
  `resilience.test.ts` that reads these settings back must keep passing.
- `Db` is the Drizzle Effect database (`drizzle-orm/effect-postgres`, `make` or
  `makeWithDefaults`) on that client. Query code keeps its shape: `yield* db.select()…`.
- `bigint` columns must still come back as JavaScript numbers (today a global `pg` type parser
  does it). Spike S1: Drizzle's own codec does it for `bigint({ mode: "number" })` columns, but raw
  `sql` aggregates over bigint arrive as `BigInt`, so the client gets its own type registry
  (`PgTypes.makeRegistry`, the `types` option) whose int8 codec decodes to a number and fails on
  values beyond `Number.MAX_SAFE_INTEGER`. `numeric` stays a string, as with `pg`.
- Transactions use `db.transaction((tx) => Effect…)`. A failure or an interruption inside rolls
  back. Helper functions that take `tx` today keep taking it.
- Migrations: the converted `drizzle/` folder, applied at startup by Drizzle's Effect migrator
  under the same advisory lock as today (`4242001`), so two copies starting together don't race.
- The leader lock (`4242002`) is a session advisory lock on a one-connection
  `PgClient.makeClient` owned by the term's scope (spike S2): closing or interrupting the term
  closes that connection, and Postgres frees the lock. Not `sql.reserve`: closing its scope gives
  the connection back to the pool still holding the lock. The driver reports no closed socket on
  its own, so the term pings every second with a 2 s timeout and TCP keepalive on; a dead
  connection fails the ping at once (STATUS "Decisions": today's `end` event was immediate).
- Migrations take the migration lock on a one-connection client too, and run Drizzle's Effect
  migrator on a database built on that client (spike S3).
- **In tests** the pool is built and closed on the live clock, and has no acquire timeout: the
  pool runs its timers on the clock of the fiber that queries, so moving the test clock would
  fire them (spike S7).
- No query goes through raw `effect/sql` templates unless Drizzle can't express it; the leader
  and migration locks are the expected exceptions.
- `scripts/qcov.py` keeps working: update its pattern to the new query form and confirm it still
  counts the same number of query sites as the baseline (`verification.md` §3).

## 9. Discord REST client

`Discord` is a service on `HttpClient` (the fetch-based one), with the bot token attached as a
`Redacted` header and the same `User-Agent` as today.

- **One typed method per endpoint the bot uses** (about 22: create/edit/delete message, bulk
  delete, list messages, create thread, pins, edit/create/delete channel, reorder channels, list
  channels, get channel, move member, scheduled events create/edit/delete, voice state, register
  commands, create DM, current user). No stringly `api(method, path)` in feature code. The admin
  passthrough route (`/admin/discord`) keeps one generic `request(method, path, body)`.
- **Responses are decoded with `Schema`**, declaring only the fields the bot reads (a message's
  `id` and `channel_id`, a channel's `id`/`name`/`type`/`position`/`parent_id`, …). Unknown extra
  fields are allowed. Request bodies are typed with `discord-api-types` where that types cleanly;
  they are built by our code and need no runtime validation.
- **The retry rules are today's, exactly,** expressed as schedules:
  - 429: wait `retry_after` (capped at 10 s) plus 100 ms, then retry; for every method
  - network error, timeout, 5xx: retry with 300 ms × 2ⁿ back-off, **only when the method is not
    POST**. A POST that failed this way may have gone through; retrying could duplicate a
    message, a channel or an event. The caller decides.
  - at most 4 attempts in total; each attempt times out after 10 s
  - then `DiscordUnavailable`
- After a successful call, the client reports its own channel changes to `Channels`, as
  `noteChannels` does today.
- **Interaction webhooks** (`followup`, `editOriginal`, `originalMessage`) keep their own rule:
  up to 4 attempts, 400 ms × attempt apart, retrying on 404 (Discord hasn't processed our reply
  yet), 429 and 5xx. Their result type says whether the edit landed, because `Panels` deletes
  the copy's row when it didn't.
- Reddit, the Blizzard feed and Gemini get the same treatment in their own services: `HttpClient`,
  a schedule that states today's retry rule, a `Schema` for what comes back.

## 10. Time

- All time comes from `Clock` / `DateTime`. The many `nowSec()` helpers become one, on `Clock`.
- Functions that take `t = nowSec()` as a parameter today keep the parameter; tests and the
  admin routes pass it.
- `LocalTime` holds the Vilnius-local helpers. First translate them as they are (they are built
  on `Intl.DateTimeFormat` and pinned by `test/time.test.ts`). Rewriting them on `DateTime` zones
  is a separate, later commit, allowed only once `time.test.ts` covers both daylight-saving
  changes and the hour-boundary cases it covers today.
- SQL keeps using values passed from the application. Two columns default to `now()` in the
  schema and one update in `roasts.ts` sets `now()`; leave them, and exclude those columns from
  the recorded database state (`verification.md` §2).
- Every delay in the code is a named `Duration` constant, so a test can advance the clock by
  exactly that amount.

## 11. Concurrency inventory

Each mechanism the bot has today, and what replaces it. Behaviour in the right column is required.

| Today | Replacement | Must hold |
|---|---|---|
| `background.defer(promise, label)` + `drain(ms)` + `inFlight()` | `Background.run(effect, label)` forks into a `FiberSet`; failures go to `Alerts` with the label | Shutdown waits up to 20 s for it to empty, then interrupts and logs how many were left. `/health.background` is its size |
| `gn.act(…, defer)` taking a defer callback so tests can wait | `Background` is a service; the test layer lets a test wait for everything deferred | The admin `vote` action still waits for the deferred work before answering |
| `scheduler.ts`: minute timer, `running` promise, `stopped` flag | `Ticker`: a loop that sleeps to just past the top of the next minute, runs the jobs, repeats | Never early, never overlapping, one catch-up run at start, `sinceTick` for `/health` |
| `scheduler.ts`: `waiting` map of start timers + `AbortController` | A `FiberMap` keyed `day@start_at`, started with `onlyIfMissing`; each fiber sleeps, starts the night, then holds its key 5 more minutes | Sleeping fibers are interrupted when the term ends. From the claim onward the fiber is uninterruptible (§15) |
| `scheduler.ts`: stall watchdog (`setInterval`) | A fiber that checks the tick's start time every 30 s | Reports once after 5 min stuck; `main` then alerts and shuts down, as today |
| `gamenight.ts` `sleepUntil(ms, signal)` | `Effect.sleep` until the instant, on `Clock` | Exact-second starts keep their precision (`qa_timing.py`) |
| `live.ts`: promise-chain queue | One `Queue` of tagged events (voice change, playing change, heartbeat, wrap-up due, lobby due, resync) and one consumer fiber | Events are handled one at a time, in order; one event's failure alerts and the loop goes on |
| `live.ts`: `heartbeat`, `wrapUp`, `lobbyTimer` | One `FiberHandle` each: setting a new timer replaces the old one | Same delays, including "already due → try again in a minute" |
| `presence.ts` listener arrays | A `PubSub`; `Live` subscribes within the leader's scope | A snapshot still reports everything that changed while disconnected as changes |
| `panels.ts` `syncing` map | Keyed permits: one sync per card at a time | An older render never lands on top of a newer one |
| `alerts.ts` promise-chain `queue` | A `Semaphore(1)` or a `Queue` with one worker | DMs go out one at a time; throttling rules unchanged; reporting never throws into the caller |
| `reddit.ts` background refill + `running` | A `FiberHandle`; `refilling` reads whether it holds a fiber | `postDaily` still skips while a refill runs |
| Every `Promise.all` (7 places) | `Effect.forEach(…, { concurrency })` with the number written out | Same fan-out as today (unbounded where it is three players) |
| `main.ts` `lead()` loop, `stopLeading`, `Promise.race` | `Leadership`: a scoped term (§13) | — |
| `gateway.ts` connect with timeout + `connectGateway` back-off | A scoped resource: acquire = connect within 30 s, release = `destroy`; retried on a capped exponential schedule (2 s doubling to 60 s) | Until connected, voice lookups fall back to REST; a refused presence intent (4014) is remembered and the next connect goes without it |

## 12. HTTP server and interactions

- `HttpRouter` on `NodeHttpServer`, port from config, 1 MB body limit, same routes and
  responses. Use plain `HttpRouter` routes, not `HttpApi`: the wire format is fixed by Discord
  and by the Python QA scripts, and nothing consumes a generated client or OpenAPI document.
- `/interactions` reads the raw body text (the signature covers the exact bytes), verifies the
  Ed25519 signature, then decodes.
- Admin routes sit behind one middleware doing the constant-time bearer check; a wrong or missing
  token answers `401 "nope"`, as today.
- Each admin action's body is a `Schema` tagged union on `action`; the handler is a `Match` over
  it. An unknown action answers `400 { "error": "action?" }`, as today.
- Any failure not handled by a route answers `500 { "error": "<text>" }` and reports to `Alerts`
  when it is our fault, as the Fastify error handler does today.
- While shutting down, `/health` answers 503 first, then the server stops taking requests and
  finishes those in flight (`gracefulShutdownTimeout`; check the option).
- Tests call the router without a port: `HttpRouter.toWebHandler` gives a
  `(Request) => Promise<Response>` function, the replacement for `app.inject`.
- Today's answers to edge cases stay (spike S4): a body over 1 MB (`MaxBodySize`) answers 500
  `{ "error": … }` because Fastify's error handler answered every error that way, and is not
  alerted (only errors that are our fault are); an unknown route answers Fastify's JSON 404 body.
- **Interactions are decoded, then routed.** A `Schema` for the parts of an interaction the bot
  reads; a parser turning `custom_id` into a tagged union (`gn:<day>:<action>[:<value>]`,
  `poll:…`, `lob:…`, `late:…`, `room:…`, `st:…`, `snz:…`, `hub:…`, `plan:…`, `games:…`, `v:…`,
  the retired `tb:…`); a `Match` over the union. An id that doesn't parse answers "That button is
  from an older version of me", as today. The timing log and the 3-second alert stay.

## 13. Lifecycle

**Startup** (`main.ts`): read config → open the pool → run migrations → start the HTTP server →
start trying to lead. `NodeRuntime.runMain(Layer.launch(Main))`.

**A leader's term** is one scope: acquire the lock; inside it start `Live`, the `Ticker`, and the
gateway (connecting in the background). The term ends when the lock's connection is lost or the
app is shutting down; closing the scope stops everything in it, then the lock is released. Then
wait 2 s and try to lead again. `/health.leader` is true only inside a term.

**Shutdown, in this order** (it is today's order, and blue/green handover depends on it):

1. Mark shutting down: `/health` answers 503 from now on.
2. End the leader's term, so the other copy can take the gateway and the clock at once. Give
   this at most 15 s. In parallel wait 3 s, so the proxy's health check has moved traffic away.
3. Stop the HTTP server: no new requests, finish those in flight.
4. Drain background work, up to 20 s.
5. Close the pool. Exit 0.

A hard cap stays outside Effect: 35 s after the signal, `process.exit(1)`, whatever is hanging.
Docker's own limit is 40 s.

Don't rely on the order in which independent layers happen to be torn down. Write the order
above explicitly (one scoped program that owns the steps), and test it (`verification.md` §7).

`unhandledRejection` and `uncaughtException` handlers stay as the last net (alert, and for the
second one exit), in `main.ts`.

## 14. Observability

- Every `console.log` becomes `Effect.log*` at a deliberate level, with the variable parts as
  annotations. Keep these phrases findable in the text, because the owner greps for them:
  `leader: took over`, `leader: stepped down`, `gateway: ready`, `interaction`, `slow
  interaction`, `minute`, `started on time`, `memes refilled`, `listening on`.
- Output stays one line per entry on stdout (the container logs to journald; `ssh vps app-logs`
  reads it): `Logger.consoleLogFmt` (spike S10). Each message is one string (`interaction 412 ms`),
  because several message parts print as repeated `message=` fields; variable parts that aren't
  in today's phrase go in annotations.
- Spans: service methods (through `Effect.fn`), each HTTP request, each interaction (with what
  was tapped and by whom), each job, each minute, each voice event, each SQL statement and each
  outbound HTTP call (the last two come from the libraries).
- Metrics (`Metric`): taps handled and their duration, jobs run/failed and their duration,
  Discord calls by outcome, alerts sent and held back, background tasks in flight.
- Export: an OTLP layer from `effect/observability`, switched on only when `OTLP_URL` is set.
  It is unset everywhere for now. Standing up a trace viewer on the server is a separate plan
  for the owner to decide; until then spans still give timing and a span stack in error reports.
- `Alerts` stays the one place that decides what is DMed. Look at `ErrorReporter` (new in
  version 4) as the hook for the outermost boundaries; use it if it keeps "one place decides",
  otherwise call `Alerts` directly.

## 15. Interruption safety

Interruption is new. Promise code could not be cancelled mid-flight; Effect code can be, at any
`yield*`, by a timeout, a closing scope or shutdown. These regions must be uninterruptible, and
each needs the test named in `verification.md` §7:

1. **Claim → post → record.** Every "claim in the database, post to Discord, record the message
   id" sequence: the daily meme, the game-night card, the start ping, roasts, recaps, the Lobby
   question, news items, late slips, room creation (placeholder → channel → real id). From the
   successful claim to the recorded result, no interruption.
2. **Releasing a claim happens only on a typed failure of the post.** Never on interruption: an
   interrupted POST may have gone through, and the hard rule is no duplicates.
3. **A start that has begun finishes** (from `claimStart` on).
4. **Transactions** commit or roll back as a whole (the driver does this; confirm in the spike).
5. **Stepping down** releases the leader lock even when interrupted.

Timeouts (phase 7) are placed around whole jobs. Because these regions are uninterruptible, a
timeout that fires while one is running takes effect only after it has finished.

## 16. Boundary files (the allowed exceptions)

Promise-style constructs are allowed only here, each behind a comment explaining why:

| File | Allowed | Why |
|---|---|---|
| `main.ts` | `runMain`, the 35 s `setTimeout` exit, the two `process.on` last-resort handlers | the process edge |
| `gateway.ts` | `@discordjs/ws` event callbacks, one bridge from callbacks into a `Queue` | a callback-based library |
| the signature verifier | `crypto.subtle` calls wrapped once in `Effect.tryPromise` | Web Crypto is promise-based |
| `db` setup | whatever Drizzle's migrator needs for file access | third-party API |
| test harness | `ManagedRuntime` | vitest edge |

## 17. What not to use

- `dfx`: an Effect-native Discord library exists for version 4, but adopting it would change
  REST retry behaviour and the gateway implementation at the same time as everything else. It
  can be its own plan later.
- `HttpApi`, RPC, cluster, workflow, the event log, STM (`Tx*`): no use here.
- `Stream` where a loop is clearer. The voice event loop is a queue and one consumer.
- In-memory replacements for database guards (README, "What must not change").
- `Effect.orDie` to make an error disappear from a signature. If an error can't happen, say why
  in a comment; if it can, handle or declare it.
