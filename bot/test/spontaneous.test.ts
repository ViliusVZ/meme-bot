// 🎮 Spontaneous play against a real Postgres, Discord stubbed: the Lobby question, unplanned
// sessions (the quiet line, counting, wrapping up), pulling people in, and ↩ back to the Lobby.
import { beforeEach, expect, it } from "@effect/vitest";
import { eq } from "drizzle-orm";
import { Clock, ConfigProvider, Effect, Exit, Schema } from "effect";
import * as spontaneous from "../src/spontaneous.js";
import { Spontaneous, type Change, type Where } from "../src/spontaneous.js";
import { Presence } from "../src/presence.js";
import { Activity } from "../src/activity.js";
import { Interactions } from "../src/interactions.js";
import { LocalTime } from "../src/localtime.js";
import { readConfig } from "../src/config.js";
import { Db } from "../src/db/db.js";
import type { AppServices } from "../src/runtime.js";
import { activityGuesses, fleeting, gameAliases, gameNights, games, lobbyPrompts, readyRooms, rooms, sessions, settings, voiceSegments } from "../src/db/schema.js";
import * as gemini from "../src/gemini.js";
import { harness, json, routes } from "./fx.js";

const h = harness({
  tables: [lobbyPrompts, sessions, fleeting, voiceSegments, rooms, gameNights, games, gameAliases, readyRooms, activityGuesses, settings],
  seed: (t) =>
    t.db.insert(games).values([
      { name: "World of Warcraft", emoji: "🐉", added_at: "x", plays: 3 },
      { name: "R.E.P.O.", emoji: "📦", added_at: "x", plays: 5 },
    ]),
  discord: { firstId: 9000, routes: [routes.lobbyOnly] },
  clock: "2026-11-10T19:00:00Z", // Tuesday 21:00 in Vilnius
});
const calls = h.calls;

const now = Effect.map(Clock.currentTimeMillis, (ms) => Math.floor(ms / 1000));
const DAY = "2026-11-10";
let where = new Map<string, string | null>();
/** The service's calls, each its own Effect (so one call can get its own configuration: h.withConfig). */
const sp = {
  react: (w: Where, t?: number, change?: Change) => Spontaneous.use((s) => s.react(w, t, change)),
  learn: (names: string[], t?: number) => Spontaneous.use((s) => s.learn(names, t)),
  recentGames: (n?: number) => Spontaneous.use((s) => s.recentGames(n)),
  answer: (id: number, user: string, what: string, game?: string) => Spontaneous.use((s) => s.answer(id, user, what, game)),
  goBack: (channel: string, users: string[], messageId: string | undefined, t?: number) => Spontaneous.use((s) => s.goBack(channel, users, messageId, t)),
  absorb: (day: string, game: string) => Spontaneous.use((s) => s.absorb(day, game)),
  minute: (t?: number) => Spontaneous.use((s) => s.minute(t)),
};
/** Put people somewhere (as the gateway would) at time `at`, and let the bot react like live.ts does. */
const at = (sec: number, moves: Record<string, string | null> = {}, change?: Change) =>
  Effect.gen(function* () {
    yield* h.setTime(sec * 1000);
    for (const [u, ch] of Object.entries(moves)) where.set(u, ch);
    yield* Presence.use((p) => p.snapshot([...where].filter(([, ch]) => ch).map(([user_id, channel_id]) => ({ user_id, channel_id }))));
    yield* Activity.use((a) => a.track(where, sec));
    return yield* sp.react(where, sec, change);
  });
const posted = (channel: string) => calls.filter((c) => c.method === "POST" && c.path === `/channels/${channel}/messages`);
const prompt = () =>
  Effect.gen(function* () {
    const db = yield* Db;
    return (yield* db.select().from(lobbyPrompts).where(eq(lobbyPrompts.current, true)))[0];
  });
const session = (game = "World of Warcraft") =>
  Effect.gen(function* () {
    const db = yield* Db;
    return (yield* db.select().from(sessions).where(eq(sessions.game, game)))[0];
  });
const plays = (name: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    return (yield* db.select().from(games).where(eq(games.name, name)))[0].plays;
  });
const tap = (custom_id: string, user = "a", channel_id = "lobby") =>
  Interactions.use((x) => Effect.map(x.handle({ type: 3, token: "tok", channel_id, member: { user: { id: user, username: user } }, message: { id: "q1", flags: 0 }, data: { custom_id } }), (r) => r as any));
/** vi.waitFor for an Effect: `check` again every 50 ms until it passes, for up to a second. */
const waitFor = <E, R>(check: Effect.Effect<unknown, E, R>) =>
  Effect.gen(function* () {
    for (let tries = 1; ; tries++) {
      const exit = yield* Effect.exit(check);
      if (Exit.isSuccess(exit)) return;
      if (tries > 20) return yield* Effect.failCause(exit.cause);
      yield* Effect.sleep("50 millis");
    }
  });
beforeEach(() => {
  where = new Map();
});

// ---------------------------------------------------------------- the Lobby question

it.effect("two of us in the Lobby for 30 s get one silent question; a 29-second visit gets none", () =>
  Effect.gen(function* () {
    const t0 = yield* now;
    expect(yield* at(t0, { a: "lobby" })).toBeNull(); // one person is just one person
    expect(yield* at(t0 + 5, { b: "lobby" })).toBe(t0 + 35); // look again when the 30 s are up
    yield* at(t0 + 34, { b: null }); // b leaves at 29 s
    expect(yield* at(t0 + 40, { b: "lobby" })).toBe(t0 + 70); // and back: the 30 s start over
    expect(posted("lobby")).toEqual([]);
    yield* at(t0 + 70);
    const [q] = posted("lobby");
    expect(q.body.flags & (1 << 12)).toBeTruthy(); // no sound, no badge
    expect(q.body.allowed_mentions).toEqual({ parse: [] });
    const ids = JSON.stringify(q.body.components);
    expect(ids).toContain("Playing something?");
    expect(ids).toContain(":g:R.E.P.O."); // the most played first, when nothing was played lately
    expect(ids).toContain(":chill");
    // the third joins, the clock ticks, a restart re-checks: still exactly one question
    yield* at(t0 + 80, { c: "lobby" });
    yield* at(t0 + 140);
    yield* at(t0 + 141);
    expect(posted("lobby")).toHaveLength(1);
    expect((yield* prompt()).state).toBe("open");
  }).pipe(h.provide),
);

