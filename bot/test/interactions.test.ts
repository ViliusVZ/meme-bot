// Taps and commands at the edges: who may tap what, what a changed vote doesn't do, the stats
// panel's range, retired and half-filled buttons.
import { beforeAll, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { interaction } from "./old/interactions.js";
import * as memes from "./old/memes.js";
import * as polls from "./old/polls.js";
import { memes as memeTable, polls as pollTable, pollVotes, users, votes } from "../src/db/schema.js";
import { harness, type TestDb } from "./harness.js";
import type { Env } from "./old/env.js";

const h = harness({
  tables: [pollVotes, pollTable, votes, memeTable, users],
  discord: { firstId: 30000 },
  clock: "2026-11-06T15:00:00Z", // Friday 17:00 in Vilnius
});
let t: TestDb;
let env: Env;
beforeAll(() => void ({ t, env } = h));

const tap = (custom_id: string, user = { id: "a", username: "a" } as { id: string; username: string; global_name?: string }, type = 3, extra: object = {}) =>
  interaction({ type, token: "tok", member: { user }, message: { id: "m1", flags: 0 }, data: { custom_id, ...extra } }, env) as Promise<any>;

test("a poll is the trio's: someone else's tap is turned away and counts for nothing", async () => {
  const id = await polls.createPoll(env, "a", "Pizza?", "");
  const r = await tap(`poll:${id}:0`, { id: "stranger", username: "s" });
  expect(r.data.content).toBe("This one's for the trio 😅");
  expect(await t.db.select().from(pollVotes).where(eq(pollVotes.poll_id, id))).toEqual([]);
});

test("changing a vote on the daily meme doesn't count as another day's vote", async () => {
  await memes.ingest(env, [{ id: "t3_s", title: "S", image: "i", link: "l", author: "a", published: "2026-11-05T08:00:00Z", rank: 1 }]);
  await memes.claim(env, "t3_s", "daily", { day: "2026-11-05" });
  await tap("v:t3_s:fire", { id: "b", username: "b", global_name: "Bee" });
  await tap("v:t3_s:lol", { id: "b", username: "b", global_name: "Bee 2.0" }); // a changed vote, under a new display name
  const [u] = await t.db.select().from(users).where(eq(users.user_id, "b"));
  expect([u.streak, u.name]).toEqual([1, "Bee"]); // the streak isn't touched by a changed vote
});

test("the stats panel only goes back in time, and at most ten years", async () => {
  const future = await tap("st:week:5");
  expect(JSON.stringify(future.data)).toContain("This week ·");
  const far = await tap("st:week:-9999");
  expect(JSON.stringify(far.data)).toContain("st:week:-521"); // ◀️ from -520
});

test("a retired tiebreaker button says so", async () => {
  const r = await tap("tb:2026-11-01:a");
  expect(r.data.content).toBe("Tiebreakers are retired 🔁 A split means a re-vote now: pick again on the card.");
});

test("a game room form left blank asks for a name", async () => {
  const r = await tap("room:other", { id: "a", username: "a" }, 5, { components: [{ components: [{ custom_id: "value", value: "   " }] }] });
  expect(r.data.content).toBe("Give the room a name 🙃");
});
