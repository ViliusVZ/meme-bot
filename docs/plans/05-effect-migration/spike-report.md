# 05 · Spike report (phase 2)

Run on 2026-11-11 against `effect` 4.1.4, `@effect/sql-pg` 4.1.4, `@effect/platform-node` 4.1.4,
`drizzle-orm` 1.0.0-rc.5, on a local Postgres 18.6. The throwaway code lived in `bot/spikes/`
and was deleted after this report; each result below is the spike's own output.

All ten pass, three with a design consequence that `architecture.md` now records.

## S1 · Drizzle's Effect driver on PgClient: pass (with an int8 codec)

`drizzle-orm/effect-postgres` `makeWithDefaults()` on a `PgClient` layer:

- insert … returning, `onConflictDoNothing`, `onConflictDoUpdate` with `excluded`: pass
- update … returning (the claim pattern: the second claim gets no row): pass
- jsonb objects and arrays round-trip; citext compares case-insensitively; `db.execute`: pass
- `count()` is a number; `COUNT(*)::int` is a number; timestamptz columns are `Date`: pass
- **bigint**: columns declared `bigint({ mode: "number" })` come back as numbers (Drizzle's own
  codec), but **raw `sql` aggregates over bigint (`MAX`, `GREATEST`) came back as `BigInt`**:
  `@effect/sql-pg` 4.1.4 speaks the Postgres protocol itself (it has no dependency on `pg`), so
  today's global `pg` type parser doesn't apply. Fixed with a client-specific type registry whose
  int8 codec decodes to a number (failing on values beyond `Number.MAX_SAFE_INTEGER`) and encodes
  numbers and bigints: then `MAX`/`GREATEST` are numbers and a 2^40 parameter round-trips.
  `numeric` (`SUM` over bigint) comes back as a string, exactly as `pg` gave it.
- transactions: commit; roll back on a typed failure (which comes out typed), on a defect, and on
  interruption: pass
- a schema per pool through `startupOptions: "-c search_path=…"`; `statement_timeout` reads back
  `30s` and `idle_in_transaction_session_timeout` `1min` through `startupParameters`;
  `application_name` through `applicationName`: pass
- a failed query is `EffectDrizzleQueryError` (wrapping `SqlError`): typed, pass
- each statement gets a span (`postgres`, plus `sql.transaction`, `BEGIN postgres`,
  `COMMIT postgres` around a transaction): pass

## S2 · The leader lock on a dedicated connection: pass, on a one-connection client

- On `sql.reserve` (a pooled connection reserved in a scope): the lock holds across other
  statements and a second client can't take it, **but closing the scope gives the connection back
  to the pool still holding the lock** (another client still couldn't take it afterwards). So
  `reserve` is the wrong tool: stepping down would leave the lock with a pooled connection.
- On `PgClient.makeClient` (one connection of its own) inside the term's scope: the lock is
  taken; a second client can't take it; closing the scope closes the connection and the lock is
  free; an **interrupted** term releases it too. Chosen.
- Killing the backend (`pg_terminate_backend`): the next statement on that connection fails at
  once (2-3 ms), and the client does not quietly reconnect. No event reports the closed socket
  without a statement, so the term pings every 5 seconds: loss is noticed within 5 s (today: at
  once through `pg`'s `end` event, else by a 15 s ping).

## S3 · Migrations through the Effect migrator under our advisory lock: pass

Each starter opens a one-connection client, takes `pg_advisory_lock`, runs
`drizzle-orm/effect-postgres/migrator` `migrate()` on a database built on that client, unlocks.
Two starters at once: both finish (136 ms and 17 ms), 13 rows, 21 tables; a third start applies
nothing (16 ms).

## S4 · HttpRouter on NodeHttpServer: pass

- `HttpRouter.toWebHandler` serves requests with no port (`{ handler, dispose }`)
- the raw body text (`request.text`) and headers are readable; Ed25519 verification through
  `crypto.subtle` (wrapped in `Effect.tryPromise`) passes a good signature and gives 401 to a
  forged one
- `HttpIncomingMessage.MaxBodySize` at 1 MB refuses a larger body with a `RequestError`
  (`BodyTooLarge`); the app maps it, so today's answer (Fastify's error handler: 500
  `{ "error": … }`) can be kept
- a dying handler gives a controllable 500 (`Effect.catchCause` at the route)
- an unknown route answers an empty 404 (Fastify answered a JSON 404; to be matched)
- `NodeHttpServer.layer` with `gracefulShutdownTimeout`: closing its scope lets an in-flight
  request finish (200) and refuses a new connection

## S5 · FetchHttpClient under test and under timeouts: answered

- **The default `Fetch` (`globalThis.fetch`) is captured once**: replacing `globalThis.fetch` after
  the first request is not seen. So the test harness provides `FetchHttpClient.Fetch` itself, as
  a function that reads `globalThis.fetch` on every call (which keeps today's recorder working),
  or a fake.
- With `Fetch` provided: a timeout aborts the underlying request (its signal fires), and so does
  an interruption.

## S6 · Per-call overrides travel: pass

A `Context.Reference` provided around a call is seen by fibers that call starts through
`FiberSet.run`, `FiberHandle.run`, `forkChild` and `forkDetach`, also after an `Effect.sleep`;
work started outside the call sees the default. `architecture.md` §7 stands as written.

## S7 · TestClock and a real database: pass, with two rules

- An `it.effect` test runs real queries; `TestClock.setTime` moves `DateTime.now` and
  `Clock.currentTimeMillis`; a 30-second sleep between two writes lands exactly 30 s later.
- **Rule 1:** build and close the pool (and the throwaway schema) on the live clock
  (`TestClock.withLive`, or a shared layer): closing a pool on the frozen test clock hangs.
- **Rule 2:** the test pool has **no acquire timeout**: the pool runs its timers on the clock of
  the fiber that queries, so moving the test clock past 5 s while a query waits for a connection
  failed it ("Timed out waiting for a pooled connection").
- The helper "run this, advancing time until it finishes": while the code waits on the clock it
  jumps exactly to the next pending sleep (it reads `TestClock`'s `sleeps`, a field of the 4.1.4
  implementation: test-only, version pinned); while it waits on I/O it waits 5 ms of live time; it
  gives up after a live time limit, so it never hangs (checked against `Effect.never`).

## S8 · Uninterruptible regions hold: pass

An interrupt sent during "post, then record" (`Effect.uninterruptible`) lets both finish and takes
effect right after the region (the interrupter waited 312 ms); the step after the region doesn't
run. A timeout around the whole job that fires inside the region also takes effect after it.

## S9 · Old and new code share one set of services: pass

Through one `ManagedRuntime`, promise code writes `Presence` state that Effect code reads, and
Effect → promise code → Effect sees the same state.

## S10 · Logs: `Logger.consoleLogFmt`

- `defaultLogger` prints an error's stack over many lines; `consoleJson` is one line but hard to
  read in `app-logs`; **`consoleLogFmt`** is one line per entry, `level=… message="…"` plus the
  annotations as `key=value` and log spans as `name=<ms>`. Chosen.
- The greppable phrases stay findable when each message is one string: `message="interaction 412
  ms"` (several message parts print as repeated `message=` fields, so messages are written as one
  template string).
- A `Redacted` value prints as `<redacted>` in every form tried: as an annotation, in an object,
  in a template string, through `String(…)`.
