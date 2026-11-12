// 📊 Stats maths and voice tracking, against a real Postgres: calls, time together, game time,
// periods, recaps, and segments opened/extended/closed by live voice changes.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import * as act from "./old/activity.js";
import { gameNights, games, recaps, voiceSegments } from "../src/db/schema.js";
import { harness, type TestDb } from "./harness.js";
import type { Env } from "./old/env.js";

const H = 3600;
const T0 = Date.parse("2026-11-06T17:00:00Z") / 1000; // Friday 19:00 in Vilnius
const at = (h: number) => T0 + Math.round(h * H); // hours after Friday 19:00
const LOBBY = "lobby";
const REPO = "repo-room";

const h = harness({
  setup: (t) => t.db.insert(games).values({ name: "R.E.P.O.", emoji: "📦", added_at: "2026-11-03" }).onConflictDoNothing(), // also seeded
  tables: [voiceSegments, gameNights, recaps],
  clock: (T0 + 24 * H) * 1000, // "now" is the next day, so nothing is cut off at now
});
let t: TestDb;
let env: Env;
beforeAll(() => void ({ t, env } = h));

/** A segment from h1 to h2 (hours after 19:00), seen leaving (ended_at) unless `unseen`. */
const seg = (user: string, channel: string, h1: number, h2: number, game: string | null = null, unseen = false) => ({
  user_id: user,
  channel_id: channel,
  game,
  started_at: at(h1),
  last_seen: unseen ? at(h2) - 60 : at(h2),
  ended_at: unseen ? null : at(h2),
  open: false,
});
const put = (...segs: ReturnType<typeof seg>[]) => t.db.insert(voiceSegments).values(segs);
const crunch = () => act.crunch(env, at(-10), at(20));

test("Lobby → game room together is one call; game and hangout time split", async () => {
  await put(seg("a", LOBBY, 0, 0.5), seg("b", LOBBY, 0.02, 0.5), seg("a", REPO, 0.5, 2, "R.E.P.O."), seg("b", REPO, 0.5, 2, "R.E.P.O."), seg("c", REPO, 1, 2, "R.E.P.O."));
  const s = await crunch();
  expect(s.calls.length).toBe(1);
  expect(s.total).toBe(at(2) - at(0.02)); // together from when b joined
  expect(s.byGame.get("R.E.P.O.")).toBe(1.5 * H);
  expect(s.hangout).toBe(at(0.5) - at(0.02));
  expect([...s.perUser]).toEqual([
    ["a", 2 * H],
    ["b", at(2) - at(0.02)],
    ["c", H],
  ]);
  expect(s.calls[0].firstIn).toBe("a");
});

test("a 10-minute break makes two calls; a 2-minute one doesn't", async () => {
  await put(seg("a", LOBBY, 0, 1), seg("b", LOBBY, 0, 1), seg("a", LOBBY, 1 + 10 / 60, 2), seg("b", LOBBY, 1 + 10 / 60, 2));
  expect((await crunch()).calls.length).toBe(2);
  await t.db.delete(voiceSegments);
  await put(seg("a", LOBBY, 0, 1), seg("b", LOBBY, 0, 1), seg("a", LOBBY, 1 + 2 / 60, 2), seg("b", LOBBY, 1 + 2 / 60, 2));
  expect((await crunch()).calls.length).toBe(1);
});

test("sitting in voice alone is voice time, not a call", async () => {
  await put(seg("a", LOBBY, 0, 1));
  const s = await crunch();
  expect(s.calls.length).toBe(0);
  expect(s.total).toBe(0);
  expect(s.perUser.get("a")).toBe(H);
});

test("two people in different channels aren't together", async () => {
  await put(seg("a", LOBBY, 0, 1), seg("b", REPO, 0, 1, "R.E.P.O."));
  expect((await crunch()).total).toBe(0);
});

test("a call over the period boundary only counts the part inside", async () => {
  await put(seg("a", LOBBY, 0, 4), seg("b", LOBBY, 0, 4));
  expect((await act.crunch(env, at(-10), at(3))).total).toBe(3 * H);
});

test("outsiders' voice time is ignored", async () => {
  await put(seg("a", LOBBY, 0, 1), seg("stranger", LOBBY, 0, 1));
  const s = await crunch();
  expect(s.total).toBe(0);
  expect(s.perUser.has("stranger")).toBe(false);
});

