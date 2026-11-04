// The paths the flow tests don't walk: HTTP routes, failure rollbacks, room upkeep, recaps, the
// one-hour re-nudge, /meme. Together with flows.test.ts every database query in src/ runs here.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as gn from "../src/gamenight.js";
import * as polls from "../src/polls.js";
import * as voice from "../src/voice.js";
import * as late from "../src/late.js";
import * as memes from "../src/memes.js";
import * as jobs from "../src/jobs.js";
import * as presence from "../src/presence.js";
import * as channels from "../src/channels.js";
import { build } from "../src/app.js";
import { interaction } from "../src/interactions.js";
import { gameNights, gameNightVotes, games, memes as memeTable, nightAttendance, recaps, roastBags, rooms, users, votes, polls as pollTable } from "../src/db/schema.js";
import { testDb, testEnv } from "./pg.js";

let t: Awaited<ReturnType<typeof testDb>>;
let env: ReturnType<typeof testEnv>;
type Call = { method: string; path: string; body: any };
let calls: Call[] = [];
let nextId = 5000;
/** Per-test overrides: return a Response to answer a call yourself. */
let override: ((c: Call) => Response | undefined) | null = null;
const realFetch = globalThis.fetch;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

beforeAll(async () => {
  t = await testDb();
  env = testEnv(t.db);
});
afterAll(() => t.close());
beforeEach(async () => {
  for (const tbl of [gameNightVotes, nightAttendance, rooms, gameNights, votes, memeTable, users, recaps, roastBags, pollTable]) await t.db.delete(tbl);
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
    if (path.includes("/voice-states/")) return json({ message: "Unknown Voice State", code: 10065 }, 404);
    if (path.endsWith("/channels") && c.method === "GET") return json([{ id: "lobby", type: 2, parent_id: "voice", position: 0, name: "Lobby" }]);
    return json({ id: String(nextId++) });
  }) as typeof fetch;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse("2026-11-06T15:00:00Z")); // Friday 17:00 in Vilnius
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
});

const DAY = "2026-11-06";
const now = () => Math.floor(Date.now() / 1000);
const night = () => gn.getNight(env, DAY);
const noop = () => {};

// ---------------------------------------------------------------- HTTP

test("HTTP: health, signatures, admin auth, ingest", async () => {
  // a real Ed25519 key pair, so a correctly signed request gets through and a forged one doesn't
  const keys = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as unknown as import("node:crypto").webcrypto.CryptoKeyPair;
  const pub = Buffer.from(await crypto.subtle.exportKey("raw", keys.publicKey)).toString("hex");
  const sign = async (body: string, ts: string) => Buffer.from(await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(ts + body))).toString("hex");
  const app = build({ ...env, DISCORD_PUBLIC_KEY: pub }, { leader: () => true, shuttingDown: () => false });
  const ping = JSON.stringify({ type: 1 });
  const ok = await app.inject({ method: "POST", url: "/interactions", payload: ping, headers: { "content-type": "application/json", "x-signature-ed25519": await sign(ping, "42"), "x-signature-timestamp": "42" } });
  expect([ok.statusCode, ok.json()]).toEqual([200, { type: 1 }]);
  const tampered = await app.inject({ method: "POST", url: "/interactions", payload: ping, headers: { "content-type": "application/json", "x-signature-ed25519": await sign(ping, "42"), "x-signature-timestamp": "43" } });
  expect(tampered.statusCode).toBe(401);
  const health = await app.inject({ method: "GET", url: "/health" });
  expect([health.statusCode, health.json().ok]).toEqual([200, true]);
  expect((await app.inject({ method: "POST", url: "/admin/register" })).statusCode).toBe(401);
  expect((await app.inject({ method: "POST", url: "/ingest", headers: { authorization: "Bearer a" } })).statusCode).toBe(401); // admin secret isn't the ingest secret
  const marked = await app.inject({ method: "POST", url: "/admin/mark-posted", headers: { authorization: "Bearer a" }, payload: { ids: ["t3_old"] } });
  expect(marked.json()).toEqual({ ok: true });
  const [m] = await t.db.select().from(memeTable).where(eq(memeTable.id, "t3_old"));
  expect(m.post_kind).toBe("request");
  const ing = await app.inject({ method: "POST", url: "/ingest", headers: { authorization: "Bearer i" }, payload: { memes: [{ id: "t3_x", title: "x", image: "i", link: "l", author: "a", published: "2026-11-05T00:00:00Z", rank: 1 }, { id: "t3_x", title: "dupe", image: "i", link: "l", author: "a", published: "2026-11-05T00:00:00Z", rank: 1 }] } });
  expect(ing.json().ingested).toBe(1);
  const down = build(env, { leader: () => false, shuttingDown: () => true });
  expect((await down.inject({ method: "GET", url: "/health" })).statusCode).toBe(503);
});

