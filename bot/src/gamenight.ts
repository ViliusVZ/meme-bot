// Daily game-night planner: one card per day that walks through three stages.
//   ask  → "Are we playing today?" (needs every player to say yes)
//   game → pick a game (once everyone's voted, most votes wins; on a split the picks are revealed
//          and everyone re-votes until two agree)
//   time → everyone picks the earliest time they can start; we start at the latest of those, and
//          only if everyone gets an hour together before the first 🏁 leave-by
//   set  → locked in: Discord event + one ping now; at start a voice room opens (voice.ts) and
//          latecomers are handled (late.ts). We play all together or not at all: anyone bailing,
//          even after the start, calls it off for everyone (and gets roasted)
//   off  → someone bailed, or the day ended before we agreed (🔄 reopen works the same day)
//
// 🔥 Every vote has a deadline (voteDeadline: 3 h, smart about nights and planned days). Votes stay
// secret until everyone's in or the deadline hits; a ❌ no alone doesn't end anything early. If the
// night falls through (someone said no, didn't vote in time, or bailed with 🚪), it's called off
// and the culprits get roasted (roasts.ts), 30 min after a warning to anyone who hasn't voted.
//
// One row per local (Europe/Vilnius) day. Its PRIMARY KEY is the only thing that decides whether
// a poll gets posted, so the 17:00 job, /playtoday and retries can never produce two polls.
import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { Env } from "./env.js";
import { gameNights, gameNightVotes, games as gameTable, nightAttendance, type Stage, type Tx } from "./db/index.js";
import { api, followup, EPHEMERAL, IS_COMPONENTS_V2, isNotFound } from "./discord.js";
import * as roasts from "./roasts.js";
import type { Reason } from "./db/index.js";
import { now } from "./memes.js";
import * as voice from "./voice.js";
import * as late from "./late.js";

export type Night = typeof gameNights.$inferSelect;
interface Game {
  name: string;
  emoji: string | null;
  plays: number;
}
type Votes = Record<string, string>; // user id → choice
type Defer = (p: Promise<unknown>) => void;
/** What to tell the clicker privately, and whether the card should be re-rendered. */
export type Outcome = { notice?: string; update: boolean };

const OPEN: Stage[] = ["ask", "game", "time"];
const COLORS: Record<Stage, number> = { ask: 0x5865f2, game: 0x57f287, time: 0xfee75c, set: 0xeb459e, off: 0x4f545c };
const HALF_HOUR = 1800;
const LEAD = 45 * 60; // first suggested start is at least this far out
const RENUDGE_AFTER = 3600;
const VOTE_WINDOW = 3 * 3600; // a vote that isn't complete this long after it opened calls the night off
const WARN_BEFORE = 30 * 60; // "last call" to whoever hasn't voted
const MORNING = { hour: 9, minute: 30 }; // nothing gets decided or posted between midnight and this

export const players = (env: Env) => env.PLAYERS.split(",").map((s) => s.trim()).filter(Boolean);
const mention = (id: string) => `<@${id}>`;
/** QUIET is set by the admin test route so simulated runs don't notify anyone. */
const pings = (env: Env, users: string[]) => (env.QUIET ? { parse: [] } : { users });
const ts = (sec: number, style: string) => `<t:${sec}:${style}>`;
const nowSec = () => Math.floor(Date.now() / 1000);
/** Sleep until `ms` (epoch ms); an abort wakes it early. */
const sleepUntil = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((ok) => {
    const t = setTimeout(ok, Math.max(0, ms - Date.now()));
    signal?.addEventListener("abort", () => (clearTimeout(t), ok()), { once: true });
  });
const ROOM_EARLY = 10; // a night's room opens this many seconds before the start, so the moves land on the dot
const ok: Outcome = { update: true };
const say = (notice: string, update = false): Outcome => ({ notice, update });

// ---------------------------------------------------------------- time

/** Wall-clock parts in the configured timezone. Intl handles Lithuanian DST for us. */
export function local(env: Env, d = new Date(Date.now())) {
  const p: Record<string, string> = {};
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: env.TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  for (const x of fmt.formatToParts(d)) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day, day: `${p.year}-${p.month}-${p.day}`, hour: +p.hour, minute: +p.minute, hm: `${p.hour}:${p.minute}` };
}

/** Unix seconds for a wall-clock time in the configured timezone. */
export function wallToUnix(env: Env, y: number, m: number, d: number, hour: number, minute: number) {
  const guess = Date.UTC(y, m - 1, d, hour, minute) / 1000;
  // shift by the zone's offset at that moment (twice, so DST changeover days land right)
  let t = guess;
  for (let i = 0; i < 2; i++) {
    const l = local(env, new Date(t * 1000));
    t -= Date.UTC(l.y, l.m - 1, l.d, l.hour, l.minute) / 1000 - guess;
  }
  return t;
}

const clock = (env: Env, sec: number) => local(env, new Date(sec * 1000)).hm;

/** "18:30", or "🌙 00:30" for after midnight. */
function timeLabel(env: Env, sec: number, day: string) {
  const l = local(env, new Date(sec * 1000));
  return l.day === day ? l.hm : `🌙 ${l.hm}`;
}

/**
 * Start-time presets, generated from when the time stage began: three half-hour steps from the
 * earliest sensible start, then two hourly ones (14:00 → 15:00 15:30 16:00 17:00 18:00;
 * 17:00 → 18:00 18:30 19:00 20:00 21:00). Past times are dropped; if the stage has dragged on
 * so long that few remain, they're regenerated from now. A night planned for a later day gets
 * that day's afternoon/evening on the hour (16:00 … 21:00). Times anyone voted for (including
 * custom ones) are always offered so others can join them.
 */
export function timeOptions(env: Env, n: Night, v: Votes) {
  const t = nowSec();
  let presets: number[];
  if (n.day > local(env).day) {
    const [y, m, d] = n.day.split("-").map(Number);
    presets = [16, 17, 18, 19, 20, 21].map((h) => wallToUnix(env, y, m, d, h, 0));
  } else {
    const build = (base: number) => {
      const first = Math.ceil((base + LEAD) / HALF_HOUR) * HALF_HOUR;
      return [0, 1, 2, 4, 6].map((k) => first + k * HALF_HOUR);
    };
    presets = build(n.stage_at ?? t).filter((s) => s > t);
    if (presets.length < 3) presets = build(t);
  }
  // every time someone voted for keeps its button (so it can be joined, or tapped to take back);
  // presets fill the rest, up to 8 buttons
  const voted = [...new Set(Object.values(v).map(Number).filter((s) => s > t))];
  const room = Math.max(0, 8 - voted.length);
  return [...new Set([...voted, ...presets.filter((p) => !voted.includes(p)).slice(0, room)])].sort((a, b) => a - b);
}

/**
 * Parses "20", "20:15", "2015", "20.15" or "20h15" typed into the custom-time box, as a time on
 * the night's day. Early-morning hours (before 06:00) mean after midnight that night.
 */
export function parseTime(env: Env, raw: string, day = local(env).day): number | string {
  const m = raw.trim().match(/^(\d{1,2})(?:\s*[:.h]?\s*(\d{2}))?$/i);
  if (!m || +m[1] > 23 || +(m[2] ?? 0) > 59) return "Couldn't read that time. Try something like **20:30**.";
  const [y, mo, d] = day.split("-").map(Number);
  const today = day === local(env).day;
  let t = wallToUnix(env, y, mo, d, +m[1], +(m[2] ?? 0));
  if (+m[1] < 6 && (!today || t < nowSec())) {
    // the small hours after the night: same wall time on the next calendar day (DST-safe)
    const next = new Date(Date.UTC(y, mo - 1, d + 1));
    t = wallToUnix(env, next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), +m[1], +(m[2] ?? 0));
  }
  if (t < nowSec() + 120) return `**${clock(env, t)}** has already passed ⏰`;
  if (today && t > nowSec() + 18 * 3600) return "That's a bit far out. Pick a time in the next 18 hours.";
  return t;
}

/** "Friday", for cards about a day other than today. */
export function weekday(env: Env, day: string) {
  return new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" }).format(new Date(`${day}T12:00:00Z`));
}

/** The least time we must all get together, or the night doesn't fit. */
export const MIN_TOGETHER = 3600;

export type Fit = {
  ready: boolean; // everyone has picked a start time
  start: number | null; // latest start picked so far (bumped to `soonest` if that has passed)
  end: number | null; // earliest leave-by, if anyone set one
  // lateFrom is the latest pick; `bumped` means even that has passed, so we start at `start`
  conflict: { leaver: string; leaveBy: number; late: string[]; lateFrom: number; bumped: boolean } | null;
};

/**
 * Do the picks fit? We start at the latest "earliest start" (so everyone can make it) and must
 * get at least MIN_TOGETHER before the first person has to leave. A conflict names who has to
 * leave and who can't start in time, so they can sort it out. No dice and no rock-paper-scissors:
 * nobody gets voted into a time they can't make.
 */
