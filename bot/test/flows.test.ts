// End-to-end flows against a real Postgres, with Discord stubbed: game night from "are we
// playing?" to the start ping, secret ballots, reopen, split re-votes, polls, rooms, latecomers,
// memes. Catches query mistakes long before the live QA suite does.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import * as gn from "./old/gamenight.js";
import * as polls from "./old/polls.js";
import * as voice from "./old/voice.js";
import * as late from "./old/late.js";
import * as memes from "./old/memes.js";
import * as jobs from "./old/jobs.js";
import * as presence from "./old/presence.js";
import { gameNights, gameNightVotes, games, memes as memeTable, nightAttendance, panels, roastBags, rooms, polls as pollTable, pollVotes, settings, votes } from "../src/db/schema.js";
import * as roasts from "./old/roasts.js";
import * as memeshame from "./old/memeshame.js";
import * as snooze from "./old/snooze.js";
import { interaction } from "./old/interactions.js";
import { drain } from "./old/background.js";
import { harness, json, routes, type TestDb } from "./harness.js";
import type { Env } from "./old/env.js";

const h = harness({
  tables: [panels, gameNightVotes, nightAttendance, rooms, gameNights, pollVotes, pollTable, votes, memeTable, games, roastBags, settings],
  seed: (t) =>
    t.db.insert(games).values([
      { name: "R.E.P.O.", emoji: "📦", added_at: "2026-11-03" },
      { name: "Phasmophobia", emoji: "👻", added_at: "2026-11-03" },
      { name: "Palworld", emoji: "🐑", added_at: "2026-11-03" },
    ]),
  // Discord: record every call, answer like Discord would
  discord: { firstId: 1000, routes: [routes.noVoiceState, routes.lobbyOnly, routes.channelExists] },
  clock: "2026-11-06T15:00:00Z", // Friday 17:00 in Vilnius
});
const calls = h.calls;
let t: TestDb;
let env: Env;
beforeAll(() => void ({ t, env } = h));
beforeEach(() => {
  presence._reset();
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
  h.race("two daily jobs at once; whether both get as far as posting depends on timing", { mask: { game_nights: ["message_id"] } });
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

test("three people planning the same day at once: one card, and only whoever claimed it is in", async () => {
  const day = "2026-11-10";
  h.race("three startNight calls at once; whichever claims the day first wins", { mask: { game_nights: ["started_by", "message_id", "nudge_id"], game_night_votes: ["user_id"] }, bodies: false });
  const rs = await Promise.all(["a", "b", "c"].map((u) => gn.startNight(env, u, true, day)));
  expect(rs.filter((r) => "started" in r && r.started).length).toBe(1);
  const n = (await gn.getNight(env, day))!;
  const yes = await t.db.select().from(gameNightVotes);
  // the others get pointed at the card like anyone planning it later; nobody is in by accident
  expect(yes.map((v) => [v.user_id, v.choice])).toEqual([[n.started_by, "yes"]]);
  expect(n.stage).toBe("ask");
});

test("the whole night: secret answers → game → time → locked in → started on the dot", async () => {
  await gn.startNight(env, "a"); // /playtoday: a is in
  let card = text(await gn.render(env, DAY));
  expect(card).toContain("🤫 Answers stay secret");
  await act("b", "yes");
  // b's private panel: their answer, and one button to switch; only b sees it
  const mine = (await gn.render(env, DAY, "b")) as any;
  expect(mine.flags & 64).toBe(64);
  expect(text(mine)).toContain("You're **in**");
  expect(text(mine)).not.toContain("Are we playing"); // not a second copy of the card
  const buttons = mine.components[0].components.find((c: any) => c.type === 1).components;
  expect(buttons.map((b: any) => [b.label, b.style])).toEqual([
    ["Change to Maybe", 1],
    ["Change to Not today", 4],
  ]);
  expect((await gn.render(env, DAY)).flags & 64).toBe(0); // the public card isn't
  await act("c", "yes");
  expect((await night())!.stage).toBe("game");

  await act("a", "game", "R.E.P.O.");
  card = text(await gn.render(env, DAY));
  expect(card).not.toContain("← <@a>"); // still secret
  await act("b", "game", "R.E.P.O.");
  expect((await night())!.stage).toBe("game"); // two votes aren't enough: everyone gets a say
  const picked = ((await gn.render(env, DAY, "a")) as any).components[0].components.find((c: any) => c.type === 1 && c.components[0].type === 3).components[0];
  expect(picked.options.filter((o: any) => o.default).map((o: any) => o.value)).toEqual(["R.E.P.O."]);
  await act("c", "game", "Palworld");
  const n = (await night())!;
  expect([n.stage, n.game]).toEqual(["time", "R.E.P.O."]);
  card = text(await gn.render(env, DAY));
  expect(card).toContain("R.E.P.O.** ← <@a> <@b>"); // revealed once decided
  expect(posts().some((p) => p.body.content?.includes("Everyone's voted"))).toBe(true);

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
  expect((await t.db.select().from(games)).find((g) => g.name === "R.E.P.O.")!.plays).toBe(0); // not played yet
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
  expect((await t.db.select().from(games)).find((g) => g.name === "R.E.P.O.")!.plays).toBe(1); // now it counts
});

test("a clash pings once, and never locks", async () => {
  await gn.startNight(env, "a");
  await act("b", "yes");
  await act("c", "yes");
  for (const u of ["a", "b", "c"]) await act(u, "game", "Palworld");
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

test("a three-way split reveals the picks and stays open for a re-vote; two agreeing settles it", async () => {
  await gn.startNight(env, "a");
  await act("b", "yes");
  await act("c", "yes");
  await act("a", "game", "R.E.P.O.");
  await act("b", "game", "Phasmophobia");
  await act("c", "game", "Palworld");
  expect((await night())!.stage).toBe("game");
  const card = text(await gn.render(env, DAY));
  expect(card).toContain("Split vote");
  expect(card).toContain("R.E.P.O.** ← <@a>"); // revealed so you can talk it out
  expect(posts().filter((p) => p.body.content?.includes("Split vote")).length).toBe(1);
  await act("c", "game", "Phasmophobia"); // c gives in
  const n = (await night())!;
  expect([n.stage, n.game]).toEqual(["time", "Phasmophobia"]);
});

test("a split that never resolves: last call for everyone, then the night's off (nobody roasted)", async () => {
  await gn.startNight(env, "a");
  await act("b", "yes");
  await act("c", "yes");
  await act("a", "game", "R.E.P.O.");
  await act("b", "game", "Phasmophobia");
  await act("c", "game", "Palworld");
  const opened = (await night())!.stage_at!;
  vi.setSystemTime((opened + 3 * 3600 - 20 * 60) * 1000);
  await gn.maintain(env);
  expect(posts().some((p) => p.body.content?.includes("Still split"))).toBe(true);
  vi.setSystemTime((opened + 3 * 3600 + 60) * 1000);
  await gn.maintain(env);
  const n = (await night())!;
  expect([n.stage, n.roast]).toEqual(["off", null]);
  expect(n.note).toContain("couldn't agree");
});

test("polls: secret until everyone's voted, then most votes wins; your answer is highlighted on your copy", async () => {
  const id = await polls.createPoll(env, "a", "Pizza?", "Yes\nNo");
  await polls.pollAct(env, id, "a", "0");
  await polls.pollAct(env, id, "b", "0");
  expect(text(await polls.renderPoll(env, id))).not.toContain("█"); // 2 of 3 isn't the end any more
  const mine = (await polls.renderPoll(env, id, "a")) as any;
  expect(mine.flags & 64).toBe(64);
  const buttons = mine.components[0].components.find((c: any) => c.type === 1).components;
  expect(buttons.map((b: any) => b.style)).toEqual([3, 2, 2]); // Yes (mine), No, Close
  await polls.pollAct(env, id, "c", "1");
  const card = text(await polls.renderPoll(env, id));
  expect(card).toContain("Decided: Yes");
  expect(card).toContain("<@a> <@b>");
  expect((await polls.pollAct(env, id, "c", "0")).notice).toContain("already decided");
});

test("polls: tapping your vote again takes it back; a split stays open until one answer leads", async () => {
  const id = await polls.createPoll(env, "a", "Where?", "A\nB\nC");
  await polls.pollAct(env, id, "a", "0");
  expect((await polls.pollAct(env, id, "a", "0")).notice).toContain("Took your vote back");
  await polls.pollAct(env, id, "a", "0");
  await polls.pollAct(env, id, "b", "1");
  await polls.pollAct(env, id, "c", "2");
  let card = text(await polls.renderPoll(env, id));
  expect(card).toContain("Split vote");
  expect(card).toContain("█"); // revealed
  expect((await polls.pollAct(env, id, "a", "close")).notice).toContain("Still split");
  await polls.pollAct(env, id, "c", "1");
  card = text(await polls.renderPoll(env, id));
  expect(card).toContain("Decided: B");
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

// ---------------------------------------------------------------- 🤔 maybe

const maybeButton = (m: any) => text(m).includes(`gn:${DAY}:maybe`);

test("🤔 a maybe holds it for 2 h once everyone's answered, then the unsure get an hour to answer", async () => {
  await gn.startNight(env, "a"); // 17:00
  await act("c", "maybe");
  expect((await night())!).toMatchObject({ stage: "ask", maybes: 0, paused_until: null }); // the others haven't answered
  expect(text(await gn.render(env, DAY))).toContain("🤫 Answers stay secret");
  expect(text(await gn.render(env, DAY, "c"))).toContain("You said **maybe**");
  await act("b", "yes");
  let n = (await night())!;
  const at19 = gn.wallToUnix(env, 2026, 11, 6, 19, 0);
  expect([n.stage, n.maybes, n.paused_until]).toEqual(["ask", 1, at19]);
  let card = text(await gn.render(env, DAY));
  expect(card).toContain("✅ <@a>　✅ <@b>　🤔 <@c>"); // everyone answered, so it's out
  expect(card).toContain("**On hold**");
  expect(card).not.toContain("Vote by"); // no deadline while it's on hold
  const held = posts().find((p) => p.body.content?.includes("isn't sure yet"))!;
  expect(held.body.content).toMatch(/^<@a> <@b> 🤔 <@c> isn't sure yet, so it's on hold until/);
  expect(held.body.allowed_mentions.users).toEqual(["a", "b"]); // the sure ones hear why they wait

  vi.setSystemTime(Date.parse("2026-11-06T16:59:00Z")); // 18:59: still on hold
  await gn.maintain(env);
  expect((await night())!.paused_until).toBe(at19);
  vi.setSystemTime(Date.parse("2026-11-06T17:00:00Z")); // 19:00: the unsure are asked again
  await gn.maintain(env);
  await gn.maintain(env); // once
  n = (await night())!;
  expect([n.stage, n.maybes, n.paused_until, n.stage_at]).toEqual(["ask", 1, null, at19]);
  const again = posts().filter((p) => p.body.content?.includes("Decision time"));
  expect(again.length).toBe(1);
  expect(again[0].body.content).toMatch(/^<@c> ⏰ Decision time: are you in tonight\?/);
  expect(again[0].body.allowed_mentions.users).toEqual(["c"]);
  card = text(await gn.render(env, DAY));
  expect(card).toContain("✅ <@a>　✅ <@b>　⏳ <@c>"); // the yeses carry over
  expect(card).toContain(`Vote by <t:${at19 + 3600}:t>`); // an hour to answer
  expect(maybeButton(await gn.render(env, DAY))).toBe(true); // one more maybe is allowed
  await act("c", "yes");
  expect((await night())!.stage).toBe("game");
});

test("🤔 a second maybe holds it 1 h more; then it's yes or no, and no answer gets you roasted", async () => {
  await gn.startNight(env, "a");
  await act("b", "yes");
  await act("c", "maybe"); // on hold until 19:00
  vi.setSystemTime(Date.parse("2026-11-06T17:00:00Z")); // 19:00
  await gn.maintain(env);
  await act("c", "maybe"); // the yeses are still in, so that's everyone again: on hold until 20:00
  let n = (await night())!;
  expect([n.maybes, n.paused_until]).toEqual([2, gn.wallToUnix(env, 2026, 11, 6, 20, 0)]);
  expect(text(await gn.render(env, DAY))).toContain("This is the last hold");
  vi.setSystemTime(Date.parse("2026-11-06T18:00:00Z")); // 20:00: final call
  await gn.maintain(env);
  expect(posts().some((p) => p.body.content?.startsWith("<@c> ⏰ Final call"))).toBe(true);
  const card = await gn.render(env, DAY);
  expect(text(card)).toContain("⏰ Final call! Are we playing today?");
  expect(maybeButton(card)).toBe(false);
  expect(maybeButton(await gn.render(env, DAY, "c"))).toBe(false);
  const r = await act("c", "maybe"); // an old panel
  expect(r.notice).toContain("No more maybes");
  expect(text(await gn.render(env, DAY, "c"))).toContain("Final call: are you in tonight? No more maybes."); // not counted
  vi.setSystemTime(Date.parse("2026-11-06T18:31:00Z")); // 20:31: last call
  await gn.maintain(env);
  expect(posts().filter((p) => p.body.content?.includes("Last call")).map((p) => p.body.content)).toEqual([expect.stringMatching(/^<@c> ⏳ Last call: 29 min/)]);
  vi.setSystemTime(Date.parse("2026-11-06T19:00:00Z")); // 21:00
  await gn.maintain(env);
  n = (await night())!;
  expect([n.stage, n.roast!.who]).toEqual(["off", { c: "ghost" }]);
});

test("🤔 a no beats a maybe, also during a hold; reopening starts the holds over", async () => {
  await gn.startNight(env, "a");
  await act("c", "maybe");
  await act("b", "no"); // everyone's answered: no hold, the no wins
  let n = (await night())!;
  expect([n.stage, n.maybes, n.roast!.who]).toEqual(["off", 0, { b: "no" }]);
  expect(text(await gn.render(env, DAY))).toContain("🤔 <@c>");

  await act("a", "reopen");
  await act("b", "yes");
  await act("c", "maybe");
  expect((await night())!.maybes).toBe(1);
  await act("b", "no"); // changed their mind while on hold
  n = (await night())!;
  expect([n.stage, n.paused_until, n.roast!.who]).toEqual(["off", null, { b: "no" }]);
  await act("a", "reopen");
  expect((await night())!).toMatchObject({ stage: "ask", maybes: 0, paused_until: null });
});

test("🤔 a maybe who turns yes during the hold starts it right away; holds never end in the small hours", async () => {
  await gn.startNight(env, "a");
  await act("b", "yes");
  await act("c", "maybe");
  await act("c", "yes");
  expect((await night())!).toMatchObject({ stage: "game", paused_until: null });

  // tomorrow, planned at 22:00: 2 h later would be midnight, so it waits until 09:30
  vi.setSystemTime(Date.parse("2026-11-06T20:00:00Z"));
  const SAT = "2026-11-07";
  await gn.startNight(env, "a", true, SAT);
  await gn.act(env, SAT, "b", "yes", undefined, defer);
  await gn.act(env, SAT, "c", "maybe", undefined, defer);
  await settle();
  expect((await gn.getNight(env, SAT))!.paused_until).toBe(gn.wallToUnix(env, 2026, 11, 7, 9, 30));
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

test("roast rotation is shared: a line used on one person doesn't come up for another in the same cycle", async () => {
  const [V, K, L] = ["306836805825593344", "212567787896307713", "747902984003780651"];
  const { SOLO, PERSONAL, DUO, PAIRS } = roasts._pools;
  // whatever order people sink nights in, nothing repeats until a culprit runs out of fitting lines,
  // which takes at least (generic lines + their own lines) draws
  const drawn: string[] = [];
  const minSolo = SOLO.length + Math.min(...Object.values(PERSONAL).map((x) => x.length));
  for (let i = 0; i < minSolo; i++) {
    const p = roasts.poolFor([[V, K, L][Math.floor(Math.random() * 3)]]);
    drawn.push(await roasts.draw(env, p.key, p.all, p.lines));
  }
  expect(new Set(drawn).size).toBe(drawn.length);

  const pairs = [[V, K], [V, L], [K, L]];
  const duo: string[] = [];
  for (let i = 0; i < DUO.length + Math.min(...Object.values(PAIRS).map((x) => x.length)); i++) {
    const p = roasts.poolFor(pairs[i % 3]);
    duo.push(await roasts.draw(env, p.key, p.all, p.lines));
  }
  expect(new Set(duo).size).toBe(duo.length);
  // personal lines only ever land on their own person
  for (const l of drawn) if (!SOLO.includes(l)) expect(Object.values(PERSONAL).filter((x) => x.includes(l)).length).toBe(1);
});

test("roast rotation: a full cycle, then a fresh one that doesn't open with the last line", async () => {
  const K = "212567787896307713";
  const p = roasts.poolFor([K]);
  const cycle: string[] = [];
  for (let i = 0; i < p.lines.length; i++) cycle.push(await roasts.draw(env, p.key, p.all, p.lines));
  expect(new Set(cycle).size).toBe(p.lines.length); // every line that fits Koral, once
  const first = await roasts.draw(env, p.key, p.all, p.lines);
  expect(first).not.toBe(cycle[cycle.length - 1]);
});

test("roast rotation survives edits: stale queue entries (old indices, removed lines) are dropped", async () => {
  await t.db.insert(roastBags).values({ pool: "trio", queue: [0, 3, "a line that was deleted"], last_line: null });
  const line = await roasts.draw(env, "trio", roasts._pools.TRIO, roasts._pools.TRIO);
  expect(roasts._pools.TRIO).toContain(line);
});

test("every line is unique within its family (rotation goes by the text)", () => {
  const { SOLO_ALL, DUO_ALL, TRIO } = roasts._pools;
  for (const fam of [SOLO_ALL, DUO_ALL, TRIO, memeshame.ALL]) expect(new Set(fam).size).toBe(fam.length);
});

test("meme call-outs share one bag too", async () => {
  const [V, K, L] = ["306836805825593344", "212567787896307713", "747902984003780651"];
  const drawn: string[] = [];
  for (let i = 0; i < memeshame.LINES.length + 3; i++) {
    const u = [V, K, L][i % 3];
    drawn.push(await roasts.draw(env, "memes", memeshame.ALL, memeshame.fitsFor(u)));
  }
  expect(new Set(drawn).size).toBe(drawn.length);
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
  h.race("two openRoom calls at once; which one's channel is kept depends on timing", { mask: { rooms: ["channel_id", "game", "created_by"] }, calls: false });
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
  expect(await memes.voters(env, "t3_b")).toEqual({ lol: ["a"] });
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

test("all of us or none of us: a bail after the start calls the night off for everyone", async () => {
  const start = gn.wallToUnix(env, 2026, 11, 6, 20, 0);
  await t.db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: start, reminded: true, message_id: "card", event_id: "ev1" });
  await t.db.insert(rooms).values({ channel_id: "room1", game: "R.E.P.O.", day: DAY, created_at: start });
  presence.snapshot([]);
  vi.setSystemTime((start + 11 * 60) * 1000);
  await late.watch(env); // everyone gets a slip
  const slips = Object.fromEntries((await t.db.select().from(nightAttendance)).map((r) => [r.user_id, r.message_id]));
  await late.act(env, DAY, "b", "b", "out"); // 😴 on b's slip
  const n = (await night())!;
  expect([n.stage, n.roast!.who]).toEqual(["off", { b: "out" }]);
  expect(calls.some((c) => c.method === "PATCH" && c.path.endsWith("/scheduled-events/ev1") && c.body.status === 3)).toBe(true); // live event ended
  const roast = roastPosts()[0];
  expect(roast.body.content).toMatch(/^🔥 \*\*📦 R\.E\.P\.O\. tonight is off\*\* · <@b> 🚪 bailed\n> /);
  expect(roast.body.allowed_mentions.users.sort()).toEqual(["a", "b", "c"]); // everyone hears it's off
  // everyone else's "running late?" slip now says it's off; b's says they bailed
  const edited = (id: string) => calls.filter((c) => c.method === "PATCH" && c.path.endsWith(`/messages/${id}`)).pop()!.body.components[0].content;
  expect(edited(slips.a!)).toContain("game night's off");
  expect(edited(slips.b!)).toContain("<@b> bailed");
  expect((await late.act(env, DAY, "c", "c", "15")).notice).toContain("Game night's off");
});

test("the card's 🚪 after the start does the same", async () => {
  const start = gn.wallToUnix(env, 2026, 11, 6, 20, 0);
  await t.db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: start, reminded: true, message_id: "card" });
  vi.setSystemTime((start + 5 * 60) * 1000);
  await act("c", "out");
  expect((await night())!.roast!.who).toEqual({ c: "out" });
  expect(roastPosts().length).toBe(1);
});

test("starting or planning by hand pings the other two; stage changes ping everyone", async () => {
  await gn.startNight(env, "a"); // /playtoday
  const start = posts().find((p) => p.body.content?.includes("wants to play"))!;
  expect(start.body.content).toBe("<@b> <@c> 🎮 <@a> wants to play tonight! Are you in? ⬆️");
  await act("b", "yes");
  await act("c", "yes");
  const next = posts().find((p) => p.body.content?.includes("Everyone's in"))!;
  expect(next.body.content.startsWith("<@a> <@b> <@c>")).toBe(true); // c clicked last and still hears it
});

test("your copy: your own leave-by is 'You', and starts that clash with it are greyed out", async () => {
  await gn.startNight(env, "a");
  await act("b", "yes");
  await act("c", "yes");
  for (const u of ["a", "b", "c"]) await act(u, "game", "Palworld");
  await act("a", "until", "20:30");
  const mine = (await gn.render(env, DAY, "a")) as any;
  expect(text(mine)).toContain("You have to leave by **20:30**");
  expect(text(await gn.render(env, DAY, "b"))).toContain("Someone has to leave by");
  const buttons = mine.components[0].components.filter((c: any) => c.type === 1).flatMap((r: any) => r.components);
  const t = (hm: string) => buttons.find((b: any) => b.label === hm);
  expect(t("19:00").disabled).toBeUndefined();
  expect(t("20:00").disabled).toBe(true); // 20:00 → 20:30 is under an hour
});

test("polls: one vote can't be closed into a decision", async () => {
  const id = await polls.createPoll(env, "a", "Q?", "A\nB");
  await polls.pollAct(env, id, "a", "0");
  expect((await polls.pollAct(env, id, "a", "close")).notice).toContain("One vote isn't a decision");
  await polls.pollAct(env, id, "b", "0");
  await polls.pollAct(env, id, "a", "close");
  expect(await polls.isClosed(env, id)).toBe(true);
});

test("⏰ running late before the start: we wait, so the start moves to the latest ETA (and back)", async () => {
  const start = gn.wallToUnix(env, 2026, 11, 6, 20, 0);
  await t.db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: start, message_id: "card", event_id: "ev1", event_end: start + 3 * 3600 });
  await t.db.insert(gameNightVotes).values({ day: DAY, stage: "until", user_id: "c", choice: String(start + 75 * 60), voted_at: new Date().toISOString() }); // c leaves at 21:15
  vi.setSystemTime((start - 15 * 60) * 1000); // 19:45: a and b realise they'll be late
  const card = text(await gn.render(env, DAY));
  expect(card).toContain("Running late?");
  expect(card).toContain(`gn:${DAY}:late:15`);

  let r = await act("a", "late", "15");
  expect(r.notice).toContain("start moved to **20:15**");
  let n = (await night())!;
  expect([n.start_at, n.planned_start]).toEqual([start + 15 * 60, start]);
  const moved = posts().pop()!;
  expect(moved.body.content).toContain("<@a> is running 15 min late, so we start at **20:15**");
  expect(moved.body.content).not.toContain("⚠️"); // exactly an hour with c: fine
  expect(moved.body.allowed_mentions.users).toEqual(["b", "c"]); // the others hear it
  const ev = calls.filter((c) => c.method === "PATCH" && c.path.endsWith("/scheduled-events/ev1")).pop()!;
  expect(ev.body.scheduled_start_time).toBe(new Date((start + 15 * 60) * 1000).toISOString());

  // b's later still: the start follows the last one; c's leave-by gets a heads-up
  await act("b", "late", "30");
  n = (await night())!;
  expect(n.start_at).toBe(start + 30 * 60);
  expect(posts().pop()!.body.content).toContain("⚠️ That leaves 45 min before <@c> has to leave");
  expect(text(await gn.render(env, DAY))).toContain("⏰ Running late: <@a> +15 min · <@b> +30 min · start moved from 20:00");

  // a shorter delay from someone else doesn't move it
  const before = posts().length;
  r = await act("c", "late", "5");
  expect(r.notice).toContain("start stays at **20:30**");
  expect(posts().length).toBe(before);

  // tapping your delay again takes it back: start goes to the next latest
  r = await act("b", "late", "30");
  expect(r.notice).toContain("Taken back");
  expect((await night())!.start_at).toBe(start + 15 * 60);
  expect(posts().pop()!.body.content).toContain("<@b> will be on time after all");

  // the start timer uses the moved start: nothing at 20:00, the start at 20:15
  vi.setSystemTime(start * 1000);
  expect((await gn.maintain(env)).reminded).toBeUndefined();
  vi.setSystemTime((start + 15 * 60) * 1000);
  expect((await gn.maintain(env)).reminded).toBe(DAY);
});

test("⏰ after the start it's an ETA on your slip; said-late people who still don't show get a slip", async () => {
  const start = gn.wallToUnix(env, 2026, 11, 6, 20, 0);
  await t.db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: start, reminded: true, message_id: "card" });
  await t.db.insert(rooms).values({ channel_id: "room1", game: "R.E.P.O.", day: DAY, created_at: start });
  presence.snapshot([{ user_id: "a", channel_id: "room1" }]);
  vi.setSystemTime((start + 3 * 60) * 1000);
  const r = await act("b", "late", "15");
  expect(r.notice).toContain("ETA");
  const b = (await late.get(env, DAY, "b"))!;
  expect([b.state, b.eta, !!b.message_id]).toEqual(["eta", start + 18 * 60, true]); // slip posted with the ETA
  expect((await gn.render(env, DAY)) && text(await gn.render(env, DAY))).toContain("Tap your ETA");
  expect((await act("a", "late", "5")).notice).toContain("already here");

  // c said ahead (before the start) they'd be 5 min late, and still isn't here 10 min past that
  await t.db.insert(nightAttendance).values({ day: DAY, user_id: "c", state: "eta", eta: start + 5 * 60 });
  vi.setSystemTime((start + 14 * 60) * 1000);
  expect(await late.watch(env)).toEqual({ arrived: ["a"] });
  vi.setSystemTime((start + 15 * 60) * 1000);
  expect(await late.watch(env)).toEqual({ slipped: ["c"] });
  expect((await late.get(env, DAY, "c"))!.state).toBe("late");
});

test("⏰ late only makes sense on a locked-in night", async () => {
  await gn.startNight(env, "a");
  expect((await act("b", "late", "15")).notice).toContain("Nothing's locked in yet");
});

test("weekends: the daily card goes out at 14:00 on Saturday and Sunday, 17:00 on weekdays", async () => {
  expect([gn.pollHour(env, "2026-11-06"), gn.pollHour(env, "2026-11-07"), gn.pollHour(env, "2026-11-08"), gn.pollHour(env, "2026-11-09")]).toEqual([17, 14, 14, 17]);
  vi.setSystemTime(Date.parse("2026-11-07T12:00:00Z")); // Saturday 14:00 in Vilnius
  expect(await gn.startNight(env)).toMatchObject({ started: true, day: "2026-11-07" });
  vi.setSystemTime(Date.parse("2026-11-09T12:00:00Z")); // Monday 14:00: not yet
  expect(await gn.startNight(env)).toEqual({ skipped: "not poll hour" });
});

test("😴 snooze: no automatic cards until it runs out; starting by hand still works; wake ends it early", async () => {
  vi.setSystemTime(Date.parse("2026-11-06T10:00:00Z")); // Friday 12:00, before today's 17:00 card
  expect(await snooze.snooze(env, "a", "3d")).toContain("Snoozed for 3 days");
  expect((await snooze.current(env))!.until).toBe("2026-11-09"); // Fri, Sat, Sun skipped
  const note = posts().pop()!;
  expect(note.body.content).toContain("<@a> snoozed game night planning for 3 days");
  expect(note.body.allowed_mentions.users).toEqual(["b", "c"]);
  // the next card: Monday at 17:00
  expect(await snooze.nextCard(env)).toBe(gn.wallToUnix(env, 2026, 11, 9, 17, 0));

  vi.setSystemTime(Date.parse("2026-11-06T15:00:00Z")); // Friday 17:00
  expect(await gn.startNight(env)).toEqual({ skipped: "snoozed" });
  vi.setSystemTime(Date.parse("2026-11-08T12:00:00Z")); // Sunday 14:00
  expect(await gn.startNight(env)).toEqual({ skipped: "snoozed" });
  expect(await gn.startNight(env, "b")).toMatchObject({ started: true }); // 🎮 Play today still works
  vi.setSystemTime(Date.parse("2026-11-09T15:00:00Z")); // Monday 17:00: back
  expect(await gn.startNight(env)).toMatchObject({ started: true, day: "2026-11-09" });
  expect(await snooze.current(env)).toBeNull();

  // after today's card, a snooze counts from tomorrow; a month is a calendar month; wake ends it
  await snooze.snooze(env, "c", "month");
  expect((await snooze.current(env))!.until).toBe("2026-12-10");
  expect(text(await snooze.panel(env))).toContain("Planning is snoozed");
  expect(text(await snooze.panel(env))).toContain("snz:wake");
  const active = ((await snooze.panel(env)) as any).components[0].components.find((c: any) => c.type === 1).components;
  expect(active.map((b: any) => b.style)).toEqual([2, 2, 1, 3]); // the month you chose is highlighted
  expect(await snooze.wake(env, "a")).toContain("Back on");
  expect(posts().pop()!.body.content).toContain("<@a> woke game night planning back up");
  expect(await snooze.current(env)).toBeNull();
  expect(text(await snooze.panel(env))).not.toContain("snz:wake");
  expect(await snooze.wake(env, "a")).toContain("isn't snoozed");
});

test("😴 a week, counted from the next card due", async () => {
  vi.setSystemTime(Date.parse("2026-11-06T18:00:00Z")); // Friday 20:00: today's 17:00 card time has passed
  await snooze.snooze(env, "a", "week");
  expect((await snooze.current(env))!.until).toBe("2026-11-14"); // Sat 7th … Fri 13th skipped
  expect(await snooze.nextCard(env)).toBe(gn.wallToUnix(env, 2026, 11, 14, 14, 0)); // Saturday: 14:00
});

test("a tap on an out-of-date copy says what changed; the card follows the start", async () => {
  await gn.startNight(env, "a");
  for (const u of ["b", "c"]) await act(u, "yes");
  for (const u of ["a", "b", "c"]) await act(u, "game", "Palworld");
  expect((await act("a", "game", "R.E.P.O.")).notice).toBe("The game's already picked: **Palworld** 🎮");
  expect((await act("b", "no")).notice).toContain("past that step");
  const at20 = gn.wallToUnix(env, 2026, 11, 6, 20, 0);
  for (const u of ["a", "b", "c"]) await act(u, "time", String(at20));
  expect((await act("a", "time", String(at20))).notice).toContain("The time's already set: **20:00**");
  expect(text(await gn.render(env, DAY))).toContain("we wait for you");
  vi.setSystemTime(at20 * 1000);
  await gn.maintain(env);
  const cardId = (await night())!.message_id;
  const card = calls.filter((c) => c.method === "PATCH" && c.path.endsWith(`/messages/${cardId}`)).pop()!;
  expect(JSON.stringify(card.body)).toContain("Tap your ETA"); // refreshed at the start
});

test("⏰ edge cases: a take-back after the planned time starts it now; late-sayers get the usual grace", async () => {
  const start = gn.wallToUnix(env, 2026, 11, 6, 20, 0);
  await t.db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: start, message_id: "card" });
  vi.setSystemTime((start - 5 * 60) * 1000);
  await act("a", "late", "60"); // 21:00
  await act("b", "late", "5"); // 20:05, start stays 21:00
  expect((await night())!.start_at).toBe(start + 3600);
  vi.setSystemTime((start + 40 * 60) * 1000); // 20:40: a takes it back
  await act("a", "late", "60");
  const n = (await night())!;
  expect(n.start_at).toBe(start + 41 * 60); // not 20:05 (35 min ago, never started): a minute from now
  vi.setSystemTime(n.start_at! * 1000);
  expect((await gn.maintain(env)).reminded).toBe(DAY);
  // b said 20:05; the night started at 20:41: b gets the same 10 minutes as everyone
  await t.db.insert(rooms).values({ channel_id: "room1", game: "R.E.P.O.", day: DAY, created_at: n.start_at! });
  presence.snapshot([]);
  vi.setSystemTime((n.start_at! + 5 * 60) * 1000);
  expect((await late.watch(env)).slipped ?? []).not.toContain("b");
  vi.setSystemTime((n.start_at! + 10 * 60) * 1000);
  expect((await late.watch(env)).slipped).toContain("b");
});