it.effect("recent games come first on the question", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db.insert(rooms).values({ channel_id: "wow", game: "World of Warcraft", created_at: (yield* now) - 86400, archived_at: (yield* now) - 80000 });
    expect(yield* sp.recentGames()).toEqual(["World of Warcraft", "R.E.P.O."]);
  }).pipe(h.provide),
);

it.effect("first tap wins: the room opens, the Lobby comes along, the question goes; a late tap hears who won", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const t0 = yield* now;
    yield* at(t0, { a: "lobby", b: "lobby" });
    yield* at(t0 + 30);
    const id = (yield* prompt()).id;
    calls.length = 0;
    yield* tap(`lob:${id}:g:World of Warcraft`, "a");
    yield* waitFor(Effect.sync(() => expect(calls.some((c) => c.method === "DELETE" && c.path.startsWith("/channels/lobby/messages/"))).toBe(true)));
    const [room] = yield* db.select().from(rooms);
    expect(room.game).toBe("World of Warcraft");
    expect(calls.filter((c) => c.method === "PATCH" && c.path.startsWith("/guilds/guild/members/")).map((c) => c.body.channel_id)).toEqual([room.channel_id, room.channel_id]);
    expect(yield* prompt()).toMatchObject({ state: "picked", by: "a", game: "World of Warcraft" });
    // b tapped R.E.P.O. a moment too late
    expect(yield* sp.answer(id, "b", "g", "R.E.P.O.")).toBe("<@a> already picked **World of Warcraft** 🙂");
    expect(yield* db.select().from(rooms)).toHaveLength(1);
    // they've moved: the gathering is over
    yield* at(t0 + 40, { a: room.channel_id, b: room.channel_id });
    expect(yield* prompt()).toBeUndefined();
  }).pipe(h.provide),
);

it.effect("two taps at the same moment open one room", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    h.race("two taps on the Lobby question at once; whichever claims it opens the room", { mask: { lobby_prompts: ["id", "message_id", "by", "game"], rooms: ["channel_id", "created_by", "game"] }, bodies: false });
    yield* at(yield* now, { a: "lobby", b: "lobby" });
    yield* at((yield* now) + 30);
    const id = (yield* prompt()).id;
    const r = yield* Effect.all([sp.answer(id, "a", "g", "World of Warcraft"), sp.answer(id, "b", "g", "R.E.P.O.")], { concurrency: "unbounded" });
    expect(r.filter((x) => typeof x === "string" && x.includes("already picked"))).toHaveLength(1);
    expect(yield* db.select().from(rooms)).toHaveLength(1);
  }).pipe(h.provide),
);

it.effect("a room that won't open gives the question back", () =>
  Effect.gen(function* () {
    yield* at(yield* now, { a: "lobby", b: "lobby" });
    yield* at((yield* now) + 30);
    const id = (yield* prompt()).id;
    h.override = (c) => (c.method === "POST" && c.path === "/guilds/guild/channels" ? json({ message: "boom" }, 400) : undefined);
    expect(yield* sp.answer(id, "a", "g", "World of Warcraft")).toContain("Couldn't open the room");
    expect((yield* prompt()).state).toBe("open");
  }).pipe(h.provide),
);

it.effect("“Just hanging out” clears the question and keeps the Lobby quiet until the gathering breaks up", () =>
  Effect.gen(function* () {
    const t0 = yield* now;
    yield* at(t0, { a: "lobby", b: "lobby" });
    yield* at(t0 + 30);
    yield* tap(`lob:${(yield* prompt()).id}:chill`, "b");
    yield* waitFor(Effect.gen(function* () { expect((yield* prompt()).state).toBe("dismissed"); }));
    expect(calls.some((c) => c.method === "DELETE" && c.path.startsWith("/channels/lobby/messages/"))).toBe(true);
    yield* at(t0 + 600);
    yield* at(t0 + 1200, { c: "lobby" });
    expect(posted("lobby")).toHaveLength(1);
    // later: everyone leaves, then two come back → a new gathering, a new question
    yield* at(t0 + 1300, { a: null, b: null, c: null });
    expect(yield* prompt()).toBeUndefined();
    yield* at(t0 + 2000, { a: "lobby", b: "lobby" });
    yield* at(t0 + 2030);
    expect(posted("lobby")).toHaveLength(2);
  }).pipe(h.provide),
);

it.effect("“Other…” opens the full room picker", () =>
  Effect.gen(function* () {
    yield* at(yield* now, { a: "lobby", b: "lobby" });
    yield* at((yield* now) + 30);
    const r: any = yield* tap(`lob:${(yield* prompt()).id}:other`, "a");
    expect(JSON.stringify(r)).toContain("room:open");
    expect(yield* tap(`lob:${(yield* prompt()).id}:other`, "stranger")).toMatchObject({ data: { content: expect.stringContaining("trio") } });
  }).pipe(h.provide),
);

