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
