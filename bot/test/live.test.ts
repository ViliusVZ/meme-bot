// Live voice (live.ts), driven through presence as the gateway feeds it: a room's wrap-up happens
// exactly at its grace period after the last person leaves, and one voice change that fails is
// reported while the next is still handled (part of test 10, plan 05 verification.md §7).
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as live from "../src/live.js";
import * as presence from "../src/presence.js";
import * as alerts from "../src/alerts.js";
import { lobbyPrompts, readyRooms, rooms, sessions, voiceSegments } from "../src/db/schema.js";
import { harness, routes, type TestDb } from "./harness.js";
import type { Env } from "../src/env.js";

const h = harness({
  tables: [lobbyPrompts, readyRooms, sessions, voiceSegments, rooms],
  discord: { firstId: 60000, routes: [routes.noVoiceState, routes.lobbyOnly] },
});
let t: TestDb;
let env: Env;
beforeAll(() => void ({ t, env } = h));
afterEach(() => {
  vi.useRealTimers();
});

const START = Date.parse("2026-11-10T19:00:00Z"); // Tuesday 21:00 in Vilnius: no game night
const now = () => Math.floor(Date.now() / 1000);
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
/** Let the database work already started finish on the real clock, before time jumps again (a jump would fire the pool's acquire timeout). */
const settle = async (ms = 300) => {
  const end = performance.now() + ms;
  while (performance.now() < end) await new Promise((ok) => setImmediate(ok));
};
const fake = () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(START);
};
const moves = (channel: string) => h.calls.filter((c) => c.method === "PATCH" && c.path === `/channels/${channel}`);

test("a room is wrapped up exactly 15 minutes after the last person leaves it", async () => {
  fake();
  await t.db.insert(rooms).values({ channel_id: "r1", game: "R.E.P.O.", created_at: now() - 600, last_seen: now() - 60 });
  presence.snapshot([]);
  const w = live.start(env);
  presence.snapshot([{ user_id: "a", channel_id: "r1" }]);
  await settle();
  await tick(1000);
  const left = now();
  presence.update("a", null);
  await settle();
  await tick(15 * 60_000 - 100); // 14:59.9 after the leave
  await settle();
  expect((await t.db.select().from(rooms).where(eq(rooms.channel_id, "r1")))[0].archived_at).toBeNull();
  expect(moves("r1")).toEqual([]);
  await tick(700); // 15:00.6 (the timer aims half a second past the grace, so it's never early)
  await settle();
  expect((await t.db.select().from(rooms).where(eq(rooms.channel_id, "r1")))[0].archived_at).toBe(left + 15 * 60);
  expect(moves("r1")).toHaveLength(1);
  await w.stop();
});

test("a voice change that fails is reported, and the next one is still handled", async () => {
  fake();
  alerts._reset();
  alerts.setup({ ...env, ALERT_USER_ID: "owner" });
  // the first segment written fails once, as a database hiccup would
  await t.pool.query("CREATE SEQUENCE IF NOT EXISTS qa_once");
  await t.pool.query(`CREATE OR REPLACE FUNCTION qa_fail_once() RETURNS trigger AS $$ BEGIN IF nextval('qa_once') = 1 THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
  await t.pool.query("CREATE TRIGGER qa_fail_once BEFORE INSERT ON voice_segments FOR EACH ROW EXECUTE FUNCTION qa_fail_once()");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    presence.snapshot([]);
    const w = live.start(env);
    presence.snapshot([{ user_id: "b", channel_id: "lobby" }]); // fails
    presence.update("c", "lobby"); // still handled
    await settle();
    await tick(1000);
    await settle();
    await w.stop();
    await alerts._settle();
  } finally {
    log.mockRestore();
    await t.pool.query("DROP TRIGGER IF EXISTS qa_fail_once ON voice_segments");
    await t.pool.query("DROP FUNCTION IF EXISTS qa_fail_once()");
    await t.pool.query("DROP SEQUENCE IF EXISTS qa_once");
  }
  const dms = h.calls.filter((c) => c.method === "POST" && /^\/channels\/[^/]+\/messages$/.test(c.path) && JSON.stringify(c.body ?? "").includes("live voice"));
  expect(dms).toHaveLength(1);
  const seen = (await t.db.select().from(voiceSegments)).map((s) => s.user_id).sort();
  expect(seen).toEqual(["b", "c"]); // b's segment on the next change, c's on its own
  alerts._reset();
});