test("/meme summons a pool meme once, and says so when the well is dry", async () => {
  await memes.ingest(env, [{ id: "t3_m", title: "M", image: "i", link: "l", author: "a", published: "2026-11-03T08:00:00Z", rank: 3 }]);
  const i = { type: 2, token: "tok", data: { name: "meme" }, member: { user: { id: "a", username: "a" } } };
  const r = (await interaction(i, env)) as any;
  expect(r.data.components[0].components[0].content).toContain("Summoned by <@a>");
  const dry = (await interaction(i, env)) as any;
  expect(dry.data.content).toContain("well is dry");
});

// ---------------------------------------------------------------- game night paths

test("the one-hour re-nudge, a card deleted by hand, refreshing open cards, the plan picker", async () => {
  await gn.startNight(env, "a");
  vi.setSystemTime((now() + 3601) * 1000);
  const done = await gn.maintain(env);
  expect(done[`renudged ${DAY}`]).toEqual(["b", "c"]);
  override = (c) => (c.method === "PATCH" && c.path.includes("/messages/") ? json({ message: "Unknown Message" }, 404) : undefined);
  await gn.refreshOpen(env);
  expect((await night())!.message_id).toBeNull(); // forgotten, so it gets reposted
  override = null;
  expect(await gn.retryUnposted(env)).toEqual([DAY]);
  expect((await night())!.message_id).toBeTruthy();
  const picker = JSON.stringify(await gn.planPicker(env));
  expect(picker).toContain("Plan a game night");
  expect(picker).toContain("🗳️"); // today already has a poll
});

test("exact starts: a failed start ping releases the claim for a retry", async () => {
  const start = now() + 30;
  await t.db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: start, reminded: false });
  await t.db.insert(games).values({ name: "R.E.P.O.", emoji: "📦", added_at: "x" }).onConflictDoNothing();
  expect((await gn.upcomingStarts(env, start + 10)).map((n) => n.day)).toEqual([DAY]);
  vi.setSystemTime(start * 1000);
  override = (c) => (c.method === "POST" && c.path.endsWith("/messages") ? json({ message: "boom" }, 500) : undefined);
  expect(await gn.maintain(env)).not.toHaveProperty("reminded");
  expect((await night())!.reminded).toBe(false);
  override = null;
  expect(await gn.maintain(env)).toHaveProperty("reminded", DAY);
});

test("a roast that fails to post is retried", async () => {
  await gn.startNight(env, "a");
  override = (c) => (c.method === "POST" && c.path.endsWith("/messages") && c.body?.content?.startsWith("🔥") ? json({ message: "boom" }, 500) : undefined);
  vi.setSystemTime(Date.parse("2026-11-06T18:00:00Z"));
  await gn.maintain(env).catch(noop);
  expect((await night())!.roasted_at).toBeNull();
  override = null;
  expect(await gn.dueRoasts(env)).toEqual([DAY]);
});

// ---------------------------------------------------------------- latecomers

test("late slips: a failed post releases the claim; the slip renders", async () => {
  const start = now() - 700;
  await t.db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: start, reminded: true });
  await t.db.insert(rooms).values({ channel_id: "room1", game: "R.E.P.O.", day: DAY, created_at: start });
  override = (c) => (c.method === "POST" && c.path.endsWith("/messages") ? json({ message: "boom" }, 500) : undefined);
  expect(await late.watch(env)).toEqual({});
  expect(await t.db.select().from(nightAttendance)).toEqual([]);
  override = null;
  expect((await late.watch(env)).slipped).toEqual(["a", "b", "c"]);
  const slip = JSON.stringify(await late.render(env, DAY, "a"));
  expect(slip).toContain("Running late?");
  expect(slip).toContain("<#room1>");
});

// ---------------------------------------------------------------- memes

test("daily post: a failed post gives the meme back to the pool", async () => {
  vi.setSystemTime(Date.parse("2026-11-06T11:00:00Z"));
  await memes.ingest(env, [{ id: "t3_d", title: "D", image: "i", link: "l", author: "a", published: "2026-11-05T08:00:00Z", rank: 1 }]);
  override = (c) => (c.method === "POST" && c.path.endsWith("/messages") ? json({ message: "boom" }, 500) : undefined);
  await expect(jobs.postDaily(env)).rejects.toThrow();
  expect((await memes.getMeme(env, "t3_d"))!.post_kind).toBeNull();
  override = null;
  expect(await jobs.postDaily(env)).toMatchObject({ posted: "t3_d" });
});