test("⏰ a start moved after the timer looked doesn't get claimed at the old time", async () => {
  const start = gn.wallToUnix(env, 2026, 11, 6, 20, 0);
  await t.db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: start, message_id: "card" });
  const stale = (await night())!;
  await t.db.update(gameNights).set({ start_at: start + 900 }); // someone tapped +15 meanwhile
  vi.setSystemTime(start * 1000);
  await gn.maintain(env); // the catch-up uses fresh rows, so nothing is due yet
  expect((await night())!.reminded).toBe(false);
  expect(await gn.startOnTime(env, stale)).toBe(false);
  expect((await night())!.reminded).toBe(false);
});

test("😴 during the poll hour, a card not posted yet still counts as today's", async () => {
  vi.setSystemTime(Date.parse("2026-11-06T15:20:00Z")); // Friday 17:20, no card yet
  await snooze.snooze(env, "a", "3d");
  expect((await snooze.current(env))!.until).toBe("2026-11-09"); // Fri, Sat, Sun: 3 days, not 4
  await snooze.wake(env, "a");
  expect(await snooze.nextCard(env)).toBe(Date.parse("2026-11-06T15:21:00Z") / 1000); // within the minute, not tomorrow
});

// ---------------------------------------------------------------- 🔒 private panels stay live

