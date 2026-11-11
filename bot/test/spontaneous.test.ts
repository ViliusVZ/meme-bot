// 🎮 Spontaneous play against a real Postgres, Discord stubbed: the Lobby question, unplanned
// sessions (the quiet line, counting, wrapping up), pulling people in, and ↩ back to the Lobby.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as spontaneous from "../src/spontaneous.js";
import * as presence from "../src/presence.js";
import * as channels from "../src/channels.js";
import * as activity from "../src/activity.js";
import { interaction } from "../src/interactions.js";
import { fleeting, gameAliases, gameNights, games, lobbyPrompts, readyRooms, rooms, sessions, voiceSegments } from "../src/db/schema.js";
import { loadConfig } from "../src/env.js";
import { testDb, testEnv } from "./pg.js";

let t: Awaited<ReturnType<typeof testDb>>;
let env: ReturnType<typeof testEnv>;
type Call = { method: string; path: string; body: any };
let calls: Call[] = [];
let nextId = 9000;
let override: ((c: Call) => Response | undefined) | null = null;
const realFetch = globalThis.fetch;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

beforeAll(async () => {
  t = await testDb();
  env = testEnv(t.db);
});
afterAll(() => t.close());
beforeEach(async () => {
  for (const tbl of [lobbyPrompts, sessions, fleeting, voiceSegments, rooms, gameNights, games, gameAliases, readyRooms]) await t.db.delete(tbl);
  calls = [];
  override = null;
  presence._reset();
  channels._reset();
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const path = String(url).replace("https://discord.com/api/v10", "");
    const c = { method: init.method ?? "GET", path, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    const o = override?.(c);
    if (o) return o;
    if (path.endsWith("/channels") && c.method === "GET") return json([{ id: "lobby", type: 2, parent_id: "voice", position: 0, name: "Lobby" }]);
    return json({ id: String(nextId++) });
  }) as typeof fetch;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse("2026-11-10T19:00:00Z")); // Tuesday 21:00 in Vilnius
  await t.db.insert(games).values([
    { name: "World of Warcraft", emoji: "🐉", added_at: "x", plays: 3 },
    { name: "R.E.P.O.", emoji: "📦", added_at: "x", plays: 5 },
  ]);
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
});

const now = () => Math.floor(Date.now() / 1000);
const DAY = "2026-11-10";
let where = new Map<string, string | null>();
/** Put people somewhere (as the gateway would) at time `at`, and let the bot react like live.ts does. */
async function at(sec: number, moves: Record<string, string | null> = {}, change?: spontaneous.Change) {
  vi.setSystemTime(sec * 1000);
  for (const [u, ch] of Object.entries(moves)) where.set(u, ch);
  presence.snapshot([...where].filter(([, ch]) => ch).map(([user_id, channel_id]) => ({ user_id, channel_id })));
  await activity.track(env, where, sec);
  return spontaneous.react(env, where, sec, change);
}
const posted = (channel: string) => calls.filter((c) => c.method === "POST" && c.path === `/channels/${channel}/messages`);
const prompt = async () => (await t.db.select().from(lobbyPrompts).where(eq(lobbyPrompts.current, true)))[0];
const session = async (game = "World of Warcraft") => (await t.db.select().from(sessions).where(eq(sessions.game, game)))[0];
const plays = async (name: string) => (await t.db.select().from(games).where(eq(games.name, name)))[0].plays;
const tap = (custom_id: string, user = "a", channel_id = "lobby") =>
  interaction({ type: 3, token: "tok", channel_id, member: { user: { id: user, username: user } }, message: { id: "q1", flags: 0 }, data: { custom_id } }, env);
beforeEach(() => {
  where = new Map();
});

// ---------------------------------------------------------------- the Lobby question

