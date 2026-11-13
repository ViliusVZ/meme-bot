// ⚔️ Early birds (plan 07) against a real Postgres, Discord stubbed, on TestClock: a locked-in night
// knows when people show up early. All three here for 30 s starts it now, quietly; two get the
// night's card instead of "Playing something?"; the start pings only who isn't in the room yet.
import { expect, it } from "@effect/vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { Duration, Effect } from "effect";
import { TestClock } from "effect/testing";
import { activityGuesses, fleeting, gameAliases, gameNights, games, lobbyPrompts, nightAttendance, nightCards, readyRooms, rooms, sessions, settings, voiceSegments } from "../src/db/schema.js";
import { Db, type DbError } from "../src/db/db.js";
import type { DiscordError } from "../src/discord.js";
import { Spontaneous, type Change, type Where } from "../src/spontaneous.js";
import { GameNight, type NightGone } from "../src/gamenight.js";
import { LateSlips } from "../src/late.js";
import { Live } from "../src/live.js";
import { Presence } from "../src/presence.js";
import { Activity } from "../src/activity.js";
import { Interactions } from "../src/interactions.js";
import { harness, json, routes } from "./fx.js";

const h = harness({
  tables: [lobbyPrompts, nightCards, sessions, fleeting, voiceSegments, rooms, nightAttendance, gameNights, games, gameAliases, readyRooms, activityGuesses, settings],
  seed: (t) =>
    t.db.insert(games).values([
      { name: "World of Warcraft", emoji: "⚔️", added_at: "x", plays: 3 },
      { name: "R.E.P.O.", emoji: "📦", added_at: "x", plays: 5 },
    ]),
  discord: { firstId: 70000, routes: [routes.noVoiceState, routes.lobbyOnly] },
  env: { PRESENCES: true }, // game detection on, as in production
  clock: "test",
});
const calls = h.calls;

const DAY = "2026-11-12";
/** A Vilnius wall time that day, as unix seconds. */
const at = (local: string) => Date.parse(`${DAY}T${local}+02:00`) / 1000;
const START = at("19:00:00");
const SILENT = 1 << 12;
const V2 = 1 << 15;
const WOW = "World of Warcraft";

const posts = (path: string) => calls.filter((c) => c.method === "POST" && c.path === path);
const gn = () => posts("/channels/gn/messages");
const lobbyPosts = () => posts("/channels/lobby/messages");
const text = (c: { body?: any }) => JSON.stringify(c.body);
const rows = <T>(q: (db: Db["Service"]) => Effect.Effect<T, DbError>) =>
  Effect.gen(function* () {
    return yield* Effect.orDie(q(yield* Db));
  });
const theNight = rows((db) => db.select().from(gameNights).where(eq(gameNights.day, DAY))).pipe(Effect.map((r) => r[0]));
const plays = rows((db) => db.select().from(games).where(eq(games.name, WOW))).pipe(Effect.map((r) => r[0].plays));
const prompt = rows((db) => db.select().from(lobbyPrompts).where(eq(lobbyPrompts.current, true))).pipe(Effect.map((r) => r[0]));
const roomId = rows((db) => db.select().from(rooms).where(eq(rooms.game, WOW))).pipe(Effect.map((r) => r[0]?.channel_id));

/** The night, locked in at 18:14 for `start`. */
const night = (start = START, game = WOW) =>
  rows((db) => db.insert(gameNights).values({ day: DAY, stage: "set", game, start_at: start, message_id: "card", stage_at: at("18:14:00") }));

let where = new Map<string, string | null>();
/**
 * Put people somewhere at `t` (as the gateway would), then let the bot react exactly as live.ts does:
 * the stats track, the early birds, then spontaneous play.
 */
const step = (t: number, moves: Record<string, string | null> = {}, change?: Change) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(t * 1000);
    for (const [u, ch] of Object.entries(moves)) where.set(u, ch);
    yield* Presence.use((p) => p.snapshot([...where].filter(([, ch]) => ch).map(([user_id, channel_id]) => ({ user_id, channel_id: channel_id! }))));
    yield* Activity.use((a) => a.track(where, t));
    const early = yield* GameNight.use((g) => g.early(where as Where, t));
    const due = yield* Spontaneous.use((s) => s.react(where, t, change));
    return { early, due };
  });
