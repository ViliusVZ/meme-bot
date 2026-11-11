// ⚔️ WoW: Forever news in its own channel. Blizzard's staff ("blue") posts on the EU forums come
// as one RSS feed covering everything (retail, every Classic, Forever, replies to players), so
// every 30 minutes the new ones are put to Gemini in one question: is it about Forever, is it news
// (an announcement, hotfixes, notes, maintenance) rather than a reply to someone's thread, and
// what's it say in one line. If Gemini can't answer for 6 hours, titles that say "Forever" go
// through without a summary. At most 5 posts a day, silent, oldest first; the first run only
// marks what's already there as seen. A topic Blizzard keeps adding to (hotfixes) gets at most
// one "updated" line a day.
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { XMLParser } from "fast-xml-parser";
import type { Env } from "./env.js";
import { newsItems, settings } from "./db/index.js";
import { api, IS_COMPONENTS_V2 } from "./discord.js";
import { local, wallToUnix } from "./gamenight.js";
import * as gemini from "./gemini.js";
import * as alerts from "./alerts.js";

export const FORUM = "https://eu.forums.blizzard.com/en/wow";
export const FEED = `${FORUM}/groups/blizzard-tracker/posts.rss`;
const UA = "DiscordBot (https://github.com/ViliusVZ/meme-bot, 3.0)";
export const EVERY = 30 * 60;
const RETRY = 10 * 60; // a failed check tries again this soon
export const FALLBACK_AFTER = 6 * 3600; // Gemini silent this long → the title rule decides
export const DAILY_POSTS = 5;
const STALE = 24 * 3600; // no successful check for this long → tell the owner
const KEY = "wow_news";
const SILENT = 1 << 12;
const nowSec = () => Math.floor(Date.now() / 1000);
const parser = new XMLParser({ processEntities: true, htmlEntities: true });

export type Post = { topic: number; post: number; title: string; link: string; excerpt: string; published: number };

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

const sections = new Map<number, string>(); // forum section id → name (they don't change)

/**
 * Which forum section a topic is in ("WoW: Forever General Discussion"): the best hint there is
 * about which game it's for. Null when the forum won't say; judging goes ahead without it.
 */
