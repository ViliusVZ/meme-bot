// The paths the flow tests don't walk: HTTP routes, failure rollbacks, room upkeep, recaps, the
// one-hour re-nudge, /meme. Together with flows.test.ts every database query in src/ runs here.
import { expect, it } from "@effect/vitest";
import { eq } from "drizzle-orm";
import { Cause, Clock, type Context, Effect, Exit, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import * as TestConsole from "effect/testing/TestConsole";
import { AppStatus, ROUTER_CONFIG, routesOn } from "../src/app.js";
import { Attendances } from "../src/attendance.js";
import { Cleanup, snowflakeAt } from "../src/cleanup.js";
import { Db } from "../src/db/db.js";
import { GameNight } from "../src/gamenight.js";
import { Interactions } from "../src/interactions.js";
import { Jobs } from "../src/jobs.js";
import { LateSlips } from "../src/late.js";
import { wallToUnixIn } from "../src/localtime.js";
import { Memes } from "../src/memes.js";
import { MemeShame } from "../src/memeshame.js";
import { Nights } from "../src/nights.js";
import { Polls } from "../src/polls.js";
import { Presence } from "../src/presence.js";
import type { AppServices } from "../src/runtime.js";
import { Voice } from "../src/voice.js";
import { gameNights, gameNightVotes, games, memes as memeTable, nightAttendance, recaps, roastBags, rooms, users, votes, polls as pollTable, pollVotes, panels } from "../src/db/schema.js";
import { harness, json, routes } from "./fx.js";

const h = harness({
  tables: [gameNightVotes, nightAttendance, rooms, gameNights, votes, memeTable, users, recaps, roastBags, pollTable, panels],
  discord: { firstId: 5000, routes: [routes.noVoiceState, routes.lobbyOnly] },
  clock: "2026-11-06T15:00:00Z", // Friday 17:00 in Vilnius
});
const calls = h.calls;

const DAY = "2026-11-06";
const now = Effect.map(Clock.currentTimeMillis, (ms) => Math.floor(ms / 1000));
const night = Nights.use((n) => n.get(DAY));
const interaction = (i: unknown) => Interactions.use((x) => Effect.map(x.handle(i), (r) => r as any));
const snapshot = (voiceStates: { user_id: string; channel_id: string | null }[]) => Presence.use((p) => p.snapshot(voiceStates));
/** Raw SQL on the test's schema (the triggers that stand in for another copy or a failing table). */
const sql = (text: string) => Effect.promise(() => h.t.pool.query(text));
/**
 * What the app logged in this test, as the old console spy saw it: the test logger's lines, and the
 * lines of services that run on the context they were built with (GameNight's methods: its logger
 * is the app's console logger, which prints to it.effect's TestConsole).
 */
const logged = Effect.map(TestConsole.logLines, (lines) => [...h.logs, ...lines.map(String)].join(" "));
/** The live clock (the start ping's test runs on real time, as the old `vi.useRealTimers()` did). */
const live = Effect.runSync(Clock.clockWith(Effect.succeed));

/**
 * A call as the old promise functions gave it, rejecting with the failure itself, for the assertions
 * on `expect(…).rejects`: run in the test's own fiber (its Random, its clock), then handed to `check`.
 */
const promised = <A, E, R>(self: Effect.Effect<A, E, R>, check: (p: Promise<A>) => Promise<unknown>) =>
  Effect.flatMap(Effect.exit(self), (exit) => Effect.promise(() => check(Exit.isSuccess(exit) ? Promise.resolve(exit.value) : Promise.reject(Cause.squash(exit.cause)))));

/** The app's routes over this test's services (the old `build`): requests go in through the web handler, as Fastify's `inject` did. */
const build = (publicKey: string, status: { leader: () => boolean; shuttingDown: () => boolean }) =>
  Effect.gen(function* () {
    const ctx: Context.Context<AppServices> = yield* Effect.context<AppServices>();
    // each request on this test's clock (the old fake Date reached the routes too)
    const clock = yield* Clock.clockWith(Effect.succeed);
    const statusLayer = Layer.succeed(AppStatus, AppStatus.of({ leader: Effect.sync(status.leader), shuttingDown: Effect.sync(status.shuttingDown), publicKey }));
    const { handler } = HttpRouter.toWebHandler(routesOn(statusLayer, ctx).pipe(Layer.provide(HttpServer.layerServices)), {
      disableLogger: true,
      routerConfig: ROUTER_CONFIG,
      middleware: (app) => Effect.provideService(app, Clock.Clock, clock),
    });
    return {
      inject: (o: { method: string; url: string; payload?: unknown; headers?: Record<string, string> }) =>
        Effect.promise(async () => {
          const body = o.payload === undefined ? undefined : typeof o.payload === "string" ? o.payload : JSON.stringify(o.payload);
          const headers = { ...(body !== undefined && typeof o.payload !== "string" ? { "content-type": "application/json" } : {}), ...o.headers };
          const res = await handler(new Request(`http://local${o.url}`, { method: o.method, headers, body }));
          const text = await res.text();
          return { statusCode: res.status, headers: Object.fromEntries(res.headers), body: text, json: () => JSON.parse(text) };
        }),
    };
  });

// ---------------------------------------------------------------- HTTP

it.effect("HTTP: health, signatures, admin auth, ingest", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    // a real Ed25519 key pair, so a correctly signed request gets through and a forged one doesn't
    const keys = (yield* Effect.promise(() => crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]))) as unknown as import("node:crypto").webcrypto.CryptoKeyPair;
    const pub = Buffer.from(yield* Effect.promise(() => crypto.subtle.exportKey("raw", keys.publicKey))).toString("hex");
    const sign = (body: string, ts: string) => Effect.promise(async () => Buffer.from(await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(ts + body))).toString("hex"));
    const app = yield* build(pub, { leader: () => true, shuttingDown: () => false });
    const ping = JSON.stringify({ type: 1 });
    const ok = yield* app.inject({ method: "POST", url: "/interactions", payload: ping, headers: { "content-type": "application/json", "x-signature-ed25519": yield* sign(ping, "42"), "x-signature-timestamp": "42" } });
    expect([ok.statusCode, ok.json()]).toEqual([200, { type: 1 }]);
    const tampered = yield* app.inject({ method: "POST", url: "/interactions", payload: ping, headers: { "content-type": "application/json", "x-signature-ed25519": yield* sign(ping, "42"), "x-signature-timestamp": "43" } });
    expect(tampered.statusCode).toBe(401);
    const health = yield* app.inject({ method: "GET", url: "/health" });
    expect([health.statusCode, health.json().ok]).toEqual([200, true]);
    expect((yield* app.inject({ method: "POST", url: "/admin/register" })).statusCode).toBe(401);
    expect((yield* app.inject({ method: "POST", url: "/ingest", headers: { authorization: "Bearer a" } })).statusCode).toBe(401); // admin secret isn't the ingest secret
    const marked = yield* app.inject({ method: "POST", url: "/admin/mark-posted", headers: { authorization: "Bearer a" }, payload: { ids: ["t3_old"] } });
    expect(marked.json()).toEqual({ ok: true });
    const [m] = yield* db.select().from(memeTable).where(eq(memeTable.id, "t3_old"));
    expect(m.post_kind).toBe("request");
    const ing = yield* app.inject({ method: "POST", url: "/ingest", headers: { authorization: "Bearer i" }, payload: { memes: [{ id: "t3_x", title: "x", image: "i", link: "l", author: "a", published: "2026-11-05T00:00:00Z", rank: 1 }, { id: "t3_x", title: "dupe", image: "i", link: "l", author: "a", published: "2026-11-05T00:00:00Z", rank: 1 }] } });
    expect(ing.json().ingested).toBe(1);
    const down = yield* build(h.config.discordPublicKey, { leader: () => false, shuttingDown: () => true });
    expect((yield* down.inject({ method: "GET", url: "/health" })).statusCode).toBe(503);
  }).pipe(h.provide),
);

