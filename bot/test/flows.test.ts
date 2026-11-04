// End-to-end flows against a real Postgres, with Discord stubbed: game night from "are we
// playing?" to the start ping, secret ballots, reopen, tiebreakers, polls, rooms, latecomers,
// memes. Catches query mistakes long before the live QA suite does.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import * as gn from "../src/gamenight.js";
import * as polls from "../src/polls.js";
import * as tiebreak from "../src/tiebreak.js";
import * as voice from "../src/voice.js";
import * as late from "../src/late.js";
import * as memes from "../src/memes.js";
import * as jobs from "../src/jobs.js";
import * as presence from "../src/presence.js";
import { gameNights, gameNightVotes, games, memes as memeTable, nightAttendance, rooms, tiebreaks, polls as pollTable, pollVotes, votes } from "../src/db/schema.js";
import { testDb, testEnv } from "./pg.js";

let t: Awaited<ReturnType<typeof testDb>>;
let env: ReturnType<typeof testEnv>;
type Call = { method: string; path: string; body: any };
let calls: Call[] = [];
let nextId = 1000;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  t = await testDb();
  env = testEnv(t.db);
});
afterAll(() => t.close());
beforeEach(async () => {
  for (const tbl of [gameNightVotes, tiebreaks, nightAttendance, rooms, gameNights, pollVotes, pollTable, votes, memeTable, games]) await t.db.delete(tbl);
  await t.db.insert(games).values([
    { name: "R.E.P.O.", emoji: "📦", added_at: "2026-11-03" },
    { name: "Phasmophobia", emoji: "👻", added_at: "2026-11-03" },
    { name: "Palworld", emoji: "🐑", added_at: "2026-11-03" },
  ]);
  calls = [];
  presence._reset();
  // Discord: record every call, answer like Discord would
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const path = String(url).replace("https://discord.com/api/v10", "");
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method ?? "GET", path, body });
    const ok = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path.includes("/voice-states/")) return new Response(JSON.stringify({ message: "Unknown Voice State", code: 10065 }), { status: 404 });
    if (path.endsWith("/channels") && (init.method ?? "GET") === "GET") return ok([{ id: "lobby", type: 2, parent_id: "voice", position: 0, name: "Lobby" }]);
    if ((init.method ?? "GET") === "GET" && /^\/channels\/\d+$/.test(path)) return ok({ id: path.split("/")[2] });
    return ok({ id: String(nextId++) });
  }) as typeof fetch;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse("2026-11-06T15:00:00Z")); // Friday 17:00 in Vilnius
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
});

const DAY = "2026-11-06";
const text = (m: any): string => JSON.stringify(m);
const posts = () => calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages"));
const pending: Promise<unknown>[] = [];
const defer = (p: Promise<unknown>) => void pending.push(p);
const settle = async () => {
  while (pending.length) await Promise.all(pending.splice(0));
};
const act = async (user: string, action: string, value?: string) => {
  const r = await gn.act(env, DAY, user, action, value, defer);
  await settle();
  return r;
};
const night = () => gn.getNight(env, DAY);

test("17:00 posts one card per day, however many times it runs", async () => {
  const [a, b] = await Promise.all([gn.startNight(env), gn.startNight(env)]);
  expect([a, b].filter((r) => "started" in r && r.started).length).toBe(1);
  // if both got as far as posting, the loser deletes its copy at once
  const deleted = calls.filter((c) => c.method === "DELETE" && c.path.includes("/messages/")).length;
  expect(posts().length - deleted).toBe(1);
  expect((await night())!.message_id).toBeTruthy();
  const before = posts().length;
  vi.setSystemTime(Date.parse("2026-11-06T16:00:00Z")); // 18:00: not poll hour, nothing new
  expect(await gn.startNight(env)).toMatchObject({ started: false });
  expect(posts().length).toBe(before);
});