export async function sectionOf(topic: number): Promise<string | null> {
  const get = async (path: string) => {
    const r = await fetch(`${FORUM}${path}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`${path} -> ${r.status}`);
    return r.json() as Promise<any>;
  };
  try {
    const id = Number((await get(`/t/${topic}.json`)).category_id);
    if (!sections.has(id)) sections.set(id, String((await get(`/c/${id}/show.json`)).category.name));
    return sections.get(id)!;
  } catch (e) {
    console.log("news: no section for", topic, String(e));
    return null;
  }
}

// ---------------------------------------------------------------- the minute job

let running = false;

/** Minute job: every 30 minutes (persisted, so restarts don't refetch), check in the background. */
export async function check(env: Env, t = nowSec()) {
  if (!env.NEWS_CHANNEL_ID || running) return {};
  const [row] = await env.db.select().from(settings).where(eq(settings.key, KEY));
  const s = (row?.value ?? { ok: 0, tried: 0 }) as { ok: number; tried: number };
  if (t - s.ok < EVERY || (s.tried > s.ok && t - s.tried < RETRY)) return {};
  running = true;
  const save = (v: { ok: number; tried: number }) =>
    env.db.insert(settings).values({ key: KEY, value: v }).onConflictDoUpdate({ target: settings.key, set: { value: v, updated_at: new Date() } });
  await save({ ...s, tried: t });
  // Gemini can take minutes: never on the minute job's own time
  run(env, t)
    .then(async (r) => {
      await save({ ok: t, tried: t });
      if (Object.keys(r).length) console.log("wow news", JSON.stringify(r));
    })
    .catch((e) => {
      if (t - s.ok < STALE) return console.log("wow news check failed, retrying in 10 min:", String(e));
      alerts.failed("checking WoW: Forever news", e);
    })
    .finally(() => (running = false));
  return { checking: true };
}

/** One check: read the feed, judge what's new, post what's due. */
export async function run(env: Env, t = nowSec()) {
  const r = await fetch(FEED, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`blue tracker -> ${r.status}`);
  const posts = parseFeed(await r.text());
  const out: Record<string, unknown> = {};
  const seen = await take(env, posts, t);
  if (seen) out.seen = seen;
  const judged = await judge(env, t);
  if (judged) out.judged = judged;
  const posted = await post(env, t);
  if (posted.length) out.posted = posted;
  return out;
}

/** Note new topics (and newer staff posts in known ones). The very first run only marks what's there. */
async function take(env: Env, posts: Post[], t: number) {
  const newest = new Map<number, Post>();
  for (const p of posts) if (!newest.has(p.topic) || newest.get(p.topic)!.post < p.post) newest.set(p.topic, p);
  if (!newest.size) return 0;
  const [{ n }] = await env.db.select({ n: sql<number>`count(*)::int` }).from(newsItems);
  const first = n === 0;
  const known = new Map((await env.db.select().from(newsItems).where(inArray(newsItems.topic_id, [...newest.keys()]))).map((x) => [x.topic_id, x]));
  let fresh = 0;
  for (const p of newest.values()) {
    const k = known.get(p.topic);
    if (!k) {
      const firstPost = posts.filter((x) => x.topic === p.topic).sort((a, b) => a.post - b.post)[0];
      const section = first ? null : await sectionOf(p.topic); // (the first run judges none of these)
      await env.db
        .insert(newsItems)
        .values({ topic_id: p.topic, title: p.title, link: firstPost.link, excerpt: firstPost.excerpt, section, published_at: firstPost.published, seen_at: t, state: first ? "old" : "new", last_post: p.post, told_post: first ? p.post : 0 })
        .onConflictDoNothing();
      fresh++;
    } else if (p.post > k.last_post) {
      await env.db.update(newsItems).set({ last_post: p.post }).where(eq(newsItems.topic_id, p.topic));
    }
  }
  if (first) {
    // a channel that opens with nothing at all looks broken: let the newest Forever item through
    const [hello] = await env.db
      .select()
      .from(newsItems)
      .where(and(eq(newsItems.state, "old"), sql`${newsItems.title} ILIKE '%forever%'`))
      .orderBy(sql`${newsItems.published_at} DESC`)
      .limit(1);
    if (hello) await env.db.update(newsItems).set({ state: "new", told_post: 0, section: await sectionOf(hello.topic_id) }).where(eq(newsItems.topic_id, hello.topic_id));
  }
  return fresh;
}

type Verdict = { topic: number; forever: boolean; news: boolean; summary: string };

/** Everything waiting to be judged, in one question to Gemini; the title rule after 6 h of silence. */
async function judge(env: Env, t: number) {
  const waiting = await env.db.select().from(newsItems).where(eq(newsItems.state, "new")).orderBy(asc(newsItems.published_at));
  if (!waiting.length) return 0;
  const answer = await gemini.ask<{ items: Verdict[] }>(
    env,
    `These are new staff posts from Blizzard's World of Warcraft forums. For each one decide:
- forever: is it about World of Warcraft: Forever (Blizzard's permanent "Classic plus" realms launched in November 2026)?
  A post in a forum section whose name has "WoW: Forever" in it is. Otherwise: not retail (Midnight and its
  patches), not other Classic versions (Classic Era, Burning Crusade, Mists...). Something for all of WoW (an
  account or shop change, a general event) counts only if it clearly applies to Forever.
- news: is it worth telling players about: an announcement, hotfixes, patch or development notes, maintenance,
  an event, a known issue, a change Blizzard is making? A staff reply that only answers someone's question or
  moderates a thread is not news.
- summary: one plain English sentence, at most 140 characters, saying what changes for a Forever player. No hype.

${JSON.stringify(waiting.map((w) => ({ topic: w.topic_id, section: w.section ?? "unknown", title: w.title, text: w.excerpt })))}`,
    {
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
    },
  );
  let n = 0;
  for (const w of waiting) {
    const v = answer?.items.find((x) => x.topic === w.topic_id);
    if (v) {
      const keep = v.forever && v.news;
      await env.db
        .update(newsItems)
        .set({ state: keep ? "post" : "skip", summary: keep ? v.summary.slice(0, 200) : null })
        .where(and(eq(newsItems.topic_id, w.topic_id), eq(newsItems.state, "new")));
      n++;
    } else if (t - w.seen_at >= FALLBACK_AFTER) {
      // Gemini's been no help for hours: decide by the title alone
      await env.db
        .update(newsItems)
        .set({ state: /forever/i.test(w.title) ? "post" : "skip" })
        .where(and(eq(newsItems.topic_id, w.topic_id), eq(newsItems.state, "new")));
      n++;
    }
  }
  return n;
}

export function card(item: typeof newsItems.$inferSelect) {
  return {
    flags: IS_COMPONENTS_V2 | SILENT,
    allowed_mentions: { parse: [] },
    components: [
      {
        type: 17,
        accent_color: 0x148eff,
        components: [
          { type: 10, content: `### [${item.title.replace(/[[\]]/g, "")}](${item.link})${item.summary ? `\n${item.summary}` : ""}\n-# Blizzard · <t:${item.published_at}:R>` },
        ],
      },
    ],
  };
}