const playing = (user: string, ...names: string[]) => Presence.use((p) => p.setActivities(user, names.map((name) => ({ type: 0, name }))));
const tap = (custom_id: string, user: string) =>
  Effect.andThen(
    Interactions.use((x) => x.handle({ type: 3, token: "tok", channel_id: "lobby", member: { user: { id: user, username: user } }, message: { id: "q1", flags: 0 }, data: { custom_id } })),
    h.settle,
  );
/** The card's buttons, by what they do. */
const buttons = (card: { body?: any }) => {
  const ids: string[] = [];
  JSON.stringify(card.body, (k, v) => (k === "custom_id" && ids.push(v), v));
  return { open: ids.find((i) => i.includes(":g:"))!, chill: ids.find((i) => i.endsWith(":chill"))! };
};
const now = (t: number) => TestClock.setTime(t * 1000);
const runNow = (e: Effect.Effect<unknown, DbError | DiscordError | NightGone>) => Effect.asVoid(Effect.orDie(e));

const reset = () => {
  where = new Map();
};

// ---------------------------------------------------------------- 1. the replay of 2026-11-12

/** Let the database and the stub answer (real I/O, on the live clock). */
const io = TestClock.withLive(Effect.sleep(Duration.millis(150)));
const to = (ms: number) => Effect.andThen(TestClock.setTime(ms), io);
const until = (done: () => boolean) =>
  Effect.gen(function* () {
    for (let i = 0; i < 40 && !done(); i++) yield* io;
  });

it.effect("2026-11-12 again: the third joins at 18:43:45, the night starts at 18:44:15 with one silent line, and 19:00 brings nothing", () =>
  Effect.gen(function* () {
    reset();
    yield* TestClock.setTime(at("18:14:00") * 1000);
    yield* night();
    yield* Live.use((l) => l.watch);
    const p = yield* Presence;
    yield* p.snapshot([]);
    yield* io;
    const join = (user: string, local: string) =>
      Effect.gen(function* () {
        yield* to(at(local) * 1000);
        yield* p.update(user, "lobby");
        yield* io;
      });
    yield* join("a", "18:29:00");
    // Koral alone for 14 minutes: nothing (the heartbeat looks every minute)
    for (let m = 1; m <= 14; m++) yield* to((at("18:29:00") + m * 60) * 1000);
    yield* join("b", "18:43:31");
    yield* join("c", "18:43:45");
    yield* to(at("18:44:01") * 1000 + 500); // the gathering's 30 s: no "Playing something?", no card either
    expect(lobbyPosts()).toEqual([]);
    expect((yield* theNight).reminded).toBe(false);
    yield* to(at("18:44:15") * 1000 + 500); // all three here for 30 s
    yield* until(() => gn().length > 0);
    const n = yield* theNight;
    expect([n.reminded, n.start_at]).toEqual([true, at("18:44:15")]);
    expect(gn()).toHaveLength(1);
    const [line] = gn();
    expect(line.body.content).toBe(`⚔️ Everyone's here early, so **World of Warcraft** is on now (was 19:00) → <#${yield* roomId}>`);
    expect(line.body.flags & SILENT).toBe(SILENT);
    expect(line.body.allowed_mentions).toEqual({ parse: [] });
    expect(line.body.content).not.toContain("<@");
    expect(posts("/guilds/guild/channels")).toHaveLength(1); // the room, opened once
    expect(lobbyPosts()).toEqual([]);
    const arrived = yield* rows((db) => db.select().from(nightAttendance));
    expect(arrived.map((r) => [r.user_id, r.state, r.arrived_at]).sort()).toEqual([
      ["a", "arrived", at("18:44:15")],
      ["b", "arrived", at("18:44:15")],
      ["c", "arrived", at("18:44:15")],
    ]);
    // the moves land (the gateway says so), and the evening goes on to 19:00
    const room = (yield* roomId)!;
    for (const u of ["a", "b", "c"]) yield* p.update(u, room);
    yield* io;
    for (let m = 45; m <= 58; m++) yield* to(at(`18:${m}:00`) * 1000);
    const before = calls.length;
    expect(yield* GameNight.use((g) => g.preciseStarts(at("18:58:00") + 120))).toEqual([]); // the 19:00 timer: nothing to arm
    yield* to(at("19:00:00") * 1000);
    yield* GameNight.use((g) => g.maintain);
    yield* LateSlips.use((l) => l.watch);
    yield* to(at("19:00:30") * 1000);
    expect(calls.slice(before).filter((c) => c.method === "POST")).toEqual([]);
  }).pipe(Effect.scoped, h.provide),
);

