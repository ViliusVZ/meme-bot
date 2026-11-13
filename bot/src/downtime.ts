// 🛠️ WoW Forever downtime alerts: when the EU servers go down (planned maintenance, restarts, a crash),
// a card in the news channel within a minute or two, edited as it changes, never a second card for
// the same downtime. No writer, no filter, no daily cap. Every minute, in the background, on the leader:
//   1. Blizzard's launcher notice (the Battle.net app's breaking-news feed): any text is an alert; its
//      start and end are read from it when they can be (`noticeWindow`);
//   2. players on the EU Forever forum, every 2 minutes (backing off when it won't answer): 3 threads
//      about the servers being down within 15 minutes is a burst (`burstOf`); the busiest one's
//      opening post may quote the in-game notice;
//   3. Blizzard's own forum posts about maintenance (news.ts keeps them out of the news, here they're
//      read like the launcher's notice);
//   4. Blizzard's realm status page, every 2 minutes: a realm offline makes or confirms a downtime,
//      all of them back online ends it.
// One row per downtime (`downtimes`), claimed by its key before the card goes out. A planned one gets
// a reminder an hour before, replying to the card, when the card went out well before that. When the
// card or the reminder goes out and any of us is in voice, the bot says one line there (botvoice.ts,
// under its 🔇 toggle). Unlike the rest of the news, the new card and the reminder are not silent and
// mention the three of us (once each per downtime; edits notify nobody). No news channel configured:
// none of this runs.
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { Cause, Context, DateTime, Duration, Effect, Layer, Option, Ref, Schema, Semaphore } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { downtimes, newsStories, settings } from "./db/schema.js";
import { Db, type DbError } from "./db/db.js";
import { AppConfig, players } from "./config.js";
import { Discord, IS_COMPONENTS_V2 } from "./discord.js";
import { Background } from "./background.js";
import { Presence } from "./presence.js";
import { BotVoice } from "./botvoice.js";
import { nowSec } from "./clock.js";
import { jsonText } from "./json.js";
import { plain } from "./newsfeeds.js";
import { clean } from "./newscard.js";
import { DOWNTIME } from "./lines.js";

export const LAUNCHER = "https://breaking-news.support.blizzard.com/service/wow-forever/live/eu/en-gb";
export const FORUM = "https://eu.forums.blizzard.com/en/wow";
export const FORUM_LATEST = `${FORUM}/c/wow-forever/359/l/latest.json`;
export const REALMS = "https://worldofwarcraft.blizzard.com/en-gb/graphql";
export const STATUS_PAGE = "https://worldofwarcraft.blizzard.com/en-gb/game/status/eu";
const REALMS_QUERY = {
  variables: { input: { compoundRegionGameVersionSlug: "forever-eu" } },
  extensions: { persistedQuery: { version: 1, sha256Hash: "e890f42a5375f136b9f9165408fb2bc372cc5f88be0b21e7dc681a70d9999c67" } },
};
const UA = "DiscordBot (https://github.com/ViliusVZ/meme-bot, 3.0)";
const TIMEOUT = Duration.seconds(15);
const FORUM_EVERY = 120; // s: the forum's listing at most this often…
const FORUM_MAX_WAIT = 30 * 60; // …backing off (doubling) up to this while it won't answer
const REALMS_EVERY = 120;
const REALMS_BROKEN_WAIT = 30 * 60; // the status page's query stopped working: try again this much later
export const BURST = 3; // players' threads about the servers…
export const BURST_WINDOW = 15 * 60; // …created within this long of each other
const BURST_FRESH = 60 * 60; // a burst counts while its last thread is at most this old
const QUIET = 60 * 60; // a downtime only players reported is over this long after the last burst
const OVER_AFTER_END = 15 * 60; // a downtime is over this long after the end Blizzard gave (the launcher keeps its notice up for hours), unless a realm still shows offline
const STALE_NOTICE = 30 * 60; // a notice whose end is longer ago than this is no news
const UNTIMED_LIFE = 6 * 3600; // a forum post with no times: over after this long
const REMIND_BEFORE = 60 * 60; // the reminder, this long before a planned start…
const REMIND_IF_POSTED = 75 * 60; // …when the card went out at least this long before it
const RECENT = 14 * 86400; // downtimes looked at when matching a notice
const REPLAY = "downtime_replay"; // the test bot's stand-ins for the sources (POST /admin/news {"downtime": …})
const OPEN_ACCENT = 0xe67e22;
const BACK_ACCENT = 0x2ecc71;

// ---------------------------------------------------------------- the rules (plain text and arithmetic)

/** A Blizzard staff post's title that's a downtime notice, not news (news.ts keeps it from the writer). */
export const DOWNTIME_TITLE = /\b(maintenance|realm restarts?|rolling restarts?|emergency restarts?|downtime)\b/i;

