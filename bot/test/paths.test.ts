// The paths the flow tests don't walk: HTTP routes, failure rollbacks, room upkeep, recaps, the
// one-hour re-nudge, /meme. Together with flows.test.ts every database query in src/ runs here.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as gn from "../src/gamenight.js";
import * as polls from "../src/polls.js";
import * as voice from "../src/voice.js";
import * as attendance from "../src/attendance.js";
import * as late from "../src/late.js";
import * as memes from "../src/memes.js";
import * as jobs from "../src/jobs.js";
import * as presence from "../src/presence.js";
import * as channels from "../src/channels.js";
import { build } from "../src/app.js";
import { interaction } from "../src/interactions.js";
import { gameNights, gameNightVotes, games, memes as memeTable, nightAttendance, recaps, roastBags, rooms, users, votes, polls as pollTable, pollVotes, panels } from "../src/db/schema.js";
import { harness, json, routes, type TestDb } from "./harness.js";
import type { Env } from "../src/env.js";

const h = harness({
  tables: [gameNightVotes, nightAttendance, rooms, gameNights, votes, memeTable, users, recaps, roastBags, pollTable, panels],
  discord: { firstId: 5000, routes: [routes.noVoiceState, routes.lobbyOnly] },
  clock: "2026-11-06T15:00:00Z", // Friday 17:00 in Vilnius
});
const calls = h.calls;
let t: TestDb;
let env: Env;
beforeAll(() => void ({ t, env } = h));
beforeEach(() => {
  presence._reset();
  channels._reset();
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
  h.override = (c) => (c.method === "PATCH" && c.path.includes("/messages/") ? json({ message: "Unknown Message" }, 404) : undefined);
  await gn.refreshOpen(env);
  expect((await night())!.message_id).toBeNull(); // forgotten, so it gets reposted
  h.override = null;
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
  h.override = (c) => (c.method === "POST" && c.path.endsWith("/messages") ? json({ message: "boom" }, 500) : undefined);
  expect(await gn.maintain(env)).not.toHaveProperty("reminded");
  expect((await night())!.reminded).toBe(false);
  h.override = null;
  expect(await gn.maintain(env)).toHaveProperty("reminded", DAY);
});

test("a roast that fails to post is retried", async () => {
  await gn.startNight(env, "a");
  h.override = (c) => (c.method === "POST" && c.path.endsWith("/messages") && c.body?.content?.startsWith("🔥") ? json({ message: "boom" }, 500) : undefined);
  vi.setSystemTime(Date.parse("2026-11-06T18:00:00Z"));
  await gn.maintain(env).catch(noop);
  expect((await night())!.roasted_at).toBeNull();
  h.override = null;
  expect(await gn.dueRoasts(env)).toEqual([DAY]);
});

// ---------------------------------------------------------------- latecomers

test("late slips: a failed post releases the claim; the slip renders", async () => {
  const start = now() - 700;
  await t.db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: start, reminded: true });
  await t.db.insert(rooms).values({ channel_id: "room1", game: "R.E.P.O.", day: DAY, created_at: start });
  h.override = (c) => (c.method === "POST" && c.path.endsWith("/messages") ? json({ message: "boom" }, 500) : undefined);
  expect(await late.watch(env)).toEqual({});
  expect(await t.db.select().from(nightAttendance)).toEqual([]);
  h.override = null;
  expect((await late.watch(env)).slipped).toEqual(["a", "b", "c"]);
  const slip = JSON.stringify(await late.render(env, DAY, "a"));
  expect(slip).toContain("Running late?");
  expect(slip).toContain("<#room1>");
});

// ---------------------------------------------------------------- memes

