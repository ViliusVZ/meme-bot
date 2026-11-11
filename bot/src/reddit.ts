// The meme pool: this week's top image posts from the subreddit's public Atom feed (Reddit's JSON
// API needs an approved OAuth app; the feed doesn't, and it's already sorted by score). Fetched
// every few hours by the minute job; storing is an upsert, so repeats are harmless.
import { XMLParser } from "fast-xml-parser";
import { eq } from "drizzle-orm";
import { Cause, Clock, Context, DateTime, Duration, Effect, FiberHandle, Layer, Option, Ref, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { settings } from "./db/index.js";
import { Db, type DbError } from "./db/db.js";
import { AppConfig } from "./config.js";
import { Memes, type Incoming } from "./memes.js";
import { Alerts } from "./alerts.js";
import type { Env } from "./env.js";
import { run, runSync } from "./legacy.js"; // LEGACY-BRIDGE

const USER_AGENT = "discord-meme-bot/3.0 (daily top post)";
const IMAGE = /href="(https:\/\/i\.redd\.it\/[^"]+\.(?:png|jpe?g|gif|webp))"/;
const EVERY = 6 * 3600_000;
const STALE = 12 * 3600_000; // the pool holds a week of memes: only this long without a refill is worth a DM
const RETRY = 10 * 60_000; // after a failed refill
const ATTEMPT_TIMEOUT = Duration.seconds(20);
const RETRYABLE = [429, 500, 502, 503];
const KEY = "reddit_refill"; // { ok, tried }: when the last refill worked, and the last attempt (unix ms)
const Times = Schema.Struct({ ok: Schema.optional(Schema.Number), tried: Schema.optional(Schema.Number) });

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", processEntities: true, htmlEntities: true });

/** The feed's image posts, ranked as Reddit ranks them (videos, galleries and text posts skipped). */
export function parseFeed(xml: string): Incoming[] {
  const feed = parser.parse(xml)?.feed;
  const entries = [feed?.entry ?? []].flat();
  const out: Incoming[] = [];
  entries.forEach((e: any, i: number) => {
    const content = unescape(String(e.content?.["#text"] ?? e.content ?? ""));
    const image = content.match(IMAGE)?.[1];
    if (!image) return;
    const links = [e.link].flat();
    out.push({
      id: String(e.id),
      title: unescape(String(e.title?.["#text"] ?? e.title ?? "")),
      image,
      link: links.find((l: any) => l?.["@href"])?.["@href"] ?? "",
      author: String(e.author?.name ?? ""),
      published: String(e.published ?? ""),
      rank: i + 1,
    });
  });
  return out;
}

/** Leftover HTML entities inside the (already XML-decoded) text. */
function unescape(s: string) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Reddit answered something other than the feed. */
export class RedditError extends Schema.TaggedError<RedditError>()("RedditError", { status: Schema.Number, reset: Schema.Number }) {
  override get message() {
    return `reddit ${this.status}`;
  }
}

/**
 * Reddit's rule as it always was: 429 and 5xx (500, 502, 503) are tried again, up to 4 attempts,
 * 1, 2, 4 s apart, or for a 429 the rate limit's reset plus 2 s; never more than a minute. A
 * network error or a timeout is final.
 */
const retries = Schedule.recurs(3).pipe(
  Schedule.setInputType<unknown>(),
  Schedule.while(({ input }) => input instanceof RedditError && RETRYABLE.includes(input.status)),
  Schedule.modifyDelay(({ input, attempt: n }) =>
    Effect.succeed(Duration.seconds(Math.min(60, input instanceof RedditError && input.status === 429 ? input.reset + 2 : 2 ** (n - 1)))),
  ),
);

export class Reddit extends Context.Service<
  Reddit,
  {
    /**
     * Minute job: refill the pool every 6 hours, and once more at the daily post hour so yesterday's
     * top posts are in before the daily meme is picked (postDaily waits a minute for it). Runs in
     * the background so a slow Reddit never holds up the other jobs; a failure is retried after 10 min.
     */
    readonly maybeRefill: Effect.Effect<{ refilling?: boolean }, DbError>;
    /** A refill is in flight (postDaily waits for it, so the daily pick sees fresh ranks). */
    readonly refilling: Effect.Effect<boolean>;
    /** Tests: forget everything in memory, as a restart would. */
    readonly reset: Effect.Effect<void>; // LEGACY-BRIDGE
  }
