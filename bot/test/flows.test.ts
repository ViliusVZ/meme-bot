// End-to-end flows against a real Postgres, with Discord stubbed: game night from "are we
// playing?" to the start ping, secret ballots, reopen, split re-votes, polls, rooms, latecomers,
// memes. Catches query mistakes long before the live QA suite does.
import { expect, it } from "@effect/vitest";
import { eq } from "drizzle-orm";
import { Effect, Fiber, Random } from "effect";
import { GameNight, deadlineFor, type Deferred } from "../src/gamenight.js";
import { Nights } from "../src/nights.js";
import { Games } from "../src/games.js";
import { Polls } from "../src/polls.js";
import { Voice } from "../src/voice.js";
import { LateSlips } from "../src/late.js";
import { Attendances } from "../src/attendance.js";
import { Memes } from "../src/memes.js";
import { Jobs } from "../src/jobs.js";
import { Presence } from "../src/presence.js";
import * as roasts from "../src/roasts.js";
import * as memeshame from "../src/memeshame.js";
import { Snoozes } from "../src/snooze.js";
import { Interactions } from "../src/interactions.js";
import { Db } from "../src/db/db.js";
import { nowIso, nowSec } from "../src/clock.js";
import { pollHourOf, wallToUnixIn } from "../src/localtime.js";
import { gameNights, gameNightVotes, games, memes as memeTable, nightAttendance, panels, roastBags, rooms, polls as pollTable, pollVotes, settings, votes } from "../src/db/schema.js";
import { harness, json, routes } from "./fx.js";

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

const DAY = "2026-11-06";
const text = (m: any): string => JSON.stringify(m);
const posts = () => calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages"));

// wall-clock times in the bot's zone (pure; the assertions read `gn.wallToUnix(env, …)`)
const gn = { wallToUnix: (env: { TIMEZONE: string }, y: number, m: number, d: number, hour: number, minute: number) => wallToUnixIn(env.TIMEZONE, y, m, d, hour, minute) };
const env = { get TIMEZONE() { return h.config.timezone; } };
const wall = (y: number, m: number, d: number, hour: number, minute: number) => gn.wallToUnix(env, y, m, d, hour, minute);

/** A tap's slow side effects (events, pings): started at once, waited for before the tap returns (as `settle`). */
type Later = Parameters<Deferred>[0];
type Pending = Fiber.Fiber<unknown, Effect.Error<Later>>[];
const later =
  (pending: Pending): Deferred =>
  (e) =>
    Effect.map(Effect.forkDetach(e), (f) => void pending.push(f));
const settle = (pending: Pending) =>
  Effect.gen(function* () {
    while (pending.length) yield* Fiber.joinAll(pending.splice(0));
  });
const actOn = (pending: Pending, day: string, user: string, action: string, value?: string) => GameNight.use((g) => g.act(day, user, action, value, later(pending)));
const act = (user: string, action: string, value?: string) =>
  Effect.gen(function* () {
    const pending: Pending = [];
    const r = yield* actOn(pending, DAY, user, action, value);
    yield* settle(pending);
    return r;
  });
const night = () => Nights.use((n) => n.get(DAY));
const render = (day: string, viewer?: string) => GameNight.use((g) => g.render(day, viewer));
const startNight = (by?: string, anyHour = false, forDay?: string) => GameNight.use((g) => g.startNight(by, anyHour, forDay));
const maintain = GameNight.use((g) => g.maintain);

it.effect("17:00 posts one card per day, however many times it runs", () =>
  Effect.gen(function* () {
    h.race("two daily jobs at once; whether both get as far as posting depends on timing", { mask: { game_nights: ["message_id"] } });
    const [a, b] = yield* Effect.all([startNight(), startNight()], { concurrency: "unbounded" });
    expect([a, b].filter((r) => "started" in r && r.started).length).toBe(1);
    // if both got as far as posting, the loser deletes its copy at once
    const deleted = calls.filter((c) => c.method === "DELETE" && c.path.includes("/messages/")).length;
    expect(posts().length - deleted).toBe(1);
    expect((yield* night())!.message_id).toBeTruthy();
    const before = posts().length;
    yield* h.setTime(Date.parse("2026-11-06T16:00:00Z")); // 18:00: not poll hour, nothing new
    expect(yield* startNight()).toMatchObject({ started: false });
    expect(posts().length).toBe(before);
  }).pipe(h.provide),
);

it.effect("three people planning the same day at once: one card, and only whoever claimed it is in", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const day = "2026-11-10";
    h.race("three startNight calls at once; whichever claims the day first wins", { mask: { game_nights: ["started_by", "message_id", "nudge_id"], game_night_votes: ["user_id"] }, bodies: false });
    const rs = yield* Effect.all(
      ["a", "b", "c"].map((u) => startNight(u, true, day)),
      { concurrency: "unbounded" },
    );
    expect(rs.filter((r) => "started" in r && r.started).length).toBe(1);
    const n = (yield* Nights.use((x) => x.get(day)))!;
    const yes = yield* db.select().from(gameNightVotes);
    // the others get pointed at the card like anyone planning it later; nobody is in by accident
    expect(yes.map((v) => [v.user_id, v.choice])).toEqual([[n.started_by, "yes"]]);
    expect(n.stage).toBe("ask");
  }).pipe(h.provide),
);

it.effect("the whole night: secret answers → game → time → locked in → started on the dot", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* startNight("a"); // /playtoday: a is in
    let card = text(yield* render(DAY));
    expect(card).toContain("🤫 Answers stay secret");
    yield* act("b", "yes");
    // b's private panel: their answer, and one button to switch; only b sees it
    const mine = (yield* render(DAY, "b")) as any;
    expect(mine.flags & 64).toBe(64);
    expect(text(mine)).toContain("You're **in**");
    expect(text(mine)).not.toContain("Are we playing"); // not a second copy of the card
    const buttons = mine.components[0].components.find((c: any) => c.type === 1).components;
    expect(buttons.map((b: any) => [b.label, b.style])).toEqual([
      ["Change to Maybe", 1],
      ["Change to Not today", 4],
    ]);
    expect(((yield* render(DAY)) as any).flags & 64).toBe(0); // the public card isn't
    yield* act("c", "yes");
    expect((yield* night())!.stage).toBe("game");

    yield* act("a", "game", "R.E.P.O.");
    card = text(yield* render(DAY));
    expect(card).not.toContain("← <@a>"); // still secret
    yield* act("b", "game", "R.E.P.O.");
    expect((yield* night())!.stage).toBe("game"); // two votes aren't enough: everyone gets a say
    const picked = ((yield* render(DAY, "a")) as any).components[0].components.find((c: any) => c.type === 1 && c.components[0].type === 3).components[0];
    expect(picked.options.filter((o: any) => o.default).map((o: any) => o.value)).toEqual(["R.E.P.O."]);
    yield* act("c", "game", "Palworld");
    const n = (yield* night())!;
    expect([n.stage, n.game]).toEqual(["time", "R.E.P.O."]);
    card = text(yield* render(DAY));
    expect(card).toContain("R.E.P.O.** ← <@a> <@b>"); // revealed once decided
    expect(posts().some((p) => p.body.content?.includes("Everyone's voted"))).toBe(true);

    const at19 = wall(2026, 11, 6, 19, 0);
    const at20 = wall(2026, 11, 6, 20, 0);
    yield* act("a", "time", String(at19));
    yield* act("b", "time", String(at20));
    yield* act("c", "until", "23:00");
    yield* act("c", "time", String(at19));
    const set = (yield* night())!;
    expect([set.stage, set.start_at]).toEqual(["set", at20]); // the latest pick wins
    expect(set.event_id).toBeTruthy();
    expect(set.event_end).toBe(gn.wallToUnix(env, 2026, 11, 6, 23, 0));
    expect((yield* db.select().from(games)).find((g) => g.name === "R.E.P.O.")!.plays).toBe(0); // not played yet
    card = text(yield* render(DAY));
    expect(card).toContain("Slowpoke of the night: <@b>");

    // two starters racing (the timer and the minute job): exactly one start
    yield* h.setTime(at20 * 1000);
    const before = posts().length;
    const [x, y] = yield* Effect.all([maintain, maintain], { concurrency: "unbounded" });
    expect([x, y].filter((r) => r.reminded).length).toBe(1);
    const startPing = posts().slice(before).filter((p) => text(p.body).includes("starts now"));
    expect(startPing.length).toBe(1);
    expect((yield* db.select().from(rooms)).length).toBe(1); // the game room opened
    expect((yield* db.select().from(games)).find((g) => g.name === "R.E.P.O.")!.plays).toBe(1); // now it counts
  }).pipe(h.provide),
);