/** A real tap through the interaction handler: from the card, or from your panel (`panel` = its message id). */
const tap = async (user: string, action: string, opts: { panel?: string; value?: string } = {}) => {
  const out = (await interaction(
    {
      type: 3,
      token: `tok-${user}-${opts.panel ?? "card"}`,
      data: { custom_id: `gn:${DAY}:${action}`, component_type: opts.value ? 3 : 2, values: opts.value ? [opts.value] : undefined },
      message: opts.panel ? { id: opts.panel, flags: (1 << 15) | 64 } : { id: "card", flags: 1 << 15 },
      member: { user: { id: user, username: user } },
    },
    env,
  )) as any;
  await drain(10_000);
  return out;
};
const panelEdits = () => calls.filter((c) => c.method === "PATCH" && c.path.startsWith("/webhooks/app/"));

test("private panels follow the card: one person's vote moves everyone's open panel on", async () => {
  await gn.startNight(env);
  // a and b answer from the card: each gets a new private panel, which the bot keeps track of
  expect((await tap("a", "yes")).type).toBe(4);
  expect((await tap("b", "yes")).type).toBe(4);
  const tracked = await t.db.select().from(panels);
  expect(tracked.map((p) => [p.user_id, p.token]).sort()).toEqual([
    ["a", "tok-a-card"],
    ["b", "tok-b-card"],
  ]);
  calls.length = 0;
  // c's yes moves the night to picking a game: a's and b's panels show the game picker, no tap needed
  await tap("c", "yes");
  expect((await night())!.stage).toBe("game");
  const edits = panelEdits().filter((e) => !e.path.includes("tok-c-")); // c's own new panel may or may not be in this round
  expect(edits.map((e) => e.path).sort()).toEqual(["/webhooks/app/tok-a-card/messages/@original", "/webhooks/app/tok-b-card/messages/@original"]);
  for (const e of edits) {
    expect(text(e.body)).toContain(`gn:${DAY}:game`); // the game dropdown
    expect(e.body.flags & 64).toBe(0); // an edit can't (and needn't) set "ephemeral" again
  }

  // a picks in their panel, then b picks from the card: a's panel moves on to the time picker
  const pa = tracked.find((p) => p.user_id === "a")!.message_id;
  expect((await tap("a", "game", { panel: pa, value: "Palworld" })).type).toBe(7);
  await tap("b", "game", { value: "Palworld" });
  calls.length = 0;
  await tap("c", "game", { value: "Palworld" });
  expect((await night())!.stage).toBe("time");
  const aPanel = panelEdits().filter((e) => e.path.includes("tok-a-"));
  expect(aPanel.length).toBeGreaterThan(0);
  expect(text(aPanel.at(-1)!.body)).toContain(`gn:${DAY}:custom`); // ✏️ Other time: the time picker
});