test("two of us in the Lobby for 30 s get one silent question; a 29-second visit gets none", async () => {
  const t0 = now();
  expect(await at(t0, { a: "lobby" })).toBeNull(); // one person is just one person
  expect(await at(t0 + 5, { b: "lobby" })).toBe(t0 + 35); // look again when the 30 s are up
  await at(t0 + 34, { b: null }); // b leaves at 29 s
  expect(await at(t0 + 40, { b: "lobby" })).toBe(t0 + 70); // and back: the 30 s start over
  expect(posted("lobby")).toEqual([]);
  await at(t0 + 70);
  const [q] = posted("lobby");
  expect(q.body.flags & (1 << 12)).toBeTruthy(); // no sound, no badge
  expect(q.body.allowed_mentions).toEqual({ parse: [] });
  const ids = JSON.stringify(q.body.components);
  expect(ids).toContain("Playing something?");
  expect(ids).toContain(":g:R.E.P.O."); // the most played first, when nothing was played lately
  expect(ids).toContain(":chill");
  // the third joins, the clock ticks, a restart re-checks: still exactly one question
  await at(t0 + 80, { c: "lobby" });
  await at(t0 + 140);
  await at(t0 + 141);
  expect(posted("lobby")).toHaveLength(1);
  expect((await prompt()).state).toBe("open");
});

test("recent games come first on the question", async () => {
  await t.db.insert(rooms).values({ channel_id: "wow", game: "World of Warcraft", created_at: now() - 86400, archived_at: now() - 80000 });
  expect(await spontaneous.recentGames(env)).toEqual(["World of Warcraft", "R.E.P.O."]);
});

test("first tap wins: the room opens, the Lobby comes along, the question goes; a late tap hears who won", async () => {
  const t0 = now();
  await at(t0, { a: "lobby", b: "lobby" });
  await at(t0 + 30);
  const id = (await prompt()).id;
  calls = [];
  await tap(`lob:${id}:g:World of Warcraft`, "a");
  await vi.waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.path.startsWith("/channels/lobby/messages/"))).toBe(true));
  const [room] = await t.db.select().from(rooms);
  expect(room.game).toBe("World of Warcraft");
  expect(calls.filter((c) => c.method === "PATCH" && c.path.startsWith("/guilds/guild/members/")).map((c) => c.body.channel_id)).toEqual([room.channel_id, room.channel_id]);
  expect(await prompt()).toMatchObject({ state: "picked", by: "a", game: "World of Warcraft" });
  // b tapped R.E.P.O. a moment too late
  expect(await spontaneous.answer(env, id, "b", "g", "R.E.P.O.")).toBe("<@a> already picked **World of Warcraft** 🙂");
  expect(await t.db.select().from(rooms)).toHaveLength(1);
  // they've moved: the gathering is over
  await at(t0 + 40, { a: room.channel_id, b: room.channel_id });
  expect(await prompt()).toBeUndefined();
});

test("two taps at the same moment open one room", async () => {
  await at(now(), { a: "lobby", b: "lobby" });
  await at(now() + 30);
  const id = (await prompt()).id;
  const r = await Promise.all([spontaneous.answer(env, id, "a", "g", "World of Warcraft"), spontaneous.answer(env, id, "b", "g", "R.E.P.O.")]);
  expect(r.filter((x) => typeof x === "string" && x.includes("already picked"))).toHaveLength(1);
  expect(await t.db.select().from(rooms)).toHaveLength(1);
});

test("a room that won't open gives the question back", async () => {
  await at(now(), { a: "lobby", b: "lobby" });
  await at(now() + 30);
  const id = (await prompt()).id;
  override = (c) => (c.method === "POST" && c.path === "/guilds/guild/channels" ? json({ message: "boom" }, 400) : undefined);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  expect(await spontaneous.answer(env, id, "a", "g", "World of Warcraft")).toContain("Couldn't open the room");
  log.mockRestore();
  expect((await prompt()).state).toBe("open");
});

test("“Just hanging out” clears the question and keeps the Lobby quiet until the gathering breaks up", async () => {
  const t0 = now();
  await at(t0, { a: "lobby", b: "lobby" });
  await at(t0 + 30);
  await tap(`lob:${(await prompt()).id}:chill`, "b");
  await vi.waitFor(async () => expect((await prompt()).state).toBe("dismissed"));
  expect(calls.some((c) => c.method === "DELETE" && c.path.startsWith("/channels/lobby/messages/"))).toBe(true);
  await at(t0 + 600);
  await at(t0 + 1200, { c: "lobby" });
  expect(posted("lobby")).toHaveLength(1);
  // later: everyone leaves, then two come back → a new gathering, a new question
  await at(t0 + 1300, { a: null, b: null, c: null });
  expect(await prompt()).toBeUndefined();
  await at(t0 + 2000, { a: "lobby", b: "lobby" });
  await at(t0 + 2030);
  expect(posted("lobby")).toHaveLength(2);
});

