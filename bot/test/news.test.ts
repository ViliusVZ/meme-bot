// ⚔️ WoW: Forever news against a real Postgres, with the feed, Gemini and Discord stubbed.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as news from "../src/news.js";
import { newsItems, settings } from "../src/db/schema.js";
import { testDb, testEnv } from "./pg.js";

let t: Awaited<ReturnType<typeof testDb>>;
let env: ReturnType<typeof testEnv>;
type Call = { method: string; url: string; body: any };
let calls: Call[] = [];
let feed = "";
let feedStatus = 200;
let verdicts: ((topics: number[]) => unknown) | "down" = () => ({ items: [] });
let discordFails = false;
let forumDown = false;
let nextId = 100;
const realFetch = globalThis.fetch;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

beforeAll(async () => {
  t = await testDb();
  env = testEnv(t.db, { NEWS_CHANNEL_ID: "news", GEMINI_API_KEY: "k" });
});
afterAll(() => t.close());
beforeEach(async () => {
  await t.db.delete(newsItems);
  await t.db.delete(settings);
  calls = [];
  feed = "";
  feedStatus = 200;
  discordFails = false;
  forumDown = false;
  verdicts = () => ({ items: [] });
  news._reset();
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const c = { method: init.method ?? "GET", url: String(url), body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    if (c.url === news.FEED) return new Response(feed, { status: feedStatus });
    if (c.url.startsWith(news.FORUM)) {
      if (forumDown) return json({ errors: ["nope"] }, 503);
      if (c.url.includes("/t/")) return json({ category_id: Number(c.url.match(/\/t\/(\d+)/)![1]) >= 100 ? 235 : 360 });
      return json({ category: { name: c.url.includes("/c/360/") ? "WoW: Forever General Discussion" : "General Discussion" } });
    }
    if (c.url.includes("generativelanguage")) {
      if (verdicts === "down") return json({ error: "overloaded" }, 503);
      const topics = [...String(c.body.contents[0].parts[0].text).matchAll(/"topic":(\d+)/g)].map((m) => Number(m[1]));
      return json({ candidates: [{ content: { parts: [{ text: JSON.stringify(verdicts(topics)) }] } }] });
    }
    if (discordFails) return json({ message: "Missing Access" }, 403);
    return json({ id: String(nextId++) });
  }) as typeof fetch;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse("2026-11-11T12:00:00Z"));
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
});