it.effect("an unanswered question goes after 10 minutes and isn't asked again that gathering", () =>
  Effect.gen(function* () {
    const t0 = yield* now;
    yield* at(t0, { a: "lobby", b: "lobby" });
    expect(yield* at(t0 + 30)).toBe(t0 + 30 + spontaneous.PROMPT_TTL);
    // the minute job does it even without a voice change
    yield* h.setTime((t0 + 30 + spontaneous.PROMPT_TTL) * 1000);
    expect(yield* sp.minute()).toMatchObject({ expired: expect.any(Number) });
    expect((yield* prompt()).state).toBe("expired");
    expect(calls.filter((c) => c.method === "DELETE" && c.path.startsWith("/channels/lobby/messages/"))).toHaveLength(1);
    yield* at(t0 + 2000);
    expect(posted("lobby")).toHaveLength(1);
  }).pipe(h.provide),
);

it.effect("a question that fails to post leaves the gathering quiet; the next gathering can ask", () =>
  Effect.gen(function* () {
    const t0 = yield* now;
    h.override = (c) => (c.method === "POST" && c.path === "/channels/lobby/messages" ? json({ message: "Missing Access" }, 403) : undefined);
    yield* at(t0, { a: "lobby", b: "lobby" });
    yield* at(t0 + 30);
    yield* at(t0 + 90);
    expect(posted("lobby")).toHaveLength(1);
    expect((yield* prompt()).state).toBe("failed");
    h.override = null;
    yield* at(t0 + 100, { b: null });
    yield* at(t0 + 200, { b: "lobby" });
    yield* at(t0 + 230);
    expect((yield* prompt()).state).toBe("open");
  }).pipe(h.provide),
);

it.effect("a planned night owns the Lobby: none while one starts within 15 min or is on", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const t0 = yield* now;
    // (plan 07: a night ahead gets its own card instead; in its last minute, not even that)
    yield* db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: t0 + 90, reminded: false });
    yield* at(t0, { a: "lobby", b: "lobby" });
    expect(yield* at(t0 + 60)).toBeNull();
    // it started, its room is open
    yield* db.update(gameNights).set({ start_at: t0 - 60, reminded: true }).where(eq(gameNights.day, DAY));
    yield* db.insert(rooms).values({ channel_id: "repo", game: "R.E.P.O.", day: DAY, created_at: t0 - 60 });
    expect(yield* at(t0 + 120)).toBeNull();
    // its room failed to open: the night is still on, so still no question
    yield* db.delete(rooms);
    expect(yield* at(t0 + 150)).toBeNull();
    expect(posted("lobby")).toEqual([]);
    // voting still in progress blocks nothing
    yield* db.delete(rooms);
    yield* db.update(gameNights).set({ stage: "time", start_at: null, reminded: false }).where(eq(gameNights.day, DAY));
    yield* at(t0 + 180);
    expect(posted("lobby")).toHaveLength(1);
  }).pipe(h.provide),
);

it.effect("someone already in a game room: no question (joiners get pulled there instead)", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db.insert(rooms).values({ channel_id: "wow", game: "World of Warcraft", created_at: (yield* now) - 600 });
    yield* at(yield* now, { c: "wow", a: "lobby", b: "lobby" });
    yield* at((yield* now) + 60);
    expect(posted("lobby")).toEqual([]);
  }).pipe(h.provide),
);

it.effect("no snapshot from the gateway: live.ts doesn't react at all", () =>
  Effect.gen(function* () {
    // react() is only ever called once presence is ready; this pins what live.ts relies on
    expect(yield* Presence.use((p) => p.isReady)).toBe(false);
  }).pipe(h.provide),
);

// ---------------------------------------------------------------- pulling people in

it.effect("joining the Lobby while one game room is in use pulls you in once, with a way back", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const t0 = yield* now;
    yield* db.insert(rooms).values({ channel_id: "wow", game: "World of Warcraft", created_at: t0 - 600 });
    yield* at(t0, { b: "wow" });
    yield* at(t0 + 10, { a: "lobby" }, { user: "a", from: null, to: "lobby" });
    const move = calls.find((c) => c.method === "PATCH" && c.path === "/guilds/guild/members/a")!;
    expect(move.body).toEqual({ channel_id: "wow" });
    const [noteMsg] = posted("wow");
    expect(noteMsg.body.content).toBe("👋 Pulled <@a> in from the Lobby: <@b> is here.");
    expect(noteMsg.body.flags).toBe(1 << 12);
    expect(JSON.stringify(noteMsg.body.components)).toContain("lob:back:a");
    // back in the Lobby on their own later: not pulled again
    calls.length = 0;
    yield* at(t0 + 60, { a: "lobby" }, { user: "a", from: null, to: "lobby" });
    expect(calls.some((c) => c.path === "/guilds/guild/members/a")).toBe(false);
    // the note removes itself after two minutes
    const [kept] = yield* db.select().from(fleeting);
    expect(kept).toMatchObject({ channel_id: "wow", delete_at: t0 + 10 + spontaneous.NOTE_TTL });
    yield* h.setTime((t0 + 9 + spontaneous.NOTE_TTL) * 1000);
    expect(yield* sp.minute()).not.toHaveProperty("notes");
    yield* h.setTime((t0 + 10 + spontaneous.NOTE_TTL) * 1000);
    expect(yield* sp.minute()).toMatchObject({ notes: 1 });
    expect(calls.some((c) => c.method === "DELETE" && c.path === `/channels/wow/messages/${kept.message_id}`)).toBe(true);
    expect(yield* db.select().from(fleeting)).toEqual([]);
  }).pipe(h.provide),
);

it.effect("no pull when you came out of that room, when two rooms are in use, or during a planned night", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const t0 = yield* now;
    yield* db.insert(rooms).values([
      { channel_id: "wow", game: "World of Warcraft", created_at: t0 - 600 },
      { channel_id: "repo", game: "R.E.P.O.", created_at: t0 - 600 },
    ]);
    yield* at(t0, { b: "wow", a: "wow" });
    yield* at(t0 + 10, { a: "lobby" }, { user: "a", from: "wow", to: "lobby" });
    yield* at(t0 + 20, { c: "repo" });
    yield* at(t0 + 30, { a: null });
    yield* at(t0 + 40, { a: "lobby" }, { user: "a", from: null, to: "lobby" });
    expect(calls.some((c) => c.method === "PATCH" && c.path.startsWith("/guilds/guild/members/"))).toBe(false);
  }).pipe(h.provide),
);

