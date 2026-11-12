// Meme voting streaks across days (memes.ts): consecutive UTC days grow the streak, the same day
// counts once, a missed day starts over, and a streak shows only while it's alive.
import { expect, it } from "@effect/vitest";
import { Cause, Effect, Exit } from "effect";
import { memes as memeTable, recaps, users, votes } from "../src/db/schema.js";
import { Memes } from "../src/memes.js";
import { Jobs } from "../src/jobs.js";
import { Db } from "../src/db/db.js";
import { harness, json } from "./fx.js";

const h = harness({ tables: [votes, memeTable, recaps, users], clock: "2026-11-06T10:00:00Z", discord: { firstId: 100 } });
const day = (iso: string) => h.setTime(iso);
/** The call as a promise on this test's services (for a `.rejects` assertion), rejecting with the failure itself. */
const promised = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.context<R>(), (ctx) =>
    Effect.runPromiseExitWith(ctx)(self).then((exit) => (Exit.isSuccess(exit) ? exit.value : Promise.reject(Cause.squash(exit.cause)))),
  );

it.effect("a voting streak grows day by day, counts once a day, and starts over after a missed day", () =>
  Effect.gen(function* () {
    const memes = yield* Memes;
    const db = yield* Db;
    expect(yield* memes.bumpStreak("a", "Vithis")).toBe(1);
    expect(yield* memes.bumpStreak("a", "Vithis")).toBeNull(); // the same day again
    yield* day("2026-11-07T23:59:00Z");
    expect(yield* memes.bumpStreak("a", "Vithis")).toBe(2);
    yield* day("2026-11-08T00:01:00Z");
    expect(yield* memes.bumpStreak("a", "Vithis")).toBe(3);
    yield* day("2026-11-10T12:00:00Z"); // missed the 9th
    expect(yield* memes.bumpStreak("a", "Vithis")).toBe(1);
    const [u] = yield* db.select().from(users);
    expect([u.streak, u.best_streak, u.last_vote_day]).toEqual([1, 3, "2026-11-10"]);
  }).pipe(h.provide),
);

it.effect("a streak shows while it's alive: voted today or yesterday", () =>
  Effect.gen(function* () {
    const memes = yield* Memes;
    const u = { streak: 4, last_vote_day: "2026-11-05" };
    expect(yield* memes.liveStreak(u)).toBe(4); // yesterday (it's the 6th)
    yield* day("2026-11-07T10:00:00Z");
    expect(yield* memes.liveStreak(u)).toBe(0);
    expect(yield* memes.liveStreak(null)).toBe(0);
  }).pipe(h.provide),
);

it.effect("a recap with no votes gives its claim back, and so does one whose post fails", () =>
  Effect.gen(function* () {
    const jobs = yield* Jobs;
    const db = yield* Db;
    // nothing voted this week: skipped, and the week isn't marked posted
    expect(yield* jobs.weeklyRecap).toEqual({ skipped: "no votes", period: "week:2026-11-06" });
    expect(yield* db.select().from(recaps)).toEqual([]);
    yield* db.insert(memeTable).values({ id: "t3_a", title: "a", image: "", link: "", author: "", published: "", ingested_at: "x", post_kind: "daily", day: "2026-11-05", posted_at: "2026-11-05T10:00:00.000Z" });
    yield* db.insert(votes).values({ meme_id: "t3_a", user_id: "b", kind: "fire", voted_at: "2026-11-05T11:00:00.000Z" });
    // the post fails: the claim is given back, so the next run posts it
    h.override = (c) => (c.method === "POST" ? json({ message: "boom" }, 500) : undefined);
    const failing = yield* promised(jobs.weeklyRecap);
    yield* Effect.promise(() => expect(failing).rejects.toThrow("gave up: 500"));
    expect(yield* db.select().from(recaps)).toEqual([]);
    h.override = null;
    expect(yield* jobs.weeklyRecap).toEqual({ posted: "week:2026-11-06" });
    expect((yield* db.select().from(recaps)).map((r) => r.period)).toEqual(["week:2026-11-06"]);
  }).pipe(h.provide),
);
