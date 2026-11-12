// Meme voting streaks across days (memes.ts): consecutive UTC days grow the streak, the same day
// counts once, a missed day starts over, and a streak shows only while it's alive.
import { beforeAll, expect, test, vi } from "vitest";
import { memes as memeTable, recaps, users, votes } from "../src/db/schema.js";
import * as jobs from "./old/jobs.js";
import * as memes from "./old/memes.js";
import type { Env } from "./old/env.js";
import { harness, json } from "./harness.js";

const h = harness({ tables: [votes, memeTable, recaps, users], clock: "2026-11-06T10:00:00Z", discord: { firstId: 100 } });
let env: Env;
beforeAll(() => void ({ env } = h));
const day = (iso: string) => vi.setSystemTime(Date.parse(iso));

test("a voting streak grows day by day, counts once a day, and starts over after a missed day", async () => {
  expect(await memes.bumpStreak(env, "a", "Vithis")).toBe(1);
  expect(await memes.bumpStreak(env, "a", "Vithis")).toBeNull(); // the same day again
  day("2026-11-07T23:59:00Z");
  expect(await memes.bumpStreak(env, "a", "Vithis")).toBe(2);
  day("2026-11-08T00:01:00Z");
  expect(await memes.bumpStreak(env, "a", "Vithis")).toBe(3);
  day("2026-11-10T12:00:00Z"); // missed the 9th
  expect(await memes.bumpStreak(env, "a", "Vithis")).toBe(1);
  const [u] = await h.t.db.select().from(users);
  expect([u.streak, u.best_streak, u.last_vote_day]).toEqual([1, 3, "2026-11-10"]);
});

test("a streak shows while it's alive: voted today or yesterday", async () => {
  const u = { streak: 4, last_vote_day: "2026-11-05" };
  expect(memes.liveStreak(u)).toBe(4); // yesterday (it's the 6th)
  day("2026-11-07T10:00:00Z");
  expect(memes.liveStreak(u)).toBe(0);
  expect(memes.liveStreak(null)).toBe(0);
});

test("a recap with no votes gives its claim back, and so does one whose post fails", async () => {
  // nothing voted this week: skipped, and the week isn't marked posted
  expect(await jobs.weeklyRecap(env)).toEqual({ skipped: "no votes", period: "week:2026-11-06" });
  expect(await h.t.db.select().from(recaps)).toEqual([]);
  await h.t.db.insert(memeTable).values({ id: "t3_a", title: "a", image: "", link: "", author: "", published: "", ingested_at: "x", post_kind: "daily", day: "2026-11-05", posted_at: "2026-11-05T10:00:00.000Z" });
  await h.t.db.insert(votes).values({ meme_id: "t3_a", user_id: "b", kind: "fire", voted_at: "2026-11-05T11:00:00.000Z" });
  // the post fails: the claim is given back, so the next run posts it
  h.override = (c) => (c.method === "POST" ? json({ message: "boom" }, 500) : undefined);
  await expect(jobs.weeklyRecap(env)).rejects.toThrow("gave up: 500");
  expect(await h.t.db.select().from(recaps)).toEqual([]);
  h.override = null;
  expect(await jobs.weeklyRecap(env)).toEqual({ posted: "week:2026-11-06" });
  expect((await h.t.db.select().from(recaps)).map((r) => r.period)).toEqual(["week:2026-11-06"]);
});
