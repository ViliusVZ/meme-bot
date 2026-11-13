// ⚔️ The news's rules that are plain arithmetic and text (plan 06), apart from the service so the
// tests can hold each one: when a thread is hot for its own subreddit, what the triage's answers
// let through, how a write-up is checked and cleaned (Reddit's text is untrusted: no mentions, no
// invites, no links but the thread's and one from Blizzard or Wowhead), and the card itself.
import { IS_COMPONENTS_V2 } from "./discord.js";
import type { Listed } from "./newsfeeds.js";
import type { Verdict, Writeup } from "./newswriter.js";

export const SILENT = 1 << 12; // SUPPRESS_NOTIFICATIONS
export const MAX_AGE = 36 * 3600; // a thread older than this is never news
export const OFFICIAL_AGE = 48 * 3600; // a Blizzard post may be a little older
export const BAR_MIN = 2;
export const BAR_MAX = 10;
export const DEFAULT_BAR = 5; // a subreddit whose month we couldn't read
export const CLIMB = 3; // places gained in hot between two runs that make a thread "climbing"
export const KEEP_SCORE = 7; // the triage's 0-10 a story needs
export const MIN_CONFIDENCE = 0.6;
export const QUIET = 5; // fewer comments than this (by the card's time): no reaction to tell yet
const JUNK: Record<string, string> = { meme: "a meme", screenshot: "a screenshot", loot: "a loot post", support: "a support post", lfg: "an LFG post", opinion: "a request or opinion" };
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
  if (s.source === "blizzard") return null; // a topic Blizzard started: big official news still qualifies (the triage decides)
  if (PINNED.test(s.title) || (s.hot_rank !== null && s.hot_rank <= 2 && s.top_rank === null && at - s.created_at > 24 * 3600)) return "pinned";
  if (s.top_rank !== null && s.top_rank <= bar) return null;
  if (s.hot_rank !== null && s.prev_hot_rank !== null && s.prev_hot_rank - s.hot_rank >= CLIMB && s.hot_rank <= 2 * bar) return null; // climbing
  return "under the bar";
}

/** Titles that are the same post (crossposts): case, punctuation and spacing aside. */
export const sameTitle = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export type Judged = { readonly id: string; readonly source: "reddit" | "blizzard"; readonly title: string; readonly link: string; readonly rank: number };
export type Decision = { readonly id: string; readonly keep: boolean; readonly reason: string | null; readonly score: number | null; readonly same_as: string | null; readonly official: string | null; readonly verdict: Verdict | null };

/**
 * What the triage's answers let through: about Forever (another game only when it plainly touches
 * Forever), not a meme, screenshot, loot, support or LFG post, 7 or more, and not a repeat: of a
 * story already posted, or of a better candidate about the same thing (one card per story: a
 * Reddit thread before Blizzard's own post, which then becomes the card's official link).
 * A candidate the answer left out is decided as not judged.
 */
