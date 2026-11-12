// Test 8 (plan 05, verification.md §7; architecture.md §11, §15): a start timer interrupted while it
// sleeps claims nothing (the next leader arms its own); interrupted once it has claimed the start,
// it finishes: the ping goes out and the night is counted as played.
import { afterAll, beforeAll, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { Deferred, Effect, Fiber } from "effect";
import { gameNights, games, lobbyPrompts, nightAttendance, rooms, sessions, voiceSegments } from "../src/db/schema.js";
import { Ticker } from "./old/scheduler.js";
import { harness, routes, type TestDb } from "./harness.js";

const h = harness({
  tables: [lobbyPrompts, sessions, nightAttendance, voiceSegments, rooms, gameNights],
  discord: { firstId: 50000, routes: [routes.noVoiceState, routes.lobbyOnly] },
  clock: "2026-11-10T19:00:00Z", // Tuesday 21:00 in Vilnius
});
const calls = h.calls;
let t: TestDb;
beforeAll(async () => {
  ({ t } = h);
  await t.pool.query(`CREATE OR REPLACE FUNCTION qa_hold() RETURNS trigger AS $$ BEGIN PERFORM pg_sleep(0.3); RETURN NEW; END $$ LANGUAGE plpgsql`);
});
afterAll(() => t.pool.query("DROP FUNCTION IF EXISTS qa_hold() CASCADE"));

const DAY = "2026-11-10";
const now = () => Math.floor(Date.now() / 1000);
const pings = () => calls.filter((c) => c.method === "POST" && c.path === "/channels/gn/messages");

async function night(startsIn: number) {
  // (games isn't emptied between this file's tests: each sets its own row)
  await t.db.insert(games).values({ name: "R.E.P.O.", emoji: "📦", added_at: "2026-11-03", plays: 2 }).onConflictDoUpdate({ target: games.name, set: { plays: 2 } });
  await t.db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: now() + startsIn, message_id: "card" });
}

/** The leader's clock, in its own fiber; resolves once its first minute has lined up the starts. */
async function clock() {
  const armed = Effect.runSync(Deferred.make<void>());
  const fiber = h.runtime.runFork(Effect.scoped(Ticker.use((tk) => tk.run({ minute: Effect.as(Deferred.succeed(armed, undefined), {}) }))));
  await Effect.runPromise(Deferred.await(armed));
  return { stop: () => h.runtime.runPromise(Fiber.interrupt(fiber)) };
}

test("a start timer stopped while it sleeps claims nothing", async () => {
  await night(11); // the room opens in a second
  const c = await clock();
  const t0 = performance.now();
  await c.stop();
  expect(performance.now() - t0).toBeLessThan(500); // it doesn't wait for the night
  await new Promise((ok) => setTimeout(ok, 2000)); // past the room's opening: no timer is left to open it
  expect((await t.db.select().from(gameNights))[0].reminded).toBe(false);
  expect(pings()).toEqual([]);
});

test("a start timer stopped once it has claimed the start finishes it", async () => {
  await night(1); // the room opens now, the ping is in a second
  await t.pool.query(`CREATE TRIGGER qa_hold BEFORE UPDATE ON game_nights FOR EACH ROW WHEN (NEW.reminded AND NOT OLD.reminded) EXECUTE FUNCTION qa_hold()`);
  try {
    const c = await clock();
    for (let i = 0; ; i++) {
      const { rows } = await t.pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event = 'PgSleep' AND query ILIKE '%game_nights%'`);
      if (rows[0].n) break;
      if (i > 300) throw new Error("the claim never ran");
      await new Promise((ok) => setTimeout(ok, 10));
    }
    await c.stop(); // while the claim is in the database
  } finally {
    await t.pool.query("DROP TRIGGER IF EXISTS qa_hold ON game_nights");
  }
  expect((await t.db.select().from(gameNights))[0].reminded).toBe(true);
  expect(pings()).toHaveLength(1);
  expect((await t.db.select().from(games).where(eq(games.name, "R.E.P.O.")))[0].plays).toBe(3);
});