it.effect("↩ Back to the Lobby moves them back and keeps the Lobby quiet", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const t0 = yield* now;
    yield* db.insert(rooms).values({ channel_id: "wow", game: "World of Warcraft", created_at: t0 - 600 });
    yield* at(t0, { a: "wow", b: "wow" });
    yield* db.insert(fleeting).values({ message_id: "n1", channel_id: "wow", delete_at: t0 + 120 });
    expect(yield* sp.goBack("wow", ["a", "b"], "n1", t0)).toBeNull();
    expect(calls.filter((c) => c.method === "PATCH" && c.path.startsWith("/guilds/guild/members/")).map((c) => c.body)).toEqual([{ channel_id: "lobby" }, { channel_id: "lobby" }]);
    expect(calls.some((c) => c.method === "DELETE" && c.path === "/channels/wow/messages/n1")).toBe(true);
    // they trickle into the Lobby one by one: no question for this gathering
    yield* at(t0 + 2, { a: "lobby" });
    yield* at(t0 + 3, { b: "lobby" });
    yield* at(t0 + 60);
    expect(posted("lobby")).toEqual([]);
    expect((yield* prompt()).state).toBe("undone");
    // nobody left in the room to move back
    expect(yield* sp.goBack("wow", ["a"], undefined, t0 + 70)).toContain("Nobody to move back");
  }).pipe(h.provide),
);

it.effect("the ↩ button is the trio's, and goes through the interaction", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db.insert(rooms).values({ channel_id: "wow", game: "World of Warcraft", created_at: (yield* now) - 600 });
    yield* at(yield* now, { a: "wow" });
    expect(yield* tap("lob:back:a", "a", "wow")).toMatchObject({ type: 6 });
    yield* waitFor(Effect.sync(() => expect(calls.some((c) => c.method === "PATCH" && c.path === "/guilds/guild/members/a")).toBe(true)));
  }).pipe(h.provide),
);

// ---------------------------------------------------------------- sessions

it.effect("an unplanned session: quiet line at 2 min, a game night at 10, wrapped up 15 min after it drops below two", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const t0 = yield* now;
    yield* db.insert(rooms).values({ channel_id: "wow", game: "World of Warcraft", created_at: t0 - 86400, archived_at: null });
    yield* at(t0, { a: "wow" });
    expect(yield* session()).toBeUndefined(); // one person isn't a session
    yield* at(t0 + 10, { b: "wow" });
    expect(yield* session()).toMatchObject({ day: DAY, started_at: t0 + 10, who: ["a", "b"] });
    yield* at(t0 + 60);
    expect(posted("gn")).toEqual([]);
    yield* at(t0 + 130);
    const [line] = posted("gn");
    expect(line.body).toMatchObject({ content: "🎮 <@a> and <@b> are in **World of Warcraft** → <#wow>", flags: 1 << 12, allowed_mentions: { parse: [] } });
    expect(yield* plays("World of Warcraft")).toBe(3);
    yield* at(t0 + 10 + 600);
    expect(yield* session()).toMatchObject({ counted: true });
    expect(yield* plays("World of Warcraft")).toBe(4);
    // the third joins: the line follows
    yield* at(t0 + 700, { c: "wow" });
    expect(calls.filter((c) => c.method === "PATCH" && c.path.startsWith("/channels/gn/messages/")).at(-1)!.body.content).toBe(
      "🎮 <@a>, <@b> and <@c> are in **World of Warcraft** → <#wow>",
    );
    // down to one at +2810 (2800 s together), and nobody back for 15 min
    yield* at(t0 + 2810, { a: null, b: null });
    yield* h.setTime((t0 + 2810 + spontaneous.END_GRACE) * 1000);
    expect(yield* sp.minute()).toMatchObject({ finished: ["World of Warcraft"] });
    expect(calls.filter((c) => c.method === "PATCH" && c.path.startsWith("/channels/gn/messages/")).at(-1)!.body.content).toBe(
      "🎮 <@a>, <@b> and <@c> played **World of Warcraft** for 47 min",
    );
    expect(yield* session()).toMatchObject({ finished: true, counted: true, together_secs: 2800 });
    expect(yield* plays("World of Warcraft")).toBe(4); // counted once
    // and the stats know
    const s = yield* Activity.use((a) => a.crunch(t0 - 3600, t0 + 7200));
    expect(s.nights).toMatchObject({ played: 1, unplanned: 1 });
    expect(s.nights.games.get("World of Warcraft")).toBe(1);
    expect((yield* Activity.use((a) => a.statsBody("Week", s))).join("\n")).toContain("🎉 1 game night played (1 unplanned)");
  }).pipe(h.provide),
);

it.effect("a short session doesn't count, and its line goes", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const t0 = yield* now;
    yield* db.insert(rooms).values({ channel_id: "wow", game: "World of Warcraft", created_at: t0 });
    yield* at(t0, { a: "wow", b: "wow" });
    yield* at(t0 + 180);
    expect(posted("gn")).toHaveLength(1);
    yield* at(t0 + 300, { b: null });
    yield* h.setTime((t0 + 300 + spontaneous.END_GRACE) * 1000);
    yield* sp.minute();
    expect(calls.some((c) => c.method === "DELETE" && c.path.startsWith("/channels/gn/messages/"))).toBe(true);
    expect(yield* session()).toMatchObject({ counted: false, finished: true, message_id: null });
    expect(yield* plays("World of Warcraft")).toBe(3);
  }).pipe(h.provide),
);