test("“Other…” opens the full room picker", async () => {
  await at(now(), { a: "lobby", b: "lobby" });
  await at(now() + 30);
  const r: any = await tap(`lob:${(await prompt()).id}:other`, "a");
  expect(JSON.stringify(r)).toContain("room:open");
  expect(await tap(`lob:${(await prompt()).id}:other`, "stranger")).toMatchObject({ data: { content: expect.stringContaining("trio") } });
});

test("an unanswered question goes after 10 minutes and isn't asked again that gathering", async () => {
  const t0 = now();
  await at(t0, { a: "lobby", b: "lobby" });
  expect(await at(t0 + 30)).toBe(t0 + 30 + spontaneous.PROMPT_TTL);
  // the minute job does it even without a voice change
  vi.setSystemTime((t0 + 30 + spontaneous.PROMPT_TTL) * 1000);
  expect(await spontaneous.minute(env)).toMatchObject({ expired: expect.any(Number) });
  expect((await prompt()).state).toBe("expired");
  expect(calls.filter((c) => c.method === "DELETE" && c.path.startsWith("/channels/lobby/messages/"))).toHaveLength(1);
  await at(t0 + 2000);
  expect(posted("lobby")).toHaveLength(1);
});

test("a question that fails to post leaves the gathering quiet; the next gathering can ask", async () => {
  const t0 = now();
  override = (c) => (c.method === "POST" && c.path === "/channels/lobby/messages" ? json({ message: "Missing Access" }, 403) : undefined);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await at(t0, { a: "lobby", b: "lobby" });
  await at(t0 + 30);
  await at(t0 + 90);
  log.mockRestore();
  expect(posted("lobby")).toHaveLength(1);
  expect((await prompt()).state).toBe("failed");
  override = null;
  await at(t0 + 100, { b: null });
  await at(t0 + 200, { b: "lobby" });
  await at(t0 + 230);
  expect((await prompt()).state).toBe("open");
});

test("a planned night owns the Lobby: none while one starts within 15 min or is on", async () => {
  const t0 = now();
  await t.db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: t0 + 600, reminded: false });
  await at(t0, { a: "lobby", b: "lobby" });
  expect(await at(t0 + 60)).toBeNull();
  // it started, its room is open
  await t.db.update(gameNights).set({ start_at: t0 - 60, reminded: true }).where(eq(gameNights.day, DAY));
  await t.db.insert(rooms).values({ channel_id: "repo", game: "R.E.P.O.", day: DAY, created_at: t0 - 60 });
  expect(await at(t0 + 120)).toBeNull();
  // its room failed to open: the night is still on, so still no question
  await t.db.delete(rooms);
  expect(await at(t0 + 150)).toBeNull();
  expect(posted("lobby")).toEqual([]);
  // voting still in progress blocks nothing
  await t.db.delete(rooms);
  await t.db.update(gameNights).set({ stage: "time", start_at: null, reminded: false }).where(eq(gameNights.day, DAY));
  await at(t0 + 180);
  expect(posted("lobby")).toHaveLength(1);
});

test("someone already in a game room: no question (joiners get pulled there instead)", async () => {
  await t.db.insert(rooms).values({ channel_id: "wow", game: "World of Warcraft", created_at: now() - 600 });
  await at(now(), { c: "wow", a: "lobby", b: "lobby" });
  await at(now() + 60);
  expect(posted("lobby")).toEqual([]);
});

test("no snapshot from the gateway: live.ts doesn't react at all", async () => {
  // react() is only ever called once presence is ready; this pins what live.ts relies on
  expect(presence.isReady()).toBe(false);
});

// ---------------------------------------------------------------- pulling people in

