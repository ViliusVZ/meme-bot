// ⚔️ Where the WoW news comes from (plan 06): Reddit's public feeds, read as RSS (Atom), because
// Reddit closes its JSON to the server (403) and an OAuth app needs the owner's account (Step 0).
// The feeds have no scores and no comment counts: a listing is an order (its rank stands in for
// the score), and a thread's feed is the post and up to 60 comments in Reddit's top order. Reddit
// allows about one feed request a minute from the server, so every request waits its turn and at
// least `newsRedditGapMs` (65 s) after the one before. All of it sits behind `RedditNews`, so an
// OAuth source (scores, comment counts) can replace this one without the news noticing.
import { XMLParser } from "fast-xml-parser";
import { Clock, Context, Duration, Effect, Layer, Redacted, Ref, Schema, Semaphore } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { HttpClientError } from "effect/http";
import type { Cause } from "effect";
import { AppConfig } from "./config.js";

export const REDDIT = "https://www.reddit.com";
const UA = "meme-bot/3.0 (the WoW news of a three-person Discord server; https://github.com/ViliusVZ/meme-bot)";
const TIMEOUT = Duration.seconds(20);
const BODY = 4000; // a post's own text, at most this long
const COMMENT = 600; // one comment, at most this long

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", processEntities: true, htmlEntities: true, parseTagValue: false });

/** One post of a listing, as the feed gives it. */
export type Listed = {
  readonly id: string; // t3_…
  readonly title: string;
  readonly link: string; // the thread
  readonly url: string; // where the post points: an article, an image; "" for a text post
  readonly body: string; // its own text (plain, cut)
  readonly created: number; // unix s
  readonly rank: number; // 1-based, in the listing's order
  readonly removed: boolean;
  readonly author?: string; // without u/ (the embed widget doesn't give it)
};

/** A thread's feed: the post, and its comments in Reddit's top order (no scores); `times`: when each was posted (unix s). */
export type Thread = { readonly post: Listed | null; readonly comments: ReadonlyArray<string>; readonly times?: ReadonlyArray<number> };

export type Listing = "day" | "hot" | "week" | "month";
const PATHS: Record<Listing, string> = {
  day: "top/.rss?t=day&limit=25",
  hot: "hot/.rss?limit=25",
  week: "top/.rss?t=week&limit=100",
  month: "top/.rss?t=month&limit=100",
};
export const listingUrl = (sub: string, kind: Listing) => `${REDDIT}/r/${sub}/${PATHS[kind]}`;
export const threadUrl = (sub: string, id: string) => `${REDDIT}/r/${sub}/comments/${id.replace(/^t3_/, "")}/.rss?sort=top&limit=60`;