const now = () => Math.floor(Date.now() / 1000);
/** A blue-tracker feed with these posts: [topic, post number, title, minutes ago]. */
function rss(posts: [number, number, string, number?][]) {
  const items = posts
    .map(
      ([topic, post, title, ago = 60]) => `<item><title>${title}</title><description><![CDATA[<p>About ${title}.</p>]]></description>
<link>https://eu.forums.blizzard.com/en/wow/t/slug/${topic}/${post}</link><pubDate>${new Date(Date.now() - ago * 60_000).toUTCString()}</pubDate></item>`,
    )
    .join("\n");
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Blue tracker</title>${items}</channel></rss>`;
}
const posted = () => calls.filter((c) => c.method === "POST" && c.url.endsWith("/channels/news/messages"));
const item = async (topic: number) => (await t.db.select().from(newsItems).where(eq(newsItems.topic_id, topic)))[0];
const say = (keep: number[], summary = "Hunters stop pulling half the zone.") => (topics: number[]) => ({
  items: topics.map((topic) => ({ topic, forever: keep.includes(topic), news: keep.includes(topic), summary })),
});

test("the real feed parses: staff posts with their topic and post number", () => {
  const xml = readFileSync(fileURLToPath(new URL("./fixtures/blue-tracker.rss", import.meta.url)), "utf8");
  const posts = news.parseFeed(xml);
  expect(posts.length).toBe(50);
  expect(posts.find((p) => p.topic === 639885)).toMatchObject({ title: "WoW: Forever Hotfixes - November 10, 2026", post: 5 });
  expect(posts.every((p) => p.published > 1.7e9 && p.excerpt.length > 0 && !p.excerpt.includes("<"))).toBe(true);
  expect(news.parseFeed("<rss><channel></channel></rss>")).toEqual([]);
});

test("the first run marks what's there as seen and lets only the newest Forever item through", async () => {
  feed = rss([
    [1, 1, "World of Warcraft: Midnight Hotfixes", 30],
    [2, 1, "WoW: Forever Hotfixes - November 10", 90],
    [3, 1, "World of Warcraft: Forever Now Live!", 3000],
  ]);
  verdicts = say([2]);
  expect(await news.run(env, now())).toMatchObject({ seen: 3, judged: 1, posted: ["WoW: Forever Hotfixes - November 10"] });
  const [card] = posted();
  expect(card.body.flags & (1 << 12)).toBeTruthy();
  expect(card.body.allowed_mentions).toEqual({ parse: [] });
  expect(JSON.stringify(card.body.components)).toContain("[WoW: Forever Hotfixes - November 10](https://eu.forums.blizzard.com/en/wow/t/slug/2/1)\\nHunters stop pulling half the zone.");
  expect((await item(1)).state).toBe("old");
  expect((await item(3)).state).toBe("old");
});

test("Gemini picks the Forever news out of everything else, in one question", async () => {
  feed = rss([[1, 1, "Old post"]]);
  await news.run(env, now());
  calls = [];
  feed = rss([
    [1, 1, "Old post"],
    [10, 1, "PvP Faction Balance Updates", 20],
    [11, 4, "No gold from quests at lvl 60? Seriously?", 15],
    [12, 1, "The Venomous Abyss Raid Tuning Incoming", 10],
  ]);
  verdicts = say([10]);
  expect(await news.run(env, now())).toMatchObject({ seen: 3, judged: 3, posted: ["PvP Faction Balance Updates"] });
  expect(calls.filter((c) => c.url.includes("generativelanguage"))).toHaveLength(1);
  expect((await item(11)).state).toBe("skip");
  expect((await item(12)).state).toBe("skip");
  // nothing new next time: Gemini isn't asked again, nothing's posted twice
  calls = [];
  expect(await news.run(env, now() + 1800)).toEqual({});
  expect(calls.filter((c) => c.url !== news.FEED)).toHaveLength(0);
});

test("Gemini down: items wait, and after 6 hours the title decides", async () => {
  feed = rss([[1, 1, "Old"]]);
  await news.run(env, now());
  verdicts = "down";
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  feed = rss([
    [1, 1, "Old"],
    [20, 1, "Explore WoW: Forever with a Gamepad"],
    [21, 1, "Midnight Talebound Demo"],
  ]);
  const t0 = now();
  expect(await news.run(env, t0)).toEqual({ seen: 2 });
  expect(await news.run(env, t0 + news.FALLBACK_AFTER - 1)).toEqual({});
  expect(await news.run(env, t0 + news.FALLBACK_AFTER)).toMatchObject({ judged: 2, posted: ["Explore WoW: Forever with a Gamepad"] });
  log.mockRestore();
  expect((await item(20)).summary).toBeNull();
  expect((await item(21)).state).toBe("skip");
});

test("at most 5 a day, oldest first; the rest go out the next day", async () => {
  feed = rss([[1, 1, "Old"]]);
  await news.run(env, now());
  feed = rss([[1, 1, "Old"], ...Array.from({ length: 7 }, (_, i) => [30 + i, 1, `Forever thing ${i}`, 100 - i] as [number, number, string, number])]);
  verdicts = (topics) => say(topics)(topics);
  const r = await news.run(env, now());
  expect(r.posted).toEqual(["Forever thing 0", "Forever thing 1", "Forever thing 2", "Forever thing 3", "Forever thing 4"]);
  expect(await news.run(env, now() + 3600)).toEqual({});
  vi.setSystemTime(Date.parse("2026-11-12T08:00:00Z"));
  expect(await news.run(env, now())).toMatchObject({ posted: ["Forever thing 5", "Forever thing 6"] });
});

test("a post Discord refuses is given back and goes out next time", async () => {
  feed = rss([[1, 1, "Old"]]);
  await news.run(env, now());
  feed = rss([[1, 1, "Old"], [40, 1, "Forever maintenance"]]);
  verdicts = say([40]);
  discordFails = true;
  await expect(news.run(env, now())).rejects.toThrow("403");
  expect(await item(40)).toMatchObject({ state: "post", message_id: null });
  discordFails = false;
  expect(await news.run(env, now() + 600)).toMatchObject({ posted: ["Forever maintenance"] });
});

test("a topic Blizzard keeps adding to (hotfixes) gets one “updated” line a day", async () => {
  feed = rss([[1, 1, "Old"]]);
  await news.run(env, now());
  feed = rss([[1, 1, "Old"], [50, 1, "WoW: Forever Hotfixes"]]);
  verdicts = say([50]);
  await news.run(env, now());
  feed = rss([[1, 1, "Old"], [50, 3, "WoW: Forever Hotfixes"]]);
  expect(await news.run(env, now() + 1800)).toMatchObject({ posted: ["updated: WoW: Forever Hotfixes"] });
  expect(posted().at(-1)!.body.content).toBe("🔧 **WoW: Forever Hotfixes** got an update → <https://eu.forums.blizzard.com/en/wow/t/slug/50/3>");
  feed = rss([[1, 1, "Old"], [50, 4, "WoW: Forever Hotfixes"]]);
  expect(await news.run(env, now() + 3600)).toEqual({}); // same day: quiet
  vi.setSystemTime(Date.parse("2026-11-12T08:00:00Z"));
  expect(await news.run(env, now())).toMatchObject({ posted: ["updated: WoW: Forever Hotfixes"] });
  // a refused update line is skipped quietly (tomorrow's says it anyway)
  vi.setSystemTime(Date.parse("2026-11-13T08:00:00Z"));
  feed = rss([[1, 1, "Old"], [50, 6, "WoW: Forever Hotfixes"]]);
  discordFails = true;
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  expect(await news.run(env, now())).toEqual({});
  log.mockRestore();
});

test("the minute job: every 30 minutes, not again after a restart, a failure retried in 10, the owner told after a day", async () => {
  feed = rss([[1, 1, "Old"]]);
  const t0 = now();
  expect(await news.check(env, t0)).toEqual({ checking: true });
  await vi.waitFor(() => expect(news._running()).toBe(false));
  expect(await news.check(env, t0 + 60)).toEqual({});
  news._reset(); // a restart: the times live in the database
  expect(await news.check(env, t0 + 600)).toEqual({});
  const fetched = () => calls.filter((c) => c.url === news.FEED).length;
  expect(fetched()).toBe(1);
  expect(await news.check(env, t0 + news.EVERY)).toEqual({ checking: true });
  await vi.waitFor(() => expect(news._running()).toBe(false));
  expect(fetched()).toBe(2);
  // Blizzard's forums down: retried after 10 minutes, quietly
  feedStatus = 503;
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const t1 = t0 + 2 * news.EVERY;
  await news.check(env, t1);
  await vi.waitFor(() => expect(news._running()).toBe(false));
  expect(await news.check(env, t1 + 300)).toEqual({});
  expect(await news.check(env, t1 + 600)).toEqual({ checking: true });
  await vi.waitFor(() => expect(news._running()).toBe(false));
  expect(log.mock.calls.flat().join(" ")).not.toContain("checking WoW: Forever news failed");
  // a day without one good check: the owner hears about it
  await news.check(env, t0 + news.EVERY + 86400 + 60);
  await vi.waitFor(() => expect(news._running()).toBe(false));
  expect(log.mock.calls.flat().map(String).join(" ")).toContain("checking WoW: Forever news failed");
  log.mockRestore();
});

test("no channel configured, no news", async () => {
  expect(await news.check({ ...env, NEWS_CHANNEL_ID: undefined }, now())).toEqual({});
  expect(calls).toEqual([]);
});

test("Gemini is told which forum section each post is in (the best hint for which game); no section, no problem", async () => {
  feed = rss([[1, 1, "Old"]]);
  await news.run(env, now());
  const prompts = () => calls.filter((c) => c.url.includes("generativelanguage")).map((c) => String(c.body.contents[0].parts[0].text));
  feed = rss([[1, 1, "Old"], [60, 1, "Dungeon Enemy XP Increased"], [160, 1, "Prepare for Forever"]]);
  verdicts = say([60, 160]);
  await news.run(env, now());
  expect(prompts().at(-1)).toContain('"topic":60,"section":"WoW: Forever General Discussion"');
  expect(prompts().at(-1)).toContain('"topic":160,"section":"General Discussion"');
  expect((await item(60)).section).toBe("WoW: Forever General Discussion");
  // the forum's JSON down: judged without it
  forumDown = true;
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  feed = rss([[1, 1, "Old"], [70, 1, "Forever maintenance"]]);
  verdicts = say([70]);
  expect(await news.run(env, now() + 1800)).toMatchObject({ posted: ["Forever maintenance"] });
  log.mockRestore();
  expect(prompts().at(-1)).toContain('"topic":70,"section":"unknown"');
});

test("the fast Gemini busy: the other one answers", async () => {
  const used: string[] = [];
  const prev = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    if (String(url).includes("generativelanguage")) {
      used.push(String(url).match(/models\/([^:]+)/)![1]);
      if (used.length === 1) return json({ error: { message: "high demand" } }, 503);
    }
    return prev(url, init);
  }) as typeof fetch;
  feed = rss([[1, 1, "Old"]]);
  await news.run(env, now());
  feed = rss([[1, 1, "Old"], [80, 1, "Forever hotfixes"]]);
  verdicts = say([80]);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  expect(await news.run(env, now())).toMatchObject({ posted: ["Forever hotfixes"] });
  log.mockRestore();
  expect(used).toEqual(["gemini-3.5-flash", "gemini-3.8-flash"]);
});