it.effect("a clash pings once, and never locks", () =>
  Effect.gen(function* () {
    yield* startNight("a");
    yield* act("b", "yes");
    yield* act("c", "yes");
    for (const u of ["a", "b", "c"]) yield* act(u, "game", "Palworld");
    yield* act("a", "until", "20:30");
    const at20 = wall(2026, 11, 6, 20, 0);
    yield* act("a", "time", String(wall(2026, 11, 6, 19, 0)));
    yield* act("b", "time", String(at20));
    yield* act("c", "time", String(at20));
    expect((yield* night())!.stage).toBe("time");
    const warnings = () => posts().filter((p) => text(p.body).includes("don't fit"));
    expect(warnings().length).toBe(1);
    yield* act("c", "time", String(at20)); // tap again: takes it back
    yield* act("c", "time", String(at20)); // same clash again: no second ping
    expect(warnings().length).toBe(1);
    expect(text(yield* render(DAY))).toContain("Doesn't fit yet");
  }).pipe(h.provide),
);

it.effect("a three-way split reveals the picks and stays open for a re-vote; two agreeing settles it", () =>
  Effect.gen(function* () {
    yield* startNight("a");
    yield* act("b", "yes");
    yield* act("c", "yes");
    yield* act("a", "game", "R.E.P.O.");
    yield* act("b", "game", "Phasmophobia");
    yield* act("c", "game", "Palworld");
    expect((yield* night())!.stage).toBe("game");
    const card = text(yield* render(DAY));
    expect(card).toContain("Split vote");
    expect(card).toContain("R.E.P.O.** ← <@a>"); // revealed so you can talk it out
    expect(posts().filter((p) => p.body.content?.includes("Split vote")).length).toBe(1);
    yield* act("c", "game", "Phasmophobia"); // c gives in
    const n = (yield* night())!;
    expect([n.stage, n.game]).toEqual(["time", "Phasmophobia"]);
  }).pipe(h.provide),
);

it.effect("a split that never resolves: last call for everyone, then the night's off (nobody roasted)", () =>
  Effect.gen(function* () {
    yield* startNight("a");
    yield* act("b", "yes");
    yield* act("c", "yes");
    yield* act("a", "game", "R.E.P.O.");
    yield* act("b", "game", "Phasmophobia");
    yield* act("c", "game", "Palworld");
    const opened = (yield* night())!.stage_at!;
    yield* h.setTime((opened + 3 * 3600 - 20 * 60) * 1000);
    yield* maintain;
    expect(posts().some((p) => p.body.content?.includes("Still split"))).toBe(true);
    yield* h.setTime((opened + 3 * 3600 + 60) * 1000);
    yield* maintain;
    const n = (yield* night())!;
    expect([n.stage, n.roast]).toEqual(["off", null]);
    expect(n.note).toContain("couldn't agree");
  }).pipe(h.provide),
);

it.effect("polls: secret until everyone's voted, then most votes wins; your answer is highlighted on your copy", () =>
  Effect.gen(function* () {
    const polls = yield* Polls;
    const id = yield* polls.create("a", "Pizza?", "Yes\nNo");
    yield* polls.act(id, "a", "0");
    yield* polls.act(id, "b", "0");
    expect(text(yield* polls.render(id))).not.toContain("█"); // 2 of 3 isn't the end any more
    const mine = (yield* polls.render(id, "a")) as any;
    expect(mine.flags & 64).toBe(64);
    const buttons = mine.components[0].components.find((c: any) => c.type === 1).components;
    expect(buttons.map((b: any) => b.style)).toEqual([3, 2, 2]); // Yes (mine), No, Close
    yield* polls.act(id, "c", "1");
    const card = text(yield* polls.render(id));
    expect(card).toContain("Decided: Yes");
    expect(card).toContain("<@a> <@b>");
    expect((yield* polls.act(id, "c", "0")).notice).toContain("already decided");
  }).pipe(h.provide),
);

it.effect("polls: tapping your vote again takes it back; a split stays open until one answer leads", () =>
  Effect.gen(function* () {
    const polls = yield* Polls;
    const id = yield* polls.create("a", "Where?", "A\nB\nC");
    yield* polls.act(id, "a", "0");
    expect((yield* polls.act(id, "a", "0")).notice).toContain("Took your vote back");
    yield* polls.act(id, "a", "0");
    yield* polls.act(id, "b", "1");
    yield* polls.act(id, "c", "2");
    let card = text(yield* polls.render(id));
    expect(card).toContain("Split vote");
    expect(card).toContain("█"); // revealed
    expect((yield* polls.act(id, "a", "close")).notice).toContain("Still split");
    yield* polls.act(id, "c", "1");
    card = text(yield* polls.render(id));
    expect(card).toContain("Decided: B");
  }).pipe(h.provide),
);

it.effect("reopen starts the day over; reset wipes it", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* startNight("a");
    yield* act("b", "yes");
    yield* act("c", "yes");
    expect((yield* night())!.stage).toBe("game");
    yield* act("c", "out");
    expect((yield* night())!.stage).toBe("off");
    yield* act("b", "reopen");
    const n = (yield* night())!;
    expect([n.stage, n.started_by]).toEqual(["ask", "b"]);
    expect((yield* db.select().from(gameNightVotes)).map((v) => [v.user_id, v.choice])).toEqual([["b", "yes"]]);
    expect(yield* GameNight.use((g) => g.resetNight(DAY))).toEqual({ reset: true });
    expect(yield* night()).toBeNull();
  }).pipe(h.provide),
);

it.effect("midnight closes an unfinished card; the roast waits for the morning", () =>
  Effect.gen(function* () {
    const gn = yield* GameNight;
    yield* startNight("a"); // 17:00
    yield* h.setTime(Date.parse("2026-11-06T22:30:00Z")); // 00:30 Saturday (17:00's 20:00 deadline was missed: no minute job ran)
    expect(yield* gn.closeStale).toEqual([DAY]);
    const n = (yield* night())!;
    expect(n.stage).toBe("off");
    expect(n.roast!.who).toEqual({ b: "ghost", c: "ghost" });
    expect(n.roast_due).toBe(Date.parse("2026-11-07T07:30:00Z") / 1000); // 09:30 Saturday
    expect(yield* gn.dueRoasts).toEqual([]); // not at night
    yield* h.setTime(Date.parse("2026-11-07T07:31:00Z"));
    expect(yield* gn.dueRoasts).toEqual([DAY]);
    expect(yield* gn.dueRoasts).toEqual([]); // once
  }).pipe(h.provide),
);

// ---------------------------------------------------------------- 🔥 deadlines and roasts

const roastPosts = () => posts().filter((p) => p.body.content?.startsWith("🔥"));