test("a tap on your own panel keeps its note when the panels sync", async () => {
  await gn.startNight(env);
  await tap("a", "yes");
  const pa = (await t.db.select().from(panels))[0].message_id;
  await tap("b", "yes");
  await tap("c", "yes");
  await act("a", "game", "Palworld");
  await act("b", "game", "Palworld");
  await act("c", "game", "Palworld");
  calls.length = 0;
  // a's panel still had the game picker open somewhere: picking again says why, on the time picker
  const r = await tap("a", "game", { panel: pa, value: "R.E.P.O." });
  expect(text(r.data)).toContain("already picked");
  const synced = panelEdits().filter((e) => e.path.includes("tok-a-"));
  expect(synced.length).toBeGreaterThan(0);
  expect(text(synced.at(-1)!.body)).toContain("already picked"); // not wiped by the sync
  expect((await t.db.select().from(panels)).find((p) => p.message_id === pa)!.token).toBe(`tok-a-${pa}`); // renewed
});

test("panels past Discord's 15 minutes, or dismissed, are let go", async () => {
  await gn.startNight(env);
  await tap("a", "yes");
  await tap("b", "yes");
  vi.setSystemTime(Date.parse("2026-11-06T15:15:00Z")); // 15 min on: a's and b's taps can't edit anymore
  calls.length = 0;
  await tap("c", "maybe");
  expect(panelEdits().filter((e) => !e.path.includes("tok-c-"))).toEqual([]);
  expect((await t.db.select().from(panels)).map((p) => p.user_id)).toEqual(["c"]);
  // c dismisses the panel: Discord says it's gone, so it's dropped
  const realMock = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) =>
    String(url).includes("/webhooks/app/tok-c-") && init.method === "PATCH" ? new Response("{}", { status: 404 }) : realMock(url, init)) as typeof fetch;
  await gn.refresh(env, DAY);
  expect(await t.db.select().from(panels)).toEqual([]);
});