>()("meme-bot/reddit") {
  static readonly layer = Layer.effect(
    Reddit,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const db = yield* Db;
      const http = yield* HttpClient.HttpClient;
      const memes = yield* Memes;
      const alerts = yield* Alerts;
      // the refill times outlive a restart (in `settings`): otherwise every deploy (or a crash loop)
      // fetches straight away, and enough of those in a day get the server's address rate-limited
      // by Reddit (429/403)
      const initial = { lastOk: 0, lastTry: 0, restored: false };
      const state = yield* Ref.make(initial);
      const handle = yield* FiberHandle.make<void, never>();

      const fetchFeed = Effect.gen(function* () {
        const req = HttpClientRequest.get(`https://www.reddit.com/r/${config.subreddit}/top/.rss?t=week&limit=100`).pipe(
          HttpClientRequest.setHeaders({ "User-Agent": USER_AGENT }),
        );
        const res = yield* http.execute(req);
        if (res.status >= 200 && res.status < 300) return yield* res.text;
        return yield* new RedditError({ status: res.status, reset: Number(res.headers["x-ratelimit-reset"] ?? 0) });
      }).pipe(Effect.timeout(ATTEMPT_TIMEOUT), Effect.retry(retries));

      const refill = Effect.gen(function* () {
        const found = parseFeed(yield* fetchFeed);
        return { fetched: found.length, stored: yield* memes.ingest(found) };
      });

      const restore = Effect.gen(function* () {
        if ((yield* Ref.get(state)).restored) return;
        const [row] = yield* db.select().from(settings).where(eq(settings.key, KEY));
        const last = Option.getOrElse(Schema.decodeUnknownOption(Times)(row?.value ?? {}), (): typeof Times.Type => ({}));
        yield* Ref.update(state, (s) => ({ lastOk: Math.max(s.lastOk, last.ok ?? 0), lastTry: Math.max(s.lastTry, last.tried ?? 0), restored: true }));
      });

      const remember = Effect.gen(function* () {
        const { lastOk, lastTry } = yield* Ref.get(state);
        const value = { ok: lastOk, tried: lastTry };
        const at = DateTime.toDate(yield* DateTime.now);
        yield* db.insert(settings).values({ key: KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value, updated_at: at } });
      });

      const failed = Effect.fnUntraced(function* (e: unknown) {
        const { lastOk } = yield* Ref.get(state);
        const text = e instanceof RedditError ? `Error: ${e.message}` : String(e); // the old error's text
        // Reddit rate-limits the server's address now and then; the retry in 10 min usually works
        if ((yield* Clock.currentTimeMillis) - lastOk < STALE) return yield* Effect.logInfo(`refill failed, retrying in 10 min: ${text}`);
        const since = lastOk ? `<t:${Math.floor(lastOk / 1000)}:R>` : "ever";
        yield* alerts.failed("fetching memes from Reddit", `${text}\nno fresh memes since ${since}: the daily meme may run dry`);
      });

      const inBackground = Effect.gen(function* () {
        yield* remember.pipe(Effect.ignore); // best effort: the refill goes ahead regardless
        const r = yield* refill;
        const ok = yield* Clock.currentTimeMillis;
        yield* Ref.update(state, (s) => ({ ...s, lastOk: ok }));
        yield* Effect.logInfo("memes refilled").pipe(Effect.annotateLogs(r));
        yield* remember.pipe(Effect.catch((e) => Effect.logInfo(`refill: couldn't note the time ${e}`)));
      }).pipe(Effect.catchCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.void : failed(Cause.squash(cause)))));

      const maybeRefill = Effect.gen(function* () {
        yield* restore;
        const now = yield* Clock.currentTimeMillis;
        const postHour = now - (now % 86_400_000) + config.postHourUtc * 3_600_000;
        const s = yield* Ref.get(state);
        const running = Option.isSome(yield* FiberHandle.get(handle));
        const due = now - s.lastOk >= EVERY || (now >= postHour && s.lastOk < postHour);
        if (!due || running || (s.lastTry > s.lastOk && now - s.lastTry < RETRY)) return {};
        yield* Ref.update(state, (x) => ({ ...x, lastTry: now }));
        yield* FiberHandle.run(handle, inBackground, { onlyIfMissing: true });
        return { refilling: true };
      }).pipe(Effect.withSpan("Reddit.maybeRefill"));

      return Reddit.of({
        maybeRefill,
        refilling: Effect.map(FiberHandle.get(handle), Option.isSome),
        reset: Ref.set(state, initial), // LEGACY-BRIDGE
      });
    }),
  );
}

// the old functions, for the code that isn't on Effect yet
export const maybeRefill = (env: Env) => run(env, Reddit.use((r) => r.maybeRefill)); // LEGACY-BRIDGE
export const refilling = () => runSync(Reddit.use((r) => r.refilling)); // LEGACY-BRIDGE
export const _reset = () => runSync(Reddit.use((r) => r.reset)); // LEGACY-BRIDGE