test("joining the Lobby while one game room is in use pulls you in once, with a way back", async () => {
  const t0 = now();
  await t.db.insert(rooms).values({ channel_id: "wow", game: "World of Warcraft", created_at: t0 - 600 });
  await at(t0, { b: "wow" });
  await at(t0 + 10, { a: "lobby" }, { user: "a", from: null, to: "lobby" });
  const move = calls.find((c) => c.method === "PATCH" && c.path === "/guilds/guild/members/a")!;
  expect(move.body).toEqual({ channel_id: "wow" });
  const [noteMsg] = posted("wow");
  expect(noteMsg.body.content).toBe("👋 Pulled <@a> in from the Lobby: <@b> is here.");
  expect(noteMsg.body.flags).toBe(1 << 12);
  expect(JSON.stringify(noteMsg.body.components)).toContain("lob:back:a");
  // back in the Lobby on their own later: not pulled again
  calls = [];
  await at(t0 + 60, { a: "lobby" }, { user: "a", from: null, to: "lobby" });
  expect(calls.some((c) => c.path === "/guilds/guild/members/a")).toBe(false);
  // the note removes itself after two minutes
  const [kept] = await t.db.select().from(fleeting);
  expect(kept).toMatchObject({ channel_id: "wow", delete_at: t0 + 10 + spontaneous.NOTE_TTL });
  vi.setSystemTime((t0 + 9 + spontaneous.NOTE_TTL) * 1000);
  expect(await spontaneous.minute(env)).not.toHaveProperty("notes");
  vi.setSystemTime((t0 + 10 + spontaneous.NOTE_TTL) * 1000);
  expect(await spontaneous.minute(env)).toMatchObject({ notes: 1 });
  expect(calls.some((c) => c.method === "DELETE" && c.path === `/channels/wow/messages/${kept.message_id}`)).toBe(true);
  expect(await t.db.select().from(fleeting)).toEqual([]);
});

test("no pull when you came out of that room, when two rooms are in use, or during a planned night", async () => {
  const t0 = now();
  await t.db.insert(rooms).values([
    { channel_id: "wow", game: "World of Warcraft", created_at: t0 - 600 },
    { channel_id: "repo", game: "R.E.P.O.", created_at: t0 - 600 },
  ]);
  await at(t0, { b: "wow", a: "wow" });
  await at(t0 + 10, { a: "lobby" }, { user: "a", from: "wow", to: "lobby" });
  await at(t0 + 20, { c: "repo" });
  await at(t0 + 30, { a: null });
  await at(t0 + 40, { a: "lobby" }, { user: "a", from: null, to: "lobby" });
  expect(calls.some((c) => c.method === "PATCH" && c.path.startsWith("/guilds/guild/members/"))).toBe(false);
});

test("↩ Back to the Lobby moves them back and keeps the Lobby quiet", async () => {
  const t0 = now();
  await t.db.insert(rooms).values({ channel_id: "wow", game: "World of Warcraft", created_at: t0 - 600 });
  await at(t0, { a: "wow", b: "wow" });
  await t.db.insert(fleeting).values({ message_id: "n1", channel_id: "wow", delete_at: t0 + 120 });
  expect(await spontaneous.goBack(env, "wow", ["a", "b"], "n1", t0)).toBeNull();
  expect(calls.filter((c) => c.method === "PATCH" && c.path.startsWith("/guilds/guild/members/")).map((c) => c.body)).toEqual([{ channel_id: "lobby" }, { channel_id: "lobby" }]);
  expect(calls.some((c) => c.method === "DELETE" && c.path === "/channels/wow/messages/n1")).toBe(true);
  // they trickle into the Lobby one by one: no question for this gathering
  await at(t0 + 2, { a: "lobby" });
  await at(t0 + 3, { b: "lobby" });
  await at(t0 + 60);
  expect(posted("lobby")).toEqual([]);
  expect((await prompt()).state).toBe("undone");
  // nobody left in the room to move back
  expect(await spontaneous.goBack(env, "wow", ["a"], undefined, t0 + 70)).toContain("Nobody to move back");
});

test("the ↩ button is the trio's, and goes through the interaction", async () => {
  await t.db.insert(rooms).values({ channel_id: "wow", game: "World of Warcraft", created_at: now() - 600 });
  await at(now(), { a: "wow" });
  expect(await tap("lob:back:a", "a", "wow")).toMatchObject({ type: 6 });
  await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH" && c.path === "/guilds/guild/members/a")).toBe(true));
});

// ---------------------------------------------------------------- sessions