test("segments that ended unseen (old checks, or a restart) count a minute past their last sighting", async () => {
  await put(seg("a", LOBBY, 0, 1, null, true), seg("b", LOBBY, 0, 1, null, true));
  expect((await crunch()).total).toBe(H);
});

test("game nights are counted by game", async () => {
  await t.db.insert(gameNights).values([
    { day: "2026-11-06", stage: "set", game: "R.E.P.O.", start_at: at(0), reminded: true },
    { day: "2026-11-05", stage: "off", game: null, start_at: null, reminded: false },
    { day: "2026-11-07", stage: "set", game: "R.E.P.O.", start_at: at(24), reminded: false },
  ]);
  const s = await act.crunch(env, at(-48), at(48)); // Thursday to Saturday
  expect([s.nights.played, s.nights.cancelled, s.nights.upcoming, s.nights.games.get("R.E.P.O.")]).toEqual([1, 1, 1, 1]);
});

test("the stats card reads right", async () => {
  await put(seg("a", REPO, 0, 2.5, "R.E.P.O."), seg("b", REPO, 0, 2.5, "R.E.P.O."), seg("c", REPO, 0.5, 2.5, "R.E.P.O."));
  const text = (await act.statsBody(env, "This week", await crunch())).join("\n");
  expect(text).toMatch(/Together · \*\*2h 30m\*\*/);
  expect(text).toMatch(/📦 R\.E\.P\.O\. \*\*2h 30m\*\*/);
  expect(text).toMatch(/🥇 <@a> \*\*2h 30m\*\*/);
  expect(text).toMatch(/busiest day \*\*Friday\*\*/);
  expect(text).toMatch(/usually starting around \*\*19:00\*\*/);
});

test("voice time alone: no '0m together' headline; a shared card says who shared it", async () => {
  await put(seg("a", LOBBY, 0, 1));
  await t.db.insert(gameNights).values({ day: "2026-11-06", stage: "off", game: null, start_at: null, reminded: false });
  const text = (await act.statsBody(env, "This week", await crunch())).join("\n");
  expect(text).not.toMatch(/Together · /);
  expect(text).toMatch(/No calls with two or more of you yet/);
  vi.setSystemTime((T0 + 2 * H) * 1000); // same week
  expect(JSON.stringify(await act.statsPanel(env, "week", 0, "a"))).toContain("Shared by <@a>");
});

test("a quiet period says so", async () => {
  const text = (await act.statsBody(env, "This week", await crunch())).join("\n");
  expect(text).toMatch(/Nothing yet/);
});

test("durations", () => {
  expect([act.dur(300), act.dur(3725), act.dur(36000)]).toEqual(["5m", "1h 02m", "10h 00m"]);
});

test("weeks run Monday 00:00 to Monday 00:00, local time", () => {
  vi.setSystemTime(Date.parse("2026-11-06T17:00:00Z")); // Friday
  const w = act.period(env, "week");
  expect(w.from).toBe(Date.parse("2026-11-01T22:00:00Z") / 1000); // Mon 2 Nov 00:00 (UTC+2)
  expect(w.to - w.from).toBe(7 * 86400);
  expect(act.period(env, "week", -1).to).toBe(w.from);
});

test("months and years, across DST", () => {
  vi.setSystemTime(Date.parse("2026-11-06T17:00:00Z"));
  const oct = act.period(env, "month", -1);
  expect(oct.from).toBe(Date.parse("2026-09-30T21:00:00Z") / 1000); // 1 Oct 00:00 summer time
  expect(oct.to).toBe(Date.parse("2026-10-31T22:00:00Z") / 1000); // 1 Nov 00:00 winter time
  expect(act.period(env, "month", 2).from).toBe(Date.parse("2026-12-31T22:00:00Z") / 1000); // month overflow → next year
  expect(act.period(env, "year").from).toBe(Date.parse("2025-12-31T22:00:00Z") / 1000);
});

