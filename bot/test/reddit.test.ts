// The Reddit feed parser, on a real copy of the feed (test/fixtures/feed.xml), and how often the
// pool is refilled from it.
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { maybeRefill, parseFeed, refilling, _reset } from "../src/reddit.js";
import { settings } from "../src/db/index.js";
import * as alerts from "../src/alerts.js";
import { testDb, testEnv } from "./pg.js";

const FEED = readFileSync(new URL("./fixtures/feed.xml", import.meta.url), "utf8");

test("image posts come out ranked, with titles decoded", () => {
  const memes = parseFeed(FEED);
  expect(memes.length).toBeGreaterThan(20);
  for (const m of memes) {
    expect(m.id).toMatch(/^t3_\w+$/);
    expect(m.image).toMatch(/^https:\/\/i\.redd\.it\/.+\.(png|jpe?g|gif|webp)$/);
    expect(m.link).toMatch(/^https:\/\/www\.reddit\.com\/r\/ProgrammerHumor\/comments\//);
    expect(m.author).toMatch(/^\/u\//);
    expect(m.published).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(m.title).not.toMatch(/&(amp|quot|#\d+);/);
  }
  const ranks = memes.map((m) => m.rank);
  expect(ranks).toEqual([...ranks].sort((a, b) => a! - b!)); // feed order kept; videos etc. leave gaps
});

test("a feed with a single entry still parses", () => {
  const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><author><name>/u/x</name></author>
    <content type="html">&lt;a href=&quot;https://i.redd.it/abc.png&quot;&gt;[link]&lt;/a&gt;</content>
    <id>t3_abc</id><link href="https://www.reddit.com/r/ProgrammerHumor/comments/abc/x/" /><published>2026-11-04T10:00:00+00:00</published>
    <title>Tom &amp;amp; Jerry &amp;#39;s code</title></entry></feed>`;
  expect(parseFeed(xml)).toEqual([
    { id: "t3_abc", title: "Tom & Jerry 's code", image: "https://i.redd.it/abc.png", link: "https://www.reddit.com/r/ProgrammerHumor/comments/abc/x/", author: "/u/x", published: "2026-11-04T10:00:00+00:00", rank: 1 },
  ]);
});

// ---------------------------------------------------------------- refills

let t: Awaited<ReturnType<typeof testDb>>;
const realFetch = globalThis.fetch;
beforeAll(async () => {
  t = await testDb();
});
afterAll(async () => {
  await t.close();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
});

test("a restart doesn't fetch again: the last refill's time is in the database", async () => {
  const env = testEnv(t.db);
  let fetches = 0;
  globalThis.fetch = (async () => (fetches++, new Response(FEED, { status: 200 }))) as typeof fetch;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse("2026-11-09T12:00:00Z"));
  _reset();
  expect(await maybeRefill(env)).toEqual({ refilling: true });
  await vi.waitFor(() => expect(refilling()).toBe(false));
  const saved = async () => (await t.db.select().from(settings).where(eq(settings.key, "reddit_refill")))[0]?.value as { ok: number; tried: number };
  await vi.waitFor(async () => expect((await saved()).ok).toBeGreaterThan(0));
  expect((await saved()).ok - Date.parse("2026-11-09T12:00:00Z")).toBeLessThan(1000); // (fake time creeps while waiting)
  expect(fetches).toBe(1);
  expect(await maybeRefill(env)).toEqual({}); // not due again for 6 hours
  _reset(); // a deploy
  expect(await maybeRefill(env)).toEqual({});
  expect(fetches).toBe(1);
  // 6 hours on, it's due (restarted or not)
  vi.setSystemTime(Date.parse("2026-11-09T18:00:01Z"));
  _reset();
  expect(await maybeRefill(env)).toEqual({ refilling: true });
  await vi.waitFor(() => expect(refilling()).toBe(false));
  expect(fetches).toBe(2);
});

test("a failed refill waits 10 minutes before trying again, also across a restart", async () => {
  const env = testEnv(t.db);
  await t.db.delete(settings).where(eq(settings.key, "reddit_refill"));
  let fetches = 0;
  globalThis.fetch = (async () => (fetches++, new Response("blocked", { status: 403 }))) as typeof fetch;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse("2026-11-10T12:00:00Z"));
  _reset();
  expect(await maybeRefill(env)).toEqual({ refilling: true });
  await vi.waitFor(() => expect(refilling()).toBe(false));
  await vi.waitFor(async () => expect((await t.db.select().from(settings).where(eq(settings.key, "reddit_refill")))[0]?.value).toMatchObject({ ok: 0, tried: Date.parse("2026-11-10T12:00:00Z") }));
  _reset();
  vi.setSystemTime(Date.parse("2026-11-10T12:05:00Z"));
  expect(await maybeRefill(env)).toEqual({});
  vi.setSystemTime(Date.parse("2026-11-10T12:10:01Z"));
  expect(await maybeRefill(env)).toEqual({ refilling: true });
  await vi.waitFor(() => expect(refilling()).toBe(false));
  expect(fetches).toBe(2);
});

test("a failed refill DMs only once the pool has gone 12 hours without fresh memes", async () => {
  const env = testEnv(t.db, { ALERT_USER_ID: "owner" });
  alerts._reset();
  alerts.setup(env);
  const dms: string[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    if (String(url).includes("reddit.com")) return new Response("blocked", { status: 403 });
    if (String(url).endsWith("/users/@me/channels")) return Response.json({ id: "dm" });
    dms.push(JSON.parse(String(init.body)).content);
    return Response.json({ id: "m" });
  }) as typeof fetch;
  vi.useFakeTimers({ toFake: ["Date"] });
  const ok = Date.parse("2026-11-11T01:00:00Z");
  const refillFrom = async (now: string) => {
    await t.db.insert(settings).values({ key: "reddit_refill", value: { ok, tried: ok } }).onConflictDoUpdate({ target: settings.key, set: { value: { ok, tried: ok } } });
    vi.setSystemTime(Date.parse(now));
    _reset();
    expect(await maybeRefill(env)).toEqual({ refilling: true });
    await vi.waitFor(() => expect(refilling()).toBe(false));
    await alerts._settle();
  };
  await refillFrom("2026-11-11T08:00:00Z"); // 7 h since the last good one: only logged
  expect(dms).toEqual([]);
  await refillFrom("2026-11-11T13:00:01Z"); // 12 h: worth a DM
  expect(dms).toHaveLength(1);
  expect(dms[0]).toContain("**fetching memes from Reddit** failed");
  expect(dms[0]).toContain(`no fresh memes since <t:${ok / 1000}:R>`);
  alerts._reset();
});