test("daily post: a failed post gives the meme back to the pool", async () => {
  vi.setSystemTime(Date.parse("2026-11-06T11:00:00Z"));
  await memes.ingest(env, [{ id: "t3_d", title: "D", image: "i", link: "l", author: "a", published: "2026-11-05T08:00:00Z", rank: 1 }]);
  h.override = (c) => (c.method === "POST" && c.path.endsWith("/messages") ? json({ message: "boom" }, 500) : undefined);
  await expect(jobs.postDaily(env)).rejects.toThrow();
  expect((await memes.getMeme(env, "t3_d"))!.post_kind).toBeNull();
  h.override = null;
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
  h.override = (c) => (c.method === "GET" && c.path === `/channels/${first.channelId}` ? json({ message: "Unknown Channel" }, 404) : undefined);
  const second = await voice.openRoom(env, "R.E.P.O.", "📦", {});
  expect(second.channelId).not.toBe(first.channelId);
  h.override = (c) => (c.method === "POST" && c.path.endsWith("/channels") ? json({ message: "boom" }, 500) : undefined);
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
  expect((await night())!.event_end).toBeNull(); // ended for good
  // back in the same room the next evening (it's revived): there's no event left to push back
  await t.db.update(rooms).set({ archived_at: null }).where(eq(rooms.channel_id, "r1"));
  calls.length = 0;
  await voice.checkRooms(env, new Set(["r1"]), t0 + 86400);
  expect(calls.some((c) => c.path.includes("/scheduled-events/"))).toBe(false);
});

test("rooms: an event ended by hand (or deleted) is let go quietly; other refusals still alert", async () => {
  const t0 = now();
  const finished = { message: "Invalid Form Body", code: 50035, errors: { scheduled_end_time: { _errors: [{ code: "GUILD_SCHEDULED_EVENT_SCHEDULE_INVALID_END_BY_STATUS", message: "Cannot update end time of finished event." }] } } };
  const log = vi.spyOn(console, "log").mockImplementation(noop);
  for (const [answer, status, alerted] of [
    [finished, 400, false],
    [{ message: "Unknown Guild Scheduled Event", code: 10070 }, 404, false],
    [{ message: "Missing Permissions", code: 50013 }, 403, true],
  ] as const) {
    await t.db.delete(rooms);
    await t.db.delete(gameNights);
    await t.db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: t0 - 3600, reminded: true, event_id: "ev1", event_end: t0 + 300 });
    await t.db.insert(rooms).values({ channel_id: "r1", game: "R.E.P.O.", day: DAY, created_at: t0 - 3600, last_seen: t0 - 60 });
    calls.length = 0;
    log.mockClear();
    h.override = (c) => (c.method === "PATCH" && c.path.endsWith("/scheduled-events/ev1") ? json(answer, status) : undefined);
    await voice.checkRooms(env, new Set(["r1"]), t0);
    await voice.checkRooms(env, new Set(["r1"]), t0 + 60);
    const said = log.mock.calls.flat().map(String).join(" ");
    expect(said.includes("extending the Discord event failed")).toBe(alerted);
    // a finished event is tried once and forgotten; a real failure keeps its end and tries again
    expect((await night())!.event_end).toBe(alerted ? t0 + 300 : null);
    expect(calls.filter((c) => c.path.endsWith("/scheduled-events/ev1"))).toHaveLength(alerted ? 2 : 1);
  }
  log.mockRestore();
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
  h.override = (c) => {
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
  h.override = (c) => {
    if (c.method === "GET" && c.path.endsWith("/channels")) return json([{ id: "ghostroom", type: 2, parent_id: "archive", position: 1, name: "x" }]);
    if (c.method === "PATCH" && c.path === "/channels/ghostroom") return json({ message: "Unknown Channel" }, 404);
    return undefined;
  };
  presence.snapshot([{ user_id: "a", channel_id: "ghostroom" }]);
  expect(await voice.maintainRooms(env)).toMatchObject({ forgotten: ["Ghost"] });
  expect(await t.db.select().from(rooms)).toEqual([]);
});

test("clicking the card opens your private copy; clicking your copy updates it in place", async () => {
  h.race("each tap starts its copy's tracking in the background, and the next tap comes before it has landed", { mask: { panels: ["message_id"] }, calls: false });
  await gn.startNight(env, "a");
  const click = (flags: number) => ({ type: 3, token: "tok", data: { custom_id: `gn:${DAY}:yes`, component_type: 2 }, message: { flags }, member: { user: { id: "b", username: "b" } } });
  const fromCard = (await interaction(click(1 << 15), env)) as any;
  expect(fromCard.type).toBe(4); // a new message…
  expect(fromCard.data.flags & 64).toBe(64); // …only b sees
  const fromCopy = (await interaction(click((1 << 15) | 64), env)) as any;
  expect(fromCopy.type).toBe(7); // edits b's copy
  // a refusal on your panel shows in the panel, not as one more message
  const late = { ...click((1 << 15) | 64), data: { custom_id: `gn:${DAY}:late:15`, component_type: 2 } };
  const refused = (await interaction(late, env)) as any;
  expect(refused.type).toBe(7);
  expect(JSON.stringify(refused.data)).toContain("⚠️ Nothing's locked in yet");
});

