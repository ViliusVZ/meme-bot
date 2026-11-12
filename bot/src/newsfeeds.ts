// ⚔️ Where the WoW news comes from (plan 06): Reddit's public feeds, read as RSS (Atom), because
// Reddit closes its JSON to the server (403) and an OAuth app needs the owner's account (Step 0).
// The feeds have no scores and no comment counts: a listing is an order (its rank stands in for
// the score), and a thread's feed is the post and up to 60 comments in Reddit's top order. Reddit
// allows about one feed request a minute from the server, so every request waits its turn and at
// least `newsRedditGapMs` (65 s) after the one before. All of it sits behind `RedditNews`, so an
// OAuth source (scores, comment counts) can replace this one without the news noticing.
import { XMLParser } from "fast-xml-parser";
import { Clock, Context, Duration, Effect, Layer, Ref, Schema, Semaphore } from "effect";
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
};

/** A thread's feed: the post, and its comments in Reddit's top order (no scores). */
export type Thread = { readonly post: Listed | null; readonly comments: ReadonlyArray<string> };

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
  const comments = all
    .filter((e) => String(e.id ?? "").startsWith("t1_"))
    .map((e) => plain(text(e.content)).slice(0, COMMENT))
    .filter((c) => c && !/^\[(removed|deleted)\]$/.test(c));
  return { post: first ? post(first, 1) : null, comments };
}

/** Reddit answered a feed with something other than 200 (429: the minute's request is used; 403: refused). */
export class RedditFeedError extends Schema.TaggedError<RedditFeedError>()("RedditFeedError", { url: Schema.String, status: Schema.Number }) {
  override get message() {
    return `${this.url.replace(REDDIT, "reddit")} -> ${this.status}`;
  }
}

/** What a feed request can fail with. */
export type FeedFailure = RedditFeedError | HttpClientError.HttpClientError | Cause.TimeoutError;

export class RedditNews extends Context.Service<
  RedditNews,
  {
    /** A subreddit's listing: top of the day, hot, the week's or the month's top. */
    listing(sub: string, kind: Listing): Effect.Effect<Listed[], FeedFailure>;
    /** A thread: its post and up to 60 comments, best first. */
    thread(sub: string, id: string): Effect.Effect<Thread, FeedFailure>;
  }
>()("meme-bot/newsfeeds/RedditNews") {
  static readonly layer = Layer.effect(
    RedditNews,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const http = yield* HttpClient.HttpClient;
      // one request at a time, process-wide (the live run and a backtest take turns), each at least
      // the gap after the last one ended
      const turn = yield* Semaphore.make(1);
      const last = yield* Ref.make<number | null>(null);

      const get = (url: string) =>
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

      return RedditNews.of({
        listing: Effect.fn("RedditNews.listing")((sub: string, kind: Listing) => Effect.map(get(listingUrl(sub, kind)), parseListing)),
        thread: Effect.fn("RedditNews.thread")((sub: string, id: string) => Effect.map(get(threadUrl(sub, id)), parseThread)),
      });
    }),
  );
}
