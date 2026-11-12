// Test 8 (plan 05, verification.md §7; architecture.md §11, §15): a start timer interrupted while it
// sleeps claims nothing (the next leader arms its own); interrupted once it has claimed the start,
// it finishes: the ping goes out and the night is counted as played.
import { afterAll, beforeAll, expect, it } from "@effect/vitest";
import { eq } from "drizzle-orm";
import { Deferred, Effect, Fiber } from "effect";
import { gameNights, games, lobbyPrompts, nightAttendance, rooms, sessions, voiceSegments } from "../src/db/schema.js";
import { Db } from "../src/db/db.js";
import { nowSec } from "../src/clock.js";
import { Ticker } from "../src/scheduler.js";
import { harness, routes } from "./fx.js";

const h = harness({
  tables: [lobbyPrompts, sessions, nightAttendance, voiceSegments, rooms, gameNights],
  discord: { firstId: 50000, routes: [routes.noVoiceState, routes.lobbyOnly] },
  clock: "2026-11-10T19:00:00Z", // Tuesday 21:00 in Vilnius
});
const calls = h.calls;
beforeAll(async () => {
  await h.t.pool.query(`CREATE OR REPLACE FUNCTION qa_hold() RETURNS trigger AS $$ BEGIN PERFORM pg_sleep(0.3); RETURN NEW; END $$ LANGUAGE plpgsql`);
});
afterAll(() => h.t.pool.query("DROP FUNCTION IF EXISTS qa_hold() CASCADE"));

const DAY = "2026-11-10";
const sql = (text: string) => Effect.promise(() => h.t.pool.query(text));
const pings = () => calls.filter((c) => c.method === "POST" && c.path === "/channels/gn/messages");

const night = (startsIn: number) =>
  Effect.gen(function* () {
    const db = yield* Db;
    // (games isn't emptied between this file's tests: each sets its own row)
    yield* db.insert(games).values({ name: "R.E.P.O.", emoji: "📦", added_at: "2026-11-03", plays: 2 }).onConflictDoUpdate({ target: games.name, set: { plays: 2 } });
    yield* db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: (yield* nowSec) + startsIn, message_id: "card" });
  });

/** The leader's clock, in its own fiber; done once its first minute has lined up the starts. */
const clock = Effect.gen(function* () {
  const armed = yield* Deferred.make<void>();
  const fiber = yield* Effect.forkChild(Effect.scoped(Ticker.use((tk) => tk.run({ minute: Effect.as(Deferred.succeed(armed, undefined), {}) }))));
  yield* Deferred.await(armed);
  return { stop: () => Fiber.interrupt(fiber) };
});

it.effect("a start timer stopped while it sleeps claims nothing", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* night(11); // the room opens in a second
    const c = yield* clock;
    const t0 = performance.now();
    yield* c.stop();
    expect(performance.now() - t0).toBeLessThan(500); // it doesn't wait for the night
    yield* Effect.sleep(2000); // past the room's opening: no timer is left to open it
    expect((yield* db.select().from(gameNights))[0].reminded).toBe(false);
    expect(pings()).toEqual([]);
  }).pipe(h.provide),
);

it.effect("a start timer stopped once it has claimed the start finishes it", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* night(1); // the room opens now, the ping is in a second
    yield* sql(`CREATE TRIGGER qa_hold BEFORE UPDATE ON game_nights FOR EACH ROW WHEN (NEW.reminded AND NOT OLD.reminded) EXECUTE FUNCTION qa_hold()`);
    yield* Effect.gen(function* () {
      const c = yield* clock;
      for (let i = 0; ; i++) {
        const { rows } = yield* sql(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event = 'PgSleep' AND query ILIKE '%game_nights%'`);
        if (rows[0].n) break;
        if (i > 300) return yield* Effect.die(new Error("the claim never ran"));
        yield* Effect.sleep(10);
      }
      yield* c.stop(); // while the claim is in the database
    }).pipe(Effect.ensuring(sql("DROP TRIGGER IF EXISTS qa_hold ON game_nights")));
    expect((yield* db.select().from(gameNights))[0].reminded).toBe(true);
    expect(pings()).toHaveLength(1);
    expect((yield* db.select().from(games).where(eq(games.name, "R.E.P.O.")))[0].plays).toBe(3);
  }).pipe(h.provide),
);
