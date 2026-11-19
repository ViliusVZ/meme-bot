// ⚡ Play now: today's time card has a quick row (Now · In 15 min · In 30 min · In 1 h), a quick tap
// is an ordinary pick worked out at the tap, and everyone on picks that are now or past starts the
// night on the spot (pinging only who isn't in voice). A locked-in night starts early when all
// three tap ⚡ Ready now. Real Postgres, Discord stubbed, the clock frozen and moved by hand.
import { expect, it } from "@effect/vitest";
import { and, eq } from "drizzle-orm";
import { Effect, Fiber } from "effect";
import { GameNight, type Deferred } from "../src/gamenight.js";
import { Nights } from "../src/nights.js";
import { Presence } from "../src/presence.js";
import { Db } from "../src/db/db.js";
import { gameNights, gameNightVotes, games, nightAttendance, panels, rooms } from "../src/db/schema.js";
import { harness, routes } from "./fx.js";

const h = harness({
  tables: [panels, gameNightVotes, nightAttendance, rooms, gameNights, games],
  seed: (t) => t.db.insert(games).values([{ name: "R.E.P.O.", emoji: "📦", added_at: "2026-11-03" }]),
  discord: { firstId: 5000, routes: [routes.noVoiceState, routes.lobbyOnly, routes.channelExists] },
  clock: "2026-11-06T16:05:00Z", // Friday 18:05 in Vilnius
});
const calls = h.calls;

const DAY = "2026-11-06";
/** A Vilnius wall time that day, as unix seconds. */
const at = (local: string) => Date.parse(`${DAY}T${local}+02:00`) / 1000;
const SILENT = 1 << 12;

type Later = Parameters<Deferred>[0];
type Pending = Fiber.Fiber<unknown, Effect.Error<Later>>[];
/** A tap, its slow side effects (the start) waited for, as the admin vote route does. */
const act = (user: string, action: string, value?: string, day = DAY) =>
  Effect.gen(function* () {
    const pending: Pending = [];
    const r = yield* GameNight.use((g) => g.act(day, user, action, value, (e) => Effect.map(Effect.forkDetach(e), (f) => void pending.push(f))));
    while (pending.length) yield* Fiber.joinAll(pending.splice(0));
    return r;
  });
const night = (day = DAY) => Nights.use((n) => n.get(day)).pipe(Effect.map((n) => n!));
const card = (viewer?: string, day = DAY) => GameNight.use((g) => g.render(day, viewer)).pipe(Effect.map((c) => JSON.stringify(c)));
const myPick = (user: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const r = yield* db.select().from(gameNightVotes).where(and(eq(gameNightVotes.day, DAY), eq(gameNightVotes.stage, "time"), eq(gameNightVotes.user_id, user)));
    return r[0] ? Number(r[0].choice) : null;
  });
const roomId = Effect.gen(function* () {
  const db = yield* Db;
  return (yield* db.select().from(rooms))[0]?.channel_id;
});
const gn = () => calls.filter((c) => c.method === "POST" && c.path === "/channels/gn/messages");
const now = (local: string) => h.setTime(at(local) * 1000);

/** Today's night, R.E.P.O. picked, waiting on start times (the card went up an hour ago). */
const timeStage = (day = DAY) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db.insert(gameNights).values({ day, stage: "time", game: "R.E.P.O.", message_id: "card", stage_at: at("17:05:00") });
  });
/** Who's in which voice channel (the gateway's snapshot). */
const voice = (where: Record<string, string>) => Presence.use((p) => p.snapshot(Object.entries(where).map(([user_id, channel_id]) => ({ user_id, channel_id }))));