/** A player's thread title about the servers being down. */
export const BURST_TITLE =
  /\b(maint(enance)?|restarts?|servers?\s+(?:(?:is|are|went|go(?:ing)?)\s+)?(?:down|offline|crash(?:ed|ing|es)?)|disconnect(?:ed|s)?|can[’']?t\s+log\s*-?in|cannot\s+log\s*-?in|log\s*-?in\s+issues?|downtime)\b/i;

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH = "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
/** Minutes east of UTC. */
const ZONES: Record<string, number> = { CET: 60, CEST: 120, GMT: 0, UTC: 0, BST: 60, WET: 0, WEST: 60, EET: 120, EEST: 180, PST: -480, PDT: -420, EST: -300, EDT: -240 };
const ZONE = `(${Object.keys(ZONES).join("|")})`;
const monthOf = (name: string) => MONTHS.findIndex((m) => m.startsWith(name.toLowerCase().slice(0, 3)));

/** A downtime's window as a notice gives it (unix s): its start, and its end when it says. */
export type Window = { readonly start: number; readonly end: number | null };

/**
 * The start and end a notice gives ("beginning on Friday, 13 November, 20:00 (CET) … at
 * approximately 21:00 (CET)", or "November 13th, 11:00 AM (PST)"): each time with the date written
 * before it (the start's, for an end without its own), in the time zone it names (one zone named
 * anywhere counts for both), in the year around `now` (a December notice read in January is last
 * year's, a January one read in December next year's). Null: no time with a zone in it.
 */
export function noticeWindow(text: string, now: number): Window | null {
  const dates = [...text.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}\\b|\\b${MONTH}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?!:)`, "gi"))].map((m) => ({
    at: m.index,
    month: monthOf(m[2] ?? m[3]),
    day: Number(m[1] ?? m[4]),
  }));
  const times = [...text.matchAll(new RegExp(`\\b(\\d{1,2})(?:([:.])(\\d{2}))?\\s*(a\\.?m\\.?|p\\.?m\\.?)?(?:\\s*\\(?\\s*${ZONE}\\b\\s*\\)?)?`, "gi"))]
    .map((m) => ({ at: m.index, h: Number(m[1]), sep: m[2], min: m[3] === undefined ? 0 : Number(m[3]), ampm: m[4]?.toLowerCase().replace(/\./g, ""), zone: m[5]?.toUpperCase() }))
    // a time is HH:MM, or a 12-hour time with am/pm; HH.MM only with a zone or am/pm after it
    .filter((x) => (x.sep === ":" || x.ampm || (x.sep === "." && x.zone)) && x.h <= (x.ampm ? 12 : 23) && x.min <= 59);
  if (!times.length) return null;
  const zone = times.find((x) => x.zone)?.zone;
  if (zone === undefined) return null;
  const today = DateTime.toPartsUtc(DateTime.makeUnsafe(now * 1000 + ZONES[zone] * 60_000));
  const at = (i: number) => {
    const x = times[i];
    const h = x.ampm ? (x.h % 12) + (x.ampm === "pm" ? 12 : 0) : x.h;
    const off = ZONES[x.zone ?? zone];
    const d = [...dates].reverse().find((y) => y.at < x.at) ?? (i === 0 ? dates[0] : undefined);
    const own = d !== undefined && (i === 0 || d.at > times[0].at);
    const month = d?.month ?? today.month - 1;
    const day = d?.day ?? today.day;
    let year = today.year;
    const unix = (y: number) => Math.floor((Date.UTC(y, month, day, h, x.min) - off * 60_000) / 1000);
    if (unix(year) < now - 200 * 86400) year++;
    else if (unix(year) > now + 165 * 86400) year--;
    return { unix: unix(year), own };
  };
  const start = at(0).unix;
  if (times.length < 2) return { start, end: null };
  const e = at(1);
  // an end without a date of its own that reads before the start is the next day's
  const end = !e.own && e.unix <= start ? e.unix + 86400 : e.unix;
  return { start, end: end > start ? end : null };
}

/** One topic of the forum's listing (Discourse's latest.json). */
export type ForumTopic = { readonly id: number; readonly title: string; readonly created_at: number; readonly posts_count: number; readonly slug: string; readonly text?: string };

/** A burst: the players' threads about the servers that make it, and the busiest of them. */
export type Burst = { readonly first: number; readonly last: number; readonly count: number; readonly topics: ReadonlyArray<ForumTopic>; readonly busiest: ForumTopic };

/**
 * Players reporting the servers down: at least BURST threads with such a title created within
 * BURST_WINDOW of each other, the last of them at most BURST_FRESH before `now`. The latest such
 * run of threads; null when there's none.
 */
export function burstOf(topics: ReadonlyArray<ForumTopic>, now: number): Burst | null {
  const hits = topics.filter((x) => BURST_TITLE.test(x.title) && x.created_at <= now + 60).sort((a, b) => a.created_at - b.created_at || a.id - b.id);
  for (let j = hits.length - 1; j >= BURST - 1; j--) {
    if (now - hits[j].created_at > BURST_FRESH) break;
    const run = hits.filter((x) => x.created_at <= hits[j].created_at && hits[j].created_at - x.created_at <= BURST_WINDOW);
    if (run.length < BURST) continue;
    const busiest = [...run].sort((a, b) => b.posts_count - a.posts_count || a.created_at - b.created_at)[0];
    return { first: run[0].created_at, last: run[run.length - 1].created_at, count: run.length, topics: run, busiest };
  }
  return null;
}

/**
 * The in-game notice as a player quotes it ("…we need to fix with restarts. All realms will come
 * down in 30 minutes and be back quickly"): the sentence saying the realms or servers will come down
 * or restart, with the one before it when that one gives the reason. Null: none.
 */
export function quotedNotice(text: string): string | null {
  const sentences = text.replace(/\s+/g, " ").split(/(?<=[.!?:])\s+|["“”]/).map((s) => s.trim()).filter(Boolean);
  const i = sentences.findIndex((s) => /\b(?:realms?|servers?)\b[^.!?]{0,40}\bwill\s+(?:(?:be\s+)?(?:come|go|coming|going|brought|taken)\s+(?:down|offline)|(?:be\s+)?restart(?:ed|ing)?)\b/i.test(s));
  if (i < 0) return null;
  const before = i > 0 && /\b(restart|crash|maintenance|fix)/i.test(sentences[i - 1]) ? `${sentences[i - 1]} ` : "";
  return clean(`${before}${sentences[i]}`, 300) || null;
}

/** How long, written out ("1 hour", "1 hour 30 minutes", "45 minutes"). */
export function lasting(sec: number): string {
  const m = Math.max(1, Math.round(sec / 60));
  const h = Math.floor(m / 60);
  const mins = m % 60;
  const hours = h ? `${h} hour${h === 1 ? "" : "s"}` : "";
  return [hours, mins ? `${mins} minute${mins === 1 ? "" : "s"}` : ""].filter(Boolean).join(" ");
}

/** How long until, as said aloud ("30 minutes", "1 hour", "1 and a half hours"). */
export function spokenIn(sec: number): string {
  const m = Math.max(1, Math.round(sec / 60));
  if (m < 60) {
    const r = m > 10 ? Math.round(m / 5) * 5 : m;
    return `${r} minute${r === 1 ? "" : "s"}`;
  }
  const half = Math.round(m / 30) / 2;
  const whole = Math.floor(half);
  if (half !== whole) return `${whole} and a half hours`;
  return `${whole} hour${whole === 1 ? "" : "s"}`;
}

type Row = typeof downtimes.$inferSelect;
/** What a card is made from. */
export type Incident = Pick<Row, "source" | "state" | "closed_by" | "notice" | "link" | "thread" | "reports" | "quote" | "realms" | "realms_down" | "start_at" | "end_at" | "back_at" | "last_seen">;

const kindOf = (i: Incident) => (i.notice !== null ? "notice" : i.realms !== null ? "realms" : "players");

/** The card's text at `now`: plain and factual, Discord timestamps (each of us sees their own time). */
export function downtimeText(i: Incident, now: number): string {
  const status = `[server status](${STATUS_PAGE})`;
  const S = i.start_at;
  const E = i.end_at;
  const back = i.state === "back";
  const lines: string[] = [];
  const kind = kindOf(i);
  const thread = i.thread ? `[players' thread](${i.thread})` : null;
  if (kind === "notice") {
    const guessed = back && i.closed_by === "time" && S !== null && E !== null; // over by Blizzard's own estimate, nothing said it
    lines.push(guessed ? "### ✅ WoW Forever: servers should be back" : back ? "### ✅ WoW Forever: servers are back" : i.state === "cancelled" ? "### 🛠️ WoW Forever: maintenance notice taken down" : "### 🛠️ WoW Forever: servers down for maintenance");
    if (guessed) lines.push(`**Down** <t:${S}:t>–about <t:${E}:t> (Blizzard's estimate)`);
    else if (back) lines.push(S !== null && i.back_at !== null ? `**Down** <t:${S}:t>–<t:${i.back_at}:t>` : i.back_at !== null ? `**Back** since <t:${i.back_at}:t>` : "**Back** up");
    else if (i.state === "cancelled") lines.push("Blizzard took the notice down before it started.");
    else if (S !== null && S <= now) lines.push(`**Down now**, since <t:${S}:t>${E !== null ? `, back about <t:${E}:R>` : ""}`);
    else if (S !== null) lines.push(`**When** <t:${S}:F> (<t:${S}:R>)${E !== null ? ` until about <t:${E}:t>, roughly ${lasting(E - S)}` : ""}`);
    lines.push(`**Blizzard says** "${clean(i.notice!, 500)}"`);
    if (i.realms_down && i.realms) lines.push(`**Server status** ${clean(i.realms, 200)} offline`);
    if (i.quote) lines.push(`**Players quote the in-game notice** "${i.quote}"`);
    const where = i.source === "blizzard" && i.link ? `[Blizzard's forum post](${i.link})` : "Blizzard's launcher notice";
    lines.push(`-# ${[where, thread, status].filter(Boolean).join(" · ")}`);
  } else if (kind === "realms") {
    lines.push(back ? "### ✅ WoW Forever: realms are back online" : "### ⚠️ WoW Forever: realms offline");
    lines.push(back && S !== null && i.back_at !== null ? `**Down** <t:${S}:t>–<t:${i.back_at}:t>` : `**Offline** ${clean(i.realms!, 200)}${S !== null ? `, since <t:${S}:t>` : ""}`);
    if (!back) lines.push("Blizzard's server status page shows it; no maintenance notice from Blizzard.");
    if (i.quote) lines.push(`**Players quote the in-game notice** "${i.quote}"`);
    lines.push(`-# ${["Blizzard's server status", thread, status].filter(Boolean).join(" · ")}`);
  } else {
    lines.push(back ? "### ✅ WoW Forever: player reports have stopped" : "### ⚠️ WoW Forever: players report the servers going down");
    const n = i.reports ?? BURST;
    lines.push(
      back
        ? `Players reported trouble from <t:${S ?? i.last_seen}:t>; nothing new for an hour.`
        : `From player reports, not from Blizzard: ${n} threads on the EU forum since <t:${S ?? i.last_seen}:t>.`,
    );
    if (i.quote) lines.push(`**Players quote the in-game notice** "${i.quote}"`);
    lines.push(`-# ${[thread, status].filter(Boolean).join(" · ")}`);
  }
  return lines.join("\n");
}

/**
 * The card: components v2, NOT silent (the owner: "alerts of maintenance should not be a silent
 * message"), the three of us mentioned in its last line so the new card reaches us; nobody else can
 * be pinged. An edit sends the same text and notifies nobody.
 */
export function downtimeCard(i: Incident, now: number, trio: ReadonlyArray<string>) {
  const ping = trio.map((p) => `<@${p}>`).join(" ");
  return {
    flags: IS_COMPONENTS_V2,
    allowed_mentions: { parse: [] as string[], users: [...trio] },
    components: [{ type: 17, accent_color: i.state === "open" ? OPEN_ACCENT : BACK_ACCENT, components: [{ type: 10, content: ping ? `${downtimeText(i, now)}\n${ping}` : downtimeText(i, now) }] }],
  };
}

/** The reminder's text, replying to the card (the three of us mentioned: it pings, once). */
export const reminderText = (start: number, end: number | null, trio: ReadonlyArray<string> = []) =>
  `⏰ WoW Forever goes down <t:${start}:R> (<t:${start}:t>)${end !== null ? ` for about ${lasting(end - start)}` : ""}.${trio.length ? ` ${trio.map((p) => `<@${p}>`).join(" ")}` : ""}`;

/** The line said aloud when the card goes out (null: none). */
export function spokenFor(i: Incident, now: number): string {
  const kind = kindOf(i);
  if (kind === "players") return DOWNTIME.players;
  if (kind === "realms") return DOWNTIME.realms;
  if (i.start_at === null) return DOWNTIME.later;
  if (i.start_at <= now) return DOWNTIME.now;
  if (i.start_at - now <= 2 * 3600) return DOWNTIME.soon.replace("{when}", spokenIn(i.start_at - now));
  return DOWNTIME.later;
}

// ---------------------------------------------------------------- the service

/** The test bot's stand-ins for the sources (each one given replaces that source). */
const ReplayTopic = Schema.Struct({
  id: Schema.Number,
  title: Schema.String,
  created_at: Schema.optional(Schema.String),
  minutes_ago: Schema.optional(Schema.Number),
  slug: Schema.optional(Schema.String),
  posts_count: Schema.optional(Schema.Number),
  text: Schema.optional(Schema.String), // the opening post (else it's fetched)
});
export const ReplayInput = Schema.Struct({
  notice: Schema.optional(Schema.String),
  topics: Schema.optional(Schema.Array(ReplayTopic)),
  realms: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String, online: Schema.Boolean }))),
  live: Schema.optional(Schema.Boolean), // true: forget the stand-ins, back to the real sources
});
export type ReplayInput = typeof ReplayInput.Type;
const StoredTopic = Schema.Struct({ id: Schema.Number, title: Schema.String, created_at: Schema.Number, posts_count: Schema.Number, slug: Schema.String, text: Schema.optional(Schema.String) });
const Replay = Schema.Struct({
  notice: Schema.optional(Schema.String),
  topics: Schema.optional(Schema.Array(StoredTopic)),
  realms: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String, online: Schema.Boolean }))),
});
type Replay = typeof Replay.Type;