test("the whole night: secret answers → game → time → locked in → started on the dot", async () => {
  await gn.startNight(env, "a"); // /playtoday: a is in
  let card = text(await gn.render(env, DAY));
  expect(card).toContain("🤫 Answers stay secret");
  const r1 = await act("b", "yes");
  expect(r1.notice).toContain("You answered"); // private receipt while it's secret
  await act("c", "yes");
  expect((await night())!.stage).toBe("game");

  await act("a", "game", "R.E.P.O.");
  card = text(await gn.render(env, DAY));
  expect(card).not.toContain("← <@a>"); // still secret
  await act("b", "game", "R.E.P.O."); // majority
  const n = (await night())!;
  expect([n.stage, n.game]).toEqual(["time", "R.E.P.O."]);
  card = text(await gn.render(env, DAY));
  expect(card).toContain("R.E.P.O.** ← <@a> <@b>"); // revealed once decided

  const at19 = gn.wallToUnix(env, 2026, 11, 6, 19, 0);
  const at20 = gn.wallToUnix(env, 2026, 11, 6, 20, 0);
  await act("a", "time", String(at19));
  await act("b", "time", String(at20));
  await act("c", "until", "23:00");
  await act("c", "time", String(at19));
  const set = (await night())!;
  expect([set.stage, set.start_at]).toEqual(["set", at20]); // the latest pick wins
  expect(set.event_id).toBeTruthy();
  expect(set.event_end).toBe(gn.wallToUnix(env, 2026, 11, 6, 23, 0));
  expect((await t.db.select().from(games)).find((g) => g.name === "R.E.P.O.")!.plays).toBe(1);
  card = text(await gn.render(env, DAY));
  expect(card).toContain("Slowpoke of the night: <@b>");

  // two starters racing (the timer and the minute job): exactly one start
  vi.setSystemTime(at20 * 1000);
  const before = posts().length;
  const [x, y] = await Promise.all([gn.maintain(env), gn.maintain(env)]);
  expect([x, y].filter((r) => r.reminded).length).toBe(1);
  const startPing = posts().slice(before).filter((p) => text(p.body).includes("starts now"));
  expect(startPing.length).toBe(1);
  expect((await t.db.select().from(rooms)).length).toBe(1); // the game room opened
});

test("a clash pings once, and never locks", async () => {
  await gn.startNight(env, "a");
  await act("b", "yes");
  await act("c", "yes");
  for (const u of ["a", "b"]) await act(u, "game", "Palworld");
  await act("a", "until", "20:30");
  const at20 = gn.wallToUnix(env, 2026, 11, 6, 20, 0);
  await act("a", "time", String(gn.wallToUnix(env, 2026, 11, 6, 19, 0)));
  await act("b", "time", String(at20));
  await act("c", "time", String(at20));
  expect((await night())!.stage).toBe("time");
  const warnings = () => posts().filter((p) => text(p.body).includes("don't fit"));
  expect(warnings().length).toBe(1);
  await act("c", "time", String(at20)); // tap again: takes it back
  await act("c", "time", String(at20)); // same clash again: no second ping
  expect(warnings().length).toBe(1);
  expect(text(await gn.render(env, DAY))).toContain("Doesn't fit yet");
});

test("a three-way split goes to a tiebreaker; the wheel picks; time picking starts", async () => {
  await gn.startNight(env, "a");
  await act("b", "yes");
  await act("c", "yes");
  await act("a", "game", "R.E.P.O.");
  await act("b", "game", "Phasmophobia");
  await act("c", "game", "Palworld");
  const tb = (await tiebreak.get(env, "night", DAY))!;
  expect(tb.options.sort()).toEqual(["Palworld", "Phasmophobia", "R.E.P.O."]);
  expect(tb.contenders).toEqual({ a: "R.E.P.O.", b: "Phasmophobia", c: "Palworld" });
  const r = await tiebreak.act(env, tb.id, "a", "wheel");
  expect(r.resolved).toBe(true);
  expect(r.spin!.length).toBe(5);
  await gn.applyTiebreak(env, DAY, "a", defer);
  await settle();
  const n = (await night())!;
  expect(n.stage).toBe("time");
  expect(tb.options).toContain(n.game);
});