test("an unplanned session: quiet line at 2 min, a game night at 10, wrapped up 15 min after it drops below two", async () => {
  const t0 = now();
  await t.db.insert(rooms).values({ channel_id: "wow", game: "World of Warcraft", created_at: t0 - 86400, archived_at: null });
  await at(t0, { a: "wow" });
  expect(await session()).toBeUndefined(); // one person isn't a session
  await at(t0 + 10, { b: "wow" });
  expect(await session()).toMatchObject({ day: DAY, started_at: t0 + 10, who: ["a", "b"] });
  await at(t0 + 60);
  expect(posted("gn")).toEqual([]);
  await at(t0 + 130);
  const [line] = posted("gn");
  expect(line.body).toMatchObject({ content: "🎮 <@a> and <@b> are in **World of Warcraft** → <#wow>", flags: 1 << 12, allowed_mentions: { parse: [] } });
  expect(await plays("World of Warcraft")).toBe(3);
  await at(t0 + 10 + 600);
  expect(await session()).toMatchObject({ counted: true });
  expect(await plays("World of Warcraft")).toBe(4);
  // the third joins: the line follows
  await at(t0 + 700, { c: "wow" });
  expect(calls.filter((c) => c.method === "PATCH" && c.path.startsWith("/channels/gn/messages/")).at(-1)!.body.content).toBe(
    "🎮 <@a>, <@b> and <@c> are in **World of Warcraft** → <#wow>",
  );
  // down to one at +2810 (2800 s together), and nobody back for 15 min
  await at(t0 + 2810, { a: null, b: null });
  vi.setSystemTime((t0 + 2810 + spontaneous.END_GRACE) * 1000);
  expect(await spontaneous.minute(env)).toMatchObject({ finished: ["World of Warcraft"] });
  expect(calls.filter((c) => c.method === "PATCH" && c.path.startsWith("/channels/gn/messages/")).at(-1)!.body.content).toBe(
    "🎮 <@a>, <@b> and <@c> played **World of Warcraft** for 47 min",
  );
  expect(await session()).toMatchObject({ finished: true, counted: true, together_secs: 2800 });
  expect(await plays("World of Warcraft")).toBe(4); // counted once
  // and the stats know
  const s = await activity.crunch(env, t0 - 3600, t0 + 7200);
  expect(s.nights).toMatchObject({ played: 1, unplanned: 1 });
  expect(s.nights.games.get("World of Warcraft")).toBe(1);
  expect((await activity.statsBody(env, "Week", s)).join("\n")).toContain("🎉 1 game night played (1 unplanned)");
});

test("a short session doesn't count, and its line goes", async () => {
  const t0 = now();
  await t.db.insert(rooms).values({ channel_id: "wow", game: "World of Warcraft", created_at: t0 });
  await at(t0, { a: "wow", b: "wow" });
  await at(t0 + 180);
  expect(posted("gn")).toHaveLength(1);
  await at(t0 + 300, { b: null });
  vi.setSystemTime((t0 + 300 + spontaneous.END_GRACE) * 1000);
  await spontaneous.minute(env);
  expect(calls.some((c) => c.method === "DELETE" && c.path.startsWith("/channels/gn/messages/"))).toBe(true);
  expect(await session()).toMatchObject({ counted: false, finished: true, message_id: null });
  expect(await plays("World of Warcraft")).toBe(3);
});

test("all three of us there: no line (nobody's missing), still a game night", async () => {
  const t0 = now();
  await t.db.insert(rooms).values({ channel_id: "wow", game: "World of Warcraft", created_at: t0 });
  await at(t0, { a: "wow", b: "wow", c: "wow" });
  await at(t0 + 700);
  expect(posted("gn")).toEqual([]);
  expect(await session()).toMatchObject({ counted: true });
});

test("a short break doesn't end it; back within 15 min is the same session", async () => {
  const t0 = now();
  await t.db.insert(rooms).values({ channel_id: "wow", game: "World of Warcraft", created_at: t0 });
  await at(t0, { a: "wow", b: "wow" });
  await at(t0 + 300, { b: null });
  await at(t0 + 600, { b: "wow" });
  vi.setSystemTime((t0 + 1300) * 1000);
  await spontaneous.minute(env);
  await at(t0 + 1300);
  expect(await session()).toMatchObject({ finished: false, together_secs: 300, counted: true }); // 300 + 700 live
});