const Latest = Schema.Struct({
  topic_list: Schema.Struct({
    topics: Schema.Array(Schema.Struct({ id: Schema.Number, title: Schema.String, created_at: Schema.String, posts_count: Schema.optional(Schema.Number), slug: Schema.optional(Schema.String) })),
  }),
});
const TopicJson = Schema.Struct({ post_stream: Schema.Struct({ posts: Schema.Array(Schema.Struct({ cooked: Schema.String })) }) });
const RealmsJson = Schema.Struct({ data: Schema.Struct({ Realms: Schema.Array(Schema.Struct({ name: Schema.String, online: Schema.Boolean })) }) });

/** What one poll did (absent keys: nothing of that kind). */
export type PollResult = {
  notice?: string | null; // the launcher's notice ("" none; absent: no answer)
  burst?: number; // players' threads in a burst
  offline?: ReadonlyArray<string>; // realms the status page shows offline
  posted?: string[];
  edited?: string[];
  reminded?: string[];
  spoken?: string[];
};

const topicLink = (x: Pick<ForumTopic, "id" | "slug">) => `${FORUM}/t/${x.slug || "topic"}/${x.id}`;
const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);

export class Downtime extends Context.Service<
  Downtime,
  {
    /** Minute job: a poll in the background (one at a time). No channel configured: nothing. */
    readonly check: Effect.Effect<{ checking?: boolean }>;
    /** One poll now; `force`: every source, whenever it was last asked. */
    poll(options?: { readonly at?: number; readonly force?: boolean }): Effect.Effect<PollResult, DbError>;
    /** POST /admin/news {"downtime": …} on the test bot: the sources' stand-ins, then a poll (null: not here). */
    replay(input: ReplayInput): Effect.Effect<PollResult | null, DbError>;
  }