it.effect("/meme summons a pool meme once, and says so when the well is dry", () =>
  Effect.gen(function* () {
    yield* Memes.use((m) => m.ingest([{ id: "t3_m", title: "M", image: "i", link: "l", author: "a", published: "2026-11-03T08:00:00Z", rank: 3 }]));
    const i = { type: 2, token: "tok", data: { name: "meme" }, member: { user: { id: "a", username: "a" } } };
    const r = yield* interaction(i);
    expect(r.data.components[0].components[0].content).toContain("Summoned by <@a>");
    const dry = yield* interaction(i);
    expect(dry.data.content).toContain("well is dry");
  }).pipe(h.provide),
);

// ---------------------------------------------------------------- game night paths

it.effect("the one-hour re-nudge, a card deleted by hand, refreshing open cards, the plan picker", () =>
  Effect.gen(function* () {
    const gn = yield* GameNight;
    yield* gn.startNight("a");
    yield* h.setTime(((yield* now) + 3601) * 1000);
    const done = yield* gn.maintain;
    expect(done[`renudged ${DAY}`]).toEqual(["b", "c"]);
    h.override = (c) => (c.method === "PATCH" && c.path.includes("/messages/") ? json({ message: "Unknown Message" }, 404) : undefined);
    yield* gn.refreshOpen;
    expect((yield* night)!.message_id).toBeNull(); // forgotten, so it gets reposted
    h.override = null;
    expect(yield* gn.retryUnposted).toEqual([DAY]);
    expect((yield* night)!.message_id).toBeTruthy();
    const picker = JSON.stringify(yield* gn.planPicker);
    expect(picker).toContain("Plan a game night");
    expect(picker).toContain("🗳️"); // today already has a poll
  }).pipe(h.provide),
);

it.effect("exact starts: a failed start ping releases the claim for a retry", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const gn = yield* GameNight;
    const start = (yield* now) + 30;
    yield* db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: start, reminded: false });
    yield* db.insert(games).values({ name: "R.E.P.O.", emoji: "📦", added_at: "x" }).onConflictDoNothing();
    expect((yield* gn.upcomingStarts(start + 10)).map((n) => n.day)).toEqual([DAY]);
    yield* h.setTime(start * 1000);
    h.override = (c) => (c.method === "POST" && c.path.endsWith("/messages") ? json({ message: "boom" }, 500) : undefined);
    expect(yield* gn.maintain).not.toHaveProperty("reminded");
    expect((yield* night)!.reminded).toBe(false);
    h.override = null;
    expect(yield* gn.maintain).toHaveProperty("reminded", DAY);
  }).pipe(h.provide),
);

it.effect("a roast that fails to post is retried", () =>
  Effect.gen(function* () {
    const gn = yield* GameNight;
    yield* gn.startNight("a");
    h.override = (c) => (c.method === "POST" && c.path.endsWith("/messages") && c.body?.content?.startsWith("🔥") ? json({ message: "boom" }, 500) : undefined);
    yield* h.setTime(Date.parse("2026-11-06T18:00:00Z"));
    yield* Effect.exit(gn.maintain); // (a failure here is expected and doesn't matter)
    expect((yield* night)!.roasted_at).toBeNull();
    h.override = null;
    expect(yield* gn.dueRoasts).toEqual([DAY]);
  }).pipe(h.provide),
);

// ---------------------------------------------------------------- latecomers

it.effect("late slips: a failed post releases the claim; the slip renders", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const late = yield* LateSlips;
    const start = (yield* now) - 700;
    yield* db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: start, reminded: true });
    yield* db.insert(rooms).values({ channel_id: "room1", game: "R.E.P.O.", day: DAY, created_at: start });
    h.override = (c) => (c.method === "POST" && c.path.endsWith("/messages") ? json({ message: "boom" }, 500) : undefined);
    expect(yield* late.watch).toEqual({});
    expect(yield* db.select().from(nightAttendance)).toEqual([]);
    h.override = null;
    expect((yield* late.watch).slipped).toEqual(["a", "b", "c"]);
    const slip = JSON.stringify(yield* Attendances.use((a) => a.render(DAY, "a")));
    expect(slip).toContain("Running late?");
    expect(slip).toContain("<#room1>");
  }).pipe(h.provide),
);

// ---------------------------------------------------------------- memes

it.effect("daily post: a failed post gives the meme back to the pool", () =>
  Effect.gen(function* () {
    const memes = yield* Memes;
    const jobs = yield* Jobs;
    yield* h.setTime(Date.parse("2026-11-06T11:00:00Z"));
    yield* memes.ingest([{ id: "t3_d", title: "D", image: "i", link: "l", author: "a", published: "2026-11-05T08:00:00Z", rank: 1 }]);
    h.override = (c) => (c.method === "POST" && c.path.endsWith("/messages") ? json({ message: "boom" }, 500) : undefined);
    yield* promised(jobs.postDaily, (p) => expect(p).rejects.toThrow());
    expect((yield* memes.get("t3_d"))!.post_kind).toBeNull();
    h.override = null;
    expect(yield* jobs.postDaily).toMatchObject({ posted: "t3_d" });
  }).pipe(h.provide),
);

it.effect("Meme of the Week: top voter and longest streak, posted once", () =>
  Effect.gen(function* () {
    const memes = yield* Memes;
    const jobs = yield* Jobs;
    yield* memes.ingest([{ id: "t3_w", title: "W", image: "i", link: "l", author: "a", published: "2026-11-05T08:00:00Z", rank: 1 }]);
    yield* memes.claim("t3_w", "daily", { day: "2026-11-05" }); // posted Friday
    yield* memes.castVote("t3_w", "a", "fire");
    yield* h.setTime(Date.parse("2026-11-07T12:00:00Z"));
    yield* memes.bumpStreak("a", "A");
    yield* h.setTime(Date.parse("2026-11-08T18:05:00Z")); // Sunday 18:05 UTC
    expect(yield* jobs.weeklyRecap).toEqual({ posted: "week:2026-11-08" });
    const post = calls.find((c) => c.method === "POST" && JSON.stringify(c.body).includes("Meme of the Week"))!;
    expect(JSON.stringify(post.body)).toContain("Most votes: <@a> (1)");
    expect(yield* jobs.weeklyRecap).toMatchObject({ skipped: "already posted" });
    expect(yield* memes.topVoter("2026-11-01", "2026-11-09")).toEqual({ user_id: "a", n: 1 });
    expect(yield* memes.longestLiveStreak).toEqual({ user_id: "a", streak: 1 }); // voted Saturday, still alive Sunday
  }).pipe(h.provide),
);

