// 🐌 Late answerers (streaks.ts): late cards counted in a row and over the window, the stand-in for
// cards from before the bot kept track (production's real history), the tier an extra roast comes
// from, one slip getting the plain reminder, and a broken streak said once on the next card.
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { chases, gameNights, gameNightVotes, roastBags, streakBreaks } from "../src/db/schema.js";
import { Db } from "../src/db/db.js";
import { GameNight } from "../src/gamenight.js";
import { K, L, V } from "../src/roasts.js";
import { _latePools, standingOf, Streaks, tierFor, type Card } from "../src/streaks.js";
import { harness, routes } from "./fx.js";

const h = harness({
  tables: [chases, streakBreaks, gameNightVotes, gameNights, roastBags],
  discord: { firstId: 5000, routes: [routes.noVoiceState, routes.lobbyOnly] },
  env: { PLAYERS: [V, K, L].join(",") },
  clock: "2026-11-23T16:30:00Z", // Monday 18:30 in Vilnius
});
const posts = () => h.calls.filter((c) => c.method === "POST" && c.path === "/channels/gn/messages");
const maintain = GameNight.use((g) => g.maintain);

/** A tracked card (from TRACKED_FROM on): who was chased on it. */
const card = (day: string, chased: string[], ghost?: string): Card => ({
  day,
  started_by: null,
  roast: ghost ? { who: { [ghost]: "ghost" }, stage: "ask" } : null,
  chased,
  votes: [],
  posted: 0,
});

it("the streak is late cards in a row, the window the late ones among the last 14; a reminder counts its own card", () => {
  // newest first: late, late, late (a 👻, never chased), on time, late, late, on time, on time, late, then on time
  const late = [1, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1];
  const cards = late.map((l, i) => card(`2026-12-${String(31 - i).padStart(2, "0")}`, l ? [V] : [], i === 2 ? V : undefined));
  expect(standingOf(cards, V)).toEqual({ streak: 3, late: 6, of: 14 });
  expect(standingOf(cards, V, true)).toEqual({ streak: 4, late: 7, of: 14 });
  expect(standingOf(cards, K, true)).toEqual({ streak: 1, late: 1, of: 14 });
  expect(standingOf([], K, true)).toEqual({ streak: 1, late: 1, of: 1 });
});

it("the tier: 2–3, 4–6, 7+ in a row, or late at least every other time; one slip gets nothing", () => {
  const tier = (streak: number, late: number, of: number) => tierFor({ streak, late, of });
  expect([tier(1, 1, 14), tier(1, 1, 1), tier(1, 6, 14), tier(1, 2, 5)]).toEqual([null, null, null, null]);
  expect([tier(1, 7, 14), tier(1, 3, 6)]).toEqual(["habit", "habit"]);
  expect([tier(2, 2, 14), tier(3, 3, 3), tier(4, 4, 14), tier(6, 9, 14), tier(7, 7, 14), tier(15, 14, 14)]).toEqual(["two", "two", "four", "four", "seven", "seven"]);
  // every line names them and carries their numbers
  const lines = Object.values(_latePools).flatMap((p) => [...p.lines, ...Object.values(p.of).flat()]);
  expect(lines.filter((l) => !/\{(n|nth|late)\}/.test(l) || !l.includes("{who}"))).toEqual([]);
});