test("clicking the card opens your private copy; clicking your copy updates it in place (each tap done before the next)", async () => {
  await gn.startNight(env, "a");
  const click = (flags: number) => ({ type: 3, token: "tok", data: { custom_id: `gn:${DAY}:yes`, component_type: 2 }, message: { flags }, member: { user: { id: "b", username: "b" } } });
  const fromCard = (await interaction(click(1 << 15), env)) as any;
  await h.settle();
  expect(fromCard.type).toBe(4); // a new message…
  expect(fromCard.data.flags & 64).toBe(64); // …only b sees
  const fromCopy = (await interaction(click((1 << 15) | 64), env)) as any;
  await h.settle();
  expect(fromCopy.type).toBe(7); // edits b's copy
  // a refusal on your panel shows in the panel, not as one more message
  const late = { ...click((1 << 15) | 64), data: { custom_id: `gn:${DAY}:late:15`, component_type: 2 } };
  const refused = (await interaction(late, env)) as any;
  expect(refused.type).toBe(7);
  expect(JSON.stringify(refused.data)).toContain("⚠️ Nothing's locked in yet");
});

test("🧹 03:00 sweep: old bot messages go; pins, live cards, recaps and people's messages stay", async () => {
  const { snowflakeAt, nightly } = await import("../src/cleanup.js");
  vi.setSystemTime(Date.parse("2026-11-06T01:05:00Z")); // 03:05 Friday
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
    { id: snowflakeAt(Date.now() - 20 * 86400_000), author: { id: "bot" } }, // too old to bulk delete
  ];
  await t.db.insert(gameNights).values([
    { day: "2026-11-05", stage: "off", message_id: msgs[1].id, nudge_id: msgs[2].id },
    { day: "2026-11-07", stage: "ask", message_id: msgs[6].id },
  ]);
  h.override = (c) => {
    if (c.path === "/users/@me") return json({ id: "bot" });
    if (c.method === "GET" && c.path.startsWith("/channels/gn/messages")) return json(c.path.includes("before=") ? [] : msgs);
    return undefined;
  };
  expect(await nightly(env)).toEqual({ deleted: 3, kept: 1 });
  const bulk = calls.find((c) => c.path.endsWith("/bulk-delete"))!;
  expect(bulk.body.messages.sort()).toEqual([msgs[1].id, msgs[2].id].sort());
  expect(calls.some((c) => c.method === "DELETE" && c.path === `/channels/gn/messages/${msgs[7].id}`)).toBe(true);
  expect((await t.db.select().from(gameNights).where(eq(gameNights.day, "2026-11-05")))[0]).toMatchObject({ message_id: null, nudge_id: null });
  expect(await nightly(env)).toEqual({}); // once a day
});

test("a meme vote shows who voted what under the bar, without pinging", async () => {
  await memes.ingest(env, [{ id: "t3_v", title: "V", image: "i", link: "l", author: "a", published: "2026-11-05T08:00:00Z", rank: 1 }]);
  await memes.claim(env, "t3_v", "daily", { day: "2026-11-05" });
  await memes.castVote(env, "t3_v", "b", "fire");
  const click = { type: 3, token: "tok", data: { custom_id: "v:t3_v:lol", component_type: 2 }, member: { user: { id: "a", username: "a" } } };
  const r = (await interaction(click, env)) as any;
  const body = JSON.stringify(r.data);
  expect(body).toContain("🔥 <@b> · 😂 <@a>");
  expect(r.data.allowed_mentions).toEqual({ parse: [] });
});

