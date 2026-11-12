// ⚔️ WoW: Forever news in its own channel. Blizzard's staff ("blue") posts on the EU forums come
// as one RSS feed covering everything (retail, every Classic, Forever, replies to players), so
// every 30 minutes the new ones are put to Gemini in one question: is it about Forever, is it news
// (an announcement, hotfixes, notes, maintenance) rather than a reply to someone's thread, and
// what's it say in one line. A busy Gemini is asked about the same lot again every 2 hours; if it
// can't answer for 6 hours, titles that say "Forever" go through without a summary. At most 5
// posts a day, silent, oldest first; the first run only marks what's already there as seen (but
// the newest Forever item, so the channel doesn't open empty). A topic Blizzard keeps adding to
// (hotfixes) gets at most one "updated" line a day. No channel configured: none of this runs.
import { XMLParser } from "fast-xml-parser";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { Cause, Context, DateTime, Duration, Effect, Layer, Option, Ref, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { newsItems, settings } from "./db/schema.js";
import { Db, type DbError } from "./db/db.js";
import { AppConfig } from "./config.js";
import { Discord, type DiscordError, IS_COMPONENTS_V2 } from "./discord.js";
import { FAST_THEN_NEWER, Gemini } from "./gemini.js";
import { Alerts } from "./alerts.js";
import { Background } from "./background.js";
import { LocalTime } from "./localtime.js";
import { nowSec } from "./clock.js";
import { jsonText } from "./json.js";

export const FORUM = "https://eu.forums.blizzard.com/en/wow";
export const FEED = `${FORUM}/groups/blizzard-tracker/posts.rss`;
const UA = "DiscordBot (https://github.com/ViliusVZ/meme-bot, 3.0)";
export const EVERY = 30 * 60;
export const RETRY = 10 * 60; // a failed check tries again this soon
export const FALLBACK_AFTER = 6 * 3600; // Gemini silent this long → the title rule decides
export const ASK_AGAIN = 2 * 3600; // Gemini didn't answer: the same items wait this long before the next try
export const DAILY_POSTS = 5;
export const STALE = 24 * 3600; // no successful check for this long → tell the owner
const FEED_TIMEOUT = Duration.seconds(20);
const FORUM_TIMEOUT = Duration.seconds(15);
const KEY = "wow_news"; // { ok, tried }: the last good check, the last attempt (unix s)
const ASKED = "wow_news_asked"; // { at }: when Gemini was last asked to judge
export const SILENT = 1 << 12; // SUPPRESS_NOTIFICATIONS
const parser = new XMLParser({ processEntities: true, htmlEntities: true });

export type Post = { topic: number; post: number; title: string; link: string; excerpt: string; published: number };
type Item = typeof newsItems.$inferSelect;

/** The feed's staff posts. Each link is …/t/<slug>/<topic>/<post number>. */
export function parseFeed(xml: string): Post[] {
  const items = [parser.parse(xml)?.rss?.channel?.item ?? []].flat() as Record<string, unknown>[];
  const out: Post[] = [];
  for (const it of items) {
    const link = String(it.link ?? "");
    const m = link.match(/\/t\/[^/]+\/(\d+)\/(\d+)/);
    if (!m) continue;
    const text = String(it.description ?? "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    out.push({ topic: Number(m[1]), post: Number(m[2]), title: String(it.title ?? "").trim(), link, excerpt: text.slice(0, 600), published: Math.floor(Date.parse(String(it.pubDate)) / 1000) });
  }
  return out;
}

/** The news card: the title as a link, Gemini's line if there is one, silent, pinging nobody. */
export function card(item: Item) {
  return {
    flags: IS_COMPONENTS_V2 | SILENT,
    allowed_mentions: { parse: [] as string[] },
    components: [
      {
        type: 17,
        accent_color: 0x148eff,
        components: [{ type: 10, content: `### [${item.title.replace(/[[\]]/g, "")}](${item.link})${item.summary ? `\n${item.summary}` : ""}\n-# Blizzard · <t:${item.published_at}:R>` }],
      },
    ],
  };
}

/** Blizzard's blue tracker answered something other than the feed. */
export class NewsFeedError extends Schema.TaggedError<NewsFeedError>()("NewsFeedError", { status: Schema.Number }) {
  override get message() {
    return `blue tracker -> ${this.status}`;
  }
}

/** The forum's JSON (a topic's section) answered something other than 200. */
export class ForumError extends Schema.TaggedError<ForumError>()("ForumError", { path: Schema.String, status: Schema.Number }) {
  override get message() {
    return `${this.path} -> ${this.status}`;
  }
}

const Times = Schema.Struct({ ok: Schema.Number, tried: Schema.Number });
const Asked = Schema.Struct({ at: Schema.Number });
const Topic = Schema.Struct({ category_id: Schema.Number });
const Category = Schema.Struct({ category: Schema.Struct({ name: Schema.String }) });
const Verdicts = Schema.Struct({ items: Schema.Array(Schema.Struct({ topic: Schema.Number, forever: Schema.Boolean, news: Schema.Boolean, summary: Schema.String })) });
const VERDICTS_SCHEMA = {
  type: "OBJECT",
  properties: {
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { topic: { type: "INTEGER" }, forever: { type: "BOOLEAN" }, news: { type: "BOOLEAN" }, summary: { type: "STRING" } },
        required: ["topic", "forever", "news", "summary"],
      },
    },
  },
  required: ["items"],
};

