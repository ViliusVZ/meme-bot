// ⚔️ WoW news, second version (plan 06): what blows up on the WoW subreddits, read and written up.
// Every hour, in the background, on the leader:
//   1. collect: each subreddit's top of the day and hot (Reddit's feeds, one request a minute), and
//      Blizzard's blue tracker, into news_stories;
//   2. filter, in code: at most 36 h old (Blizzard's posts 48), not pinned or removed or handled,
//      and hot for its own subreddit: within its top of the day's first `bar` places (the bar is
//      learned from its month, newsfeeds.ts has no scores to give), or climbing in hot;
//   3. triage: one model call for all new candidates; code keeps the ones about Forever, not memes,
//      screenshots, loot, support or LFG, scored 7 or more, not repeats (newscard.ts `decide`);
//   4. ripen: 40 comments in its thread's feed, or 3 hours old;
//   5. write: one model call for up to NEWS_WRITE_BATCH (3) stories, each from its post, the linked
//      Blizzard/Wowhead article, up to 60 comments in top order; code checks and cleans each write-up
//      on its own (newscard.ts `check`); a batch that comes back unreadable: its stories alone, next run;
//   6. post: the card, silent, pinging nobody, at most NEWS_DAILY_POSTS (3) a day, best first.
// The first run posts nothing (everything visible is marked as there before us). No write-up, no
// post: a story whose write-up fails waits and is tried again each hour, and is dropped after 12 h.
// The owner hears after 24 h without one good collect, or 24 h of write-ups failing. The model's
// calls go to the news's own model lists (config), each model within its own daily budget
// (gemini.ts). The backtest runs the same steps over the last week, posting and storing nothing the
// live runs read (news_cache), and leaves the live runs LIVE_WRITES + LIVE_TRIAGES requests a day.
// No channel configured: none of this runs.
import { XMLParser } from "fast-xml-parser";
import { and, asc, eq, gte, inArray, lt, sql } from "drizzle-orm";
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
import { NewsWriter, PROMPT_VERSION, Verdict, Writeup, type Candidate, type Material, type Spend } from "./newswriter.js";
import type { Asked } from "./gemini.js";
import { DEFAULT_BAR, MAX_AGE, OFFICIAL_AGE, barFrom, card, cardText, check as checkWriteup, decide, notHot, officialLink, type Decision, type Judged, type Origin } from "./newscard.js";

export { SILENT } from "./newscard.js";
export const FORUM = "https://eu.forums.blizzard.com/en/wow";
export const FEED = `${FORUM}/groups/blizzard-tracker/posts.rss`;
const UA = "DiscordBot (https://github.com/ViliusVZ/meme-bot, 3.0)";
export const EVERY = 3600; // a run an hour; a failed one is tried again the next hour
export const RIPE_COMMENTS = 40; // …or RIPE_AGE old: then there's a mood to report
export const RIPE_AGE = 3 * 3600;
export const WRITE_STALE = 12 * 3600; // a story whose write-up keeps failing is dropped after this
export const STALE = 24 * 3600; // no good collect (or no write-up) for this long → tell the owner
const LEVEL_AGE = 24 * 3600; // a subreddit's bar is learned again from its month once a day
const THREADS_PER_RUN = 4; // threads read (and written up) per run at most: Reddit's minute each
const TRIAGE_MAX = 25; // candidates per triage call
const DAY_SEC = 86400;
const FEED_TIMEOUT = Duration.seconds(20);
const ARTICLE_TIMEOUT = Duration.seconds(15);
const ARTICLE_MAX = 6000;
const RUN = "news_run"; // { ok, tried, since?, alerted? }: the last good run, the last attempt (unix s)
const LEVELS = "news_levels"; // { [sub]: { bar, at } }: how deep each subreddit's top of the day is hot
const WRITES = "news_writes"; // { failing?, alerted? }: since when no write-up has worked
const SHEET = "backtest:sheet";
/** What a backtest always leaves the live runs: requests for two write-ups and one triage, a day. */
export const LIVE_WRITES = 2;
export const LIVE_TRIAGES = 1;
/** A queued story's reason when its batched write-up came back unreadable: the next one is a request of its own. */
export const ALONE = "its batch came back unreadable: written alone next";
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

const RunTimes = Schema.Struct({ ok: Schema.Number, tried: Schema.Number, since: Schema.optional(Schema.Number), alerted: Schema.optional(Schema.Number) });
const Levels = Schema.Record(Schema.String, Schema.Struct({ bar: Schema.Number, at: Schema.Number }));
const Writes = Schema.Struct({ failing: Schema.optional(Schema.Number), alerted: Schema.optional(Schema.Number) });
const ListedSchema = Schema.Struct({ id: Schema.String, title: Schema.String, link: Schema.String, url: Schema.String, body: Schema.String, created: Schema.Number, rank: Schema.Number, removed: Schema.Boolean });
const ThreadSchema = Schema.Struct({ post: Schema.NullOr(ListedSchema), comments: Schema.Array(Schema.String) });
const PostSchema = Schema.Struct({ topic: Schema.Number, post: Schema.Number, title: Schema.String, link: Schema.String, excerpt: Schema.String, published: Schema.Number });
const OriginSchema = Schema.Struct({ source: Schema.Literals(["reddit", "blizzard"]), sub: Schema.String, link: Schema.String, created_at: Schema.Number, official: Schema.NullOr(Schema.String) });
/** A card the backtest would have posted (the admin route can post them on the test bot). */
const SheetCard = Schema.Struct({ day: Schema.String, id: Schema.String, origin: OriginSchema, writeup: Writeup });
type SheetCard = typeof SheetCard.Type;
const SheetSchema = Schema.Struct({ text: Schema.String, at: Schema.Number, done: Schema.Boolean, cards: Schema.optional(Schema.Array(SheetCard)) });

