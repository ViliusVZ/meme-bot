// 🎧 "coming?" (21 Nov): only the one it asks can answer it, every tap gets an answer the tapper sees
// (on a called-off night too: never the card aimed at a plain message), and it names a game only
// when one is known.
import { expect, it } from "@effect/vitest";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { gameNights, gameNightVotes, games, settings, voiceSegments, lobbyPrompts, rooms, sessions, fleeting, nightCards, nightAttendance, readyRooms, gameAliases, activityGuesses, panels } from "../src/db/schema.js";
import { Db } from "../src/db/db.js";
import { Interactions } from "../src/interactions.js";
import { GameNight } from "../src/gamenight.js";
import { Presence } from "../src/presence.js";
import { Spontaneous } from "../src/spontaneous.js";
import { harness, routes } from "./fx.js";

const h = harness({
  tables: [gameNights, gameNightVotes, games, settings, voiceSegments, lobbyPrompts, rooms, sessions, fleeting, nightCards, nightAttendance, readyRooms, gameAliases, activityGuesses, panels],
  seed: (t) => t.db.insert(games).values([{ name: "World of Warcraft", emoji: "⚔️", added_at: "x", plays: 3 }]),
  discord: { firstId: 90000, routes: [routes.noVoiceState, routes.lobbyOnly] },
  clock: "2026-11-06T19:00:00Z", // Friday 21:00 in Vilnius
});
const calls = h.calls;
const DAY = "2026-11-06";
const IS_V2 = 1 << 15;

const tap = (custom_id: string, user: string) =>
  Interactions.use((x) =>
    Effect.map(x.handle({ type: 3, token: "tok", channel_id: "gn", member: { user: { id: user, username: user } }, message: { id: "coming", flags: 0 }, data: { custom_id } }), (r) => r as any),
  );

/** Tonight's card at `stage`, and the one "coming?" to c (a and b are in voice). */
const setUp = (stage: "off" | "ask") =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db.insert(gameNights).values({ day: DAY, stage, message_id: "card", stage_at: Date.parse("2026-11-06T15:00:00Z") / 1000, note: stage === "off" ? "🔥 Called off" : null });
    yield* db.insert(settings).values({ key: `gn:called:${DAY}:c`, value: { at: 1, message_id: "coming", two: ["a", "b"] } });
  });

const clears = () => calls.filter((c) => c.method === "PATCH" && c.path === "/channels/gn/messages/coming");
const askOf = (user: string) =>
  Effect.map(
    Effect.flatMap(Db, (db) => db.select().from(gameNightVotes).where(eq(gameNightVotes.user_id, user))),
    (r) => r.find((v) => v.stage === "ask")?.choice,
  );

for (const stage of ["off", "ask"] as const)
  for (const [button, said] of [
    ["coming:0:c", "🏃 Told them you're on the way."],
    ["coming:15:c", "⏰ Told them: 15 min."],
    ["nottonight:c", "😴 Got it. Have a good night."],
  ] as const)
    it.effect(`${stage} night, ${button}: the one asked gets a private answer, the buttons come off`, () =>
      Effect.gen(function* () {
        yield* setUp(stage);
        const r = yield* tap(`gn:${DAY}:${button}`, "c");
        // a new private message, never an update of the plain "coming?" message with the card
        expect(r.type).toBe(4);
        expect(r.data.flags & 64).toBe(64);
        expect(r.data.flags & IS_V2).toBe(0);
        expect(r.data.content).toBe(said);
        yield* Effect.yieldNow;
        expect(clears().map((c) => c.body)).toEqual([{ components: [] }]);
        expect(yield* askOf("c")).toBe(button.startsWith("nottonight") ? "no" : "yes");
      }).pipe(h.provide),
    );

for (const button of ["coming:0:c", "coming:15:c", "nottonight:c"])
  it.effect(`someone else taps ${button}: "that one's for" them, and nothing changes`, () =>
    Effect.gen(function* () {
      yield* setUp("off");
      yield* GameNight.use((g) => Effect.void); // the service is up
      const before = calls.filter((c) => c.method === "POST").length;
      const r = yield* tap(`gn:${DAY}:${button}`, "a");
      expect([r.type, r.data.flags & 64, r.data.content]).toEqual([4, 64, "That one's for <@c> 🙂"]);
      yield* Effect.yieldNow;
      expect(clears()).toEqual([]);
      expect(calls.filter((c) => c.method === "POST").length).toBe(before); // no public line
      expect(yield* askOf("a")).toBeUndefined();
    }).pipe(h.provide),
  );

it.effect("an older message (no name on its buttons) still knows who it asked", () =>
  Effect.gen(function* () {
    yield* setUp("off");
    const r = yield* tap(`gn:${DAY}:nottonight`, "a");
    expect(r.data.content).toBe("That one's for <@c> 🙂");
    expect(yield* askOf("a")).toBeUndefined();
  }).pipe(h.provide),
);