it.effect("a no stays secret until everyone's answered, then the night's off and the no-sayer is roasted", () =>
  Effect.gen(function* () {
    yield* startNight("a");
    yield* act("b", "no");
    expect((yield* night())!.stage).toBe("ask"); // a no alone doesn't end it
    expect(text(yield* render(DAY))).toContain("🤫 Answers stay secret");
    expect(text(yield* render(DAY))).toContain("Vote by");
    yield* act("c", "yes");
    const n = (yield* night())!;
    expect([n.stage, n.roast!.who]).toEqual(["off", { b: "no" }]);
    const [r] = roastPosts();
    expect(r.body.content).toMatch(/^🔥 \*\*Tonight's game night is off\*\* · <@b> ❌ said no\n> .*<@b>/);
    expect(r.body.allowed_mentions.users.sort()).toEqual(["a", "b", "c"]);
    const card = text(yield* render(DAY));
    expect(card).toContain("How everyone voted"); // revealed
    expect(card).toContain("Reopen");
  }).pipe(h.provide),
);

it.effect("3 h after voting opens: last call at 2.5 h, then non-voters (and no-sayers) are roasted", () =>
  Effect.gen(function* () {
    yield* startNight("a"); // 17:00
    yield* act("b", "no");
    yield* h.setTime(Date.parse("2026-11-06T17:29:00Z")); // 19:29
    yield* maintain;
    expect(posts().some((p) => p.body.content?.includes("Last call"))).toBe(false);
    yield* h.setTime(Date.parse("2026-11-06T17:31:00Z")); // 19:31
    yield* maintain;
    const warn = posts().filter((p) => p.body.content?.includes("Last call"));
    expect(warn.length).toBe(1);
    expect(warn[0].body.content).toMatch(/^<@c> ⏳ Last call: 29 min/);
    yield* maintain;
    expect(posts().filter((p) => p.body.content?.includes("Last call")).length).toBe(1); // once
    yield* h.setTime(Date.parse("2026-11-06T18:00:00Z")); // 20:00
    yield* maintain;
    const n = (yield* night())!;
    expect([n.stage, n.roast!.who]).toEqual(["off", { b: "no", c: "ghost" }]);
    expect(roastPosts()[0].body.content).toContain("<@b> ❌ said no · <@c> 👻 didn't vote in time");
  }).pipe(h.provide),
);

// ---------------------------------------------------------------- 🤔 maybe

const maybeButton = (m: any) => text(m).includes(`gn:${DAY}:maybe`);

it.effect("🤔 a maybe holds it for 2 h once everyone's answered, then the unsure get an hour to answer", () =>
  Effect.gen(function* () {
    yield* startNight("a"); // 17:00
    yield* act("c", "maybe");
    expect((yield* night())!).toMatchObject({ stage: "ask", maybes: 0, paused_until: null }); // the others haven't answered
    expect(text(yield* render(DAY))).toContain("🤫 Answers stay secret");
    expect(text(yield* render(DAY, "c"))).toContain("You said **maybe**");
    yield* act("b", "yes");
    let n = (yield* night())!;
    const at19 = wall(2026, 11, 6, 19, 0);
    expect([n.stage, n.maybes, n.paused_until]).toEqual(["ask", 1, at19]);
    let card = text(yield* render(DAY));
    expect(card).toContain("✅ <@a>　✅ <@b>　🤔 <@c>"); // everyone answered, so it's out
    expect(card).toContain("**On hold**");
    expect(card).not.toContain("Vote by"); // no deadline while it's on hold
    const held = posts().find((p) => p.body.content?.includes("isn't sure yet"))!;
    expect(held.body.content).toMatch(/^<@a> <@b> 🤔 <@c> isn't sure yet, so it's on hold until/);
    expect(held.body.allowed_mentions.users).toEqual(["a", "b"]); // the sure ones hear why they wait

    yield* h.setTime(Date.parse("2026-11-06T16:59:00Z")); // 18:59: still on hold
    yield* maintain;
    expect((yield* night())!.paused_until).toBe(at19);
    yield* h.setTime(Date.parse("2026-11-06T17:00:00Z")); // 19:00: the unsure are asked again
    yield* maintain;
    yield* maintain; // once
    n = (yield* night())!;
    expect([n.stage, n.maybes, n.paused_until, n.stage_at]).toEqual(["ask", 1, null, at19]);
    const again = posts().filter((p) => p.body.content?.includes("Decision time"));
    expect(again.length).toBe(1);
    expect(again[0].body.content).toMatch(/^<@c> ⏰ Decision time: are you in tonight\?/);
    expect(again[0].body.allowed_mentions.users).toEqual(["c"]);
    card = text(yield* render(DAY));
    expect(card).toContain("✅ <@a>　✅ <@b>　⏳ <@c>"); // the yeses carry over
    expect(card).toContain(`Vote by <t:${at19 + 3600}:t>`); // an hour to answer
    expect(maybeButton(yield* render(DAY))).toBe(true); // one more maybe is allowed
    yield* act("c", "yes");
    expect((yield* night())!.stage).toBe("game");
  }).pipe(h.provide),
);

it.effect("🤔 a second maybe holds it 1 h more; then it's yes or no, and no answer gets you roasted", () =>
  Effect.gen(function* () {
    yield* startNight("a");
    yield* act("b", "yes");
    yield* act("c", "maybe"); // on hold until 19:00
    yield* h.setTime(Date.parse("2026-11-06T17:00:00Z")); // 19:00
    yield* maintain;
    yield* act("c", "maybe"); // the yeses are still in, so that's everyone again: on hold until 20:00
    let n = (yield* night())!;
    expect([n.maybes, n.paused_until]).toEqual([2, gn.wallToUnix(env, 2026, 11, 6, 20, 0)]);
    expect(text(yield* render(DAY))).toContain("This is the last hold");
    yield* h.setTime(Date.parse("2026-11-06T18:00:00Z")); // 20:00: final call
    yield* maintain;
    expect(posts().some((p) => p.body.content?.startsWith("<@c> ⏰ Final call"))).toBe(true);
    const card = yield* render(DAY);
    expect(text(card)).toContain("⏰ Final call! Are we playing today?");
    expect(maybeButton(card)).toBe(false);
    expect(maybeButton(yield* render(DAY, "c"))).toBe(false);
    const r = yield* act("c", "maybe"); // an old panel
    expect(r.notice).toContain("No more maybes");
    expect(text(yield* render(DAY, "c"))).toContain("Final call: are you in tonight? No more maybes."); // not counted
    yield* h.setTime(Date.parse("2026-11-06T18:31:00Z")); // 20:31: last call
    yield* maintain;
    expect(posts().filter((p) => p.body.content?.includes("Last call")).map((p) => p.body.content)).toEqual([expect.stringMatching(/^<@c> ⏳ Last call: 29 min/)]);
    yield* h.setTime(Date.parse("2026-11-06T19:00:00Z")); // 21:00
    yield* maintain;
    n = (yield* night())!;
    expect([n.stage, n.roast!.who]).toEqual(["off", { c: "ghost" }]);
  }).pipe(h.provide),
);

it.effect("🤔 a no beats a maybe, also during a hold; reopening starts the holds over", () =>
  Effect.gen(function* () {
    yield* startNight("a");
    yield* act("c", "maybe");
    yield* act("b", "no"); // everyone's answered: no hold, the no wins
    let n = (yield* night())!;
    expect([n.stage, n.maybes, n.roast!.who]).toEqual(["off", 0, { b: "no" }]);
    expect(text(yield* render(DAY))).toContain("🤔 <@c>");

    yield* act("a", "reopen");
    yield* act("b", "yes");
    yield* act("c", "maybe");
    expect((yield* night())!.maybes).toBe(1);
    yield* act("b", "no"); // changed their mind while on hold
    n = (yield* night())!;
    expect([n.stage, n.paused_until, n.roast!.who]).toEqual(["off", null, { b: "no" }]);
    yield* act("a", "reopen");
    expect((yield* night())!).toMatchObject({ stage: "ask", maybes: 0, paused_until: null });
  }).pipe(h.provide),
);

it.effect("🤔 a maybe who turns yes during the hold starts it right away; holds never end in the small hours", () =>
  Effect.gen(function* () {
    yield* startNight("a");
    yield* act("b", "yes");
    yield* act("c", "maybe");
    yield* act("c", "yes");
    expect((yield* night())!).toMatchObject({ stage: "game", paused_until: null });

    // tomorrow, planned at 22:00: 2 h later would be midnight, so it waits until 09:30
    yield* h.setTime(Date.parse("2026-11-06T20:00:00Z"));
    const SAT = "2026-11-07";
    yield* startNight("a", true, SAT);
    const pending: Pending = [];
    yield* actOn(pending, SAT, "b", "yes");
    yield* actOn(pending, SAT, "c", "maybe");
    yield* settle(pending);
    expect((yield* Nights.use((x) => x.get(SAT)))!.paused_until).toBe(gn.wallToUnix(env, 2026, 11, 7, 9, 30));
  }).pipe(h.provide),
);

it.effect("game and time picks have the same deadline", () =>
  Effect.gen(function* () {
    yield* startNight("a");
    yield* act("b", "yes");
    yield* act("c", "yes");
    yield* act("a", "game", "Palworld");
    yield* h.setTime(Date.parse("2026-11-06T18:01:00Z")); // 3 h later, b and c never picked
    yield* maintain;
    expect((yield* night())!.roast!.who).toEqual({ b: "ghost", c: "ghost" });
  }).pipe(h.provide),
);

it.effect("all three out: the bot sulks alone", () =>
  Effect.gen(function* () {
    yield* startNight(); // the 17:00 schedule: nobody's in yet
    yield* h.setTime(Date.parse("2026-11-06T18:00:00Z"));
    yield* maintain;
    const [r] = roastPosts();
    expect(r.body.content).toMatch(/^🔥 \*\*Nobody's in, so tonight's game night is off\*\*\n> /);
    expect(roasts._pools.TRIO.some((l) => r.body.content.endsWith(roasts.fill(l, ["a", "b", "c"])))).toBe(true);
  }).pipe(h.provide),
);

it.effect("bailing with 🚪 gets you roasted, also after the night was locked in", () =>
  Effect.gen(function* () {
    yield* startNight("a");
    yield* act("b", "yes");
    yield* act("c", "yes");
    yield* act("b", "out");
    expect((yield* night())!.roast!.who).toEqual({ b: "out" });
    expect(roastPosts()[0].body.content).toContain("<@b> 🚪 bailed");
  }).pipe(h.provide),
);

it.effect("deadlines: never in the small hours, and planned days get until noon on the day", () =>
  Effect.gen(function* () {
    const w = { zone: h.config.timezone, now: yield* nowSec };
    const at = (iso: string) => Date.parse(iso) / 1000;
    // opened 23:00 today → 02:00 → moved to 09:30
    expect(deadlineFor(w, { day: DAY, stage_at: at("2026-11-06T21:00:00Z") })).toBe(at("2026-11-07T07:30:00Z"));
    // opened 17:00 → 20:00
    expect(deadlineFor(w, { day: DAY, stage_at: at("2026-11-06T15:00:00Z") })).toBe(at("2026-11-06T18:00:00Z"));
    // Friday planned on Monday 10:00 → noon Friday
    expect(deadlineFor(w, { day: DAY, stage_at: at("2026-11-02T08:00:00Z") })).toBe(at("2026-11-06T10:00:00Z"));
    // tomorrow planned at 22:00 → 01:00 would be night, but noon tomorrow is later anyway
    expect(deadlineFor(w, { day: "2026-11-07", stage_at: at("2026-11-06T20:00:00Z") })).toBe(at("2026-11-07T10:00:00Z"));
  }).pipe(h.provide),
);

it.effect("reopening drops a roast still waiting for the morning", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* startNight("a");
    yield* h.setTime(Date.parse("2026-11-06T21:30:00Z")); // 23:30: deadline was 20:00
    yield* maintain;
    // (23:30 is awake time, so it posted; force a held one to check reopen clears it)
    yield* db.update(gameNights).set({ roasted_at: null, roast_due: Date.parse("2026-11-07T07:30:00Z") / 1000 });
    yield* act("c", "reopen");
    const n = (yield* night())!;
    expect([n.stage, n.roast, n.roast_due]).toEqual(["ask", null, null]);
  }).pipe(h.provide),
);