test("the room vanishing mid-session wraps it up without an alert", async () => {
  const t0 = now();
  await t.db.insert(rooms).values({ channel_id: "wow", game: "World of Warcraft", created_at: t0 });
  await at(t0, { a: "wow", b: "wow" });
  await at(t0 + 900);
  await t.db.delete(rooms);
  const log = vi.spyOn(console, "log");
  expect(await spontaneous.minute(env)).toMatchObject({ finished: ["World of Warcraft"] });
  expect(log.mock.calls.flat().join(" ")).not.toContain("failed");
  log.mockRestore();
});

test("a failed line is tried again; a line swept away at 03:00 doesn't upset anything", async () => {
  const t0 = now();
  await t.db.insert(rooms).values({ channel_id: "wow", game: "World of Warcraft", created_at: t0 });
  override = (c) => (c.method === "POST" && c.path === "/channels/gn/messages" ? json({ message: "boom" }, 403) : undefined);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await at(t0, { a: "wow", b: "wow" });
  await at(t0 + 130);
  expect((await session()).message_id).toBeNull();
  override = (c) => (c.method === "PATCH" && c.path.startsWith("/channels/gn/messages/") ? json({ message: "Unknown Message" }, 404) : undefined);
  await at(t0 + 190);
  expect((await session()).message_id).not.toBeNull();
  await at(t0 + 700, { b: null });
  vi.setSystemTime((t0 + 700 + spontaneous.END_GRACE) * 1000);
  await spontaneous.minute(env);
  log.mockRestore();
  expect(await session()).toMatchObject({ finished: true, counted: true });
});

test("the day's planned night starting with the same game takes the session over: one night, not two", async () => {
  vi.setSystemTime(Date.parse("2026-11-10T07:00:00Z")); // 09:00 in Vilnius: a long day ahead
  const t0 = now();
  await t.db.insert(rooms).values({ channel_id: "wow", game: "World of Warcraft", created_at: t0 });
  await at(t0, { a: "wow", b: "wow" });
  await at(t0 + 700);
  expect(await plays("World of Warcraft")).toBe(4);
  // the night (planned for WoW, starting now) claims its start: plays +1, the session -1
  await t.db.insert(gameNights).values({ day: DAY, stage: "set", game: "World of Warcraft", start_at: t0 + 700, reminded: true });
  await t.db.update(games).set({ plays: 5 }).where(eq(games.name, "World of Warcraft"));
  await spontaneous.absorb(env, DAY, "World of Warcraft");
  expect(await plays("World of Warcraft")).toBe(4);
  expect(await session()).toMatchObject({ absorbed: true, counted: false, finished: true });
  expect(calls.some((c) => c.method === "DELETE" && c.path.startsWith("/channels/gn/messages/"))).toBe(true);
  // the room's the night's now; hours later (the night's long over) that day it's still the one night
  await t.db.update(rooms).set({ day: DAY }).where(eq(rooms.channel_id, "wow"));
  await at(t0 + 8 * 3600);
  await at(t0 + 9 * 3600);
  expect(await t.db.select().from(sessions)).toHaveLength(1);
  expect(await session()).toMatchObject({ day: DAY, absorbed: true, counted: false });
  expect(await plays("World of Warcraft")).toBe(4);
});

test("after the day's planned night, playing that game again the same day isn't a second night", async () => {
  const t0 = now();
  await t.db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: t0 - 8 * 3600, reminded: true });
  await t.db.insert(rooms).values({ channel_id: "repo", game: "R.E.P.O.", created_at: t0 });
  await at(t0, { a: "repo", b: "repo" });
  await at(t0 + 700);
  expect(await session("R.E.P.O.")).toMatchObject({ counted: false });
  expect(await plays("R.E.P.O.")).toBe(5);
});

test("absorbing with nothing to absorb is a no-op", async () => {
  await spontaneous.absorb(env, DAY, "World of Warcraft");
  expect(calls).toEqual([]);
});

test("words", () => {
  expect(spontaneous.names(["a"])).toBe("<@a>");
  expect(spontaneous.minutes(30)).toBe("1 min");
  expect(spontaneous.minutes(3600 + 20 * 60)).toBe("1 h 20 min");
  expect(spontaneous.minutes(7200)).toBe("2 h");
});