const prompt = (waiting: ReadonlyArray<Item>) => `These are new staff posts from Blizzard's World of Warcraft forums. For each one decide:
- forever: is it about World of Warcraft: Forever (Blizzard's permanent "Classic plus" realms launched in November 2026)?
  A post in a forum section whose name has "WoW: Forever" in it is. Otherwise: not retail (Midnight and its
  patches), not other Classic versions (Classic Era, Burning Crusade, Mists...). Something for all of WoW (an
  account or shop change, a general event) counts only if it clearly applies to Forever.
- news: is it worth telling players about: an announcement, hotfixes, patch or development notes, maintenance,
  an event, a known issue, a change Blizzard is making? A staff reply that only answers someone's question or
  moderates a thread is not news.
- summary: one plain English sentence, at most 140 characters, saying what changes for a Forever player. No hype.

${jsonText(waiting.map((w) => ({ topic: w.topic_id, section: w.section ?? "unknown", title: w.title, text: w.excerpt })))}`;

/** What one check did (absent keys: nothing of that kind). */
export type RunResult = { seen?: number; judged?: number; posted?: string[] };
export type RunOptions = {
  /** The time to run at (unix s); the clock's by default. */
  readonly at?: number;
  /** Act as if Gemini were unavailable for good: the title rule decides now (the admin route's QA switch). */
  readonly fallback?: boolean;
};

export class News extends Context.Service<
  News,
  {
    /**
     * Minute job: every 30 minutes (the times are in the database, so a restart doesn't refetch), a
     * check in the background; a failed one is tried again after 10 minutes, and the owner hears
     * about it after a day without a good one. No channel configured: nothing, quietly.
     */
    readonly check: Effect.Effect<{ checking?: boolean }, DbError>;
    /** One check now: read the feed, judge what's new, post what's due. No channel: `{}`. */
    run(options?: RunOptions): Effect.Effect<RunResult, DbError | DiscordError | NewsFeedError | HttpFailure>;
    /** A check is running in the background. */
    readonly running: Effect.Effect<boolean>;
  }