it.effect("roast lines rotate: no repeats until the pool is used up", () =>
  Effect.gen(function* () {
    const bag = yield* roasts.Roasts;
    const { lines } = roasts.poolFor(["b"]);
    const seen = new Set<string>();
    for (let i = 0; i < lines.length; i++) seen.add(yield* bag.next(["b"]));
    expect(seen.size).toBe(lines.length);
  }).pipe(h.provide),
);

it.effect("roast rotation is shared: a line used on one person doesn't come up for another in the same cycle", () =>
  Effect.gen(function* () {
    const bag = yield* roasts.Roasts;
    const [V, K, L] = ["306836805825593344", "212567787896307713", "747902984003780651"];
    const { SOLO, PERSONAL, DUO, PAIRS } = roasts._pools;
    // whatever order people sink nights in, nothing repeats until a culprit runs out of fitting lines,
    // which takes at least (generic lines + their own lines) draws
    const drawn: string[] = [];
    const minSolo = SOLO.length + Math.min(...Object.values(PERSONAL).map((x) => x.length));
    for (let i = 0; i < minSolo; i++) {
      const p = roasts.poolFor([[V, K, L][Math.floor((yield* Random.next) * 3)]]);
      drawn.push(yield* bag.draw(p.key, p.all, p.lines));
    }
    expect(new Set(drawn).size).toBe(drawn.length);

    const pairs = [[V, K], [V, L], [K, L]];
    const duo: string[] = [];
    for (let i = 0; i < DUO.length + Math.min(...Object.values(PAIRS).map((x) => x.length)); i++) {
      const p = roasts.poolFor(pairs[i % 3]);
      duo.push(yield* bag.draw(p.key, p.all, p.lines));
    }
    expect(new Set(duo).size).toBe(duo.length);
    // personal lines only ever land on their own person
    for (const l of drawn) if (!SOLO.includes(l)) expect(Object.values(PERSONAL).filter((x) => x.includes(l)).length).toBe(1);
  }).pipe(h.provide),
);

it.effect("roast rotation: a full cycle, then a fresh one that doesn't open with the last line", () =>
  Effect.gen(function* () {
    const bag = yield* roasts.Roasts;
    const K = "212567787896307713";
    const p = roasts.poolFor([K]);
    const cycle: string[] = [];
    for (let i = 0; i < p.lines.length; i++) cycle.push(yield* bag.draw(p.key, p.all, p.lines));
    expect(new Set(cycle).size).toBe(p.lines.length); // every line that fits Koral, once
    const first = yield* bag.draw(p.key, p.all, p.lines);
    expect(first).not.toBe(cycle[cycle.length - 1]);
  }).pipe(h.provide),
);

it.effect("roast rotation survives edits: stale queue entries (old indices, removed lines) are dropped", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db.insert(roastBags).values({ pool: "trio", queue: [0, 3, "a line that was deleted"], last_line: null });
    const line = yield* roasts.Roasts.use((r) => r.draw("trio", roasts._pools.TRIO, roasts._pools.TRIO));
    expect(roasts._pools.TRIO).toContain(line);
  }).pipe(h.provide),
);

it.effect("every line is unique within its family (rotation goes by the text)", () =>
  Effect.gen(function* () {
    const { SOLO_ALL, DUO_ALL, TRIO } = roasts._pools;
    for (const fam of [SOLO_ALL, DUO_ALL, TRIO, memeshame.ALL]) expect(new Set(fam).size).toBe(fam.length);
  }).pipe(h.provide),
);

it.effect("meme call-outs share one bag too", () =>
  Effect.gen(function* () {
    const bag = yield* roasts.Roasts;
    const [V, K, L] = ["306836805825593344", "212567787896307713", "747902984003780651"];
    const drawn: string[] = [];
    for (let i = 0; i < memeshame.LINES.length + 3; i++) {
      const u = [V, K, L][i % 3];
      drawn.push(yield* bag.draw("memes", memeshame.ALL, memeshame.fitsFor(u)));
    }
    expect(new Set(drawn).size).toBe(drawn.length);
  }).pipe(h.provide),
);

it.effect("roast pools: personal lines join the right pools", () =>
  Effect.gen(function* () {
    const [V, K, L] = ["306836805825593344", "212567787896307713", "747902984003780651"];
    expect(roasts.poolFor([K]).lines.some((l) => l.includes("fap and nap"))).toBe(true);
    expect(roasts.poolFor([L]).lines.some((l) => l.includes("Pūkis"))).toBe(true);
    expect(roasts.poolFor([V]).lines.some((l) => l.includes("merge conflict"))).toBe(true);
    expect(roasts.poolFor([K, L]).key).toBe(roasts.poolFor([L, K]).key);
    expect(roasts.poolFor([V, K, L]).key).toBe("trio");
    for (const l of roasts.poolFor([K, L]).lines) expect(roasts.fill(l, [K, L])).not.toMatch(/\{\w+\}/);
  }).pipe(h.provide),
);