it.effect("polls remember their message", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const polls = yield* Polls;
    const id = yield* polls.create("a", "Q?", "");
    yield* polls.setMessage(id, "ch", "msg");
    const [p] = yield* db.select().from(pollTable).where(eq(pollTable.id, id));
    expect([p.channel_id, p.message_id, p.options]).toEqual(["ch", "msg", ["👍 Yes", "👎 No"]]);
  }).pipe(h.provide),
);

// ---------------------------------------------------------------- rooms

it.effect("rooms: a hand-deleted room is recreated; a failed creation leaves no placeholder", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const voice = yield* Voice;
    yield* snapshot([]);
    const first = yield* voice.openRoom("R.E.P.O.", "📦", {});
    h.override = (c) => (c.method === "GET" && c.path === `/channels/${first.channelId}` ? json({ message: "Unknown Channel" }, 404) : undefined);
    const second = yield* voice.openRoom("R.E.P.O.", "📦", {});
    expect(second.channelId).not.toBe(first.channelId);
    h.override = (c) => (c.method === "POST" && c.path.endsWith("/channels") ? json({ message: "boom" }, 500) : undefined);
    yield* promised(voice.openRoom("Palworld", "🐑", {}), (p) => expect(p).rejects.toThrow());
    expect((yield* db.select().from(rooms)).map((r) => r.game)).toEqual(["R.E.P.O."]);
  }).pipe(h.provide),
);

it.effect("rooms: busy keeps the event alive, empty wraps it up and ends the event", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const voice = yield* Voice;
    const t0 = yield* now;
    yield* db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: t0 - 3600, reminded: true, event_id: "ev1", event_end: t0 + 300 });
    yield* db.insert(rooms).values({ channel_id: "r1", game: "R.E.P.O.", day: DAY, created_at: t0 - 3600, last_seen: t0 - 60 });
    yield* voice.checkRooms(new Set(["r1"]), t0);
    expect((yield* night)!.event_end).toBe(t0 + 1800); // pushed back
    expect(calls.some((c) => c.method === "PATCH" && c.path.endsWith("/scheduled-events/ev1") && c.body.scheduled_end_time)).toBe(true);
    const r = yield* voice.checkRooms(new Set(), t0 + 901);
    expect(r.archived).toEqual(["R.E.P.O."]);
    expect(calls.some((c) => c.method === "PATCH" && c.path.endsWith("/scheduled-events/ev1") && c.body.status === 3)).toBe(true);
    expect((yield* night)!.event_end).toBeNull(); // ended for good
    // back in the same room the next evening (it's revived): there's no event left to push back
    yield* db.update(rooms).set({ archived_at: null }).where(eq(rooms.channel_id, "r1"));
    calls.length = 0;
    yield* voice.checkRooms(new Set(["r1"]), t0 + 86400);
    expect(calls.some((c) => c.path.includes("/scheduled-events/"))).toBe(false);
  }).pipe(h.provide),
);

it.effect("rooms: an event ended by hand (or deleted) is let go quietly; other refusals still alert", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const voice = yield* Voice;
    const t0 = yield* now;
    const finished = { message: "Invalid Form Body", code: 50035, errors: { scheduled_end_time: { _errors: [{ code: "GUILD_SCHEDULED_EVENT_SCHEDULE_INVALID_END_BY_STATUS", message: "Cannot update end time of finished event." }] } } };
    for (const [answer, status, alerted] of [
      [finished, 400, false],
      [{ message: "Unknown Guild Scheduled Event", code: 10070 }, 404, false],
      [{ message: "Missing Permissions", code: 50013 }, 403, true],
    ] as const) {
      yield* db.delete(rooms);
      yield* db.delete(gameNights);
      yield* db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: t0 - 3600, reminded: true, event_id: "ev1", event_end: t0 + 300 });
      yield* db.insert(rooms).values({ channel_id: "r1", game: "R.E.P.O.", day: DAY, created_at: t0 - 3600, last_seen: t0 - 60 });
      calls.length = 0;
      h.logs.length = 0;
      h.override = (c) => (c.method === "PATCH" && c.path.endsWith("/scheduled-events/ev1") ? json(answer, status) : undefined);
      yield* voice.checkRooms(new Set(["r1"]), t0);
      yield* voice.checkRooms(new Set(["r1"]), t0 + 60);
      const said = h.logs.join(" ");
      expect(said.includes("extending the Discord event failed")).toBe(alerted);
      // a finished event is tried once and forgotten; a real failure keeps its end and tries again
      expect((yield* night)!.event_end).toBe(alerted ? t0 + 300 : null);
      expect(calls.filter((c) => c.path.endsWith("/scheduled-events/ev1"))).toHaveLength(alerted ? 2 : 1);
    }
  }).pipe(h.provide),
);

it.effect("room upkeep: stale placeholders, hand-deleted rooms, revivals, 3-day deletion", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const t0 = yield* now;
    yield* db.insert(rooms).values([
      { channel_id: "pending:old", game: "Old", created_at: t0 - 600 },
      { channel_id: "gone", game: "Gone", created_at: t0 },
      { channel_id: "busy", game: "Busy", created_at: t0 - 9999, archived_at: t0 - 100 },
      { channel_id: "stale", game: "Stale", created_at: t0 - 9 * 86400, archived_at: t0 - 4 * 86400 },
      { channel_id: "vanished", game: "Vanished", created_at: t0 - 9 * 86400, archived_at: t0 - 4 * 86400 },
    ]);
    const list = ["busy", "stale", "vanished"].map((id, i) => ({ id, type: 2, parent_id: "archive", position: i + 1, name: id }));
    h.override = (c) => {
      if (c.method === "GET" && c.path.endsWith("/channels")) return json([{ id: "lobby", type: 2, parent_id: "voice", position: 0, name: "Lobby" }, { id: "archive", type: 4, position: 9, name: "🗄️ Recent games" }, ...list]);
      if (c.method === "DELETE" && c.path === "/channels/vanished") return json({ message: "Unknown Channel" }, 404);
      return undefined;
    };
    yield* snapshot([{ user_id: "a", channel_id: "busy" }]);
    const done = yield* Voice.use((v) => v.maintainRooms);
    // (a 404 while deleting means it's already gone, which is what we wanted)
    expect(done).toMatchObject({ forgotten: ["Gone"], revived: ["Busy"], deleted: ["Stale", "Vanished"] });
    expect((yield* db.select().from(rooms)).map((r) => [r.channel_id, r.archived_at])).toEqual([["busy", null]]);
  }).pipe(h.provide),
);