/** Production's game nights 2026-11-08 to 11-14, as they are (before the bot kept track). */
type Night = typeof gameNights.$inferInsert;
const PRODUCTION: { nights: Night[]; votes: [string, string, string, string, string][] } = {
  nights: [
    { day: "2026-11-08", stage: "off", reminded: false, maybes: 1, roast: { who: { [L]: "ghost" }, stage: "ask" } },
    { day: "2026-11-09", stage: "set", reminded: true },
    { day: "2026-11-10", stage: "off", reminded: false, roast: { who: { [L]: "no" }, stage: "ask" } },
    { day: "2026-11-11", stage: "off", reminded: false, roast: { who: { [K]: "no", [V]: "no" }, stage: "ask" } },
    { day: "2026-11-12", stage: "set", reminded: true },
    { day: "2026-11-13", stage: "off", reminded: false, roast: { who: { [K]: "no", [L]: "no" }, stage: "ask" } },
    { day: "2026-11-14", stage: "set", reminded: true, maybes: 1 },
  ],
  votes: [
    ["2026-11-08", "ask", K, "yes", "2026-11-08T14:56:11.368Z"],
    ["2026-11-08", "ask", V, "maybe", "2026-11-08T17:19:42.500Z"],
    ["2026-11-09", "ask", V, "yes", "2026-11-09T15:00:14.909Z"],
    ["2026-11-09", "ask", K, "yes", "2026-11-09T15:09:17.573Z"],
    ["2026-11-09", "ask", L, "yes", "2026-11-09T16:00:07.791Z"],
    ["2026-11-09", "game", V, "World of Warcraft", "2026-11-09T16:00:22.524Z"],
    ["2026-11-09", "game", L, "World of Warcraft", "2026-11-09T16:00:23.972Z"],
    ["2026-11-09", "game", K, "World of Warcraft", "2026-11-09T16:00:25.619Z"],
    ["2026-11-09", "time", V, "1794243600", "2026-11-09T16:00:33.787Z"],
    ["2026-11-09", "time", K, "1794247200", "2026-11-09T16:00:35.223Z"],
    ["2026-11-09", "time", L, "1794249000", "2026-11-09T16:00:37.483Z"],
    ["2026-11-10", "ask", K, "yes", "2026-11-10T15:00:18.773Z"],
    ["2026-11-10", "ask", V, "yes", "2026-11-10T15:37:03.620Z"],
    ["2026-11-10", "ask", L, "no", "2026-11-10T15:37:26.457Z"],
    ["2026-11-11", "ask", V, "no", "2026-11-11T15:01:05.075Z"],
    ["2026-11-11", "ask", L, "yes", "2026-11-11T15:59:25.026Z"],
    ["2026-11-11", "ask", K, "no", "2026-11-11T16:00:34.197Z"],
    ["2026-11-12", "ask", V, "yes", "2026-11-12T15:00:16.224Z"],
    ["2026-11-12", "ask", K, "yes", "2026-11-12T15:00:54.903Z"],
    ["2026-11-12", "ask", L, "yes", "2026-11-12T15:42:33.004Z"],
    ["2026-11-12", "game", L, "World of Warcraft", "2026-11-12T15:42:36.976Z"],
    ["2026-11-12", "game", V, "World of Warcraft", "2026-11-12T15:45:22.108Z"],
    ["2026-11-12", "game", K, "World of Warcraft", "2026-11-12T16:13:32.065Z"],
    ["2026-11-12", "time", K, "1794502800", "2026-11-12T16:13:45.401Z"],
    ["2026-11-12", "time", V, "1794502800", "2026-11-12T16:13:52.288Z"],
    ["2026-11-12", "time", L, "1794501000", "2026-11-12T16:14:43.555Z"],
    ["2026-11-13", "ask", V, "yes", "2026-11-13T15:00:07.773Z"],
    ["2026-11-13", "ask", K, "no", "2026-11-13T15:00:22.537Z"],
    ["2026-11-13", "ask", L, "no", "2026-11-13T15:31:12.999Z"],
    ["2026-11-14", "ask", K, "yes", "2026-11-14T12:00:14.344Z"],
    ["2026-11-14", "ask", V, "yes", "2026-11-14T13:00:16.409Z"],
    ["2026-11-14", "ask", L, "yes", "2026-11-14T17:03:59.955Z"],
    ["2026-11-14", "game", L, "World of Warcraft", "2026-11-14T17:04:03.959Z"],
    ["2026-11-14", "game", V, "World of Warcraft", "2026-11-14T17:04:07.181Z"],
    ["2026-11-14", "game", K, "World of Warcraft", "2026-11-14T17:04:08.944Z"],
    ["2026-11-14", "time", L, "1794679200", "2026-11-14T17:04:12.850Z"],
    ["2026-11-14", "time", V, "1794676500", "2026-11-14T17:04:22.165Z"],
    ["2026-11-14", "time", K, "1794676200", "2026-11-14T17:04:51.448Z"],
  ],
};