it.effect("a called-off night names no game; an open card names its usual one", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    // WoW on recent nights: an open card assumes it
    for (const d of ["2026-11-01", "2026-11-03"]) yield* db.insert(gameNights).values({ day: d, stage: "set", game: "World of Warcraft", start_at: Date.parse(`${d}T19:00:00Z`) / 1000, reminded: true });
    yield* db.insert(gameNights).values({ day: DAY, stage: "off", message_id: "card", stage_at: Date.parse("2026-11-06T15:00:00Z") / 1000 });
    const t = Date.parse("2026-11-06T19:00:00Z") / 1000;
    const where = new Map([["a", "lobby"], ["b", "lobby"], ["c", null]]);
    yield* Presence.use((p) => p.snapshot([{ user_id: "a", channel_id: "lobby" }, { user_id: "b", channel_id: "lobby" }]));
    yield* db.insert(voiceSegments).values(["a", "b"].map((u) => ({ user_id: u, channel_id: "lobby", started_at: t, last_seen: t, open: true })));
    yield* GameNight.use((g) => g.early(where, t + 31));
    const off = calls.find((c) => c.method === "POST" && JSON.stringify(c.body).includes("Coming?"))!;
    expect(off.body.content).toMatch(/^🎧 <@c>, .+ are in <#lobby>\. Coming\?$/);
    expect(off.body.content).not.toContain("World of Warcraft");
    expect(off.body.components[0].components.map((b: any) => b.custom_id)).toEqual([`gn:${DAY}:coming:0:c`, `gn:${DAY}:coming:15:c`, `gn:${DAY}:nottonight:c`]);
    const [saved] = yield* db.select().from(settings).where(eq(settings.key, `gn:called:${DAY}:c`));
    expect(saved.value).toMatchObject({ two: ["a", "b"] });
  }).pipe(h.provide),
);

it.effect("the two pick a game on the Lobby question: “coming?” now points at their room and names the game", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* setUp("off");
    const [q] = yield* db.insert(lobbyPrompts).values({ created_at: 1, state: "open", message_id: "q", posted_at: 1, current: true }).returning();
    yield* Spontaneous.use((s) => s.answer(q!.id, "a", "g", "World of Warcraft"));
    const [room] = yield* db.select().from(rooms);
    const edit = calls.find((c) => c.method === "PATCH" && c.path === "/channels/gn/messages/coming")!;
    expect(edit.body.content.startsWith("🎧 <@c>, ")).toBe(true);
    expect(edit.body.content.endsWith(` are in <#${room!.channel_id}>. Coming?`)).toBe(true); // the room's name says the game
    expect(edit.body.components).toBeUndefined(); // its buttons stay while it's unanswered
  }).pipe(h.provide),
);

it.effect("her own “Not tonight” shows on the called-off card as what she said", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* setUp("off");
    yield* db.insert(gameNightVotes).values({ day: DAY, stage: "time", user_id: "a", choice: String(Date.parse("2026-11-06T20:00:00Z") / 1000), voted_at: new Date().toISOString() });
    yield* tap(`gn:${DAY}:nottonight:c`, "c");
    const card = JSON.stringify(yield* GameNight.use((g) => g.render(DAY)));
    expect(card).toContain("<@c> 😴 not tonight");
    // and the card in the channel is redrawn with it
    yield* h.settle;
    const edits = calls.filter((c) => c.method === "PATCH" && c.path === "/channels/gn/messages/card");
    expect(JSON.stringify(edits.at(-1)?.body)).toContain("<@c> 😴 not tonight");
  }).pipe(h.provide),
);

for (const [first, second] of [
  ["nottonight:c", "nottonight:c"],
  ["coming:0:c", "coming:15:c"],
  ["coming:0:c", "nottonight:c"],
] as const)
  it.effect(`answered once means answered: ${first} then ${second} posts one line`, () =>
    Effect.gen(function* () {
      yield* setUp("off");
      yield* tap(`gn:${DAY}:${first}`, "c");
      const lines = () => calls.filter((c) => c.method === "POST" && c.path === "/channels/gn/messages" && /is out tonight|on the way|in \d+ min/.test(c.body.content ?? "")).length;
      expect(lines()).toBe(1);
      const r = yield* tap(`gn:${DAY}:${second}`, "c");
      expect([r.type, r.data.flags & 64, r.data.content]).toEqual([4, 64, "You've already answered that one 🙂"]);
      expect(lines()).toBe(1);
      expect(yield* askOf("c")).toBe(first.startsWith("nottonight") ? "no" : "yes");
    }).pipe(h.provide),
  );
