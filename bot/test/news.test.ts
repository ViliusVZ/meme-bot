// ⚔️ WoW: Forever news against a real Postgres, with the feed, the forum, Gemini and Discord stubbed
// (one outbound stub for all of them: the harness's).
import { readFileSync } from "node:fs";
import { expect, it } from "@effect/vitest";
import { beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { News, FEED, FORUM, ASK_AGAIN, FALLBACK_AFTER, EVERY, parseFeed } from "../src/news.js";
import { AppConfig } from "../src/config.js";
import { Gemini } from "../src/gemini.js";
import { AppStatus, ROUTER_CONFIG, routesOn } from "../src/app.js";
import { Db } from "../src/db/db.js";
import { newsItems, settings } from "../src/db/schema.js";
import type { AppServices } from "../src/runtime.js";
import { harness, json, type Call } from "./fx.js";

const START = "2026-11-11T12:00:00Z";

// what the outside world answers, per test
let feed = "";
let feedStatus = 200;
let verdicts: ((topics: number[]) => unknown) | "down" = () => ({ items: [] });
let discordFails = false;
let forumDown = false;

const outside = (c: Call) => {
  if (c.path === FEED) return new Response(feed, { status: feedStatus });
  if (c.path.startsWith(FORUM)) {
    if (forumDown) return json({ errors: ["nope"] }, 503);
    if (c.path.includes("/t/")) return json({ category_id: Number(c.path.match(/\/t\/(\d+)/)![1]) >= 100 ? 235 : 360 });
    return json({ category: { name: c.path.includes("/c/360/") ? "WoW: Forever General Discussion" : "General Discussion" } });
  }
  if (c.path.includes("generativelanguage")) {
    if (verdicts === "down") return json({ error: "overloaded" }, 503);
    const topics = [...String(c.body.contents[0].parts[0].text).matchAll(/"topic":(\d+)/g)].map((m) => Number(m[1]));
    return json({ candidates: [{ content: { parts: [{ text: JSON.stringify(verdicts(topics)) }] } }] });
  }
  if (discordFails && c.path === "/channels/news/messages") return json({ message: "Missing Access", code: 50001 }, 403);
  return undefined;
};

const h = harness({
  tables: [newsItems, settings],
  discord: { firstId: 100, routes: [outside] },
  clock: START,
  env: { NEWS_CHANNEL_ID: "news", GEMINI_API_KEY: "k" },
});
const calls = h.calls;

// the frozen clock's time, as this file reads it (the harness sets it back to START before each test)
let clock = Date.parse(START);
beforeEach(() => {
  clock = Date.parse(START);
  feed = "";
  feedStatus = 200;
  discordFails = false;
  forumDown = false;
  verdicts = () => ({ items: [] });
});
const setTime = (at: number | string) => Effect.andThen(Effect.sync(() => void (clock = typeof at === "string" ? Date.parse(at) : at)), h.setTime(at));
const now = () => Math.floor(clock / 1000);

/** A blue-tracker feed with these posts: [topic, post number, title, minutes ago]. */
function rss(posts: [number, number, string, number?][]) {
  const items = posts
    .map(
      ([topic, post, title, ago = 60]) => `<item><title>${title}</title><description><![CDATA[<p>About ${title}.</p>]]></description>
<link>https://eu.forums.blizzard.com/en/wow/t/slug/${topic}/${post}</link><pubDate>${new Date(clock - ago * 60_000).toUTCString()}</pubDate></item>`,
    )
    .join("\n");
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Blue tracker</title>${items}</channel></rss>`;
}
const posted = () => calls.filter((c) => c.method === "POST" && c.path === "/channels/news/messages");
const item = (topic: number) =>
  Effect.gen(function* () {
    const db = yield* Db;
    return (yield* db.select().from(newsItems).where(eq(newsItems.topic_id, topic)))[0];
  });
const say = (keep: number[], summary = "Hunters stop pulling half the zone.") => (topics: number[]) => ({
  items: topics.map((topic) => ({ topic, forever: keep.includes(topic), news: keep.includes(topic), summary })),
});
const run = (at = now(), fallback = false) => News.use((n) => n.run({ at, fallback }));
const geminiCalls = () => calls.filter((c) => c.path.includes("generativelanguage"));

/**
 * A deploy: a News with no state of its own (the times it keeps are in the database), the last one
 * closed. What the old `_reset()` did.
 */
const deploys = () => {
  let last: Scope.Closeable | undefined;
  return Effect.gen(function* () {
    if (last) yield* Scope.close(last, Exit.void);
    last = yield* Scope.make();
    return Context.get(yield* Layer.buildWithScope(Layer.fresh(News.layer), last), News);
  });
};

/** A News on this test's services with no news channel configured (production's first deploy). */
const unconfigured = Effect.gen(function* () {
  const config = yield* AppConfig;
  const scope = yield* Scope.make();
  const layer = Layer.fresh(News.layer).pipe(Layer.provide(Layer.succeed(AppConfig, { ...config, newsChannelId: undefined })));
  return Context.get(yield* Layer.buildWithScope(layer, scope), News);
});

it.effect("the real feed parses: staff posts with their topic and post number", () =>
  Effect.sync(() => {
    const xml = readFileSync(new URL("./fixtures/blue-tracker.rss", import.meta.url), "utf8");
    const posts = parseFeed(xml);
    expect(posts.length).toBe(50);
    expect(posts.find((p) => p.topic === 639885)).toMatchObject({ title: "WoW: Forever Hotfixes - November 10, 2026", post: 5 });
    expect(posts.every((p) => p.published > 1.7e9 && p.excerpt.length > 0 && !p.excerpt.includes("<"))).toBe(true);
    expect(parseFeed("<rss><channel></channel></rss>")).toEqual([]);
  }).pipe(h.provide),
);

it.effect("the first run marks what's there as seen and lets only the newest Forever item through", () =>
  Effect.gen(function* () {
    feed = rss([
      [1, 1, "World of Warcraft: Midnight Hotfixes", 30],
      [2, 1, "WoW: Forever Hotfixes - November 10", 90],
      [3, 1, "World of Warcraft: Forever Now Live!", 3000],
    ]);
    verdicts = say([2]);
    expect(yield* run()).toMatchObject({ seen: 3, judged: 1, posted: ["WoW: Forever Hotfixes - November 10"] });
    const [card] = posted();
    expect(card.body.flags & (1 << 12)).toBeTruthy();
    expect(card.body.allowed_mentions).toEqual({ parse: [] });
    expect(JSON.stringify(card.body.components)).toContain("[WoW: Forever Hotfixes - November 10](https://eu.forums.blizzard.com/en/wow/t/slug/2/1)\\nHunters stop pulling half the zone.");
    expect((yield* item(1)).state).toBe("old");
    expect((yield* item(3)).state).toBe("old");
  }).pipe(h.provide),
);

it.effect("Gemini picks the Forever news out of everything else, in one question", () =>
  Effect.gen(function* () {
    feed = rss([[1, 1, "Old post"]]);
    yield* run();
    calls.length = 0;
    feed = rss([
      [1, 1, "Old post"],
      [10, 1, "PvP Faction Balance Updates", 20],
      [11, 4, "No gold from quests at lvl 60? Seriously?", 15],
      [12, 1, "The Venomous Abyss Raid Tuning Incoming", 10],
    ]);
    verdicts = say([10]);
    expect(yield* run()).toMatchObject({ seen: 3, judged: 3, posted: ["PvP Faction Balance Updates"] });
    expect(geminiCalls()).toHaveLength(1);
    expect((yield* item(11)).state).toBe("skip");
    expect((yield* item(12)).state).toBe("skip");
    // nothing new next time: Gemini isn't asked again, nothing's posted twice
    calls.length = 0;
    expect(yield* run(now() + 1800)).toEqual({});
    expect(calls.filter((c) => c.path !== FEED)).toHaveLength(0);
  }).pipe(h.provide),
);

it.effect("Gemini down: items wait, and after 6 hours the title decides", () =>
  Effect.gen(function* () {
    feed = rss([[1, 1, "Old"]]);
    yield* run();
    verdicts = "down";
    feed = rss([
      [1, 1, "Old"],
      [20, 1, "Explore WoW: Forever with a Gamepad"],
      [21, 1, "Midnight Talebound Demo"],
    ]);
    const t0 = now();
    const asks = () => calls.filter((c) => c.path.includes("gemini-3.5")).length;
    expect(yield* run(t0)).toEqual({ seen: 2 });
    expect(asks()).toBe(1);
    // the same lot isn't put to Gemini every half hour: every 2 hours
    yield* run(t0 + 1800);
    expect(asks()).toBe(1);
    yield* run(t0 + ASK_AGAIN);
    expect(asks()).toBe(2);
    expect(yield* run(t0 + FALLBACK_AFTER - 1)).toEqual({});
    expect(yield* run(t0 + FALLBACK_AFTER)).toMatchObject({ judged: 2, posted: ["Explore WoW: Forever with a Gamepad"] });
    expect((yield* item(20)).summary).toBeNull();
    expect((yield* item(21)).state).toBe("skip");
  }).pipe(h.provide),
);

it.effect("at most 5 a day, oldest first; the rest go out the next day", () =>
  Effect.gen(function* () {
    feed = rss([[1, 1, "Old"]]);
    yield* run();
    feed = rss([[1, 1, "Old"], ...Array.from({ length: 7 }, (_, i) => [30 + i, 1, `Forever thing ${i}`, 100 - i] as [number, number, string, number])]);
    verdicts = (topics) => say(topics)(topics);
    const r = yield* run();
    expect(r.posted).toEqual(["Forever thing 0", "Forever thing 1", "Forever thing 2", "Forever thing 3", "Forever thing 4"]);
    expect(yield* run(now() + 3600)).toEqual({});
    yield* setTime("2026-11-12T08:00:00Z");
    expect(yield* run()).toMatchObject({ posted: ["Forever thing 5", "Forever thing 6"] });
  }).pipe(h.provide),
);

it.effect("a post Discord refuses is given back and goes out next time", () =>
  Effect.gen(function* () {
    feed = rss([[1, 1, "Old"]]);
    yield* run();
    feed = rss([[1, 1, "Old"], [40, 1, "Forever maintenance"]]);
    verdicts = say([40]);
    discordFails = true;
    yield* h.promise(run(), (p) => expect(p).rejects.toThrow("403"));
    expect(yield* item(40)).toMatchObject({ state: "post", message_id: null });
    discordFails = false;
    expect(yield* run(now() + 600)).toMatchObject({ posted: ["Forever maintenance"] });
  }).pipe(h.provide),
);

it.effect("a topic Blizzard keeps adding to (hotfixes) gets one “updated” line a day", () =>
  Effect.gen(function* () {
    feed = rss([[1, 1, "Old"]]);
    yield* run();
    feed = rss([[1, 1, "Old"], [50, 1, "WoW: Forever Hotfixes"]]);
    verdicts = say([50]);
    yield* run();
    feed = rss([[1, 1, "Old"], [50, 3, "WoW: Forever Hotfixes"]]);
    expect(yield* run(now() + 1800)).toMatchObject({ posted: ["updated: WoW: Forever Hotfixes"] });
    expect(posted().at(-1)!.body.content).toBe("🔧 **WoW: Forever Hotfixes** got an update → <https://eu.forums.blizzard.com/en/wow/t/slug/50/3>");
    feed = rss([[1, 1, "Old"], [50, 4, "WoW: Forever Hotfixes"]]);
    expect(yield* run(now() + 3600)).toEqual({}); // same day: quiet
    yield* setTime("2026-11-12T08:00:00Z");
    expect(yield* run()).toMatchObject({ posted: ["updated: WoW: Forever Hotfixes"] });
    // a refused update line is skipped quietly (tomorrow's says it anyway)
    yield* setTime("2026-11-13T08:00:00Z");
    feed = rss([[1, 1, "Old"], [50, 6, "WoW: Forever Hotfixes"]]);
    discordFails = true;
    expect(yield* run()).toEqual({});
  }).pipe(h.provide),
);

it.effect("the minute job: every 30 minutes, not again after a restart, a failure retried in 10, the owner told after a day", () =>
  Effect.gen(function* () {
    const deploy = deploys();
    let news = yield* deploy;
    const check = () => Effect.flatMap(Effect.suspend(() => Effect.succeed(news)), (n) => n.check);
    const at = (t: number) => setTime(t * 1000);
    feed = rss([[1, 1, "Old"]]);
    const t0 = now();
    expect(yield* check()).toEqual({ checking: true });
    yield* h.settle;
    expect(yield* news.running).toBe(false);
    yield* at(t0 + 60);
    expect(yield* check()).toEqual({});
    news = yield* deploy; // a restart: the times live in the database
    yield* at(t0 + 600);
    expect(yield* check()).toEqual({});
    const fetched = () => calls.filter((c) => c.path === FEED).length;
    expect(fetched()).toBe(1);
    yield* at(t0 + EVERY);
    expect(yield* check()).toEqual({ checking: true });
    yield* h.settle;
    expect(yield* news.running).toBe(false);
    expect(fetched()).toBe(2);
    // Blizzard's forums down: retried after 10 minutes, quietly
    feedStatus = 503;
    const t1 = t0 + 2 * EVERY;
    yield* at(t1);
    yield* check();
    yield* h.settle;
    expect(yield* news.running).toBe(false);
    yield* at(t1 + 300);
    expect(yield* check()).toEqual({});
    yield* at(t1 + 600);
    expect(yield* check()).toEqual({ checking: true });
    yield* h.settle;
    expect(yield* news.running).toBe(false);
    expect(h.logs.join(" ")).not.toContain("checking WoW: Forever news failed");
    // a day without one good check: the owner hears about it
    yield* at(t0 + EVERY + 86400 + 60);
    yield* check();
    yield* h.settle;
    expect(yield* news.running).toBe(false);
    expect(h.logs.join(" ")).toContain("checking WoW: Forever news failed");
  }).pipe(h.provide),
);

it.effect("no channel configured, no news", () =>
  Effect.gen(function* () {
    const news = yield* unconfigured;
    expect(yield* news.check).toEqual({});
    expect(calls).toEqual([]);
  }).pipe(h.provide),
);

it.effect("Gemini is told which forum section each post is in (the best hint for which game); no section, no problem", () =>
  Effect.gen(function* () {
    feed = rss([[1, 1, "Old"]]);
    yield* run();
    const prompts = () => geminiCalls().map((c) => String(c.body.contents[0].parts[0].text));
    feed = rss([[1, 1, "Old"], [60, 1, "Dungeon Enemy XP Increased"], [160, 1, "Prepare for Forever"]]);
    verdicts = say([60, 160]);
    yield* run();
    expect(prompts().at(-1)).toContain('"topic":60,"section":"WoW: Forever General Discussion"');
    expect(prompts().at(-1)).toContain('"topic":160,"section":"General Discussion"');
    expect((yield* item(60)).section).toBe("WoW: Forever General Discussion");
    // the forum's JSON down: judged without it
    forumDown = true;
    feed = rss([[1, 1, "Old"], [70, 1, "Forever maintenance"]]);
    verdicts = say([70]);
    expect(yield* run(now() + 1800)).toMatchObject({ posted: ["Forever maintenance"] });
    expect(prompts().at(-1)).toContain('"topic":70,"section":"unknown"');
  }).pipe(h.provide),
);

it.effect("the fast Gemini busy: the other one answers", () =>
  Effect.gen(function* () {
    const used: string[] = [];
    h.override = (c) => {
      if (!c.path.includes("generativelanguage")) return undefined;
      used.push(c.path.match(/models\/([^:]+)/)![1]);
      return used.length === 1 ? json({ error: { message: "high demand" } }, 503) : undefined;
    };
    feed = rss([[1, 1, "Old"]]);
    yield* run();
    feed = rss([[1, 1, "Old"], [80, 1, "Forever hotfixes"]]);
    verdicts = say([80]);
    expect(yield* run()).toMatchObject({ posted: ["Forever hotfixes"] });
    expect(used).toEqual(["gemini-3.5-flash", "gemini-3.8-flash"]);
  }).pipe(h.provide),
);

// ---------------------------------------------------------------- the port's own (plan 05)

it.effect("no channel configured: no fetch, no Gemini, no post, nothing stored, from the job and from a forced run", () =>
  Effect.gen(function* () {
    const news = yield* unconfigured;
    feed = rss([[1, 1, "WoW: Forever Hotfixes"]]);
    verdicts = say([1]);
    expect(yield* news.check).toEqual({});
    expect(yield* news.run()).toEqual({});
    expect(yield* news.run({ fallback: true })).toEqual({});
    yield* h.settle;
    expect(calls).toEqual([]);
    const db = yield* Db;
    expect(yield* db.select().from(newsItems)).toEqual([]);
    expect(yield* db.select().from(settings)).toEqual([]);
  }).pipe(h.provide),
);

it.effect("the first run on a feed with a backlog (the real one): no dump, only the newest Forever item, silent", () =>
  Effect.gen(function* () {
    feed = readFileSync(new URL("./fixtures/blue-tracker.rss", import.meta.url), "utf8");
    const topics = new Set(parseFeed(feed).map((p) => p.topic));
    verdicts = (ts) => say(ts)(ts); // Gemini would let anything through
    yield* setTime("2026-11-11T09:00:00Z");
    const r = yield* run();
    expect(r.seen).toBe(topics.size);
    // the newest topic by its first staff post (the hotfixes topic began days earlier)
    expect(r.posted).toEqual(["Prepare for Forever, Try Midnight’s Talebound, and Discover Sweet Treats in WoW Weekly"]);
    expect(posted()).toHaveLength(1);
    expect(posted()[0].body.flags & (1 << 12)).toBeTruthy();
    // the one let through was the only one judged; everything else is marked as there before us
    expect(geminiCalls()).toHaveLength(1);
    expect([...String(geminiCalls()[0].body.contents[0].parts[0].text).matchAll(/"topic":(\d+)/g)]).toHaveLength(1);
    const db = yield* Db;
    const states = (yield* db.select().from(newsItems)).map((x) => x.state);
    expect(states.filter((s) => s === "old")).toHaveLength(topics.size - 1);
    expect(states.filter((s) => s === "posted")).toHaveLength(1);
    // and the next run, with the same feed, posts nothing more
    expect(yield* run(now() + 1800)).toEqual({});
    expect(posted()).toHaveLength(1);
  }).pipe(h.provide),
);

it.effect("the daily cap counts across runs: 5 posts and “updated” lines in all, every one silent", () =>
  Effect.gen(function* () {
    feed = rss([[1, 1, "Old"]]);
    yield* run();
    verdicts = (ts) => say(ts)(ts);
    feed = rss([[1, 1, "Old"], [90, 1, "Forever a", 90], [91, 1, "Forever b", 80], [92, 1, "Forever c", 70]]);
    expect((yield* run()).posted).toHaveLength(3);
    feed = rss([[1, 1, "Old"], [90, 2, "Forever a", 90], [91, 1, "Forever b", 80], [92, 1, "Forever c", 70], [93, 1, "Forever d", 60], [94, 1, "Forever e", 50]]);
    expect((yield* run(now() + 1800)).posted).toEqual(["Forever d", "Forever e"]);
    expect(yield* run(now() + 3600)).toEqual({}); // the update line for "Forever a" waits for tomorrow
    expect(posted()).toHaveLength(5);
    expect(posted().every((c) => (c.body.flags & (1 << 12)) !== 0 && c.body.allowed_mentions?.parse?.length === 0)).toBe(true);
  }).pipe(h.provide),
);

it.effect("Gemini unavailable (no key at all): nothing is asked, and the title rule decides after 6 hours", () =>
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const scope = yield* Scope.make();
    const keyless = Layer.fresh(News.layer).pipe(Layer.provide(Layer.fresh(Gemini.layer)), Layer.provide(Layer.succeed(AppConfig, { ...config, geminiApiKey: undefined })));
    const news = Context.get(yield* Layer.buildWithScope(keyless, scope), News);
    feed = rss([[1, 1, "Old"]]);
    const t0 = now();
    yield* news.run({ at: t0 });
    feed = rss([[1, 1, "Old"], [95, 1, "WoW: Forever maintenance"], [96, 1, "Midnight maintenance"]]);
    expect(yield* news.run({ at: t0 })).toEqual({ seen: 2 });
    expect(yield* news.run({ at: t0 + ASK_AGAIN })).toEqual({});
    expect(yield* news.run({ at: t0 + FALLBACK_AFTER - 1 })).toEqual({});
    expect(yield* news.run({ at: t0 + FALLBACK_AFTER })).toMatchObject({ judged: 2, posted: ["WoW: Forever maintenance"] });
    expect(geminiCalls()).toEqual([]);
  }).pipe(h.provide),
);

// ---------------------------------------------------------------- the admin route

const app = Effect.gen(function* () {
  const ctx = yield* Effect.context<AppServices>();
  const statusLayer = Layer.succeed(AppStatus, AppStatus.of({ leader: Effect.succeed(true), shuttingDown: Effect.succeed(false), publicKey: h.env.DISCORD_PUBLIC_KEY }));
  const { handler } = HttpRouter.toWebHandler(routesOn(statusLayer, ctx).pipe(Layer.provide(HttpServer.layerServices)), { disableLogger: true, routerConfig: ROUTER_CONFIG });
  return (payload: unknown, token = "a") =>
    Effect.promise(async () => {
      const res = await handler(new Request("http://local/admin/news", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(payload) }), ctx);
      const text = await res.text();
      return { statusCode: res.status, body: text };
    });
});

it.effect("POST /admin/news: one check now; `fallback` judges by the title rule at once, without Gemini", () =>
  Effect.gen(function* () {
    const admin = yield* app;
    expect((yield* admin({}, "i")).statusCode).toBe(401);
    feed = rss([[1, 1, "Old"]]);
    const first = yield* admin({});
    expect([first.statusCode, JSON.parse(first.body)]).toEqual([200, { seen: 1 }]);
    feed = rss([[1, 1, "Old"], [97, 1, "WoW: Forever Hotfixes"], [98, 1, "Midnight Hotfixes"]]);
    const forced = yield* admin({ fallback: true });
    expect([forced.statusCode, JSON.parse(forced.body)]).toEqual([200, { seen: 2, judged: 2, posted: ["WoW: Forever Hotfixes"] }]);
    expect(geminiCalls()).toEqual([]);
    expect((yield* item(98)).state).toBe("skip");
    // and without it, Gemini is asked as the job would
    feed = rss([[1, 1, "Old"], [97, 1, "WoW: Forever Hotfixes"], [98, 1, "Midnight Hotfixes"], [99, 1, "Forever patch notes"]]);
    verdicts = say([99]);
    const asked = yield* admin({});
    expect(JSON.parse(asked.body)).toEqual({ seen: 1, judged: 1, posted: ["Forever patch notes"] });
    expect(geminiCalls()).toHaveLength(1);
  }).pipe(h.provide),
);

it.effect("POST /admin/news: the feed down is answered 500 with what went wrong", () =>
  Effect.gen(function* () {
    const admin = yield* app;
    feedStatus = 503;
    const r = yield* admin({});
    expect(r.statusCode).toBe(500);
    expect(r.body).toContain("blue tracker -> 503");
  }).pipe(h.provide),
);