// ---------------------------------------------------------------- 2. two early

it.effect("two early: the night's card, not the question; Open the room; the line for the third; the third pulled in and 30 s later it starts, counted once", () =>
  Effect.gen(function* () {
    reset();
    yield* night();
    yield* step(at("18:20:00"), { a: "lobby" });
    expect((yield* step(at("18:20:10"), { b: "lobby" })).due).toBe(at("18:20:40"));
    yield* step(at("18:20:40"));
    expect(lobbyPosts()).toHaveLength(1);
    const [card] = lobbyPosts();
    expect(text(card)).not.toContain("Playing something?");
    expect(text(card)).toContain(`### ⚔️ World of Warcraft at <t:${START}:t> · you're early`);
    expect(text(card)).toContain("-# Still waiting on <@c>. Want the room already?");
    expect(card.body.flags).toBe(V2 | SILENT);
    expect(card.body.allowed_mentions).toEqual({ parse: [] });
    const { open, chill } = buttons(card);
    expect([open.endsWith(":g:World of Warcraft"), !!chill]).toEqual([true, true]);
    // ⚔️ Open the room: the room opens and the Lobby comes along; the card goes
    calls.length = 0;
    yield* tap(open, "a");
    const room = (yield* roomId)!;
    expect(calls.filter((c) => c.method === "PATCH" && c.path.startsWith("/guilds/guild/members/")).map((c) => [c.path.split("/").pop(), c.body.channel_id])).toEqual([
      ["a", room],
      ["b", room],
    ]);
    expect(calls.some((c) => c.method === "DELETE" && c.path.startsWith("/channels/lobby/messages/"))).toBe(true);
    expect((yield* theNight).reminded).toBe(false); // the night itself hasn't started
    yield* step(at("18:20:45"), { a: room, b: room });
    // two minutes in, the quiet line tells the third where we are
    yield* step(at("18:22:45"));
    expect(gn().map((c) => c.body.content)).toEqual([`🎮 <@a> and <@b> are in **World of Warcraft** → <#${room}>`]);
    yield* step(at("18:31:00"));
    expect(yield* plays).toBe(4); // ten minutes together: it counts
    // the third joins the Lobby and is pulled in
    yield* step(at("18:35:00"), { c: "lobby" }, { user: "c", from: null, to: "lobby" });
    expect(calls.filter((c) => c.method === "PATCH" && c.path === "/guilds/guild/members/c").map((c) => c.body.channel_id)).toEqual([room]);
    yield* step(at("18:35:01"), { c: room });
    yield* step(at("18:35:30"));
    expect((yield* theNight).reminded).toBe(false);
    yield* step(at("18:35:31"));
    const n = yield* theNight;
    expect([n.reminded, n.start_at]).toEqual([true, at("18:35:31")]);
    const started = gn()[1];
    expect(started.body.content).toBe(`⚔️ Everyone's here early, so **World of Warcraft** is on now (was 19:00) → <#${room}>`);
    expect([started.body.flags & SILENT, started.body.allowed_mentions]).toEqual([SILENT, { parse: [] }]);
    expect(gn()).toHaveLength(2);
    // the warm-up was the night: absorbed, its line gone, the play counted once
    const [s] = yield* rows((db) => db.select().from(sessions));
    expect([s.absorbed, s.counted]).toEqual([true, false]);
    expect(calls.some((c) => c.method === "DELETE" && c.path.startsWith("/channels/gn/messages/"))).toBe(true);
    expect(yield* plays).toBe(4);
    expect(lobbyPosts()).toEqual([]); // after the card, nothing more in the Lobby's chat
  }).pipe(h.provide),
);