it.effect("rooms: one room per game even when two open at once; archived after 15 empty minutes", () =>
  Effect.gen(function* () {
    const voice = yield* Voice;
    h.race("two openRoom calls at once; which one's channel is kept depends on timing", { mask: { rooms: ["channel_id", "game", "created_by"] }, calls: false });
    yield* Presence.use((p) => p.snapshot([])); // nobody in voice
    const [a, b] = yield* Effect.all([voice.openRoom("R.E.P.O.", "📦", { by: "a" }), voice.openRoom("r.e.p.o.", "📦", { by: "b" })], { concurrency: "unbounded" });
    expect(a.channelId).toBe(b.channelId);
    expect(calls.filter((c) => c.method === "POST" && c.path.endsWith("/channels")).length).toBe(1);
    const now = yield* nowSec;
    yield* voice.leftRoom(a.channelId, now);
    let r = yield* voice.checkRooms(new Set(), now + 60);
    expect(r).toEqual({ archived: [], nextDue: now + 15 * 60 });
    r = yield* voice.checkRooms(new Set(), now + 15 * 60);
    expect(r.archived.map((g) => g.toLowerCase())).toEqual(["r.e.p.o."]);
    // the next game night of that game brings the archived room back
    const again = yield* voice.openRoom("R.E.P.O.", "📦", { day: DAY });
    expect([again.channelId, again.reused]).toEqual([a.channelId, true]);
  }).pipe(h.provide),
);

it.effect("latecomers: pulled in from the Lobby once; a slip after 10 minutes otherwise", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const late = yield* LateSlips;
    const start = wall(2026, 11, 6, 20, 0);
    yield* db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: start, reminded: true, message_id: "card" });
    yield* db.insert(rooms).values({ channel_id: "room1", game: "R.E.P.O.", day: DAY, created_at: start });
    yield* Presence.use((p) => p.snapshot([{ user_id: "a", channel_id: "lobby" }]));
    yield* h.setTime((start + 60) * 1000);
    expect(yield* late.watch).toEqual({ moved: ["a"] });
    expect(calls.some((c) => c.method === "PATCH" && c.path.endsWith("/members/a") && c.body.channel_id === "room1")).toBe(true);
    yield* h.setTime((start + 11 * 60) * 1000);
    yield* Presence.use((p) => p.update("a", "room1"));
    const r = yield* late.watch;
    expect(r).toEqual({ slipped: ["b", "c"] }); // a already counts as arrived (we moved them)
    expect(yield* late.watch).toEqual({}); // no second slip
    yield* late.act(DAY, "b", "b", "15");
    expect((yield* Attendances.use((x) => x.get(DAY, "b")))!.state).toBe("eta");
    expect((yield* late.act(DAY, "b", "c", "out")).notice).toContain("not your late slip");
  }).pipe(h.provide),
);

it.effect("memes: one daily per day even when posted twice at once; votes toggle; streaks", () =>
  Effect.gen(function* () {
    const memes = yield* Memes;
    yield* h.setTime(Date.parse("2026-11-06T11:00:00Z"));
    yield* memes.ingest([
      { id: "t3_a", title: "A", image: "i", link: "l", author: "u", published: "2026-11-05T08:00:00Z", rank: 2 },
      { id: "t3_b", title: "B", image: "i", link: "l", author: "u", published: "2026-11-05T09:00:00Z", rank: 1 },
    ]);
    const postDaily = Jobs.use((j) => j.postDaily);
    const [x, y] = yield* Effect.all([postDaily, postDaily], { concurrency: "unbounded" });
    expect([x, y].filter((r) => "posted" in r).map((r) => (r as any).posted)).toEqual(["t3_b"]);
    expect(yield* memes.castVote("t3_b", "a", "fire")).toBe("new");
    expect(yield* memes.castVote("t3_b", "a", "lol")).toBe("changed");
    expect(yield* memes.tally("t3_b")).toEqual({ lol: 1 });
    expect(yield* memes.voters("t3_b")).toEqual({ lol: ["a"] });
    expect(yield* memes.castVote("t3_b", "a", "lol")).toBe("removed");
    expect(yield* memes.bumpStreak("a", "A")).toBe(1);
    expect(yield* memes.bumpStreak("a", "A")).toBeNull();
    yield* memes.castVote("t3_b", "a", "fire");
    yield* memes.castVote("t3_b", "b", "fire");
    const top = yield* memes.leaderboard(null, null, 5);
    expect([top[0].id, top[0].score, top[0].votes]).toEqual(["t3_b", 6, 2]);
    const s = yield* memes.userStats("a");
    expect([s.kinds.fire, s.agree.total, s.agree.agreed]).toEqual([1, 1, 1]);
    expect(yield* memes.claimRecap("week:x")).toBe(true);
    expect(yield* memes.claimRecap("week:x")).toBe(false);
  }).pipe(h.provide),
);

it.effect("games are case-insensitive, most played first", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const gs = yield* Games;
    expect(yield* gs.add("  phasmophobia ", "a")).toBe("Phasmophobia");
    expect(yield* gs.add("Lethal Company", "a")).toBe("Lethal Company");
    yield* db.update(games).set({ plays: 5 }).where(eq(games.name, "Palworld"));
    expect((yield* gs.list(25)).map((g) => g.name)).toEqual(["Palworld", "R.E.P.O.", "Phasmophobia", "Lethal Company"]);
    yield* gs.remove("lethal company");
    expect((yield* gs.list(25)).length).toBe(3);
  }).pipe(h.provide),
);

it.effect("all of us or none of us: a bail after the start calls the night off for everyone", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const late = yield* LateSlips;
    const start = wall(2026, 11, 6, 20, 0);
    yield* db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: start, reminded: true, message_id: "card", event_id: "ev1" });
    yield* db.insert(rooms).values({ channel_id: "room1", game: "R.E.P.O.", day: DAY, created_at: start });
    yield* Presence.use((p) => p.snapshot([]));
    yield* h.setTime((start + 11 * 60) * 1000);
    yield* late.watch; // everyone gets a slip
    const slips = Object.fromEntries((yield* db.select().from(nightAttendance)).map((r) => [r.user_id, r.message_id]));
    yield* late.act(DAY, "b", "b", "out"); // 😴 on b's slip
    const n = (yield* night())!;
    expect([n.stage, n.roast!.who]).toEqual(["off", { b: "out" }]);
    expect(calls.some((c) => c.method === "PATCH" && c.path.endsWith("/scheduled-events/ev1") && c.body.status === 3)).toBe(true); // live event ended
    const roast = roastPosts()[0];
    expect(roast.body.content).toMatch(/^🔥 \*\*📦 R\.E\.P\.O\. tonight is off\*\* · <@b> 🚪 bailed\n> /);
    expect(roast.body.allowed_mentions.users.sort()).toEqual(["a", "b", "c"]); // everyone hears it's off
    // everyone else's "running late?" slip now says it's off; b's says they bailed
    const edited = (id: string) => calls.filter((c) => c.method === "PATCH" && c.path.endsWith(`/messages/${id}`)).pop()!.body.components[0].content;
    expect(edited(slips.a!)).toContain("game night's off");
    expect(edited(slips.b!)).toContain("<@b> bailed");
    expect((yield* late.act(DAY, "c", "c", "15")).notice).toContain("Game night's off");
  }).pipe(h.provide),
);

it.effect("the card's 🚪 after the start does the same", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const start = wall(2026, 11, 6, 20, 0);
    yield* db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: start, reminded: true, message_id: "card" });
    yield* h.setTime((start + 5 * 60) * 1000);
    yield* act("c", "out");
    expect((yield* night())!.roast!.who).toEqual({ c: "out" });
    expect(roastPosts().length).toBe(1);
  }).pipe(h.provide),
);

it.effect("starting or planning by hand pings the other two; stage changes ping everyone", () =>
  Effect.gen(function* () {
    yield* startNight("a"); // /playtoday
    const start = posts().find((p) => p.body.content?.includes("wants to play"))!;
    expect(start.body.content).toBe("<@b> <@c> 🎮 <@a> wants to play tonight! Are you in? ⬆️");
    yield* act("b", "yes");
    yield* act("c", "yes");
    const next = posts().find((p) => p.body.content?.includes("Everyone's in"))!;
    expect(next.body.content.startsWith("<@a> <@b> <@c>")).toBe(true); // c clicked last and still hears it
  }).pipe(h.provide),
);