it.effect("rooms: another click finishing the same room between our look and our claim", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    // simulate the other click: the moment our placeholder goes in, its finished room appears
    yield* sql(`CREATE OR REPLACE FUNCTION qa_racer() RETURNS trigger AS $$
    BEGIN INSERT INTO rooms (channel_id, game, created_at) VALUES ('real-racer', 'Racer', NEW.created_at); RETURN NEW; END $$ LANGUAGE plpgsql`);
    yield* sql(`CREATE TRIGGER qa_racer AFTER INSERT ON rooms FOR EACH ROW WHEN (NEW.channel_id = 'pending:racer') EXECUTE FUNCTION qa_racer()`);
    yield* snapshot([]);
    const r = yield* Voice.use((v) => v.openRoom("Racer", null, {}));
    expect([r.channelId, r.reused]).toEqual(["real-racer", true]);
    expect((yield* db.select().from(rooms)).map((x) => x.channel_id)).toEqual(["real-racer"]); // our placeholder is gone
    expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/channels"))).toBe(false); // and we made no twin
    yield* sql("DROP TRIGGER qa_racer ON rooms");
  }).pipe(h.provide),
);

it.effect("room upkeep: reviving a room whose channel vanished just forgets it", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db.insert(rooms).values({ channel_id: "ghostroom", game: "Ghost", created_at: (yield* now) - 9999, archived_at: (yield* now) - 100 });
    h.override = (c) => {
      if (c.method === "GET" && c.path.endsWith("/channels")) return json([{ id: "ghostroom", type: 2, parent_id: "archive", position: 1, name: "x" }]);
      if (c.method === "PATCH" && c.path === "/channels/ghostroom") return json({ message: "Unknown Channel" }, 404);
      return undefined;
    };
    yield* snapshot([{ user_id: "a", channel_id: "ghostroom" }]);
    expect(yield* Voice.use((v) => v.maintainRooms)).toMatchObject({ forgotten: ["Ghost"] });
    expect(yield* db.select().from(rooms)).toEqual([]);
  }).pipe(h.provide),
);

it.effect("clicking the card opens your private copy; clicking your copy updates it in place", () =>
  Effect.gen(function* () {
    h.race("each tap starts its copy's tracking in the background, and the next tap comes before it has landed", { mask: { panels: ["message_id"] }, calls: false });
    yield* GameNight.use((g) => g.startNight("a"));
    const click = (flags: number) => ({ type: 3, token: "tok", data: { custom_id: `gn:${DAY}:yes`, component_type: 2 }, message: { flags }, member: { user: { id: "b", username: "b" } } });
    const fromCard = yield* interaction(click(1 << 15));
    expect(fromCard.type).toBe(4); // a new message…
    expect(fromCard.data.flags & 64).toBe(64); // …only b sees
    const fromCopy = yield* interaction(click((1 << 15) | 64));
    expect(fromCopy.type).toBe(7); // edits b's copy
    // a refusal on your panel shows in the panel, not as one more message
    const late = { ...click((1 << 15) | 64), data: { custom_id: `gn:${DAY}:late:15`, component_type: 2 } };
    const refused = yield* interaction(late);
    expect(refused.type).toBe(7);
    expect(JSON.stringify(refused.data)).toContain("⚠️ Nothing's locked in yet");
  }).pipe(h.provide),
);

it.effect("clicking the card opens your private copy; clicking your copy updates it in place (each tap done before the next)", () =>
  Effect.gen(function* () {
    yield* GameNight.use((g) => g.startNight("a"));
    const click = (flags: number) => ({ type: 3, token: "tok", data: { custom_id: `gn:${DAY}:yes`, component_type: 2 }, message: { flags }, member: { user: { id: "b", username: "b" } } });
    const fromCard = yield* interaction(click(1 << 15));
    yield* h.settle;
    expect(fromCard.type).toBe(4); // a new message…
    expect(fromCard.data.flags & 64).toBe(64); // …only b sees
    const fromCopy = yield* interaction(click((1 << 15) | 64));
    yield* h.settle;
    expect(fromCopy.type).toBe(7); // edits b's copy
    // a refusal on your panel shows in the panel, not as one more message
    const late = { ...click((1 << 15) | 64), data: { custom_id: `gn:${DAY}:late:15`, component_type: 2 } };
    const refused = yield* interaction(late);
    expect(refused.type).toBe(7);
    expect(JSON.stringify(refused.data)).toContain("⚠️ Nothing's locked in yet");
  }).pipe(h.provide),
);

it.effect("🧹 03:00 sweep: old bot messages go; pins, live cards, recaps and people's messages stay", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const cleanup = yield* Cleanup;
    yield* h.setTime(Date.parse("2026-11-06T01:05:00Z")); // 03:05 Friday
    const old = Date.parse("2026-11-05T15:00:00Z"); // yesterday 17:00
    const fresh = Date.parse("2026-11-06T01:02:00Z"); // after 03:00 today
    const msgs = [
      { id: snowflakeAt(fresh), author: { id: "bot" } }, // after the cutoff
      { id: snowflakeAt(old, 1), author: { id: "bot" } }, // yesterday's card
      { id: snowflakeAt(old, 2), author: { id: "bot" } }, // yesterday's nudge
      { id: snowflakeAt(old, 3), author: { id: "bot" }, pinned: true }, // the HQ panel
      { id: snowflakeAt(old, 4), author: { id: "a" } }, // a person
      { id: snowflakeAt(old, 5), author: { id: "bot" }, components: [{ content: "## 📊 Weekly recap · 2 Nov – 8 Nov" }] },
      { id: snowflakeAt(old, 6), author: { id: "bot" } }, // the card of a night planned for Saturday
      { id: snowflakeAt((yield* Clock.currentTimeMillis) - 20 * 86400_000), author: { id: "bot" } }, // too old to bulk delete
    ];
    yield* db.insert(gameNights).values([
      { day: "2026-11-05", stage: "off", message_id: msgs[1].id, nudge_id: msgs[2].id },
      { day: "2026-11-07", stage: "ask", message_id: msgs[6].id },
    ]);
    h.override = (c) => {
      if (c.path === "/users/@me") return json({ id: "bot" });
      if (c.method === "GET" && c.path.startsWith("/channels/gn/messages")) return json(c.path.includes("before=") ? [] : msgs);
      return undefined;
    };
    expect(yield* cleanup.nightly).toEqual({ deleted: 3, kept: 1 });
    const bulk = calls.find((c) => c.path.endsWith("/bulk-delete"))!;
    expect(bulk.body.messages.sort()).toEqual([msgs[1].id, msgs[2].id].sort());
    expect(calls.some((c) => c.method === "DELETE" && c.path === `/channels/gn/messages/${msgs[7].id}`)).toBe(true);
    expect((yield* db.select().from(gameNights).where(eq(gameNights.day, "2026-11-05")))[0]).toMatchObject({ message_id: null, nudge_id: null });
    expect(yield* cleanup.nightly).toEqual({}); // once a day
  }).pipe(h.provide),
);

it.effect("a meme vote shows who voted what under the bar, without pinging", () =>
  Effect.gen(function* () {
    const memes = yield* Memes;
    yield* memes.ingest([{ id: "t3_v", title: "V", image: "i", link: "l", author: "a", published: "2026-11-05T08:00:00Z", rank: 1 }]);
    yield* memes.claim("t3_v", "daily", { day: "2026-11-05" });
    yield* memes.castVote("t3_v", "b", "fire");
    const click = { type: 3, token: "tok", data: { custom_id: "v:t3_v:lol", component_type: 2 }, member: { user: { id: "a", username: "a" } } };
    const r = yield* interaction(click);
    const body = JSON.stringify(r.data);
    expect(body).toContain("🔥 <@b> · 😂 <@a>");
    expect(r.data.allowed_mentions).toEqual({ parse: [] });
  }).pipe(h.provide),
);