it.effect("the backfill: before tracking, a 👻 or a vote over an hour after its step opened is late (production's real week)", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db.insert(gameNights).values(PRODUCTION.nights);
    yield* db.insert(gameNightVotes).values(PRODUCTION.votes.map(([day, stage, user_id, choice, voted_at]) => ({ day, stage, user_id, choice, voted_at })));
    // 11-08: Koral answered at 16:56 (card at 14:00), Ieva a 👻, Vithis's 🤔 isn't timed · 11-09: Ieva
    // 1 h 0 min 7 s after the card · 11-11: Koral 1 h 0 min 34 s (Ieva's 59 min is on time) · 11-14:
    // Vithis 1 h 0 min 16 s, Ieva 5 h after. The game and time votes were all quick.
    expect(yield* Streaks.use((s) => s.standings("2026-11-15"))).toEqual({
      [V]: { streak: 1, late: 1, of: 7 },
      [K]: { streak: 0, late: 2, of: 7 },
      [L]: { streak: 1, late: 3, of: 7 },
    });
  }).pipe(h.provide),
);

/** Finished cards on these days with whoever was chased, and today's (11-23) card asking since 17:00. */
const history = (days: Record<string, string[]>) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db.insert(gameNights).values(Object.keys(days).map((day) => ({ day, stage: "off" as const, reminded: false })));
    const rows = Object.entries(days).flatMap(([day, who]) => who.map((user_id) => ({ day, user_id, at: 0 })));
    if (rows.length) yield* db.insert(chases).values(rows);
  });

it.effect("a reminder roasts the repeat offender extra (first reminder of the card only); one slip gets the plain one, pings unchanged", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* history({ "2026-11-21": [L], "2026-11-22": [L] });
    yield* db.insert(gameNights).values({ day: "2026-11-23", stage: "ask", reminded: false, message_id: "card", stage_at: Date.parse("2026-11-23T15:00:00Z") / 1000 });
    yield* db.insert(gameNightVotes).values({ day: "2026-11-23", stage: "ask", user_id: K, choice: "yes", voted_at: "2026-11-23T15:01:00Z" });
    yield* maintain; // 18:30: Vithis (on time both times before) and Ieva (late both) still haven't answered
    const [nudge] = posts();
    const [ping, ...extra] = nudge.body.content.split("\n");
    expect(ping).toBe(`<@${V}> <@${L}> ⏳ still waiting on you: are you in tonight? ⬆️`);
    expect(extra).toHaveLength(1); // Ieva's third card running; nothing for Vithis
    expect(extra[0]).toMatch(/^> /);
    expect(extra[0]).toContain(`<@${L}>`);
    expect(extra[0]).not.toContain(`<@${V}>`);
    expect(extra[0].replace(/<@\d+>/g, "")).toMatch(/third|\b3\b/);
    expect(nudge.body.allowed_mentions).toEqual({ users: [V, L] });
    expect((yield* db.select().from(chases)).filter((c) => c.day === "2026-11-23").map((c) => c.user_id).sort()).toEqual([V, L].sort());
    // the last call on the same card: the plain one
    yield* h.setTime("2026-11-23T17:31:00Z");
    yield* maintain;
    const last = posts().at(-1)!;
    expect(last.body.content).toMatch(/^<@\d+> <@\d+> ⏳ Last call: 29 min/);
    expect(last.body.content).not.toContain("\n");
  }).pipe(h.provide),
);

it.effect("answering on time ends the streak: the next card says so once", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    // Ieva late on 11-20 and 11-21, on time on 11-22
    yield* history({ "2026-11-20": [L], "2026-11-21": [L], "2026-11-22": [] });
    const start = (day: string) => GameNight.use((g) => g.startNight(undefined, true, day));
    yield* start("2026-11-23");
    const card = JSON.stringify(posts()[0].body);
    const broke = card.match(/-# 🏅 [^"]*/g) ?? [];
    expect(broke).toHaveLength(1); // Ieva's only
    expect(broke[0]).toContain(`<@${L}>`);
    expect((broke[0] ?? "").replace(/<@\d+>/g, "")).toMatch(/\b2\b/); // the streak that ended
    // re-rendered, the card still says it; a card planned for later doesn't say it again
    expect(JSON.stringify(yield* GameNight.use((g) => g.render("2026-11-23")))).toContain("🏅");
    yield* start("2026-11-25");
    expect(JSON.stringify(posts()[1].body)).not.toContain("🏅");
    expect((yield* db.select().from(streakBreaks)).map((b) => [b.user_id, b.broken_on, b.card_day, b.streak])).toEqual([[L, "2026-11-22", "2026-11-23", 2]]);
  }).pipe(h.provide),
);