export function fit(ps: string[], starts: Votes, untils: Votes, soonest: number): Fit {
  const picked = ps.filter((p) => starts[p]);
  const latestPick = picked.length ? Math.max(...picked.map((p) => Number(starts[p]))) : null;
  const start = latestPick === null ? null : Math.max(soonest, latestPick);
  const limits = ps.filter((p) => untils[p]).map((p) => ({ p, t: Number(untils[p]) }));
  limits.sort((a, b) => a.t - b.t);
  const first = limits[0];
  const conflict =
    start !== null && first && first.t - start < MIN_TOGETHER
      ? {
          leaver: first.p,
          leaveBy: first.t,
          late: picked.filter((p) => Number(starts[p]) === latestPick),
          lateFrom: latestPick!,
          bumped: start > latestPick!,
        }
      : null;
  return { ready: picked.length === ps.length, start, end: first?.t ?? null, conflict };
}

// ---------------------------------------------------------------- storage

export const getNight = async (env: Env, day: string): Promise<Night | null> =>
  (await env.db.select().from(gameNights).where(eq(gameNights.day, day)))[0] ?? null;

/** Vote buckets: one per stage, plus "until" for optional 🏁 leave-by times (unix seconds). */
type VoteStage = Stage | "until";

async function votes(env: Env, day: string, stage: VoteStage): Promise<Votes> {
  const r = await env.db
    .select({ user_id: gameNightVotes.user_id, choice: gameNightVotes.choice })
    .from(gameNightVotes)
    .where(and(eq(gameNightVotes.day, day), eq(gameNightVotes.stage, stage)));
  return Object.fromEntries(r.map((v) => [v.user_id, v.choice]));
}

const vote = (env: Env, day: string, stage: VoteStage, user: string, choice: string) =>
  env.db
    .insert(gameNightVotes)
    .values({ day, stage, user_id: user, choice, voted_at: now() })
    .onConflictDoUpdate({
      target: [gameNightVotes.day, gameNightVotes.stage, gameNightVotes.user_id],
      set: { choice: sql`excluded.choice`, voted_at: sql`excluded.voted_at` },
    });

const unvote = (env: Env, day: string, stage: VoteStage, user: string) =>
  env.db.delete(gameNightVotes).where(and(eq(gameNightVotes.day, day), eq(gameNightVotes.stage, stage), eq(gameNightVotes.user_id, user)));

/** The game list, most played first (a dropdown holds 25). */
export async function games(env: Env, limit = 25): Promise<Game[]> {
  return env.db
    .select({ name: gameTable.name, emoji: gameTable.emoji, plays: gameTable.plays })
    .from(gameTable)
    .orderBy(desc(gameTable.plays), asc(gameTable.seq))
    .limit(limit);
}

/** Adds a game if it's new; returns its stored name (names are case-insensitive). */
export async function addGame(env: Env, raw: string, user: string) {
  const name = raw.replace(/\s+/g, " ").trim().slice(0, 60);
  if (!name) return null;
  await env.db.insert(gameTable).values({ name, emoji: null, added_by: user, added_at: now() }).onConflictDoNothing();
  return (await env.db.select({ name: gameTable.name }).from(gameTable).where(eq(gameTable.name, name)))[0].name;
}

export const removeGame = (env: Env, name: string) => env.db.delete(gameTable).where(eq(gameTable.name, name));

/** Compare-and-set on the stage, so concurrent clicks can only advance a night once. */
async function advance(env: Env, day: string, from: Stage, to: Stage, set: { game?: string; start_at?: number; note?: string | null } = {}) {
  const r = await env.db
    .update(gameNights)
    .set({
      stage: to,
      stage_at: nowSec(),
      ...(set.game != null ? { game: set.game } : {}),
      ...(set.start_at != null ? { start_at: set.start_at } : {}),
      ...(set.note != null ? { note: set.note } : {}),
    })
    .where(and(eq(gameNights.day, day), eq(gameNights.stage, from)))
    .returning({ day: gameNights.day });
  return r.length > 0;
}

function tally(env: Env, v: Votes) {
  const counts = new Map<string, number>();
  for (const p of players(env)) if (v[p]) counts.set(v[p], (counts.get(v[p]) ?? 0) + 1);
  return counts;
}

// ---------------------------------------------------------------- 🤫 secret ballots
// The card is the same for everyone, so it can't highlight *your* picks. Clicking it answers with
// your own private copy (render with a viewer): same buttons, your picks highlighted, and clicks
// on it update it in place while the public card follows along.
// While a vote runs, the card shows only who has voted, never what. No counts either: in a group
// of three they'd give picks away. Each voter gets a private receipt instead. Picks are revealed
// once everyone has answered (a split game vote stays revealed while you re-vote), or every start
// time is in.

/** Is this stage's vote still secret? Once revealed it stays revealed (a time clash sets `conflict`). */
async function secret(env: Env, n: Night) {
  const ps = players(env);
  if (n.stage === "ask") {
    const v = await votes(env, n.day, "ask");
    return !ps.every((p) => v[p]);
  }
  if (n.stage === "game") {
    const v = await votes(env, n.day, "game");
    return !ps.every((p) => v[p]);
  }
  if (n.stage === "time") {
    if (n.conflict) return false;
    const v = await votes(env, n.day, "time");
    return !ps.every((p) => v[p]);
  }
  return false;
}

/** "👻 **Phasmophobia** ← @a @b · 🔫 **Valorant** ← @c", or null if nobody voted. */
async function gameVotesLine(env: Env, day: string) {
  const v = await votes(env, day, "game");
  const by = new Map<string, string[]>();
  for (const p of players(env)) if (v[p]) by.set(v[p], [...(by.get(v[p]) ?? []), p]);
  if (!by.size) return null;
  const label = await gameLabel(env);
  return [...by]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([g, us]) => `**${label(g)}** ← ${us.map(mention).join(" ")}`)
    .join(" · ");
}

/** "@a 18:00 · @b 19:00 (🏁 22:00) · @c no pick", or null if nobody picked anything. */
async function timeVotesLine(env: Env, day: string) {
  const v = await votes(env, day, "time");
  const until = await votes(env, day, "until");
  const ps = players(env);
  if (!ps.some((p) => v[p] || until[p])) return null;
  return ps
    .map((p) => {
      const start = v[p] ? `**${timeLabel(env, Number(v[p]), day)}**` : "no pick";
      return `${mention(p)} ${start}${until[p] ? ` (🏁 ${timeLabel(env, Number(until[p]), day)})` : ""}`;
    })
    .join(" · ");
}