it.effect("😐 meme slackers: called out at 19:00, once a day, at most every 3 days each", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const memes = yield* Memes;
    const { evening, slackers } = yield* MemeShame;
    // five daily memes, posted on the five days before Friday
    for (let i = 0; i < 5; i++) {
      const day = `2026-11-0${5 - i}`;
      yield* db.insert(memeTable).values({ id: `t3_d${i}`, title: "d", image: "i", link: "l", author: "u", published: `${day}T08:00:00Z`, ingested_at: "x", post_kind: "daily", day, posted_at: `${day}T10:00:00.000Z`, channel_id: "memes", message_id: `msg${i}` });
    }
    for (let i = 0; i < 5; i++) yield* memes.castVote(`t3_d${i}`, "a", "lol"); // a votes on everything
    yield* memes.castVote("t3_d4", "b", "fire"); // b only on the oldest
    yield* memes.castVote("t3_d0", "c", "fire"); // c voted on the latest only
    yield* memes.castVote("t3_d1", "c", "fire"); // …and the one before: 2 of 5, not 3 in a row
    yield* h.setTime(Date.parse("2026-11-06T16:30:00Z")); // 18:30: too early
    expect(yield* evening).toEqual({});
    yield* h.setTime(Date.parse("2026-11-06T17:05:00Z")); // 19:05
    expect((yield* slackers()).who.map((s) => s.user)).toEqual(["b"]);
    expect(yield* evening).toEqual({ called: ["b"] });
    const post = calls.find((c) => c.method === "POST" && c.path === "/channels/memes/messages")!;
    expect(post.body.content).toMatch(/^😐 .*<@b>/);
    expect(post.body.content).not.toMatch(/\{\w+\}/);
    expect(post.body.allowed_mentions).toEqual({ users: ["b"] });
    expect(yield* evening).toEqual({}); // once a day
    yield* h.setTime(Date.parse("2026-11-07T17:05:00Z")); // next evening: b's still slacking, but cooling down
    expect(yield* evening).toEqual({});
    yield* h.setTime(Date.parse("2026-11-09T17:05:00Z")); // 3 days later: fair game again
    expect(yield* evening).toEqual({ called: ["b"] });
  }).pipe(h.provide),
);

it.effect("admin: redraw every posted meme with its voters", () =>
  Effect.gen(function* () {
    const memes = yield* Memes;
    yield* memes.ingest([{ id: "t3_r", title: "R", image: "i", link: "l", author: "a", published: "2026-11-05T08:00:00Z", rank: 1 }]);
    yield* memes.claim("t3_r", "daily", { day: "2026-11-05" });
    yield* memes.setMessage("t3_r", "memes", "m1");
    yield* memes.castVote("t3_r", "c", "dead");
    const app = yield* build(h.config.discordPublicKey, { leader: () => true, shuttingDown: () => false });
    const r = yield* app.inject({ method: "POST", url: "/admin/refresh-memes", headers: { authorization: "Bearer a" } });
    expect(r.json()).toEqual({ updated: 1, failed: [] });
    expect(JSON.stringify(calls.find((c) => c.method === "PATCH" && c.path === "/channels/memes/messages/m1")!.body)).toContain("💀 <@c>");
  }).pipe(h.provide),
);

it.effect("rooms: opening a room brings the Lobby along unless told not to", () =>
  Effect.gen(function* () {
    const voice = yield* Voice;
    yield* snapshot([{ user_id: "a", channel_id: "lobby" }, { user_id: "c", channel_id: "lobby" }]);
    const r = yield* voice.openRoom("R.E.P.O.", "📦", {});
    expect(r.moved).toEqual(["a", "c"]);
    const moves = () => calls.filter((c) => c.method === "PATCH" && c.path.startsWith("/guilds/guild/members/"));
    expect(moves().map((c) => [c.path.split("/").pop(), c.body.channel_id]).sort()).toEqual([["a", r.channelId], ["c", r.channelId]]);
    calls.length = 0;
    const again = yield* voice.openRoom("R.E.P.O.", "📦", { move: false });
    expect([again.channelId, again.reused, again.moved]).toEqual([r.channelId, true, []]);
    expect(moves()).toEqual([]);
  }).pipe(h.provide),
);

it.effect("room upkeep: an archived room is deleted 3 days after it was archived, not a second sooner", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const t0 = yield* now;
    yield* db.insert(rooms).values([
      { channel_id: "young", game: "Young", created_at: t0 - 9 * 86400, archived_at: t0 - 3 * 86400 + 1 },
      { channel_id: "due", game: "Due", created_at: t0 - 9 * 86400, archived_at: t0 - 3 * 86400 },
    ]);
    const list = ["young", "due"].map((id, i) => ({ id, type: 2, parent_id: "archive", position: i + 1, name: id }));
    h.override = (c) => (c.method === "GET" && c.path.endsWith("/channels") ? json([{ id: "archive", type: 4, position: 9, name: "🗄️ Recent games" }, ...list]) : undefined);
    yield* snapshot([]);
    expect(yield* Voice.use((v) => v.maintainRooms)).toEqual({ deleted: ["Due"] });
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["/channels/due"]);
    expect((yield* db.select().from(rooms)).map((r) => r.channel_id)).toEqual(["young"]);
  }).pipe(h.provide),
);

it.effect("rooms: a room Discord won't move to Recent games stays open, and the next check tries again", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const voice = yield* Voice;
    const t0 = yield* now;
    yield* db.insert(rooms).values({ channel_id: "r1", game: "R.E.P.O.", created_at: t0 - 7200, last_seen: t0 - 3600 });
    h.override = (c) => (c.method === "PATCH" && c.path === "/channels/r1" ? json({ message: "Missing Permissions", code: 50013 }, 403) : undefined);
    expect((yield* voice.checkRooms(new Set(), t0)).archived).toEqual([]);
    expect((yield* db.select().from(rooms)).map((r) => [r.channel_id, r.archived_at])).toEqual([["r1", null]]);
    yield* voice.checkRooms(new Set(), t0 + 60);
    expect(calls.filter((c) => c.method === "PATCH" && c.path === "/channels/r1")).toHaveLength(2);
  }).pipe(h.provide),
);

it.effect("rooms: a new room Discord won't slot under the Lobby is still known, so the next tap makes no twin", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const voice = yield* Voice;
    yield* snapshot([]);
    h.override = (c) => (c.method === "PATCH" && c.path === "/guilds/guild/channels" ? json({ message: "Missing Permissions", code: 50013 }, 403) : undefined);
    yield* promised(voice.openRoom("Palworld", "🐑", {}), (p) => expect(p).rejects.toThrow(/403/));
    const [made] = yield* db.select().from(rooms);
    expect([made.game, made.channel_id.startsWith("pending:")]).toEqual(["Palworld", false]);
    h.override = null;
    const again = yield* voice.openRoom("Palworld", "🐑", {});
    expect([again.channelId, again.reused]).toEqual([made.channel_id, true]);
    expect(calls.filter((c) => c.method === "POST" && c.path === "/guilds/guild/channels")).toHaveLength(1);
  }).pipe(h.provide),
);