it.effect("all three of us there: no line (nobody's missing), still a game night", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const t0 = yield* now;
    yield* db.insert(rooms).values({ channel_id: "wow", game: "World of Warcraft", created_at: t0 });
    yield* at(t0, { a: "wow", b: "wow", c: "wow" });
    yield* at(t0 + 700);
    expect(posted("gn")).toEqual([]);
    expect(yield* session()).toMatchObject({ counted: true });
  }).pipe(h.provide),
);

it.effect("a short break doesn't end it; back within 15 min is the same session", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const t0 = yield* now;
    yield* db.insert(rooms).values({ channel_id: "wow", game: "World of Warcraft", created_at: t0 });
    yield* at(t0, { a: "wow", b: "wow" });
    yield* at(t0 + 300, { b: null });
    yield* at(t0 + 600, { b: "wow" });
    yield* h.setTime((t0 + 1300) * 1000);
    yield* sp.minute();
    yield* at(t0 + 1300);
    expect(yield* session()).toMatchObject({ finished: false, together_secs: 300, counted: true }); // 300 + 700 live
  }).pipe(h.provide),
);

it.effect("the room vanishing mid-session wraps it up without an alert", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const t0 = yield* now;
    yield* db.insert(rooms).values({ channel_id: "wow", game: "World of Warcraft", created_at: t0 });
    yield* at(t0, { a: "wow", b: "wow" });
    yield* at(t0 + 900);
    yield* db.delete(rooms);
    const from = h.logs.length; // what's logged from here on
    expect(yield* sp.minute()).toMatchObject({ finished: ["World of Warcraft"] });
    expect(h.logs.slice(from).join(" ")).not.toContain("failed");
  }).pipe(h.provide),
);

it.effect("a failed line is tried again; a line swept away at 03:00 doesn't upset anything", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const t0 = yield* now;
    yield* db.insert(rooms).values({ channel_id: "wow", game: "World of Warcraft", created_at: t0 });
    h.override = (c) => (c.method === "POST" && c.path === "/channels/gn/messages" ? json({ message: "boom" }, 403) : undefined);
    yield* at(t0, { a: "wow", b: "wow" });
    yield* at(t0 + 130);
    expect((yield* session()).message_id).toBeNull();
    h.override = (c) => (c.method === "PATCH" && c.path.startsWith("/channels/gn/messages/") ? json({ message: "Unknown Message" }, 404) : undefined);
    yield* at(t0 + 190);
    expect((yield* session()).message_id).not.toBeNull();
    yield* at(t0 + 700, { b: null });
    yield* h.setTime((t0 + 700 + spontaneous.END_GRACE) * 1000);
    yield* sp.minute();
    expect(yield* session()).toMatchObject({ finished: true, counted: true });
  }).pipe(h.provide),
);

it.effect("the day's planned night starting with the same game takes the session over: one night, not two", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* h.setTime(Date.parse("2026-11-10T07:00:00Z")); // 09:00 in Vilnius: a long day ahead
    const t0 = yield* now;
    yield* db.insert(rooms).values({ channel_id: "wow", game: "World of Warcraft", created_at: t0 });
    yield* at(t0, { a: "wow", b: "wow" });
    yield* at(t0 + 700);
    expect(yield* plays("World of Warcraft")).toBe(4);
    // the night (planned for WoW, starting now) claims its start: plays +1, the session -1
    yield* db.insert(gameNights).values({ day: DAY, stage: "set", game: "World of Warcraft", start_at: t0 + 700, reminded: true });
    yield* db.update(games).set({ plays: 5 }).where(eq(games.name, "World of Warcraft"));
    yield* sp.absorb(DAY, "World of Warcraft");
    expect(yield* plays("World of Warcraft")).toBe(4);
    expect(yield* session()).toMatchObject({ absorbed: true, counted: false, finished: true });
    expect(calls.some((c) => c.method === "DELETE" && c.path.startsWith("/channels/gn/messages/"))).toBe(true);
    // the room's the night's now; hours later (the night's long over) that day it's still the one night
    yield* db.update(rooms).set({ day: DAY }).where(eq(rooms.channel_id, "wow"));
    yield* at(t0 + 8 * 3600);
    yield* at(t0 + 9 * 3600);
    expect(yield* db.select().from(sessions)).toHaveLength(1);
    expect(yield* session()).toMatchObject({ day: DAY, absorbed: true, counted: false });
    expect(yield* plays("World of Warcraft")).toBe(4);
  }).pipe(h.provide),
);

it.effect("after the day's planned night, playing that game again the same day isn't a second night", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const t0 = yield* now;
    yield* db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: t0 - 8 * 3600, reminded: true });
    yield* db.insert(rooms).values({ channel_id: "repo", game: "R.E.P.O.", created_at: t0 });
    yield* at(t0, { a: "repo", b: "repo" });
    yield* at(t0 + 700);
    expect(yield* session("R.E.P.O.")).toMatchObject({ counted: false });
    expect(yield* plays("R.E.P.O.")).toBe(5);
  }).pipe(h.provide),
);

it.effect("absorbing with nothing to absorb is a no-op", () =>
  Effect.gen(function* () {
    yield* sp.absorb(DAY, "World of Warcraft");
    expect(calls).toEqual([]);
  }).pipe(h.provide),
);

it.effect("words", () =>
  Effect.gen(function* () {
    expect(spontaneous.names(["a"])).toBe("<@a>");
    expect(spontaneous.minutes(30)).toBe("1 min");
    expect(spontaneous.minutes(3600 + 20 * 60)).toBe("1 h 20 min");
    expect(spontaneous.minutes(7200)).toBe("2 h");
  }).pipe(h.provide),
);

// ---------------------------------------------------------------- 🎮 game detection (PRESENCES=1)

const playing = (user: string, ...names: string[]) => Presence.use((p) => p.setActivities(user, names.map((name) => ({ type: 0, name }))));

