// The Reddit feed parser, on a real copy of the feed (test/fixtures/feed.xml), and how often the
// pool is refilled from it.
import { readFileSync } from "node:fs";
import { expect, it } from "@effect/vitest";
import { eq } from "drizzle-orm";
import { Clock, Context, Effect, Exit, Layer, Scope } from "effect";
import { Reddit, parseFeed } from "../src/reddit.js";
import { Alerts } from "../src/alerts.js";
import { Db } from "../src/db/db.js";
import { settings } from "../src/db/schema.js";
import { harness } from "./fx.js";

const FEED = readFileSync(new URL("./fixtures/feed.xml", import.meta.url), "utf8");

it.effect("image posts come out ranked, with titles decoded", () =>
  Effect.sync(() => {
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
  }).pipe(h.provide),
);

it.effect("a feed with a single entry still parses", () =>
  Effect.sync(() => {
    const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><author><name>/u/x</name></author>
    <content type="html">&lt;a href=&quot;https://i.redd.it/abc.png&quot;&gt;[link]&lt;/a&gt;</content>
    <id>t3_abc</id><link href="https://www.reddit.com/r/ProgrammerHumor/comments/abc/x/" /><published>2026-11-04T10:00:00+00:00</published>
    <title>Tom &amp;amp; Jerry &amp;#39;s code</title></entry></feed>`;
    expect(parseFeed(xml)).toEqual([
      { id: "t3_abc", title: "Tom & Jerry 's code", image: "https://i.redd.it/abc.png", link: "https://www.reddit.com/r/ProgrammerHumor/comments/abc/x/", author: "/u/x", published: "2026-11-04T10:00:00+00:00", rank: 1 },
    ]);
  }).pipe(h.provide),
);

// ---------------------------------------------------------------- refills

// the refill tests set their own time (the clock is frozen there, as the old fake Date was)
const h = harness({ clock: "2026-11-09T12:00:00Z" });

/**
 * A deploy: a Reddit with no state of its own (what it remembers is in the database), the last
 * one closed. What the old `_reset()` did (a fresh runtime), for the one service these tests use.
 */
const deploys = () => {
  let last: Scope.Closeable | undefined;
  return Effect.gen(function* () {
    if (last) yield* Scope.close(last, Exit.void);
    last = yield* Scope.make();
    return Context.get(yield* Layer.buildWithScope(Layer.fresh(Reddit.layer), last), Reddit);
  });
};

/**
 * `vi.waitFor` as these tests had it, under the old fake Date: vitest moves fake time on by its
 * 50 ms interval before every check, and checks again every 50 ms (real), for up to a second. The
 * refill's stored times (and the memes' ingested_at) show that creep, so it is kept.
 */
const creep = Effect.flatMap(Clock.currentTimeMillis, (t) => h.setTime(t + 50));
const waitFor = <A, E, R>(check: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    for (let i = 0; ; i++) {
      yield* creep;
      const exit = yield* Effect.exit(check);
      if (Exit.isSuccess(exit) || i >= 20) return yield* exit;
      yield* Effect.sleep(50);
    }
  });

it.effect("a restart doesn't fetch again: the last refill's time is in the database", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const deploy = deploys();
    let fetches = 0;
    h.fetch = (async () => (fetches++, new Response(FEED, { status: 200 }))) as typeof fetch;
    yield* h.setTime(Date.parse("2026-11-09T12:00:00Z"));
    let reddit = yield* deploy;
    expect(yield* reddit.maybeRefill).toEqual({ refilling: true });
    yield* waitFor(Effect.gen(function* () { expect(yield* reddit.refilling).toBe(false); }));
    const saved = () => Effect.map(db.select().from(settings).where(eq(settings.key, "reddit_refill")), (rows) => rows[0]?.value as { ok: number; tried: number });
    yield* waitFor(Effect.gen(function* () { expect((yield* saved()).ok).toBeGreaterThan(0); }));
    expect((yield* saved()).ok - Date.parse("2026-11-09T12:00:00Z")).toBeLessThan(1000); // (fake time creeps while waiting)
    expect(fetches).toBe(1);
    expect(yield* reddit.maybeRefill).toEqual({}); // not due again for 6 hours
    reddit = yield* deploy; // a deploy
    expect(yield* reddit.maybeRefill).toEqual({});
    expect(fetches).toBe(1);
    // 6 hours on, it's due (restarted or not)
    yield* h.setTime(Date.parse("2026-11-09T18:00:01Z"));
    reddit = yield* deploy;
    expect(yield* reddit.maybeRefill).toEqual({ refilling: true });
    yield* waitFor(Effect.gen(function* () { expect(yield* reddit.refilling).toBe(false); }));
    expect(fetches).toBe(2);
    yield* deploy;
  }).pipe(h.provide),
);