it.effect("everyone taps ⚡ Now: it starts at once, the Lobby is moved in, and only who isn't in voice is pinged", () =>
  Effect.gen(function* () {
    yield* timeStage();
    yield* voice({ a: "lobby", b: "lobby" });
    yield* act("a", "soon", "0");
    yield* act("b", "soon", "0");
    expect((yield* night()).stage).toBe("time"); // waiting on c
    yield* now("18:05:20");
    yield* act("c", "soon", "0");
    const n = yield* night();
    expect([n.stage, n.start_at, n.reminded]).toEqual(["set", at("18:05:20"), true]);
    const room = (yield* roomId)!;
    expect(calls.filter((c) => c.method === "PATCH" && c.path.startsWith("/guilds/guild/members/")).map((c) => [c.path.split("/").pop(), c.body.channel_id])).toEqual([
      ["a", room],
      ["b", room],
    ]);
    // no "it's on at…" ping: just the start, for the one who isn't in voice
    expect(gn().map((c) => c.body.content)).toEqual([`⏰ <@c> 📦 **R.E.P.O.** starts now! <@a> and <@b> are already in → <#${room}>`]);
    expect(gn()[0].body.allowed_mentions).toEqual({ users: ["c"] });
    expect(calls.filter((c) => c.method === "POST" && c.path.endsWith("/scheduled-events"))).toHaveLength(1); // the event, as on any night
    expect(yield* card()).not.toContain("Slowpoke"); // three taps seconds apart
  }).pipe(h.provide),
);

it.effect("everyone on ⚡ Now and all in voice: one silent line", () =>
  Effect.gen(function* () {
    yield* timeStage();
    yield* voice({ a: "lobby", b: "lobby", c: "lobby" });
    for (const u of ["a", "b", "c"]) yield* act(u, "soon", "0");
    const room = (yield* roomId)!;
    expect(gn().map((c) => [c.body.content, c.body.flags & SILENT, c.body.allowed_mentions])).toEqual([[`📦 Everyone's here, so **R.E.P.O.** is on → <#${room}>`, SILENT, { parse: [] }]]);
  }).pipe(h.provide),
);

it.effect("mixed quick picks: rounded up to the next 5 minutes, and the night locks in at the latest", () =>
  Effect.gen(function* () {
    yield* timeStage();
    yield* now("18:07:30");
    yield* act("a", "soon", "0");
    yield* act("b", "soon", "15");
    yield* act("c", "soon", "30");
    expect([yield* myPick("a"), yield* myPick("b"), yield* myPick("c")]).toEqual([at("18:07:30"), at("18:25:00"), at("18:40:00")]);
    const n = yield* night();
    expect([n.stage, n.start_at, n.reminded]).toEqual(["set", at("18:40:00"), false]);
    expect(gn().map((c) => c.body.content)).toEqual([`🎉 <@a> <@b> <@c> it's on! 📦 **R.E.P.O.** at <t:${at("18:40:00")}:t> (<t:${at("18:40:00")}:R>)`]);
  }).pipe(h.provide),
);

it.effect("one on a fixed slot and two on ⚡ Now: it starts at the slot", () =>
  Effect.gen(function* () {
    yield* timeStage();
    yield* act("a", "time", String(at("20:00:00")));
    yield* act("b", "soon", "0");
    yield* act("c", "soon", "0");
    const n = yield* night();
    expect([n.stage, n.start_at, n.reminded]).toEqual(["set", at("20:00:00"), false]);
  }).pipe(h.provide),
);

it.effect("changing your mind: another quick button replaces your pick; tapping your pick's button takes it back, also once it has passed", () =>
  Effect.gen(function* () {
    yield* timeStage();
    yield* act("a", "soon", "0");
    expect(yield* myPick("a")).toBe(at("18:05:00"));
    // a's own copy offers the pick as a button (highlighted), in its own row after the quick row
    expect(yield* card("a")).toContain(`"style":3,"label":"18:05","custom_id":"gn:${DAY}:time:${at("18:05:00")}"`);
    yield* act("a", "soon", "60");
    expect(yield* myPick("a")).toBe(at("19:05:00"));
    yield* act("a", "soon", "0");
    yield* now("18:15:00"); // ten minutes on, the Now pick has passed: still a button, still one tap to take back
    expect(yield* card("a")).toContain(`gn:${DAY}:time:${at("18:05:00")}`);
    yield* act("a", "time", String(at("18:05:00")));
    expect(yield* myPick("a")).toBeNull();
    // a passed time nobody picked can't be picked
    expect((yield* act("b", "time", String(at("18:10:00")))).notice).toContain("already passed");
  }).pipe(h.provide),
);