// ---------------------------------------------------------------- 🎮 game detection (PRESENCES=1)

const playing = (user: string, ...names: string[]) => presence.setActivities(user, names.map((name) => ({ type: 0, name })));

test("two in the Lobby playing the same game skip the question: straight to its room, with ↩", async () => {
  const e = { ...env, PRESENCES: true };
  const t0 = now();
  playing("a", "World of Warcraft");
  playing("b", "world of warcraft"); // Discord's spelling may differ in case
  await at(t0, { a: "lobby", b: "lobby" });
  vi.setSystemTime((t0 + 30) * 1000);
  expect(await spontaneous.react(e, where, t0 + 30)).toBeNull();
  expect(posted("lobby")).toEqual([]);
  const [room] = await t.db.select().from(rooms);
  expect(room.game).toBe("World of Warcraft");
  expect(calls.filter((c) => c.method === "PATCH" && c.path.startsWith("/guilds/guild/members/"))).toHaveLength(2);
  const [n] = posted(room.channel_id);
  expect(n.body.content).toBe("🎮 Saw <@a> and <@b> in **World of Warcraft**, so I brought you over.");
  expect(JSON.stringify(n.body.components)).toContain("lob:back:a,b");
  expect((await prompt()).state).toBe("moved");
  // without game detection the same moment just asks
  await t.db.delete(lobbyPrompts);
  await t.db.delete(rooms);
  await spontaneous.react(env, where, t0 + 31);
  expect(posted("lobby")).toHaveLength(1);
});

test("different games, or only one of us in a known game: ask, that game first", async () => {
  const e = { ...env, PRESENCES: true };
  const t0 = now();
  playing("a", "World of Warcraft");
  playing("b", "R.E.P.O.");
  await at(t0, { a: "lobby", b: "lobby" });
  await spontaneous.react(e, where, t0 + 30);
  expect(posted("lobby")).toHaveLength(1);
  // b stops; only a plays something we know → asked, with WoW first (R.E.P.O. is otherwise first)
  await t.db.delete(lobbyPrompts);
  playing("b");
  await spontaneous.react(e, where, t0 + 31);
  const q = posted("lobby")[1].body.components[0].components[1].components;
  expect(q.map((b: any) => b.label)).toEqual(["World of Warcraft", "R.E.P.O."]);
});

test("a name Discord uses that we don't know is learned with one tap, never silently", async () => {
  const e = { ...env, PRESENCES: true };
  const t0 = now();
  playing("a", "World of Warcraft: Forever", "Visual Studio Code");
  playing("b", "World of Warcraft: Forever");
  await at(t0, { a: "lobby", b: "lobby" });
  await spontaneous.react(e, where, t0 + 30);
  const p = await prompt();
  expect(p).toMatchObject({ state: "open", activity: "World of Warcraft: Forever" });
  const r = (await spontaneous.answer(e, p.id, "a", "g", "World of Warcraft")) as { content: string; components: any[] };
  expect(r.content).toBe("Discord says you were playing *World of Warcraft: Forever*. Is that **World of Warcraft**?");
  expect(JSON.stringify(r.components)).toContain(`lob:${p.id}:alias`);
  expect(await spontaneous.answer(e, p.id, "a", "alias")).toBe("👍 From now on, two of you in *World of Warcraft: Forever* go straight to **World of Warcraft**.");
  // next evening: straight there
  await at(t0 + 60, { a: null, b: null });
  await t.db.delete(rooms);
  await at(t0 + 3600, { a: "lobby", b: "lobby" });
  vi.setSystemTime((t0 + 3630) * 1000);
  await spontaneous.react(e, where, t0 + 3630);
  expect((await prompt()).state).toBe("moved");
  // a tap on the offer with nothing to learn is harmless
  expect(await spontaneous.answer(e, (await prompt()).id, "a", "alias")).toBe("🤷");
});