it.effect("a failed refill waits 10 minutes before trying again, also across a restart", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const deploy = deploys();
    yield* db.delete(settings).where(eq(settings.key, "reddit_refill"));
    let fetches = 0;
    h.fetch = (async () => (fetches++, new Response("blocked", { status: 403 }))) as typeof fetch;
    yield* h.setTime(Date.parse("2026-11-10T12:00:00Z"));
    let reddit = yield* deploy;
    expect(yield* reddit.maybeRefill).toEqual({ refilling: true });
    yield* waitFor(Effect.gen(function* () { expect(yield* reddit.refilling).toBe(false); }));
    yield* waitFor(Effect.gen(function* () { expect((yield* db.select().from(settings).where(eq(settings.key, "reddit_refill")))[0]?.value).toMatchObject({ ok: 0, tried: Date.parse("2026-11-10T12:00:00Z") }); }));
    reddit = yield* deploy;
    yield* h.setTime(Date.parse("2026-11-10T12:05:00Z"));
    expect(yield* reddit.maybeRefill).toEqual({});
    yield* h.setTime(Date.parse("2026-11-10T12:10:01Z"));
    expect(yield* reddit.maybeRefill).toEqual({ refilling: true });
    yield* waitFor(Effect.gen(function* () { expect(yield* reddit.refilling).toBe(false); }));
    expect(fetches).toBe(2);
    yield* deploy;
  }).pipe(h.provide),
);

it.effect("a failed refill DMs only once the pool has gone 12 hours without fresh memes", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const alerts = yield* Alerts;
    const deploy = deploys();
    yield* alerts.setOwner("owner"); // ALERT_USER_ID
    const dms: string[] = [];
    h.fetch = (async (url: string, init: RequestInit = {}) => {
      if (String(url).includes("reddit.com")) return new Response("blocked", { status: 403 });
      if (String(url).endsWith("/users/@me/channels")) return Response.json({ id: "dm" });
      dms.push(JSON.parse(String(init.body)).content);
      return Response.json({ id: "m" });
    }) as typeof fetch;
    const ok = Date.parse("2026-11-11T01:00:00Z");
    const refillFrom = (now: string) =>
      Effect.gen(function* () {
        yield* db.insert(settings).values({ key: "reddit_refill", value: { ok, tried: ok } }).onConflictDoUpdate({ target: settings.key, set: { value: { ok, tried: ok } } });
        yield* h.setTime(Date.parse(now));
        const reddit = yield* deploy;
        expect(yield* reddit.maybeRefill).toEqual({ refilling: true });
        yield* waitFor(Effect.gen(function* () { expect(yield* reddit.refilling).toBe(false); }));
        yield* alerts.settle;
      });
    yield* refillFrom("2026-11-11T08:00:00Z"); // 7 h since the last good one: only logged
    expect(dms).toEqual([]);
    yield* refillFrom("2026-11-11T13:00:01Z"); // 12 h: worth a DM
    expect(dms).toHaveLength(1);
    expect(dms[0]).toContain("**fetching memes from Reddit** failed");
    expect(dms[0]).toContain(`no fresh memes since <t:${ok / 1000}:R>`);
    yield* deploy;
  }).pipe(h.provide),
);

it.effect("Reddit's busy answers are tried again: 1 s after a 503, then the 429's reset plus 2 s; a 404 is final", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    const deploy = deploys();
    const answers = [new Response("busy", { status: 503 }), new Response("slow down", { status: 429, headers: { "x-ratelimit-reset": "1" } }), new Response(FEED, { status: 200 })];
    const at: number[] = [];
    h.fetch = (async (url: string) => (String(url).includes("reddit.com") ? (at.push(performance.now()), answers.shift()!) : Response.json({ id: "m" }))) as typeof fetch;
    yield* h.setTime(Date.parse("2026-11-12T12:00:00Z"));
    yield* db.delete(settings).where(eq(settings.key, "reddit_refill"));
    const reddit = yield* deploy;
    // waits on real timers (the frozen clock's sleeps are real: the stored refill time stays put)
    const idle = Effect.gen(function* () {
      for (let i = 0; i < 500 && (yield* reddit.refilling); i++) yield* Effect.sleep(20);
      expect(yield* reddit.refilling).toBe(false);
    });
    expect(yield* reddit.maybeRefill).toEqual({ refilling: true });
    yield* idle;
    expect(at).toHaveLength(3);
    const gaps = [at[1] - at[0], at[2] - at[1]];
    expect(gaps[0]).toBeGreaterThanOrEqual(990);
    expect(gaps[0]).toBeLessThan(1500);
    expect(gaps[1]).toBeGreaterThanOrEqual(2990);
    expect(gaps[1]).toBeLessThan(3500);
    // a refusal Reddit means is final: one try, and the next one is 10 minutes away
    at.length = 0;
    answers.push(new Response("gone", { status: 404 }));
    yield* h.setTime(Date.parse("2026-11-12T18:00:01Z"));
    expect(yield* reddit.maybeRefill).toEqual({ refilling: true });
    yield* idle;
    expect(at).toHaveLength(1);
    yield* deploy;
  }).pipe(h.provide),
  20_000,
);