/** Leftover HTML entities inside the (already XML-decoded) text. */
export function unescape(s: string) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** HTML as plain text: tags out, entities decoded, white space squeezed. */
export function plain(html: string) {
  return unescape(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

type Node = { "#text"?: unknown; "@href"?: unknown } | string | undefined;
type Entry = { content?: Node; link?: Node | Node[]; id?: unknown; title?: Node; published?: unknown; updated?: unknown };
const text = (n: Node) => String(typeof n === "object" && n !== null ? (n["#text"] ?? "") : (n ?? ""));
const href = (n: Entry["link"]) => String([n].flat().map((l) => (typeof l === "object" && l !== null ? l["@href"] : undefined)).find(Boolean) ?? "");
const entries = (xml: string) => [parser.parse(xml)?.feed?.entry ?? []].flat() as Entry[];

/** A post's entry: its own text sits in the `md` block, its target in the `[link]` anchor. */
function post(e: Entry, rank: number): Listed {
  const html = text(e.content);
  const md = html.match(/<div class="md">([\s\S]*?)<\/div>\s*<!-- SC_ON -->/)?.[1] ?? "";
  const link = href(e.link);
  const target = unescape(html.match(/<a href="([^"]+)">\[link\]<\/a>/)?.[1] ?? "");
  const body = plain(md);
  return {
    id: String(e.id ?? ""),
    title: unescape(text(e.title)).trim(),
    link,
    url: target === link ? "" : target,
    body: body.slice(0, BODY),
    created: Math.floor(Date.parse(String(e.published ?? e.updated ?? "")) / 1000),
    rank,
    removed: /^\[(removed|deleted)\]$/.test(body),
  };
}

/** A listing's posts, in its order (comments and anything that isn't a post are skipped). */
export function parseListing(xml: string): Listed[] {
  return entries(xml)
    .filter((e) => String(e.id ?? "").startsWith("t3_"))
    .map((e, i) => post(e, i + 1))
    .filter((p) => p.title && p.link && Number.isFinite(p.created));
}

/** A thread's feed: the post first, then its comments (as plain text, cut; empty ones skipped). */
export function parseThread(xml: string): Thread {
  const all = entries(xml);
  const first = all.find((e) => String(e.id ?? "").startsWith("t3_"));
  const kept = all
    .filter((e) => String(e.id ?? "").startsWith("t1_"))
    .map((e) => ({ text: plain(text(e.content)).slice(0, COMMENT), at: Math.floor(Date.parse(String(e.published ?? e.updated ?? "")) / 1000) }))
    .filter((c) => c.text && !/^\[(removed|deleted)\]$/.test(c.text));
  return { post: first ? post(first, 1) : null, comments: kept.map((c) => c.text), times: kept.map((c) => (Number.isFinite(c.at) ? c.at : 0)) };
}

/** Reddit answered a feed with something other than 200 (429: the minute's request is used; 403: refused). */
export class RedditFeedError extends Schema.TaggedError<RedditFeedError>()("RedditFeedError", { url: Schema.String, status: Schema.Number }) {
  override get message() {
    return `${this.url.replace(REDDIT, "reddit")} -> ${this.status}`;
  }
}

/** What a feed request can fail with. */
export type FeedFailure = RedditFeedError | HttpClientError.HttpClientError | Cause.TimeoutError | Schema.SchemaError;

// ---------------------------------------------------------------- 🌉 the embed widget (a bridge)

// Reddit's old embed widget still answers logged-out readers: `document.write("…html…")` with a
// listing's posts (id, title, target, score, comments) or a thread's comments (author, score, "2
// hours ago", text). No post dates: a post counts as made when we first saw it (news.ts keeps the
// first value). Only until the Devvit API works (REDDIT_SOURCE=devvit); the owner wants it gone then.
const EMBED: Record<Listing, string | null> = {
  day: "top/.embed?limit=25&t=day",
  hot: "hot/.embed?limit=25",
  week: "top/.embed?limit=100&t=week",
  month: null, // only for the subreddits' levels, which keep their last learned value meanwhile
};
export const embedListingUrl = (sub: string, kind: Listing) => (EMBED[kind] ? `${REDDIT}/r/${sub}/${EMBED[kind]}` : null);
export const embedThreadUrl = (sub: string, id: string) => `${REDDIT}/r/${sub}/comments/${id.replace(/^t3_/, "")}/.embed?limit=60&sort=top`;

/** The widget's HTML out of its `document.write("…")` (a JSON-style string). */
function embedHtml(js: string): string {
  const m = js.match(/document\.write\(([\s\S]*)\);?\s*$/);
  if (!m) return "";
  try {
    return String(JSON.parse(m[1]!));
  } catch {
    return "";
  }
}

/** A listing widget's posts, in its order; `now` stands in for their (unknown) creation time. */
export function parseEmbedListing(js: string, now: number): Listed[] {
  const out: Listed[] = [];
  for (const part of embedHtml(js).split(/<div class="reddit-link [^"]*thing id-/).slice(1)) {
    const id = part.match(/^(t3_\w+)/)?.[1];
    const title = part.match(/class="reddit-link-title[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
    const link = part.match(/class="reddit-comment-link[^"]*"[^>]*href="([^"]*)"/)?.[1];
    if (!id || !title || !link) continue;
    const thread = unescape(link);
    const target = unescape(title[1]!);
    out.push({ id, title: plain(title[2]!), link: thread, url: target === thread ? "" : target, body: "", created: now, rank: out.length + 1, removed: false });
  }
  return out;
}

/** "2 hours ago" as seconds before now (null: unreadable). */
function ago(text: string): number | null {
  const t = text.trim();
  if (/^just now$/i.test(t)) return 0;
  const m = t.match(/^(\d+|an?)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/i);
  if (!m) return null;
  const n = /^an?$/i.test(m[1]!) ? 1 : Number(m[1]);
  const unit: Record<string, number> = { second: 1, minute: 60, hour: 3600, day: 86400, week: 7 * 86400, month: 30 * 86400, year: 365 * 86400 };
  return n * (unit[m[2]!.toLowerCase()] ?? 0);
}

/** A thread widget's comments, in its (top) order: replies follow their parent. No post. */
export function parseEmbedThread(js: string, now: number): Thread {
  const kept: Array<{ text: string; at: number }> = [];
  const re = /thing id-t1_\w+ "><small>[\s\S]*?<\/span>&#32;([^&<]*)&#32;<a[^>]*>permalink<\/a><\/small><br\/><div class="md">([\s\S]*?)<\/div>/g;
  for (const m of embedHtml(js).matchAll(re)) {
    const text = plain(m[2]!).slice(0, COMMENT);
    if (!text || /^\[(removed|deleted)\]$/.test(text)) continue;
    const before = ago(m[1]!);
    kept.push({ text, at: before === null ? 0 : now - before });
  }
  return { post: null, comments: kept.map((c) => c.text), times: kept.map((c) => c.at) };
}

// ---------------------------------------------------------------- 📮 our Devvit app's API

/** A post as our Devvit app answers it (trio-relay/src/server/server.ts). */
const ApiPost = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  link: Schema.String,
  url: Schema.String,
  body: Schema.String,
  created: Schema.Number,
  score: Schema.Number,
  comments: Schema.Number,
  removed: Schema.Boolean,
  author: Schema.String,
  nsfw: Schema.Boolean,
  images: Schema.Array(Schema.String),
});
const ApiAnswer = Schema.Struct({
  listings: Schema.Array(Schema.Struct({ sub: Schema.String, kind: Schema.String, posts: Schema.Array(ApiPost) })),
  threads: Schema.Array(
    Schema.Struct({
      sub: Schema.String,
      id: Schema.String,
      post: Schema.NullOr(ApiPost),
      comments: Schema.Array(Schema.Struct({ body: Schema.String, created: Schema.Number, score: Schema.optional(Schema.Number) })),
    }),
  ),
  failed: Schema.Array(Schema.String),
});
const t3 = (id: string) => (id.startsWith("t3_") ? id : `t3_${id}`);
/** One of the app's posts as the news reads it (rank: its place in the listing). */
export const fromApi = (p: typeof ApiPost.Type, rank: number): Listed => ({
  id: t3(p.id),
  title: p.title.trim(),
  link: p.link,
  url: p.url === p.link ? "" : p.url,
  body: p.body,
  created: p.created,
  rank,
  removed: p.removed,
  author: p.author,
});

/** One request at a time, process-wide, each at least the gap after the last one ended (the feeds' and the widget's minute). */
const paced = Effect.gen(function* () {
  const config = yield* AppConfig;
  const http = yield* HttpClient.HttpClient;
  const turn = yield* Semaphore.make(1);
  const last = yield* Ref.make<number | null>(null);
  return (url: string) =>
    turn.withPermit(
      Effect.gen(function* () {
        const before = yield* Ref.get(last);
        if (before !== null) {
          const wait = before + config.newsRedditGapMs - (yield* Clock.currentTimeMillis);
          if (wait > 0) yield* Effect.sleep(Duration.millis(wait));
        }
        return yield* Effect.gen(function* () {
          const res = yield* http.execute(HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders({ "User-Agent": UA })));
          if (res.status !== 200) return yield* new RedditFeedError({ url, status: res.status });
          return yield* res.text;
        }).pipe(
          Effect.timeout(TIMEOUT),
          Effect.ensuring(Effect.flatMap(Clock.currentTimeMillis, (ms) => Ref.set(last, ms))),
        );
      }),
    );
});

