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
import { gameNights, gameNightVotes, games, memes as memeTable, nightAttendance, roastBags, rooms, tiebreaks, polls as pollTable, pollVotes, votes } from "../src/db/schema.js";
import * as roasts from "../src/roasts.js";
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
  for (const tbl of [gameNightVotes, tiebreaks, nightAttendance, rooms, gameNights, pollVotes, pollTable, votes, memeTable, games, roastBags]) await t.db.delete(tbl);
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
  await act("b", "yes");
  await act("c", "yes");
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

test("midnight closes an unfinished card; the roast waits for the morning", async () => {
  await gn.startNight(env, "a"); // 17:00
  vi.setSystemTime(Date.parse("2026-11-06T22:30:00Z")); // 00:30 Saturday (17:00's 20:00 deadline was missed: no minute job ran)
  expect(await gn.closeStale(env)).toEqual([DAY]);
  const n = (await night())!;
  expect(n.stage).toBe("off");
  expect(n.roast!.who).toEqual({ b: "ghost", c: "ghost" });
  expect(n.roast_due).toBe(Date.parse("2026-11-07T07:30:00Z") / 1000); // 09:30 Saturday
  expect(await gn.dueRoasts(env)).toEqual([]); // not at night
  vi.setSystemTime(Date.parse("2026-11-07T07:31:00Z"));
  expect(await gn.dueRoasts(env)).toEqual([DAY]);
  expect(await gn.dueRoasts(env)).toEqual([]); // once
});

// ---------------------------------------------------------------- 🔥 deadlines and roasts

const roastPosts = () => posts().filter((p) => p.body.content?.startsWith("🔥"));

test("a no stays secret until everyone's answered, then the night's off and the no-sayer is roasted", async () => {
  await gn.startNight(env, "a");
  await act("b", "no");
  expect((await night())!.stage).toBe("ask"); // a no alone doesn't end it
  expect(text(await gn.render(env, DAY))).toContain("🤫 Answers stay secret");
  expect(text(await gn.render(env, DAY))).toContain("Vote by");
  await act("c", "yes");
  const n = (await night())!;
  expect([n.stage, n.roast!.who]).toEqual(["off", { b: "no" }]);
  const [r] = roastPosts();
  expect(r.body.content).toMatch(/^🔥 \*\*Tonight's game night is off\*\* · <@b> ❌ said no\n> .*<@b>/);
  expect(r.body.allowed_mentions.users.sort()).toEqual(["a", "b", "c"]);
  const card = text(await gn.render(env, DAY));
  expect(card).toContain("How everyone voted"); // revealed
  expect(card).toContain("Reopen");
});

test("3 h after voting opens: last call at 2.5 h, then non-voters (and no-sayers) are roasted", async () => {
  await gn.startNight(env, "a"); // 17:00
  await act("b", "no");
  vi.setSystemTime(Date.parse("2026-11-06T17:29:00Z")); // 19:29
  await gn.maintain(env);
  expect(posts().some((p) => p.body.content?.includes("Last call"))).toBe(false);
  vi.setSystemTime(Date.parse("2026-11-06T17:31:00Z")); // 19:31
  await gn.maintain(env);
  const warn = posts().filter((p) => p.body.content?.includes("Last call"));
  expect(warn.length).toBe(1);
  expect(warn[0].body.content).toMatch(/^<@c> ⏳ Last call: 29 min/);
  await gn.maintain(env);
  expect(posts().filter((p) => p.body.content?.includes("Last call")).length).toBe(1); // once
  vi.setSystemTime(Date.parse("2026-11-06T18:00:00Z")); // 20:00
  await gn.maintain(env);
  const n = (await night())!;
  expect([n.stage, n.roast!.who]).toEqual(["off", { b: "no", c: "ghost" }]);
  expect(roastPosts()[0].body.content).toContain("<@b> ❌ said no · <@c> 👻 didn't vote in time");
});

test("game and time picks have the same deadline", async () => {
  await gn.startNight(env, "a");
  await act("b", "yes");
  await act("c", "yes");
  await act("a", "game", "Palworld");
  vi.setSystemTime(Date.parse("2026-11-06T18:01:00Z")); // 3 h later, b and c never picked
  await gn.maintain(env);
  expect((await night())!.roast!.who).toEqual({ b: "ghost", c: "ghost" });
});

test("all three out: the bot sulks alone", async () => {
  await gn.startNight(env); // the 17:00 schedule: nobody's in yet
  vi.setSystemTime(Date.parse("2026-11-06T18:00:00Z"));
  await gn.maintain(env);
  const [r] = roastPosts();
  expect(r.body.content).toMatch(/^🔥 \*\*Nobody's in, so tonight's game night is off\*\*\n> /);
  expect(roasts._pools.TRIO.some((l) => r.body.content.endsWith(roasts.fill(l, ["a", "b", "c"])))).toBe(true);
});

test("bailing with 🚪 gets you roasted, also after the night was locked in", async () => {
  await gn.startNight(env, "a");
  await act("b", "yes");
  await act("c", "yes");
  await act("b", "out");
  expect((await night())!.roast!.who).toEqual({ b: "out" });
  expect(roastPosts()[0].body.content).toContain("<@b> 🚪 bailed");
});

test("deadlines: never in the small hours, and planned days get until noon on the day", () => {
  const at = (iso: string) => Date.parse(iso) / 1000;
  // opened 23:00 today → 02:00 → moved to 09:30
  expect(gn.voteDeadline(env, { day: DAY, stage_at: at("2026-11-06T21:00:00Z") })).toBe(at("2026-11-07T07:30:00Z"));
  // opened 17:00 → 20:00
  expect(gn.voteDeadline(env, { day: DAY, stage_at: at("2026-11-06T15:00:00Z") })).toBe(at("2026-11-06T18:00:00Z"));
  // Friday planned on Monday 10:00 → noon Friday
  expect(gn.voteDeadline(env, { day: DAY, stage_at: at("2026-11-02T08:00:00Z") })).toBe(at("2026-11-06T10:00:00Z"));
  // tomorrow planned at 22:00 → 01:00 would be night, but noon tomorrow is later anyway
  expect(gn.voteDeadline(env, { day: "2026-11-07", stage_at: at("2026-11-06T20:00:00Z") })).toBe(at("2026-11-07T10:00:00Z"));
});

test("reopening drops a roast still waiting for the morning", async () => {
  await gn.startNight(env, "a");
  vi.setSystemTime(Date.parse("2026-11-06T21:30:00Z")); // 23:30: deadline was 20:00
  await gn.maintain(env);
  // (23:30 is awake time, so it posted; force a held one to check reopen clears it)
  await t.db.update(gameNights).set({ roasted_at: null, roast_due: Date.parse("2026-11-07T07:30:00Z") / 1000 });
  await act("c", "reopen");
  const n = (await night())!;
  expect([n.stage, n.roast, n.roast_due]).toEqual(["ask", null, null]);
});

test("roast lines rotate: no repeats until the pool is used up", async () => {
  const { lines } = roasts.poolFor(["b"]);
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) seen.add(await roasts.next(env, ["b"]));
  expect(seen.size).toBe(lines.length);
});