it.effect("late: a voice lookup that fails isn't \"already here\"; the ETA goes on a slip", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const attendance = yield* Attendances;
    const t0 = yield* now;
    yield* db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: t0 - 600, reminded: true, message_id: "card" });
    yield* db.insert(rooms).values({ channel_id: "r1", game: "R.E.P.O.", day: DAY, created_at: t0 - 900 });
    h.override = (c) => (c.path.includes("/voice-states/") ? json({ message: "Missing Access", code: 50001 }, 403) : undefined);
    expect(yield* attendance.declare(DAY, "b", 15)).toContain("Got it 🏃");
    expect(calls.filter((c) => c.method === "POST" && c.path === "/channels/gn/messages")).toHaveLength(1);
    expect((yield* attendance.etas(DAY)).b).toBe(t0 + 900);
  }).pipe(h.provide),
);

it.effect("late: a slip that won't update still takes the ETA", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const attendance = yield* Attendances;
    const t0 = yield* now;
    yield* db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: t0 - 600, reminded: true, message_id: "card" });
    yield* db.insert(nightAttendance).values({ day: DAY, user_id: "b", state: "late", message_id: "slip-b" });
    h.override = (c) => (c.method === "PATCH" && c.path === "/channels/gn/messages/slip-b" ? json({ message: "Unknown Message", code: 10008 }, 404) : undefined);
    expect(yield* attendance.declare(DAY, "b", 5)).toContain("Got it 🏃");
    expect((yield* attendance.etas(DAY)).b).toBe(t0 + 300);
    expect(calls.filter((c) => c.method === "POST" && c.path === "/channels/gn/messages")).toEqual([]); // no second slip
  }).pipe(h.provide),
);

it.effect("a called-off night leaves the slips of people who made it alone", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: (yield* now) - 600, message_id: "card" });
    yield* db.insert(nightAttendance).values([
      { day: DAY, user_id: "a", state: "arrived", message_id: "slip-a", arrived_at: yield* now },
      { day: DAY, user_id: "b", state: "absent", message_id: "slip-b" },
      { day: DAY, user_id: "c", state: "eta", eta: (yield* now) + 600, message_id: "slip-c" },
    ]);
    yield* Attendances.use((a) => a.retireSlips(DAY));
    const edits = calls.filter((c) => c.method === "PATCH").map((c) => [c.path, JSON.stringify(c.body)] as const);
    expect(edits.map(([p]) => p).sort()).toEqual(["/channels/gn/messages/slip-b", "/channels/gn/messages/slip-c"]);
    expect(edits.find(([p]) => p.endsWith("slip-c"))![1]).toContain("Never mind <@c>");
  }).pipe(h.provide),
);

it.effect("a night another copy already called off isn't touched again", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db.insert(gameNights).values({ day: "2026-11-05", stage: "ask", stage_at: (yield* now) - 86400, message_id: "old-card", nudge_id: "old-nudge" });
    // the other copy flips the stage first: ours finds nothing to flip
    yield* sql(`CREATE OR REPLACE FUNCTION qa_lost() RETURNS trigger AS $$ BEGIN RETURN NULL; END $$ LANGUAGE plpgsql`);
    yield* sql(`CREATE TRIGGER qa_lost BEFORE UPDATE ON game_nights FOR EACH ROW WHEN (NEW.stage = 'off') EXECUTE FUNCTION qa_lost()`);
    yield* GameNight.use((g) => g.closeStale);
    yield* sql("DROP TRIGGER qa_lost ON game_nights");
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
    expect((yield* db.select().from(gameNights).where(eq(gameNights.day, "2026-11-05")))[0]).toMatchObject({ stage: "ask", nudge_id: "old-nudge" });
  }).pipe(h.provide),
);

it.effect("a card that won't post is reported, and its claim kept", () =>
  Effect.gen(function* () {
    h.override = (c) => (c.method === "POST" && c.path === "/channels/gn/messages" ? json({ message: "Missing Access", code: 50001 }, 403) : undefined);
    yield* promised(GameNight.use((g) => g.startNight(undefined, true)), (p) => expect(p).rejects.toThrow(/403/));
    const said = yield* logged;
    expect(said).toContain("posting the game-night card failed");
    expect(yield* night).toMatchObject({ stage: "ask", message_id: null });
  }).pipe(h.provide),
);

it.effect("no reminders before 09:00: a waiting card is re-nudged from 09:00 on", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const gn = yield* GameNight;
    const SAT = "2026-11-07";
    yield* db.insert(gameNights).values({ day: SAT, stage: "ask", message_id: "card-sat", stage_at: wallToUnixIn(h.config.timezone, 2026, 11, 6, 20, 0), started_by: "a" });
    yield* db.insert(gameNightVotes).values({ day: SAT, stage: "ask", user_id: "a", choice: "yes", voted_at: "2026-11-06T18:00:00.000Z" });
    yield* h.setTime(Date.parse("2026-11-07T06:30:00Z")); // Saturday 08:30 in Vilnius
    yield* gn.maintain;
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
    yield* h.setTime(Date.parse("2026-11-07T07:00:00Z")); // 09:00
    yield* gn.maintain;
    const [ping] = calls.filter((c) => c.method === "POST");
    expect(ping.body.content).toBe("<@b> <@c> ⏳ still waiting on you: are you in tonight? ⬆️");
  }).pipe(h.provide),
);

it.effect("one night's trouble doesn't hold up the other's upkeep", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db.insert(gameNights).values([
      { day: DAY, stage: "time", game: "R.E.P.O.", message_id: "card-a", stage_at: yield* now },
      { day: "2026-11-07", stage: "time", game: "R.E.P.O.", message_id: "card-b", stage_at: yield* now },
    ]);
    h.override = (c) => (c.method === "PATCH" && c.path === "/channels/gn/messages/card-a" ? json({ message: "Missing Access", code: 50001 }, 403) : undefined);
    const done = yield* GameNight.use((g) => g.maintain); // 17:00: the quarter-hourly refresh of the times
    expect(String(done[`failed ${DAY}`])).toContain("403");
    expect(calls.some((c) => c.method === "PATCH" && c.path === "/channels/gn/messages/card-b")).toBe(true);
  }).pipe(h.provide),
);

it.effect("a start the timer missed is caught up within half an hour", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: (yield* now) - 20 * 60, message_id: "card", reminded: false });
    yield* snapshot([]);
    expect(yield* GameNight.use((g) => g.maintain)).toMatchObject({ reminded: DAY });
    expect((yield* night)!.reminded).toBe(true);
  }).pipe(h.provide),
);

it.effect("the start times on an open card are refreshed every quarter hour", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const gn = yield* GameNight;
    yield* db.insert(gameNights).values({ day: DAY, stage: "time", game: "R.E.P.O.", message_id: "card", stage_at: yield* now });
    const edits = () => calls.filter((c) => c.method === "PATCH" && c.path === "/channels/gn/messages/card").length;
    yield* h.setTime(Date.parse("2026-11-06T15:10:00Z")); // 17:10
    yield* gn.maintain;
    expect(edits()).toBe(0);
    yield* h.setTime(Date.parse("2026-11-06T15:15:00Z")); // 17:15
    yield* gn.maintain;
    expect(edits()).toBe(1);
  }).pipe(h.provide),
);