test("two of us playing the same game before anyone's in voice: its room is ready under the Lobby, once a day", async () => {
  const e = { ...env, PRESENCES: true };
  const t0 = now();
  await t.db.insert(rooms).values({ channel_id: "wow", game: "World of Warcraft", created_at: t0 - 86400, archived_at: t0 - 80000 });
  playing("a", "World of Warcraft");
  await spontaneous.react(e, where, t0);
  expect(calls).toEqual([]); // one person isn't enough
  playing("b", "World of Warcraft");
  where.set("c", "lobby");
  await spontaneous.react(e, where, t0 + 5);
  expect(calls.some((c) => c.method === "PATCH" && c.path === "/channels/wow" && c.body.parent_id === "voice")).toBe(true); // out of the archive
  expect(calls.some((c) => c.path.startsWith("/guilds/guild/members/"))).toBe(false); // nobody's moved, nothing's posted
  expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/messages"))).toBe(false);
  expect((await t.db.select().from(rooms))[0]).toMatchObject({ archived_at: null, last_seen: null });
  // (the third hanging out in the Lobby meanwhile changes nothing: the two playing aren't in voice)
  // nobody came: it archives itself after an hour like any never-joined room, and isn't brought back again today
  await t.db.update(rooms).set({ archived_at: t0 + 3600 });
  calls = [];
  await spontaneous.react(e, where, t0 + 3700);
  expect(calls).toEqual([]);
});

test("no ready room when one of the players is already in voice, a night is on its way, or detection is off", async () => {
  const e = { ...env, PRESENCES: true };
  const t0 = now();
  playing("a", "World of Warcraft");
  playing("b", "World of Warcraft");
  await spontaneous.react(env, where, t0); // detection off
  where.set("a", "lobby");
  await spontaneous.react(e, where, t0); // a's in the Lobby: that flow has them
  where.delete("a");
  await t.db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: t0 + 300, reminded: false });
  await spontaneous.react(e, where, t0);
  expect(await t.db.select().from(rooms)).toEqual([]);
});

test("a room that can't be got ready gives the day's claim back", async () => {
  const e = { ...env, PRESENCES: true };
  playing("a", "World of Warcraft");
  playing("b", "World of Warcraft");
  override = (c) => (c.method === "POST" && c.path === "/guilds/guild/channels" ? json({ message: "boom" }, 400) : undefined);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await spontaneous.react(e, where, now());
  log.mockRestore();
  expect(await t.db.select().from(readyRooms)).toEqual([]);
});

test("what someone's playing: only “Playing …”, and a listener hears only real changes", () => {
  const heard: string[][] = [];
  presence.onPlaying((_u, names) => heard.push(names));
  presence.setActivities("a", [
    { type: 0, name: "World of Warcraft" },
    { type: 2, name: "Spotify" },
    { type: 4, name: "Custom Status" },
  ]);
  presence.setActivities("a", [{ type: 0, name: "World of Warcraft" }]);
  presence.setActivities("a", []);
  expect(heard).toEqual([["World of Warcraft"], []]);
  expect(presence.playing("a")).toEqual([]);
});

test("game detection is off unless PRESENCES=1", () => {
  const base = { DATABASE_URL: "x", DISCORD_TOKEN: "x", DISCORD_PUBLIC_KEY: "x", DISCORD_APP_ID: "x", INGEST_SECRET: "x", ADMIN_SECRET: "x", GUILD_ID: "x", CHANNEL_ID: "x", GAME_CHANNEL_ID: "x", PLAYERS: "x", LOBBY_CHANNEL_ID: "x", VOICE_CATEGORY_ID: "x" };
  expect(loadConfig(base).PRESENCES).toBe(false);
  expect(loadConfig({ ...base, PRESENCES: "1" }).PRESENCES).toBe(true);
});

test("an auto-move whose room won't open keeps the gathering quiet and says so", async () => {
  const e = { ...env, PRESENCES: true };
  const t0 = now();
  playing("a", "World of Warcraft");
  playing("b", "World of Warcraft");
  await at(t0, { a: "lobby", b: "lobby" });
  override = (c) => (c.method === "POST" && c.path === "/guilds/guild/channels" ? json({ message: "boom" }, 400) : undefined);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await spontaneous.react(e, where, t0 + 30);
  const said = log.mock.calls.flat().map(String).join(" ");
  log.mockRestore();
  expect(said).toContain("moving the Lobby into the game we're playing failed");
  expect((await prompt()).state).toBe("failed");
  expect(posted("lobby")).toEqual([]);
});