test("😐 meme slackers: called out at 19:00, once a day, at most every 3 days each", async () => {
  const { evening, slackers } = await import("../src/memeshame.js");
  // five daily memes, posted on the five days before Friday
  for (let i = 0; i < 5; i++) {
    const day = `2026-11-0${5 - i}`;
    await t.db.insert(memeTable).values({ id: `t3_d${i}`, title: "d", image: "i", link: "l", author: "u", published: `${day}T08:00:00Z`, ingested_at: "x", post_kind: "daily", day, posted_at: `${day}T10:00:00.000Z`, channel_id: "memes", message_id: `msg${i}` });
  }
  for (let i = 0; i < 5; i++) await memes.castVote(env, `t3_d${i}`, "a", "lol"); // a votes on everything
  await memes.castVote(env, "t3_d4", "b", "fire"); // b only on the oldest
  await memes.castVote(env, "t3_d0", "c", "fire"); // c voted on the latest only
  await memes.castVote(env, "t3_d1", "c", "fire"); // …and the one before: 2 of 5, not 3 in a row
  vi.setSystemTime(Date.parse("2026-11-06T16:30:00Z")); // 18:30: too early
  expect(await evening(env)).toEqual({});
  vi.setSystemTime(Date.parse("2026-11-06T17:05:00Z")); // 19:05
  expect((await slackers(env)).who.map((s) => s.user)).toEqual(["b"]);
  expect(await evening(env)).toEqual({ called: ["b"] });
  const post = calls.find((c) => c.method === "POST" && c.path === "/channels/memes/messages")!;
  expect(post.body.content).toMatch(/^😐 .*<@b>/);
  expect(post.body.content).not.toMatch(/\{\w+\}/);
  expect(post.body.allowed_mentions).toEqual({ users: ["b"] });
  expect(await evening(env)).toEqual({}); // once a day
  vi.setSystemTime(Date.parse("2026-11-07T17:05:00Z")); // next evening: b's still slacking, but cooling down
  expect(await evening(env)).toEqual({});
  vi.setSystemTime(Date.parse("2026-11-09T17:05:00Z")); // 3 days later: fair game again
  expect(await evening(env)).toEqual({ called: ["b"] });
});

test("admin: redraw every posted meme with its voters", async () => {
  await memes.ingest(env, [{ id: "t3_r", title: "R", image: "i", link: "l", author: "a", published: "2026-11-05T08:00:00Z", rank: 1 }]);
  await memes.claim(env, "t3_r", "daily", { day: "2026-11-05" });
  await memes.setMessage(env, "t3_r", "memes", "m1");
  await memes.castVote(env, "t3_r", "c", "dead");
  const app = build(env, { leader: () => true, shuttingDown: () => false });
  const r = await app.inject({ method: "POST", url: "/admin/refresh-memes", headers: { authorization: "Bearer a" } });
  expect(r.json()).toEqual({ updated: 1, failed: [] });
  expect(JSON.stringify(calls.find((c) => c.method === "PATCH" && c.path === "/channels/memes/messages/m1")!.body)).toContain("💀 <@c>");
});

test("rooms: opening a room brings the Lobby along unless told not to", async () => {
  presence.snapshot([{ user_id: "a", channel_id: "lobby" }, { user_id: "c", channel_id: "lobby" }]);
  const r = await voice.openRoom(env, "R.E.P.O.", "📦", {});
  expect(r.moved).toEqual(["a", "c"]);
  const moves = () => calls.filter((c) => c.method === "PATCH" && c.path.startsWith("/guilds/guild/members/"));
  expect(moves().map((c) => [c.path.split("/").pop(), c.body.channel_id]).sort()).toEqual([["a", r.channelId], ["c", r.channelId]]);
  calls.length = 0;
  const again = await voice.openRoom(env, "R.E.P.O.", "📦", { move: false });
  expect([again.channelId, again.reused, again.moved]).toEqual([r.channelId, true, []]);
  expect(moves()).toEqual([]);
});

test("room upkeep: an archived room is deleted 3 days after it was archived, not a second sooner", async () => {
  const t0 = now();
  await t.db.insert(rooms).values([
    { channel_id: "young", game: "Young", created_at: t0 - 9 * 86400, archived_at: t0 - 3 * 86400 + 1 },
    { channel_id: "due", game: "Due", created_at: t0 - 9 * 86400, archived_at: t0 - 3 * 86400 },
  ]);
  const list = ["young", "due"].map((id, i) => ({ id, type: 2, parent_id: "archive", position: i + 1, name: id }));
  h.override = (c) => (c.method === "GET" && c.path.endsWith("/channels") ? json([{ id: "archive", type: 4, position: 9, name: "🗄️ Recent games" }, ...list]) : undefined);
  presence.snapshot([]);
  expect(await voice.maintainRooms(env)).toEqual({ deleted: ["Due"] });
  expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["/channels/due"]);
  expect((await t.db.select().from(rooms)).map((r) => r.channel_id)).toEqual(["young"]);
});