it.effect("a ⚡ Now pick 40 minutes old when the last one taps: it starts now", () =>
  Effect.gen(function* () {
    yield* timeStage();
    yield* voice({});
    yield* act("a", "soon", "0");
    yield* now("18:10:00");
    yield* act("b", "soon", "0");
    yield* now("18:45:00");
    yield* act("c", "soon", "0");
    const n = yield* night();
    expect([n.stage, n.start_at, n.reminded]).toEqual(["set", at("18:45:00"), true]);
    const room = (yield* roomId)!;
    expect(gn().map((c) => c.body.content)).toEqual([`⏰ <@a> <@b> <@c> 📦 **R.E.P.O.** starts now! Room: <#${room}>`]);
  }).pipe(h.provide),
);

it.effect("the quick row is on today's time card only", () =>
  Effect.gen(function* () {
    const later = "2026-11-08";
    yield* timeStage();
    yield* timeStage(later);
    const today = yield* card();
    for (const m of ["0", "15", "30", "60"]) expect(today).toContain(`gn:${DAY}:soon:${m}`);
    expect(today).toContain('"label":"Now"');
    expect(today).toContain('"label":"In 1 h"');
    expect(yield* card(undefined, later)).not.toContain(":soon:");
    expect((yield* act("a", "soon", "0", later)).notice).toContain("tonight's card");
    // components: today's card stays within Discord's 40 (container, texts, rows and buttons)
    let count = 0;
    JSON.parse(today).components.forEach(function walk(c: any) {
      count++;
      (c.components ?? []).forEach(walk);
    });
    expect(count).toBeLessThanOrEqual(40);
  }).pipe(h.provide),
);

it.effect("⚡ Ready now on a locked-in night: two aren't enough, a tap goes stale after 30 min, all three start it now", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: at("20:00:00"), message_id: "card", stage_at: at("17:30:00") });
    yield* voice({ a: "lobby", b: "lobby" });
    expect(yield* card()).toContain(`gn:${DAY}:readynow`);
    yield* act("a", "readynow");
    yield* now("18:10:00");
    expect((yield* act("b", "readynow")).notice).toContain("When <@c> taps it too");
    expect(yield* card()).toContain("⚡ Ready now: <@a> <@b>");
    expect((yield* night()).reminded).toBe(false);
    // tap again: taken back
    yield* act("b", "readynow");
    expect(yield* card()).toContain("⚡ Ready now: <@a> ·");
    yield* now("18:20:00");
    yield* act("b", "readynow");
    // 18:40: a's tap is 35 minutes old, so c's makes two, not three
    yield* now("18:40:00");
    yield* act("c", "readynow");
    expect((yield* night()).reminded).toBe(false);
    expect(yield* card()).toContain("⚡ Ready now: <@b> <@c>");
    yield* act("a", "readynow");
    const n = yield* night();
    expect([n.reminded, n.start_at]).toEqual([true, at("18:40:00")]);
    const room = (yield* roomId)!;
    expect(gn().map((c) => c.body.content)).toEqual([`⏰ <@c> 📦 Everyone's ready, so **R.E.P.O.** is on now (was 20:00)! <@a> and <@b> are already in → <#${room}>`]);
    expect(gn()[0].body.allowed_mentions).toEqual({ users: ["c"] });
    // the 20:00 timer finds it started and moved: nothing more
    yield* now("20:00:00");
    const before = calls.length;
    yield* GameNight.use((g) => g.maintain);
    expect(calls.slice(before).filter((c) => c.method === "POST")).toEqual([]);
  }).pipe(h.provide),
);