test("Meme of the Week: top voter and longest streak, posted once", async () => {
  await memes.ingest(env, [{ id: "t3_w", title: "W", image: "i", link: "l", author: "a", published: "2026-11-05T08:00:00Z", rank: 1 }]);
  await memes.claim(env, "t3_w", "daily", { day: "2026-11-05" }); // posted Friday
  await memes.castVote(env, "t3_w", "a", "fire");
  vi.setSystemTime(Date.parse("2026-11-07T12:00:00Z"));
  await memes.bumpStreak(env, "a", "A");
  vi.setSystemTime(Date.parse("2026-11-08T18:05:00Z")); // Sunday 18:05 UTC
  expect(await jobs.weeklyRecap(env)).toEqual({ posted: "week:2026-11-08" });
  const post = calls.find((c) => c.method === "POST" && JSON.stringify(c.body).includes("Meme of the Week"))!;
  expect(JSON.stringify(post.body)).toContain("Most votes: <@a> (1)");
  expect(await jobs.weeklyRecap(env)).toMatchObject({ skipped: "already posted" });
  expect(await memes.topVoter(env, "2026-11-01", "2026-11-09")).toEqual({ user_id: "a", n: 1 });
  expect(await memes.longestLiveStreak(env)).toEqual({ user_id: "a", streak: 1 }); // voted Saturday, still alive Sunday
});

test("polls remember their message", async () => {
  const id = await polls.createPoll(env, "a", "Q?", "");
  await polls.setMessage(env, id, "ch", "msg");
  const [p] = await t.db.select().from(pollTable).where(eq(pollTable.id, id));
  expect([p.channel_id, p.message_id, p.options]).toEqual(["ch", "msg", ["👍 Yes", "👎 No"]]);
});

// ---------------------------------------------------------------- rooms

test("rooms: a hand-deleted room is recreated; a failed creation leaves no placeholder", async () => {
  presence.snapshot([]);
  const first = await voice.openRoom(env, "R.E.P.O.", "📦", {});
  override = (c) => (c.method === "GET" && c.path === `/channels/${first.channelId}` ? json({ message: "Unknown Channel" }, 404) : undefined);
  const second = await voice.openRoom(env, "R.E.P.O.", "📦", {});
  expect(second.channelId).not.toBe(first.channelId);
  override = (c) => (c.method === "POST" && c.path.endsWith("/channels") ? json({ message: "boom" }, 500) : undefined);
  await expect(voice.openRoom(env, "Palworld", "🐑", {})).rejects.toThrow();
  expect((await t.db.select().from(rooms)).map((r) => r.game)).toEqual(["R.E.P.O."]);
});

test("rooms: busy keeps the event alive, empty wraps it up and ends the event", async () => {
  const t0 = now();
  await t.db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: t0 - 3600, reminded: true, event_id: "ev1", event_end: t0 + 300 });
  await t.db.insert(rooms).values({ channel_id: "r1", game: "R.E.P.O.", day: DAY, created_at: t0 - 3600, last_seen: t0 - 60 });
  await voice.checkRooms(env, new Set(["r1"]), t0);
  expect((await night())!.event_end).toBe(t0 + 1800); // pushed back
  expect(calls.some((c) => c.method === "PATCH" && c.path.endsWith("/scheduled-events/ev1") && c.body.scheduled_end_time)).toBe(true);
  const r = await voice.checkRooms(env, new Set(), t0 + 901);
  expect(r.archived).toEqual(["R.E.P.O."]);
  expect(calls.some((c) => c.method === "PATCH" && c.path.endsWith("/scheduled-events/ev1") && c.body.status === 3)).toBe(true);
});