// ---------------------------------------------------------------- 3. and 4. the start pings only who isn't in the room

it.effect("two early in the room, the third never comes: at 19:00 one message pinging only the third, their late slip at 19:10", () =>
  Effect.gen(function* () {
    reset();
    yield* night();
    yield* rows((db) => db.insert(rooms).values({ channel_id: "wow", game: WOW, created_at: at("18:30:00") }));
    yield* step(at("18:40:00"), { a: "wow", b: "wow" });
    yield* step(at("18:50:00"));
    expect(gn()).toHaveLength(1); // the session's quiet line (c's missing)
    yield* now(START);
    yield* GameNight.use((g) => g.maintain);
    expect(gn()).toHaveLength(2);
    const ping = gn()[1];
    expect(ping.body.content).toBe("⏰ <@c> ⚔️ **World of Warcraft** starts now! <@a> and <@b> are already in → <#wow>");
    expect(ping.body.allowed_mentions).toEqual({ users: ["c"] });
    yield* now(START + 600);
    yield* LateSlips.use((l) => l.watch);
    expect(gn()).toHaveLength(3);
    const slip = gn()[2];
    expect(text(slip)).toContain("⏰ <@c> we've started **World of Warcraft** in <#wow>. Running late?");
    expect(slip.body.allowed_mentions).toEqual({ users: ["c"] });
  }).pipe(h.provide),
);

it.effect("the start pings exactly the people not in the room, for all eight combinations of who is", () =>
  Effect.gen(function* () {
    const trio = ["a", "b", "c"];
    for (let mask = 0; mask < 8; mask++) {
      reset();
      yield* rows((db) => Effect.all([db.delete(gameNights), db.delete(rooms), db.delete(nightAttendance), db.delete(sessions), db.delete(lobbyPrompts), db.delete(voiceSegments)]));
      const inRoom = trio.filter((_, i) => mask & (1 << i));
      const pinged = trio.filter((p) => !inRoom.includes(p));
      yield* now(START);
      yield* night();
      yield* rows((db) => db.insert(rooms).values({ channel_id: "wow", game: WOW, created_at: START - 600 }));
      yield* Presence.use((p) => p.snapshot(inRoom.map((user_id) => ({ user_id, channel_id: "wow" }))));
      calls.length = 0;
      yield* GameNight.use((g) => g.maintain);
      expect(gn()).toHaveLength(1);
      const [m] = gn();
      if (!pinged.length) {
        expect([m.body.content, m.body.flags & SILENT, m.body.allowed_mentions]).toEqual(["⚔️ Everyone's here, so **World of Warcraft** is on → <#wow>", SILENT, { parse: [] }]);
      } else {
        expect(m.body.allowed_mentions).toEqual({ users: pinged });
        expect(m.body.content.startsWith(`⏰ ${pinged.map((p) => `<@${p}>`).join(" ")} ⚔️`)).toBe(true);
        expect(m.body.content.includes("already in")).toBe(inRoom.length > 0);
      }
      const arrived = yield* rows((db) => db.select().from(nightAttendance));
      expect(arrived.map((r) => r.user_id).sort()).toEqual(inRoom);
    }
  }).pipe(h.provide),
);

// ---------------------------------------------------------------- 5. to 7. game detection and "Just hanging out"

it.effect("two early, both shown in the night's game: moved straight in, with ↩, and no card", () =>
  Effect.gen(function* () {
    reset();
    yield* night();
    yield* playing("a", WOW);
    yield* playing("b", WOW);
    yield* step(at("18:20:00"), { a: "lobby" });
    yield* step(at("18:20:10"), { b: "lobby" });
    yield* step(at("18:20:40"));
    expect(lobbyPosts()).toEqual([]);
    const room = (yield* roomId)!;
    expect(calls.filter((c) => c.method === "PATCH" && c.path.startsWith("/guilds/guild/members/")).map((c) => c.body.channel_id)).toEqual([room, room]);
    expect((yield* prompt).state).toBe("moved");
    const [note] = posts(`/channels/${room}/messages`);
    expect(text(note)).toContain("Saw <@a> and <@b> in **World of Warcraft**");
    expect(text(note)).toContain("lob:back:a,b");
    expect((yield* theNight).reminded).toBe(false);
  }).pipe(h.provide),
);

