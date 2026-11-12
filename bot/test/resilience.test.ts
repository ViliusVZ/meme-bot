// Resilience: the leader's clock notices when it's stuck (and /health shows how it's ticking), and the
// bot's database connections give up on a stuck query instead of hanging the job behind it.
import { expect, it } from "@effect/vitest";
import { Clock, Deferred, Effect, Exit, Fiber, Layer } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { HttpRouter, HttpServer } from "effect/http";
import { SqlClient } from "effect/sql";
import { Ticker } from "../src/scheduler.js";
import { AppStatus, ROUTER_CONFIG, routesOn } from "../src/app.js";
import type { AppServices } from "../src/runtime.js";
import { harness } from "./fx.js";

// the clock tests drive the ticker's time themselves (the test's TestClock)
const h = harness({ clock: "test" });

const tick = (ms: number) => TestClock.adjust(ms);
const sinceTick = Ticker.use((t) => t.sinceTick);
/** The leader's clock, in its own fiber (as main.ts runs it for a term). */
const start = (opts: Parameters<Ticker["Service"]["run"]>[0]) => Effect.forkChild(Effect.scoped(Ticker.use((t) => t.run(opts))), { startImmediately: true });
/** Check again every 50 ms on the real clock (the ticker's work is real database work), for up to a second. */
const waitFor = <A, E, R>(check: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    for (let i = 0; ; i++) {
      const exit = yield* Effect.exit(check);
      if (Exit.isSuccess(exit) || i >= 20) return yield* exit;
      yield* TestClock.withLive(Effect.sleep(50));
    }
  });
/** GET a path from the app's routes (on this test's services), as /health's watchdog does. */
const get = (url: string, status: { leader: boolean; shuttingDown: boolean }) =>
  Effect.gen(function* () {
    const statusLayer = Layer.succeed(AppStatus, AppStatus.of({ leader: Effect.succeed(status.leader), shuttingDown: Effect.succeed(status.shuttingDown), publicKey: h.config.discordPublicKey }));
    const web = HttpRouter.toWebHandler(routesOn(statusLayer, yield* Effect.context<AppServices>()).pipe(Layer.provide(HttpServer.layerServices)), { disableLogger: true, routerConfig: ROUTER_CONFIG });
    const res = yield* Effect.promise(() => web.handler(new Request(`http://local${url}`, { method: "GET" })));
    const body: unknown = yield* Effect.promise(() => res.json());
    yield* Effect.promise(() => web.dispose());
    return body;
  });

it.effect("the clock says how long since its last minute, and nothing once it stops", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-09T17:00:30Z"));
    const minutes: number[] = [];
    const clock = yield* start({ minute: Effect.map(Clock.currentTimeMillis, (now) => (minutes.push(now), {})) });
    yield* waitFor(Effect.sync(() => expect(minutes).toHaveLength(1))); // catches up at once
    expect(yield* sinceTick).toBe(0);
    yield* tick(20_000);
    expect(yield* sinceTick).toBe(20);
    yield* tick(15_000); // past the top of the minute
    yield* waitFor(Effect.sync(() => expect(minutes).toHaveLength(2)));
    expect(minutes[1]).toBeGreaterThanOrEqual(Date.parse("2026-11-09T17:01:00Z"));
    expect(yield* sinceTick).toBeLessThan(2);
    expect(yield* get("/health", { leader: true, shuttingDown: false })).toMatchObject({ ok: true, leader: true, clock: expect.any(Number), version: "dev" });
    yield* Fiber.interrupt(clock);
    expect(yield* sinceTick).toBeNull(); // a follower has no clock
  }).pipe(h.provide),
);

it.effect("a minute stuck for 5 minutes is reported once, so the bot can restart itself", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-09T17:00:30Z"));
    const release = yield* Deferred.make<void>();
    const stalls: number[] = [];
    const clock = yield* start({ minute: Effect.as(Deferred.await(release), {}), onStall: (mins) => Effect.sync(() => void stalls.push(mins)) });
    yield* tick(4 * 60_000);
    expect(stalls).toEqual([]);
    expect(yield* sinceTick).toBe(240); // /health shows it falling behind
    yield* tick(90_000);
    expect(stalls).toEqual([5]);
    yield* tick(10 * 60_000);
    expect(stalls).toEqual([5]); // once
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.interrupt(clock);
  }).pipe(h.provide),
);

it.effect("a query stuck on a lock gives up after 30 s instead of hanging its job", () =>
  Effect.gen(function* () {
    // the app's own pool (src/db/db.ts), as every job uses it
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`SELECT current_setting('statement_timeout') AS st, current_setting('idle_in_transaction_session_timeout') AS idle`;
    expect(rows[0]).toEqual({ st: "30s", idle: "1min" });
  }).pipe(h.provide),
);
