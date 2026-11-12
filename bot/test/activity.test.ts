// 📊 Stats maths and voice tracking, against a real Postgres: calls, time together, game time,
// periods, recaps, and segments opened/extended/closed by live voice changes.
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { Activity, dur, periodAt, segmentEnd, type Kind } from "../src/activity.js";
import { AppConfig } from "../src/config.js";
import { nowSec } from "../src/clock.js";
import { Db } from "../src/db/db.js";
import { gameNights, games, recaps, voiceSegments } from "../src/db/schema.js";
import { harness } from "./fx.js";

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
const put = (...segs: ReturnType<typeof seg>[]) => Db.use((db) => db.insert(voiceSegments).values(segs));
const crunch = () => Activity.use((a) => a.crunch(at(-10), at(20)));
/** The stats period around the clock's now, in the bot's time zone. */
const period = (kind: Kind, offset = 0) =>
  Effect.gen(function* () {
    return periodAt({ zone: (yield* AppConfig).timezone, now: yield* nowSec }, kind, offset);
  });

it.effect("Lobby → game room together is one call; game and hangout time split", () =>
  Effect.gen(function* () {
    yield* put(seg("a", LOBBY, 0, 0.5), seg("b", LOBBY, 0.02, 0.5), seg("a", REPO, 0.5, 2, "R.E.P.O."), seg("b", REPO, 0.5, 2, "R.E.P.O."), seg("c", REPO, 1, 2, "R.E.P.O."));
    const s = yield* crunch();
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
  }).pipe(h.provide),
);

it.effect("a 10-minute break makes two calls; a 2-minute one doesn't", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* put(seg("a", LOBBY, 0, 1), seg("b", LOBBY, 0, 1), seg("a", LOBBY, 1 + 10 / 60, 2), seg("b", LOBBY, 1 + 10 / 60, 2));
    expect((yield* crunch()).calls.length).toBe(2);
    yield* db.delete(voiceSegments);
    yield* put(seg("a", LOBBY, 0, 1), seg("b", LOBBY, 0, 1), seg("a", LOBBY, 1 + 2 / 60, 2), seg("b", LOBBY, 1 + 2 / 60, 2));
    expect((yield* crunch()).calls.length).toBe(1);
  }).pipe(h.provide),
);

it.effect("sitting in voice alone is voice time, not a call", () =>
  Effect.gen(function* () {
    yield* put(seg("a", LOBBY, 0, 1));
    const s = yield* crunch();
    expect(s.calls.length).toBe(0);
    expect(s.total).toBe(0);
    expect(s.perUser.get("a")).toBe(H);
  }).pipe(h.provide),
);

it.effect("two people in different channels aren't together", () =>
  Effect.gen(function* () {
    yield* put(seg("a", LOBBY, 0, 1), seg("b", REPO, 0, 1, "R.E.P.O."));
    expect((yield* crunch()).total).toBe(0);
  }).pipe(h.provide),
);

it.effect("a call over the period boundary only counts the part inside", () =>
  Effect.gen(function* () {
    yield* put(seg("a", LOBBY, 0, 4), seg("b", LOBBY, 0, 4));
    expect((yield* Activity.use((a) => a.crunch(at(-10), at(3)))).total).toBe(3 * H);
  }).pipe(h.provide),
);

it.effect("outsiders' voice time is ignored", () =>
  Effect.gen(function* () {
    yield* put(seg("a", LOBBY, 0, 1), seg("stranger", LOBBY, 0, 1));
    const s = yield* crunch();
    expect(s.total).toBe(0);
    expect(s.perUser.has("stranger")).toBe(false);
  }).pipe(h.provide),
);

it.effect("segments that ended unseen (old checks, or a restart) count a minute past their last sighting", () =>
  Effect.gen(function* () {
    yield* put(seg("a", LOBBY, 0, 1, null, true), seg("b", LOBBY, 0, 1, null, true));
    expect((yield* crunch()).total).toBe(H);
  }).pipe(h.provide),
);

it.effect("game nights are counted by game", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db.insert(gameNights).values([
      { day: "2026-11-06", stage: "set", game: "R.E.P.O.", start_at: at(0), reminded: true },
      { day: "2026-11-05", stage: "off", game: null, start_at: null, reminded: false },
      { day: "2026-11-07", stage: "set", game: "R.E.P.O.", start_at: at(24), reminded: false },
    ]);
    const s = yield* Activity.use((a) => a.crunch(at(-48), at(48))); // Thursday to Saturday
    expect([s.nights.played, s.nights.cancelled, s.nights.upcoming, s.nights.games.get("R.E.P.O.")]).toEqual([1, 1, 1, 1]);
  }).pipe(h.provide),
);

