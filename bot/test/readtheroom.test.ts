// 🎧 Reading the room (19 Nov): nobody is chased while they sit in voice with the others, and the
// game and time steps send no reminders of their own; a step with a pick closes on its own.
import { expect, it } from "@effect/vitest";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { gameNights, gameNightVotes, games, settings, voiceSegments, lobbyPrompts, rooms, sessions, fleeting, nightCards, nightAttendance, readyRooms, gameAliases, activityGuesses } from "../src/db/schema.js";
import { Db } from "../src/db/db.js";
import { GameNight } from "../src/gamenight.js";
import { Presence } from "../src/presence.js";
import { harness, routes } from "./fx.js";

const h = harness({
  tables: [gameNights, gameNightVotes, games, settings, voiceSegments, lobbyPrompts, rooms, sessions, fleeting, nightCards, nightAttendance, readyRooms, gameAliases, activityGuesses],
  seed: (t) => t.db.insert(games).values([{ name: "World of Warcraft", emoji: "⚔️", added_at: "x", plays: 3 }]),
  discord: { firstId: 80000, routes: [routes.noVoiceState, routes.lobbyOnly] },
  clock: "test",
});
const calls = h.calls;
const DAY = "2026-11-12";
const at = (local: string) => Date.parse(`${DAY}T${local}+02:00`) / 1000;
const gn = () => calls.filter((c) => c.method === "POST" && c.path === "/channels/gn/messages");

const setUp = (stage: "ask" | "time", opened: number) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db.insert(gameNights).values({ day: DAY, stage, game: stage === "time" ? "World of Warcraft" : null, message_id: "card", stage_at: opened });
    const iso = new Date(opened * 1000).toISOString();
    yield* db.insert(gameNightVotes).values(["a", "b"].map((u) => ({ day: DAY, stage: "ask", user_id: u, choice: "yes", voted_at: iso })));
    if (stage === "time") yield* db.insert(gameNightVotes).values({ day: DAY, stage: "ask", user_id: "c", choice: "yes", voted_at: iso });
  });

it.effect("the hour's reminder skips whoever sits in voice with the others, and still reaches whoever doesn't", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(at("18:00:00") * 1000);
    yield* setUp("ask", at("18:00:00"));
    // c hasn't answered, but sits in the Lobby with a: being there is the answer
    yield* Presence.use((p) => p.snapshot([{ user_id: "a", channel_id: "lobby" }, { user_id: "c", channel_id: "lobby" }]));
    yield* TestClock.setTime(at("19:01:00") * 1000);
    yield* GameNight.use((g) => g.maintain);
    expect(gn().filter((m) => JSON.stringify(m.body).includes("still waiting"))).toEqual([]);
  }).pipe(h.provide),
);

it.effect("not in voice: the hour's reminder goes out, loud, to them", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(at("18:00:00") * 1000);
    yield* setUp("ask", at("18:00:00"));
    yield* Presence.use((p) => p.snapshot([]));
    yield* TestClock.setTime(at("19:01:00") * 1000);
    yield* GameNight.use((g) => g.maintain);
    const [r] = gn().filter((m) => JSON.stringify(m.body).includes("still waiting"));
    expect(r!.body.allowed_mentions).toEqual({ users: ["c"] });
    expect(r!.body.flags ?? 0).toBe(0);
  }).pipe(h.provide),
);

it.effect("the time step sends no reminder; after 15 min with one pick it closes, the others going with the group", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* TestClock.setTime(at("18:00:00") * 1000);
    yield* setUp("time", at("18:00:00"));
    yield* Presence.use((p) => p.snapshot([]));
    yield* db.insert(gameNightVotes).values({ day: DAY, stage: "time", user_id: "a", choice: String(at("20:00:00")), voted_at: new Date().toISOString() });
    yield* TestClock.setTime(at("18:10:00") * 1000);
    yield* GameNight.use((g) => g.maintain);
    expect((yield* db.select().from(gameNights).where(eq(gameNights.day, DAY)))[0]!.stage).toBe("time"); // not yet
    yield* TestClock.setTime(at("18:16:00") * 1000);
    yield* GameNight.use((g) => g.maintain);
    const [n] = yield* db.select().from(gameNights).where(eq(gameNights.day, DAY));
    expect([n!.stage, n!.start_at]).toEqual(["set", at("20:00:00")]);
    const on = gn().find((m) => JSON.stringify(m.body).includes("it's on"))!;
    expect(on.body.content).toContain("didn't pick, so they go with the group");
    expect(gn().filter((m) => JSON.stringify(m.body).includes("still waiting") || JSON.stringify(m.body).includes("Last call"))).toEqual([]);
  }).pipe(h.provide),
);