test("rock-paper-scissors: simultaneous throws all count; a draw replays", async () => {
  const tb = await tiebreak.open(env, "poll", "77", ["X", "Y"], { a: "X", b: "Y" });
  await tiebreak.act(env, tb.id, "a", "rps");
  await Promise.all([tiebreak.act(env, tb.id, "a", "hand", "r"), tiebreak.act(env, tb.id, "b", "hand", "r")]);
  let fresh = (await tiebreak.getById(env, tb.id))!;
  expect([fresh.round, fresh.result, fresh.history.length]).toEqual([2, null, 1]); // draw
  await tiebreak.act(env, tb.id, "a", "hand", "p");
  await tiebreak.act(env, tb.id, "b", "hand", "r");
  fresh = (await tiebreak.getById(env, tb.id))!;
  expect(fresh.result).toBe("X");
  expect(tiebreak.story(fresh, (o) => o)).toContain("won rock-paper-scissors");
});

test("polls: secret until a majority, then revealed and closed", async () => {
  const id = await polls.createPoll(env, "a", "Pizza?", "Yes\nNo");
  expect((await polls.pollAct(env, id, "a", "0")).notice).toContain("Your vote");
  expect(text(await polls.renderPoll(env, id))).not.toContain("█");
  await polls.pollAct(env, id, "b", "0");
  const card = text(await polls.renderPoll(env, id));
  expect(card).toContain("Decided: Yes");
  expect(card).toContain("<@a> <@b>");
  expect((await polls.pollAct(env, id, "c", "1")).notice).toContain("already decided");
});

test("polls: tapping your vote again takes it back; a three-way split goes to a tiebreaker", async () => {
  const id = await polls.createPoll(env, "a", "Where?", "A\nB\nC");
  await polls.pollAct(env, id, "a", "0");
  expect((await polls.pollAct(env, id, "a", "0")).notice).toContain("Took your vote back");
  await polls.pollAct(env, id, "a", "0");
  await polls.pollAct(env, id, "b", "1");
  await polls.pollAct(env, id, "c", "2");
  expect(await tiebreak.get(env, "poll", String(id))).toBeTruthy();
});

test("reopen starts the day over; reset wipes it", async () => {
  await gn.startNight(env, "a");
  await act("b", "no");
  await act("c", "yes");
  expect(text(await gn.render(env, DAY))).toContain("Not tonight");
  await act("b", "out"); // ask stage: "out" does nothing
  await gn.act(env, DAY, "b", "yes", undefined, defer);
  await settle();
  expect((await night())!.stage).toBe("game");
  await act("c", "out");
  expect((await night())!.stage).toBe("off");
  await act("b", "reopen");
  const n = (await night())!;
  expect([n.stage, n.started_by]).toEqual(["ask", "b"]);
  expect((await t.db.select().from(gameNightVotes)).map((v) => [v.user_id, v.choice])).toEqual([["b", "yes"]]);
  expect(await gn.resetNight(env, DAY)).toEqual({ reset: true });
  expect(await night()).toBeNull();
});

test("midnight closes an unfinished card", async () => {
  await gn.startNight(env, "a");
  vi.setSystemTime(Date.parse("2026-11-06T22:30:00Z")); // 00:30 Saturday
  expect(await gn.closeStale(env)).toEqual([DAY]);
  expect((await night())!.stage).toBe("off");
});

test("rooms: one room per game even when two open at once; archived after 15 empty minutes", async () => {
  presence.snapshot([]); // nobody in voice
  const [a, b] = await Promise.all([voice.openRoom(env, "R.E.P.O.", "📦", { by: "a" }), voice.openRoom(env, "r.e.p.o.", "📦", { by: "b" })]);
  expect(a.channelId).toBe(b.channelId);
  expect(calls.filter((c) => c.method === "POST" && c.path.endsWith("/channels")).length).toBe(1);
  const now = Math.floor(Date.now() / 1000);
  await voice.leftRoom(env, a.channelId, now);
  let r = await voice.checkRooms(env, new Set(), now + 60);
  expect(r).toEqual({ archived: [], nextDue: now + 15 * 60 });
  r = await voice.checkRooms(env, new Set(), now + 15 * 60);
  expect(r.archived.map((g) => g.toLowerCase())).toEqual(["r.e.p.o."]);
  // the next game night of that game brings the archived room back
  const again = await voice.openRoom(env, "R.E.P.O.", "📦", { day: DAY });
  expect([again.channelId, again.reused]).toEqual([a.channelId, true]);
});