test("Monday 10:00: last week's recap is posted once; quiet weeks are skipped", async () => {
  const posts: { url: string; body: any }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    posts.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ id: "1" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    await put(seg("a", REPO, 0, 2, "R.E.P.O."), seg("b", REPO, 0, 2, "R.E.P.O."));
    vi.setSystemTime(Date.parse("2026-11-09T07:30:00Z")); // Monday 09:30: too early
    expect(await act.recaps(env)).toEqual({});
    vi.setSystemTime(Date.parse("2026-11-09T08:05:00Z")); // Monday 10:05
    expect(await act.recaps(env)).toEqual({ "games-week:2026-11-02": "posted" });
    expect(posts.length).toBe(1);
    expect(JSON.stringify(posts[0].body)).toMatch(/Weekly recap · 2 Nov – 8 Nov/);
    expect(JSON.stringify(posts[0].body)).toMatch(/2h 00m/);
    expect(await act.recaps(env)).toEqual({}); // the next minute doesn't post it again
    await t.db.delete(voiceSegments);
    vi.setSystemTime(Date.parse("2026-11-16T08:05:00Z"));
    expect(await act.recaps(env)).toEqual({ "games-week:2026-11-09": "quiet, skipped" });
    expect(posts.length).toBe(1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------------------------------------------------------------- live tracking

const where = (m: Record<string, string | null>) => new Map(Object.entries(m));
const segs = () => t.db.select().from(voiceSegments).orderBy(voiceSegments.id);

test("joins, moves and leaves are recorded to the second", async () => {
  await act.track(env, where({ a: LOBBY }), at(0));
  await act.track(env, where({ a: LOBBY, b: LOBBY }), at(0) + 7);
  await act.track(env, where({ a: REPO, b: LOBBY }), at(0) + 65); // a hops into the room
  await act.track(env, where({ a: REPO, b: null }), at(0) + 90); // b leaves
  const s = await segs();
  expect(s.map((x) => [x.user_id, x.channel_id, x.started_at - at(0), x.ended_at && x.ended_at - at(0), x.open])).toEqual([
    ["a", LOBBY, 0, 65, false],
    ["b", LOBBY, 7, 90, false],
    ["a", REPO, 65, null, true],
  ]);
});

test("heartbeats extend a segment; a long silence (the bot was away) ends it unseen", async () => {
  await act.track(env, where({ a: LOBBY }), at(0));
  await act.track(env, where({ a: LOBBY }), at(0) + 60);
  await act.track(env, where({ a: LOBBY }), at(0) + 120);
  let s = await segs();
  expect(s.length).toBe(1);
  expect(s[0].last_seen).toBe(at(0) + 120);
  await act.track(env, where({ a: LOBBY }), at(0) + 1000); // 880 s of nothing
  s = await segs();
  expect(s.length).toBe(2);
  expect([s[0].open, s[0].ended_at, act.segmentEnd(s[0], at(1))]).toEqual([false, null, at(0) + 180]);
  expect(s[1].open).toBe(true);
});

test("a racing duplicate check doesn't open a second segment", async () => {
  await Promise.all([act.track(env, where({ a: LOBBY }), at(0)), act.track(env, where({ a: LOBBY }), at(0))]);
  expect((await segs()).length).toBe(1);
});

test("a recap that fails to post is tried again the next minute", async () => {
  let fail = true;
  const posts: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (fail) return new Response(JSON.stringify({ message: "Missing Access", code: 50001 }), { status: 403, headers: { "Content-Type": "application/json" } });
    posts.push(String(url));
    return new Response(JSON.stringify({ id: "1" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    await put(seg("a", REPO, 0, 2, "R.E.P.O."), seg("b", REPO, 0, 2, "R.E.P.O."));
    vi.setSystemTime(Date.parse("2026-11-09T08:05:00Z")); // Monday 10:05
    await expect(act.recaps(env)).rejects.toThrow(/403/);
    fail = false;
    vi.setSystemTime(Date.parse("2026-11-09T08:06:00Z"));
    expect(await act.recaps(env)).toEqual({ "games-week:2026-11-02": "posted" });
    expect(posts).toHaveLength(1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the monthly recap comes on the 1st, and only then", async () => {
  const posts: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    posts.push(String(init.body));
    return new Response(JSON.stringify({ id: "1" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    await put(seg("a", REPO, 0, 2, "R.E.P.O."), seg("b", REPO, 0, 2, "R.E.P.O."));
    vi.setSystemTime(Date.parse("2026-12-02T08:05:00Z")); // Wednesday 2 Dec 10:05
    expect(await act.recaps(env)).toEqual({});
    vi.setSystemTime(Date.parse("2026-12-01T08:05:00Z")); // Tuesday 1 Dec 10:05
    expect(await act.recaps(env)).toEqual({ "games-month:2026-11-01": "posted" });
    expect(posts.join("")).toMatch(/Monthly recap · November 2026/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