it.effect("“Just hanging out”, then the third arrives: no early start; the planned start runs as usual", () =>
  Effect.gen(function* () {
    reset();
    yield* night();
    yield* step(at("18:20:00"), { a: "lobby" });
    yield* step(at("18:20:10"), { b: "lobby" });
    yield* step(at("18:20:40"));
    yield* tap(buttons(lobbyPosts()[0]).chill, "b");
    expect((yield* prompt).state).toBe("dismissed");
    expect(calls.some((c) => c.method === "DELETE" && c.path.startsWith("/channels/lobby/messages/"))).toBe(true);
    yield* step(at("18:30:00"), { c: "lobby" }, { user: "c", from: null, to: "lobby" });
    expect((yield* step(at("18:30:30"))).early).toEqual({ started: null, due: null });
    yield* step(at("18:45:00"));
    expect((yield* theNight).reminded).toBe(false);
    expect(gn()).toEqual([]);
    expect(lobbyPosts()).toHaveLength(1);
    yield* now(START);
    yield* GameNight.use((g) => g.maintain);
    const n = yield* theNight;
    expect([n.reminded, n.start_at]).toEqual([true, START]);
    const room = (yield* roomId)!;
    expect(gn().map((c) => c.body.content)).toEqual([`⏰ <@a> <@b> <@c> ⚔️ **World of Warcraft** starts now! Room: <#${room}> (moved <@a> <@b> <@c> from the Lobby)`]);
  }).pipe(h.provide),
);

it.effect("all three here, two shown in another of our games: no early start, the card instead", () =>
  Effect.gen(function* () {
    reset();
    yield* night();
    yield* playing("a", "R.E.P.O.");
    yield* playing("b", "R.E.P.O.");
    yield* step(at("18:20:00"), { a: "lobby", b: "lobby", c: "lobby" });
    expect((yield* step(at("18:20:30"))).early).toEqual({ started: null, due: null });
    expect(lobbyPosts()).toHaveLength(1);
    const [card] = lobbyPosts();
    expect(text(card)).toContain("you're early\\n-# Want the room already?");
    expect(text(card)).not.toContain("Still waiting on");
    yield* step(at("18:25:00"));
    expect((yield* theNight).reminded).toBe(false);
    expect(yield* rows((db) => db.select().from(rooms))).toEqual([]);
    expect(lobbyPosts()).toHaveLength(1);
  }).pipe(h.provide),
);

// ---------------------------------------------------------------- 8. the card's life

it.effect("the card goes when the gathering breaks up and when the night is called off, and follows a moved start", () =>
  Effect.gen(function* () {
    reset();
    yield* night();
    const deleted = (id: string | null | undefined) => calls.some((c) => c.method === "DELETE" && c.path === `/channels/lobby/messages/${id}`);
    yield* step(at("18:20:00"), { a: "lobby", b: "lobby" });
    yield* step(at("18:20:30"));
    const first = yield* prompt;
    expect(lobbyPosts()).toHaveLength(1);
    // b steps out: the gathering broke up, the card goes
    yield* step(at("18:22:00"), { b: null });
    expect(deleted(first.message_id)).toBe(true);
    expect(yield* prompt).toBeUndefined();
    // back together: a new card
    yield* step(at("18:23:00"), { b: "lobby" });
    yield* step(at("18:23:30"));
    expect(lobbyPosts()).toHaveLength(2);
    const second = yield* prompt;
    // ⏰ c is running 15 min late: the start moves, the card follows
    yield* GameNight.use((g) => g.act(DAY, "c", "late", "15", runNow));
    expect((yield* theNight).start_at).toBe(START + 900);
    const [edit] = calls.filter((c) => c.method === "PATCH" && c.path === `/channels/lobby/messages/${second.message_id}`);
    expect(text(edit)).toContain(`at <t:${START + 900}:t> · you're early`);
    expect((yield* rows((db) => db.select().from(nightCards).where(eq(nightCards.prompt_id, second.id))))[0].start_at).toBe(START + 900);
    // c can't make it after all: the night's off, and the card goes
    yield* now(at("18:40:00"));
    yield* GameNight.use((g) => g.bailFromSlip(DAY, "c"));
    expect((yield* theNight).stage).toBe("off");
    expect(deleted(second.message_id)).toBe(true);
    expect((yield* rows((db) => db.select().from(lobbyPrompts).where(eq(lobbyPrompts.id, second.id))))[0].state).toBe("expired");
  }).pipe(h.provide),
);