test("roast pools: personal lines join the right pools", () => {
  const [V, K, L] = ["306836805825593344", "212567787896307713", "747902984003780651"];
  expect(roasts.poolFor([K]).lines.some((l) => l.includes("fap and nap"))).toBe(true);
  expect(roasts.poolFor([L]).lines.some((l) => l.includes("Pūkis"))).toBe(true);
  expect(roasts.poolFor([V]).lines.some((l) => l.includes("merge conflict"))).toBe(true);
  expect(roasts.poolFor([K, L]).key).toBe(roasts.poolFor([L, K]).key);
  expect(roasts.poolFor([V, K, L]).key).toBe("trio");
  for (const l of roasts.poolFor([K, L]).lines) expect(roasts.fill(l, [K, L])).not.toMatch(/\{\w+\}/);
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

test("bailing after the start: the late slip turns into a roast; no slip means a roast post", async () => {
  const start = gn.wallToUnix(env, 2026, 11, 6, 20, 0);
  await t.db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: start, reminded: true, message_id: "card" });
  await t.db.insert(rooms).values({ channel_id: "room1", game: "R.E.P.O.", day: DAY, created_at: start });
  presence.snapshot([]);
  vi.setSystemTime((start + 11 * 60) * 1000);
  await late.watch(env); // everyone gets a slip
  await late.act(env, DAY, "b", "b", "out"); // 😴 on the slip
  const slip = text(await late.render(env, DAY, "b"));
  expect(slip).toContain("🔥 **Tonight's R.E.P.O. lost a player** · <@b> 🚪 bailed");
  const kept = (await late.get(env, DAY, "b"))!.roast;
  expect(kept).toBeTruthy();
  expect(text(await late.render(env, DAY, "b"))).toContain(JSON.stringify(kept).slice(1, -1)); // same line on every re-render
  // the card's "Can't make it" from someone whose slip is gone
  await t.db.update(nightAttendance).set({ message_id: null }).where((await import("drizzle-orm")).eq(nightAttendance.user_id, "c"));
  const before = posts().length;
  const r = await gn.act(env, DAY, "c", "out", undefined, defer);
  await settle();
  expect(r.notice).toContain("carry on");
  const roast = posts().slice(before).find((p) => text(p.body).includes("bailed"))!;
  expect(roast.body.content).toMatch(/^🔥 \*\*Tonight's R\.E\.P\.O\. lost a player\*\* · <@c> 🚪 bailed, the rest of you carry on\n> /);
  expect((await night())!.stage).toBe("set"); // the others still play
});
