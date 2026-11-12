// Live voice (live.ts), driven through presence as the gateway feeds it: a room's wrap-up happens
// exactly at its grace period after the last person leaves, and one voice change that fails is
// reported while the next is still handled (part of test 10, plan 05 verification.md §7).
import { expect, it } from "@effect/vitest";
import { eq } from "drizzle-orm";
import { Effect, Fiber } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { Live } from "../src/live.js";
import { Presence } from "../src/presence.js";
import { Alerts } from "../src/alerts.js";
import { Db } from "../src/db/db.js";
import { nowSec } from "../src/clock.js";
import { lobbyPrompts, readyRooms, rooms, sessions, voiceSegments } from "../src/db/schema.js";
import { harness, routes } from "./fx.js";

// the tests drive time themselves (the test's TestClock): the wrap-up timer fires as the clock moves
const h = harness({
  tables: [lobbyPrompts, readyRooms, sessions, voiceSegments, rooms],
  discord: { firstId: 60000, routes: [routes.noVoiceState, routes.lobbyOnly] },
  clock: "test",
});

const START = Date.parse("2026-11-10T19:00:00Z"); // Tuesday 21:00 in Vilnius: no game night
const tick = (ms: number) => TestClock.adjust(ms);
/** Let the database work already started finish on the real clock, before time jumps again (a jump would fire the pool's acquire timeout). */
const settle = (ms = 300) => TestClock.withLive(Effect.sleep(ms));
const fake = () => TestClock.setTime(START);
const sql = (text: string) => Effect.promise(() => h.t.pool.query(text));
const moves = (channel: string) => h.calls.filter((c) => c.method === "PATCH" && c.path === `/channels/${channel}`);
/** Live voice for a leader's term, in its own fiber (started at once, so it hears the next change). */
const start = Effect.map(Effect.forkChild(Effect.scoped(Effect.andThen(Live.use((l) => l.watch), Effect.never)), { startImmediately: true }), (fiber) => ({ stop: () => Fiber.interrupt(fiber) }));

it.effect("a room is wrapped up exactly 15 minutes after the last person leaves it", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const presence = yield* Presence;
    yield* fake();
    const now = yield* nowSec;
    yield* db.insert(rooms).values({ channel_id: "r1", game: "R.E.P.O.", created_at: now - 600, last_seen: now - 60 });
    yield* presence.snapshot([]);
    const w = yield* start;
    yield* presence.snapshot([{ user_id: "a", channel_id: "r1" }]);
    yield* settle();
    yield* tick(1000);
    const left = yield* nowSec;
    yield* presence.update("a", null);
    yield* settle();
    yield* tick(15 * 60_000 - 100); // 14:59.9 after the leave
    yield* settle();
    expect((yield* db.select().from(rooms).where(eq(rooms.channel_id, "r1")))[0].archived_at).toBeNull();
    expect(moves("r1")).toEqual([]);
    yield* tick(700); // 15:00.6 (the timer aims half a second past the grace, so it's never early)
    yield* settle();
    expect((yield* db.select().from(rooms).where(eq(rooms.channel_id, "r1")))[0].archived_at).toBe(left + 15 * 60);
    expect(moves("r1")).toHaveLength(1);
    yield* w.stop();
  }).pipe(h.provide),
);

it.effect("a voice change that fails is reported, and the next one is still handled", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const presence = yield* Presence;
    const alerts = yield* Alerts;
    yield* fake();
    yield* alerts.setOwner("owner"); // ALERT_USER_ID
    // the first segment written fails once, as a database hiccup would
    yield* sql("CREATE SEQUENCE IF NOT EXISTS qa_once");
    yield* sql(`CREATE OR REPLACE FUNCTION qa_fail_once() RETURNS trigger AS $$ BEGIN IF nextval('qa_once') = 1 THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    yield* sql("CREATE TRIGGER qa_fail_once BEFORE INSERT ON voice_segments FOR EACH ROW EXECUTE FUNCTION qa_fail_once()");
    yield* Effect.gen(function* () {
      yield* presence.snapshot([]);
      const w = yield* start;
      yield* presence.snapshot([{ user_id: "b", channel_id: "lobby" }]); // fails
      yield* presence.update("c", "lobby"); // still handled
      yield* settle();
      yield* tick(1000);
      yield* settle();
      yield* w.stop();
      yield* alerts.settle;
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          yield* sql("DROP TRIGGER IF EXISTS qa_fail_once ON voice_segments");
          yield* sql("DROP FUNCTION IF EXISTS qa_fail_once()");
          yield* sql("DROP SEQUENCE IF EXISTS qa_once");
        }),
      ),
    );
    const dms = h.calls.filter((c) => c.method === "POST" && /^\/channels\/[^/]+\/messages$/.test(c.path) && JSON.stringify(c.body ?? "").includes("live voice"));
    expect(dms).toHaveLength(1);
    const seen = (yield* db.select().from(voiceSegments)).map((s) => s.user_id).sort();
    expect(seen).toEqual(["b", "c"]); // b's segment on the next change, c's on its own
  }).pipe(h.provide),
);