test("rooms: a room Discord won't move to Recent games stays open, and the next check tries again", async () => {
  const t0 = now();
  await t.db.insert(rooms).values({ channel_id: "r1", game: "R.E.P.O.", created_at: t0 - 7200, last_seen: t0 - 3600 });
  h.override = (c) => (c.method === "PATCH" && c.path === "/channels/r1" ? json({ message: "Missing Permissions", code: 50013 }, 403) : undefined);
  const log = vi.spyOn(console, "log").mockImplementation(noop);
  expect((await voice.checkRooms(env, new Set(), t0)).archived).toEqual([]);
  expect((await t.db.select().from(rooms)).map((r) => [r.channel_id, r.archived_at])).toEqual([["r1", null]]);
  await voice.checkRooms(env, new Set(), t0 + 60);
  expect(calls.filter((c) => c.method === "PATCH" && c.path === "/channels/r1")).toHaveLength(2);
  log.mockRestore();
});

test("rooms: a new room Discord won't slot under the Lobby is still known, so the next tap makes no twin", async () => {
  presence.snapshot([]);
  h.override = (c) => (c.method === "PATCH" && c.path === "/guilds/guild/channels" ? json({ message: "Missing Permissions", code: 50013 }, 403) : undefined);
  await expect(voice.openRoom(env, "Palworld", "🐑", {})).rejects.toThrow(/403/);
  const [made] = await t.db.select().from(rooms);
  expect([made.game, made.channel_id.startsWith("pending:")]).toEqual(["Palworld", false]);
  h.override = null;
  const again = await voice.openRoom(env, "Palworld", "🐑", {});
  expect([again.channelId, again.reused]).toEqual([made.channel_id, true]);
  expect(calls.filter((c) => c.method === "POST" && c.path === "/guilds/guild/channels")).toHaveLength(1);
});

test("late: a voice lookup that fails isn't \"already here\"; the ETA goes on a slip", async () => {
  const t0 = now();
  await t.db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: t0 - 600, reminded: true, message_id: "card" });
  await t.db.insert(rooms).values({ channel_id: "r1", game: "R.E.P.O.", day: DAY, created_at: t0 - 900 });
  h.override = (c) => (c.path.includes("/voice-states/") ? json({ message: "Missing Access", code: 50001 }, 403) : undefined);
  expect(await attendance.declare(env, DAY, "b", 15)).toContain("Got it 🏃");
  expect(calls.filter((c) => c.method === "POST" && c.path === "/channels/gn/messages")).toHaveLength(1);
  expect((await attendance.etas(env, DAY)).b).toBe(t0 + 900);
});

test("late: a slip that won't update still takes the ETA", async () => {
  const t0 = now();
  await t.db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: t0 - 600, reminded: true, message_id: "card" });
  await t.db.insert(nightAttendance).values({ day: DAY, user_id: "b", state: "late", message_id: "slip-b" });
  h.override = (c) => (c.method === "PATCH" && c.path === "/channels/gn/messages/slip-b" ? json({ message: "Unknown Message", code: 10008 }, 404) : undefined);
  expect(await attendance.declare(env, DAY, "b", 5)).toContain("Got it 🏃");
  expect((await attendance.etas(env, DAY)).b).toBe(t0 + 300);
  expect(calls.filter((c) => c.method === "POST" && c.path === "/channels/gn/messages")).toEqual([]); // no second slip
});

test("a called-off night leaves the slips of people who made it alone", async () => {
  await t.db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: now() - 600, message_id: "card" });
  await t.db.insert(nightAttendance).values([
    { day: DAY, user_id: "a", state: "arrived", message_id: "slip-a", arrived_at: now() },
    { day: DAY, user_id: "b", state: "absent", message_id: "slip-b" },
    { day: DAY, user_id: "c", state: "eta", eta: now() + 600, message_id: "slip-c" },
  ]);
  await attendance.retireSlips(env, DAY);
  const edits = calls.filter((c) => c.method === "PATCH").map((c) => [c.path, JSON.stringify(c.body)] as const);
  expect(edits.map(([p]) => p).sort()).toEqual(["/channels/gn/messages/slip-b", "/channels/gn/messages/slip-c"]);
  expect(edits.find(([p]) => p.endsWith("slip-c"))![1]).toContain("Never mind <@c>");
});

