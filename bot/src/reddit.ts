// The meme pool: this week's top image posts from the subreddit's public Atom feed (Reddit's JSON
// API needs an approved OAuth app; the feed doesn't, and it's already sorted by score). Fetched
// every few hours by the minute job; storing is an upsert, so repeats are harmless.
import { XMLParser } from "fast-xml-parser";
import { eq } from "drizzle-orm";
import type { Env } from "./env.js";
import { settings } from "./db/index.js";
import { ingest, type Incoming } from "./memes.js";
import * as alerts from "./alerts.js";

const USER_AGENT = "discord-meme-bot/3.0 (daily top post)";
const IMAGE = /href="(https:\/\/i\.redd\.it\/[^"]+\.(?:png|jpe?g|gif|webp))"/;
const EVERY = 6 * 3600_000;
const STALE = 12 * 3600_000; // the pool holds a week of memes: only this long without a refill is worth a DM
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

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

async function fetchFeed(env: Env) {
  const url = `https://www.reddit.com/r/${env.SUBREDDIT}/top/.rss?t=week&limit=100`;
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(20_000) });
    if (r.ok) return r.text();
    if (![429, 500, 502, 503].includes(r.status) || attempt === 3) throw new Error(`reddit ${r.status}`);
    const reset = Number(r.headers.get("x-ratelimit-reset") ?? 0);
    await sleep(Math.min(60, r.status === 429 ? reset + 2 : 2 ** attempt) * 1000);
  }
}

export async function refill(env: Env) {
  const memes = parseFeed(await fetchFeed(env));
  return { fetched: memes.length, stored: await ingest(env, memes) };
}

const KEY = "reddit_refill"; // { ok, tried }: when the last refill worked, and the last attempt (unix ms)

let lastOk = 0;
let lastTry = 0;
let restored = false;
let running = false;

/**
 * The refill times outlive a restart: otherwise every deploy (or a crash loop) fetches straight
 * away, and enough of those in a day get the server's address rate-limited by Reddit (429/403).
 */
async function restore(env: Env) {
  if (restored) return;
  const [row] = await env.db.select().from(settings).where(eq(settings.key, KEY));
  const last = (row?.value ?? {}) as { ok?: number; tried?: number };
  lastOk = Math.max(lastOk, last.ok ?? 0);
  lastTry = Math.max(lastTry, last.tried ?? 0);
  restored = true;
}

function remember(env: Env) {
  const value = { ok: lastOk, tried: lastTry };
  return env.db.insert(settings).values({ key: KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value, updated_at: new Date() } });
}

/** Tests: forget everything in memory, as a restart would. */
export function _reset() {
  lastOk = lastTry = 0;
  restored = running = false;
}

/** A refill is in flight (postDaily waits for it, so the daily pick sees fresh ranks). */
export const refilling = () => running;
const RETRY = 10 * 60_000;

/**
 * Minute job: refill the pool every 6 hours, and once more at the daily post hour so yesterday's
 * top posts are in before the daily meme is picked (postDaily waits a minute for it). Runs in
 * the background so a slow Reddit never holds up the other jobs; a failure is retried after 10 min.
 */
export async function maybeRefill(env: Env) {
  await restore(env);
  const now = Date.now();
  const postHour = new Date(now);
  postHour.setUTCHours(Number(env.POST_HOUR_UTC), 0, 0, 0);
  const due = now - lastOk >= EVERY || (now >= postHour.getTime() && lastOk < postHour.getTime());
  if (!due || running || (lastTry > lastOk && now - lastTry < RETRY)) return {};
  running = true;
  lastTry = now;
  const tried = remember(env).catch(() => {}); // best effort: the refill goes ahead regardless
  refill(env)
    .then(async (r) => {
      lastOk = Date.now();
      console.log("memes refilled", r);
      await tried;
      await remember(env).catch((e) => console.log("refill: couldn't note the time", String(e)));
    })
    .catch((e) => {
      // Reddit rate-limits the server's address now and then; the retry in 10 min usually works
      if (Date.now() - lastOk < STALE) return console.log("refill failed, retrying in 10 min:", String(e));
      const since = lastOk ? `<t:${Math.floor(lastOk / 1000)}:R>` : "ever";
      alerts.failed("fetching memes from Reddit", `${e}
no fresh memes since ${since}: the daily meme may run dry`);
    })
    .finally(() => (running = false));
  return { refilling: true };
}
