// Daily game-night planner: one card per day that walks through three stages.
//   ask  → "Are we playing today?" (needs every player to say yes)
//   game → pick a game (first to a majority wins; an all-different split is settled by dice)
//   time → everyone picks the earliest time they can start; we start at the latest of those
//   set  → locked in: Discord event + one ping now and one at start time
//   off  → someone bailed, or the day ended before we agreed
//
// One row per local (Europe/Vilnius) day. Its PRIMARY KEY is the only thing that decides whether
// a poll gets posted, so the 17:00 cron, /playtoday and retries can never produce two polls.
import type { Env } from "./index";
import { api, followup, EPHEMERAL, IS_COMPONENTS_V2 } from "./discord";
import { now } from "./db";
import * as tiebreak from "./tiebreak";

type Stage = "ask" | "game" | "time" | "set" | "off";
export interface Night {
  day: string;
  stage: Stage;
  message_id: string | null;
  game: string | null;
  start_at: number | null;
  event_id: string | null;
  reminded: number;
  note: string | null;
  nudge_id: string | null;
  started_by: string | null; // null = the 17:00 schedule
  stage_at: number | null; // unix seconds the current stage began
  renudged: string | null; // stage whose "still waiting on you" ping was sent
  conflict: string | null; // the time clash we last pinged about, so we ping once per clash
}
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

export const players = (env: Env) => env.PLAYERS.split(",").map((s) => s.trim()).filter(Boolean);
const majority = (env: Env) => Math.floor(players(env).length / 2) + 1;
const mention = (id: string) => `<@${id}>`;
/** QUIET is set by the admin test route so simulated runs don't notify anyone. */
const pings = (env: Env, users: string[]) => (env.QUIET ? { parse: [] } : { users });
const ts = (sec: number, style: string) => `<t:${sec}:${style}>`;
const nowSec = () => Math.floor(Date.now() / 1000);
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
  const voted = Object.values(v).map(Number).filter((s) => s > t);
  return [...new Set([...presets, ...voted])].sort((a, b) => a - b).slice(0, 8);
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
  if (+m[1] < 6 && (!today || t < nowSec())) t += 86400;
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

const getNight = (env: Env, day: string) => env.DB.prepare("SELECT * FROM game_nights WHERE day = ?").bind(day).first<Night>();

/** Vote buckets: one per stage, plus "until" for optional 🏁 leave-by times (unix seconds). */
type VoteStage = Stage | "until";

async function votes(env: Env, day: string, stage: VoteStage): Promise<Votes> {
  const r = await env.DB.prepare("SELECT user_id, choice FROM game_night_votes WHERE day = ? AND stage = ?")
    .bind(day, stage)
    .all<{ user_id: string; choice: string }>();
  return Object.fromEntries(r.results.map((v) => [v.user_id, v.choice]));
}

const vote = (env: Env, day: string, stage: VoteStage, user: string, choice: string) =>
  env.DB.prepare(
    `INSERT INTO game_night_votes (day, stage, user_id, choice, voted_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(day, stage, user_id) DO UPDATE SET choice = excluded.choice, voted_at = excluded.voted_at`,
  )
    .bind(day, stage, user, choice, now())
    .run();

const unvote = (env: Env, day: string, stage: VoteStage, user: string) =>
  env.DB.prepare("DELETE FROM game_night_votes WHERE day = ? AND stage = ? AND user_id = ?").bind(day, stage, user).run();

export async function games(env: Env): Promise<Game[]> {
  const r = await env.DB.prepare("SELECT name, emoji, plays FROM games ORDER BY plays DESC, rowid LIMIT 25").all<Game>();
  return r.results;
}

/** Adds a game if it's new; returns its stored name (names are case-insensitive). */
export async function addGame(env: Env, raw: string, user: string) {
  const name = raw.replace(/\s+/g, " ").trim().slice(0, 60);
  if (!name) return null;
  await env.DB.prepare("INSERT OR IGNORE INTO games (name, emoji, added_by, added_at) VALUES (?, NULL, ?, ?)")
    .bind(name, user, now())
    .run();
  return (await env.DB.prepare("SELECT name FROM games WHERE name = ?").bind(name).first<{ name: string }>())!.name;
}

export const removeGame = (env: Env, name: string) => env.DB.prepare("DELETE FROM games WHERE name = ?").bind(name).run();