test("private poll copies follow the poll too: once it's decided, everyone's copy shows the result", async () => {
  const id = await polls.createPoll(env, "a", "Pizza?", "Yes\nNo");
  await polls.setMessage(env, id, "gn", "poll-msg");
  const vote = async (user: string, choice: string) => {
    const out = (await interaction(
      { type: 3, token: `ptok-${user}`, data: { custom_id: `poll:${id}:${choice}`, component_type: 2 }, message: { id: "poll-msg", flags: 1 << 15 }, member: { user: { id: user, username: user } } },
      env,
    )) as any;
    await drain(10_000);
    return out;
  };
  expect((await vote("a", "0")).type).toBe(4); // a's private copy
  await vote("b", "0");
  expect((await t.db.select().from(panels)).map((p) => p.card)).toEqual([`poll:${id}`, `poll:${id}`]);
  calls.length = 0;
  await vote("c", "1"); // 2 of 3: Yes wins, and a's and b's copies say so without another tap
  const edits = panelEdits().filter((e) => !e.path.includes("ptok-c"));
  expect(edits.map((e) => e.path).sort()).toEqual(["/webhooks/app/ptok-a/messages/@original", "/webhooks/app/ptok-b/messages/@original"]);
  for (const e of edits) expect(text(e.body)).toContain("✅ Decided: Yes"); // no stale answer buttons left
});

