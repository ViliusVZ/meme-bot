// ⚔️ The news's rules that are plain arithmetic and text (plan 06), apart from the service so the
// tests can hold each one: when a thread is hot for its own subreddit, how the outside writer's
// write-up is checked and cleaned (it's written from Reddit's text, which is untrusted: no
// mentions, no invites, no links at all), and the card itself.
import { Schema } from "effect";
import { IS_COMPONENTS_V2 } from "./discord.js";
import type { Listed } from "./newsfeeds.js";

export const SILENT = 1 << 12; // SUPPRESS_NOTIFICATIONS
export const MAX_AGE = 36 * 3600; // a thread older than this is never news
export const OFFICIAL_AGE = 48 * 3600; // a Blizzard post may be a little older
export const BAR_MIN = 2;
export const BAR_MAX = 10;
export const DEFAULT_BAR = 5; // a subreddit whose month we couldn't read
export const CLIMB = 3; // places gained in hot between two runs that make a thread "climbing"
export const QUIET = 5; // fewer comments than this (by the card's time): no reaction to tell yet
export const MOODS = ["mostly for", "mostly against", "split", "joking about it", "no clear reaction yet"] as const;
/** The longest each part of a write-up may be (characters, after cleaning). */
export const LIMITS = { headline: 80, what: 350, why: 250, line: 200, take: 160 } as const;

/** A write-up, as the outside writer sends it and the card shows it. */
export const Writeup = Schema.Struct({
  headline: Schema.String,
  what: Schema.String,
  mood: Schema.Struct({ label: Schema.Literals(MOODS), line: Schema.String, takes: Schema.Array(Schema.String) }),
  why: Schema.String,
});
export type Writeup = typeof Writeup.Type;
const PINNED = /\b(mega ?thread|weekly .*thread|daily .*thread|discussion thread|q&a thread|questions thread)\b/i;

/** Hosts a card may link to besides the thread (Blizzard's and Wowhead's, any subdomain). */
const OFFICIAL_HOSTS = /(^|\.)(blizzard\.com|wowhead\.com)$/i;

