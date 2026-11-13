// ⚔️ WoW news, second version (plan 06): what blows up on the WoW subreddits and what Blizzard posts
// for Forever, collected and filtered here, written up by an outside writer (a scheduled Claude
// agent) through two routes: GET /news/queue and POST /news/article.
// Every hour, in the background, on the leader:
//   1. collect: each subreddit's top of the day and hot (Reddit's feeds, one request a minute), and
//      Blizzard's blue tracker, Forever's topics only (the forum's category), into news_stories; each
//      dated section of a running post (a hotfix topic's opening post) that no staff reply carries
//      is a story of its own;
//   2. filter, in code: at most 36 h old (Blizzard's posts 48), not pinned or removed or handled,
//      and hot for its own subreddit: within its top of the day's first `bar` places (the bar is
//      learned from its month, newsfeeds.ts has no scores to give), or climbing in hot; crossposts
//      (the same title) are one story;
//   3. ripen: 40 comments in its thread's feed, or 3 hours old; then what the writer is given (the
//      post, the Blizzard/Wowhead article it links, the comments, best first) is read once and kept
//      on the row (`ready`), so the queue answers at once.
// The writer takes up to three ready stories (best first) and sends back a write-up or a skip; code
// checks it (newscard.ts `check`) and posts the card, silent, pinging nobody, at most
// NEWS_DAILY_POSTS (3) a day, once per story. The first run posts nothing (everything visible is
// marked as there before us). The owner hears after 24 h without one good collect, or 24 h of
// stories waiting while the writer never asked. The backtest builds each past day's queue (up to 8)
// the same way, for the test bot's sample sheet. No channel configured: none of this runs.
import { XMLParser } from "fast-xml-parser";
import { and, asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { Cause, Context, DateTime, Duration, Effect, Layer, Option, Ref, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { newsCache, newsStories, settings, type StoryState } from "./db/schema.js";
import { Db, type DbError } from "./db/db.js";
import { AppConfig } from "./config.js";
import { Discord } from "./discord.js";
import { Alerts } from "./alerts.js";
import { Background } from "./background.js";
import { LocalTime, calendar } from "./localtime.js";
import { nowSec } from "./clock.js";
import { jsonText } from "./json.js";
import { RedditNews, plain, type Listed, type Listing, type Thread } from "./newsfeeds.js";
import { DEFAULT_BAR, MAX_AGE, OFFICIAL_AGE, Writeup, barFrom, card, cardText, check as checkWriteup, clean, datesIn, notHot, officialLink, sameTitle, sectionsIn, titleFor, upTo, type Origin } from "./newscard.js";

export { SILENT } from "./newscard.js";
export const FORUM = "https://eu.forums.blizzard.com/en/wow";
export const FEED = `${FORUM}/groups/blizzard-tracker/posts.rss`;
/** The forum's category of WoW: Forever's posts (retail's are elsewhere, e.g. 235). */
export const FOREVER_CATEGORY = 360;
const UA = "DiscordBot (https://github.com/ViliusVZ/meme-bot, 3.0)";
export const EVERY = 3600; // a run an hour; a failed one is tried again the next hour
export const RIPE_COMMENTS = 40; // …or RIPE_AGE old: then there's a mood to report
export const RIPE_AGE = 2 * 3600; // (a quiet channel: the writer comes every two hours anyway)
export const STALE = 24 * 3600; // no good collect (or no word from the writer) for this long → tell the owner
export const QUEUE_SIZE = 3; // stories the queue hands the writer at once
export const BACKTEST_QUEUE = 8; // …and a backtest day's queue (the writer picks)
const RUNNING_DAYS = 14; // a running topic's opening post is read for new sections this long
const LEVEL_AGE = 24 * 3600; // a subreddit's bar is learned again from its month once a day
const THREADS_PER_RUN = 6; // threads read per run at most: Reddit's minute each
const COMMENTS_SHOWN = 25;
const POSTED_SHOWN = 10;
const DAY_SEC = 86400;
const FEED_TIMEOUT = Duration.seconds(20);
const ARTICLE_TIMEOUT = Duration.seconds(15);
const ARTICLE_MAX = 6000;
const FORUM_TEXT = 4000; // a Blizzard forum post's own text, at most this long
const FORUM_COMMENT = 600; // one reply, at most this long
const RUN = "news_run"; // { ok, tried, since?, alerted? }: the last good run, the last attempt (unix s)
const LEVELS = "news_levels"; // { [sub]: { bar, at } }: how deep each subreddit's top of the day is hot
const TOPICS = "news_topics"; // { [topic]: { forever, running, link, at } }: Blizzard's topics, read once
const WRITER = "news_writer"; // { heard?, waiting?, alerted? }: when the writer last asked or wrote
const SHEET = "backtest:sheet"; // the last backtest: its days' queues
const parser = new XMLParser({ processEntities: true, htmlEntities: true });

export type Post = { topic: number; post: number; title: string; link: string; excerpt: string; published: number };
type Story = typeof newsStories.$inferSelect;

/** The blue tracker's staff posts. Each link is …/t/<slug>/<topic>/<post number>. */
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

/** Blizzard's blue tracker answered something other than the feed. */
export class NewsFeedError extends Schema.TaggedError<NewsFeedError>()("NewsFeedError", { status: Schema.Number }) {
  override get message() {
    return `blue tracker -> ${this.status}`;
  }
}

/** The writer's request can't be done: the status it answers with, and why. */
export class NewsRefused extends Schema.TaggedError<NewsRefused>()("NewsRefused", { status: Schema.Number, reason: Schema.String }) {
  override get message() {
    return this.reason;
  }
}

const RunTimes = Schema.Struct({ ok: Schema.Number, tried: Schema.Number, since: Schema.optional(Schema.Number), alerted: Schema.optional(Schema.Number) });
const Levels = Schema.Record(Schema.String, Schema.Struct({ bar: Schema.Number, at: Schema.Number }));
const Topics = Schema.Record(Schema.String, Schema.Struct({ forever: Schema.Boolean, running: Schema.Boolean, link: Schema.String, at: Schema.Number }));
const WriterTimes = Schema.Struct({ heard: Schema.optional(Schema.Number), waiting: Schema.optional(Schema.Number), alerted: Schema.optional(Schema.Number) });
const ListedSchema = Schema.Struct({ id: Schema.String, title: Schema.String, link: Schema.String, url: Schema.String, body: Schema.String, created: Schema.Number, rank: Schema.Number, removed: Schema.Boolean });
const ThreadSchema = Schema.Struct({ post: Schema.NullOr(ListedSchema), comments: Schema.Array(Schema.String), times: Schema.optional(Schema.Array(Schema.Number)) });
/** One post of a Blizzard forum topic (Discourse's JSON), as plain text; `edited`: when it last changed. */
export type ForumPost = { readonly n: number; readonly at: number; readonly staff: boolean; readonly text: string; readonly edited?: number };
const ForumPostSchema = Schema.Struct({ n: Schema.Number, at: Schema.Number, staff: Schema.Boolean, text: Schema.String, edited: Schema.optional(Schema.Number) });
/** A Blizzard forum topic: its category (null: not given), its title, its posts. */
export type Topic = { readonly category: number | null; readonly title: string; readonly posts: ReadonlyArray<ForumPost> };
const TopicSchema = Schema.Struct({ category: Schema.NullOr(Schema.Number), title: Schema.String, posts: Schema.Array(ForumPostSchema) });
const Discourse = Schema.Struct({
  title: Schema.optional(Schema.String),
  category_id: Schema.optional(Schema.NullOr(Schema.Number)),
  post_stream: Schema.Struct({
    posts: Schema.Array(Schema.Struct({ post_number: Schema.Number, created_at: Schema.String, updated_at: Schema.optional(Schema.String), cooked: Schema.String, staff: Schema.optional(Schema.NullOr(Schema.Boolean)) })),
  }),
});

/** The post number in a forum link (…/t/<slug>/<topic>/<n>); 1 when it has none. */
export const postNumber = (link: string) => Number(link.match(/\/t\/[^/]+\/\d+\/(\d+)/)?.[1] ?? 1);
/** A staff post's link, made the topic's opening post's. */
const openingLink = (link: string) => link.replace(/(\/t\/[^/]+\/\d+)(?:\/\d+)?$/, "$1/1");

/** A staff post's story id: the topic for the post that opened it, the topic and post for a reply. */
export const blizzardId = (p: Pick<Post, "topic" | "post">) => (p.post === 1 ? `blizzard:${p.topic}` : `blizzard:${p.topic}/${p.post}`);
/** A running post's section's story id: the topic and the section's day. */
export const sectionId = (topic: number | string, day: string) => `blizzard:${topic}#${day}`;
/** The day of a section story (null: not one). */
const sectionOf = (id: string) => id.match(/#(\d{4}-\d\d-\d\d)$/)?.[1] ?? null;

/**
 * What a write-up is given from a Blizzard forum topic for its post `n`, at `at`: that post's own
 * text (the opening post as it stood on `day`: a running hotfix post grows by dated sections), and
 * the players' replies after it posted by then, oldest first, as its comments.
 */
export function forumMaterial(posts: ReadonlyArray<ForumPost>, n: number, at: number, day: string): { text: string; comments: string[] } | null {
  const own = posts.find((p) => p.n === n);
  if (!own) return null;
  // a running topic's opening post: the sections a later staff post carries are that post's story, not this one's
  const later = posts.filter((p) => p.n > 1 && p.staff).flatMap((p) => datesIn(p.text).slice(0, 1)).sort()[0];
  return {
    text: (n === 1 ? upTo(own.text, day, later) : own.text).slice(0, FORUM_TEXT),
    comments: posts.filter((p) => p.n > n && !p.staff && p.at <= at && p.text).map((p) => p.text.slice(0, FORUM_COMMENT)).slice(0, 60),
  };
}

/**
 * The dated sections of a running topic's opening post that are stories of their own: dated after
 * the day it opened (`opened`) and by `today`, and carried by no later staff post (that post is the
 * day's story).
 */
export function ownSections(posts: ReadonlyArray<ForumPost>, opened: string, today: string): Array<{ day: string; text: string }> {
  const op = posts.find((p) => p.n === 1);
  if (!op) return [];
  const carried = new Set(posts.filter((p) => p.n > 1 && p.staff).flatMap((p) => datesIn(p.text).slice(0, 1)));
  return sectionsIn(op.text).filter((s) => s.day > opened && s.day <= today && !carried.has(s.day));
}

/** A section story's material: its section of the opening post, and the players' replies from `from` (its day's start) to `at` (by its next day's end at most). */
export function sectionMaterial(posts: ReadonlyArray<ForumPost>, day: string, from: number, at: number): { text: string; comments: string[] } | null {
  const op = posts.find((p) => p.n === 1);
  const section = op ? sectionsIn(op.text).find((s) => s.day === day) : undefined;
  if (!section) return null;
  return {
    text: section.text.slice(0, FORUM_TEXT),
    comments: posts.filter((p) => p.n > 1 && !p.staff && p.at >= from && p.at <= at && p.text).map((p) => p.text.slice(0, FORUM_COMMENT)).slice(0, 60),
  };
}

/** What the writer is given about a story, kept on its row once it ripened. */
export const Prepared = Schema.Struct({
  text: Schema.String,
  article: Schema.NullOr(Schema.Struct({ url: Schema.String, text: Schema.String })),
  official_post: Schema.NullOr(Schema.Struct({ url: Schema.String, title: Schema.String, text: Schema.String })),
  comments: Schema.Array(Schema.String),
  comment_count: Schema.Number,
});
export type Prepared = typeof Prepared.Type;

/** One story in the queue, as the writer gets it. */
export const QueuedStory = Schema.Struct({
  id: Schema.String,
  source: Schema.Literals(["reddit", "blizzard"]),
  subreddit: Schema.String,
  title: Schema.String,
  link: Schema.String,
  points_to: Schema.String,
  posted_hours_ago: Schema.Number,
  ...Prepared.fields,
});
export type QueuedStory = typeof QueuedStory.Type;
/** The queue's answer. */
export type Queue = { readonly audience: string; readonly today: string; readonly posted: ReadonlyArray<string>; readonly left_today: number; readonly stories: ReadonlyArray<QueuedStory> };

/** A backtest day's story: what the queue answers, and what its card is made from. */
const BtStory = Schema.Struct({ ...QueuedStory.fields, sub: Schema.String, created_at: Schema.Number, official: Schema.NullOr(Schema.String) });
type BtStory = typeof BtStory.Type;
const BtDay = Schema.Struct({ day: Schema.String, at: Schema.Number, posts: Schema.Number, over: Schema.Number, stories: Schema.Array(BtStory), missing: Schema.Array(Schema.String) });
type BtDay = typeof BtDay.Type;
const SheetSchema = Schema.Struct({ at: Schema.Number, today: Schema.String, levels: Schema.Record(Schema.String, Schema.Number), days: Schema.Array(BtDay) });
const BtPosted = Schema.Struct({ message_id: Schema.String, headline: Schema.optional(Schema.String), writeup: Schema.optional(Writeup), at: Schema.optional(Schema.Number) });
const BtSkipped = Schema.Struct({ reason: Schema.String, at: Schema.Number });

/** The writer's answer for one story: a write-up, or a skip with its reason; `day`: a backtest day's (the test bot's). */
export const ArticleInput = Schema.Union([
  Schema.Struct({ id: Schema.String, day: Schema.optional(Schema.String), skip: Schema.String }),
  Schema.Struct({ id: Schema.String, day: Schema.optional(Schema.String), ...Writeup.fields }),
]);
export type ArticleInput = typeof ArticleInput.Type;
export type ArticleResult = { readonly posted: true; readonly message_id: string } | { readonly skipped: true };

/** What one run did (absent keys: nothing of that kind). */
export type RunResult = {
  running?: true;
  first?: true;
  seen?: number;
  candidates?: number;
  repeats?: number;
  ready?: string[];
  dropped?: number;
  failed?: string[];
};
export type RunOptions = {
  /** The time to run at (unix s); the clock's by default. */
  readonly at?: number;
};
export type BacktestOptions = {
  /** How many days back (the days before today), 7 by default. */
  readonly days?: number;
};
export type BacktestResult = { readonly sheet: string; readonly done: boolean };

const label = (s: Pick<Story, "source" | "sub">) => (s.source === "blizzard" ? "Blizzard's forums" : `r/${s.sub}`);
const limitOf = (s: Pick<Story, "source">) => (s.source === "blizzard" ? OFFICIAL_AGE : MAX_AGE);
const externalId = (id: string) => id.replace(/^reddit:/, "");
/** Best first: a Blizzard staff post as a top story, a thread by its best place in its top of the day; then the older (it ages out first). */
const rankOf = (s: { source: string; best_rank?: number | null; rank?: number }) => (s.source === "blizzard" ? 1 : (s.rank ?? s.best_rank ?? 99));
const byRank = <S extends { source: string; best_rank?: number | null; rank?: number; created_at: number; id: string }>(a: S, b: S) =>
  rankOf(a) - rankOf(b) || a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
/** A story's card's official link: Blizzard's post about it, or the Blizzard/Wowhead page the thread points at. */
const officialOf = (s: Pick<Story, "source" | "url" | "official">) => s.official ?? (s.source === "reddit" && officialLink(s.url) ? s.url : null);

/**
 * One title's stories (crossposts): the thread kept (the one already handled, else the best), the
 * other threads its repeats, and Blizzard's post of that title its official one when it's the only
 * one (a running topic's staff posts share their title, and each is a story of its own). Null: no
 * thread in it.
 */
function crossposts<S extends { id: string; source: "reddit" | "blizzard"; state?: StoryState; best_rank?: number | null; rank?: number; created_at: number }>(group: ReadonlyArray<S>) {
  const threads = group.filter((s) => s.source === "reddit");
  if (!threads.length || group.length < 2) return null;
  const kept = threads.find((s) => s.state !== undefined && s.state !== "candidate") ?? [...threads].sort(byRank)[0];
  const blizzard = group.filter((s) => s.source === "blizzard");
  const official = blizzard.length === 1 ? blizzard[0] : null;
  return { kept, official, repeats: [...threads.filter((s) => s !== kept), ...(official ? [official] : [])] };
}

export class News extends Context.Service<
  News,
  {
    /**
     * Minute job: every hour (the times are in the database, so a restart doesn't refetch), a run
     * in the background. No channel configured: nothing, quietly.
     */
    readonly check: Effect.Effect<{ checking?: boolean }, DbError>;
    /** One run now (the admin route). No channel: `{}`; one already running: `{ running: true }`. */
    run(options?: RunOptions): Effect.Effect<RunResult, DbError>;
    /** A run is going. */
    readonly running: Effect.Effect<boolean>;
    /** GET /news/queue: the stories waiting for a write-up, best first; `day`: a backtest day's queue (the test bot only). */
    queue(day?: string): Effect.Effect<Queue, NewsRefused | DbError>;
    /** POST /news/article: one story's write-up, posted as its card (once, within the day's cap), or its skip. */
    article(input: ArticleInput): Effect.Effect<ArticleResult, NewsRefused | DbError>;
    /** Each of the last days' queues as they stood that day, for the writer (posting nothing); its sheet (markdown). */
    backtest(options?: BacktestOptions): Effect.Effect<BacktestResult, DbError>;
    /** The admin route's: a backtest in the background, unless one is going. */
    startBacktest(options?: BacktestOptions): Effect.Effect<{ backtest: "started" | "running" }>;
    /** The last backtest's sheet: each day's queue and what the writer made of it (null: none yet). */
    readonly sheet: Effect.Effect<string | null, DbError>;
  }
>()("meme-bot/news") {
  static readonly layer = Layer.effect(
    News,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const db = yield* Db;
      const http = yield* HttpClient.HttpClient;
      const discord = yield* Discord;
      const reddit = yield* RedditNews;
      const alerts = yield* Alerts;
      const background = yield* Background;
      const time = yield* LocalTime;
      const channel = config.newsChannelId;
      const subs = config.newsSubreddits;
      const running = yield* Ref.make(false);
      const testing = yield* Ref.make(false); // a backtest is going

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
        return parseFeed(yield* res.text);
      });

      /** A Blizzard or Wowhead page as plain text (its main part), or null when it won't come. */
      const article = Effect.fn("News.article")(function* (url: string) {
        if (!officialLink(url)) return null;
        return yield* Effect.gen(function* () {
          const res = yield* get(url, ARTICLE_TIMEOUT);
          if (res.status !== 200) return null;
          const html = yield* res.text;
          const main = html.match(/<(article|main)\b[\s\S]*?<\/\1>/i)?.[0] ?? html.match(/<body\b[\s\S]*<\/body>/i)?.[0] ?? html;
          return plain(main).slice(0, ARTICLE_MAX) || null;
        }).pipe(Effect.catch((e) => Effect.as(Effect.logInfo(`news: no article from ${url} ${"message" in e ? e.message : String(e)}`), null)));
      });

      /**
       * A Blizzard forum topic around post `n` of its link (…/t/<slug>/<topic>/<n>), from the forum's
       * JSON: its category, its title, and its posts (who's staff, when each was posted, its text).
       * Null when it won't come.
       */
      const forumTopic = Effect.fn("News.forumTopic")(function* (link: string) {
        const m = link.match(/^(https:\/\/[^/?#]*forums\.blizzard\.com\/[^?#]*?\/t\/[^/?#]+\/\d+)(?:\/(\d+))?/i);
        if (!m) return null;
        return yield* Effect.gen(function* () {
          const res = yield* get(`${m[1]}${m[2] ? `/${m[2]}` : ""}.json`, ARTICLE_TIMEOUT);
          if (res.status !== 200) return null;
          const body = Option.getOrUndefined(Schema.decodeUnknownOption(Discourse)(yield* res.json));
          if (!body) return null;
          const unix = (s: string) => Math.floor(Date.parse(s) / 1000);
          const topic: Topic = {
            category: body.category_id ?? null,
            title: body.title ?? "",
            posts: body.post_stream.posts.map((p): ForumPost => ({ n: p.post_number, at: unix(p.created_at), staff: p.staff === true, text: plain(p.cooked), ...(p.updated_at ? { edited: unix(p.updated_at) } : {}) })),
          };
          return topic;
        }).pipe(Effect.catch((e) => Effect.as(Effect.logInfo(`news: no forum topic from ${link} ${"message" in e ? e.message : String(e)}`), null)));
      });

      /** A feed's answer, or the reason it didn't come (logged; the run goes on without it). */
      const attempt = <A, E extends { readonly message: string }>(what: string, effect: Effect.Effect<A, E>) =>
        effect.pipe(
          Effect.map((a) => ({ ok: a }) as { ok: A } | { failed: string }),
          Effect.catch((e) => Effect.as(Effect.logInfo(`news: ${what} failed: ${e.message}`), { failed: `${what}: ${e.message}` })),
        );

      const dayStart = (t: number) => {
        const l = time.at(t);
        return time.wallToUnix(l.y, l.m, l.d, 0, 0);
      };
      /** A Vilnius day's first and last second. */
      const dayBounds = (day: string) => {
        const [y, m, d] = day.split("-").map(Number);
        const next = calendar(y, m, d, 1);
        return { start: time.wallToUnix(y, m, d, 0, 0), end: time.wallToUnix(next.y, next.m, next.d, 0, 0) - 1 };
      };
      const todayLine = (t: number) => {
        const l = time.at(t);
        return `${time.weekday(l.day)}, ${l.day}, ${l.hm} Vilnius`;
      };

      /**
       * The section stories of a running topic: each dated section of its opening post that no staff
       * reply carries, made when it appeared (the post's last edit, when that was on the section's
       * day; else the day's end), by `at`.
       */
      const sectionsOf = (topic: number | string, tp: Topic, link: string, at: number) => {
        const op = tp.posts.find((p) => p.n === 1);
        if (!op) return [];
        return ownSections(tp.posts, time.at(op.at).day, time.at(at).day).map((s) => {
          const { end } = dayBounds(s.day);
          const made = op.edited !== undefined && time.at(op.edited).day === s.day ? op.edited : end;
          return { id: sectionId(topic, s.day), title: titleFor(tp.title, s.day), link, body: s.text.slice(0, 600), created_at: Math.min(made, at) };
        });
      };
      /** Forever's topic, by the forum's category; while its JSON won't come, by a mention of Forever. */
      const foreverOf = (tp: Topic | null, p: Pick<Post, "title" | "excerpt">) => (tp && tp.category !== null ? tp.category === FOREVER_CATEGORY : /\bforever\b/i.test(`${p.title} ${p.excerpt}`));

      // ---------------------------------------------------------------- 1. collect

      /** How deep each subreddit's top of the day is hot: learned from its month, once a day. */
      const levelsFor = Effect.fn("News.levels")(function* (t: number, failures: string[]) {
        const levels = { ...((yield* read(LEVELS, Levels)) ?? {}) };
        let changed = false;
        for (const sub of subs) {
          if (levels[sub] && t - levels[sub].at < LEVEL_AGE) continue;
          const month = yield* attempt(`r/${sub} month`, reddit.listing(sub, "month"));
          if ("failed" in month) {
            failures.push(month.failed);
            continue;
          }
          levels[sub] = { bar: barFrom(month.ok, t), at: t };
          changed = true;
        }
        if (changed) yield* save(LEVELS, levels);
        return levels;
      });

      type Blue = { id: string; title: string; link: string; body: string; created_at: number };
      /**
       * Blizzard's stories this hour: each staff post of a Forever topic (each topic's category read
       * once, from the forum's JSON), and each new section of a running Forever topic's opening post
       * (its JSON read again each hour for two weeks).
       */
      const blizzardStories = Effect.fn("News.blizzard")(function* (posts: ReadonlyArray<Post>, t: number) {
        const topics = { ...((yield* read(TOPICS, Topics)) ?? {}) };
        const fetched = new Map<string, Topic | null>();
        const forever = new Map<number, boolean>();
        for (const p of posts) {
          if (forever.has(p.topic)) continue;
          const known = topics[p.topic];
          if (known) {
            forever.set(p.topic, known.forever);
            continue;
          }
          const link = openingLink(p.link);
          const tp = yield* forumTopic(link);
          fetched.set(String(p.topic), tp);
          forever.set(p.topic, foreverOf(tp, p));
          const op = tp?.posts.find((x) => x.n === 1);
          if (tp && tp.category !== null) topics[p.topic] = { forever: tp.category === FOREVER_CATEGORY, running: !!op && datesIn(op.text).length > 0, link, at: t };
        }
        const out: Blue[] = posts.filter((p) => p.excerpt && forever.get(p.topic)).map((p) => ({ id: blizzardId(p), title: p.title, link: p.link, body: p.excerpt, created_at: p.published }));
        for (const [topic, info] of Object.entries(topics)) {
          if (t - info.at > RUNNING_DAYS * DAY_SEC) {
            delete topics[topic];
            continue;
          }
          if (!info.forever || !info.running) continue;
          const tp = fetched.has(topic) ? fetched.get(topic)! : yield* forumTopic(info.link);
          if (tp) out.push(...sectionsOf(topic, tp, info.link, t));
        }
        yield* save(TOPICS, topics);
        return out;
      });

      /** Everything the feeds show, into news_stories (ranks moved along; new ones `old` on the first run). */
      const collect = Effect.fn("News.collect")(function* (t: number, first: boolean, failures: string[]) {
        type Row = typeof newsStories.$inferInsert;
        const rows = new Map<string, Row>();
        const official = yield* attempt("blue tracker", fetchFeed);
        const listed: Array<{ sub: string; day: Listed[] | null; hot: Listed[] | null }> = [];
        for (const sub of subs) {
          const got: Partial<Record<Listing, Listed[] | null>> = {};
          for (const kind of ["day", "hot"] as const) {
            const r = yield* attempt(`r/${sub} ${kind === "day" ? "top of the day" : "hot"}`, reddit.listing(sub, kind));
            if ("failed" in r) failures.push(r.failed);
            got[kind] = "ok" in r ? r.ok : null;
          }
          listed.push({ sub, day: got.day ?? null, hot: got.hot ?? null });
        }
        if ("failed" in official) failures.push(official.failed);
        const blue = "ok" in official ? yield* blizzardStories(official.ok, t) : [];
        const ids = [...listed.flatMap((l) => [...(l.day ?? []), ...(l.hot ?? [])].map((p) => `reddit:${p.id}`)), ...blue.map((b) => b.id)];
        if (!ids.length) return { seen: 0, removed: new Set<string>() };
        const known = new Map((yield* db.select().from(newsStories).where(inArray(newsStories.id, [...new Set(ids)]))).map((s) => [s.id, s]));
        const removed = new Set<string>();
        for (const { sub, day, hot } of listed) {
          const top = new Map((day ?? []).map((p) => [p.id, p.rank]));
          const hotRank = new Map((hot ?? []).map((p) => [p.id, p.rank]));
          for (const p of [...(day ?? []), ...(hot ?? [])]) {
            const id = `reddit:${p.id}`;
            if (rows.has(id)) continue;
            const was = known.get(id);
            if (p.removed) removed.add(id);
            const rank = day ? (top.get(p.id) ?? null) : (was?.top_rank ?? null);
            rows.set(id, {
              id, source: "reddit", sub, title: p.title, link: p.link, url: p.url, body: p.body, created_at: p.created,
              first_seen: was?.first_seen ?? t, last_seen: t,
              top_rank: rank,
              best_rank: rank === null ? (was?.best_rank ?? null) : Math.min(rank, was?.best_rank ?? rank),
              hot_rank: hot ? (hotRank.get(p.id) ?? null) : (was?.hot_rank ?? null),
              prev_hot_rank: was ? was.hot_rank : null,
              prev_at: was ? was.last_seen : null,
              state: was?.state ?? (first ? "old" : "watch"),
            });
          }
        }
        // every staff post with something in it is a story of its own (the post that opened a topic,
        // and each later one), and so is each day a running post grew by without a staff post of its own
        for (const b of blue) {
          if (rows.has(b.id)) continue;
          const was = known.get(b.id);
          rows.set(b.id, {
            id: b.id, source: "blizzard", sub: "blizzard", title: b.title, link: b.link, url: "", body: b.body, created_at: was?.created_at ?? b.created_at,
            first_seen: was?.first_seen ?? t, last_seen: t, top_rank: null, best_rank: null, hot_rank: null, prev_hot_rank: null, prev_at: was ? was.last_seen : null,
            state: was?.state ?? (first ? "old" : "watch"),
            reason: was ? was.reason : null,
          });
        }
        const values = [...rows.values()];
        const excluded = (c: string) => sql.raw(`excluded."${c}"`);
        yield* db
          .insert(newsStories)
          .values(values)
          .onConflictDoUpdate({
            target: newsStories.id,
            set: Object.fromEntries(["title", "link", "url", "body", "last_seen", "top_rank", "best_rank", "hot_rank", "prev_hot_rank", "prev_at"].map((c) => [c, excluded(c)])),
          });
        return { seen: values.filter((v) => !known.has(v.id)).length, removed };
      });

      // ---------------------------------------------------------------- 2. filter, 3. ripen

      const setState = (ids: ReadonlyArray<string>, state: StoryState, reason: string | null = null) =>
        ids.length ? db.update(newsStories).set({ state, reason }).where(inArray(newsStories.id, [...ids])) : Effect.void;

      const filter = Effect.fn("News.filter")(function* (t: number, levels: Record<string, { bar: number }>, removed: ReadonlySet<string>) {
        const watched = yield* db.select().from(newsStories).where(and(eq(newsStories.state, "watch"), eq(newsStories.last_seen, t)));
        const hot = watched.filter((s) => notHot(s, levels[s.sub]?.bar ?? DEFAULT_BAR, t, removed.has(s.id)) === null).map((s) => s.id);
        yield* setState(hot, "candidate");
        return hot.length;
      });

      /**
       * Crossposts are one story: threads with the same title as another candidate, or as a thread
       * waiting for or given a card this week, are its repeats; Blizzard's post of that title too, and
       * it becomes the thread's official link (a running topic's staff posts share one title, so
       * several Blizzard posts of a title stay stories of their own).
       */
      const merge = Effect.fn("News.merge")(function* (t: number) {
        const open = yield* db
          .select()
          .from(newsStories)
          .where(and(inArray(newsStories.state, ["candidate", "ready", "posted"]), gte(newsStories.created_at, t - 7 * DAY_SEC)));
        const groups = new Map<string, Story[]>();
        for (const s of open) groups.set(sameTitle(s.title), [...(groups.get(sameTitle(s.title)) ?? []), s]);
        let repeats = 0;
        for (const group of groups.values()) {
          const c = crossposts(group);
          if (!c) continue;
          for (const s of c.repeats) {
            if (s.state !== "candidate") continue;
            yield* db.update(newsStories).set({ state: "skip", reason: "a repeat", same_as: c.kept.id }).where(and(eq(newsStories.id, s.id), eq(newsStories.state, "candidate")));
            repeats++;
          }
          if (c.official && !c.kept.official && c.kept.state !== "posted") yield* db.update(newsStories).set({ official: c.official.link }).where(eq(newsStories.id, c.kept.id));
        }
        return repeats;
      });

      /** What the writer is given about a story at `at` (its thread's comments come from the caller). */
      const materialFor = Effect.fn("News.material")(function* (s: Pick<Story, "id" | "source" | "link" | "url" | "body">, at: number, comments: ReadonlyArray<string>, official: { url: string; title: string; text: string } | null, readArticle: (url: string) => Effect.Effect<string | null, DbError>, forum: Topic | null) {
        // a Blizzard post: its own post from the topic, as it stood then (a section story: its section), its replies by then as the comments
        let own: { text: string; comments: string[] } | null = null;
        if (s.source === "blizzard" && forum) {
          const section = sectionOf(s.id);
          const opened = forum.posts.find((p) => p.n === 1);
          const day = time.at(at).day;
          own = section
            ? sectionMaterial(forum.posts, section, dayBounds(section).start, Math.min(at, dayBounds(section).start + 2 * DAY_SEC))
            : forumMaterial(forum.posts, postNumber(s.link), at, postNumber(s.link) === 1 && opened ? [day, time.at(opened.at).day].sort()[0] : day);
        }
        if (own) comments = own.comments;
        const target = s.source === "blizzard" ? (own ? "" : s.link) : s.url;
        const text = officialLink(target) ? yield* readArticle(target) : null;
        const prepared: Prepared = {
          text: own ? own.text : s.body,
          article: text ? { url: target, text } : null,
          official_post: s.source === "blizzard" ? null : official, // a Blizzard story's own post is its text already
          comments: comments.slice(0, COMMENTS_SHOWN),
          comment_count: comments.length,
        };
        return prepared;
      });

      const blizzardPost = Effect.fn("News.blizzardPost")(function* (link: string | null) {
        if (!link) return null;
        const [b] = yield* db.select().from(newsStories).where(and(eq(newsStories.source, "blizzard"), eq(newsStories.link, link)));
        return b ? { url: b.link, title: b.title, text: b.body } : null;
      });

      /** One story: ripe yet? then what the writer is given. A string: why not this run ("waiting", "removed", "ripening"). */
      const prepare = Effect.fn("News.prepare")(function* (s: Story, t: number) {
        let comments: ReadonlyArray<string> = [];
        if (s.source === "reddit") {
          const thread = yield* attempt(`the thread ${s.id}`, reddit.thread(s.sub, externalId(s.id)));
          if ("failed" in thread) return "waiting";
          if (thread.ok.post?.removed) {
            yield* setState([s.id], "skip", "removed");
            return "removed";
          }
          comments = thread.ok.comments;
          if (comments.length < RIPE_COMMENTS && t - s.created_at < RIPE_AGE) {
            yield* db.update(newsStories).set({ comments: comments.length }).where(eq(newsStories.id, s.id));
            return "ripening";
          }
        }
        const forum = s.source === "blizzard" ? yield* forumTopic(s.link) : null;
        const prepared = yield* materialFor(s, t, comments, yield* blizzardPost(s.official), article, forum);
        // Blizzard's own posts (hotfixes, announcements) go to the writer at once
        if (s.source === "reddit" && prepared.comment_count < RIPE_COMMENTS && t - s.created_at < RIPE_AGE) return "ripening";
        return prepared;
      });

      /** The candidates that ripened, read for the writer (a few threads a run: Reddit's minute each), best first. */
      const ripen = Effect.fn("News.ripen")(function* (t: number) {
        const waiting = (yield* db.select().from(newsStories).where(eq(newsStories.state, "candidate"))).sort(byRank);
        const aged = waiting.filter((s) => t - s.created_at > limitOf(s));
        yield* setState(aged.map((s) => s.id), "dropped", "too old");
        let threads = THREADS_PER_RUN;
        const ready: string[] = [];
        for (const s of waiting) {
          if (aged.includes(s) || (s.source === "reddit" && threads <= 0)) continue;
          const p = yield* prepare(s, t);
          if (s.source === "reddit") threads--;
          if (typeof p === "string") continue;
          yield* db.update(newsStories).set({ state: "ready", material: p, comments: p.comment_count }).where(and(eq(newsStories.id, s.id), eq(newsStories.state, "candidate")));
          ready.push(s.title);
        }
        // a story the writer never got to ages out, never posted late
        const stale = (yield* db.select().from(newsStories).where(eq(newsStories.state, "ready"))).filter((s) => t - s.created_at > limitOf(s));
        yield* setState(stale.map((s) => s.id), "dropped", "too old");
        return { ready, dropped: aged.length + stale.length };
      });

      // ---------------------------------------------------------------- the run

      /** The owner hears once per outage: after a day without a good collect, or a day of stories waiting while the writer never asked. */
      const watch = Effect.fn("News.watch")(function* (t: number, failures: ReadonlyArray<string>) {
        const s = (yield* read(RUN, RunTimes)) ?? { ok: 0, tried: t };
        if (!failures.length) yield* save(RUN, { ok: t, tried: s.tried });
        else {
          const since = s.ok || (s.since ?? t);
          if (t - since >= STALE && !(s.alerted !== undefined && t - s.alerted < STALE)) {
            yield* alerts.failed("collecting WoW news", `${failures.join("\n")}\nno good collect since ${s.ok ? `<t:${s.ok}:R>` : "ever"}`);
            yield* save(RUN, { ...s, alerted: t });
          }
        }
        const [{ n }] = yield* db.select({ n: sql<number>`count(*)::int` }).from(newsStories).where(eq(newsStories.state, "ready"));
        if (!n) return;
        const w = (yield* read(WRITER, WriterTimes)) ?? {};
        const since = w.heard ?? w.waiting;
        if (since === undefined) yield* save(WRITER, { ...w, waiting: t });
        else if (t - since >= STALE && (w.alerted === undefined || w.alerted < since)) {
          yield* alerts.failed("writing up WoW news", `stories are waiting, and the writer hasn't asked for them since <t:${since}:R> (GET /news/queue)`);
          yield* save(WRITER, { ...w, alerted: t });
        }
      });

      const once = Effect.fn("News.once")(function* (t: number) {
        const before = yield* read(RUN, RunTimes);
        const first = !before?.ok;
        const failures: string[] = [];
        const out: RunResult = {};
        const levels = yield* levelsFor(t, failures);
        const { seen, removed } = yield* collect(t, first, failures);
        if (seen) out.seen = seen;
        if (first) {
          out.first = true; // everything already visible is marked as there before us: nothing is posted
        } else {
          const candidates = yield* filter(t, levels, removed);
          if (candidates) out.candidates = candidates;
          const repeats = yield* merge(t);
          if (repeats) out.repeats = repeats;
          const r = yield* ripen(t);
          if (r.ready.length) out.ready = r.ready;
          if (r.dropped) out.dropped = r.dropped;
        }
        // what's done with stays two weeks (repeats are looked up a week back)
        yield* db.delete(newsStories).where(and(lt(newsStories.last_seen, t - 14 * DAY_SEC), inArray(newsStories.state, ["old", "watch", "skip", "dropped"])));
        if (failures.length) out.failed = failures;
        yield* watch(t, failures);
        return out;
      });

      /** The attempt's time first (so a restart, or the next minute, doesn't run it again), then the run. */
      const begin = Effect.fn("News.begin")(function* (t: number) {
        const s = (yield* read(RUN, RunTimes)) ?? { ok: 0, tried: 0 };
        yield* save(RUN, { ...s, tried: t, ...(s.ok ? {} : { since: s.since ?? t }) });
      });

      const run = Effect.fn("News.run")(function* (options: RunOptions = {}) {
        if (!channel) return {};
        if (yield* Ref.getAndSet(running, true)) return { running: true } as RunResult;
        return yield* Effect.gen(function* () {
          const t = options.at ?? (yield* nowSec);
          yield* begin(t);
          return yield* once(t);
        }).pipe(Effect.ensuring(Ref.set(running, false)));
      });

      const check = Effect.gen(function* () {
        if (!channel || (yield* Ref.get(running))) return {};
        const t = yield* nowSec;
        const s = (yield* read(RUN, RunTimes)) ?? { ok: 0, tried: 0 };
        if (t - s.tried < EVERY) return {};
        yield* Ref.set(running, true);
        // Reddit's minute between requests makes a run take ten minutes: never on the minute job's own time
        const go = once(t).pipe(
          Effect.flatMap((r) => (Object.keys(r).length ? Effect.logInfo(`wow news ${jsonText(r)}`) : Effect.void)),
          Effect.catchCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logInfo(`wow news run failed, trying again in an hour: ${String(Cause.squash(cause))}`))),
          Effect.ensuring(Ref.set(running, false)),
        );
        // (anything failing before the run is under way puts the flag down again, or the news would stop)
        yield* Effect.andThen(begin(t), background.run(go, "the WoW news run")).pipe(Effect.onError(() => Ref.set(running, false)));
        return { checking: true };
      }).pipe(Effect.withSpan("News.check"));

      // ---------------------------------------------------------------- the writer's routes

      /** The writer asked or wrote: it's alive (the owner's alert waits on this). */
      const heard = (t: number) => save(WRITER, { heard: t });

      const toQueued = (s: Pick<Story, "id" | "source" | "sub" | "title" | "link" | "url" | "created_at">, p: Prepared, t: number): QueuedStory => ({
        id: s.id,
        source: s.source,
        subreddit: label(s),
        title: s.title,
        link: s.link,
        points_to: s.url,
        posted_hours_ago: Math.max(0, Math.round((t - s.created_at) / 360) / 10),
        ...p,
      });
      const decoded = <A>(schema: Schema.Decoder<A>, value: unknown) => Option.getOrUndefined(Schema.decodeUnknownOption(schema)(value));
      const postedSince = (since: number) => db.select().from(newsStories).where(and(eq(newsStories.state, "posted"), gte(newsStories.posted_at, since)));
      const refuse = (status: number, reason: string) => Effect.fail(new NewsRefused({ status, reason }));
      /** Discord said no: the claim is given back already; the writer may send it again. */
      const discordRefused = {
        DiscordNotFound: (e: { message: string }) => refuse(502, `Discord refused the post: ${e.message}; send it again later`),
        DiscordRejected: (e: { message: string }) => refuse(502, `Discord refused the post: ${e.message}; send it again later`),
        DiscordUnavailable: (e: { message: string }) => refuse(502, `Discord refused the post: ${e.message}; send it again later`),
        DiscordUnexpected: (e: { message: string }) => refuse(502, `Discord refused the post: ${e.message}; send it again later`),
      };

      const liveQueue = Effect.fn("News.queue")(function* () {
        const t = yield* nowSec;
        yield* heard(t);
        const left = Math.max(0, config.newsDailyPosts - (yield* postedSince(dayStart(t))).length);
        const ready = left ? (yield* db.select().from(newsStories).where(eq(newsStories.state, "ready"))).filter((s) => t - s.created_at <= limitOf(s)).sort(byRank) : [];
        const stories = ready.flatMap((s) => {
          const p = decoded(Prepared, s.material);
          return p ? [toQueued(s, p, t)] : [];
        });
        const posted = yield* db.select().from(newsStories).where(eq(newsStories.state, "posted")).orderBy(desc(newsStories.posted_at), asc(newsStories.id)).limit(POSTED_SHOWN);
        return {
          audience: config.newsAudience,
          today: todayLine(t),
          posted: posted.map((s) => decoded(Writeup, s.writeup)?.headline ?? s.title),
          left_today: left,
          stories: stories.slice(0, QUEUE_SIZE),
        } satisfies Queue;
      });

      const liveArticle = Effect.fn("News.write")(function* (input: ArticleInput) {
        const t = yield* nowSec;
        yield* heard(t);
        const [s] = yield* db.select().from(newsStories).where(eq(newsStories.id, input.id));
        if (!s) return yield* refuse(404, `no story ${input.id}`);
        if (s.state !== "ready") return yield* refuse(s.state === "candidate" || s.state === "watch" || s.state === "old" ? 404 : 409, `${input.id} isn't waiting for a write-up (${s.state}${s.reason ? `: ${s.reason}` : ""})`);
        if ("skip" in input) {
          const [done] = yield* db
            .update(newsStories)
            .set({ state: "skip", reason: `the writer: ${clean(input.skip, 200) || "skipped"}` })
            .where(and(eq(newsStories.id, s.id), eq(newsStories.state, "ready")))
            .returning();
          if (!done) return yield* refuse(409, `${input.id} was just written or skipped`);
          return { skipped: true } as const;
        }
        const checked = checkWriteup(input, decoded(Prepared, s.material)?.comment_count ?? 0);
        if ("bad" in checked) return yield* refuse(400, checked.bad);
        if (!channel) return yield* refuse(404, "no news channel configured");
        if ((yield* postedSince(dayStart(t))).length >= config.newsDailyPosts) return yield* refuse(409, `today's ${config.newsDailyPosts} cards are out; it stays queued until it ages out`);
        const origin: Origin = { source: s.source, sub: s.sub, link: s.link, created_at: s.created_at, official: officialOf(s) };
        // claim → post → its id is never cut short (architecture §15); a refused post gives the claim back
        const id = yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const [claim] = yield* db
              .update(newsStories)
              .set({ state: "posted", message_id: "posting", posted_at: t, writeup: checked.ok })
              .where(and(eq(newsStories.id, s.id), eq(newsStories.state, "ready")))
              .returning();
            if (!claim) return null;
            const msg = yield* discord
              .createMessage(channel, card(origin, checked.ok))
              .pipe(Effect.tapError(() => db.update(newsStories).set({ state: "ready", message_id: null, posted_at: null, writeup: null }).where(eq(newsStories.id, s.id))));
            yield* db.update(newsStories).set({ message_id: msg.id }).where(eq(newsStories.id, s.id));
            return msg.id;
          }),
        ).pipe(Effect.catchTags(discordRefused));
        if (id === null) return yield* refuse(409, `${input.id} was just written or skipped`);
        return { posted: true, message_id: id } as const;
      });

      // ---------------------------------------------------------------- the backtest

      const cacheGet = <A>(key: string, schema: Schema.Decoder<A>) =>
        Effect.map(db.select().from(newsCache).where(eq(newsCache.key, key)), ([row]) => (row ? decoded(schema, row.value) : undefined));
      const cachePut = (key: string, value: unknown) =>
        Effect.gen(function* () {
          const at = yield* nowSec;
          yield* db.insert(newsCache).values({ key, value, at }).onConflictDoUpdate({ target: newsCache.key, set: { value, at } });
        });
      /** A cached value, or `make`'s (stored when it's there): what a rerun of the backtest doesn't fetch twice. */
      const cached = <A, E>(key: string, schema: Schema.Decoder<A>, make: Effect.Effect<A | null, E>) =>
        Effect.gen(function* () {
          const hit = yield* cacheGet(key, schema);
          if (hit !== undefined) return hit;
          const made = yield* make;
          if (made !== null) yield* cachePut(key, made);
          return made;
        });
      const feedOrNull = <A, E extends { readonly message: string }>(what: string, effect: Effect.Effect<A, E>) =>
        Effect.map(attempt(what, effect), (r) => ("ok" in r ? r.ok : null));
      const forumCached = (link: string) => cached(`bt:forum:v3:${link}`, TopicSchema, forumTopic(link));

      /** The writer's marks on a backtest's days: the cards posted (`bt:posted:<day>:<id>`) and the skips. */
      const backtestMarks = Effect.gen(function* () {
        const rows = yield* db.select().from(newsCache).where(sql`${newsCache.key} LIKE 'bt:posted:%' OR ${newsCache.key} LIKE 'bt:skipped:%'`);
        return rows.flatMap((r) => {
          const m = r.key.match(/^bt:(posted|skipped):(\d{4}-\d\d-\d\d):(.+)$/);
          if (!m) return [];
          const posted = m[1] === "posted" ? decoded(BtPosted, r.value) : undefined;
          const skipped = m[1] === "skipped" ? decoded(BtSkipped, r.value) : undefined;
          return [{ day: m[2], id: m[3], at: r.at, posted, skipped }];
        });
      });

      const backtestDay = Effect.fn("News.backtestDay")(function* (day: string) {
        if (!config.newsBacktestPost) return yield* refuse(404, "no backtest here (NEWS_BACKTEST_POST is the test bot's)");
        const s = yield* cacheGet(SHEET, SheetSchema);
        const d = s?.days.find((x) => x.day === day);
        if (!d) return yield* refuse(404, `no backtest queue for ${day}: POST /admin/news {"backtest": {"days": 7}} first`);
        return d;
      });

      const backtestQueue = Effect.fn("News.backtestQueue")(function* (day: string) {
        const d = yield* backtestDay(day);
        const marks = yield* backtestMarks;
        const mine = marks.filter((m) => m.day === day);
        const left = Math.max(0, config.newsDailyPosts - mine.filter((m) => m.posted).length);
        const posted = marks
          .filter((m) => m.day < day && m.posted?.headline)
          .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.at - b.at || Number(a.posted!.message_id) - Number(b.posted!.message_id)))
          .map((m) => m.posted!.headline!)
          .slice(-POSTED_SHOWN)
          .reverse();
        const stories = left ? d.stories.filter((x) => !mine.some((m) => m.id === x.id)).slice(0, BACKTEST_QUEUE) : [];
        return {
          audience: config.newsAudience,
          today: todayLine(d.at),
          posted,
          left_today: left,
          stories: stories.map(({ sub: _sub, created_at: _created, official: _official, ...q }) => q),
        } satisfies Queue;
      });

      /** A backtest day's write-up: its card in the news channel marked as a backtest, at most three a day, once per story; never the live tables. */
      const backtestArticle = Effect.fn("News.backtestArticle")(function* (day: string, input: ArticleInput) {
        const d = yield* backtestDay(day);
        const story = d.stories.find((x) => x.id === input.id);
        if (!story) return yield* refuse(404, `no story ${input.id} in ${day}'s queue`);
        const marks = (yield* backtestMarks).filter((m) => m.day === day);
        if (marks.some((m) => m.id === input.id)) return yield* refuse(409, `${input.id} was already written or skipped for ${day}`);
        if ("skip" in input) {
          const t = yield* nowSec;
          const [done] = yield* db.insert(newsCache).values({ key: `bt:skipped:${day}:${input.id}`, value: { reason: clean(input.skip, 200) || "skipped", at: t }, at: t }).onConflictDoNothing().returning();
          if (!done) return yield* refuse(409, `${input.id} was already written or skipped for ${day}`);
          return { skipped: true } as const;
        }
        const checked = checkWriteup(input, story.comment_count);
        if ("bad" in checked) return yield* refuse(400, checked.bad);
        if (!channel) return yield* refuse(404, "no news channel configured");
        if (marks.filter((m) => m.posted).length >= config.newsDailyPosts) return yield* refuse(409, `${day}'s ${config.newsDailyPosts} cards are out`);
        const key = `bt:posted:${day}:${input.id}`;
        const origin: Origin = { source: story.source, sub: story.sub, link: story.link, created_at: story.created_at, official: story.official };
        // claim → post → its id, never cut short; a refused post gives the claim back
        const id = yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const at = yield* nowSec;
            const [claim] = yield* db.insert(newsCache).values({ key, value: { message_id: "posting", headline: checked.ok.headline, writeup: checked.ok }, at }).onConflictDoNothing().returning();
            if (!claim) return null;
            const msg = yield* discord
              .createMessage(channel, card(origin, checked.ok, `backtest · ${time.weekday(day)} ${day}`))
              .pipe(Effect.tapError(() => db.delete(newsCache).where(eq(newsCache.key, key))));
            yield* db.update(newsCache).set({ value: { message_id: msg.id, headline: checked.ok.headline, writeup: checked.ok } }).where(eq(newsCache.key, key));
            return msg.id;
          }),
        ).pipe(Effect.catchTags(discordRefused));
        if (id === null) return yield* refuse(409, `${input.id} was already written or skipped for ${day}`);
        return { posted: true, message_id: id } as const;
      });

      const backtest = Effect.fn("News.backtest")(function* (options: BacktestOptions = {}) {
        const t = yield* nowSec;
        const days = Math.max(1, Math.min(7, Math.round(options.days ?? 7)));
        const today = time.at(t);
        const levels: Record<string, number> = {};
        const week: Array<Listed & { sub: string }> = [];
        for (const sub of subs) {
          const month = yield* cached(`bt:month:${sub}:${today.day}`, Schema.Array(ListedSchema), feedOrNull(`r/${sub} month`, reddit.listing(sub, "month")));
          levels[sub] = month ? barFrom(month, t) : DEFAULT_BAR;
          const w = yield* cached(`bt:week:${sub}:${today.day}`, Schema.Array(ListedSchema), feedOrNull(`r/${sub} week`, reddit.listing(sub, "week")));
          for (const p of w ?? []) week.push({ ...p, sub });
        }
        const blue = (yield* cached(`bt:blue:${today.day}`, Schema.Array(Schema.Struct({ topic: Schema.Number, post: Schema.Number, title: Schema.String, link: Schema.String, excerpt: Schema.String, published: Schema.Number })), feedOrNull("blue tracker", fetchFeed))) ?? [];
        // Forever's topics only (the forum's category), each read once: its running post's sections too
        const topics = new Map<number, { link: string; tp: Topic | null; forever: boolean }>();
        for (const p of blue) {
          if (topics.has(p.topic)) continue;
          const link = openingLink(p.link);
          const tp = yield* forumCached(link);
          topics.set(p.topic, { link, tp, forever: foreverOf(tp, p) });
        }
        const out: BtDay[] = [];
        let done = true;
        for (let i = days; i >= 1; i--) {
          const d = calendar(today.y, today.m, today.d, -i);
          const { start, end } = dayBounds(d.iso);
          const at = Math.min(t, end);
          // the day's posts (Vilnius's day), ranked within their subreddit's day as the week's top has them
          type Row = { id: string; source: "reddit" | "blizzard"; sub: string; title: string; link: string; url: string; body: string; created_at: number; rank: number; removed: boolean };
          const rows: Row[] = [];
          for (const sub of subs)
            week
              .filter((p) => p.sub === sub && p.created >= start && p.created <= at)
              .forEach((p, j) => rows.push({ id: `reddit:${p.id}`, source: "reddit", sub, title: p.title, link: p.link, url: p.url, body: p.body, created_at: p.created, rank: j + 1, removed: p.removed }));
          for (const p of blue)
            if (p.excerpt && p.published >= start && p.published <= at && topics.get(p.topic)?.forever)
              rows.push({ id: blizzardId(p), source: "blizzard", sub: "blizzard", title: p.title, link: p.link, url: "", body: p.excerpt, created_at: p.published, rank: 0, removed: false });
          for (const [topic, x] of topics)
            if (x.forever && x.tp)
              for (const s of sectionsOf(topic, x.tp, x.link, at))
                if (s.created_at >= start && !rows.some((r) => r.id === s.id)) rows.push({ ...s, source: "blizzard", sub: "blizzard", url: "", rank: 0, removed: false });
          const over = rows.filter((r) => notHot({ ...r, top_rank: r.source === "reddit" ? r.rank : null, hot_rank: null, prev_hot_rank: null }, levels[r.sub] ?? DEFAULT_BAR, at, r.removed) === null);
          // crossposts are one story: a thread before Blizzard's own post, which becomes its official link
          const groups = new Map<string, Row[]>();
          for (const r of over) groups.set(sameTitle(r.title), [...(groups.get(sameTitle(r.title)) ?? []), r]);
          const repeat = new Set<Row>();
          const officials = new Map<Row, string>();
          for (const g of groups.values()) {
            const c = crossposts(g);
            if (!c) continue;
            for (const r of c.repeats) repeat.add(r);
            if (c.official) officials.set(c.kept, c.official.link);
          }
          const picked = over
            .filter((r) => !repeat.has(r))
            .sort(byRank)
            .slice(0, BACKTEST_QUEUE)
            .map((r) => ({ r, official: officials.get(r) ?? (r.source === "reddit" && officialLink(r.url) ? r.url : null) }));
          const stories: BtStory[] = [];
          const missing: string[] = [];
          for (const { r, official } of picked) {
            // the thread (Reddit's minute, once), with only the comments posted by that day's end
            const thread: Thread | null = r.source === "blizzard" ? { post: null, comments: [] } : yield* cached(`bt:thread:v2:${r.id}`, ThreadSchema, feedOrNull(`the thread ${r.id}`, reddit.thread(r.sub, externalId(r.id))));
            if (!thread) {
              missing.push(r.id);
              continue;
            }
            const byThen = thread.times ? thread.comments.filter((_, j) => (thread.times?.[j] ?? 0) <= at) : thread.comments;
            // Blizzard's post as it stood that day (the feed's excerpt is today's: a running post grows)
            const b = official && r.source === "reddit" ? (blue.find((p) => p.link === official) ?? null) : null;
            const bForum = b ? yield* forumCached(b.link) : null;
            const bThen = b && bForum ? forumMaterial(bForum.posts, postNumber(b.link), at, d.iso)?.text : undefined;
            const forum = r.source === "blizzard" ? yield* forumCached(r.link) : null;
            const p = yield* materialFor(r, at, byThen, b ? { url: b.link, title: b.title, text: bThen ?? b.excerpt } : null, (url) => cached(`bt:article:${url}`, Schema.String, article(url)), forum);
            stories.push({ ...toQueued(r, p, at), sub: r.sub, created_at: r.created_at, official });
          }
          if (missing.length) done = false;
          out.push({ day: d.iso, at, posts: rows.length, over: over.length, stories, missing });
        }
        yield* cachePut(SHEET, { at: t, today: today.day, levels, days: out });
        return { sheet: (yield* sheetText) ?? "", done };
      });

      /** The sheet: each backtest day's queue, the cards the writer posted, what it skipped and what it left. */
      const sheetText = Effect.gen(function* () {
        const s = yield* cacheGet(SHEET, SheetSchema);
        if (!s) return null;
        const marks = yield* backtestMarks;
        const sections = s.days.map((d) => {
          const mine = marks.filter((m) => m.day === d.day);
          const cards = mine
            .filter((m) => m.posted?.writeup)
            .sort((a, b) => a.at - b.at)
            .flatMap((m) => {
              const x = d.stories.find((y) => y.id === m.id);
              return x ? [cardText({ source: x.source, sub: x.sub, link: x.link, created_at: x.created_at, official: x.official }, m.posted!.writeup!)] : [];
            });
          const skipped = mine.filter((m) => m.skipped).map((m) => `- ${d.stories.find((x) => x.id === m.id)?.title ?? m.id} — ${m.skipped!.reason}`);
          const left = d.stories.filter((x) => !mine.some((m) => m.id === x.id)).map((x, j) => `${j + 1}. ${x.subreddit} · [${x.title.replace(/[[\]]/g, "")}](${x.link})`);
          return [
            `## ${time.weekday(d.day)} ${d.day}`,
            `${d.posts} posts that day; ${d.over} over their subreddit's bar; ${d.stories.length} in the queue; ${cards.length} card${cards.length === 1 ? "" : "s"}.${d.missing.length ? ` Threads that didn't load: ${d.missing.join(", ")}.` : ""}`,
            ...(cards.length ? cards.flatMap((c) => ["", c, "", "---"]) : ["", "_No card that day._"]),
            ...(skipped.length ? ["", "**Skipped by the writer**", ...skipped] : []),
            ...(left.length ? ["", "**Not written**", ...left] : []),
          ].join("\n");
        });
        const head = [
          `# WoW news backtest · the ${s.days.length} days before ${s.today}`,
          `-# ${subs.map((x) => `r/${x} (bar: top ${s.levels[x] ?? DEFAULT_BAR})`).join(", ")} · each day's queue (up to ${BACKTEST_QUEUE}) as it stood at the day's end (Vilnius): GET /news/queue?day=…`,
        ].join("\n");
        return [head, ...sections].join("\n\n");
      });

      const startBacktest = (options: BacktestOptions = {}) =>
        Effect.gen(function* () {
          if (yield* Ref.getAndSet(testing, true)) return { backtest: "running" as const };
          yield* background.run(backtest(options).pipe(Effect.ensuring(Ref.set(testing, false))), "the WoW news backtest").pipe(Effect.onError(() => Ref.set(testing, false)));
          return { backtest: "started" as const };
        });

      const queue = (day?: string) => (day === undefined ? liveQueue() : backtestQueue(day));
      const write = (input: ArticleInput) => (input.day === undefined ? liveArticle(input) : backtestArticle(input.day, input));

      return News.of({ check, run, running: Ref.get(running), queue, article: write, backtest, startBacktest, sheet: sheetText });
    }),
  );
}