test("😴 asked ahead: the last snoozed day sleeps, the day it runs out is back", async () => {
  vi.setSystemTime(Date.parse("2026-11-06T10:00:00Z")); // Friday 12:00
  await snooze.snooze(env, "a", "3d"); // until Monday the 9th
  expect(await snooze.isSnoozed(env, "2026-11-06")).toBe(true);
  expect(await snooze.isSnoozed(env, "2026-11-08")).toBe(true);
  expect(await snooze.isSnoozed(env, "2026-11-09")).toBe(false);
  expect(await snooze.isSnoozed(env, "2026-11-10")).toBe(false);
});

test("a nudge someone deleted by hand doesn't stop the next one", async () => {
  await gn.startNight(env, "a"); // b and c hear that a wants to play
  const first = (await night())!.nudge_id!;
  expect(first).toBeTruthy();
  h.override = (c) => (c.method === "DELETE" && c.path === `/channels/gn/messages/${first}` ? json({ message: "Unknown Message", code: 10008 }, 404) : undefined);
  for (const u of ["b", "c"]) await act(u, "yes");
  const n = (await night())!;
  expect(n.stage).toBe("game");
  expect(n.nudge_id).toBeTruthy();
  expect(n.nudge_id).not.toBe(first);
  expect(posts().at(-1)!.body.content).toContain("Everyone's in! What are we playing?");
});