it.effect("your copy: your own leave-by is 'You', and starts that clash with it are greyed out", () =>
  Effect.gen(function* () {
    yield* startNight("a");
    yield* act("b", "yes");
    yield* act("c", "yes");
    for (const u of ["a", "b", "c"]) yield* act(u, "game", "Palworld");
    yield* act("a", "until", "20:30");
    const mine = (yield* render(DAY, "a")) as any;
    expect(text(mine)).toContain("You have to leave by **20:30**");
    expect(text(yield* render(DAY, "b"))).toContain("Someone has to leave by");
    const buttons = mine.components[0].components.filter((c: any) => c.type === 1).flatMap((r: any) => r.components);
    const t = (hm: string) => buttons.find((b: any) => b.label === hm);
    expect(t("19:00").disabled).toBeUndefined();
    expect(t("20:00").disabled).toBe(true); // 20:00 → 20:30 is under an hour
  }).pipe(h.provide),
);

it.effect("polls: one vote can't be closed into a decision", () =>
  Effect.gen(function* () {
    const polls = yield* Polls;
    const id = yield* polls.create("a", "Q?", "A\nB");
    yield* polls.act(id, "a", "0");
    expect((yield* polls.act(id, "a", "close")).notice).toContain("One vote isn't a decision");
    yield* polls.act(id, "b", "0");
    yield* polls.act(id, "a", "close");
    expect(yield* polls.isClosed(id)).toBe(true);
  }).pipe(h.provide),
);

it.effect("⏰ running late before the start: we wait, so the start moves to the latest ETA (and back)", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const start = wall(2026, 11, 6, 20, 0);
    yield* db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: start, message_id: "card", event_id: "ev1", event_end: start + 3 * 3600 });
        yield* db.insert(gameNightVotes).values({ day: DAY, stage: "until", user_id: "c", choice: String(start + 75 * 60), voted_at: yield* nowIso }); // c leaves at 21:15
    yield* h.setTime((start - 15 * 60) * 1000); // 19:45: a and b realise they'll be late
    const card = text(yield* render(DAY));
    expect(card).toContain("Running late?");
    expect(card).toContain(`gn:${DAY}:late:15`);

    let r = yield* act("a", "late", "15");
    expect(r.notice).toContain("start moved to **20:15**");
    let n = (yield* night())!;
    expect([n.start_at, n.planned_start]).toEqual([start + 15 * 60, start]);
    const moved = posts().pop()!;
    expect(moved.body.content).toContain("<@a> is running 15 min late, so we start at **20:15**");
    expect(moved.body.content).not.toContain("⚠️"); // exactly an hour with c: fine
    expect(moved.body.allowed_mentions.users).toEqual(["b", "c"]); // the others hear it
    const ev = calls.filter((c) => c.method === "PATCH" && c.path.endsWith("/scheduled-events/ev1")).pop()!;
    expect(ev.body.scheduled_start_time).toBe(new Date((start + 15 * 60) * 1000).toISOString());

    // b's later still: the start follows the last one; c's leave-by gets a heads-up
    yield* act("b", "late", "30");
    n = (yield* night())!;
    expect(n.start_at).toBe(start + 30 * 60);
    expect(posts().pop()!.body.content).toContain("⚠️ That leaves 45 min before <@c> has to leave");
    expect(text(yield* render(DAY))).toContain("⏰ Running late: <@a> +15 min · <@b> +30 min · start moved from 20:00");

    // a shorter delay from someone else doesn't move it
    const before = posts().length;
    r = yield* act("c", "late", "5");
    expect(r.notice).toContain("start stays at **20:30**");
    expect(posts().length).toBe(before);

    // tapping your delay again takes it back: start goes to the next latest
    r = yield* act("b", "late", "30");
    expect(r.notice).toContain("Taken back");
    expect((yield* night())!.start_at).toBe(start + 15 * 60);
    expect(posts().pop()!.body.content).toContain("<@b> will be on time after all");

    // the start timer uses the moved start: nothing at 20:00, the start at 20:15
    yield* h.setTime(start * 1000);
    expect((yield* maintain).reminded).toBeUndefined();
    yield* h.setTime((start + 15 * 60) * 1000);
    expect((yield* maintain).reminded).toBe(DAY);
  }).pipe(h.provide),
);

it.effect("⏰ after the start it's an ETA on your slip; said-late people who still don't show get a slip", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const late = yield* LateSlips;
    const slip = (user: string) => Attendances.use((x) => x.get(DAY, user));
    const start = wall(2026, 11, 6, 20, 0);
    yield* db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: start, reminded: true, message_id: "card" });
    yield* db.insert(rooms).values({ channel_id: "room1", game: "R.E.P.O.", day: DAY, created_at: start });
    yield* Presence.use((p) => p.snapshot([{ user_id: "a", channel_id: "room1" }]));
    yield* h.setTime((start + 3 * 60) * 1000);
    const r = yield* act("b", "late", "15");
    expect(r.notice).toContain("ETA");
    const b = (yield* slip("b"))!;
    expect([b.state, b.eta, !!b.message_id]).toEqual(["eta", start + 18 * 60, true]); // slip posted with the ETA
    expect((yield* render(DAY)) && text(yield* render(DAY))).toContain("Tap your ETA");
    expect((yield* act("a", "late", "5")).notice).toContain("already here");

    // c said ahead (before the start) they'd be 5 min late, and still isn't here 10 min past that
    yield* db.insert(nightAttendance).values({ day: DAY, user_id: "c", state: "eta", eta: start + 5 * 60 });
    yield* h.setTime((start + 14 * 60) * 1000);
    expect(yield* late.watch).toEqual({ arrived: ["a"] });
    yield* h.setTime((start + 15 * 60) * 1000);
    expect(yield* late.watch).toEqual({ slipped: ["c"] });
    expect((yield* slip("c"))!.state).toBe("late");
  }).pipe(h.provide),
);

it.effect("⏰ late only makes sense on a locked-in night", () =>
  Effect.gen(function* () {
    yield* startNight("a");
    expect((yield* act("b", "late", "15")).notice).toContain("Nothing's locked in yet");
  }).pipe(h.provide),
);

it.effect("weekends: the daily card goes out at 14:00 on Saturday and Sunday, 17:00 on weekdays", () =>
  Effect.gen(function* () {
    const pollHour = (day: string) => pollHourOf(day, h.config.gamePollHour, h.config.gamePollHourWeekend);
    expect([pollHour("2026-11-06"), pollHour("2026-11-07"), pollHour("2026-11-08"), pollHour("2026-11-09")]).toEqual([17, 14, 14, 17]);
    yield* h.setTime(Date.parse("2026-11-07T12:00:00Z")); // Saturday 14:00 in Vilnius
    expect(yield* startNight()).toMatchObject({ started: true, day: "2026-11-07" });
    yield* h.setTime(Date.parse("2026-11-09T12:00:00Z")); // Monday 14:00: not yet
    expect(yield* startNight()).toEqual({ skipped: "not poll hour" });
  }).pipe(h.provide),
);