export function decide(candidates: ReadonlyArray<Judged>, verdicts: ReadonlyArray<Verdict>, posted: ReadonlySet<string>): Decision[] {
  const v = new Map(verdicts.map((x) => [x.id, x]));
  const ids = new Set(candidates.map((c) => c.id));
  // groups: the triage's "same as" between candidates, and identical titles (crossposts)
  const parent = new Map(candidates.map((c) => [c.id, c.id]));
  const root = (id: string): string => (parent.get(id) === id ? id : root(parent.get(id)!));
  const join = (a: string, b: string) => parent.set(root(a), root(b));
  for (const c of candidates) {
    const s = v.get(c.id)?.same_as;
    if (s && ids.has(s)) join(c.id, s);
  }
  const byTitle = new Map<string, string>();
  for (const c of candidates) {
    const k = sameTitle(c.title);
    if (byTitle.has(k)) join(c.id, byTitle.get(k)!);
    else byTitle.set(k, c.id);
  }
  const groups = new Map<string, Judged[]>();
  for (const c of candidates) groups.set(root(c.id), [...(groups.get(root(c.id)) ?? []), c]);

  const why = (x: Verdict): string | null => {
    if (JUNK[x.kind]) return JUNK[x.kind];
    if (x.game !== "forever" && !x.touches_forever) return x.game === "retail" ? "about retail" : x.game === "classic" ? "about another Classic" : "not about Forever";
    if (x.matters < KEEP_SCORE) return `scored ${x.matters}/10`;
    return null;
  };
  const out: Decision[] = [];
  for (const group of groups.values()) {
    const repeat = group.some((c) => {
      const s = v.get(c.id)?.same_as;
      return !!s && posted.has(s);
    });
    const official = group.find((c) => c.source === "blizzard")?.link ?? null;
    const fit = group
      .filter((c) => v.has(c.id) && why(v.get(c.id)!) === null)
      .sort((a, b) => (a.source === b.source ? 0 : a.source === "reddit" ? -1 : 1) || v.get(b.id)!.matters - v.get(a.id)!.matters || a.rank - b.rank);
    const best = repeat ? undefined : fit[0];
    for (const c of group) {
      const x = v.get(c.id) ?? null;
      const score = x ? Math.max(0, Math.min(10, Math.round(x.matters))) : null;
      if (best && c.id === best.id) out.push({ id: c.id, keep: true, reason: null, score, same_as: null, official, verdict: x });
      else if (!x) out.push({ id: c.id, keep: false, reason: "not judged", score, same_as: null, official: null, verdict: x });
      else if (repeat || (best && why(x) === null)) out.push({ id: c.id, keep: false, reason: "a repeat", score, same_as: repeat ? (x.same_as || null) : best!.id, official: null, verdict: x });
      else out.push({ id: c.id, keep: false, reason: why(x) ?? "a repeat", score, same_as: best ? best.id : null, official: null, verdict: x });
    }
  }
  return out;
}

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

/** A write-up fit for a card (cleaned and cut), or why it isn't. */
export type Checked = { readonly ok: Writeup } | { readonly drop: string };

/**
 * Code's say over the write-up: dropped when the model calls it old news, says it changes nothing
 * for us, isn't sure (under 0.6), or left a field empty; every text cut and cleaned; the official
 * link kept only when it's Blizzard's or Wowhead's and was in the material the model was given
 * (never one it made up). With fewer than QUIET `comments` there's no reaction to tell: the mood
 * says so, whatever the model made of the few there were.
 */
export function check(w: Writeup, links: ReadonlyArray<string>, comments?: number): Checked {
  if (w.old_news) return { drop: "old news" };
  if (w.changes_something === false) return { drop: "nothing it changes for us" };
  if (!(w.confidence >= MIN_CONFIDENCE)) return { drop: `unsure (${Math.round(w.confidence * 100) / 100})` };
  const headline = clean(w.headline, 80);
  const what = clean(w.what, 350);
  const why = clean(w.why, 250);
  const few = comments !== undefined && comments < QUIET;
  const mood = few ? { label: "no clear reaction yet" as const, line: comments ? `Only ${comments} comment${comments === 1 ? "" : "s"} so far.` : "No comments yet.", takes: [] } : w.mood;
  const line = clean(mood.line, 200);
  const takes = mood.takes.map((t) => clean(t, 160)).filter(Boolean).slice(0, 3);
  const quiet = mood.label === "no clear reaction yet";
  if (!headline || !what || !why || !line || (!quiet && takes.length < 2)) return { drop: "an empty field" };
  const link = w.official_link.trim();
  const official = link && officialLink(link) && links.some((l) => l === link) ? link : "";
  return { ok: { ...w, headline, what, why, mood: { label: mood.label, line, takes }, official_link: official } };
}

const MOOD_EMOJI: Record<string, string> = { "mostly for": "👍", "mostly against": "😡", split: "⚖️", "joking about it": "😂", "no clear reaction yet": "🤷" };

/** Where a card's story came from, for its last line. */
export type Origin = { readonly source: "reddit" | "blizzard"; readonly sub: string; readonly link: string; readonly created_at: number; readonly official: string | null };

/** The card's text (also the backtest sheet's): no numbers (the feeds have none), two links at most. */
export function cardText(o: Origin, w: Writeup): string {
  const official = [o.official, w.official_link].find((l): l is string => !!l && officialLink(l) && l !== o.link) ?? null;
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