it.effect("the start ping goes out on the start's second, not before", () =>
  Effect.gen(function* () {
    h.race("runs on the real clock, so its times differ from run to run", {
      mask: { game_nights: ["start_at", "stage_at"], rooms: ["created_at", "last_seen"], night_attendance: ["arrived_at"] },
      bodies: false,
    });
    const db = yield* Db;
    const start = (yield* now) + 1; // (the live clock, below)
    yield* db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: start, message_id: "card", reminded: false });
    yield* snapshot([]);
    let pingAt = 0;
    h.override = (c) => {
      if (c.method === "POST" && c.path === "/channels/gn/messages" && c.body.content?.includes("starts now")) pingAt = Date.now();
      return undefined;
    };
    const [n] = yield* db.select().from(gameNights).where(eq(gameNights.day, DAY));
    expect(yield* GameNight.use((g) => g.startOnTime(n))).toBe(true);
    expect(pingAt).toBeGreaterThanOrEqual(start * 1000);
  }).pipe(Effect.provideService(Clock.Clock, live), h.provide),
);

it.effect("a start whose unplanned session can't be merged still happens", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: (yield* now) - 60, message_id: "card", reminded: false });
    yield* sql(`CREATE OR REPLACE FUNCTION qa_fail() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'sessions are down'; END $$ LANGUAGE plpgsql`);
    yield* sql(`CREATE TRIGGER qa_fail BEFORE UPDATE ON sessions FOR EACH STATEMENT EXECUTE FUNCTION qa_fail()`);
    yield* snapshot([]);
    const done = yield* GameNight.use((g) => g.maintain);
    const said = yield* logged;
    yield* sql("DROP TRIGGER qa_fail ON sessions");
    expect(done).toMatchObject({ reminded: DAY });
    expect((yield* night)!.reminded).toBe(true);
    expect(said).toContain("merging the unplanned session into the night failed");
    expect(said).not.toContain("the start ping failed");
  }).pipe(h.provide),
);

it.effect("late: someone who arrived and wandered back to the Lobby is left there", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: (yield* now) - 300, reminded: true, message_id: "card" });
    yield* db.insert(rooms).values({ channel_id: "r1", game: "R.E.P.O.", day: DAY, created_at: (yield* now) - 400 });
    yield* db.insert(nightAttendance).values({ day: DAY, user_id: "a", state: "arrived", arrived_at: (yield* now) - 200 });
    yield* snapshot([{ user_id: "a", channel_id: "lobby" }]);
    yield* LateSlips.use((l) => l.watch);
    expect(calls.some((c) => c.method === "PATCH" && c.path === "/guilds/guild/members/a")).toBe(false);
  }).pipe(h.provide),
);

it.effect("late: a latecomer the bot can't move into the room isn't counted as here", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: (yield* now) - 300, reminded: true, message_id: "card" });
    yield* db.insert(rooms).values({ channel_id: "r1", game: "R.E.P.O.", day: DAY, created_at: (yield* now) - 400 });
    yield* snapshot([{ user_id: "a", channel_id: "lobby" }]);
    h.override = (c) => (c.method === "PATCH" && c.path === "/guilds/guild/members/a" ? json({ message: "Missing Permissions", code: 50013 }, 403) : undefined);
    yield* LateSlips.use((l) => l.watch);
    const said = yield* logged;
    expect(said).toContain("latecomer upkeep failed");
    expect(yield* db.select().from(nightAttendance).where(eq(nightAttendance.user_id, "a"))).toEqual([]);
  }).pipe(h.provide),
);

it.effect("a poll: tapping your answer again takes your vote back", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const polls = yield* Polls;
    const id = yield* polls.create("a", "Pizza?", "");
    yield* polls.act(id, "a", "0");
    expect(yield* db.select().from(pollVotes).where(eq(pollVotes.poll_id, id))).toHaveLength(1);
    expect(yield* polls.act(id, "a", "0")).toEqual({ notice: "🗳️ Took your vote back.", update: true });
    expect(yield* db.select().from(pollVotes).where(eq(pollVotes.poll_id, id))).toEqual([]);
  }).pipe(h.provide),
);

it.effect("🧹 a sweep that fails is tried again the next minute", () =>
  Effect.gen(function* () {
    const cleanup = yield* Cleanup;
    yield* h.setTime(Date.parse("2026-11-06T01:05:00Z")); // 03:05 Friday
    const old = snowflakeAt(Date.parse("2026-11-05T15:00:00Z"), 1);
    let down = true;
    h.override = (c) => {
      if (c.path === "/users/@me") return json({ id: "bot" });
      if (c.method === "GET" && c.path.startsWith("/channels/gn/messages")) return down ? json({ message: "Missing Access", code: 50001 }, 403) : json([{ id: old, author: { id: "bot" } }]);
      return undefined;
    };
    yield* promised(cleanup.nightly, (p) => expect(p).rejects.toThrow(/403/));
    down = false;
    yield* h.setTime(Date.parse("2026-11-06T01:06:00Z"));
    expect(yield* cleanup.nightly).toEqual({ deleted: 1, kept: 0 });
  }).pipe(h.provide),
);

it.effect("🧹 the sweep goes back page by page, 100 at a time", () =>
  Effect.gen(function* () {
    yield* h.setTime(Date.parse("2026-11-06T01:05:00Z"));
    const old = Date.parse("2026-11-05T15:00:00Z");
    const first = Array.from({ length: 100 }, (_, i) => ({ id: snowflakeAt(old, 200 - i), author: { id: "bot" } })); // newest first
    const second = [{ id: snowflakeAt(old, 1), author: { id: "bot" } }];
    h.override = (c) => {
      if (c.path === "/users/@me") return json({ id: "bot" });
      if (c.method === "GET" && c.path.startsWith("/channels/gn/messages")) return json(c.path.includes(`before=${first[99].id}`) ? second : first);
      return undefined;
    };
    expect(yield* Cleanup.use((c) => c.sweep(Date.parse("2026-11-06T01:00:00Z")))).toEqual({ deleted: 101, kept: 0 });
  }).pipe(h.provide),
);

it.effect("🧹 a night that started in the last 6 hours keeps its card through the sweep", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* h.setTime(Date.parse("2026-11-06T01:05:00Z")); // 03:05 Friday
    const card = snowflakeAt(Date.parse("2026-11-05T17:00:00Z"), 1);
    yield* db.insert(gameNights).values({ day: "2026-11-05", stage: "set", game: "R.E.P.O.", start_at: Date.parse("2026-11-05T23:30:00Z") / 1000, reminded: true, message_id: card });
    h.override = (c) => {
      if (c.path === "/users/@me") return json({ id: "bot" });
      if (c.method === "GET" && c.path.startsWith("/channels/gn/messages")) return json([{ id: card, author: { id: "bot" } }]);
      return undefined;
    };
    expect(yield* Cleanup.use((c) => c.sweep(Date.parse("2026-11-06T01:00:00Z")))).toEqual({ deleted: 0, kept: 1 });
  }).pipe(h.provide),
);