test("a night another copy already called off isn't touched again", async () => {
  await t.db.insert(gameNights).values({ day: "2026-11-05", stage: "ask", stage_at: now() - 86400, message_id: "old-card", nudge_id: "old-nudge" });
  // the other copy flips the stage first: ours finds nothing to flip
  await t.pool.query(`CREATE OR REPLACE FUNCTION qa_lost() RETURNS trigger AS $$ BEGIN RETURN NULL; END $$ LANGUAGE plpgsql`);
  await t.pool.query(`CREATE TRIGGER qa_lost BEFORE UPDATE ON game_nights FOR EACH ROW WHEN (NEW.stage = 'off') EXECUTE FUNCTION qa_lost()`);
  await gn.closeStale(env);
  await t.pool.query("DROP TRIGGER qa_lost ON game_nights");
  expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
  expect((await t.db.select().from(gameNights).where(eq(gameNights.day, "2026-11-05")))[0]).toMatchObject({ stage: "ask", nudge_id: "old-nudge" });
});

test("a card that won't post is reported, and its claim kept", async () => {
  h.override = (c) => (c.method === "POST" && c.path === "/channels/gn/messages" ? json({ message: "Missing Access", code: 50001 }, 403) : undefined);
  const log = vi.spyOn(console, "log").mockImplementation(noop);
  await expect(gn.startNight(env, undefined, true)).rejects.toThrow(/403/);
  const said = log.mock.calls.flat().map(String).join(" ");
  log.mockRestore();
  expect(said).toContain("posting the game-night card failed");
  expect(await night()).toMatchObject({ stage: "ask", message_id: null });
});

test("no reminders before 09:00: a waiting card is re-nudged from 09:00 on", async () => {
  const SAT = "2026-11-07";
  await t.db.insert(gameNights).values({ day: SAT, stage: "ask", message_id: "card-sat", stage_at: gn.wallToUnix(env, 2026, 11, 6, 20, 0), started_by: "a" });
  await t.db.insert(gameNightVotes).values({ day: SAT, stage: "ask", user_id: "a", choice: "yes", voted_at: "2026-11-06T18:00:00.000Z" });
  vi.setSystemTime(Date.parse("2026-11-07T06:30:00Z")); // Saturday 08:30 in Vilnius
  await gn.maintain(env);
  expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  vi.setSystemTime(Date.parse("2026-11-07T07:00:00Z")); // 09:00
  await gn.maintain(env);
  const [ping] = calls.filter((c) => c.method === "POST");
  expect(ping.body.content).toBe("<@b> <@c> ⏳ still waiting on you: are you in tonight? ⬆️");
});

test("one night's trouble doesn't hold up the other's upkeep", async () => {
  await t.db.insert(gameNights).values([
    { day: DAY, stage: "time", game: "R.E.P.O.", message_id: "card-a", stage_at: now() },
    { day: "2026-11-07", stage: "time", game: "R.E.P.O.", message_id: "card-b", stage_at: now() },
  ]);
  h.override = (c) => (c.method === "PATCH" && c.path === "/channels/gn/messages/card-a" ? json({ message: "Missing Access", code: 50001 }, 403) : undefined);
  const log = vi.spyOn(console, "log").mockImplementation(noop);
  const done = await gn.maintain(env); // 17:00: the quarter-hourly refresh of the times
  log.mockRestore();
  expect(String(done[`failed ${DAY}`])).toContain("403");
  expect(calls.some((c) => c.method === "PATCH" && c.path === "/channels/gn/messages/card-b")).toBe(true);
});

test("a start the timer missed is caught up within half an hour", async () => {
  await t.db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: now() - 20 * 60, message_id: "card", reminded: false });
  presence.snapshot([]);
  expect(await gn.maintain(env)).toMatchObject({ reminded: DAY });
  expect((await night())!.reminded).toBe(true);
});

test("the start times on an open card are refreshed every quarter hour", async () => {
  await t.db.insert(gameNights).values({ day: DAY, stage: "time", game: "R.E.P.O.", message_id: "card", stage_at: now() });
  const edits = () => calls.filter((c) => c.method === "PATCH" && c.path === "/channels/gn/messages/card").length;
  vi.setSystemTime(Date.parse("2026-11-06T15:10:00Z")); // 17:10
  await gn.maintain(env);
  expect(edits()).toBe(0);
  vi.setSystemTime(Date.parse("2026-11-06T15:15:00Z")); // 17:15
  await gn.maintain(env);
  expect(edits()).toBe(1);
});