it.effect("⚡ one tap each: a time, Now and any time lock the night in the usual game, with no game or time question", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* TestClock.setTime(at("17:00:00") * 1000);
    // three World of Warcraft nights lately: it's the usual game
    for (const [d, s] of [["2026-11-05", "20:30"], ["2026-11-08", "20:30"], ["2026-11-10", "21:00"]] as const)
      yield* db.insert(gameNights).values({ day: d, stage: "set", game: "World of Warcraft", start_at: Date.parse(`${d}T${s}:00+02:00`) / 1000, reminded: true });
    yield* db.insert(gameNights).values({ day: DAY, stage: "ask", message_id: "card", stage_at: at("17:00:00") });
    yield* Presence.use((p) => p.snapshot([]));
    const tap = (u: string, a: string, v?: string) => GameNight.use((g) => g.act(DAY, u, a, v, (x) => Effect.ignore(x)));
    yield* tap("a", "pick", String(at("20:30:00")));
    yield* tap("b", "pick", "any");
    yield* TestClock.setTime(at("18:00:00") * 1000);
    yield* tap("c", "pick", String(at("21:00:00")));
    const [n] = yield* db.select().from(gameNights).where(eq(gameNights.day, DAY));
    expect([n!.stage, n!.game, n!.start_at]).toEqual(["set", "World of Warcraft", at("21:00:00")]);
    const said = gn().map((m) => JSON.stringify(m.body));
    expect(said.filter((t) => t.includes("What are we playing") || t.includes("When can you start"))).toEqual([]);
    expect(said.some((t) => t.includes("it's on"))).toBe(true);
  }).pipe(h.provide),
);

// ---------------------------------------------------------------- 21 Nov: all three, or it isn't a game night

/** a and b (and c, when `all`) in one room for SETTLE, as the gateway and the stats would have it. */
const inRoom = (t: number, all: boolean) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const who = all ? ["a", "b", "c"] : ["a", "b"];
    yield* Presence.use((p) => p.snapshot(who.map((u) => ({ user_id: u, channel_id: "room1" }))));
    yield* db.insert(voiceSegments).values(who.map((u) => ({ user_id: u, channel_id: "room1", started_at: t, last_seen: t, open: true })));
    const where = new Map<string, string | null>([["a", "room1"], ["b", "room1"], ["c", all ? "room1" : null]]);
    return yield* GameNight.use((g) => g.early(where, t + 31));
  });

it.effect("two in a room after the third said not tonight: no game night, the card stays off", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* TestClock.setTime(at("21:57:00") * 1000);
    yield* db.insert(gameNights).values({ day: DAY, stage: "off", message_id: "card", stage_at: at("18:00:00"), note: "🔥 Called off" });
    yield* db.insert(gameNightVotes).values([
      ...["a", "b"].map((u) => ({ day: DAY, stage: "ask", user_id: u, choice: "yes", voted_at: new Date().toISOString() })),
      { day: DAY, stage: "ask", user_id: "c", choice: "no", voted_at: new Date().toISOString() },
    ]);
    const r = yield* inRoom(at("21:57:00"), false);
    expect(r.started).toBeNull();
    expect((yield* db.select().from(gameNights).where(eq(gameNights.day, DAY)))[0]!.stage).toBe("off");
    expect(gn().filter((m) => JSON.stringify(m.body).includes("game night is on"))).toEqual([]);
  }).pipe(h.provide),
);

it.effect("two in a room: still no start; all three: the called-off night starts, and the roast's claim is struck", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* TestClock.setTime(at("21:57:00") * 1000);
    yield* db.insert(gameNights).values({ day: DAY, stage: "off", message_id: "card", stage_at: at("18:00:00"), note: "🔥 Called off", game: null });
    yield* db.insert(gameNights).values({ day: "2026-11-05", stage: "set", game: "World of Warcraft", start_at: Date.parse("2026-11-05T20:30:00+02:00") / 1000, reminded: true });
    yield* db.insert(gameNights).values({ day: "2026-11-08", stage: "set", game: "World of Warcraft", start_at: Date.parse("2026-11-08T20:30:00+02:00") / 1000, reminded: true });
    yield* db.insert(settings).values({ key: `gn:roastmsg:${DAY}`, value: { id: "roast", content: "🔥 **Tonight's game night is off** · <@c> 👻 didn't vote in time\n> a line" } });
    expect((yield* inRoom(at("21:57:00"), false)).started).toBeNull();
    yield* db.delete(voiceSegments);
    const r = yield* inRoom(at("21:58:00"), true);
    expect(r.started).toBe(DAY);
    const struck = calls.find((c) => c.method === "PATCH" && c.path === "/channels/gn/messages/roast")!;
    expect(struck.body.content).toBe("🔥 ~~Tonight's game night is off~~ · <@c> 👻 didn't vote in time\n> a line");
  }).pipe(h.provide),
);

it.effect("a maybe asked again after the hold who never answers shows as “🤔 Maybe, then no answer”", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* TestClock.setTime(at("20:02:00") * 1000);
    yield* db.insert(gameNights).values({ day: DAY, stage: "ask", message_id: "card", stage_at: at("17:00:00"), maybes: 1, paused_until: at("20:01:00") });
    yield* db.insert(gameNightVotes).values([
      ...["a", "b"].map((u) => ({ day: DAY, stage: "ask", user_id: u, choice: "yes", voted_at: new Date().toISOString() })),
      { day: DAY, stage: "time", user_id: "a", choice: String(at("21:00:00")), voted_at: new Date().toISOString() },
      { day: DAY, stage: "ask", user_id: "c", choice: "maybe", voted_at: new Date().toISOString() },
    ]);
    yield* Presence.use((p) => p.snapshot([]));
    yield* GameNight.use((g) => g.maintain); // the hold is up: c is asked again
    yield* db.update(gameNights).set({ stage: "off", note: "🔥 Called off" }).where(eq(gameNights.day, DAY));
    const card = JSON.stringify(yield* GameNight.use((g) => g.render(DAY)));
    expect(card).toContain("<@c> 🤔 Maybe, then no answer");
  }).pipe(h.provide),
);