it.effect("two in the Lobby playing the same game skip the question: straight to its room, with ↩", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const e = h.withConfig({ presences: true });
    const t0 = yield* now;
    yield* playing("a", "World of Warcraft");
    yield* playing("b", "world of warcraft"); // Discord's spelling may differ in case
    yield* at(t0, { a: "lobby", b: "lobby" });
    yield* h.setTime((t0 + 30) * 1000);
    expect(yield* e(sp.react(where, t0 + 30))).toBeNull();
    expect(posted("lobby")).toEqual([]);
    const [room] = yield* db.select().from(rooms);
    expect(room.game).toBe("World of Warcraft");
    expect(calls.filter((c) => c.method === "PATCH" && c.path.startsWith("/guilds/guild/members/"))).toHaveLength(2);
    const [n] = posted(room.channel_id);
    expect(n.body.content).toBe("🎮 Saw <@a> and <@b> in **World of Warcraft**, so I brought you over.");
    expect(JSON.stringify(n.body.components)).toContain("lob:back:a,b");
    expect((yield* prompt()).state).toBe("moved");
    // without game detection the same moment just asks
    yield* db.delete(lobbyPrompts);
    yield* db.delete(rooms);
    yield* sp.react(where, t0 + 31);
    expect(posted("lobby")).toHaveLength(1);
  }).pipe(h.provide),
);

it.effect("different games, or only one of us in a known game: ask, that game first", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const e = h.withConfig({ presences: true });
    const t0 = yield* now;
    yield* playing("a", "World of Warcraft");
    yield* playing("b", "R.E.P.O.");
    yield* at(t0, { a: "lobby", b: "lobby" });
    yield* e(sp.react(where, t0 + 30));
    expect(posted("lobby")).toHaveLength(1);
    // b stops; only a plays something we know → asked, with WoW first (R.E.P.O. is otherwise first)
    yield* db.delete(lobbyPrompts);
    yield* playing("b");
    yield* e(sp.react(where, t0 + 31));
    const q = posted("lobby")[1].body.components[0].components[1].components;
    expect(q.map((b: any) => b.label)).toEqual(["World of Warcraft", "R.E.P.O."]);
  }).pipe(h.provide),
);

it.effect("a name Discord uses that we don't know is learned with one tap, never silently", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const e = h.withConfig({ presences: true });
    const t0 = yield* now;
    yield* playing("a", "World of Warcraft: Forever", "Visual Studio Code");
    yield* playing("b", "World of Warcraft: Forever");
    yield* at(t0, { a: "lobby", b: "lobby" });
    yield* e(sp.react(where, t0 + 30));
    const p = yield* prompt();
    expect(p).toMatchObject({ state: "open", activity: "World of Warcraft: Forever" });
    const r = (yield* e(sp.answer(p.id, "a", "g", "World of Warcraft"))) as { content: string; components: any[] };
    expect(r.content).toBe("Discord says you were playing *World of Warcraft: Forever*. Is that **World of Warcraft**?");
    expect(JSON.stringify(r.components)).toContain(`lob:${p.id}:alias`);
    expect(yield* e(sp.answer(p.id, "a", "alias"))).toBe("👍 From now on, two of you in *World of Warcraft: Forever* go straight to **World of Warcraft**.");
    // next evening: straight there
    yield* at(t0 + 60, { a: null, b: null });
    yield* db.delete(rooms);
    yield* at(t0 + 3600, { a: "lobby", b: "lobby" });
    yield* h.setTime((t0 + 3630) * 1000);
    yield* e(sp.react(where, t0 + 3630));
    expect((yield* prompt()).state).toBe("moved");
    // a tap on the offer with nothing to learn is harmless
    expect(yield* e(sp.answer((yield* prompt()).id, "a", "alias"))).toBe("🤷");
  }).pipe(h.provide),
);

it.effect("two of us playing the same game before anyone's in voice: its room is ready under the Lobby, once a day", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const e = h.withConfig({ presences: true });
    const t0 = yield* now;
    yield* db.insert(rooms).values({ channel_id: "wow", game: "World of Warcraft", created_at: t0 - 86400, archived_at: t0 - 80000 });
    yield* playing("a", "World of Warcraft");
    yield* e(sp.react(where, t0));
    expect(calls).toEqual([]); // one person isn't enough
    yield* playing("b", "World of Warcraft");
    where.set("c", "lobby");
    yield* e(sp.react(where, t0 + 5));
    expect(calls.some((c) => c.method === "PATCH" && c.path === "/channels/wow" && c.body.parent_id === "voice")).toBe(true); // out of the archive
    expect(calls.some((c) => c.path.startsWith("/guilds/guild/members/"))).toBe(false); // nobody's moved, nothing's posted
    expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/messages"))).toBe(false);
    expect((yield* db.select().from(rooms))[0]).toMatchObject({ archived_at: null, last_seen: null });
    // (the third hanging out in the Lobby meanwhile changes nothing: the two playing aren't in voice)
    // nobody came: it archives itself after an hour like any never-joined room, and isn't brought back again today
    yield* db.update(rooms).set({ archived_at: t0 + 3600 });
    calls.length = 0;
    yield* e(sp.react(where, t0 + 3700));
    expect(calls).toEqual([]);
  }).pipe(h.provide),
);

it.effect("no ready room when one of the players is already in voice, a night is on its way, or detection is off", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const e = h.withConfig({ presences: true });
    const t0 = yield* now;
    yield* playing("a", "World of Warcraft");
    yield* playing("b", "World of Warcraft");
    yield* sp.react(where, t0); // detection off
    where.set("a", "lobby");
    yield* e(sp.react(where, t0)); // a's in the Lobby: that flow has them
    where.delete("a");
    yield* db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: t0 + 300, reminded: false });
    yield* e(sp.react(where, t0));
    expect(yield* db.select().from(rooms)).toEqual([]);
  }).pipe(h.provide),
);