test("latecomers: pulled in from the Lobby once; a slip after 10 minutes otherwise", async () => {
  const start = gn.wallToUnix(env, 2026, 11, 6, 20, 0);
  await t.db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: start, reminded: true, message_id: "card" });
  await t.db.insert(rooms).values({ channel_id: "room1", game: "R.E.P.O.", day: DAY, created_at: start });
  presence.snapshot([{ user_id: "a", channel_id: "lobby" }]);
  vi.setSystemTime((start + 60) * 1000);
  expect(await late.watch(env)).toEqual({ moved: ["a"] });
  expect(calls.some((c) => c.method === "PATCH" && c.path.endsWith("/members/a") && c.body.channel_id === "room1")).toBe(true);
  vi.setSystemTime((start + 11 * 60) * 1000);
  presence.update("a", "room1");
  const r = await late.watch(env);
  expect(r).toEqual({ slipped: ["b", "c"] }); // a already counts as arrived (we moved them)
  expect(await late.watch(env)).toEqual({}); // no second slip
  await late.act(env, DAY, "b", "b", "15");
  expect((await late.get(env, DAY, "b"))!.state).toBe("eta");
  expect((await late.act(env, DAY, "b", "c", "out")).notice).toContain("not your late slip");
});

test("memes: one daily per day even when posted twice at once; votes toggle; streaks", async () => {
  vi.setSystemTime(Date.parse("2026-11-06T11:00:00Z"));
  await memes.ingest(env, [
    { id: "t3_a", title: "A", image: "i", link: "l", author: "u", published: "2026-11-05T08:00:00Z", rank: 2 },
    { id: "t3_b", title: "B", image: "i", link: "l", author: "u", published: "2026-11-05T09:00:00Z", rank: 1 },
  ]);
  const [x, y] = await Promise.all([jobs.postDaily(env), jobs.postDaily(env)]);
  expect([x, y].filter((r) => "posted" in r).map((r) => (r as any).posted)).toEqual(["t3_b"]);
  expect(await memes.castVote(env, "t3_b", "a", "fire")).toBe("new");
  expect(await memes.castVote(env, "t3_b", "a", "lol")).toBe("changed");
  expect(await memes.tally(env, "t3_b")).toEqual({ lol: 1 });
  expect(await memes.castVote(env, "t3_b", "a", "lol")).toBe("removed");
  expect(await memes.bumpStreak(env, "a", "A")).toBe(1);
  expect(await memes.bumpStreak(env, "a", "A")).toBeNull();
  await memes.castVote(env, "t3_b", "a", "fire");
  await memes.castVote(env, "t3_b", "b", "fire");
  const top = await memes.leaderboard(env, null, null, 5);
  expect([top[0].id, top[0].score, top[0].votes]).toEqual(["t3_b", 6, 2]);
  const s = await memes.userStats(env, "a");
  expect([s.kinds.fire, s.agree.total, s.agree.agreed]).toEqual([1, 1, 1]);
  expect(await memes.claimRecap(env, "week:x")).toBe(true);
  expect(await memes.claimRecap(env, "week:x")).toBe(false);
});

test("games are case-insensitive, most played first", async () => {
  expect(await gn.addGame(env, "  phasmophobia ", "a")).toBe("Phasmophobia");
  expect(await gn.addGame(env, "Lethal Company", "a")).toBe("Lethal Company");
  await t.db.update(games).set({ plays: 5 }).where((await import("drizzle-orm")).eq(games.name, "Palworld"));
  expect((await gn.games(env)).map((g) => g.name)).toEqual(["Palworld", "R.E.P.O.", "Phasmophobia", "Lethal Company"]);
  await gn.removeGame(env, "lethal company");
  expect((await gn.games(env)).length).toBe(3);
});