// ---------------------------------------------------------------- 9. to 11. what stays as it was, guesses, races

it.effect("outside the window, and while the vote is still open: plan 01's question, unchanged", () =>
  Effect.gen(function* () {
    reset();
    yield* night();
    // 15:50: the night is 3 h 10 min away
    yield* step(at("15:50:00"), { a: "lobby", b: "lobby" });
    yield* step(at("15:50:30"));
    expect(lobbyPosts()).toHaveLength(1);
    expect(text(lobbyPosts()[0])).toContain("Playing something?");
    // later, a new day's vote still running (no start yet): the question too
    yield* step(at("15:55:00"), { a: null, b: null });
    yield* rows((db) => db.update(gameNights).set({ stage: "time", start_at: null }).where(eq(gameNights.day, DAY)));
    yield* step(at("18:20:00"), { a: "lobby", b: "lobby", c: "lobby" });
    expect((yield* step(at("18:20:30"))).early).toEqual({ started: null, due: null });
    expect(lobbyPosts()).toHaveLength(2);
    expect(text(lobbyPosts()[1])).toContain("Playing something?");
    expect(yield* rows((db) => db.select().from(nightCards))).toEqual([]);
  }).pipe(h.provide),
);

it.effect("no voice snapshot: no early start and no card", () =>
  Effect.gen(function* () {
    reset();
    yield* night();
    yield* now(at("18:20:00"));
    yield* rows((db) =>
      db.insert(voiceSegments).values(["a", "b", "c"].map((user_id) => ({ user_id, channel_id: "lobby", started_at: at("18:20:00"), last_seen: at("18:20:00") }))),
    );
    // the gateway had them all in the Lobby, then dropped: what it last said is a guess now
    const p = yield* Presence;
    yield* p.snapshot(["a", "b", "c"].map((user_id) => ({ user_id, channel_id: "lobby" })));
    yield* p.invalidate;
    yield* now(at("18:30:00"));
    expect(yield* GameNight.use((g) => g.early())).toEqual({ started: null, due: null });
    yield* GameNight.use((g) => g.maintain);
    expect((yield* theNight).reminded).toBe(false);
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  }).pipe(h.provide),
);

it.effect("a voice change and the minute tick both see “everyone's here” at once: one start", () =>
  Effect.gen(function* () {
    reset();
    yield* night();
    yield* step(at("18:20:00"), { a: "lobby", b: "lobby", c: "lobby" });
    yield* now(at("18:20:30"));
    // the first claim is held in the database for 0.3 s, so both have decided to start before either has claimed
    const sql = (q: string) => Effect.promise(() => h.t.pool.query(q));
    yield* sql(`CREATE OR REPLACE FUNCTION qa_hold_claim() RETURNS trigger AS $$ BEGIN PERFORM pg_sleep(0.3); RETURN NEW; END $$ LANGUAGE plpgsql`);
    yield* sql(`CREATE TRIGGER qa_hold_claim BEFORE UPDATE ON game_nights FOR EACH ROW WHEN (NEW.reminded AND NOT OLD.reminded) EXECUTE FUNCTION qa_hold_claim()`);
    const both = Effect.all([GameNight.use((g) => g.early(where, at("18:20:30"))), GameNight.use((g) => g.maintain)], { concurrency: "unbounded" });
    const [fromVoice, fromMinute] = yield* both.pipe(Effect.ensuring(sql("DROP TRIGGER IF EXISTS qa_hold_claim ON game_nights")));
    expect([fromVoice.started, fromMinute.early].filter(Boolean)).toEqual([DAY]);
    expect(gn()).toHaveLength(1);
    expect(posts("/guilds/guild/channels")).toHaveLength(1);
    expect(yield* plays).toBe(4);
    const n = yield* theNight;
    expect([n.reminded, n.start_at]).toEqual([true, at("18:20:30")]);
  }).pipe(h.provide),
);