test("the start ping goes out on the start's second, not before", async () => {
  h.race("runs on the real clock, so its times differ from run to run", {
    mask: { game_nights: ["start_at", "stage_at"], rooms: ["created_at", "last_seen"], night_attendance: ["arrived_at"] },
    bodies: false,
  });
  vi.useRealTimers();
  const start = Math.floor(Date.now() / 1000) + 1;
  await t.db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: start, message_id: "card", reminded: false });
  presence.snapshot([]);
  let pingAt = 0;
  h.override = (c) => {
    if (c.method === "POST" && c.path === "/channels/gn/messages" && c.body.content?.includes("starts now")) pingAt = Date.now();
    return undefined;
  };
  const [n] = await t.db.select().from(gameNights).where(eq(gameNights.day, DAY));
  expect(await gn.startOnTime(env, n)).toBe(true);
  expect(pingAt).toBeGreaterThanOrEqual(start * 1000);
});

test("a start whose unplanned session can't be merged still happens", async () => {
  await t.db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: now() - 60, message_id: "card", reminded: false });
  await t.pool.query(`CREATE OR REPLACE FUNCTION qa_fail() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'sessions are down'; END $$ LANGUAGE plpgsql`);
  await t.pool.query(`CREATE TRIGGER qa_fail BEFORE UPDATE ON sessions FOR EACH STATEMENT EXECUTE FUNCTION qa_fail()`);
  presence.snapshot([]);
  const log = vi.spyOn(console, "log").mockImplementation(noop);
  const done = await gn.maintain(env);
  const said = log.mock.calls.flat().map(String).join(" ");
  log.mockRestore();
  await t.pool.query("DROP TRIGGER qa_fail ON sessions");
  expect(done).toMatchObject({ reminded: DAY });
  expect((await night())!.reminded).toBe(true);
  expect(said).toContain("merging the unplanned session into the night failed");
  expect(said).not.toContain("the start ping failed");
});

test("late: someone who arrived and wandered back to the Lobby is left there", async () => {
  await t.db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: now() - 300, reminded: true, message_id: "card" });
  await t.db.insert(rooms).values({ channel_id: "r1", game: "R.E.P.O.", day: DAY, created_at: now() - 400 });
  await t.db.insert(nightAttendance).values({ day: DAY, user_id: "a", state: "arrived", arrived_at: now() - 200 });
  presence.snapshot([{ user_id: "a", channel_id: "lobby" }]);
  await late.watch(env);
  expect(calls.some((c) => c.method === "PATCH" && c.path === "/guilds/guild/members/a")).toBe(false);
});

test("late: a latecomer the bot can't move into the room isn't counted as here", async () => {
  await t.db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: now() - 300, reminded: true, message_id: "card" });
  await t.db.insert(rooms).values({ channel_id: "r1", game: "R.E.P.O.", day: DAY, created_at: now() - 400 });
  presence.snapshot([{ user_id: "a", channel_id: "lobby" }]);
  h.override = (c) => (c.method === "PATCH" && c.path === "/guilds/guild/members/a" ? json({ message: "Missing Permissions", code: 50013 }, 403) : undefined);
  const log = vi.spyOn(console, "log").mockImplementation(noop);
  await late.watch(env);
  const said = log.mock.calls.flat().map(String).join(" ");
  log.mockRestore();
  expect(said).toContain("latecomer upkeep failed");
  expect(await t.db.select().from(nightAttendance).where(eq(nightAttendance.user_id, "a"))).toEqual([]);
});

test("a poll: tapping your answer again takes your vote back", async () => {
  const id = await polls.createPoll(env, "a", "Pizza?", "");
  await polls.pollAct(env, id, "a", "0");
  expect(await t.db.select().from(pollVotes).where(eq(pollVotes.poll_id, id))).toHaveLength(1);
  expect(await polls.pollAct(env, id, "a", "0")).toEqual({ notice: "🗳️ Took your vote back.", update: true });
  expect(await t.db.select().from(pollVotes).where(eq(pollVotes.poll_id, id))).toEqual([]);
});