/** A night that ended without playing reveals whatever was voted before it stopped. */
async function revealOff(env: Env, day: string) {
  const game = await gameVotesLine(env, day);
  const time = await timeVotesLine(env, day);
  const lines = [...(game ? [`🕹️ ${game}`] : []), ...(time ? [`🕐 ${time}`] : [])];
  if (!lines.length) {
    // it never got past "are we playing?": who was in, who wasn't, who never answered
    const v = await votes(env, day, "ask");
    const ps = players(env);
    if (ps.some((p) => v[p])) lines.push(ps.map((p) => `${v[p] === "yes" ? "✅" : v[p] === "no" ? "❌" : "⏳"} ${mention(p)}`).join("　"));
  }
  return lines.length ? [text(`-# 🗳️ How everyone voted\n${lines.map((l) => `-# ${l}`).join("\n")}`)] : [];
}

// ---------------------------------------------------------------- flow

export type StartResult = { started: boolean; day: string; message_id: string | null; stage: Stage };

/**
 * Posts the card for a day (today by default) if there isn't one yet. `by` is the player who ran
 * /playtoday or planned the day (their "yes" counts straight away); without it this is the 17:00
 * schedule, which only acts in the poll hour. Either way the INSERT OR IGNORE on the day decides
 * who wins, so a day planned in advance is never posted again by the schedule.
 */
export async function startNight(env: Env, by?: string, anyHour = false, forDay?: string): Promise<StartResult | { skipped: string }> {
  const { day: today, hour } = local(env);
  const day = forDay ?? today;
  if (day < today) return { skipped: "that day is over" };
  let n = await getNight(env, day);
  if (!n) {
    if (!by && !anyHour && hour !== Number(env.GAME_POLL_HOUR)) return { skipped: "not poll hour" };
    await env.db.insert(gameNights).values({ day, stage: "ask", reminded: false, started_by: by ?? null, stage_at: nowSec() }).onConflictDoNothing();
    n = (await getNight(env, day))!;
  }
  // whoever starts or plans the night is in (also when retrying a claim whose post failed)
  if (by && n.stage === "ask" && !n.message_id) await vote(env, day, "ask", by, "yes");
  // already posted, or someone else's card: just point at it
  if (n.message_id || n.stage !== "ask") return { started: false, day, message_id: n.message_id, stage: n.stage };
  // otherwise the day is claimed but not posted yet (fresh claim, or an earlier post failed): post it
  try {
    const msg = await api(env, "POST", `/channels/${env.GAME_CHANNEL_ID}/messages`, await render(env, day));
    // only the first writer stores its message; a racing duplicate deletes itself
    const set = await env.db
      .update(gameNights)
      .set({ message_id: msg.id })
      .where(and(eq(gameNights.day, day), isNull(gameNights.message_id)))
      .returning({ day: gameNights.day });
    if (!set.length) {
      await api(env, "DELETE", `/channels/${env.GAME_CHANNEL_ID}/messages/${msg.id}`).catch(() => {});
      const n = (await getNight(env, day))!;
      return { started: false, day, message_id: n.message_id, stage: n.stage };
    }
    if (by) {
      // someone kicked it off by hand: the other two hear about it (the 17:00 card is expected)
      const when = day === today ? "tonight" : `on ${weekday(env, day)}`;
      await nudge(env, day, players(env).filter((p) => p !== by), `🎮 ${mention(by)} wants to play ${when}! Are you in? ⬆️`).catch((e) => console.log("start nudge failed", e));
    }
    return { started: true, day, message_id: msg.id as string, stage: "ask" };
  } catch (e) {
    // keep the claim (so 17:00 can't post a second poll); the next minute (retryUnposted) or /playtoday retries
    console.log("startNight post failed", e);
    throw e;
  }
}

/** A claimed day whose card failed to post (today's or a planned one): try again. */
export async function retryUnposted(env: Env) {
  const days = await env.db
    .select({ day: gameNights.day })
    .from(gameNights)
    .where(and(isNull(gameNights.message_id), eq(gameNights.stage, "ask"), gte(gameNights.day, local(env).day)));
  for (const { day } of days) await startNight(env, undefined, true, day);
  return days.map((d) => d.day);
}

/** Re-render every open card (after the game list changes, say). */
export async function refreshOpen(env: Env) {
  const open = await env.db
    .select({ day: gameNights.day })
    .from(gameNights)
    .where(and(gte(gameNights.day, local(env).day), inArray(gameNights.stage, OPEN)));
  for (const { day } of open) await refresh(env, day);
}

/**
 * Is an unfinished card past its time? Asking and game picking end at midnight, but time picking
 * runs until the small hours, because 🌙 after-midnight starts (up to 06:00) are fair game.
 */
export function isOver(env: Env, n: { day: string; stage: Stage }) {
  if (n.day >= local(env).day) return false;
  if (n.stage !== "time") return true;
  const [y, mo, d] = n.day.split("-").map(Number);
  return nowSec() >= wallToUnix(env, y, mo, d, 0, 0) + 30 * 3600;
}

/** Cards left open past their time get closed so their buttons stop working. */
export async function closeStale(env: Env) {
  const today = local(env).day;
  const open = await env.db
    .select({ day: gameNights.day, stage: gameNights.stage })
    .from(gameNights)
    .where(and(sql`${gameNights.day} < ${today}`, inArray(gameNights.stage, OPEN)));
  const stale = open.filter((n) => isOver(env, n));
  for (const { day } of stale) await close(env, day);
  return stale.map((s) => s.day);
}

const closeNote = (stage: Stage) => (stage === "ask" ? "Not everyone was in. Maybe tomorrow 🫡" : "The day ended before we agreed. Maybe tomorrow 🫡");

/**
 * Closes a card that's past its time. From the minute job it re-renders the card itself; from a click
 * (`rerender` false) the stage is already flipped and the reply shows the closed card, so this
 * only tidies the nudge.
 */
async function close(env: Env, day: string, rerender = true) {
  const n = await getNight(env, day);
  if (!n) return;
  if (rerender) {
    if (!OPEN.includes(n.stage)) return;
    // the day ran out: anyone who had an hour to vote and didn't (or said no) still gets roasted,
    // in the morning; a vote that only just opened closes quietly
    const { who } = await culprits(env, n);
    const fair = nowSec() - (n.stage_at ?? 0) >= RENUDGE_AFTER;
    if (!(await callOff(env, n, fair ? who : {}, fair && Object.keys(who).length ? undefined : closeNote(n.stage)))) return;
    await refresh(env, day);
    return;
  }
  await clearNudge(env, n);
}

/**
 * Re-render a card in place (used outside interactions, where we can't reply with an update).
 * If someone deleted the card by hand, forget it: an "are we playing?" card then gets reposted by
 * the next minute, and later stages simply stop trying to edit it.
 */
export async function refresh(env: Env, day: string) {
  const n = await getNight(env, day);
  if (!n?.message_id) return;
  try {
    await api(env, "PATCH", `/channels/${env.GAME_CHANNEL_ID}/messages/${n.message_id}`, await render(env, day));
  } catch (e) {
    if (!isNotFound(e)) throw e;
    await env.db.update(gameNights).set({ message_id: null }).where(and(eq(gameNights.day, day), eq(gameNights.message_id, n.message_id)));
  }
}

/**
 * A player clicked something. Slow side effects (events, pings) go through `defer` so the
 * interaction can be answered within Discord's 3 seconds.
 */
export async function act(env: Env, day: string, user: string, action: string, value: string | undefined, defer: Defer): Promise<Outcome> {
  const n = await getNight(env, day);
  if (!n) return say("This poll has vanished 🫥");
  if (!players(env).includes(user)) return say("This one's for the trio 😅");
  if (OPEN.includes(n.stage) && isOver(env, n)) {
    // close in the background; the reply below already shows the closed card
    defer(close(env, day, false));
    await advance(env, day, n.stage, "off", { note: closeNote(n.stage) });
    return say("That poll has closed. Start a new one with **/playtoday** 🎮", true);
  }

  switch (action) {
    case "yes":
    case "no":
      if (n.stage !== "ask") return ok;
      await vote(env, day, "ask", user, action);
      break;
    case "game":
      if (n.stage !== "game" || !value) return ok;
      await vote(env, day, "game", user, value);
      break;
    case "suggest": {
      if (n.stage !== "game") return say("Game picking is already over for today.", true);
      const name = await addGame(env, value ?? "", user);
      if (!name) return say("Give the game a name 🙃");
      await vote(env, day, "game", user, name);
      break;
    }
    case "time":
    case "custom": {
      if (n.stage !== "time") return action === "custom" ? say("Time picking is already over for this night.", true) : ok;
      const t = action === "custom" ? parseTime(env, value ?? "", day) : Number(value);
      if (typeof t === "string") return say(t);
      if (!Number.isFinite(t)) return ok;
      if (!onNightDay(env, day, t)) return say("That time isn't on this game night's day 🤔", true);
      if (t < nowSec() + 60) return say(`**${clock(env, t)}** has already passed ⏰ Pick a later time.`, true);
      const mine = (await votes(env, day, "time"))[user];
      // clicking your current pick again takes it back
      if (action === "time" && mine === String(t)) {
        await unvote(env, day, "time", user);
        break;
      }
      const until = (await votes(env, day, "until"))[user];
      if (until && Number(until) - t < MIN_TOGETHER) {
        return say(
          `You said you have to leave by **${timeLabel(env, Number(until), day)}**, so starting at **${timeLabel(env, t, day)}** leaves you under an hour. Change your 🏁 leave-by first if that's moved.`,
        );
      }
      await vote(env, day, "time", user, String(t));
      break;
    }
    case "until": {
      // 🏁 optional "I have to leave by…"; an empty form clears it
      if (n.stage !== "time") return say("Time picking is already over for this night.", true);
      if (!(value ?? "").trim()) {
        await unvote(env, day, "until", user);
        break;
      }
      const t = parseTime(env, value ?? "", day);
      if (typeof t === "string") return say(t);
      if (!onNightDay(env, day, t)) return say("That time isn't on this game night's day 🤔");
      if (t < nowSec() + MIN_TOGETHER) return say(`Leaving by **${clock(env, t)}** doesn't leave time to play 😅 Pick a later time, or tap 🚪 I'm out.`);
      const start = (await votes(env, day, "time"))[user];
      if (start && t - Number(start) < MIN_TOGETHER) {
        return say(
          `Your start is **${timeLabel(env, Number(start), day)}**, so a leave-by of **${timeLabel(env, t, day)}** is under an hour of play. Pick an earlier start first, or a later leave-by.`,
        );
      }
      await vote(env, day, "until", user, String(t));
      break;
    }
    case "out":
      if (n.stage === "set" && (n.start_at ?? 0) < nowSec() - 4 * 3600) return say("That game night is already history 🕰️");
      if (n.stage === "off" || n.stage === "ask") return ok;
      // all of us or none of us: a bail calls it off for everyone, even after the start
      if (await callOff(env, n, { [user]: "out" })) defer(afterBail(env, n));
      return ok;
    case "late": {
      // ⏰ "I'll be late by…" on the locked-in card
      if (n.stage !== "set") return say(n.stage === "off" ? "Game night's off, no need to hurry 🫡" : "Nothing's locked in yet, so you can't be late 😄 Pick a later time instead.");
      const mins = Number(value);
      if (![5, 15, 30, 60].includes(mins)) return ok;
      return runningLate(env, n, user, mins, defer);
    }
    case "reopen": {
      // changed your mind after a cancel? Start that day's poll over (same card, fresh votes)
      if (n.stage !== "off") return ok;
      if (day < local(env).day) return say("That day is over 🕰️ Start a new one with **/playtoday**.");
      const r = await env.db
        .update(gameNights)
        .set({
          stage: "ask",
          stage_at: nowSec(),
          game: null,
          start_at: null,
          event_id: null,
          event_end: null,
          reminded: false,
          note: null,
          conflict: null,
          renudged: null,
          warned: null,
          started_by: user,
          // a roast still waiting for the morning is dropped: they made up
          roast: null,
          roast_due: null,
          roasted_at: null,
          planned_start: null,
        })
        .where(and(eq(gameNights.day, day), eq(gameNights.stage, "off")))
        .returning({ day: gameNights.day });
      if (!r.length) return ok; // someone else reopened it a moment ago
      await env.db.transaction((tx) => clearDay(tx, day));
      await vote(env, day, "ask", user, "yes");
      const when = day === local(env).day ? "tonight" : `on ${weekday(env, day)}`;
      defer(nudge(env, day, players(env).filter((p) => p !== user), `🔄 ${mention(user)} reopened game night. Are you in ${when}? ⬆️`));
      break;
    }
    default:
      return say("That button is from an older version of me. Try **/playtoday** 🤖");
  }
  await settle(env, day, user, defer);
  return { update: true };
}

/**
 * ⏰ Running late. Before the start we wait for everyone (all together or not at all), so the start
 * moves to whoever arrives last: the planned start plus the biggest delay. Tapping your delay again
 * takes it back (and the start moves back). Once the night has started it's an ETA on your slip.
 */
async function runningLate(env: Env, n: Night, user: string, mins: number, defer: Defer): Promise<Outcome> {
  const t = nowSec();
  if (n.start_at! < t - 3 * 3600) return say("That game night is already history 🕰️");
  if (n.reminded) return say(await late.declare(env, n.day, user, mins));
  const planned = n.planned_start ?? n.start_at!;
  const eta = planned + mins * 60;
  const mine = (await late.etas(env, n.day))[user];
  const undo = mine === eta;
  await late.expect(env, n.day, user, undo ? null : eta);
  const etas = Object.values(await late.etas(env, n.day));
  const start = Math.max(planned, ...etas);
  const moved = await env.db
    .update(gameNights)
    .set({ start_at: start, planned_start: planned })
    .where(and(eq(gameNights.day, n.day), eq(gameNights.stage, "set"), eq(gameNights.reminded, false)))
    .returning({ day: gameNights.day });
  if (!moved.length) return say(await late.declare(env, n.day, user, mins)); // it started a moment ago
  const at = (x: number) => timeLabel(env, x, n.day);
  if (start !== n.start_at) defer(startMoved(env, n, start, user, undo ? null : mins));
  if (undo) return say(`✅ Taken back: you'll be on time.${start !== n.start_at ? ` Start's back to **${at(start)}**.` : ""}`, true);
  return say(
    start !== n.start_at
      ? `⏰ Got it. We wait for you: the start moved to **${at(start)}** and the others know.`
      : `⏰ Got it, you'll be there at **${at(eta)}**. The start stays at **${at(start)}** (someone's even later).`,
    true,
  );
}

/** The start moved because someone's late (or isn't any more): the event follows, the others hear. */
async function startMoved(env: Env, n: Night, start: number, user: string, mins: number | null) {
  const at = (x: number) => timeLabel(env, x, n.day);
  if (n.event_id) {
    const evStart = Math.max(start, nowSec() + 60);
    const evEnd = Math.max(n.event_end ?? 0, evStart + 15 * 60);
    await api(env, "PATCH", `/guilds/${env.GUILD_ID}/scheduled-events/${n.event_id}`, {
      scheduled_start_time: new Date(evStart * 1000).toISOString(),
      scheduled_end_time: new Date(evEnd * 1000).toISOString(),
    }).catch((e) => console.log("event move failed", e));
    await env.db.update(gameNights).set({ event_end: evEnd }).where(eq(gameNights.day, n.day));
  }
  // a leave-by that now leaves under an hour together is worth a heads-up
  const until = await votes(env, n.day, "until");
  const end = Object.values(until).length ? Math.min(...Object.values(until).map(Number)) : null;
  const leavers = end === null ? [] : players(env).filter((p) => Number(until[p]) === end);
  const tight =
    end !== null && end - start < MIN_TOGETHER
      ? `\n-# ⚠️ That leaves ${Math.max(0, Math.round((end - start) / 60))} min before ${leavers.map(mention).join(" & ")} ${leavers.length > 1 ? "have" : "has"} to leave (${at(end)}).`
      : "";
  const others = players(env).filter((p) => p !== user);
  const content =
    mins === null
      ? `✅ ${mention(user)} will be on time after all: we start at **${at(start)}** ${ts(start, "R")}${tight}`
      : `⏰ ${mention(user)} is running ${mins === 60 ? "an hour" : `${mins} min`} late, so we start at **${at(start)}** ${ts(start, "R")} instead of ${at(n.start_at!)}${tight}`;
  await api(env, "POST", `/channels/${env.GAME_CHANNEL_ID}/messages`, {
    content,
    allowed_mentions: pings(env, others),
    message_reference: n.message_id ? { message_id: n.message_id, fail_if_not_exists: false } : undefined,
  });
}

/** Moves the night forward if the votes allow it. */
async function settle(env: Env, day: string, actor: string, defer: Defer) {
  const n = (await getNight(env, day))!;
  const ps = players(env);

  if (n.stage === "ask") {
    const v = await votes(env, day, "ask");
    if (ps.every((p) => v[p] === "yes") && (await advance(env, day, "ask", "game"))) {
      defer(nudge(env, day, ps, "✅ Everyone's in! What are we playing? ⬆️"));
    } else if (ps.every((p) => v[p])) {
      // everyone answered and somebody said no: the votes come out, and so do the roasts
      const who = Object.fromEntries(ps.filter((p) => v[p] === "no").map((p) => [p, "no" as Reason]));
      if (await callOff(env, n, who)) defer(postRoast(env, day));
    }
    return;
  }

  if (n.stage === "game") {
    // nothing is decided until everyone's voted (or the deadline calls it off)
    const v = await votes(env, day, "game");
    if (!ps.every((p) => v[p])) return;
    const counts = tally(env, v);
    const top = Math.max(...counts.values());
    const tied = [...counts].filter(([, c]) => c === top).map(([g]) => g);
    if (tied.length === 1) {
      const winner = tied[0];
      if (await advance(env, day, "game", "time", { game: winner })) {
        defer(nudge(env, day, ps, `🗳️ Everyone's voted: ${await emojiFor(env, winner)} **${winner}** it is! When can you start? ⬆️`));
      }
    } else {
      // a split: the picks are revealed (everyone's voted) and it stays open for a re-vote; one
      // ping per night about it
      const claimed = await env.db
        .update(gameNights)
        .set({ renudged: "split" })
        .where(and(eq(gameNights.day, day), eq(gameNights.stage, "game"), or(isNull(gameNights.renudged), ne(gameNights.renudged, "split"))))
        .returning({ day: gameNights.day });
      if (claimed.length) defer(nudge(env, day, ps, "🔁 Split vote! Everyone picked something different. Talk it out and re-vote until two of you agree ⬆️"));
    }
    return;
  }

  if (n.stage === "time") {
    const f = fit(ps, await votes(env, day, "time"), await votes(env, day, "until"), soonest());
    if (!f.ready) return;
    if (f.conflict) {
      // ping the people involved once per distinct clash (not on every click)
      const key = `${f.conflict.leaver}@${f.conflict.leaveBy}/${f.conflict.lateFrom}`;
      const claimed = await env.db
        .update(gameNights)
        .set({ conflict: key })
        .where(and(eq(gameNights.day, day), or(isNull(gameNights.conflict), ne(gameNights.conflict, key))))
        .returning({ day: gameNights.day });
      const who = [...new Set([f.conflict.leaver, ...f.conflict.late])].filter((p) => p !== actor);
      if (claimed.length && who.length) {
        defer(nudge(env, day, who, "⚠️ The times don't fit together yet. Take a look ⬆️"));
      }
      return;
    }
    if (await advance(env, day, "time", "set", { start_at: f.start! })) defer(lockIn(env, day));
  }
}

/** If everyone's picks have already passed, start a few minutes from now instead. */
const soonest = () => Math.ceil((nowSec() + 120) / 300) * 300;

/** A time belongs to a night if it's on that day or in the small hours after it. */
function onNightDay(env: Env, day: string, t: number) {
  const [y, mo, d] = day.split("-").map(Number);
  const dayStart = wallToUnix(env, y, mo, d, 0, 0);
  return t >= dayStart && t <= dayStart + 30 * 3600;
}

/** "👻 Phasmophobia", using each game's emoji. */
export async function gameLabel(env: Env) {
  const list = await env.db.select({ name: gameTable.name, emoji: gameTable.emoji }).from(gameTable);
  const emoji = new Map(list.map((g) => [g.name.toLowerCase(), g.emoji]));
  return (g: string) => `${emoji.get(g.toLowerCase()) ?? "🎮"} ${g}`;
}

/**
 * Stage changes only edit the card, which doesn't notify anyone. When a stage needs someone's
 * input, ping them once; the previous nudge is deleted so the channel stays tidy.
 */
async function nudge(env: Env, day: string, who: string[], content: string) {
  const n = (await getNight(env, day))!;
  await clearNudge(env, n);
  if (!who.length) return;
  const m = await api(env, "POST", `/channels/${env.GAME_CHANNEL_ID}/messages`, {
    content: `${who.map(mention).join(" ")} ${content}`,
    allowed_mentions: pings(env, who),
    message_reference: n.message_id ? { message_id: n.message_id, fail_if_not_exists: false } : undefined,
  });
  await env.db.update(gameNights).set({ nudge_id: m.id }).where(eq(gameNights.day, day));
}

async function clearNudge(env: Env, n: Night) {
  if (!n.nudge_id) return;
  await api(env, "DELETE", `/channels/${env.GAME_CHANNEL_ID}/messages/${n.nudge_id}`).catch(() => {});
  await env.db.update(gameNights).set({ nudge_id: null }).where(and(eq(gameNights.day, n.day), eq(gameNights.nudge_id, n.nudge_id)));
}

/** The night is set: create a Discord event and ping everyone once. */
async function lockIn(env: Env, day: string) {
  const n = (await getNight(env, day))!;
  const ps = players(env);
  await clearNudge(env, n);
  try {
    const start = n.start_at! * 1000;
    const until = Object.values(await votes(env, day, "until")).map(Number);
    const end = until.length ? Math.min(...until) * 1000 : start + 3 * 3600e3;
    const evStart = Math.max(start, Date.now() + 60e3);
    const evEnd = Math.max(end, evStart + 15 * 60e3);
    const ev = await api(env, "POST", `/guilds/${env.GUILD_ID}/scheduled-events`, {
      name: `${await emojiFor(env, n.game!)} ${n.game}`,
      description: `Terrible Trio game night: ${n.game}. Planned by Meme Bot 3000.`,
      privacy_level: 2,
      entity_type: 3,
      entity_metadata: { location: "Terrible Trio 🔊" },
      scheduled_start_time: new Date(evStart).toISOString(),
      scheduled_end_time: new Date(evEnd).toISOString(),
    });
    await env.db.update(gameNights).set({ event_id: ev.id, event_end: Math.floor(evEnd / 1000) }).where(eq(gameNights.day, day));
    await refresh(env, day);
  } catch (e) {
    console.log("event failed", e); // the night still happens; the card just has no event link
  }
  await api(env, "POST", `/channels/${env.GAME_CHANNEL_ID}/messages`, {
    content: `🎉 ${ps.map(mention).join(" ")} it's on! ${await emojiFor(env, n.game!)} **${n.game}** ${day === local(env).day ? "at" : "on"} ${ts(n.start_at!, day === local(env).day ? "t" : "f")} (${ts(n.start_at!, "R")})`,
    allowed_mentions: pings(env, ps),
    message_reference: n.message_id ? { message_id: n.message_id, fail_if_not_exists: false } : undefined,
  });
}

// ---------------------------------------------------------------- 🔥 deadlines and roasts

/** Unix seconds for MORNING on the local day of `t`. */
function morningOf(env: Env, t: number) {
  const l = local(env, new Date(t * 1000));
  return wallToUnix(env, l.y, l.m, l.d, MORNING.hour, MORNING.minute);
}

/** Moves a time out of the small hours (00:00 until MORNING) to MORNING. */
function awakeTime(env: Env, t: number) {
  return t < morningOf(env, t) ? morningOf(env, t) : t;
}

/**
 * When the current stage's vote closes: 3 h after it opened, but a night planned for a later day
 * gets until at least noon on the day itself, and nothing closes in the small hours (it waits
 * until 09:30, after the 09:00 last call).
 */
export function voteDeadline(env: Env, n: Pick<Night, "day" | "stage_at">) {
  const opened = n.stage_at ?? nowSec();
  let t = opened + VOTE_WINDOW;
  if (n.day > local(env, new Date(opened * 1000)).day) {
    const [y, m, d] = n.day.split("-").map(Number);
    t = Math.max(t, wallToUnix(env, y, m, d, 12, 0));
  }
  return awakeTime(env, t);
}

const REASON: Record<Reason, string> = { no: "❌ said no", ghost: "👻 didn't vote in time", out: "🚪 bailed" };

function blame(who: Record<string, Reason>) {
  return Object.entries(who)
    .map(([u, r]) => `${mention(u)} ${REASON[r]}`)
    .join(" · ");
}

/**
 * Call the night off (once: compare-and-set on the stage), with the culprits recorded for the roast.
 * The roast posts right away, or at 09:30 if it happened in the small hours. With nobody to
 * blame (say, the day simply ended) it just closes.
 */
async function callOff(env: Env, n: Night, who: Record<string, Reason>, note?: string) {
  const anyone = Object.keys(who).length > 0;
  const text = note ?? (anyone ? `🔥 Called off: ${blame(who)}.` : closeNote(n.stage));
  if (!(await advance(env, n.day, n.stage, "off", { note: text }))) return false;
  if (anyone) {
    await env.db
      .update(gameNights)
      .set({ roast: { who, stage: n.stage }, roast_due: awakeTime(env, nowSec()), roasted_at: null })
      .where(eq(gameNights.day, n.day));
  }
  await clearNudge(env, (await getNight(env, n.day))!);
  return true;
}

/**
 * Someone bailed: ends the night's Discord event (deleted if it hadn't started, marked ended if it
 * had), retires everyone's late slips, and posts the roast.
 */
async function afterBail(env: Env, n: Night) {
  if (n.event_id) {
    const live = n.reminded || (n.start_at ?? Infinity) <= nowSec();
    await (live
      ? api(env, "PATCH", `/guilds/${env.GUILD_ID}/scheduled-events/${n.event_id}`, { status: 3 })
      : api(env, "DELETE", `/guilds/${env.GUILD_ID}/scheduled-events/${n.event_id}`)
    ).catch(() => {});
  }
  await late.retireSlips(env, n.day).catch((e) => console.log("retire slips failed", e));
  await postRoast(env, n.day);
}

/** A late slip's 😴: same as 🚪, the whole night is off. */
export async function bailFromSlip(env: Env, day: string, user: string) {
  const n = await getNight(env, day);
  if (n?.stage !== "set") return false;
  if (!(await callOff(env, n, { [user]: "out" }))) return false;
  await refresh(env, day);
  await afterBail(env, n);
  return true;
}

/** Post a night's roast if it's due (exactly once: claimed in the database first). */
export async function postRoast(env: Env, day: string) {
  const claimed = await env.db
    .update(gameNights)
    .set({ roasted_at: nowSec() })
    .where(and(eq(gameNights.day, day), eq(gameNights.stage, "off"), sql`${gameNights.roast} IS NOT NULL`, isNull(gameNights.roasted_at), lte(gameNights.roast_due, nowSec())))
    .returning();
  const n = claimed[0];
  if (!n?.roast) return false;
  const ps = players(env);
  const culprits = Object.keys(n.roast.who);
  const when = n.day === local(env).day ? "tonight's" : `${weekday(env, n.day)}'s`;
  const what = n.roast.stage === "set" && n.game ? `${await emojiFor(env, n.game)} ${n.game} ${n.day === local(env).day ? "tonight" : `on ${weekday(env, n.day)}`}` : `${when} game night`;
  const head = culprits.length >= ps.length && ps.every((p) => n.roast!.who[p]) ? `🔥 **Nobody's in, so ${what} is off**` : `🔥 **${what[0].toUpperCase()}${what.slice(1)} is off** · ${blame(n.roast.who)}`;
  try {
    await api(env, "POST", `/channels/${env.GAME_CHANNEL_ID}/messages`, {
      content: `${head}\n> ${await roasts.next(env, culprits)}`,
      // everyone hears it's off; the culprits are named in it
      allowed_mentions: pings(env, ps),
      message_reference: n.message_id ? { message_id: n.message_id, fail_if_not_exists: false } : undefined,
    });
    return true;
  } catch (e) {
    await env.db.update(gameNights).set({ roasted_at: null }).where(eq(gameNights.day, day)); // the next minute retries
    throw e;
  }
}

/** Every minute: roasts that were held for the morning. */
export async function dueRoasts(env: Env) {
  const due = await env.db
    .select({ day: gameNights.day })
    .from(gameNights)
    .where(and(eq(gameNights.stage, "off"), sql`${gameNights.roast} IS NOT NULL`, isNull(gameNights.roasted_at), lte(gameNights.roast_due, nowSec())));
  const posted: string[] = [];
  for (const { day } of due) if (await postRoast(env, day)) posted.push(day);
  return posted;
}

/** Who sinks the night if the vote closed now: no-votes (asking stage) plus anyone who hasn't voted. */
async function culprits(env: Env, n: Night) {
  const v = await votes(env, n.day, n.stage);
  const who: Record<string, Reason> = {};
  for (const p of players(env)) {
    if (!v[p]) who[p] = "ghost";
    else if (n.stage === "ask" && v[p] === "no") who[p] = "no";
  }
  return { who, missing: players(env).filter((p) => !v[p]) };
}

/**
 * Every minute: keep open cards fresh (drops start times that just passed), ping
 * anyone who's left a stage waiting for an hour (once per stage), and ping the squad when a
 * locked-in night starts.
 */
export async function maintain(env: Env) {
  const t = nowSec();
  const done: Record<string, unknown> = {};
  const open = await env.db
    .select()
    .from(gameNights)
    .where(and(gte(gameNights.day, local(env).day), inArray(gameNights.stage, OPEN), sql`${gameNights.message_id} IS NOT NULL`));

  // reminders wait for daytime: nobody gets pinged about a poll between midnight and 09:00
  const awake = local(env).hour >= 9;
  for (const n of open) {
    // one night's trouble (say, a card deleted by hand) must not hold up the others
    try {
      await maintainNight(env, n, t, awake, done);
    } catch (e) {
      console.log("maintain night failed", n.day, e);
      done[`failed ${n.day}`] = String(e).slice(0, 120);
    }
  }

  // a start the timer missed (say, the bot was restarting at that moment): catch up within 30 min
  const due = await env.db
    .select()
    .from(gameNights)
    .where(and(eq(gameNights.stage, "set"), eq(gameNights.reminded, false), lte(gameNights.start_at, t)));
  for (const n of due) if (n.start_at! >= t - 1800 && (await claimStart(env, n))) done.reminded = n.day;
  return done;
}

/**
 * Starts due by `until` (unix seconds): wait for them, open the room a few seconds early, then
 * move everyone and ping at the exact start time. The scheduler calls this every minute for the
 * next two; the claim in claimStart makes overlapping calls harmless.
 */
export async function preciseStarts(env: Env, until: number) {
  const started: string[] = [];
  await Promise.all((await upcomingStarts(env, until)).map(async (n) => (await startOnTime(env, n)) && started.push(n.day)));
  return started;
}

/** Locked-in nights starting after now and by `until` (unix seconds) that haven't started yet. */
export const upcomingStarts = (env: Env, until: number) =>
  env.db
    .select()
    .from(gameNights)
    .where(and(eq(gameNights.stage, "set"), eq(gameNights.reminded, false), gt(gameNights.start_at, nowSec()), lte(gameNights.start_at, until)));

/** Wait until just before the night's start, then run it on the dot (unless it was cancelled or moved meanwhile). */
export async function startOnTime(env: Env, n: Night, signal?: AbortSignal) {
  await sleepUntil((n.start_at! - ROOM_EARLY) * 1000, signal);
  if (signal?.aborted) return false; // shutting down: the next leader (or the minute job) starts it
  const fresh = await getNight(env, n.day);
  if (fresh?.stage !== "set" || fresh.start_at !== n.start_at) return false;
  return claimStart(env, fresh, fresh.start_at! * 1000);
}

/** Claim the start (once, whoever gets there first), then run it; a failure releases the claim. */
async function claimStart(env: Env, n: Night, at?: number) {
  const claimed = await env.db
    .update(gameNights)
    .set({ reminded: true })
    .where(and(eq(gameNights.day, n.day), eq(gameNights.stage, "set"), eq(gameNights.reminded, false)))
    .returning({ day: gameNights.day });
  if (!claimed.length) return false;
  try {
    await startReminder(env, n, at);
    // a night counts as played once it actually starts (a locked-in night can still be called off)
    await env.db.update(gameTable).set({ plays: sql`${gameTable.plays} + 1` }).where(eq(gameTable.name, n.game!));
    return true;
  } catch (e) {
    // the ping didn't go out: release the claim so the next minute tries again
    console.log("start reminder failed", n.day, e);
    await env.db.update(gameNights).set({ reminded: false }).where(eq(gameNights.day, n.day));
    return false;
  }
}

/**
 * It's time: open the room, then (at `at`, epoch ms, when given) move the Lobby in, make the
 * event live and ping the squad.
 */
async function startReminder(env: Env, n: Night, at?: number) {
  const ps = players(env);
  const emoji = await emojiFor(env, n.game!);
  // open the game's voice room and bring the Lobby along; the ping still goes out if this fails
  let where = "Hop in 🔊";
  const room = await voice.openRoom(env, n.game!, emoji, { day: n.day, move: false }).catch((e) => (console.log("room failed", e), null));
  if (at) await sleepUntil(at);
  // external events don't go live on their own
  const live = n.event_id
    ? api(env, "PATCH", `/guilds/${env.GUILD_ID}/scheduled-events/${n.event_id}`, { status: 2 }).catch((e) => console.log("event start", e))
    : null;
  if (room) {
    const moved = await voice.moveFromLobby(env, room.channelId).catch((e) => (console.log("lobby move failed", e), [] as string[]));
    await late.markArrived(env, n.day, moved);
    where = `Room: <#${room.channelId}>${moved.length ? ` (moved ${moved.map(mention).join(" ")} from the Lobby)` : ""}`;
  }
  await live;
  await api(env, "POST", `/channels/${env.GAME_CHANNEL_ID}/messages`, {
    content: `⏰ ${ps.map(mention).join(" ")} ${emoji} **${n.game}** starts now! ${where}`,
    allowed_mentions: pings(env, ps),
    message_reference: n.message_id ? { message_id: n.message_id, fail_if_not_exists: false } : undefined,
  });
}

async function maintainNight(env: Env, n: Night, t: number, awake: boolean, done: Record<string, unknown>) {
  {
    // drop start times that just passed (every 15 min is plenty; the tick runs every minute)
    if (n.stage === "time" && local(env).minute % 15 === 0) await refresh(env, n.day);
    const { who, missing } = await culprits(env, n);
    const deadline = voteDeadline(env, n);
    // everyone voted for a game but it's split: the clock still runs, for all three
    const split = n.stage === "game" && !missing.length;
    if (split && t >= deadline) {
      if (await callOff(env, n, {}, "🤷 We couldn't agree on a game in time. Maybe tomorrow 🫡")) {
        await refresh(env, n.day);
        done[`split ran out ${n.day}`] = true;
      }
      return;
    }
    if (split && awake && t >= deadline - WARN_BEFORE && n.warned !== n.stage) {
      const claimed = await env.db
        .update(gameNights)
        .set({ warned: n.stage })
        .where(and(eq(gameNights.day, n.day), eq(gameNights.stage, n.stage), or(isNull(gameNights.warned), ne(gameNights.warned, n.stage))))
        .returning({ day: gameNights.day });
      if (claimed.length) {
        const left = Math.max(1, Math.round((deadline - t) / 60));
        await nudge(env, n.day, players(env), `⏳ Still split: ${left} min for two of you to agree on a game, or the night's off ⬆️`);
        done[`warned ${n.day}`] = "split";
      }
      return;
    }
    if (missing.length && t >= deadline) {
      // 🔥 time's up: the votes come out, the night's off, and whoever sank it gets roasted
      if (await callOff(env, n, who)) {
        await refresh(env, n.day);
        await postRoast(env, n.day);
        done[`called off ${n.day}`] = who;
      }
      return;
    }
    if (awake && missing.length && t >= deadline - WARN_BEFORE && n.warned !== n.stage) {
      const claimed = await env.db
        .update(gameNights)
        .set({ warned: n.stage })
        .where(and(eq(gameNights.day, n.day), eq(gameNights.stage, n.stage), or(isNull(gameNights.warned), ne(gameNights.warned, n.stage))))
        .returning({ day: gameNights.day });
      if (claimed.length) {
        const left = Math.max(1, Math.round((deadline - t) / 60));
        await nudge(env, n.day, missing, `⏳ Last call: ${left} min to vote, or game night's off and you get roasted 🔥 ⬆️`);
        done[`warned ${n.day}`] = missing;
      }
      return;
    }
    const v = await votes(env, n.day, n.stage);
    if (awake && missing.length && n.renudged !== n.stage && t - (n.stage_at ?? t) >= RENUDGE_AFTER) {
      const claimed = await env.db
        .update(gameNights)
        .set({ renudged: n.stage })
        .where(and(eq(gameNights.day, n.day), eq(gameNights.stage, n.stage), or(isNull(gameNights.renudged), ne(gameNights.renudged, n.stage))))
        .returning({ day: gameNights.day });
      if (claimed.length) {
        const when = n.day === local(env).day ? "tonight" : `on ${weekday(env, n.day)}`;
        const ask = { ask: `are you in ${when}?`, game: "pick a game so we can get going", time: "when can you start?" }[n.stage as "ask"];
        await nudge(env, n.day, missing, `⏳ still waiting on you: ${ask} ⬆️`);
        done[`renudged ${n.day}`] = missing;
      }
    }
  }
}

/** Private heads-up after a click, when we also re-render the card. */
export const notify = (env: Env, token: string, notice: string) => followup(env, token, { content: notice, flags: EPHEMERAL });

// ---------------------------------------------------------------- rendering

async function emojiFor(env: Env, game: string) {
  const [g] = await env.db.select({ emoji: gameTable.emoji }).from(gameTable).where(eq(gameTable.name, game));
  return g?.emoji ?? "🎮";
}

const text = (content: string) => ({ type: 10, content });
const row = (...components: unknown[]) => ({ type: 1, components });
const button = (style: number, emoji: string | null, label: string, custom_id: string) => ({
  type: 2,
  style,
  label,
  custom_id,
  ...(emoji ? { emoji: { name: emoji } } : {}),
});
const rows = (buttons: unknown[]) => Array.from({ length: Math.ceil(buttons.length / 5) }, (_, i) => row(...buttons.slice(i * 5, i * 5 + 5)));

/**
 * The card. With a `viewer` it's their private copy: their picks highlighted, plus `notice` (what
 * just happened) on top. Without one it's the public card everyone sees.
 */
export async function render(env: Env, day: string, viewer?: string, notice?: string) {
  const n = (await getNight(env, day))!;
  const ps = players(env);
  const me = viewer && ps.includes(viewer) ? viewer : null;
  const date = ts(Math.floor(Date.parse(`${day}T12:00:00Z`) / 1000), "D");
  const id = (action: string) => `gn:${day}:${action}`;
  const out = button(2, "🚪", "I'm out", id("out"));
  const starter = n.started_by ? ` · ${day > local(env).day ? "planned" : "started"} by ${mention(n.started_by)}` : "";
  const deadline = voteDeadline(env, n);
  const closes = `-# ⏳ Vote by ${ts(deadline, day === local(env).day ? "t" : "f")} (${ts(deadline, "R")}). No vote by then = night's off and you get roasted 🔥`;
  let body: unknown[];

  switch (n.stage) {
    case "ask": {
      const v = await votes(env, day, "ask");
      const today = day === local(env).day;
      const hidden = await secret(env, n);
      // revealed means everyone answered and someone can't (all yes would have moved on)
      const status = hidden
        ? `🤫 Answers stay secret until everyone's answered · waiting on ${ps.filter((p) => !v[p]).length} more · it's on when all ${ps.length} say yes`
        : `😴 Not ${today ? "tonight" : "that day"}… unless someone changes their mind (answers can change until the end of ${today ? "today" : weekday(env, day)}).`;
      const mark = (p: string) => (!v[p] ? "⏳" : hidden ? "🗳️" : v[p] === "yes" ? "✅" : "❌");
      body = [
        text(`## 🎮 Game night? · ${date}\n### ${today ? "Are we playing today?" : `📅 Are we playing on ${weekday(env, day)}?`}`),
        text(ps.map((p) => `${mark(p)} ${mention(p)}`).join("　")),
        text(`-# ${status}${starter}${hidden ? `\n${closes}` : ""}`),
        // your answer stays coloured, the other one greys out
        row(
          button(me && v[me] === "no" ? 2 : 3, "✅", "I'm in", id("yes")),
          button(me && v[me] === "yes" ? 2 : 4, "✖️", today ? "Not today" : "Can't", id("no")),
        ),
      ];
      break;
    }
    case "game": {
      const v = await votes(env, day, "game");
      const list = await games(env);
      // everyone's voted and we're still here: it's split, so the picks are out and you re-vote
      const split = ps.every((p) => v[p]);
      const picks = split ? await gameVotesLine(env, day) : null;
      body = [
        text(`## 🕹️ What are we playing? · ${date}\n${split ? "### 🔁 Split vote! Re-vote until two of you agree" : `✅ All ${ps.length} are in!`}`),
        text(split ? `🗳️ ${picks}` : ps.map((p) => `${v[p] ? "🗳️" : "⏳"} ${mention(p)}`).join("　")),
        text(
          split
            ? `-# Everyone picked something different. Talk it out, then pick again: two of you on the same game and it's settled.\n${closes.replace("No vote by then = night's off and you get roasted 🔥", "Still split by then = night's off")}`
            : `-# 🤫 Votes stay secret until everyone's voted · then most votes wins · a split means a re-vote\n${closes}`,
        ),
        // a dropdown needs at least one option; with an empty game list, suggesting is the way in
        ...(list.length
          ? [
              row({
                type: 3,
                custom_id: id("game"),
                placeholder: split ? "🔁 Change your pick…" : "🎯 Pick a game…",
                options: list.map((g) => ({
                  label: g.name,
                  value: g.name,
                  emoji: { name: g.emoji ?? "🎮" },
                  description: g.plays ? `Played ${g.plays}×` : undefined,
                  // your vote shows as picked
                  default: !!me && v[me]?.toLowerCase() === g.name.toLowerCase(),
                })),
              }),
            ]
          : [text("*The game list is empty. ➕ Suggest one!*")]),
        row(button(1, "➕", "Suggest a game", id("suggest")), out),
      ];
      break;
    }
    case "time": {
      const v = await votes(env, day, "time");
      const until = await votes(env, day, "until");
      const f = fit(ps, v, until, soonest());
      const at = (t: number) => `**${timeLabel(env, t, day)}**`;
      const hidden = await secret(env, n);
      const lead = f.start === null || hidden ? null : Math.max(...ps.filter((p) => v[p]).map((p) => Number(v[p])));
      const lines = hidden ? [ps.map((p) => `${v[p] ? "🗳️" : "⏳"} ${mention(p)}`).join("　")] : ps.map((p) => {
        const leave = until[p] ? ` · 🏁 leaves ${at(Number(until[p]))}` : "";
        return v[p] ? `🕐 ${mention(p)} from ${at(Number(v[p]))}${leave}` : `⏳ ${mention(p)}${leave}`;
      });
      const waiting = ps.filter((p) => !v[p]);
      const leaver = f.end !== null ? ps.find((p) => Number(until[p]) === f.end)! : null;
      const deadline = f.end !== null ? ` · start by ${at(f.end - MIN_TOGETHER)} so we get an hour before ${mention(leaver!)} leaves` : "";
      let status: string;
      if (hidden) {
        // a leave-by is shown without its owner, so nobody picks a start that's too late
        const who = me && Number(until[me]) === f.end ? "You have" : "Someone has";
        const limit = f.end !== null ? `\n-# 🏁 ${who} to leave by ${at(f.end)}, so start by ${at(f.end - MIN_TOGETHER)} to get an hour together.` : "";
        status = `-# 🤫 Picks stay secret until everyone's chosen · tap the earliest time you can start (tap again to take it back) · have to leave early? Tap 🏁 Leave by${limit}`;
      } else if (f.conflict) {
        const c = f.conflict;
        status = [
          `### ⚠️ Doesn't fit yet`,
          c.bumped
            ? `${mention(c.leaver)} has to leave by ${at(c.leaveBy)}, but the earliest we can still start is ${at(f.start!)}. That's under an hour together.`
            : `${mention(c.leaver)} has to leave by ${at(c.leaveBy)}, but ${c.late.map(mention).join(" & ")} can't start before ${at(c.lateFrom)}. That's under an hour together.`,
          `-# Fix it: pick an earlier start, push your 🏁 leave-by, or tap 🚪 I'm out.`,
        ].join("\n");
      } else if (f.start === null) {
        status = `-# Tap the earliest time you can start (tap again to take it back). Have to leave early? Tap 🏁 Leave by.${deadline}`;
      } else if (!f.ready) {
        status = `-# So far we'd start at ${at(f.start)}${f.end !== null ? ` and play until ${at(f.end)}` : ""} · waiting on ${waiting.map(mention).join(" ")}${deadline}`;
      } else {
        status = `-# Starting at ${at(f.start)}`;
      }
      // while secret, custom picks get no button of their own (that would give them away), except
      // your own on your private copy
      const shown = hidden ? (me && v[me] ? { [me]: v[me] } : {}) : v;
      const mine = me ? Number(v[me]) : null;
      const times = timeOptions(env, n, shown).map((t) => {
        const count = hidden ? 0 : ps.filter((p) => v[p] === String(t)).length;
        const style = me ? (t === mine ? 3 : 2) : t === lead ? 3 : 2;
        const b = button(style, null, `${timeLabel(env, t, day)}${count ? ` · ${count}` : ""}`, id(`time:${t}`));
        // on your copy, starts that leave you under an hour before your own 🏁 leave-by are greyed out
        const tooLate = me && until[me] && Number(until[me]) - t < MIN_TOGETHER && t !== mine;
        return tooLate ? { ...b, disabled: true } : b;
      });
      const myLeave = me && until[me] ? `Leave by ${timeLabel(env, Number(until[me]), day)}` : "Leave by";
      // the game vote is decided, so it's revealed
      const gameVotes = n.note ? null : await gameVotesLine(env, day);
      const notes = [...(gameVotes ? [`🗳️ ${gameVotes}`] : []), ...(n.note ? n.note.split("\n") : [])];
      body = [
        text(`## ⏰ What time? · ${date}\n${notes.map((l) => `-# ${l}\n`).join("")}### ${await emojiFor(env, n.game!)} ${n.game} it is!`),
        text(`Pick the **earliest** time you can start. We kick off when everyone's ready.\n${lines.join("\n")}`),
        text(`${status}${f.ready ? "" : `\n${closes}`}`),
        ...rows([...times, button(1, "✏️", "Other time", id("custom")), button(me && until[me] ? 1 : 2, "🏁", myLeave, id("leaveby")), out]),
      ];
      break;
    }
    case "set": {
      // different times aren't a tie: we start when the last person is free. Credit them.
      const v = await votes(env, day, "time");
      const picks = ps.filter((p) => v[p]).map((p) => Number(v[p]));
      const latest = Math.max(...picks);
      const slowpokes = ps.filter((p) => Number(v[p]) === latest);
      const flavour =
        picks.length === ps.length && Math.min(...picks) < latest
          ? `\n-# 🐢 Slowpoke of the night: ${slowpokes.map(mention).join(" & ")} (free from ${timeLabel(env, latest, day)}). Everyone else, warm up!`
          : "";
      const until = await votes(env, day, "until");
      const end = Object.values(until).length ? Math.min(...Object.values(until).map(Number)) : null;
      const leavers = end === null ? [] : ps.filter((p) => Number(until[p]) === end);
      const timeVotes = await timeVotesLine(env, day);
      const gameVotes = await gameVotesLine(env, day);
      const endLine = end === null ? "" : `\n🏁 until **${timeLabel(env, end, day)}** (${leavers.map(mention).join(" & ")} ${leavers.length > 1 ? "have" : "has"} to leave)`;
      // ⏰ who said they'd be late (before the start; after it, their slips say it)
      const lateBy = n.reminded ? {} : await late.etas(env, day);
      const planned = n.planned_start ?? n.start_at!;
      const lateLine = Object.keys(lateBy).length
        ? `\n⏰ Running late: ${ps
            .filter((p) => lateBy[p])
            .map((p) => `${mention(p)} +${Math.round((lateBy[p] - planned) / 60)} min`)
            .join(" · ")}${planned !== n.start_at ? ` · start moved from ${timeLabel(env, planned, day)}` : ""}`
        : "";
      const history = n.start_at! < nowSec() - 3 * 3600;
      body = [
        text(`## 🎉 Game night is ON · ${date}`),
        text(
          `### ${await emojiFor(env, n.game!)} ${n.game}\n🕐 **${timeLabel(env, n.start_at!, day)}** · ${ts(n.start_at!, "R")}${endLine}${lateLine}\n👥 ${timeVotes ?? ps.map(mention).join(" ")}${flavour}`,
        ),
        ...(gameVotes ? [text(`-# 🗳️ ${gameVotes}`)] : []),
        ...(history
          ? []
          : [
              text(n.reminded ? "-# ⏰ Running late? Tap your ETA:" : "-# ⏰ Running late? Tap how late. We'll wait for you, so the start moves for everyone (tap again to take it back):"),
              row(...[5, 15, 30, 60].map((m) => button(2, "🏃", m === 60 ? "+1 h" : `+${m} min`, id(`late:${m}`)))),
            ]),
        row(
          ...(n.event_id
            ? [{ type: 2, style: 5, emoji: { name: "📅" }, label: "Event", url: `https://discord.com/events/${env.GUILD_ID}/${n.event_id}` }]
            : []),
          button(2, "🚪", "Can't make it", id("out")),
        ),
      ];
      break;
    }
    case "off":
      body = [
        text(`## 😴 No game night · ${date}`),
        text(n.note ?? "Maybe tomorrow 🫡"),
        ...(await revealOff(env, day)),
        // still today (or a planned day ahead): let anyone who changed their mind start it over
        ...(day >= local(env).day ? [row(button(2, "🔄", "Changed our minds? Reopen", id("reopen")))] : []),
      ];
      break;
  }
  if (me) {
    body = [
      ...(notice ? [text(notice)] : []),
      ...body,
      text("-# 🔒 Your private copy: your picks are highlighted, and tapping here works just like the card. Only you can see this."),
    ];
  }
  return {
    flags: IS_COMPONENTS_V2 | (me ? EPHEMERAL : 0),
    allowed_mentions: { parse: [] },
    components: [{ type: 17, accent_color: COLORS[n.stage], components: body }],
  };
}

/** Ephemeral "which day?" picker for planning ahead: today plus the next 6 days. */
export async function planPicker(env: Env) {
  const today = local(env).day;
  const days = Array.from({ length: 7 }, (_, i) => new Date(Date.parse(`${today}T12:00:00Z`) + i * 864e5).toISOString().slice(0, 10));
  const existing = await env.db
    .select({ day: gameNights.day, stage: gameNights.stage })
    .from(gameNights)
    .where(and(gte(gameNights.day, days[0]), lte(gameNights.day, days[6])));
  const has = new Map(existing.map((n) => [n.day, n.stage]));
  const mark: Record<Stage, string> = { ask: "🗳️", game: "🕹️", time: "⏰", set: "🎉", off: "😴" };
  const buttons = days.map((d, i) => {
    const label = i === 0 ? "Today" : i === 1 ? "Tomorrow" : `${weekday(env, d).slice(0, 3)} ${Number(d.slice(8))}`;
    const stage = has.get(d);
    return button(stage ? 2 : 1, stage ? mark[stage] : null, label, `plan:${d}`);
  });
  return {
    flags: IS_COMPONENTS_V2 | EPHEMERAL,
    components: [
      {
        type: 17,
        accent_color: COLORS.ask,
        components: [
          text("## 📅 Plan a game night\nPick a day and I'll post its poll in the game-night channel, with your ✅ already in."),
          text("-# Days with an icon already have a poll, so tapping them just links to it. One poll per day, always."),
          ...rows(buttons),
        ],
      },
    ],
  };
}

const modal = (custom_id: string, title: string, input: object) => ({
  custom_id,
  title,
  components: [{ type: 1, components: [{ type: 4, custom_id: "value", style: 1, required: true, ...input }] }],
});

export const suggestModal = (day: string) =>
  modal(`gn:${day}:suggest`, "Suggest a game", { label: "Game name", placeholder: "Lethal Company", max_length: 60 });

export const customTimeModal = (day: string) =>
  modal(`gn:${day}:custom`, "Pick your own start time", { label: "Earliest time you can start (HH:MM)", placeholder: "20:15", max_length: 5 });

/** 🏁 "I have to leave by…", prefilled with your current one; submitting it empty clears it. */
export async function leaveByModal(env: Env, day: string, user: string) {
  const current = (await votes(env, day, "until"))[user];
  return modal(`gn:${day}:until`, "When do you have to leave?", {
    label: "Leave by (HH:MM). Leave empty for no limit",
    placeholder: "22:30",
    max_length: 5,
    required: false,
    ...(current ? { value: clock(env, Number(current)) } : {}),
  });
}

/** Testing/maintenance: wipe a day's night (card, nudge, event, votes). */
export async function resetNight(env: Env, day: string) {
  const n = await getNight(env, day);
  if (!n) return { reset: false };
  if (n.message_id) await api(env, "DELETE", `/channels/${env.GAME_CHANNEL_ID}/messages/${n.message_id}`).catch(() => {});
  await clearNudge(env, n);
  if (n.event_id) await api(env, "DELETE", `/guilds/${env.GUILD_ID}/scheduled-events/${n.event_id}`).catch(() => {});
  await env.db.transaction(async (tx) => {
    await clearDay(tx, day);
    await tx.delete(gameNights).where(eq(gameNights.day, day));
  });
  return { reset: true };
}

/** A day's votes and attendance (reopen and reset start the day over). */
async function clearDay(tx: Tx, day: string) {
  await tx.delete(gameNightVotes).where(eq(gameNightVotes.day, day));
  await tx.delete(nightAttendance).where(eq(nightAttendance.day, day));
}