>()("meme-bot/news") {
  static readonly layer = Layer.effect(
    News,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const db = yield* Db;
      const http = yield* HttpClient.HttpClient;
      const discord = yield* Discord;
      const gemini = yield* Gemini;
      const alerts = yield* Alerts;
      const background = yield* Background;
      const time = yield* LocalTime;
      const channel = config.newsChannelId;
      const running = yield* Ref.make(false);
      const sections = yield* Ref.make(new Map<number, string>()); // forum section id → name (they don't change)

      const save = (key: string, value: unknown) =>
        Effect.gen(function* () {
          const at = DateTime.toDate(yield* DateTime.now);
          yield* db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value, updated_at: at } });
        });
      const read = <A>(key: string, schema: Schema.Decoder<A>) =>
        Effect.map(db.select().from(settings).where(eq(settings.key, key)), ([row]) => Option.getOrUndefined(Schema.decodeUnknownOption(schema)(row?.value)));

      const get = (url: string, timeout: Duration.Input) => http.execute(HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders({ "User-Agent": UA }))).pipe(Effect.timeout(timeout));

      const fetchFeed = Effect.gen(function* () {
        const res = yield* get(FEED, FEED_TIMEOUT);
        if (res.status < 200 || res.status >= 300) return yield* new NewsFeedError({ status: res.status });
        return yield* res.text;
      });

      const forumJson = <A>(path: string, schema: Schema.Decoder<A>) =>
        Effect.gen(function* () {
          const res = yield* get(`${FORUM}${path}`, FORUM_TIMEOUT);
          if (res.status < 200 || res.status >= 300) return yield* new ForumError({ path, status: res.status });
          return yield* Schema.decodeUnknownEffect(schema)(yield* res.json);
        });

      /**
       * Which forum section a topic is in ("WoW: Forever General Discussion"): the best hint there is
       * about which game it's for. Null when the forum won't say; judging goes ahead without it.
       */
      const sectionOf = Effect.fn("News.sectionOf")(function* (topic: number) {
        return yield* Effect.gen(function* () {
          const id = (yield* forumJson(`/t/${topic}.json`, Topic)).category_id;
          const known = (yield* Ref.get(sections)).get(id);
          if (known !== undefined) return known;
          const name = (yield* forumJson(`/c/${id}/show.json`, Category)).category.name;
          yield* Ref.update(sections, (m) => new Map(m).set(id, name));
          return name;
        }).pipe(
          Effect.catchTags({
            ForumError: (e) => Effect.as(Effect.logInfo(`news: no section for ${topic} ${e.message}`), null),
            HttpClientError: (e) => Effect.as(Effect.logInfo(`news: no section for ${topic} ${e.message}`), null),
            TimeoutError: (e) => Effect.as(Effect.logInfo(`news: no section for ${topic} ${e.message}`), null),
            SchemaError: (e) => Effect.as(Effect.logInfo(`news: no section for ${topic} ${e.message}`), null),
          }),
        );
      });

      /** Note new topics (and newer staff posts in known ones). The very first run only marks what's there. */
      const take = Effect.fn("News.take")(function* (posts: Post[], t: number) {
        const newest = new Map<number, Post>();
        for (const p of posts) if (!newest.has(p.topic) || newest.get(p.topic)!.post < p.post) newest.set(p.topic, p);
        if (!newest.size) return 0;
        const [{ n }] = yield* db.select({ n: sql<number>`count(*)::int` }).from(newsItems);
        const first = n === 0;
        const known = new Map((yield* db.select().from(newsItems).where(inArray(newsItems.topic_id, [...newest.keys()]))).map((x) => [x.topic_id, x]));
        let fresh = 0;
        for (const p of newest.values()) {
          const k = known.get(p.topic);
          if (!k) {
            const firstPost = posts.filter((x) => x.topic === p.topic).sort((a, b) => a.post - b.post)[0];
            const section = first ? null : yield* sectionOf(p.topic); // (the first run judges none of these)
            yield* db
              .insert(newsItems)
              .values({ topic_id: p.topic, title: p.title, link: firstPost.link, excerpt: firstPost.excerpt, section, published_at: firstPost.published, seen_at: t, state: first ? "old" : "new", last_post: p.post, told_post: first ? p.post : 0 })
              .onConflictDoNothing();
            fresh++;
          } else if (p.post > k.last_post) {
            yield* db.update(newsItems).set({ last_post: p.post }).where(eq(newsItems.topic_id, p.topic));
          }
        }
        if (first) {
          // a channel that opens with nothing at all looks broken: let the newest Forever item through
          const [hello] = yield* db
            .select()
            .from(newsItems)
            .where(and(eq(newsItems.state, "old"), sql`${newsItems.title} ILIKE '%forever%'`))
            .orderBy(sql`${newsItems.published_at} DESC`)
            .limit(1);
          if (hello) yield* db.update(newsItems).set({ state: "new", told_post: 0, section: yield* sectionOf(hello.topic_id) }).where(eq(newsItems.topic_id, hello.topic_id));
        }
        return fresh;
      });

      /** Everything waiting to be judged, in one question to Gemini; the title rule after 6 h of silence. */
      const judge = Effect.fn("News.judge")(function* (t: number, fallback: boolean) {
        const waiting = yield* db.select().from(newsItems).where(eq(newsItems.state, "new")).orderBy(asc(newsItems.published_at));
        if (!waiting.length) return 0;
        // Gemini's free tier is often busy: something new is asked about at once, the same lot again only
        // every 2 hours (the daily budget is shared with game-name matching), then the title rule decides
        const asked = (yield* read(ASKED, Asked))?.at ?? 0;
        const ask = !fallback && (waiting.some((w) => w.seen_at > asked) || t - asked >= ASK_AGAIN);
        if (ask) yield* save(ASKED, { at: t });
        const answer = ask ? yield* gemini.ask(prompt(waiting), VERDICTS_SCHEMA, Verdicts, FAST_THEN_NEWER) : null;
        let n = 0;
        for (const w of waiting) {
          const v = answer?.items.find((x) => x.topic === w.topic_id);
          if (v) {
            const keep = v.forever && v.news;
            yield* db
              .update(newsItems)
              .set({ state: keep ? "post" : "skip", summary: keep ? v.summary.slice(0, 200) : null })
              .where(and(eq(newsItems.topic_id, w.topic_id), eq(newsItems.state, "new")));
            n++;
          } else if (fallback || t - w.seen_at >= FALLBACK_AFTER) {
            // Gemini's been no help for hours: decide by the title alone
            yield* db
              .update(newsItems)
              .set({ state: /forever/i.test(w.title) ? "post" : "skip" })
              .where(and(eq(newsItems.topic_id, w.topic_id), eq(newsItems.state, "new")));
            n++;
          }
        }
        return n;
      });

      /** Post what's due, oldest first, within today's 5; then "updated" lines for topics Blizzard added to. */
      const post = Effect.fn("News.post")(function* (to: string, t: number) {
        const l = time.at(t);
        const dayStart = time.wallToUnix(l.y, l.m, l.d, 0, 0);
        const [{ n }] = yield* db
          .select({ n: sql<number>`count(*)::int` })
          .from(newsItems)
          .where(sql`${newsItems.posted_at} >= ${dayStart} OR ${newsItems.updated_day} = ${l.day}`);
        let left = DAILY_POSTS - n;
        const done: string[] = [];
        const due = yield* db.select().from(newsItems).where(eq(newsItems.state, "post")).orderBy(asc(newsItems.published_at));
        for (const item of due) {
          if (left <= 0) break;
          // claim → post → its id is never cut short (architecture §15); a refused post gives the claim back
          const sent = yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const [claim] = yield* db
                .update(newsItems)
                .set({ state: "posted", message_id: "posting", posted_at: t, told_post: item.last_post })
                .where(and(eq(newsItems.topic_id, item.topic_id), eq(newsItems.state, "post")))
                .returning();
              if (!claim) return false;
              const msg = yield* discord
                .createMessage(to, card(claim))
                .pipe(Effect.tapError(() => db.update(newsItems).set({ state: "post", message_id: null, posted_at: null, told_post: 0 }).where(eq(newsItems.topic_id, item.topic_id))));
              yield* db.update(newsItems).set({ message_id: msg.id }).where(eq(newsItems.topic_id, item.topic_id));
              return true;
            }),
          );
          if (!sent) continue;
          done.push(item.title);
          left--;
        }
        const grown = yield* db
          .select()
          .from(newsItems)
          .where(and(eq(newsItems.state, "posted"), sql`${newsItems.last_post} > ${newsItems.told_post}`, sql`${newsItems.updated_day} IS DISTINCT FROM ${l.day}`));
        for (const item of grown) {
          if (left <= 0) break;
          const link = item.link.replace(/\/\d+$/, `/${item.last_post}`);
          // claim → the line is never cut short; a missed "updated" line isn't worth a retry: tomorrow's says it anyway
          const sent = yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const [claim] = yield* db
                .update(newsItems)
                .set({ told_post: item.last_post, updated_day: l.day })
                .where(and(eq(newsItems.topic_id, item.topic_id), sql`${newsItems.updated_day} IS DISTINCT FROM ${l.day}`))
                .returning();
              if (!claim) return false;
              return yield* discord.createMessage(to, { content: `🔧 **${item.title}** got an update → <${link}>`, flags: SILENT, allowed_mentions: { parse: [] } }).pipe(
                Effect.as(true),
                Effect.catch((e) => Effect.as(Effect.logInfo(`news update line failed ${item.topic_id} ${e.message}`), false)),
              );
            }),
          );
          if (!sent) continue;
          done.push(`updated: ${item.title}`);
          left--;
        }
        return done;
      });

      const run = Effect.fn("News.run")(function* (options: RunOptions = {}) {
        if (!channel) return {};
        const t = options.at ?? (yield* nowSec);
        const posts = parseFeed(yield* fetchFeed);
        const out: RunResult = {};
        const seen = yield* take(posts, t);
        if (seen) out.seen = seen;
        const judged = yield* judge(t, options.fallback ?? false);
        if (judged) out.judged = judged;
        const posted = yield* post(channel, t);
        if (posted.length) out.posted = posted;
        return out;
      });

      const check = Effect.gen(function* () {
        if (!channel || (yield* Ref.get(running))) return {};
        const t = yield* nowSec;
        const s = (yield* read(KEY, Times)) ?? { ok: 0, tried: 0 };
        if (t - s.ok < EVERY || (s.tried > s.ok && t - s.tried < RETRY)) return {};
        yield* Ref.set(running, true);
        yield* save(KEY, { ...s, tried: t });
        // Gemini can take minutes: never on the minute job's own time
        const once = Effect.gen(function* () {
          const r = yield* run({ at: t });
          yield* save(KEY, { ok: t, tried: t });
          if (Object.keys(r).length) yield* Effect.logInfo(`wow news ${jsonText(r)}`);
        }).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.void;
            const e = Cause.squash(cause);
            if (t - s.ok < STALE) return Effect.logInfo(`wow news check failed, retrying in 10 min: ${e instanceof Error ? e.message : String(e)}`);
            return alerts.failed("checking WoW: Forever news", e);
          }),
          Effect.ensuring(Ref.set(running, false)),
        );
        yield* background.run(once, "checking WoW: Forever news");
        return { checking: true };
      }).pipe(Effect.withSpan("News.check"));

      return News.of({ check, run, running: Ref.get(running) });
    }),
  );
}

/** What the outbound HTTP can fail with (the feed's request, its timeout, its body). */
type HttpFailure = import("effect/http").HttpClientError.HttpClientError | Cause.TimeoutError;