it.effect("a room that can't be got ready gives the day's claim back", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const e = h.withConfig({ presences: true });
    yield* playing("a", "World of Warcraft");
    yield* playing("b", "World of Warcraft");
    h.override = (c) => (c.method === "POST" && c.path === "/guilds/guild/channels" ? json({ message: "boom" }, 400) : undefined);
    yield* e(sp.react(where, yield* now));
    expect(yield* db.select().from(readyRooms)).toEqual([]);
  }).pipe(h.provide),
);

it.effect("what someone's playing: only “Playing …”, and a listener hears only real changes", () =>
  Effect.gen(function* () {
    const presence = yield* Presence;
    const heard: string[][] = [];
    yield* presence.onPlaying((_u, names) => heard.push(names));
    yield* presence.setActivities("a", [
      { type: 0, name: "World of Warcraft" },
      { type: 2, name: "Spotify" },
      { type: 4, name: "Custom Status" },
    ]);
    yield* presence.setActivities("a", [{ type: 0, name: "World of Warcraft" }]);
    yield* presence.setActivities("a", []);
    expect(heard).toEqual([["World of Warcraft"], []]);
    expect(yield* presence.playing("a")).toEqual([]);
  }).pipe(h.provide),
);

/** The configuration read from these environment variables (as the old loadConfig did). */
const loadConfig = (e: Record<string, string>) => readConfig.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(e))));

it.effect("game detection is off unless PRESENCES=1", () =>
  Effect.gen(function* () {
    const base = { DATABASE_URL: "x", DISCORD_TOKEN: "x", DISCORD_PUBLIC_KEY: "x", DISCORD_APP_ID: "x", INGEST_SECRET: "x", ADMIN_SECRET: "x", GUILD_ID: "x", CHANNEL_ID: "x", GAME_CHANNEL_ID: "x", PLAYERS: "x", LOBBY_CHANNEL_ID: "x", VOICE_CATEGORY_ID: "x" };
    expect((yield* loadConfig(base)).presences).toBe(false);
    expect((yield* loadConfig({ ...base, PRESENCES: "1" })).presences).toBe(true);
  }).pipe(h.provide),
);

it.effect("an auto-move whose room won't open keeps the gathering quiet and says so", () =>
  Effect.gen(function* () {
    const e = h.withConfig({ presences: true });
    const t0 = yield* now;
    yield* playing("a", "World of Warcraft");
    yield* playing("b", "World of Warcraft");
    yield* at(t0, { a: "lobby", b: "lobby" });
    h.override = (c) => (c.method === "POST" && c.path === "/guilds/guild/channels" ? json({ message: "boom" }, 400) : undefined);
    const from = h.logs.length; // what's logged from here on
    yield* e(sp.react(where, t0 + 30));
    const said = h.logs.slice(from).join(" ");
    expect(said).toContain("moving the Lobby into the game we're playing failed");
    expect((yield* prompt()).state).toBe("failed");
    expect(posted("lobby")).toEqual([]);
  }).pipe(h.provide),
);

// ---------------------------------------------------------------- 🧠 Gemini places names Discord uses

/** Answer Gemini calls with `game` (or fail them), counting how many were made. */
function geminiSays(answer: string | null | "fail") {
  const asked: string[] = [];
  const prev = h.override;
  h.override = (c) => {
    if (c.path.includes("generativelanguage.googleapis.com")) {
      asked.push(JSON.stringify(c.body));
      if (answer === "fail") return json({ error: { message: "overloaded" } }, 503);
      return json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ game: answer }) }] } }] });
    }
    return prev?.(c);
  };
  return asked;
}

it.effect("a new name Discord uses is put to Gemini once; a yes becomes an alias, so two of us in it go straight to the room", () =>
  Effect.gen(function* () {
    const e = h.withConfig({ presences: true, geminiApiKey: "k" });
    const asked = geminiSays("World of Warcraft");
    expect(yield* e(sp.learn(["World of Warcraft: Forever"]))).toEqual([{ activity: "World of Warcraft: Forever", game: "World of Warcraft" }]);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("World of Warcraft: Forever");
    // known now: no second question
    expect(yield* e(sp.learn(["World of Warcraft: Forever", "World of Warcraft"]))).toEqual([]);
    expect(asked).toHaveLength(1);
    const t0 = yield* now;
    yield* playing("a", "World of Warcraft: Forever");
    yield* playing("b", "World of Warcraft: Forever");
    yield* at(t0, { a: "lobby", b: "lobby" });
    yield* e(sp.react(where, t0 + 30));
    expect((yield* prompt()).state).toBe("moved");
  }).pipe(h.provide),
);

it.effect("Gemini says it's not one of ours: no alias, and no “is that …?” offer for it either", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const e = h.withConfig({ presences: true, geminiApiKey: "k" });
    geminiSays(null);
    expect(yield* e(sp.learn(["Visual Studio Code"]))).toEqual([{ activity: "Visual Studio Code", game: null }]);
    expect(yield* db.select().from(gameAliases)).toEqual([]);
    yield* playing("a", "Visual Studio Code");
    yield* playing("b", "Visual Studio Code");
    yield* at(yield* now, { a: "lobby", b: "lobby" });
    yield* e(sp.react(where, (yield* now) + 30));
    expect((yield* prompt()).activity).toBeNull();
  }).pipe(h.provide),
);

it.effect("an answer that isn't on the list is treated as no; Gemini down means try again tomorrow, not every update", () =>
  Effect.gen(function* () {
    const e = h.withConfig({ presences: true, geminiApiKey: "k" });
    geminiSays("Some Game We Never Added");
    expect(yield* e(sp.learn(["Peak"]))).toEqual([{ activity: "Peak", game: null }]);
    const asked = geminiSays("fail");
    const t0 = yield* now;
    // (plan 07: tried again an hour later, not a day)
    expect(yield* e(sp.learn(["Lethal Company"], t0))).toEqual([]);
    expect(yield* e(sp.learn(["Lethal Company"], t0 + 1800))).toEqual([]);
    expect(asked).toHaveLength(1);
    expect(yield* e(sp.learn(["Lethal Company"], t0 + 3600))).toEqual([]);
    expect(asked).toHaveLength(2);
  }).pipe(h.provide),
);