it.effect("the stats card reads right", () =>
  Effect.gen(function* () {
    const activity = yield* Activity;
    yield* put(seg("a", REPO, 0, 2.5, "R.E.P.O."), seg("b", REPO, 0, 2.5, "R.E.P.O."), seg("c", REPO, 0.5, 2.5, "R.E.P.O."));
    const text = (yield* activity.statsBody("This week", yield* crunch())).join("\n");
    expect(text).toMatch(/Together · \*\*2h 30m\*\*/);
    expect(text).toMatch(/📦 R\.E\.P\.O\. \*\*2h 30m\*\*/);
    expect(text).toMatch(/🥇 <@a> \*\*2h 30m\*\*/);
    expect(text).toMatch(/busiest day \*\*Friday\*\*/);
    expect(text).toMatch(/usually starting around \*\*19:00\*\*/);
  }).pipe(h.provide),
);

it.effect("voice time alone: no '0m together' headline; a shared card says who shared it", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const activity = yield* Activity;
    yield* put(seg("a", LOBBY, 0, 1));
    yield* db.insert(gameNights).values({ day: "2026-11-06", stage: "off", game: null, start_at: null, reminded: false });
    const text = (yield* activity.statsBody("This week", yield* crunch())).join("\n");
    expect(text).not.toMatch(/Together · /);
    expect(text).toMatch(/No calls with two or more of you yet/);
    yield* h.setTime((T0 + 2 * H) * 1000); // same week
    expect(JSON.stringify(yield* activity.statsPanel("week", 0, "a"))).toContain("Shared by <@a>");
  }).pipe(h.provide),
);

it.effect("a quiet period says so", () =>
  Effect.gen(function* () {
    const activity = yield* Activity;
    const text = (yield* activity.statsBody("This week", yield* crunch())).join("\n");
    expect(text).toMatch(/Nothing yet/);
  }).pipe(h.provide),
);

it.effect("durations", () =>
  Effect.sync(() => {
    expect([dur(300), dur(3725), dur(36000)]).toEqual(["5m", "1h 02m", "10h 00m"]);
  }).pipe(h.provide),
);

it.effect("weeks run Monday 00:00 to Monday 00:00, local time", () =>
  Effect.gen(function* () {
    yield* h.setTime(Date.parse("2026-11-06T17:00:00Z")); // Friday
    const w = yield* period("week");
    expect(w.from).toBe(Date.parse("2026-11-01T22:00:00Z") / 1000); // Mon 2 Nov 00:00 (UTC+2)
    expect(w.to - w.from).toBe(7 * 86400);
    expect((yield* period("week", -1)).to).toBe(w.from);
  }).pipe(h.provide),
);

it.effect("months and years, across DST", () =>
  Effect.gen(function* () {
    yield* h.setTime(Date.parse("2026-11-06T17:00:00Z"));
    const oct = yield* period("month", -1);
    expect(oct.from).toBe(Date.parse("2026-09-30T21:00:00Z") / 1000); // 1 Oct 00:00 summer time
    expect(oct.to).toBe(Date.parse("2026-10-31T22:00:00Z") / 1000); // 1 Nov 00:00 winter time
    expect((yield* period("month", 2)).from).toBe(Date.parse("2026-12-31T22:00:00Z") / 1000); // month overflow → next year
    expect((yield* period("year")).from).toBe(Date.parse("2025-12-31T22:00:00Z") / 1000);
  }).pipe(h.provide),
);

it.effect("Monday 10:00: last week's recap is posted once; quiet weeks are skipped", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const activity = yield* Activity;
    const posts: { url: string; body: any }[] = [];
    h.fetch = (async (url: string, init: RequestInit) => {
      posts.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ id: "1" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    yield* put(seg("a", REPO, 0, 2, "R.E.P.O."), seg("b", REPO, 0, 2, "R.E.P.O."));
    yield* h.setTime(Date.parse("2026-11-09T07:30:00Z")); // Monday 09:30: too early
    expect(yield* activity.recaps).toEqual({});
    yield* h.setTime(Date.parse("2026-11-09T08:05:00Z")); // Monday 10:05
    expect(yield* activity.recaps).toEqual({ "games-week:2026-11-02": "posted" });
    expect(posts.length).toBe(1);
    expect(JSON.stringify(posts[0].body)).toMatch(/Weekly recap · 2 Nov – 8 Nov/);
    expect(JSON.stringify(posts[0].body)).toMatch(/2h 00m/);
    expect(yield* activity.recaps).toEqual({}); // the next minute doesn't post it again
    yield* db.delete(voiceSegments);
    yield* h.setTime(Date.parse("2026-11-16T08:05:00Z"));
    expect(yield* activity.recaps).toEqual({ "games-week:2026-11-09": "quiet, skipped" });
    expect(posts.length).toBe(1);
  }).pipe(h.provide),
);