/** Compare-and-set on the stage, so concurrent clicks can only advance a night once. */
async function advance(env: Env, day: string, from: Stage, to: Stage, set: { game?: string; start_at?: number; note?: string | null } = {}) {
  const r = await env.DB.prepare(
    `UPDATE game_nights SET stage = ?, stage_at = ?, game = COALESCE(?, game), start_at = COALESCE(?, start_at), note = COALESCE(?, note)
     WHERE day = ? AND stage = ?`,
  )
    .bind(to, nowSec(), set.game ?? null, set.start_at ?? null, set.note ?? null, day, from)
    .run();
  return r.meta.changes > 0;
}

function tally(env: Env, v: Votes) {
  const counts = new Map<string, number>();
  for (const p of players(env)) if (v[p]) counts.set(v[p], (counts.get(v[p]) ?? 0) + 1);
  return counts;
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
    const ins = await env.DB.prepare("INSERT OR IGNORE INTO game_nights (day, stage, reminded, started_by, stage_at) VALUES (?, 'ask', 0, ?, ?)")
      .bind(day, by ?? null, nowSec())
      .run();
    if (ins.meta.changes && by) await vote(env, day, "ask", by, "yes");
    n = (await getNight(env, day))!;
  }
  // already posted, or someone else's card: just point at it
  if (n.message_id || n.stage !== "ask") return { started: false, day, message_id: n.message_id, stage: n.stage };
  // otherwise the day is claimed but not posted yet (fresh claim, or an earlier post failed): post it
  try {
    const msg = await api(env, "POST", `/channels/${env.GAME_CHANNEL_ID}/messages`, await render(env, day));
    // only the first writer stores its message; a racing duplicate deletes itself
    const set = await env.DB.prepare("UPDATE game_nights SET message_id = ? WHERE day = ? AND message_id IS NULL").bind(msg.id, day).run();
    if (!set.meta.changes) {
      await api(env, "DELETE", `/channels/${env.GAME_CHANNEL_ID}/messages/${msg.id}`).catch(() => {});
      const n = (await getNight(env, day))!;
      return { started: false, day, message_id: n.message_id, stage: n.stage };
    }
    return { started: true, day, message_id: msg.id as string, stage: "ask" };
  } catch (e) {
    // keep the claim (so 17:00 can't post a second poll); the next tick or /playtoday retries
    console.log("startNight post failed", e);
    throw e;
  }
}

/** Polls left open from an earlier day get closed so their buttons stop working. */
export async function closeStale(env: Env) {
  const today = local(env).day;
  const stale = await env.DB.prepare(`SELECT day FROM game_nights WHERE day < ? AND stage IN ('ask', 'game', 'time')`).bind(today).all<{ day: string }>();
  for (const { day } of stale.results) await close(env, day);
  return stale.results.map((s) => s.day);
}

async function close(env: Env, day: string) {
  const n = await getNight(env, day);
  if (!n || !OPEN.includes(n.stage)) return;
  const note = n.stage === "ask" ? "Not everyone was in. Maybe tomorrow 🫡" : "The day ended before we agreed. Maybe tomorrow 🫡";
  if (await advance(env, day, n.stage, "off", { note })) {
    await clearNudge(env, n);
    await refresh(env, day);
  }
}

/** Re-render a card in place (used outside interactions, where we can't reply with an update). */
export async function refresh(env: Env, day: string) {
  const n = await getNight(env, day);
  if (n?.message_id) await api(env, "PATCH", `/channels/${env.GAME_CHANNEL_ID}/messages/${n.message_id}`, await render(env, day));
}

/**
 * A player clicked something. Slow side effects (events, pings) go through `defer` so the
 * interaction can be answered within Discord's 3 seconds.
 */