it.effect("no key, no questions", () =>
  Effect.gen(function* () {
    const asked = geminiSays("World of Warcraft");
    expect(yield* sp.learn(["World of Warcraft: Forever"])).toEqual([]);
    expect(asked).toEqual([]);
  }).pipe(h.provide),
);

it.effect("Gemini's daily budget is kept in the database and stops asking once it's spent", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const e = h.withConfig({ geminiApiKey: "k" });
    const ask = (prompt: string, schema: object) => e(gemini.Gemini.use((g) => g.ask(prompt, schema, Schema.Unknown)));
    const asked = geminiSays("World of Warcraft");
    const schema = { type: "OBJECT", properties: { game: { type: "STRING", nullable: true } } };
    yield* db.insert(settings).values({ key: "gemini_budget", value: { day: (yield* LocalTime.use((t) => t.now)).day, used: gemini.DAILY - 1 } });
    expect(yield* ask("q", schema)).toEqual({ game: "World of Warcraft" });
    expect(yield* ask("q", schema)).toBeNull();
    expect(asked).toHaveLength(1);
    // a new day, a new budget
    yield* db.update(settings).set({ value: { day: "2000-01-01", used: 99 } });
    expect(yield* ask("q", schema)).toEqual({ game: "World of Warcraft" });
  }).pipe(h.provide),
);

it.effect("a pull-in another copy makes at the same moment moves you once", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const t0 = yield* now;
    yield* db.insert(rooms).values({ channel_id: "wow", game: "World of Warcraft", created_at: t0 - 600 });
    yield* at(t0, { b: "wow" });
    const change = { user: "a", from: null, to: "lobby" };
    // while our move is on its way, the other copy reacts to the same join (on this test's services and clock)
    const copy = Effect.runPromiseWith(yield* Effect.context<AppServices>());
    let other: Promise<unknown> | null = null;
    h.override = (c) => {
      if (c.method !== "PATCH" || c.path !== "/guilds/guild/members/a" || other) return undefined;
      other = copy(sp.react(where, t0 + 10, change));
      return other.then(() => json({})) as unknown as Response;
    };
    yield* at(t0 + 10, { a: "lobby" }, change);
    yield* Effect.promise(() => Promise.resolve(other));
    expect(calls.filter((c) => c.method === "PATCH" && c.path === "/guilds/guild/members/a")).toHaveLength(1);
    expect((yield* db.select().from(rooms))[0].pulled).toEqual(["a"]);
  }).pipe(h.provide),
);

it.effect("a session another copy already counted isn't counted again", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const t0 = yield* now;
    yield* db.insert(rooms).values({ channel_id: "wow", game: "World of Warcraft", created_at: t0 - 86400 });
    yield* db.insert(sessions).values({ day: DAY, game: "World of Warcraft", channel_id: "wow", started_at: t0 - 700, active_since: t0 - 700, who: ["a"] });
    // the other copy counts it between our look at the session and our count
    const sql = (q: string) => Effect.promise(() => h.t.pool.query(q));
    yield* sql(`CREATE OR REPLACE FUNCTION qa_counted() RETURNS trigger AS $$ BEGIN NEW.counted := true; RETURN NEW; END $$ LANGUAGE plpgsql`);
    yield* sql(`CREATE TRIGGER qa_counted BEFORE UPDATE ON sessions FOR EACH ROW WHEN (OLD.who IS DISTINCT FROM NEW.who) EXECUTE FUNCTION qa_counted()`);
    yield* at(t0, { a: "wow", b: "wow" });
    yield* sql("DROP TRIGGER qa_counted ON sessions");
    expect(yield* session()).toMatchObject({ counted: true, who: ["a", "b"] });
    expect(yield* plays("World of Warcraft")).toBe(3); // the other copy's count, not ours
  }).pipe(h.provide),
);

it.effect("a pull-in whose note won't post still pulls you in", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const t0 = yield* now;
    yield* db.insert(rooms).values({ channel_id: "wow", game: "World of Warcraft", created_at: t0 - 600 });
    yield* at(t0, { b: "wow" });
    h.override = (c) => (c.method === "POST" && c.path === "/channels/wow/messages" ? json({ message: "Missing Access", code: 50001 }, 403) : undefined);
    yield* at(t0 + 10, { a: "lobby" }, { user: "a", from: null, to: "lobby" });
    expect(calls.find((c) => c.method === "PATCH" && c.path === "/guilds/guild/members/a")!.body).toEqual({ channel_id: "wow" });
    expect((yield* db.select().from(rooms))[0].pulled).toEqual(["a"]);
    expect(yield* db.select().from(fleeting)).toEqual([]);
  }).pipe(h.provide),
);

it.effect("↩ moves back whoever it can when one move fails", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const t0 = yield* now;
    yield* db.insert(rooms).values({ channel_id: "wow", game: "World of Warcraft", created_at: t0 - 600 });
    yield* at(t0, { a: "wow", c: "wow" });
    h.override = (c) => (c.method === "PATCH" && c.path === "/guilds/guild/members/a" ? json({ message: "Missing Permissions", code: 50013 }, 403) : undefined);
    expect(yield* sp.goBack("wow", ["a", "c"], undefined, t0)).toBeNull();
    expect(calls.find((c) => c.method === "PATCH" && c.path === "/guilds/guild/members/c")!.body).toEqual({ channel_id: "lobby" });
    expect((yield* prompt()).state).toBe("undone");
  }).pipe(h.provide),
);