/** Five daily memes, one on each of the five days before Friday (the newest first: t3_d0 … t3_d4). */
const fiveDailyMemes = Effect.gen(function* () {
  const db = yield* Db;
  for (let i = 0; i < 5; i++) {
    const day = `2026-11-0${5 - i}`;
    yield* db.insert(memeTable).values({ id: `t3_d${i}`, title: "d", image: "i", link: "l", author: "u", published: `${day}T08:00:00Z`, ingested_at: "x", post_kind: "daily", day, posted_at: `${day}T10:00:00.000Z`, channel_id: "memes", message_id: `msg${i}` });
  }
});

it.effect("😐 a call-out that fails is tried again the next minute, for whoever's still due", () =>
  Effect.gen(function* () {
    const memes = yield* Memes;
    const { evening } = yield* MemeShame;
    yield* fiveDailyMemes;
    for (let i = 0; i < 5; i++) yield* memes.castVote(`t3_d${i}`, "a", "lol"); // only a votes
    yield* h.setTime(Date.parse("2026-11-06T17:05:00Z")); // 19:05
    h.override = (c) => (c.method === "POST" && c.path === "/channels/memes/messages" && c.body.content.includes("<@b>") ? json({ message: "Missing Access", code: 50001 }, 403) : undefined);
    yield* promised(evening, (p) => expect(p).rejects.toThrow(/403/));
    h.override = null;
    yield* h.setTime(Date.parse("2026-11-06T17:06:00Z"));
    expect(yield* evening).toEqual({ called: ["c"] }); // b's own claim was taken: once a day each, even on a retry
  }).pipe(h.provide),
);

it.effect("😐 skipping the latest three in a row is enough", () =>
  Effect.gen(function* () {
    const memes = yield* Memes;
    yield* fiveDailyMemes;
    for (let i = 0; i < 5; i++) yield* memes.castVote(`t3_d${i}`, "a", "lol");
    for (const i of [3, 4]) yield* memes.castVote(`t3_d${i}`, "b", "fire"); // b voted on the two oldest only
    for (const i of [0, 1, 2, 3, 4]) yield* memes.castVote(`t3_d${i}`, "c", "fire");
    yield* h.setTime(Date.parse("2026-11-06T17:05:00Z"));
    expect((yield* MemeShame.use((m) => m.slackers())).who).toEqual([expect.objectContaining({ user: "b", missed: 3 })]);
  }).pipe(h.provide),
);

it.effect("😐 a meme up for less than 6 hours doesn't count yet", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const memes = yield* Memes;
    yield* fiveDailyMemes;
    for (let i = 0; i < 3; i++) {
      // three posted this afternoon (unlikely, but the rule only looks at when they went up)
      yield* db.insert(memeTable).values({ id: `t3_f${i}`, title: "f", image: "i", link: "l", author: "u", published: "2026-11-06T08:00:00Z", ingested_at: "x", post_kind: "daily", day: `2026-11-0${6 + i}`, posted_at: `2026-11-06T1${3 + i}:00:00.000Z`, channel_id: "memes", message_id: `fresh${i}` });
    }
    for (const u of ["a", "b", "c"]) for (let i = 0; i < 5; i++) yield* memes.castVote(`t3_d${i}`, u, "lol");
    yield* h.setTime(Date.parse("2026-11-06T17:05:00Z")); // 19:05: the fresh ones are 2 to 4 hours old
    expect((yield* MemeShame.use((m) => m.slackers())).who).toEqual([]);
  }).pipe(h.provide),
);

it.effect("a start whose play count fails after the ping keeps its claim: the ping never goes twice", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const gn = yield* GameNight;
    yield* db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: (yield* now) - 60, message_id: "card", reminded: false });
    yield* sql(`CREATE OR REPLACE FUNCTION qa_fail() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'games are down'; END $$ LANGUAGE plpgsql`);
    yield* sql(`CREATE TRIGGER qa_fail BEFORE UPDATE ON games FOR EACH STATEMENT EXECUTE FUNCTION qa_fail()`);
    yield* snapshot([]);
    yield* gn.maintain;
    yield* gn.maintain; // the next minute
    const said = yield* logged;
    yield* sql("DROP TRIGGER qa_fail ON games");
    expect((yield* night)!.reminded).toBe(true);
    expect(calls.filter((c) => c.method === "POST" && c.path === "/channels/gn/messages" && c.body.content?.includes("starts now"))).toHaveLength(1);
    expect(said).toContain("counting the night as played failed");
    expect(said).not.toContain("the start ping failed");
  }).pipe(h.provide),
);

it.effect("the daily meme waits for POST_HOUR_UTC, to the hour", () =>
  Effect.gen(function* () {
    const jobs = yield* Jobs;
    yield* Memes.use((m) => m.ingest([{ id: "t3_h", title: "H", image: "i", link: "l", author: "a", published: "2026-11-05T08:00:00Z", rank: 1 }]));
    yield* h.setTime(Date.parse("2026-11-06T09:59:00Z"));
    expect(yield* jobs.postDaily).toEqual({ skipped: "too early" });
    yield* h.setTime(Date.parse("2026-11-06T10:00:00Z"));
    expect(yield* jobs.postDaily).toMatchObject({ posted: "t3_h" });
  }).pipe(h.provide),
);

it.effect("a daily meme whose comment thread won't open is still posted", () =>
  Effect.gen(function* () {
    const memes = yield* Memes;
    yield* h.setTime(Date.parse("2026-11-06T11:00:00Z"));
    yield* memes.ingest([{ id: "t3_t", title: "T", image: "i", link: "l", author: "a", published: "2026-11-05T08:00:00Z", rank: 1 }]);
    h.override = (c) => (c.method === "POST" && c.path.endsWith("/threads") ? json({ message: "Missing Permissions", code: 50013 }, 403) : undefined);
    expect(yield* Jobs.use((j) => j.postDaily)).toMatchObject({ posted: "t3_t" });
    const said = yield* logged;
    expect(said).toContain("opening the meme's comment thread failed");
    expect((yield* memes.get("t3_t"))!.message_id).toBeTruthy();
  }).pipe(h.provide),
);

it.effect("one failing job doesn't stop the others in the same minute", () =>
  Effect.gen(function* () {
    yield* h.setTime(Date.parse("2026-11-06T01:05:00Z")); // 03:05: the sweep's time
    h.override = (c) => {
      if (c.path === "/users/@me") return json({ id: "bot" });
      if (c.method === "GET" && c.path.startsWith("/channels/gn/messages")) return json({ message: "Missing Access", code: 50001 }, 403);
      return undefined;
    };
    const out = yield* Jobs.use((j) => j.minute);
    const said = yield* logged;
    expect(String((out.cleanup as { error: string }).error)).toContain("403");
    expect(said).toContain("the “cleanup” job failed");
    expect(out).toHaveProperty("meme-shame"); // the jobs after it still ran
    expect(out).toHaveProperty("gateway");
  }).pipe(h.provide),
);