>()("meme-bot/downtime") {
  static readonly layer = Layer.effect(
    Downtime,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const db = yield* Db;
      const http = yield* HttpClient.HttpClient;
      const discord = yield* Discord;
      const background = yield* Background;
      const presence = yield* Presence;
      const botVoice = yield* BotVoice;
      const channel = config.newsChannelId;
      const trio = Effect.provideService(players, AppConfig, config);
      const turn = yield* Semaphore.make(1);
      const busy = yield* Ref.make(false);
      // when each slower source may be asked next, and how long the forum's wait is now (a restart asks again at once: harmless)
      const forumNext = yield* Ref.make(0);
      const forumWait = yield* Ref.make(FORUM_EVERY);
      const realmsNext = yield* Ref.make(0);
      const realmsBroken = yield* Ref.make(false);
      const quoted = yield* Ref.make<ReadonlySet<number>>(new Set()); // threads whose opening post was read for a quote

      const decoded = <A>(schema: Schema.Decoder<A>, value: unknown) => Option.getOrUndefined(Schema.decodeUnknownOption(schema)(value));
      const request = (req: HttpClientRequest.HttpClientRequest) => http.execute(req.pipe(HttpClientRequest.setHeaders({ "User-Agent": UA }))).pipe(Effect.timeout(TIMEOUT));
      /** A source's answer, or null (logged) when it won't come. */
      const orNull = <A, E>(what: string, effect: Effect.Effect<A | null, E>) =>
        effect.pipe(Effect.catch((e) => Effect.as(Effect.logInfo(`downtime: ${what} failed ${e instanceof Error ? e.message : String(e)}`), null)));

      /** The launcher's notice: "" none, null no answer. */
      const launcher = orNull(
        "the launcher's notice",
        Effect.gen(function* () {
          const res = yield* request(HttpClientRequest.get(LAUNCHER));
          if (res.status !== 200) return yield* Effect.as(Effect.logInfo(`downtime: the launcher's notice answered ${res.status}`), null);
          return plain(yield* res.text);
        }),
      );

      const forumListing = orNull(
        "the forum's listing",
        Effect.gen(function* () {
          const res = yield* request(HttpClientRequest.get(FORUM_LATEST));
          if (res.status !== 200) return yield* Effect.as(Effect.logInfo(`downtime: the forum's listing answered ${res.status}`), null);
          const body = decoded(Latest, yield* res.json);
          if (!body) return yield* Effect.as(Effect.logInfo("downtime: the forum's listing wasn't the listing"), null);
          return body.topic_list.topics.map((x): ForumTopic => ({ id: x.id, title: x.title, created_at: unix(x.created_at), posts_count: x.posts_count ?? 1, slug: x.slug ?? "" }));
        }),
      );

      const openingPost = (x: ForumTopic) =>
        x.text !== undefined
          ? Effect.succeed<string | null>(x.text)
          : orNull(
              `the thread ${x.id}`,
              Effect.gen(function* () {
                const res = yield* request(HttpClientRequest.get(`${FORUM}/t/${x.id}.json`));
                if (res.status !== 200) return null;
                const body = decoded(TopicJson, yield* res.json);
                // a quote block ends where the player's own words start again
                return body?.post_stream.posts[0] ? plain(body.post_stream.posts[0].cooked.replace(/<\/?(?:blockquote|aside)(?:\s[^>]*)?>/gi, ' " ')) : null;
              }),
            );

      /** The realms the status page shows offline (null: no answer; the query stopped working is said once). */
      const realmStatus = Effect.gen(function* () {
        const got = yield* Effect.gen(function* () {
          const res = yield* request(HttpClientRequest.post(REALMS).pipe(HttpClientRequest.bodyText(jsonText(REALMS_QUERY), "application/json")));
          return res.status === 200 ? (decoded(RealmsJson, yield* res.json) ?? null) : null;
        }).pipe(Effect.catch(() => Effect.succeed(null)));
        if (!got || !got.data.Realms.length) {
          if (!(yield* Ref.getAndSet(realmsBroken, true))) yield* Effect.logInfo("downtime: the realm status page's query isn't answering; carrying on without it");
          return null;
        }
        if (yield* Ref.getAndSet(realmsBroken, false)) yield* Effect.logInfo("downtime: the realm status page answers again");
        return got.data.Realms;
      });

      const readReplay = Effect.map(db.select().from(settings).where(eq(settings.key, REPLAY)), ([row]) => (row ? decoded(Replay, row.value) : undefined));

      // ---------------------------------------------------------------- the downtimes

      const recent = (t: number) => db.select().from(downtimes).where(gte(downtimes.created_at, t - RECENT)).orderBy(desc(downtimes.created_at), desc(downtimes.key));
      const set = (key: string, change: Partial<typeof downtimes.$inferInsert>) => db.update(downtimes).set(change).where(eq(downtimes.key, key));
      /** A new downtime; false when its key is taken (another copy, or before a restart). */
      const create = (row: typeof downtimes.$inferInsert) => Effect.map(db.insert(downtimes).values(row).onConflictDoNothing().returning({ key: downtimes.key }), (r) => r.length > 0);
      /** A downtime's own span for matching: its window, or (no end) from its start to an hour after it was last seen. */
      const spanOf = (i: Row) => ({ start: i.start_at ?? i.created_at, end: i.end_at ?? Math.max(i.last_seen, i.back_at ?? 0) + 3600 });
      const overlaps = (i: Row, w: Window) => {
        const a = spanOf(i);
        return a.start <= (w.end ?? w.start + 3600) && w.start <= a.end;
      };
      /** A downtime going on now, or starting within two hours (a planned one next week takes no reports of tonight's trouble). */
      const current = (i: Row, t: number) => i.state === "open" && (i.start_at === null || i.start_at <= t + 2 * 3600);
      const textKey = (text: string) => {
        let x = 0;
        for (const c of text) x = (Math.imul(x, 31) + c.charCodeAt(0)) | 0;
        return (x >>> 0).toString(36);
      };

      /**
       * Blizzard's notice (the launcher's, or its forum post's title and text): the downtime it's
       * about (the same text, a window that overlaps, or the one going on when it gives no times),
       * updated; or a new one. The launcher's word is final on the times; a forum post only fills in
       * what's missing.
       */
      const noticeSeen = Effect.fn("Downtime.notice")(function* (text: string, source: "launcher" | "blizzard", t: number, link: string | null) {
        const w = noticeWindow(text, t);
        const rows = yield* recent(t);
        const match =
          rows.find((i) => i.notice === text) ??
          (w ? rows.find((i) => overlaps(i, w)) : rows.find((i) => current(i, t)));
        if (w && (w.end ?? w.start + 3600) < t - STALE_NOTICE && !match) return; // long over: no news
        if (!match) {
          yield* create({
            key: `notice:${w ? w.start : textKey(text)}`, source, state: "open", notice: text, link, start_at: w?.start ?? null, end_at: w?.end ?? null, created_at: t, last_seen: t,
          });
          return;
        }
        // the notice back after it went, or a new text with a later end after the old end passed (extended): open again;
        // the same text still up after its end changes nothing
        const extended = match.closed_by === "time" && w?.end != null && match.end_at !== null && w.end > match.end_at && t <= w.end + OVER_AFTER_END;
        const reopen = match.state !== "open" && source === "launcher" && ((match.closed_by === "notice" && (match.end_at === null || t < match.end_at)) || extended);
        const launcherWins = source === "launcher";
        yield* set(match.key, {
          last_seen: t,
          ...(launcherWins || match.notice === null ? { notice: text } : {}),
          ...(launcherWins ? { source: "launcher" as const } : match.source === "forum" || match.source === "realms" ? { source, link } : {}),
          ...(w && (launcherWins || match.start_at === null || match.source === "forum" || match.source === "realms") ? { start_at: w.start, end_at: w.end } : {}),
          ...(reopen ? { state: "open" as const, closed_by: null, back_at: null } : {}),
        });
      });

      /** The launcher shows no notice: its downtime is over (or, before it started, called off). */
      const noticeGone = Effect.fn("Downtime.noticeGone")(function* (t: number) {
        for (const i of yield* recent(t)) {
          if (i.state !== "open" || i.source !== "launcher") continue;
          const started = i.start_at === null || t >= i.start_at;
          yield* set(i.key, started ? { state: "back", closed_by: "notice", back_at: t } : { state: "cancelled", closed_by: "notice" });
        }
      });

      const realmsSeen = Effect.fn("Downtime.realms")(function* (realms: ReadonlyArray<{ name: string; online: boolean }>, t: number) {
        const offline = realms.filter((r) => !r.online).map((r) => r.name);
        const rows = yield* recent(t);
        if (offline.length) {
          const names = offline.join(", ");
          const i = rows.find((x) => current(x, t));
          if (i) {
            yield* set(i.key, { realms: names, realms_down: true, last_seen: t, ...(i.start_at === null || i.start_at > t ? { start_at: t } : {}) });
          } else yield* create({ key: `realms:${t - (t % 600)}`, source: "realms", state: "open", realms: names, realms_down: true, start_at: t, created_at: t, last_seen: t });
        } else {
          // every realm back online: what they were down for is over
          for (const i of rows) if (i.state === "open" && i.realms_down) yield* set(i.key, { realms_down: false, state: "back", closed_by: "realms", back_at: t });
        }
        return offline;
      });

      const burstSeen = Effect.fn("Downtime.burst")(function* (b: Burst, t: number) {
        const rows = yield* recent(t);
        const open = rows.find((i) => current(i, t));
        // a burst within an hour after a downtime ended is its aftermath, not a new one
        const after = rows.find((i) => i.state === "back" && b.first <= (i.back_at ?? i.end_at ?? i.last_seen) + 3600);
        if (!open && after) return;
        const link = topicLink(b.busiest);
        const quote = (open ?? rows.find((i) => i.key === `forum:${b.topics[0].id}`))?.quote ?? (yield* quoteFrom(b));
        if (open) {
          yield* set(open.key, {
            thread: open.thread ?? link,
            reports: Math.max(open.reports ?? 0, b.count),
            ...(quote && !open.quote ? { quote } : {}),
            ...(open.source === "forum" ? { last_seen: t } : {}),
          });
          return;
        }
        yield* create({ key: `forum:${b.topics[0].id}`, source: "forum", state: "open", thread: link, reports: b.count, quote, start_at: b.first, created_at: t, last_seen: t });
      });

      /** The in-game notice quoted in the burst's busiest thread (its opening post read once at most). */
      const quoteFrom = Effect.fnUntraced(function* (b: Burst) {
        const done = yield* Ref.get(quoted);
        const next = b.busiest; // one request: the busiest thread's opening post, once
        if (done.has(next.id)) return null;
        yield* Ref.update(quoted, (s) => new Set([...s, next.id]));
        const text = yield* openingPost(next);
        return text ? quotedNotice(text) : null;
      });

      /** What time alone ends: a notice that went quiet after its end, Blizzard's post with no times, players who stopped reporting. */
      const closeByTime = Effect.fn("Downtime.closeByTime")(function* (t: number) {
        for (const i of yield* recent(t)) {
          if (i.state !== "open" || i.realms_down) continue;
          if (i.end_at !== null && t > i.end_at + OVER_AFTER_END) yield* set(i.key, { state: "back", closed_by: "time", back_at: i.end_at });
          else if (i.end_at === null && i.source === "blizzard" && t - i.created_at > UNTIMED_LIFE) yield* set(i.key, { state: "back", closed_by: "time", back_at: t });
          else if (i.source === "forum" && t - i.last_seen > QUIET) yield* set(i.key, { state: "back", closed_by: "quiet", back_at: i.last_seen });
        }
      });

      // ---------------------------------------------------------------- the card, the reminder, the voice

      /** Who of us is in voice, and where most of us are (null: nobody, or we can't see). */
      const ourChannel = Effect.gen(function* () {
        if (!(yield* presence.isReady)) return null;
        const counts = new Map<string, number>();
        for (const p of yield* trio) {
          const ch = yield* presence.lastKnown(p);
          if (ch) counts.set(ch, (counts.get(ch) ?? 0) + 1);
        }
        return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      });

      /** One line aloud where we are, through the bot's voice (its 🔇 toggle decides). */
      const speak = (line: string, what: string) =>
        Effect.gen(function* () {
          const ch = yield* ourChannel;
          if (!ch) return false;
          return yield* botVoice.say(ch, [{ _tag: "Line", line }], what);
        }).pipe(Effect.catch((e) => Effect.as(Effect.logWarning(`downtime: not said ${String(e)}`), false)));

      /** Each downtime's card: posted once (claimed), edited when its text changes; the reminder once. */
      const publish = Effect.fn("Downtime.publish")(function* (ch: string, t: number, out: PollResult) {
        const us = yield* trio;
        for (const i of yield* recent(t)) {
          const text = downtimeText(i, t);
          if (i.message_id === null) {
            if (i.state !== "open") continue; // over before its card could go out
            // claim → post → its id, never cut short; a refused post gives the claim back (tried again next minute)
            const id = yield* Effect.uninterruptible(
              Effect.gen(function* () {
                const [claim] = yield* db.update(downtimes).set({ message_id: "posting" }).where(and(eq(downtimes.key, i.key), isNull(downtimes.message_id))).returning({ key: downtimes.key });
                if (!claim) return null;
                const msg = yield* discord.createMessage(ch, downtimeCard(i, t, us)).pipe(Effect.tapError(() => set(i.key, { message_id: null })));
                yield* set(i.key, { message_id: msg.id, posted_at: t, rendered: text });
                return msg.id;
              }),
            ).pipe(Effect.catch((e) => Effect.as(Effect.logInfo(`downtime: the card for ${i.key} wasn't posted ${e.message}`), null)));
            if (id === null) continue;
            (out.posted ??= []).push(i.key);
            yield* Effect.logInfo(`downtime: posted ${i.key} ${id}`);
            if (yield* speak(spokenFor(i, t), `downtime ${i.key}`)) (out.spoken ??= []).push(i.key);
            continue;
          }
          if (i.message_id === "posting") continue;
          if (i.rendered !== text) {
            const done = yield* discord.editMessage(ch, i.message_id, { flags: IS_COMPONENTS_V2, allowed_mentions: { parse: [] }, components: downtimeCard(i, t, us).components }).pipe(
              Effect.as(true),
              // a card someone deleted stays deleted; anything else is tried again next minute
              Effect.catchTag("DiscordNotFound", () => Effect.as(Effect.logInfo(`downtime: the card for ${i.key} is gone`), true)),
              Effect.catch((e) => Effect.as(Effect.logInfo(`downtime: the card for ${i.key} wasn't edited ${e.message}`), false)),
            );
            if (done) {
              yield* set(i.key, { rendered: text });
              (out.edited ??= []).push(i.key);
            }
          }
          const S = i.start_at;
          if (i.state === "open" && S !== null && i.reminder_id === null && i.posted_at !== null && S - i.posted_at >= REMIND_IF_POSTED && t >= S - REMIND_BEFORE && t < S) {
            const card = i.message_id;
            const id = yield* Effect.uninterruptible(
              Effect.gen(function* () {
                const [claim] = yield* db.update(downtimes).set({ reminder_id: "posting" }).where(and(eq(downtimes.key, i.key), isNull(downtimes.reminder_id))).returning({ key: downtimes.key });
                if (!claim) return null;
                const msg = yield* discord
                  .createMessage(ch, { content: reminderText(S, i.end_at, us), allowed_mentions: { parse: [], users: [...us] }, message_reference: { message_id: card, fail_if_not_exists: false } })
                  .pipe(Effect.tapError(() => set(i.key, { reminder_id: null })));
                yield* set(i.key, { reminder_id: msg.id });
                return msg.id;
              }),
            ).pipe(Effect.catch((e) => Effect.as(Effect.logInfo(`downtime: the reminder for ${i.key} wasn't posted ${e.message}`), null)));
            if (id === null) continue;
            (out.reminded ??= []).push(i.key);
            if (yield* speak(DOWNTIME.soon.replace("{when}", spokenIn(S - t)), `downtime reminder ${i.key}`)) (out.spoken ??= []).push(`${i.key} reminder`);
          }
        }
      });

      // ---------------------------------------------------------------- the poll

      const once = Effect.fn("Downtime.once")(function* (ch: string, t: number, force: boolean) {
        const out: PollResult = {};
        const replay: Replay | undefined = config.newsBacktestPost ? yield* readReplay : undefined;
        // 1. the launcher, every minute
        const notice = replay?.notice !== undefined ? replay.notice : yield* launcher;
        if (notice !== null) out.notice = notice;
        if (notice) yield* noticeSeen(notice, "launcher", t, null);
        else if (notice === "") yield* noticeGone(t);
        // 2. Blizzard's own forum posts about maintenance (news.ts collects them, hourly)
        const posts = yield* db
          .select()
          .from(newsStories)
          .where(and(eq(newsStories.source, "blizzard"), eq(newsStories.reason, "downtime notice"), gte(newsStories.created_at, t - 86400)));
        for (const p of posts) yield* noticeSeen(`${p.title}. ${p.body}`.trim(), "blizzard", t, p.link);
        // 3. the status page, every 2 minutes
        if (replay?.realms !== undefined || force || t >= (yield* Ref.get(realmsNext))) {
          const realms = replay?.realms ?? (yield* realmStatus);
          yield* Ref.set(realmsNext, t + (realms === null ? REALMS_BROKEN_WAIT : REALMS_EVERY));
          if (realms) out.offline = yield* realmsSeen(realms, t);
        }
        // 4. the players, every 2 minutes, backing off while the forum won't answer
        if (replay?.topics !== undefined || force || t >= (yield* Ref.get(forumNext))) {
          const topics = replay?.topics ?? (yield* forumListing);
          const wait = topics === null ? Math.min(FORUM_MAX_WAIT, (yield* Ref.get(forumWait)) * 2) : FORUM_EVERY;
          yield* Ref.set(forumWait, wait);
          yield* Ref.set(forumNext, t + wait);
          const b = topics ? burstOf(topics, t) : null;
          if (b) {
            out.burst = b.count;
            yield* burstSeen(b, t);
          }
        }
        yield* closeByTime(t);
        yield* publish(ch, t, out);
        return out;
      });

      const poll = (options: { readonly at?: number; readonly force?: boolean } = {}) =>
        Effect.gen(function* () {
          if (!channel) return {} as PollResult;
          const t = options.at ?? (yield* nowSec);
          return yield* turn.withPermit(once(channel, t, options.force ?? false));
        });

      const check = Effect.gen(function* () {
        if (!channel || (yield* Ref.getAndSet(busy, true))) return {};
        const go = poll().pipe(
          Effect.flatMap((r) => (Object.keys(r).some((k) => k !== "notice" && k !== "offline") ? Effect.logInfo(`downtime ${jsonText(r)}`) : Effect.void)),
          Effect.catchCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logInfo(`downtime: the poll failed, trying again next minute: ${String(Cause.squash(cause))}`))),
          Effect.ensuring(Ref.set(busy, false)),
        );
        yield* background.run(go, "the downtime poll").pipe(Effect.onError(() => Ref.set(busy, false)));
        return { checking: true };
      }).pipe(Effect.withSpan("Downtime.check"));

      const replay = Effect.fn("Downtime.replay")(function* (input: ReplayInput) {
        if (!config.newsBacktestPost) return null;
        const t = yield* nowSec;
        if (input.live) yield* db.delete(settings).where(eq(settings.key, REPLAY));
        else {
          const before = (yield* readReplay) ?? {};
          const topics = input.topics?.map((x) => ({
            id: x.id,
            title: x.title,
            created_at: x.created_at !== undefined ? unix(x.created_at) : t - Math.round((x.minutes_ago ?? 0) * 60),
            posts_count: x.posts_count ?? 1,
            slug: x.slug ?? "topic",
            ...(x.text !== undefined ? { text: x.text } : {}),
          }));
          const value: Replay = {
            ...before,
            ...(input.notice !== undefined ? { notice: input.notice } : {}),
            ...(topics !== undefined ? { topics } : {}),
            ...(input.realms !== undefined ? { realms: input.realms } : {}),
          };
          yield* db.insert(settings).values({ key: REPLAY, value }).onConflictDoUpdate({ target: settings.key, set: { value, updated_at: sql`now()` } });
        }
        return yield* poll({ at: t, force: true });
      });

      return Downtime.of({ check, poll, replay });
    }),
  );
}

/** For news.ts: is this Blizzard staff post's title a downtime notice? */
export const isDowntimeNotice = (title: string) => DOWNTIME_TITLE.test(title);
