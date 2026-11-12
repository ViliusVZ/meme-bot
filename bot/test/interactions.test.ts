// Taps and commands at the edges: who may tap what, what a changed vote doesn't do, the stats
// panel's range, retired and half-filled buttons.
import { expect, it } from "@effect/vitest";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { Interactions } from "../src/interactions.js";
import { Memes } from "../src/memes.js";
import { Polls } from "../src/polls.js";
import { Db } from "../src/db/db.js";
import { memes as memeTable, polls as pollTable, pollVotes, users, votes } from "../src/db/schema.js";
import { harness } from "./fx.js";

const h = harness({
  tables: [pollVotes, pollTable, votes, memeTable, users],
  discord: { firstId: 30000 },
  clock: "2026-11-06T15:00:00Z", // Friday 17:00 in Vilnius
});

const tap = (custom_id: string, user = { id: "a", username: "a" } as { id: string; username: string; global_name?: string }, type = 3, extra: object = {}) =>
  Interactions.use((x) => Effect.map(x.handle({ type, token: "tok", member: { user }, message: { id: "m1", flags: 0 }, data: { custom_id, ...extra } }), (r) => r as any));

it.effect("a poll is the trio's: someone else's tap is turned away and counts for nothing", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const id = yield* Polls.use((p) => p.create("a", "Pizza?", ""));
    const r = yield* tap(`poll:${id}:0`, { id: "stranger", username: "s" });
    expect(r.data.content).toBe("This one's for the trio 😅");
    expect(yield* db.select().from(pollVotes).where(eq(pollVotes.poll_id, id))).toEqual([]);
  }).pipe(h.provide),
);

it.effect("changing a vote on the daily meme doesn't count as another day's vote", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const memes = yield* Memes;
    yield* memes.ingest([{ id: "t3_s", title: "S", image: "i", link: "l", author: "a", published: "2026-11-05T08:00:00Z", rank: 1 }]);
    yield* memes.claim("t3_s", "daily", { day: "2026-11-05" });
    yield* tap("v:t3_s:fire", { id: "b", username: "b", global_name: "Bee" });
    yield* tap("v:t3_s:lol", { id: "b", username: "b", global_name: "Bee 2.0" }); // a changed vote, under a new display name
    const [u] = yield* db.select().from(users).where(eq(users.user_id, "b"));
    expect([u.streak, u.name]).toEqual([1, "Bee"]); // the streak isn't touched by a changed vote
  }).pipe(h.provide),
);

it.effect("the stats panel only goes back in time, and at most ten years", () =>
  Effect.gen(function* () {
    const future = yield* tap("st:week:5");
    expect(JSON.stringify(future.data)).toContain("This week ·");
    const far = yield* tap("st:week:-9999");
    expect(JSON.stringify(far.data)).toContain("st:week:-521"); // ◀️ from -520
  }).pipe(h.provide),
);

it.effect("a retired tiebreaker button says so", () =>
  Effect.gen(function* () {
    const r = yield* tap("tb:2026-11-01:a");
    expect(r.data.content).toBe("Tiebreakers are retired 🔁 A split means a re-vote now: pick again on the card.");
  }).pipe(h.provide),
);

it.effect("a game room form left blank asks for a name", () =>
  Effect.gen(function* () {
    const r = yield* tap("room:other", { id: "a", username: "a" }, 5, { components: [{ components: [{ custom_id: "value", value: "   " }] }] });
    expect(r.data.content).toBe("Give the room a name 🙃");
  }).pipe(h.provide),
);