it.effect("😴 snooze: no automatic cards until it runs out; starting by hand still works; wake ends it early", () =>
  Effect.gen(function* () {
    const snooze = yield* Snoozes;
    yield* h.setTime(Date.parse("2026-11-06T10:00:00Z")); // Friday 12:00, before today's 17:00 card
    expect(yield* snooze.snooze("a", "3d")).toContain("Snoozed for 3 days");
    expect((yield* snooze.current)!.until).toBe("2026-11-09"); // Fri, Sat, Sun skipped
    const note = posts().pop()!;
    expect(note.body.content).toContain("<@a> snoozed game night planning for 3 days");
    expect(note.body.allowed_mentions.users).toEqual(["b", "c"]);
    // the next card: Monday at 17:00
    expect(yield* snooze.nextCard).toBe(gn.wallToUnix(env, 2026, 11, 9, 17, 0));

    yield* h.setTime(Date.parse("2026-11-06T15:00:00Z")); // Friday 17:00
    expect(yield* startNight()).toEqual({ skipped: "snoozed" });
    yield* h.setTime(Date.parse("2026-11-08T12:00:00Z")); // Sunday 14:00
    expect(yield* startNight()).toEqual({ skipped: "snoozed" });
    expect(yield* startNight("b")).toMatchObject({ started: true }); // 🎮 Play today still works
    yield* h.setTime(Date.parse("2026-11-09T15:00:00Z")); // Monday 17:00: back
    expect(yield* startNight()).toMatchObject({ started: true, day: "2026-11-09" });
    expect(yield* snooze.current).toBeNull();

    // after today's card, a snooze counts from tomorrow; a month is a calendar month; wake ends it
    yield* snooze.snooze("c", "month");
    expect((yield* snooze.current)!.until).toBe("2026-12-10");
    expect(text(yield* snooze.panel())).toContain("Planning is snoozed");
    expect(text(yield* snooze.panel())).toContain("snz:wake");
    const active = ((yield* snooze.panel()) as any).components[0].components.find((c: any) => c.type === 1).components;
    expect(active.map((b: any) => b.style)).toEqual([2, 2, 1, 3]); // the month you chose is highlighted
    expect(yield* snooze.wake("a")).toContain("Back on");
    expect(posts().pop()!.body.content).toContain("<@a> woke game night planning back up");
    expect(yield* snooze.current).toBeNull();
    expect(text(yield* snooze.panel())).not.toContain("snz:wake");
    expect(yield* snooze.wake("a")).toContain("isn't snoozed");
  }).pipe(h.provide),
);

it.effect("😴 a week, counted from the next card due", () =>
  Effect.gen(function* () {
    const snooze = yield* Snoozes;
    yield* h.setTime(Date.parse("2026-11-06T18:00:00Z")); // Friday 20:00: today's 17:00 card time has passed
    yield* snooze.snooze("a", "week");
    expect((yield* snooze.current)!.until).toBe("2026-11-14"); // Sat 7th … Fri 13th skipped
    expect(yield* snooze.nextCard).toBe(gn.wallToUnix(env, 2026, 11, 14, 14, 0)); // Saturday: 14:00
  }).pipe(h.provide),
);

it.effect("a tap on an out-of-date copy says what changed; the card follows the start", () =>
  Effect.gen(function* () {
    yield* startNight("a");
    for (const u of ["b", "c"]) yield* act(u, "yes");
    for (const u of ["a", "b", "c"]) yield* act(u, "game", "Palworld");
    expect((yield* act("a", "game", "R.E.P.O.")).notice).toBe("The game's already picked: **Palworld** 🎮");
    expect((yield* act("b", "no")).notice).toContain("past that step");
    const at20 = wall(2026, 11, 6, 20, 0);
    for (const u of ["a", "b", "c"]) yield* act(u, "time", String(at20));
    expect((yield* act("a", "time", String(at20))).notice).toContain("The time's already set: **20:00**");
    expect(text(yield* render(DAY))).toContain("we wait for you");
    yield* h.setTime(at20 * 1000);
    yield* maintain;
    const cardId = (yield* night())!.message_id;
    const card = calls.filter((c) => c.method === "PATCH" && c.path.endsWith(`/messages/${cardId}`)).pop()!;
    expect(JSON.stringify(card.body)).toContain("Tap your ETA"); // refreshed at the start
  }).pipe(h.provide),
);

it.effect("⏰ edge cases: a take-back after the planned time starts it now; late-sayers get the usual grace", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const late = yield* LateSlips;
    const start = wall(2026, 11, 6, 20, 0);
    yield* db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: start, message_id: "card" });
    yield* h.setTime((start - 5 * 60) * 1000);
    yield* act("a", "late", "60"); // 21:00
    yield* act("b", "late", "5"); // 20:05, start stays 21:00
    expect((yield* night())!.start_at).toBe(start + 3600);
    yield* h.setTime((start + 40 * 60) * 1000); // 20:40: a takes it back
    yield* act("a", "late", "60");
    const n = (yield* night())!;
    expect(n.start_at).toBe(start + 41 * 60); // not 20:05 (35 min ago, never started): a minute from now
    yield* h.setTime(n.start_at! * 1000);
    expect((yield* maintain).reminded).toBe(DAY);
    // b said 20:05; the night started at 20:41: b gets the same 10 minutes as everyone
    yield* db.insert(rooms).values({ channel_id: "room1", game: "R.E.P.O.", day: DAY, created_at: n.start_at! });
    yield* Presence.use((p) => p.snapshot([]));
    yield* h.setTime((n.start_at! + 5 * 60) * 1000);
    expect((yield* late.watch).slipped ?? []).not.toContain("b");
    yield* h.setTime((n.start_at! + 10 * 60) * 1000);
    expect((yield* late.watch).slipped).toContain("b");
  }).pipe(h.provide),
);

it.effect("⏰ a start moved after the timer looked doesn't get claimed at the old time", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const start = wall(2026, 11, 6, 20, 0);
    yield* db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: start, message_id: "card" });
    const stale = (yield* night())!;
    yield* db.update(gameNights).set({ start_at: start + 900 }); // someone tapped +15 meanwhile
    yield* h.setTime(start * 1000);
    yield* maintain; // the catch-up uses fresh rows, so nothing is due yet
    expect((yield* night())!.reminded).toBe(false);
    expect(yield* GameNight.use((g) => g.startOnTime(stale))).toBe(false);
    expect((yield* night())!.reminded).toBe(false);
  }).pipe(h.provide),
);

it.effect("😴 during the poll hour, a card not posted yet still counts as today's", () =>
  Effect.gen(function* () {
    const snooze = yield* Snoozes;
    yield* h.setTime(Date.parse("2026-11-06T15:20:00Z")); // Friday 17:20, no card yet
    yield* snooze.snooze("a", "3d");
    expect((yield* snooze.current)!.until).toBe("2026-11-09"); // Fri, Sat, Sun: 3 days, not 4
    yield* snooze.wake("a");
    expect(yield* snooze.nextCard).toBe(Date.parse("2026-11-06T15:21:00Z") / 1000); // within the minute, not tomorrow
  }).pipe(h.provide),
);

// ---------------------------------------------------------------- 🔒 private panels stay live

/** A real tap through the interaction handler: from the card, or from your panel (`panel` = its message id). */
const tap = (user: string, action: string, opts: { panel?: string; value?: string } = {}) =>
  Effect.gen(function* () {
    const out = (yield* Interactions.use((x) =>
      x.handle({
        type: 3,
        token: `tok-${user}-${opts.panel ?? "card"}`,
        data: { custom_id: `gn:${DAY}:${action}`, component_type: opts.value ? 3 : 2, values: opts.value ? [opts.value] : undefined },
        message: opts.panel ? { id: opts.panel, flags: (1 << 15) | 64 } : { id: "card", flags: 1 << 15 },
        member: { user: { id: user, username: user } },
      }),
    )) as any;
    yield* h.settle;
    return out;
  });
const panelEdits = () => calls.filter((c) => c.method === "PATCH" && c.path.startsWith("/webhooks/app/"));