/** Post what's due, oldest first, within today's 5; then "updated" lines for topics Blizzard added to. */
async function post(env: Env, t: number) {
  const l = local(env, new Date(t * 1000));
  const dayStart = wallToUnix(env, l.y, l.m, l.d, 0, 0);
  const [{ n }] = await env.db
    .select({ n: sql<number>`count(*)::int` })
    .from(newsItems)
    .where(sql`${newsItems.posted_at} >= ${dayStart} OR ${newsItems.updated_day} = ${l.day}`);
  let left = DAILY_POSTS - n;
  const done: string[] = [];
  const due = await env.db.select().from(newsItems).where(eq(newsItems.state, "post")).orderBy(asc(newsItems.published_at));
  for (const item of due) {
    if (left <= 0) break;
    const [claim] = await env.db
      .update(newsItems)
      .set({ state: "posted", message_id: "posting", posted_at: t, told_post: item.last_post })
      .where(and(eq(newsItems.topic_id, item.topic_id), eq(newsItems.state, "post")))
      .returning();
    if (!claim) continue;
    try {
      const msg = await api(env, "POST", `/channels/${env.NEWS_CHANNEL_ID}/messages`, card(claim));
      await env.db.update(newsItems).set({ message_id: msg.id }).where(eq(newsItems.topic_id, item.topic_id));
      done.push(item.title);
      left--;
    } catch (e) {
      // give it back: next check tries again
      await env.db.update(newsItems).set({ state: "post", message_id: null, posted_at: null, told_post: 0 }).where(eq(newsItems.topic_id, item.topic_id));
      throw e;
    }
  }
  const grown = await env.db
    .select()
    .from(newsItems)
    .where(and(eq(newsItems.state, "posted"), sql`${newsItems.last_post} > ${newsItems.told_post}`, sql`${newsItems.updated_day} IS DISTINCT FROM ${l.day}`));
  for (const item of grown) {
    if (left <= 0) break;
    const [claim] = await env.db
      .update(newsItems)
      .set({ told_post: item.last_post, updated_day: l.day })
      .where(and(eq(newsItems.topic_id, item.topic_id), sql`${newsItems.updated_day} IS DISTINCT FROM ${l.day}`))
      .returning();
    if (!claim) continue;
    const link = item.link.replace(/\/\d+$/, `/${item.last_post}`);
    // a missed "updated" line isn't worth a retry: tomorrow's update says it anyway
    const sent = await api(env, "POST", `/channels/${env.NEWS_CHANNEL_ID}/messages`, {
      content: `🔧 **${item.title}** got an update → <${link}>`,
      flags: SILENT,
      allowed_mentions: { parse: [] },
    }).catch((e) => console.log("news update line failed", item.topic_id, String(e)));
    if (!sent) continue;
    done.push(`updated: ${item.title}`);
    left--;
  }
  return done;
}

/** Tests only. */
export function _reset() {
  running = false;
}
export const _running = () => running;