export async function act(env: Env, day: string, user: string, action: string, value: string | undefined, defer: Defer): Promise<Outcome> {
  const n = await getNight(env, day);
  if (!n) return say("This poll has vanished 🫥");
  if (!players(env).includes(user)) return say("This one's for the trio 😅");
  if (OPEN.includes(n.stage) && day < local(env).day) {
    await close(env, day);
    return say("That poll closed at midnight. Start a new one with **/playtoday** 🎮", true);
  }

  switch (action) {
    case "yes":
    case "no":
      if (n.stage !== "ask") return ok;
      await vote(env, day, "ask", user, action);
      break;
    case "game":
      if (n.stage !== "game" || !value) return ok;
      if (await tiebreak.get(env, "night", day)) return say("It's tiebreaker time ⚔️ Settle it on the card.", true);
      await vote(env, day, "game", user, value);
      break;
    case "suggest": {
      if (n.stage !== "game") return say("Game picking is already over for today.", true);
      if (await tiebreak.get(env, "night", day)) return say("It's tiebreaker time ⚔️ Settle it on the card.", true);
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
      if (await advance(env, day, n.stage, "off", { note: `${mention(user)} can't make it. Maybe tomorrow 🫡` })) {
        defer(n.stage === "set" ? cancelLocked(env, n, user) : clearNudge(env, n));
      }
      return ok;
    default:
      return say("That button is from an older version of me. Try **/playtoday** 🤖");
  }
  await settle(env, day, user, defer);
  return ok;
}

/** Moves the night forward if the votes allow it. */
async function settle(env: Env, day: string, actor: string, defer: Defer) {
  const n = (await getNight(env, day))!;
  const ps = players(env);

  if (n.stage === "ask") {
    const v = await votes(env, day, "ask");
    if (ps.every((p) => v[p] === "yes") && (await advance(env, day, "ask", "game"))) {
      defer(nudge(env, day, ps.filter((p) => p !== actor), "✅ Everyone's in! Pick a game ⬆️"));
    }
    return;
  }

  if (n.stage === "game") {
    const v = await votes(env, day, "game");
    const counts = tally(env, v);
    const winner = [...counts].find(([, c]) => c >= majority(env))?.[0];
    if (winner && (await advance(env, day, "game", "time", { game: winner }))) {
      defer(nudge(env, day, ps.filter((p) => p !== actor), `${await emojiFor(env, winner)} **${winner}** it is! When can you start? ⬆️`));
    } else if (!winner && ps.every((p) => v[p])) {
      // everyone voted and nothing has a majority: ⚔️ tiebreaker between the most-voted games
      const top = Math.max(...counts.values());
      const tied = [...counts].filter(([, c]) => c === top).map(([g]) => g);
      const existed = await tiebreak.get(env, "night", day);
      await tiebreak.open(env, "night", day, tied, Object.fromEntries(ps.filter((p) => tied.includes(v[p])).map((p) => [p, v[p]])));
      if (!existed) defer(nudge(env, day, ps.filter((p) => p !== actor), "⚔️ It's a tie! Spin the wheel or settle it with rock-paper-scissors ⬆️"));
    }
    return;
  }

  if (n.stage === "time") {
    const f = fit(ps, await votes(env, day, "time"), await votes(env, day, "until"), soonest());
    if (!f.ready) return;
    if (f.conflict) {
      // ping the people involved once per distinct clash (not on every click)
      const key = `${f.conflict.leaver}@${f.conflict.leaveBy}/${f.conflict.lateFrom}`;
      const claimed = await env.DB.prepare("UPDATE game_nights SET conflict = ? WHERE day = ? AND (conflict IS NULL OR conflict != ?)")
        .bind(key, day, key)
        .run();
      const who = [...new Set([f.conflict.leaver, ...f.conflict.late])].filter((p) => p !== actor);
      if (claimed.meta.changes && who.length) {
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

/** A game-pick tiebreak finished: the winner goes on to time picking, with the story as a note. */
export async function applyTiebreak(env: Env, day: string, actor: string, defer: Defer) {
  const tb = await tiebreak.get(env, "night", day);
  if (!tb?.result) return;
  const label = await gameLabel(env);
  if (await advance(env, day, "game", "time", { game: tb.result, note: tiebreak.story(tb, label) })) {
    defer(nudge(env, day, players(env).filter((p) => p !== actor), `${label(tb.result)} it is! When can you start? ⬆️`));
  }
}

/** "👻 Phasmophobia", using each game's emoji. */
export async function gameLabel(env: Env) {
  const list = await env.DB.prepare("SELECT name, emoji FROM games").all<{ name: string; emoji: string | null }>();
  const emoji = new Map(list.results.map((g) => [g.name.toLowerCase(), g.emoji]));
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
  await env.DB.prepare("UPDATE game_nights SET nudge_id = ? WHERE day = ?").bind(m.id, day).run();
}

async function clearNudge(env: Env, n: Night) {
  if (!n.nudge_id) return;
  await api(env, "DELETE", `/channels/${env.GAME_CHANNEL_ID}/messages/${n.nudge_id}`).catch(() => {});
  await env.DB.prepare("UPDATE game_nights SET nudge_id = NULL WHERE day = ? AND nudge_id = ?").bind(n.day, n.nudge_id).run();
}

/** The night is set: create a Discord event and ping everyone once. */
async function lockIn(env: Env, day: string) {
  const n = (await getNight(env, day))!;
  const ps = players(env);
  await clearNudge(env, n);
  await env.DB.prepare("UPDATE games SET plays = plays + 1 WHERE name = ?").bind(n.game).run();
  try {
    const start = n.start_at! * 1000;
    const until = Object.values(await votes(env, day, "until")).map(Number);
    const end = until.length ? Math.min(...until) * 1000 : start + 3 * 3600e3;
    const ev = await api(env, "POST", `/guilds/${env.GUILD_ID}/scheduled-events`, {
      name: `${await emojiFor(env, n.game!)} ${n.game}`,
      description: `Terrible Trio game night: ${n.game}. Planned by Meme Bot 3000.`,
      privacy_level: 2,
      entity_type: 3,
      entity_metadata: { location: "Terrible Trio 🔊" },
      scheduled_start_time: new Date(Math.max(start, Date.now() + 60e3)).toISOString(),
      scheduled_end_time: new Date(Math.max(end, Math.max(start, Date.now() + 60e3) + 15 * 60e3)).toISOString(),
    });
    await env.DB.prepare("UPDATE game_nights SET event_id = ? WHERE day = ?").bind(ev.id, day).run();
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

async function cancelLocked(env: Env, n: Night, user: string) {
  await clearNudge(env, n);
  if (n.event_id) await api(env, "DELETE", `/guilds/${env.GUILD_ID}/scheduled-events/${n.event_id}`).catch(() => {});
  const others = players(env).filter((p) => p !== user);
  await api(env, "POST", `/channels/${env.GAME_CHANNEL_ID}/messages`, {
    content: `😢 ${others.map(mention).join(" ")} ${mention(user)} can't make it, so ${n.day === local(env).day ? "tonight's" : `${weekday(env, n.day)}'s`} **${n.game}** is off.`,
    allowed_mentions: pings(env, others),
    message_reference: n.message_id ? { message_id: n.message_id, fail_if_not_exists: false } : undefined,
  });
}

/**
 * Cron, every 15 minutes: keep open cards fresh (drops start times that just passed), ping
 * anyone who's left a stage waiting for an hour (once per stage), and ping the squad when a
 * locked-in night starts.
 */
export async function maintain(env: Env) {
  const t = nowSec();
  const done: Record<string, unknown> = {};
  const open = await env.DB.prepare("SELECT * FROM game_nights WHERE day >= ? AND stage IN ('ask', 'game', 'time') AND message_id IS NOT NULL")
    .bind(local(env).day)
    .all<Night>();

  for (const n of open.results) {
    if (n.stage === "game" && (await tiebreak.get(env, "night", n.day))?.result) {
      // a tiebreak finished but the card never moved on (failed follow-up): finish the job
      await applyTiebreak(env, n.day, "", (p) => p);
      await refresh(env, n.day);
      continue;
    }
    if (n.stage === "time") await refresh(env, n.day);
    const v = await votes(env, n.day, n.stage);
    const missing = players(env).filter((p) => !v[p]);
    if (missing.length && n.renudged !== n.stage && t - (n.stage_at ?? t) >= RENUDGE_AFTER) {
      const claimed = await env.DB.prepare("UPDATE game_nights SET renudged = ? WHERE day = ? AND stage = ? AND (renudged IS NULL OR renudged != ?)")
        .bind(n.stage, n.day, n.stage, n.stage)
        .run();
      if (claimed.meta.changes) {
        const when = n.day === local(env).day ? "tonight" : `on ${weekday(env, n.day)}`;
        const ask = { ask: `are you in ${when}?`, game: "pick a game so we can get going", time: "when can you start?" }[n.stage as "ask"];
        await nudge(env, n.day, missing, `⏳ still waiting on you: ${ask} ⬆️`);
        done[`renudged ${n.day}`] = missing;
      }
    }
  }

  const due = await env.DB.prepare("SELECT * FROM game_nights WHERE stage = 'set' AND reminded = 0 AND start_at <= ?").bind(t + 120).all<Night>();
  for (const n of due.results) {
    const claimed = await env.DB.prepare("UPDATE game_nights SET reminded = 1 WHERE day = ? AND reminded = 0").bind(n.day).run();
    if (!claimed.meta.changes || n.start_at! < t - 1800) continue;
    const ps = players(env);
    await api(env, "POST", `/channels/${env.GAME_CHANNEL_ID}/messages`, {
      content: `⏰ ${ps.map(mention).join(" ")} ${await emojiFor(env, n.game!)} **${n.game}** starts now! Hop in 🔊`,
      allowed_mentions: pings(env, ps),
      message_reference: n.message_id ? { message_id: n.message_id, fail_if_not_exists: false } : undefined,
    });
    done.reminded = n.day;
  }
  return done;
}

/** Private heads-up after a click, when we also re-render the card. */
export const notify = (env: Env, token: string, notice: string) => followup(env, token, { content: notice, flags: EPHEMERAL });

// ---------------------------------------------------------------- rendering

async function emojiFor(env: Env, game: string) {
  const g = await env.DB.prepare("SELECT emoji FROM games WHERE name = ?").bind(game).first<{ emoji: string | null }>();
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

export async function render(env: Env, day: string) {
  const n = (await getNight(env, day))!;
  const ps = players(env);
  const date = ts(Math.floor(Date.parse(`${day}T12:00:00Z`) / 1000), "D");
  const id = (action: string) => `gn:${day}:${action}`;
  const out = button(2, "🚪", "I'm out", id("out"));
  const starter = n.started_by ? ` · started by ${mention(n.started_by)}` : "";
  let body: unknown[];

  switch (n.stage) {
    case "ask": {
      const v = await votes(env, day, "ask");
      const yes = ps.filter((p) => v[p] === "yes").length;
      const no = ps.filter((p) => v[p] === "no").length;
      const today = day === local(env).day;
      const status = no
        ? ps.every((p) => v[p])
          ? `😴 Not ${today ? "tonight" : "that day"}… unless someone changes their mind.`
          : `Someone's out for now. Votes can change until the end of ${today ? "today" : weekday(env, day)}.`
        : `Waiting on ${ps.length - yes} more. It's on when all ${ps.length} say yes.`;
      body = [
        text(`## 🎮 Game night? · ${date}\n### ${today ? "Are we playing today?" : `📅 Are we playing on ${weekday(env, day)}?`}`),
        text(ps.map((p) => `${v[p] === "yes" ? "✅" : v[p] === "no" ? "❌" : "⏳"} ${mention(p)}`).join("　")),
        text(`-# ${status}${starter}`),
        row(button(3, "✅", `I'm in · ${yes}`, id("yes")), button(4, "✖️", `${today ? "Not today" : "Can't"} · ${no}`, id("no"))),
      ];
      break;
    }
    case "game": {
      const v = await votes(env, day, "game");
      const list = await games(env);
      const emoji = new Map(list.map((g) => [g.name, g.emoji ?? "🎮"]));
      const picks = [...tally(env, v)]
        .sort((a, b) => b[1] - a[1])
        .map(([g, c]) => `${emoji.get(g) ?? "🎮"} **${g}** · ${c} · ${ps.filter((p) => v[p] === g).map(mention).join(" ")}`);
      const waiting = ps.filter((p) => !v[p]);
      const tb = await tiebreak.get(env, "night", day);
      if (tb) {
        // a tie: the dropdown makes way for the ⚔️ tiebreaker
        body = [
          text(`## 🕹️ What are we playing? · ${date}`),
          ...tiebreak.section(tb, await gameLabel(env), ps.every((p) => v[p]) && picks.length === ps.length ? "Everyone picked something different!" : "It's a tie!"),
          row(out),
        ];
        break;
      }
      body = [
        text(`## 🕹️ What are we playing? · ${date}\n✅ All ${ps.length} are in!`),
        text(picks.length ? picks.join("\n") : "*No picks yet…*"),
        text(
          `-# First game to ${majority(env)} votes wins · a split goes to a ⚔️ tiebreaker${waiting.length ? ` · waiting on ${waiting.map(mention).join(" ")}` : ""}`,
        ),
        row({
          type: 3,
          custom_id: id("game"),
          placeholder: "🎯 Pick a game…",
          options: list.map((g) => ({
            label: g.name,
            value: g.name,
            emoji: { name: g.emoji ?? "🎮" },
            description: g.plays ? `Played ${g.plays}×` : undefined,
          })),
        }),
        row(button(1, "➕", "Suggest a game", id("suggest")), out),
      ];
      break;
    }
    case "time": {
      const v = await votes(env, day, "time");
      const until = await votes(env, day, "until");
      const f = fit(ps, v, until, soonest());
      const at = (t: number) => `**${timeLabel(env, t, day)}**`;
      const lead = f.start === null ? null : Math.max(...ps.filter((p) => v[p]).map((p) => Number(v[p])));
      const lines = ps.map((p) => {
        const leave = until[p] ? ` · 🏁 leaves ${at(Number(until[p]))}` : "";
        return v[p] ? `🕐 ${mention(p)} from ${at(Number(v[p]))}${leave}` : `⏳ ${mention(p)}${leave}`;
      });
      const waiting = ps.filter((p) => !v[p]);
      const leaver = f.end !== null ? ps.find((p) => Number(until[p]) === f.end)! : null;
      const deadline = f.end !== null ? ` · start by ${at(f.end - MIN_TOGETHER)} so we get an hour before ${mention(leaver!)} leaves` : "";
      let status: string;
      if (f.conflict) {
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
      const times = timeOptions(env, n, v).map((t) => {
        const count = ps.filter((p) => v[p] === String(t)).length;
        return button(t === lead ? 3 : 2, null, `${timeLabel(env, t, day)}${count ? ` · ${count}` : ""}`, id(`time:${t}`));
      });
      body = [
        text(`## ⏰ What time? · ${date}\n${n.note ? `${n.note.split("\n").map((l) => `-# ${l}`).join("\n")}\n` : ""}### ${await emojiFor(env, n.game!)} ${n.game} it is!`),
        text(`Pick the **earliest** time you can start. We kick off when everyone's ready.\n${lines.join("\n")}`),
        text(status),
        ...rows([...times, button(1, "✏️", "Other time", id("custom")), button(2, "🏁", "Leave by", id("leaveby")), out]),
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
      const endLine = end === null ? "" : `\n🏁 until **${timeLabel(env, end, day)}** (${leavers.map(mention).join(" & ")} ${leavers.length > 1 ? "have" : "has"} to leave)`;
      body = [
        text(`## 🎉 Game night is ON · ${date}`),
        text(
          `### ${await emojiFor(env, n.game!)} ${n.game}\n🕐 **${timeLabel(env, n.start_at!, day)}** · ${ts(n.start_at!, "R")}${endLine}\n👥 ${ps.map(mention).join(" ")}${flavour}`,
        ),
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
      body = [text(`## 😴 No game night · ${date}`), text(n.note ?? "Maybe tomorrow 🫡")];
      break;
  }
  return {
    flags: IS_COMPONENTS_V2,
    allowed_mentions: { parse: [] },
    components: [{ type: 17, accent_color: COLORS[n.stage], components: body }],
  };
}

/** Ephemeral "which day?" picker for planning ahead: today plus the next 6 days. */
export async function planPicker(env: Env) {
  const today = local(env).day;
  const days = Array.from({ length: 7 }, (_, i) => new Date(Date.parse(`${today}T12:00:00Z`) + i * 864e5).toISOString().slice(0, 10));
  const existing = await env.DB.prepare(`SELECT day, stage FROM game_nights WHERE day >= ? AND day <= ?`)
    .bind(days[0], days[6])
    .all<{ day: string; stage: Stage }>();
  const has = new Map(existing.results.map((n) => [n.day, n.stage]));
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
  await env.DB.batch([
    env.DB.prepare("DELETE FROM game_night_votes WHERE day = ?").bind(day),
    env.DB.prepare("DELETE FROM game_nights WHERE day = ?").bind(day),
    env.DB.prepare("DELETE FROM tiebreaks WHERE kind = 'night' AND ref = ?").bind(day),
  ]);
  return { reset: true };
}