test("start times stay secret until everyone has picked", async () => {
  await gn.startNight(env, "a");
  for (const u of ["b", "c"]) await act(u, "yes");
  for (const u of ["a", "b", "c"]) await act(u, "game", "Palworld");
  expect((await night())!.stage).toBe("time");
  await act("a", "time", String(gn.wallToUnix(env, 2026, 11, 6, 20, 0)));
  const card = text(await gn.render(env, DAY));
  expect(card).toContain("🗳️ <@a>");
  expect(card).not.toContain("from **20:00**");
  expect(card).toContain("Picks stay secret");
});

test("🏁 the leave-by box comes filled in with your current one", async () => {
  await gn.startNight(env, "a");
  for (const u of ["b", "c"]) await act(u, "yes");
  for (const u of ["a", "b", "c"]) await act(u, "game", "Palworld");
  await act("b", "until", "22:30");
  expect(JSON.stringify(await gn.leaveByModal(env, DAY, "b"))).toContain('"value":"22:30"');
  expect(JSON.stringify(await gn.leaveByModal(env, DAY, "c"))).not.toContain('"value":"');
});

test("⏰ a later start moves the Discord event, and its new end is remembered", async () => {
  const start = gn.wallToUnix(env, 2026, 11, 6, 20, 0);
  await t.db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: start, message_id: "card", event_id: "ev1", event_end: start + 600 });
  await act("b", "late", "30");
  const moved = start + 1800;
  const ev = calls.find((c) => c.method === "PATCH" && c.path.endsWith("/scheduled-events/ev1"))!;
  expect(ev.body).toEqual({ scheduled_start_time: new Date(moved * 1000).toISOString(), scheduled_end_time: new Date((moved + 900) * 1000).toISOString() });
  expect(await night()).toMatchObject({ start_at: moved, event_end: moved + 900 });
});