test("room upkeep: stale placeholders, hand-deleted rooms, revivals, 3-day deletion", async () => {
  const t0 = now();
  await t.db.insert(rooms).values([
    { channel_id: "pending:old", game: "Old", created_at: t0 - 600 },
    { channel_id: "gone", game: "Gone", created_at: t0 },
    { channel_id: "busy", game: "Busy", created_at: t0 - 9999, archived_at: t0 - 100 },
    { channel_id: "stale", game: "Stale", created_at: t0 - 9 * 86400, archived_at: t0 - 4 * 86400 },
    { channel_id: "vanished", game: "Vanished", created_at: t0 - 9 * 86400, archived_at: t0 - 4 * 86400 },
  ]);
  const list = ["busy", "stale", "vanished"].map((id, i) => ({ id, type: 2, parent_id: "archive", position: i + 1, name: id }));
  override = (c) => {
    if (c.method === "GET" && c.path.endsWith("/channels")) return json([{ id: "lobby", type: 2, parent_id: "voice", position: 0, name: "Lobby" }, { id: "archive", type: 4, position: 9, name: "🗄️ Recent games" }, ...list]);
    if (c.method === "DELETE" && c.path === "/channels/vanished") return json({ message: "Unknown Channel" }, 404);
    return undefined;
  };
  presence.snapshot([{ user_id: "a", channel_id: "busy" }]);
  const done = await voice.maintainRooms(env);
  // (a 404 while deleting means it's already gone, which is what we wanted)
  expect(done).toMatchObject({ forgotten: ["Gone"], revived: ["Busy"], deleted: ["Stale", "Vanished"] });
  expect((await t.db.select().from(rooms)).map((r) => [r.channel_id, r.archived_at])).toEqual([["busy", null]]);
});

test("a tiebreak nobody finishes gets one nudge after an hour", async () => {
  await gn.startNight(env, "a");
  const pending: Promise<unknown>[] = [];
  const act = async (u: string, a: string, v?: string) => (await gn.act(env, DAY, u, a, v, (p) => pending.push(p)), await Promise.all(pending.splice(0)));
  await act("b", "yes");
  await act("c", "yes");
  await act("a", "game", "R.E.P.O.");
  await act("b", "game", "Phasmophobia");
  await act("c", "game", "Palworld");
  vi.setSystemTime((now() + 3601) * 1000);
  expect((await gn.maintain(env))[`tiebreak nudged ${DAY}`]).toEqual(["a", "b", "c"]);
  expect((await gn.maintain(env))[`tiebreak nudged ${DAY}`]).toBeUndefined();
});

test("rooms: another click finishing the same room between our look and our claim", async () => {
  // simulate the other click: the moment our placeholder goes in, its finished room appears
  await t.pool.query(`CREATE OR REPLACE FUNCTION qa_racer() RETURNS trigger AS $$
    BEGIN INSERT INTO rooms (channel_id, game, created_at) VALUES ('real-racer', 'Racer', NEW.created_at); RETURN NEW; END $$ LANGUAGE plpgsql`);
  await t.pool.query(`CREATE TRIGGER qa_racer AFTER INSERT ON rooms FOR EACH ROW WHEN (NEW.channel_id = 'pending:racer') EXECUTE FUNCTION qa_racer()`);
  presence.snapshot([]);
  const r = await voice.openRoom(env, "Racer", null, {});
  expect([r.channelId, r.reused]).toEqual(["real-racer", true]);
  expect((await t.db.select().from(rooms)).map((x) => x.channel_id)).toEqual(["real-racer"]); // our placeholder is gone
  expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/channels"))).toBe(false); // and we made no twin
  await t.pool.query("DROP TRIGGER qa_racer ON rooms");
});

test("room upkeep: reviving a room whose channel vanished just forgets it", async () => {
  await t.db.insert(rooms).values({ channel_id: "ghostroom", game: "Ghost", created_at: now() - 9999, archived_at: now() - 100 });
  override = (c) => {
    if (c.method === "GET" && c.path.endsWith("/channels")) return json([{ id: "ghostroom", type: 2, parent_id: "archive", position: 1, name: "x" }]);
    if (c.method === "PATCH" && c.path === "/channels/ghostroom") return json({ message: "Unknown Channel" }, 404);
    return undefined;
  };
  presence.snapshot([{ user_id: "a", channel_id: "ghostroom" }]);
  expect(await voice.maintainRooms(env)).toMatchObject({ forgotten: ["Ghost"] });
  expect(await t.db.select().from(rooms)).toEqual([]);
});

test("clicking the card opens your private copy; clicking your copy updates it in place", async () => {
  await gn.startNight(env, "a");
  const click = (flags: number) => ({ type: 3, token: "tok", data: { custom_id: `gn:${DAY}:yes`, component_type: 2 }, message: { flags }, member: { user: { id: "b", username: "b" } } });
  const fromCard = (await interaction(click(1 << 15), env)) as any;
  expect(fromCard.type).toBe(4); // a new message…
  expect(fromCard.data.flags & 64).toBe(64); // …only b sees
  const fromCopy = (await interaction(click((1 << 15) | 64), env)) as any;
  expect(fromCopy.type).toBe(7); // edits b's copy
});