it.effect("private panels follow the card: one person's vote moves everyone's open panel on", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* startNight();
    // a and b answer from the card: each gets a new private panel, which the bot keeps track of
    expect((yield* tap("a", "yes")).type).toBe(4);
    expect((yield* tap("b", "yes")).type).toBe(4);
    const tracked = yield* db.select().from(panels);
    expect(tracked.map((p) => [p.user_id, p.token]).sort()).toEqual([
      ["a", "tok-a-card"],
      ["b", "tok-b-card"],
    ]);
    calls.length = 0;
    // c's yes moves the night to picking a game: a's and b's panels show the game picker, no tap needed
    yield* tap("c", "yes");
    expect((yield* night())!.stage).toBe("game");
    const edits = panelEdits().filter((e) => !e.path.includes("tok-c-")); // c's own new panel may or may not be in this round
    expect(edits.map((e) => e.path).sort()).toEqual(["/webhooks/app/tok-a-card/messages/@original", "/webhooks/app/tok-b-card/messages/@original"]);
    for (const e of edits) {
      expect(text(e.body)).toContain(`gn:${DAY}:game`); // the game dropdown
      expect(e.body.flags & 64).toBe(0); // an edit can't (and needn't) set "ephemeral" again
    }

    // a picks in their panel, then b picks from the card: a's panel moves on to the time picker
    const pa = tracked.find((p) => p.user_id === "a")!.message_id;
    expect((yield* tap("a", "game", { panel: pa, value: "Palworld" })).type).toBe(7);
    yield* tap("b", "game", { value: "Palworld" });
    calls.length = 0;
    yield* tap("c", "game", { value: "Palworld" });
    expect((yield* night())!.stage).toBe("time");
    const aPanel = panelEdits().filter((e) => e.path.includes("tok-a-"));
    expect(aPanel.length).toBeGreaterThan(0);
    expect(text(aPanel.at(-1)!.body)).toContain(`gn:${DAY}:custom`); // ✏️ Other time: the time picker
  }).pipe(h.provide),
);

it.effect("a tap on your own panel keeps its note when the panels sync", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* startNight();
    yield* tap("a", "yes");
    const pa = (yield* db.select().from(panels))[0].message_id;
    yield* tap("b", "yes");
    yield* tap("c", "yes");
    yield* act("a", "game", "Palworld");
    yield* act("b", "game", "Palworld");
    yield* act("c", "game", "Palworld");
    calls.length = 0;
    // a's panel still had the game picker open somewhere: picking again says why, on the time picker
    const r = yield* tap("a", "game", { panel: pa, value: "R.E.P.O." });
    expect(text(r.data)).toContain("already picked");
    const synced = panelEdits().filter((e) => e.path.includes("tok-a-"));
    expect(synced.length).toBeGreaterThan(0);
    expect(text(synced.at(-1)!.body)).toContain("already picked"); // not wiped by the sync
    expect((yield* db.select().from(panels)).find((p) => p.message_id === pa)!.token).toBe(`tok-a-${pa}`); // renewed
  }).pipe(h.provide),
);

it.effect("panels past Discord's 15 minutes, or dismissed, are let go", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* startNight();
    yield* tap("a", "yes");
    yield* tap("b", "yes");
    yield* h.setTime(Date.parse("2026-11-06T15:15:00Z")); // 15 min on: a's and b's taps can't edit anymore
    calls.length = 0;
    yield* tap("c", "maybe");
    expect(panelEdits().filter((e) => !e.path.includes("tok-c-"))).toEqual([]);
    expect((yield* db.select().from(panels)).map((p) => p.user_id)).toEqual(["c"]);
    // c dismisses the panel: Discord says it's gone, so it's dropped
    const realMock = h.fetch;
    h.fetch = (async (url: string, init: RequestInit = {}) =>
      String(url).includes("/webhooks/app/tok-c-") && init.method === "PATCH" ? new Response("{}", { status: 404 }) : realMock(url, init)) as typeof fetch;
    yield* GameNight.use((g) => g.refresh(DAY));
    expect(yield* db.select().from(panels)).toEqual([]);
  }).pipe(h.provide),
);

it.effect("private poll copies follow the poll too: once it's decided, everyone's copy shows the result", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const polls = yield* Polls;
    const id = yield* polls.create("a", "Pizza?", "Yes\nNo");
    yield* polls.setMessage(id, "gn", "poll-msg");
    const vote = (user: string, choice: string) =>
      Effect.gen(function* () {
        const out = (yield* Interactions.use((x) =>
          x.handle({ type: 3, token: `ptok-${user}`, data: { custom_id: `poll:${id}:${choice}`, component_type: 2 }, message: { id: "poll-msg", flags: 1 << 15 }, member: { user: { id: user, username: user } } }),
        )) as any;
        yield* h.settle;
        return out;
      });
    expect((yield* vote("a", "0")).type).toBe(4); // a's private copy
    yield* vote("b", "0");
    expect((yield* db.select().from(panels)).map((p) => p.card)).toEqual([`poll:${id}`, `poll:${id}`]);
    calls.length = 0;
    yield* vote("c", "1"); // 2 of 3: Yes wins, and a's and b's copies say so without another tap
    const edits = panelEdits().filter((e) => !e.path.includes("ptok-c"));
    expect(edits.map((e) => e.path).sort()).toEqual(["/webhooks/app/ptok-a/messages/@original", "/webhooks/app/ptok-b/messages/@original"]);
    for (const e of edits) expect(text(e.body)).toContain("✅ Decided: Yes"); // no stale answer buttons left
  }).pipe(h.provide),
);

it.effect("😴 asked ahead: the last snoozed day sleeps, the day it runs out is back", () =>
  Effect.gen(function* () {
    const snooze = yield* Snoozes;
    yield* h.setTime(Date.parse("2026-11-06T10:00:00Z")); // Friday 12:00
    yield* snooze.snooze("a", "3d"); // until Monday the 9th
    expect(yield* snooze.isSnoozed("2026-11-06")).toBe(true);
    expect(yield* snooze.isSnoozed("2026-11-08")).toBe(true);
    expect(yield* snooze.isSnoozed("2026-11-09")).toBe(false);
    expect(yield* snooze.isSnoozed("2026-11-10")).toBe(false);
  }).pipe(h.provide),
);

it.effect("a nudge someone deleted by hand doesn't stop the next one", () =>
  Effect.gen(function* () {
    yield* startNight("a"); // b and c hear that a wants to play
    const first = (yield* night())!.nudge_id!;
    expect(first).toBeTruthy();
    h.override = (c) => (c.method === "DELETE" && c.path === `/channels/gn/messages/${first}` ? json({ message: "Unknown Message", code: 10008 }, 404) : undefined);
    for (const u of ["b", "c"]) yield* act(u, "yes");
    const n = (yield* night())!;
    expect(n.stage).toBe("game");
    expect(n.nudge_id).toBeTruthy();
    expect(n.nudge_id).not.toBe(first);
    expect(posts().at(-1)!.body.content).toContain("Everyone's in! What are we playing?");
  }).pipe(h.provide),
);

it.effect("start times stay secret until everyone has picked", () =>
  Effect.gen(function* () {
    yield* startNight("a");
    for (const u of ["b", "c"]) yield* act(u, "yes");
    for (const u of ["a", "b", "c"]) yield* act(u, "game", "Palworld");
    expect((yield* night())!.stage).toBe("time");
    yield* act("a", "time", String(wall(2026, 11, 6, 20, 0)));
    const card = text(yield* render(DAY));
    expect(card).toContain("🗳️ <@a>");
    expect(card).not.toContain("from **20:00**");
    expect(card).toContain("Picks stay secret");
  }).pipe(h.provide),
);

it.effect("🏁 the leave-by box comes filled in with your current one", () =>
  Effect.gen(function* () {
    const leaveByModal = (user: string) => GameNight.use((g) => g.leaveByModal(DAY, user));
    yield* startNight("a");
    for (const u of ["b", "c"]) yield* act(u, "yes");
    for (const u of ["a", "b", "c"]) yield* act(u, "game", "Palworld");
    yield* act("b", "until", "22:30");
    expect(JSON.stringify(yield* leaveByModal("b"))).toContain('"value":"22:30"');
    expect(JSON.stringify(yield* leaveByModal("c"))).not.toContain('"value":"');
  }).pipe(h.provide),
);

it.effect("⏰ a later start moves the Discord event, and its new end is remembered", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const start = wall(2026, 11, 6, 20, 0);
    yield* db.insert(gameNights).values({ day: DAY, stage: "set", game: "R.E.P.O.", start_at: start, message_id: "card", event_id: "ev1", event_end: start + 600 });
    yield* act("b", "late", "30");
    const moved = start + 1800;
    const ev = calls.find((c) => c.method === "PATCH" && c.path.endsWith("/scheduled-events/ev1"))!;
    expect(ev.body).toEqual({ scheduled_start_time: new Date(moved * 1000).toISOString(), scheduled_end_time: new Date((moved + 900) * 1000).toISOString() });
    expect(yield* night()).toMatchObject({ start_at: moved, event_end: moved + 900 });
  }).pipe(h.provide),
);