// ---------------------------------------------------------------- live tracking

const where = (m: Record<string, string | null>) => new Map(Object.entries(m));
const segs = () => Db.use((db) => db.select().from(voiceSegments).orderBy(voiceSegments.id));
const track = (w: Map<string, string | null>, t?: number) => Activity.use((a) => a.track(w, t));

it.effect("joins, moves and leaves are recorded to the second", () =>
  Effect.gen(function* () {
    yield* track(where({ a: LOBBY }), at(0));
    yield* track(where({ a: LOBBY, b: LOBBY }), at(0) + 7);
    yield* track(where({ a: REPO, b: LOBBY }), at(0) + 65); // a hops into the room
    yield* track(where({ a: REPO, b: null }), at(0) + 90); // b leaves
    const s = yield* segs();
    expect(s.map((x) => [x.user_id, x.channel_id, x.started_at - at(0), x.ended_at && x.ended_at - at(0), x.open])).toEqual([
      ["a", LOBBY, 0, 65, false],
      ["b", LOBBY, 7, 90, false],
      ["a", REPO, 65, null, true],
    ]);
  }).pipe(h.provide),
);

it.effect("heartbeats extend a segment; a long silence (the bot was away) ends it unseen", () =>
  Effect.gen(function* () {
    yield* track(where({ a: LOBBY }), at(0));
    yield* track(where({ a: LOBBY }), at(0) + 60);
    yield* track(where({ a: LOBBY }), at(0) + 120);
    let s = yield* segs();
    expect(s.length).toBe(1);
    expect(s[0].last_seen).toBe(at(0) + 120);
    yield* track(where({ a: LOBBY }), at(0) + 1000); // 880 s of nothing
    s = yield* segs();
    expect(s.length).toBe(2);
    expect([s[0].open, s[0].ended_at, segmentEnd(s[0], at(1))]).toEqual([false, null, at(0) + 180]);
    expect(s[1].open).toBe(true);
  }).pipe(h.provide),
);

it.effect("a racing duplicate check doesn't open a second segment", () =>
  Effect.gen(function* () {
    yield* Effect.all([track(where({ a: LOBBY }), at(0)), track(where({ a: LOBBY }), at(0))], { concurrency: "unbounded" });
    expect((yield* segs()).length).toBe(1);
    // the losing insert may or may not have used up an id (timing): the next test's ids mustn't depend on it
    yield* Effect.promise(() => h.t.pool.query("SELECT setval(pg_get_serial_sequence('voice_segments', 'id'), (SELECT max(id) FROM voice_segments))"));
  }).pipe(h.provide),
);

it.effect("a recap that fails to post is tried again the next minute", () =>
  Effect.gen(function* () {
    let fail = true;
    const posts: string[] = [];
    h.fetch = (async (url: string) => {
      if (fail) return new Response(JSON.stringify({ message: "Missing Access", code: 50001 }), { status: 403, headers: { "Content-Type": "application/json" } });
      posts.push(String(url));
      return new Response(JSON.stringify({ id: "1" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    yield* put(seg("a", REPO, 0, 2, "R.E.P.O."), seg("b", REPO, 0, 2, "R.E.P.O."));
    yield* h.setTime(Date.parse("2026-11-09T08:05:00Z")); // Monday 10:05
    yield* Effect.promise(() => expect(h.run(Activity.use((a) => a.recaps))).rejects.toThrow(/403/));
    fail = false;
    yield* h.setTime(Date.parse("2026-11-09T08:06:00Z"));
    expect(yield* Activity.use((a) => a.recaps)).toEqual({ "games-week:2026-11-02": "posted" });
    expect(posts).toHaveLength(1);
  }).pipe(h.provide),
);

it.effect("the monthly recap comes on the 1st, and only then", () =>
  Effect.gen(function* () {
    const activity = yield* Activity;
    const posts: string[] = [];
    h.fetch = (async (url: string, init: RequestInit) => {
      posts.push(String(init.body));
      return new Response(JSON.stringify({ id: "1" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    yield* put(seg("a", REPO, 0, 2, "R.E.P.O."), seg("b", REPO, 0, 2, "R.E.P.O."));
    yield* h.setTime(Date.parse("2026-12-02T08:05:00Z")); // Wednesday 2 Dec 10:05
    expect(yield* activity.recaps).toEqual({});
    yield* h.setTime(Date.parse("2026-12-01T08:05:00Z")); // Tuesday 1 Dec 10:05
    expect(yield* activity.recaps).toEqual({ "games-month:2026-11-01": "posted" });
    expect(posts.join("")).toMatch(/Monthly recap · November 2026/);
  }).pipe(h.provide),
);