// ---------------------------------------------------------------- 13. the name fix

const aliasMigration = () => {
  const dir = fileURLToPath(new URL("../drizzle", import.meta.url));
  const m = readdirSync(dir).find((f) => f.endsWith("_wow_forever_alias"))!;
  return readFileSync(`${dir}/${m}/migration.sql`, "utf8");
};

it.effect("“World of Warcraft: Forever” is World of Warcraft (a migration); an unanswered ask is tried again after an hour", () =>
  Effect.gen(function* () {
    reset();
    const migrate = Effect.promise(() => h.t.pool.query(aliasMigration()));
    yield* migrate; // a fresh database: nothing to learn from yet
    expect(yield* rows((db) => db.select().from(gameAliases))).toEqual([]);
    yield* rows((db) => db.insert(gameNights).values({ day: "2026-11-11", stage: "off" }));
    yield* migrate;
    yield* migrate; // (twice is once)
    expect((yield* rows((db) => db.select().from(gameAliases))).map((a) => [a.activity, a.game])).toEqual([["World of Warcraft: Forever", WOW]]);
    // two of us playing it in the Lobby, nothing planned: straight to World of Warcraft's room
    yield* playing("a", "World of Warcraft: Forever");
    yield* playing("b", "World of Warcraft: Forever", "CurseForge");
    yield* step(at("18:20:00"), { a: "lobby", b: "lobby" });
    yield* step(at("18:20:30"));
    expect([(yield* prompt).state, (yield* prompt).game, !!(yield* roomId)]).toEqual(["moved", WOW, true]);
    // Gemini didn't answer about "CurseForge": asked again an hour later, not before, not a day later
    const asked: string[] = [];
    h.override = (c) => (c.path.includes("generativelanguage.googleapis.com") ? (asked.push(c.path), json({ error: "busy" }, 503)) : undefined);
    const learn = (t: number) => Spontaneous.use((s) => s.learn(["CurseForge"], t)).pipe(h.withConfig({ geminiApiKey: "k" }));
    const t0 = at("18:21:00");
    expect(yield* learn(t0)).toEqual([]);
    expect(yield* learn(t0 + 3599)).toEqual([]);
    expect(asked).toHaveLength(1);
    expect(yield* learn(t0 + 3600)).toEqual([]);
    expect(asked).toHaveLength(2);
    expect(yield* learn(t0 + 3700)).toEqual([]);
    expect(asked).toHaveLength(2); // one claim per name: once an hour at most
  }).pipe(h.provide),
);

it.effect("a card that won't post leaves the gathering quiet (and says so); the next gathering gets one", () =>
  Effect.gen(function* () {
    reset();
    yield* night();
    h.override = (c) => (c.method === "POST" && c.path === "/channels/lobby/messages" ? json({ message: "boom" }, 400) : undefined);
    yield* step(at("18:20:00"), { a: "lobby", b: "lobby" });
    yield* step(at("18:20:30"));
    expect((yield* prompt).state).toBe("failed");
    expect(h.logs.join("\n")).toContain("posting the early-bird card");
    yield* step(at("18:25:00"));
    expect(lobbyPosts()).toHaveLength(1); // tried once
    h.override = null;
    yield* step(at("18:26:00"), { a: null, b: null });
    yield* step(at("18:27:00"), { a: "lobby", b: "lobby" });
    yield* step(at("18:27:30"));
    expect((yield* prompt).state).toBe("open");
    expect(lobbyPosts()).toHaveLength(2);
  }).pipe(h.provide),
);