/** What one run did (absent keys: nothing of that kind). */
export type RunResult = {
  running?: true;
  first?: true;
  seen?: number;
  candidates?: number;
  triaged?: number;
  queued?: string[];
  written?: number;
  posted?: string[];
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
  /** Model requests this backtest may make (within each model's budget, the live runs' part kept); 10 by default. */
  readonly maxCalls?: number;
};
export type BacktestResult = { readonly sheet: string; readonly done: boolean; readonly calls: number; readonly requests: Readonly<Record<string, number>> };
/** What posting the backtest's cards did (or why it won't, here). */
export type BacktestPosted = { readonly posted: number; readonly already: number; readonly failed?: ReadonlyArray<string> } | { readonly refused: string };

const label = (s: Pick<Story, "source" | "sub">) => (s.source === "blizzard" ? "Blizzard" : `r/${s.sub}`);
const limitOf = (s: Pick<Story, "source">) => (s.source === "blizzard" ? OFFICIAL_AGE : MAX_AGE);
const externalId = (id: string) => id.replace(/^reddit:/, "");

/** Every link in a text (the write-up's official link must be one of the material's). */
const linksIn = (text: string) => [...text.matchAll(/https?:\/\/[^\s"'<>()[\]]+/g)].map((m) => m[0].replace(/[.,;:!?]+$/, ""));

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
    /** The pipeline over the last days, posting nothing; its sheet (markdown). Resumable: see news_cache. */
    backtest(options?: BacktestOptions): Effect.Effect<BacktestResult, DbError>;
    /** The admin route's: a backtest in the background, unless one is going. */
    startBacktest(options?: BacktestOptions): Effect.Effect<{ backtest: "started" | "running" }>;
    /** The last backtest's sheet (null: none yet). */
    readonly sheet: Effect.Effect<string | null, DbError>;
    /** The last sheet's cards (of these days, or all), posted to the news channel as backtests: the test bot only. */
    postBacktest(days?: ReadonlyArray<string>): Effect.Effect<BacktestPosted, DbError>;
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
      const writer = yield* NewsWriter;
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
        const ids = [
          ...listed.flatMap((l) => [...(l.day ?? []), ...(l.hot ?? [])].map((p) => `reddit:${p.id}`)),
          ...("ok" in official ? official.ok.map((p) => `blizzard:${p.topic}`) : []),
        ];
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
        if ("ok" in official) {
          // a topic is Blizzard's when its first staff post opened it (post 1); later ones are replies
          const topics = new Map<number, Post>();
          for (const p of official.ok) if (!topics.has(p.topic) || topics.get(p.topic)!.post > p.post) topics.set(p.topic, p);
          for (const p of topics.values()) {
            const id = `blizzard:${p.topic}`;
            const was = known.get(id);
            rows.set(id, {
              id, source: "blizzard", sub: "blizzard", title: p.title, link: p.link, url: "", body: p.excerpt, created_at: p.published,
              first_seen: was?.first_seen ?? t, last_seen: t, top_rank: null, best_rank: null, hot_rank: null, prev_hot_rank: null, prev_at: was ? was.last_seen : null,
              state: was?.state ?? (first ? "old" : p.post === 1 ? "watch" : "skip"),
              reason: was ? was.reason : first ? null : p.post === 1 ? null : "a staff reply",
            });
          }
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

      // ---------------------------------------------------------------- 2. filter, 3. triage

      const setState = (ids: ReadonlyArray<string>, state: StoryState, reason: string | null = null) =>
        ids.length ? db.update(newsStories).set({ state, reason }).where(inArray(newsStories.id, [...ids])) : Effect.void;

      const filter = Effect.fn("News.filter")(function* (t: number, levels: Record<string, { bar: number }>, removed: ReadonlySet<string>) {
        const watched = yield* db.select().from(newsStories).where(and(eq(newsStories.state, "watch"), eq(newsStories.last_seen, t)));
        const hot = watched.filter((s) => notHot(s, levels[s.sub]?.bar ?? DEFAULT_BAR, t, removed.has(s.id)) === null).map((s) => s.id);
        yield* setState(hot, "candidate");
        return hot.length;
      });

      const postedSince = (since: number) => db.select().from(newsStories).where(and(eq(newsStories.state, "posted"), gte(newsStories.posted_at, since)));

      const toCandidate = (s: Story, t: number): Candidate => ({
        id: s.id,
        sub: label(s),
        title: s.title,
        rank: s.source === "blizzard" ? "a Blizzard staff post" : [s.top_rank && `#${s.top_rank} in today's top`, s.hot_rank && `#${s.hot_rank} in hot`].filter(Boolean).join(", ") || "rising",
        age_hours: Math.round((t - s.created_at) / 360) / 10,
        text: s.body.slice(0, 400),
      });

      const triage = Effect.fn("News.triage")(function* (t: number) {
        const waiting = yield* db.select().from(newsStories).where(eq(newsStories.state, "candidate")).orderBy(asc(newsStories.best_rank), asc(newsStories.created_at));
        const aged = waiting.filter((s) => t - s.created_at > limitOf(s));
        yield* setState(aged.map((s) => s.id), "dropped", "too old");
        const fresh = waiting.filter((s) => t - s.created_at <= limitOf(s)).slice(0, TRIAGE_MAX);
        if (!fresh.length) return { triaged: 0, dropped: aged.length, queued: [] as string[] };
        // today's cards are all out: what's found now waits for tomorrow's triage (or ages out)
        const posted = yield* postedSince(dayStart(t));
        if (posted.length >= config.newsDailyPosts) return { triaged: 0, dropped: aged.length, queued: [] as string[] };
        // the day's write-ups come first: the triage never takes, on the write-ups' models, the last
        // requests the day's remaining posts would need (on its own first model it never meets them)
        const keep = [{ models: writer.models.write, requests: Math.max(0, config.newsDailyPosts - posted.length) }];
        if ((yield* writer.left("triage", keep)) <= 0) {
          yield* Effect.logInfo("news: the triage waits (the day's model calls are kept for write-ups)");
          return { triaged: 0, dropped: aged.length, queued: [] as string[] };
        }
        const week = yield* postedSince(t - 7 * DAY_SEC);
        const headlines = week.map((s) => ({ id: s.id, headline: Option.getOrElse(Schema.decodeUnknownOption(Writeup)(s.writeup), () => ({ headline: s.title })).headline }));
        const verdicts = (yield* writer.triage(t, fresh.map((s) => toCandidate(s, t)), headlines, { keep })).answer;
        if (!verdicts) return { triaged: 0, dropped: aged.length, queued: [] as string[] }; // asked again next run
        const decisions = decide(fresh.map((s) => ({ id: s.id, source: s.source, title: s.title, link: s.link, rank: s.best_rank ?? s.hot_rank ?? 99 })), verdicts, new Set(week.map((s) => s.id)));
        for (const d of decisions)
          yield* db
            .update(newsStories)
            .set({ state: d.keep ? "queued" : "skip", reason: d.reason, score: d.score, same_as: d.same_as, official: d.official, verdict: d.verdict })
            .where(and(eq(newsStories.id, d.id), eq(newsStories.state, "candidate")));
        return { triaged: decisions.length, dropped: aged.length, queued: decisions.filter((d) => d.keep).map((d) => fresh.find((s) => s.id === d.id)!.title) };
      });

      // ---------------------------------------------------------------- 4. ripen, 5. write

      /** What the writer gets about a story (its thread's comments come from the caller). */
      const materialFor = Effect.fn("News.material")(function* (s: Pick<Story, "source" | "sub" | "title" | "created_at" | "link" | "url" | "body" | "official">, at: number, comments: ReadonlyArray<string>, blizzard: { url: string; title: string; text: string } | null, read: (url: string) => Effect.Effect<string | null, DbError>) {
        const target = s.source === "blizzard" ? s.link : s.url;
        const text = officialLink(target) ? yield* read(target) : null;
        const material: Material = {
          subreddit: s.source === "blizzard" ? "Blizzard's forums" : `r/${s.sub}`,
          title: s.title,
          posted_hours_ago: Math.max(0, Math.round((at - s.created_at) / 360) / 10),
          link: s.link,
          points_to: s.url,
          text: s.body,
          article: text ? { url: target, text } : null,
          blizzard_post: blizzard,
          comments,
        };
        const links = [s.link, s.url, s.official ?? "", ...(text ? [target] : []), ...linksIn(s.body), ...linksIn(text ?? ""), ...(blizzard ? [blizzard.url, ...linksIn(blizzard.text)] : [])].filter(Boolean);
        return { material, links };
      });

      const blizzardPost = Effect.fn("News.blizzardPost")(function* (link: string | null) {
        if (!link) return null;
        const [b] = yield* db.select().from(newsStories).where(and(eq(newsStories.source, "blizzard"), eq(newsStories.link, link)));
        return b ? { url: b.link, title: b.title, text: b.body } : null;
      });

      const writes = Effect.fn("News.writes")(function* (t: number, ok: boolean) {
        const w = (yield* read(WRITES, Writes)) ?? {};
        if (ok) {
          if (w.failing !== undefined || w.alerted !== undefined) yield* save(WRITES, {});
        } else if (w.failing === undefined) yield* save(WRITES, { ...w, failing: t });
      });

      /** One story: ripe yet? then what its write-up is made from. A string: why not this run ("waiting", "removed", "ripening"). */
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
          yield* db.update(newsStories).set({ comments: comments.length }).where(eq(newsStories.id, s.id));
        }
        if (comments.length < RIPE_COMMENTS && t - s.created_at < RIPE_AGE) return "ripening";
        return yield* materialFor(s, t, comments, yield* blizzardPost(s.official), article);
      });

      /** A write-up that didn't come: tried again next run, and dropped after 12 h of these; `alone`: next time in a request of its own. */
      const failed = (ids: ReadonlyArray<string>, t: number, alone: boolean) =>
        ids.length
          ? db
              .update(newsStories)
              .set({ write_tries: sql`${newsStories.write_tries} + 1`, write_first: sql`COALESCE(${newsStories.write_first}, ${t})`, ...(alone ? { reason: ALONE } : {}) })
              .where(inArray(newsStories.id, [...ids]))
          : Effect.void;

      const write = Effect.fn("News.write")(function* (t: number) {
        const queued = yield* db
          .select()
          .from(newsStories)
          .where(eq(newsStories.state, "queued"))
          .orderBy(sql`${newsStories.score} DESC NULLS LAST`, sql`${newsStories.best_rank} ASC NULLS LAST`, asc(newsStories.created_at));
        // aged out, or 12 hours of failed write-ups: dropped, never posted late
        const aged = queued.filter((s) => t - s.created_at > limitOf(s));
        const stale = queued.filter((s) => !aged.includes(s) && s.write_first !== null && t - s.write_first >= WRITE_STALE);
        yield* setState(aged.map((s) => s.id), "dropped", "too old");
        yield* setState(stale.map((s) => s.id), "dropped", "no write-up in 12 h");
        const live = queued.filter((s) => !aged.includes(s) && !stale.includes(s));
        const posted = (yield* postedSince(dayStart(t))).length;
        const ready = (yield* db.select({ n: sql<number>`count(*)::int` }).from(newsStories).where(eq(newsStories.state, "ready")))[0].n;
        // only as many write-ups as today can still post, and a few threads a run (Reddit's minute each);
        // up to NEWS_WRITE_BATCH ripe stories in one request, a story whose batch came back malformed alone
        let need = config.newsDailyPosts - posted - ready;
        let threads = THREADS_PER_RUN;
        let written = 0;
        let i = 0;
        while (need > 0 && threads > 0 && i < live.length) {
          const batch: Array<{ s: Story; material: Material; links: string[] }> = [];
          while (i < live.length && threads > 0 && batch.length < Math.min(need, config.newsWriteBatch)) {
            const s = live[i];
            const alone = s.reason === ALONE;
            if (alone && batch.length) break;
            i++;
            const p = yield* prepare(s, t);
            if (s.source === "reddit") threads--;
            if (typeof p === "string") continue;
            batch.push({ s, ...p });
            if (alone) break;
          }
          if (!batch.length) continue;
          const r = (yield* writer.write(t, batch.map((b) => ({ id: b.s.id, material: b.material })))).answer;
          yield* writes(t, !!r && r.written.size > 0);
          if (!r) {
            yield* failed(batch.map((b) => b.s.id), t, false);
            break; // the model isn't answering: the rest wait for the next run too
          }
          yield* failed(r.missing, t, batch.length > 1);
          for (const { s, links } of batch) {
            const raw = r.written.get(s.id);
            if (!raw) continue;
            const checked = checkWriteup(raw, links);
            if ("drop" in checked) {
              yield* setState([s.id], "skip", checked.drop);
              continue;
            }
            yield* db.update(newsStories).set({ state: "ready", writeup: checked.ok, reason: null }).where(and(eq(newsStories.id, s.id), eq(newsStories.state, "queued")));
            written++;
            need--;
          }
          if (!r.written.size) break; // nothing readable came back: the rest wait for the next run
        }
        return { written, dropped: aged.length + stale.length };
      });

      // ---------------------------------------------------------------- 6. post

      const post = Effect.fn("News.post")(function* (to: string, t: number) {
        const ready = yield* db
          .select()
          .from(newsStories)
          .where(eq(newsStories.state, "ready"))
          .orderBy(sql`${newsStories.score} DESC NULLS LAST`, sql`${newsStories.best_rank} ASC NULLS LAST`, asc(newsStories.created_at));
        const aged = ready.filter((s) => t - s.created_at > limitOf(s));
        yield* setState(aged.map((s) => s.id), "dropped", "too old");
        let left = config.newsDailyPosts - (yield* postedSince(dayStart(t))).length;
        const done: string[] = [];
        for (const s of ready) {
          if (left <= 0) break;
          if (aged.includes(s)) continue;
          const w = Option.getOrUndefined(Schema.decodeUnknownOption(Writeup)(s.writeup));
          if (!w) continue;
          const origin: Origin = { source: s.source, sub: s.sub, link: s.link, created_at: s.created_at, official: s.official };
          // claim → post → its id is never cut short (architecture §15); a refused post gives the claim back
          const sent = yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const [claim] = yield* db
                .update(newsStories)
                .set({ state: "posted", message_id: "posting", posted_at: t })
                .where(and(eq(newsStories.id, s.id), eq(newsStories.state, "ready")))
                .returning();
              if (!claim) return false;
              const msg = yield* discord
                .createMessage(to, card(origin, w))
                .pipe(Effect.tapError(() => db.update(newsStories).set({ state: "ready", message_id: null, posted_at: null }).where(eq(newsStories.id, s.id))));
              yield* db.update(newsStories).set({ message_id: msg.id }).where(eq(newsStories.id, s.id));
              return true;
            }),
          ).pipe(
            // Discord said no: the story waits for the next run (not a single failure worth a DM)
            Effect.catchTags({
              DiscordNotFound: (e) => Effect.as(Effect.logInfo(`news: post failed ${s.id} ${e.message}`), null),
              DiscordRejected: (e) => Effect.as(Effect.logInfo(`news: post failed ${s.id} ${e.message}`), null),
              DiscordUnavailable: (e) => Effect.as(Effect.logInfo(`news: post failed ${s.id} ${e.message}`), null),
              DiscordUnexpected: (e) => Effect.as(Effect.logInfo(`news: post failed ${s.id} ${e.message}`), null),
            }),
          );
          if (sent === null) break;
          if (!sent) continue;
          done.push(w.headline);
          left--;
        }
        // the day's cards are out: what passed today and didn't get one would be tomorrow's old news
        let capped = 0;
        if (left <= 0) {
          const waiting = yield* db.select({ id: newsStories.id }).from(newsStories).where(inArray(newsStories.state, ["queued", "ready"]));
          yield* setState(waiting.map((x) => x.id), "dropped", `the day's ${config.newsDailyPosts} were taken`);
          capped = waiting.length;
        }
        return { posted: done, dropped: aged.length + capped };
      });

      // ---------------------------------------------------------------- the run

      /** The owner hears once per outage: after a day without a good collect, or a day of failed write-ups. */
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
        const w = (yield* read(WRITES, Writes)) ?? {};
        if (w.failing !== undefined && t - w.failing >= STALE && w.alerted === undefined) {
          yield* alerts.failed("writing up WoW news", `no write-up has worked since <t:${w.failing}:R> (Gemini unavailable or out of budget)`);
          yield* save(WRITES, { ...w, alerted: t });
        }
      });

      const once = Effect.fn("News.once")(function* (to: string, t: number) {
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
          const tr = yield* triage(t);
          if (tr.triaged) out.triaged = tr.triaged;
          if (tr.queued.length) out.queued = tr.queued;
          const wr = yield* write(t);
          if (wr.written) out.written = wr.written;
          const po = yield* post(to, t);
          if (po.posted.length) out.posted = po.posted;
          const dropped = tr.dropped + wr.dropped + po.dropped;
          if (dropped) out.dropped = dropped;
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
          return yield* once(channel, t);
        }).pipe(Effect.ensuring(Ref.set(running, false)));
      });

      const check = Effect.gen(function* () {
        if (!channel || (yield* Ref.get(running))) return {};
        const t = yield* nowSec;
        const s = (yield* read(RUN, RunTimes)) ?? { ok: 0, tried: 0 };
        if (t - s.tried < EVERY) return {};
        yield* Ref.set(running, true);
        // Reddit's minute between requests makes a run take ten minutes: never on the minute job's own time
        const go = once(channel, t).pipe(
          Effect.flatMap((r) => (Object.keys(r).length ? Effect.logInfo(`wow news ${jsonText(r)}`) : Effect.void)),
          Effect.catchCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logInfo(`wow news run failed, trying again in an hour: ${String(Cause.squash(cause))}`))),
          Effect.ensuring(Ref.set(running, false)),
        );
        // (anything failing before the run is under way puts the flag down again, or the news would stop)
        yield* Effect.andThen(begin(t), background.run(go, "the WoW news run")).pipe(Effect.onError(() => Ref.set(running, false)));
        return { checking: true };
      }).pipe(Effect.withSpan("News.check"));

      // ---------------------------------------------------------------- the backtest

      const cacheGet = <A>(key: string, schema: Schema.Decoder<A>) =>
        Effect.map(db.select().from(newsCache).where(eq(newsCache.key, key)), ([row]) => (row ? Option.getOrUndefined(Schema.decodeUnknownOption(schema)(row.value)) : undefined));
      const cachePut = (key: string, value: unknown) =>
        Effect.gen(function* () {
          const at = yield* nowSec;
          yield* db.insert(newsCache).values({ key, value, at }).onConflictDoUpdate({ target: newsCache.key, set: { value, at } });
        });
      /** A cached value, or `make`'s (stored when it's there): what a rerun of the backtest doesn't pay twice for. */
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

      const backtest = Effect.fn("News.backtest")(function* (options: BacktestOptions = {}) {
        const t = yield* nowSec;
        const days = Math.max(1, Math.min(7, Math.round(options.days ?? 7)));
        const maxCalls = Math.max(0, Math.round(options.maxCalls ?? 10));
        const today = time.at(t);
        // whatever the backtest spends, the live runs keep two write-ups' requests and a triage's
        const keep = [
          { models: writer.models.write, requests: LIVE_WRITES },
          { models: writer.models.triage, requests: LIVE_TRIAGES },
          { models: [...new Set([...writer.models.write, ...writer.models.triage])], requests: LIVE_WRITES + LIVE_TRIAGES },
        ];
        let calls = 0; // requests this run, against max_calls
        let pending = false;
        const requests = new Map<string, number>(); // per model, this run
        const answered = new Map<string, number>();
        /** A model call within the run's max_calls and the live runs' keep (null: not made). */
        const spend = <T>(ask: (s: Spend) => Effect.Effect<Asked<T>, DbError>) =>
          Effect.gen(function* () {
            if (calls >= maxCalls) {
              pending = true;
              return null;
            }
            const r = yield* ask({ keep, limit: maxCalls - calls });
            calls += r.attempts.length;
            for (const a of r.attempts) {
              requests.set(a.model, (requests.get(a.model) ?? 0) + 1);
              if (a.outcome === "answered") answered.set(a.model, (answered.get(a.model) ?? 0) + 1);
            }
            if (r.answer === null && r.refused) pending = true;
            return r;
          });
        /** Out of model calls for now (max_calls, or the budget), rather than Gemini failing. */
        const outOfCalls = (r: Asked<unknown> | null) => r === null || (r.answer === null && r.refused);
        const levels: Record<string, number> = {};
        const week: Array<Listed & { sub: string }> = [];
        for (const sub of subs) {
          const month = yield* cached(`bt:month:${sub}:${today.day}`, Schema.Array(ListedSchema), feedOrNull(`r/${sub} month`, reddit.listing(sub, "month")));
          levels[sub] = month ? barFrom(month, t) : DEFAULT_BAR;
          const w = yield* cached(`bt:week:${sub}:${today.day}`, Schema.Array(ListedSchema), feedOrNull(`r/${sub} week`, reddit.listing(sub, "week")));
          for (const p of w ?? []) week.push({ ...p, sub });
        }
        const blue = (yield* cached(`bt:blue:${today.day}`, Schema.Array(PostSchema), feedOrNull("blue tracker", fetchFeed))) ?? [];
        const sections: string[] = [];
        const posted: Array<{ id: string; headline: string }> = [];
        const wouldPost: Array<SheetCard> = [];
        for (let i = days; i >= 1; i--) {
          const d = calendar(today.y, today.m, today.d, -i);
          const start = time.wallToUnix(d.y, d.m, d.d, 0, 0);
          const next = calendar(d.y, d.m, d.d, 1);
          const at = Math.min(t, time.wallToUnix(next.y, next.m, next.d, 0, 0) - 1);
          // the day's posts, ranked within their subreddit's day as the week's top has them
          const ofDay = new Map<string, Listed & { sub: string }>();
          const rankInDay = new Map<string, number>();
          for (const sub of subs) {
            const mine = week.filter((p) => p.sub === sub && p.created >= start && p.created <= at);
            mine.forEach((p, j) => {
              ofDay.set(`reddit:${p.id}`, p);
              rankInDay.set(`reddit:${p.id}`, j + 1);
            });
          }
          type Row = { id: string; source: "reddit" | "blizzard"; sub: string; title: string; link: string; url: string; body: string; created_at: number; rank: number };
          const rows: Row[] = [...ofDay].map(([id, p]) => ({ id, source: "reddit", sub: p.sub, title: p.title, link: p.link, url: p.url, body: p.body, created_at: p.created, rank: rankInDay.get(id)! }));
          for (const p of blue) if (p.post === 1 && p.published >= start && p.published <= at) rows.push({ id: `blizzard:${p.topic}`, source: "blizzard", sub: "blizzard", title: p.title, link: p.link, url: "", body: p.excerpt, created_at: p.published, rank: 0 });
          const reasons = new Map<string, string>();
          const scores = new Map<string, number>();
          const candidates: Row[] = [];
          for (const r of rows) {
            const why = notHot({ ...r, top_rank: r.source === "reddit" ? r.rank : null, hot_rank: null, prev_hot_rank: null }, levels[r.sub] ?? DEFAULT_BAR, at, ofDay.get(r.id)?.removed);
            if (why) reasons.set(r.id, why === "under the bar" ? `under the bar (#${r.rank} of the day; r/${r.sub}'s bar is ${levels[r.sub] ?? DEFAULT_BAR})` : why);
            else candidates.push(r);
          }
          candidates.sort((a, b) => a.rank - b.rank);
          const judged = candidates.slice(0, TRIAGE_MAX);
          const asked: Candidate[] = judged.map((r) => ({ id: r.id, sub: r.source === "blizzard" ? "Blizzard" : `r/${r.sub}`, title: r.title, rank: r.source === "blizzard" ? "a Blizzard staff post" : `#${r.rank} in that day's top`, age_hours: Math.round((at - r.created_at) / 360) / 10, text: r.body.slice(0, 400) }));
          const triageKey = `bt:triage:${PROMPT_VERSION}:${d.iso}:${judged.map((r) => r.id).sort().join(",")}`;
          let triaged: Asked<ReadonlyArray<Verdict>> | null = null;
          const verdicts = judged.length
            ? yield* cached(triageKey, Schema.Array(Verdict), Effect.gen(function* () {
                triaged = yield* spend((s) => writer.triage(at, asked, posted, s));
                return triaged?.answer ?? null;
              }))
            : [];
          let decisions: Decision[] = [];
          if (verdicts) decisions = decide(judged.map((r): Judged => ({ id: r.id, source: r.source, title: r.title, link: r.link, rank: r.rank })), verdicts, new Set(posted.map((p) => p.id)));
          else for (const r of judged) reasons.set(r.id, outOfCalls(triaged) ? "not triaged yet (Gemini's budget: run again)" : "not triaged (Gemini didn't answer)");
          for (const r of candidates.slice(TRIAGE_MAX)) reasons.set(r.id, "under the bar (past the triage's 25)");
          for (const x of decisions) {
            if (x.score !== null) scores.set(x.id, x.score);
            if (!x.keep) reasons.set(x.id, x.reason ?? "skipped");
          }
          const kept = decisions.filter((x) => x.keep).sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || rows.find((r) => r.id === a.id)!.rank - rows.find((r) => r.id === b.id)!.rank);
          const cap = config.newsDailyPosts;
          const cards: string[] = [];
          // in rounds, best first: as many as the day still has room for, up to NEWS_WRITE_BATCH
          // write-ups in one request (cached ones cost nothing), a story whose batch was unreadable alone
          let k = 0;
          while (k < kept.length && cards.length < cap) {
            type Entry = { r: Row; official: string | null; key: string; w: Writeup | undefined; links: string[]; material: Material; why?: string };
            const round: Entry[] = [];
            let toWrite = 0;
            while (k < kept.length && round.length < cap - cards.length && toWrite < config.newsWriteBatch) {
              const x = kept[k];
              const r = rows.find((y) => y.id === x.id)!;
              const key = `bt:write:${PROMPT_VERSION}:${r.id}`;
              const w = yield* cacheGet(key, Writeup);
              const alone = !w && (yield* cacheGet(`bt:alone:${r.id}`, Schema.Boolean)) === true;
              if (alone && toWrite) break;
              k++;
              // the thread only for a write-up still to be paid for (Reddit's minute each)
              const thread: Thread | null = w || r.source === "blizzard" ? { post: null, comments: [] } : yield* cached(`bt:thread:${r.id}`, ThreadSchema, feedOrNull(`the thread ${r.id}`, reddit.thread(r.sub, externalId(r.id))));
              if (!thread) {
                reasons.set(r.id, "its thread didn't load");
                continue;
              }
              const b = x.official ? (blue.find((p) => p.link === x.official) ?? null) : null;
              const { material, links } = yield* materialFor({ ...r, official: x.official }, at, thread.comments, b ? { url: b.link, title: b.title, text: b.excerpt } : null, (url) => cached(`bt:article:${url}`, Schema.String, article(url)));
              round.push({ r, official: x.official, key, w, links, material });
              if (!w) toWrite++;
              if (alone) break;
            }
            const writing = round.filter((e) => !e.w);
            if (writing.length) {
              const res = yield* spend((s) => writer.write(at, writing.map((e) => ({ id: e.r.id, material: e.material })), s));
              const got = res?.answer ?? null;
              for (const e of writing) {
                e.w = got?.written.get(e.r.id);
                if (e.w) yield* cachePut(e.key, e.w);
                else if (got && writing.length > 1) {
                  yield* cachePut(`bt:alone:${e.r.id}`, true);
                  e.why = "its batch came back unreadable (written alone next run)";
                } else e.why = outOfCalls(res) ? "not written yet (Gemini's budget: run again)" : got ? "an unreadable write-up" : "no write-up (Gemini didn't answer)";
              }
            }
            for (const e of round) {
              if (!e.w) {
                reasons.set(e.r.id, e.why ?? "no write-up");
                continue;
              }
              const c = checkWriteup(e.w, e.links);
              if ("drop" in c) {
                reasons.set(e.r.id, c.drop);
                continue;
              }
              const origin: Origin = { source: e.r.source, sub: e.r.sub, link: e.r.link, created_at: e.r.created_at, official: e.official };
              cards.push(cardText(origin, c.ok));
              wouldPost.push({ day: d.iso, id: e.r.id, origin, writeup: c.ok });
              posted.push({ id: e.r.id, headline: c.ok.headline });
            }
          }
          for (const x of kept.slice(k)) reasons.set(x.id, `the day's ${cap} were taken`);
          const rest = rows
            .filter((r) => reasons.has(r.id))
            .sort((a, b) => (scores.get(b.id) ?? -1) - (scores.get(a.id) ?? -1) || (a.source === "blizzard" ? 99 : a.rank) - (b.source === "blizzard" ? 99 : b.rank))
            .slice(0, 5)
            .map((r, j) => `${j + 1}. ${r.source === "blizzard" ? "Blizzard" : `r/${r.sub} #${r.rank}`} · [${r.title.replace(/[[\]]/g, "")}](${r.link}) — ${reasons.get(r.id)}${scores.has(r.id) ? ` (${scores.get(r.id)}/10)` : ""}`);
          sections.push(
            [
              `## ${time.weekday(d.iso)} ${d.iso}`,
              `${rows.length} posts that day; ${candidates.length} over their subreddit's bar; ${cards.length} card${cards.length === 1 ? "" : "s"}.`,
              ...(cards.length ? cards.flatMap((c) => ["", c, "", "---"]) : ["", "_No card that day._"]),
              "",
              "**The best of the rest**",
              ...(rest.length ? rest : ["(none)"]),
            ].join("\n"),
          );
        }
        const perModel = (m: ReadonlyMap<string, number>) => [...m].map(([model, n]) => `${model} ${n}`).join(", ") || "none";
        const head = [
          `# WoW news backtest · the ${days} days before ${today.day}`,
          `-# ${subs.map((s) => `r/${s} (bar: top ${levels[s]})`).join(", ")} · ${pending ? "**not finished**: out of model calls; run it again (tomorrow's budget) and it carries on from what's cached" : "complete"}`,
          `-# Model requests this run: ${calls} of ${maxCalls} (${perModel(requests)}); answered by: ${perModel(answered)}. Write-ups: ${writer.models.write.join(" → ")}; triage: ${writer.models.triage.join(" → ")}.`,
          `-# Threads are read as they are now, not as they were that day; no waiting for comments; posts ranked within their day by the week's top.`,
        ].join("\n");
        const sheet = [head, ...sections].join("\n\n");
        yield* cachePut(SHEET, { text: sheet, at: t, done: !pending, cards: wouldPost });
        return { sheet, done: !pending, calls, requests: Object.fromEntries(requests) };
      });

      const startBacktest = (options: BacktestOptions = {}) =>
        Effect.gen(function* () {
          if (yield* Ref.getAndSet(testing, true)) return { backtest: "running" as const };
          yield* background.run(backtest(options).pipe(Effect.ensuring(Ref.set(testing, false))), "the WoW news backtest").pipe(Effect.onError(() => Ref.set(testing, false)));
          return { backtest: "started" as const };
        });

      const sheet = Effect.map(cacheGet(SHEET, SheetSchema), (s) => s?.text ?? null);

      /**
       * The last sheet's would-be cards in the news channel, as the live runs post them, each marked
       * as a backtest: the test bot only (NEWS_BACKTEST_POST). Never touches news_stories or the
       * day's cap; each card is claimed in news_cache first, so a second call doesn't post it again.
       */
      const postBacktest = Effect.fn("News.postBacktest")(function* (days?: ReadonlyArray<string>) {
        if (!config.newsBacktestPost) return { refused: "posting the backtest's cards is off here (NEWS_BACKTEST_POST is the test bot's)" } as const;
        if (!channel) return { refused: "no news channel configured" } as const;
        const s = yield* cacheGet(SHEET, SheetSchema);
        const out = { posted: 0, already: 0, failed: [] as string[] };
        for (const c of s?.cards ?? []) {
          if (days?.length && !days.includes(c.day)) continue;
          const key = `bt:posted:${s!.at}:${c.id}`;
          // claim → post → its id, never cut short; a refused post gives the claim back
          const sent = yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const at = yield* nowSec;
              const [claim] = yield* db.insert(newsCache).values({ key, value: { message_id: "posting" }, at }).onConflictDoNothing().returning();
              if (!claim) return false;
              const msg = yield* discord
                .createMessage(channel, card(c.origin, c.writeup, `backtest · ${time.weekday(c.day)} ${c.day}`))
                .pipe(Effect.tapError(() => db.delete(newsCache).where(eq(newsCache.key, key))));
              yield* db.update(newsCache).set({ value: { message_id: msg.id } }).where(eq(newsCache.key, key));
              return true;
            }),
          ).pipe(
            Effect.catchTags({
              DiscordNotFound: (e) => Effect.succeed(e.message),
              DiscordRejected: (e) => Effect.succeed(e.message),
              DiscordUnavailable: (e) => Effect.succeed(e.message),
              DiscordUnexpected: (e) => Effect.succeed(e.message),
            }),
          );
          if (sent === true) out.posted++;
          else if (sent === false) out.already++;
          else out.failed.push(`${c.id}: ${sent}`);
        }
        return out.failed.length ? out : { posted: out.posted, already: out.already };
      });

      return News.of({ check, run, running: Ref.get(running), backtest, startBacktest, sheet, postBacktest });
    }),
  );
}