export class RedditNews extends Context.Service<
  RedditNews,
  {
    /** A subreddit's listing: top of the day, hot, the week's or the month's top. */
    listing(sub: string, kind: Listing): Effect.Effect<Listed[], FeedFailure>;
    /** A thread: its post and up to 60 comments, best first. */
    thread(sub: string, id: string): Effect.Effect<Thread, FeedFailure>;
  }
>()("meme-bot/newsfeeds/RedditNews") {
  /** By config: our Devvit app's API, the embed widget (a bridge), or the public feeds (the tests). */
  static readonly layer = Layer.unwrap(
    Effect.gen(function* () {
      const c = yield* AppConfig;
      return c.redditSource === "devvit" ? RedditNews.devvitLayer : c.redditSource === "embed" ? RedditNews.embedLayer : RedditNews.feedLayer;
    }),
  );

  /** 📮 POST {listings} or {threads} to our Devvit app's /external/read, with its managed token. */
  static readonly devvitLayer = Layer.effect(
    RedditNews,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const http = yield* HttpClient.HttpClient;
      const url = config.redditApiUrl ?? "";
      const token = config.redditApiToken;
      const ask = (body: object) =>
        Effect.gen(function* () {
          if (!url || token === undefined) return yield* new RedditFeedError({ url: url || "devvit", status: 503 });
          const req = HttpClientRequest.post(url).pipe(
            HttpClientRequest.setHeaders({ Authorization: `bearer ${Redacted.value(token)}`, "User-Agent": UA }),
            HttpClientRequest.bodyJsonUnsafe(body),
          );
          const res = yield* http.execute(req);
          if (res.status !== 200) return yield* new RedditFeedError({ url, status: res.status });
          return yield* Schema.decodeUnknownEffect(ApiAnswer)(yield* res.json);
        }).pipe(Effect.timeout(Duration.seconds(30)));
      return RedditNews.of({
        listing: Effect.fn("RedditNews.listing")(function* (sub: string, kind: Listing) {
          const a = yield* ask({ listings: [{ sub, kind, limit: kind === "day" || kind === "hot" ? 25 : 100 }] });
          const l = a.listings[0];
          if (!l) return yield* new RedditFeedError({ url: listingUrl(sub, kind), status: 404 });
          return l.posts.map((p, i) => fromApi(p, i + 1)).filter((p) => p.title && p.link && Number.isFinite(p.created));
        }),
        thread: Effect.fn("RedditNews.thread")(function* (sub: string, id: string) {
          const a = yield* ask({ threads: [{ sub, id: t3(id), limit: 60 }] });
          const t = a.threads[0];
          if (!t) return yield* new RedditFeedError({ url: threadUrl(sub, id), status: 404 });
          const comments = t.comments.filter((c) => c.body.trim());
          return { post: t.post ? fromApi(t.post, 1) : null, comments: comments.map((c) => c.body), times: comments.map((c) => c.created) };
        }),
      });
    }),
  );

  /** 🌉 The embed widget, one request a minute like the feeds were (a bridge; see EMBED). */
  static readonly embedLayer = Layer.effect(
    RedditNews,
    Effect.gen(function* () {
      const get = yield* paced;
      return RedditNews.of({
        listing: Effect.fn("RedditNews.listing")(function* (sub: string, kind: Listing) {
          const url = embedListingUrl(sub, kind);
          if (!url) return yield* new RedditFeedError({ url: listingUrl(sub, kind), status: 501 });
          const body = yield* get(url);
          return parseEmbedListing(body, Math.floor((yield* Clock.currentTimeMillis) / 1000));
        }),
        thread: Effect.fn("RedditNews.thread")(function* (sub: string, id: string) {
          const body = yield* get(embedThreadUrl(sub, id));
          return parseEmbedThread(body, Math.floor((yield* Clock.currentTimeMillis) / 1000));
        }),
      });
    }),
  );

  /** Reddit's public feeds, one request a minute (closed to logged-out readers since Nov 2026). */
  static readonly feedLayer = Layer.effect(
    RedditNews,
    Effect.gen(function* () {
      const get = yield* paced;
      return RedditNews.of({
        listing: Effect.fn("RedditNews.listing")((sub: string, kind: Listing) => Effect.map(get(listingUrl(sub, kind)), parseListing)),
        thread: Effect.fn("RedditNews.thread")((sub: string, id: string) => Effect.map(get(threadUrl(sub, id)), parseThread)),
      });
    }),
  );
}