/** A link a card may carry as "Blizzard's post": https, on Blizzard's or Wowhead's domains. */
export function officialLink(url: string): boolean {
  const m = url.match(/^https:\/\/([^/?#:]+)(?:[/?#]|$)/i);
  return !!m && OFFICIAL_HOSTS.test(m[1]) && !/[\s()<>[\]]/.test(url);
}

/** What a card calls an official link: by its domain (a Wowhead article is not Blizzard's post). */
export function linkLabel(url: string): string {
  return /^https:\/\/([^/]+\.)?wowhead\.com\//i.test(url) ? "Wowhead" : "Blizzard's post";
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** The dates ("November 11, 2026") a text's sections start with, as YYYY-MM-DD, in order. */
export function datesIn(text: string): string[] {
  return dateMarks(text).map((k) => k.iso);
}

/**
 * A post that keeps growing by dated sections ("November 11, 2026 …", like Blizzard's running
 * hotfix posts), as it stood on `day` (YYYY-MM-DD): the text before the first date, and every
 * section dated on or before that day (and before `before`, when given). A text without dates is
 * kept whole.
 */
export function upTo(text: string, day: string, before?: string): string {
  const marks = dateMarks(text);
  if (!marks.length) return text;
  let out = text.slice(0, marks[0].at);
  marks.forEach((k, i) => {
    if (k.iso <= day && (before === undefined || k.iso < before)) out += text.slice(k.at, marks[i + 1]?.at ?? text.length);
  });
  return out.replace(/\s+/g, " ").trim();
}

/** A running post's dated sections, by day, in order (two marks of the same day make one section). */
export function sectionsIn(text: string): Array<{ day: string; text: string }> {
  const marks = dateMarks(text);
  const out = new Map<string, string>();
  marks.forEach((k, i) => out.set(k.iso, `${out.get(k.iso) ?? ""} ${text.slice(k.at, marks[i + 1]?.at ?? text.length)}`.replace(/\s+/g, " ").trim()));
  return [...out].map(([day, t]) => ({ day, text: t }));
}

/** A running topic's title for one of its days: its date swapped for that day's ("…Hotfixes - November 10, 2026"). */
export function titleFor(title: string, day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const label = `${MONTHS[m - 1][0].toUpperCase()}${MONTHS[m - 1].slice(1)} ${d}, ${y}`;
  const marks = dateMarks(title);
  return marks.length ? title.replace(/\b(January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}\b/, label) : `${title} (${label})`;
}

function dateMarks(text: string) {
  return [...text.matchAll(/\b(January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2}), (\d{4})\b/g)].map((m) => ({
    at: m.index,
    iso: `${m[3]}-${String(MONTHS.indexOf(m[1].toLowerCase()) + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`,
  }));
}

/** A thread's own link (from the feed): https on reddit.com, nothing that would break the markdown. */
export function threadLink(url: string): boolean {
  return /^https:\/\/(www\.)?reddit\.com\/r\/[\w-]+\/comments\/[\w/-]+$/i.test(url) || (officialLink(url) && /forums\.blizzard\.com/i.test(url));
}

/**
 * How deep a subreddit's top of the day counts as "hot" there: how many of a day's posts usually
 * reach its month's top 100. A big subreddit spreads its month's best over 30 days (about 3 a day);
 * a young or small one has all of them in a few days, so its top ten are its month's best.
 */
export function barFrom(month: ReadonlyArray<Pick<Listed, "created">>, at: number): number {
  if (!month.length) return DEFAULT_BAR;
  const oldest = Math.min(...month.map((p) => p.created));
  const days = Math.max(1, (at - oldest) / 86400);
  return Math.min(BAR_MAX, Math.max(BAR_MIN, Math.round(month.length / days)));
}

export type Heat = { readonly sub: string; readonly source: "reddit" | "blizzard"; readonly title: string; readonly created_at: number; readonly top_rank: number | null; readonly hot_rank: number | null; readonly prev_hot_rank: number | null };

/** Why a story isn't a candidate (null: it is). Freshness is the timestamps', never a model's. */
export function notHot(s: Heat, bar: number, at: number, removed = false): string | null {
  if (at - s.created_at > (s.source === "blizzard" ? OFFICIAL_AGE : MAX_AGE)) return "too old";
  if (removed) return "removed";
  if (s.source === "blizzard") return null; // a Forever staff post: big official news qualifies (the writer can skip it)
  if (PINNED.test(s.title) || (s.hot_rank !== null && s.hot_rank <= 2 && s.top_rank === null && at - s.created_at > 24 * 3600)) return "pinned";
  if (s.top_rank !== null && s.top_rank <= bar) return null;
  if (s.hot_rank !== null && s.prev_hot_rank !== null && s.prev_hot_rank - s.hot_rank >= CLIMB && s.hot_rank <= 2 * bar) return null; // climbing
  return "under the bar";
}

/** Titles that are the same post (crossposts): case, punctuation and spacing aside. */
export const sameTitle = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// ---------------------------------------------------------------- the write-up, checked

/**
 * Untrusted text made safe for a card, on one line: no mentions of anyone (users, roles, channels,
 * everyone, here), no invites, no links of any kind, no markdown that could change the card's
 * shape; then cut to `max` characters at a word.
 */
export function clean(text: string, max: number): string {
  let s = text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // [text](url) → text
    .replace(/<(@[!&]?|#)\d+>/g, "") // <@123>, <@&123>, <#123>
    .replace(/<\/?[a-z][^>]*>/gi, " ") // stray HTML
    .replace(/(?:https?:\/\/)?(?:www\.)?(?:discord(?:app)?\.(?:gg|com\/invite|io|me|li)|dsc\.gg)\/\S*/gi, "") // invites
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "") // any other link
    .replace(/@(everyone|here)\b/gi, "$1")
    .replace(/@/g, "＠") // nothing left can mention anyone, even by accident
    .replace(/\|\|/g, "") // spoilers
    .replace(/[`*_~<>[\]]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[-#>\s]+/, "")
    .trim();
  if (s.length > max) {
    const cut = s.slice(0, max - 1);
    const at = cut.lastIndexOf(" ");
    s = `${(at > max * 0.5 ? cut.slice(0, at) : cut).replace(/[\s,;:.–-]+$/, "")}…`;
  }
  return s;
}

/** A write-up fit for a card (cleaned), or what's wrong with it. */
export type Checked = { readonly ok: Writeup } | { readonly bad: string };

/**
 * Code's say over a write-up: every text cleaned (no mentions, links or markdown), none empty, none
 * longer than LIMITS; two or three takes unless there's no clear reaction. With fewer than QUIET
 * `comments` there's no reaction to tell: the mood says so, whatever the writer made of the few.
 */
export function check(w: Writeup, comments: number): Checked {
  const fits = (what: string, text: string, max: number) => {
    const c = clean(text, Number.MAX_SAFE_INTEGER);
    return !c ? `${what} is empty` : c.length > max ? `${what} is ${c.length} characters, at most ${max}` : null;
  };
  const few = comments < QUIET;
  const mood = few ? { label: "no clear reaction yet" as const, line: comments ? `Only ${comments} comment${comments === 1 ? "" : "s"} so far.` : "No comments yet.", takes: [] } : w.mood;
  const quiet = mood.label === "no clear reaction yet";
  const takes = mood.takes.map((t) => clean(t, Number.MAX_SAFE_INTEGER)).filter(Boolean);
  const bad =
    fits("headline", w.headline, LIMITS.headline) ??
    fits("what", w.what, LIMITS.what) ??
    fits("why", w.why, LIMITS.why) ??
    fits("mood.line", mood.line, LIMITS.line) ??
    mood.takes.map((t, i) => fits(`mood.takes[${i}]`, t, LIMITS.take)).find(Boolean) ??
    (!quiet && (takes.length < 2 || takes.length > 3) ? `mood.takes: two or three (${takes.length} given)` : null);
  if (bad) return { bad };
  const c = (t: string) => clean(t, Number.MAX_SAFE_INTEGER);
  return { ok: { headline: c(w.headline), what: c(w.what), why: c(w.why), mood: { label: mood.label, line: c(mood.line), takes: quiet ? takes.slice(0, 3) : takes } } };
}

const MOOD_EMOJI: Record<string, string> = { "mostly for": "👍", "mostly against": "😡", split: "⚖️", "joking about it": "😂", "no clear reaction yet": "🤷" };

/** Where a card's story came from, for its last line. */
export type Origin = { readonly source: "reddit" | "blizzard"; readonly sub: string; readonly link: string; readonly created_at: number; readonly official: string | null };

/** The card's text (also the backtest sheet's): no numbers (the feeds have none), two links at most. */
export function cardText(o: Origin, w: Writeup): string {
  const official = o.official && officialLink(o.official) && o.official !== o.link ? o.official : null;
  const where = o.source === "blizzard" ? "Blizzard" : `r/${o.sub}`;
  const links = [threadLink(o.link) ? `[${o.source === "blizzard" ? "Blizzard's post" : "thread"}](${o.link})` : null, official ? `[${linkLabel(official)}](${official})` : null].filter(Boolean);
  return [
    `### ${w.headline}`,
    `**What happened** ${w.what}`,
    `**What players think** ${MOOD_EMOJI[w.mood.label] ?? "💬"} ${w.mood.line}`,
    ...w.mood.takes.map((t) => `- ${t}`),
    `**Why it matters to us** ${w.why}`,
    `-# ${[where, `<t:${o.created_at}:R>`, ...links].join(" · ")}`,
  ].join("\n");
}

/** The news card: components v2, silent, pinging nobody; `note`: a small line under it (the backtest's mark). */
export function card(o: Origin, w: Writeup, note?: string) {
  return {
    flags: IS_COMPONENTS_V2 | SILENT,
    allowed_mentions: { parse: [] as string[] },
    components: [{ type: 17, accent_color: 0x148eff, components: [{ type: 10, content: note ? `${cardText(o, w)}\n-# ${note}` : cardText(o, w) }] }],
  };
}
