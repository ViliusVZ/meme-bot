// Daily game-night planner: one card per day that walks through three stages.
//   ask  → "Are we playing today?" (needs every player to say yes). Not sure? 🤔 Maybe: once
//          everyone's answered and nobody said no, it's on hold for 2 h and the unsure are asked
//          again; one more maybe holds it 1 h more, then it's a final yes or no
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
import { and, eq, gt, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { Clock, Context, DateTime, Duration, Effect, Fiber, Layer, Match, Result, Schema } from "effect";
import { AppConfig, allowedMentions, players as theTrio } from "./config.js";
import { Db, type DbError, type Tx as DbTx } from "./db/db.js";
import { Roasts } from "./roasts.js";
import type { AppServices } from "./runtime.js";
import { Discord, type DiscordError } from "./discord.js";
import { Games } from "./games.js";
import { Nights } from "./nights.js";
import { Attendances } from "./attendance.js";
import { localAt, pollHourOf, wallToUnixIn, weekdayOf } from "./localtime.js";
import { Alerts } from "./alerts.js";
import { Panels, type Mine } from "./panels.js";
import { Snoozes } from "./snooze.js";
import { Voice } from "./voice.js";
import { Spontaneous } from "./spontaneous.js";
import { nowIso, nowSec as currentSec } from "./clock.js";
import { gameNights, gameNightVotes, games as gameTable, nightAttendance, type Reason, type Stage } from "./db/schema.js";
import { EPHEMERAL, IS_COMPONENTS_V2 } from "./discord.js";
import type { Night } from "./nights.js";

export type { Night } from "./nights.js";

export type Votes = Record<string, string>; // user id → choice
/** What to tell the clicker privately, and whether the card should be re-rendered. */
export type Outcome = { notice?: string; update: boolean };

const OPEN: Stage[] = ["ask", "game", "time"];
const COLORS: Record<Stage, number> = { ask: 0x5865f2, game: 0x57f287, time: 0xfee75c, set: 0xeb459e, off: 0x4f545c };
const HALF_HOUR = 1800;
const LEAD = 45 * 60; // first suggested start is at least this far out
const RENUDGE_AFTER = 3600;
const VOTE_WINDOW = 3 * 3600; // a vote that isn't complete this long after it opened calls the night off
const WARN_BEFORE = 30 * 60; // "last call" to whoever hasn't voted
const HOLDS = [2 * 3600, 3600]; // 🤔 how long each maybe puts "are we playing?" on hold; after the last, it's yes or no
const AFTER_HOLD = 3600; // once a hold is up, the unsure get this long to answer
const ANSWER: Record<string, string> = { yes: "✅", maybe: "🤔", no: "❌" };
const MORNING = { hour: 9, minute: 30 }; // nothing gets decided or posted between midnight and this

const mention = (id: string) => `<@${id}>`;
const ts = (sec: number, style: string) => `<t:${sec}:${style}>`;
const ROOM_EARLY = 10; // a night's room opens this many seconds before the start, so the moves land on the dot
const ok: Outcome = { update: true };
const say = (notice: string, update = false): Outcome => ({ notice, update });

// ---------------------------------------------------------------- time

/** Where and when: the bot's time zone and the current unix second (pure helpers take it). */
export type When = { readonly zone: string; readonly now: number };
const when = Effect.gen(function* () {
  return { zone: (yield* AppConfig).timezone, now: yield* currentSec } as When;
});
const localOf = (w: When, sec = w.now) => localAt(w.zone, sec * 1000);
const today = (w: When) => localOf(w).day;

const clock = (w: When, sec: number) => localOf(w, sec).hm;
/** A Discord timestamp: just the time if it's today, else the date too. */
const stamp = (w: When, sec: number) => ts(sec, localOf(w, sec).day === today(w) ? "t" : "f");

/** "18:30", or "🌙 00:30" for after midnight. */
function timeLabel(w: When, sec: number, day: string) {
  const l = localOf(w, sec);
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
export function timeOptionsFor(w: When, n: Night, v: Votes) {
  const t = w.now;
  let presets: number[];
  if (n.day > today(w)) {
    const [y, m, d] = n.day.split("-").map(Number);
    presets = [16, 17, 18, 19, 20, 21].map((h) => wallToUnixIn(w.zone, y, m, d, h, 0));
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
export function parseTimeFor(w: When, raw: string, day = today(w)): number | string {
  const m = raw.trim().match(/^(\d{1,2})(?:\s*[:.h]?\s*(\d{2}))?$/i);
  if (!m || +m[1] > 23 || +(m[2] ?? 0) > 59) return "Couldn't read that time. Try something like **20:30**.";
  const [y, mo, d] = day.split("-").map(Number);
  const isToday = day === today(w);
  let t = wallToUnixIn(w.zone, y, mo, d, +m[1], +(m[2] ?? 0));
  if (+m[1] < 6 && (!isToday || t < w.now)) {
    // the small hours after the night: same wall time on the next calendar day (DST-safe)
    const next = new Date(Date.UTC(y, mo - 1, d + 1));
    t = wallToUnixIn(w.zone, next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), +m[1], +(m[2] ?? 0));
  }
  if (t < w.now + 120) return `**${clock(w, t)}** has already passed ⏰`;
  if (isToday && t > w.now + 18 * 3600) return "That's a bit far out. Pick a time in the next 18 hours.";
  return t;
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
export function fit(ps: ReadonlyArray<string>, starts: Votes, untils: Votes, soonest: number): Fit {
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

/** If everyone's picks have already passed, start a few minutes from now instead. */
const soonest = (w: When) => Math.ceil((w.now + 120) / 300) * 300;

/** A time belongs to a night if it's on that day or in the small hours after it. */
function onNightDay(w: When, day: string, t: number) {
  const [y, mo, d] = day.split("-").map(Number);
  const dayStart = wallToUnixIn(w.zone, y, mo, d, 0, 0);
  return t >= dayStart && t <= dayStart + 30 * 3600;
}

/** Unix seconds for MORNING on the local day of `t`. */
function morningOf(w: When, t: number) {
  const l = localOf(w, t);
  return wallToUnixIn(w.zone, l.y, l.m, l.d, MORNING.hour, MORNING.minute);
}

/** Moves a time out of the small hours (00:00 until MORNING) to MORNING. */
function awakeTime(w: When, t: number) {
  return t < morningOf(w, t) ? morningOf(w, t) : t;
}

/**
 * When the current stage's vote closes: 3 h after it opened (an hour after a 🤔 hold is up), but a
 * night planned for a later day gets until at least noon on the day itself, and nothing closes in
 * the small hours (it waits until 09:30, after the 09:00 last call).
 */
export function deadlineFor(w: When, n: Pick<Night, "day" | "stage_at"> & Partial<Pick<Night, "stage" | "maybes">>) {
  const opened = n.stage_at ?? w.now;
  let t = opened + (n.stage === "ask" && n.maybes ? AFTER_HOLD : VOTE_WINDOW);
  if (n.day > localOf(w, opened).day) {
    const [y, m, d] = n.day.split("-").map(Number);
    t = Math.max(t, wallToUnixIn(w.zone, y, m, d, 12, 0));
  }
  return awakeTime(w, t);
}

/** After the last hold it's yes or no: no more maybes. */
const finalCall = (n: Night) => n.stage === "ask" && n.maybes >= HOLDS.length && !n.paused_until;

const closeNote = (stage: Stage) => (stage === "ask" ? "Not everyone was in. Maybe tomorrow 🫡" : "The day ended before we agreed. Maybe tomorrow 🫡");

const REASON: Record<Reason, string> = { no: "❌ said no", ghost: "👻 didn't vote in time", out: "🚪 bailed" };

function blame(who: Record<string, Reason>) {
  return Object.entries(who)
    .map(([u, r]) => `${mention(u)} ${REASON[r]}`)
    .join(" · ");
}

function tally(ps: ReadonlyArray<string>, v: Votes) {
  const counts = new Map<string, number>();
  for (const p of ps) if (v[p]) counts.set(v[p], (counts.get(v[p]) ?? 0) + 1);
  return counts;
}

// ---------------------------------------------------------------- storage

/** Vote buckets: one per stage, plus "until" for optional 🏁 leave-by times (unix seconds). */
type VoteStage = Stage | "until";

const votes = Effect.fnUntraced(function* (day: string, stage: VoteStage) {
  const db = yield* Db;
  const r = yield* db
    .select({ user_id: gameNightVotes.user_id, choice: gameNightVotes.choice })
    .from(gameNightVotes)
    .where(and(eq(gameNightVotes.day, day), eq(gameNightVotes.stage, stage)));
  return Object.fromEntries(r.map((v) => [v.user_id, v.choice])) as Votes;
});

const vote = Effect.fnUntraced(function* (day: string, stage: VoteStage, user: string, choice: string) {
  const db = yield* Db;
  yield* db
    .insert(gameNightVotes)
    .values({ day, stage, user_id: user, choice, voted_at: yield* nowIso })
    .onConflictDoUpdate({
      target: [gameNightVotes.day, gameNightVotes.stage, gameNightVotes.user_id],
      set: { choice: sql`excluded.choice`, voted_at: sql`excluded.voted_at` },
    });
});

const unvote = Effect.fnUntraced(function* (day: string, stage: VoteStage, user: string) {
  const db = yield* Db;
  yield* db.delete(gameNightVotes).where(and(eq(gameNightVotes.day, day), eq(gameNightVotes.stage, stage), eq(gameNightVotes.user_id, user)));
});

/** Compare-and-set on the stage, so concurrent clicks can only advance a night once. */
const advance = Effect.fnUntraced(function* (day: string, from: Stage, to: Stage, set: { game?: string; start_at?: number; note?: string | null } = {}) {
  const db = yield* Db;
  const r = yield* db
    .update(gameNights)
    .set({
      stage: to,
      stage_at: yield* currentSec,
      ...(set.game != null ? { game: set.game } : {}),
      ...(set.start_at != null ? { start_at: set.start_at } : {}),
      ...(set.note != null ? { note: set.note } : {}),
      ...(from === "ask" ? { paused_until: null } : {}),
    })
    .where(and(eq(gameNights.day, day), eq(gameNights.stage, from)))
    .returning({ day: gameNights.day });
  return r.length > 0;
});

/** Who sinks the night if the vote closed now: no-votes (asking stage) plus anyone who hasn't voted. */
const culprits = Effect.fnUntraced(function* (n: Night) {
  const v = yield* votes(n.day, n.stage);
  const ps = yield* theTrio;
  const who: Record<string, Reason> = {};
  for (const p of ps) {
    // on the final call a maybe that slipped in isn't an answer
    if (!v[p] || (v[p] === "maybe" && finalCall(n))) who[p] = "ghost";
    else if (n.stage === "ask" && v[p] === "no") who[p] = "no";
  }
  return { who, missing: ps.filter((p) => who[p] === "ghost") };
});

/** The day's night row vanished under us (reset by hand, say): that night's work stops, the others go on. */
export class NightGone extends Schema.TaggedError<NightGone>()("NightGone", { day: Schema.String }) {
  override get message() {
    return `no game night for ${this.day}`;
  }
}

/** The day's night, which must be there. */
const nightOf = Effect.fnUntraced(function* (day: string) {
  const n = yield* (yield* Nights).get(day);
  if (!n) return yield* new NightGone({ day });
  return n;
});

/**
 * Stage changes only edit the card, which doesn't notify anyone. When a stage needs someone's
 * input, ping them once; the previous nudge is deleted so the channel stays tidy.
 */
const nudge = (day: string, who: ReadonlyArray<string>, content: string) => Effect.uninterruptible(nudgeOnce(day, who, content)); // post → its id (§15)
const nudgeOnce = Effect.fnUntraced(function* (day: string, who: ReadonlyArray<string>, content: string) {
  const config = yield* AppConfig;
  const db = yield* Db;
  const n = yield* nightOf(day);
  yield* clearNudge(n);
  if (!who.length) return;
  const m = yield* (yield* Discord).createMessage(config.gameChannelId, {
    content: `${who.map(mention).join(" ")} ${content}`,
    allowed_mentions: yield* allowedMentions(who),
    message_reference: n.message_id ? { message_id: n.message_id, fail_if_not_exists: false } : undefined,
  });
  yield* db.update(gameNights).set({ nudge_id: m.id }).where(eq(gameNights.day, day));
});

const clearNudge = Effect.fnUntraced(function* (n: Night) {
  if (!n.nudge_id) return;
  const config = yield* AppConfig;
  const db = yield* Db;
  yield* (yield* Discord).deleteMessage(config.gameChannelId, n.nudge_id).pipe(Effect.ignore);
  yield* db.update(gameNights).set({ nudge_id: null }).where(and(eq(gameNights.day, n.day), eq(gameNights.nudge_id, n.nudge_id)));
});


// ---------------------------------------------------------------- 🤫 secret ballots
// The card is the same for everyone, so it can't highlight *your* picks. Clicking it answers with
// your own private copy (render with a viewer): same buttons, your picks highlighted, and clicks
// on it update it in place while the public card follows along.
// While a vote runs, the card shows only who has voted, never what. No counts either: in a group
// of three they'd give picks away. Each voter gets a private receipt instead. Picks are revealed
// once everyone has answered (a split game vote stays revealed while you re-vote), or every start
// time is in.

/** Is this stage's vote still secret? Once revealed it stays revealed (a time clash sets `conflict`). */
const secret = Effect.fnUntraced(function* (n: Night) {
  const ps = yield* theTrio;
  if (n.stage === "ask") {
    if (n.maybes) return false; // a 🤔 hold only starts once everyone's answered
    const v = yield* votes(n.day, "ask");
    return !ps.every((p) => v[p]);
  }
  if (n.stage === "game") {
    const v = yield* votes(n.day, "game");
    return !ps.every((p) => v[p]);
  }
  if (n.stage === "time") {
    if (n.conflict) return false;
    const v = yield* votes(n.day, "time");
    return !ps.every((p) => v[p]);
  }
  return false;
});

/** "👻 **Phasmophobia** ← @a @b · 🔫 **Valorant** ← @c", or null if nobody voted. */
const gameVotesLine = Effect.fnUntraced(function* (day: string) {
  const v = yield* votes(day, "game");
  const by = new Map<string, string[]>();
  for (const p of yield* theTrio) if (v[p]) by.set(v[p], [...(by.get(v[p]) ?? []), p]);
  if (!by.size) return null;
  const label = yield* (yield* Games).label;
  return [...by]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([g, us]) => `**${label(g)}** ← ${us.map(mention).join(" ")}`)
    .join(" · ");
});

/** "@a 18:00 · @b 19:00 (🏁 22:00) · @c no pick", or null if nobody picked anything. */
const timeVotesLine = Effect.fnUntraced(function* (day: string) {
  const w = yield* when;
  const v = yield* votes(day, "time");
  const until = yield* votes(day, "until");
  const ps = yield* theTrio;
  if (!ps.some((p) => v[p] || until[p])) return null;
  return ps
    .map((p) => {
      const start = v[p] ? `**${timeLabel(w, Number(v[p]), day)}**` : "no pick";
      return `${mention(p)} ${start}${until[p] ? ` (🏁 ${timeLabel(w, Number(until[p]), day)})` : ""}`;
    })
    .join(" · ");
});

/** A night that ended without playing reveals whatever was voted before it stopped. */
const revealOff = Effect.fnUntraced(function* (day: string) {
  const game = yield* gameVotesLine(day);
  const time = yield* timeVotesLine(day);
  const lines = [...(game ? [`🕹️ ${game}`] : []), ...(time ? [`🕐 ${time}`] : [])];
  if (!lines.length) {
    // it never got past "are we playing?": who was in, who wasn't, who never answered
    const v = yield* votes(day, "ask");
    const ps = yield* theTrio;
    if (ps.some((p) => v[p])) lines.push(ps.map((p) => `${ANSWER[v[p]] ?? "⏳"} ${mention(p)}`).join("　"));
  }
  return lines.length ? [text(`-# 🗳️ How everyone voted\n${lines.map((l) => `-# ${l}`).join("\n")}`)] : [];
});

// ---------------------------------------------------------------- flow

export type StartResult = { started: boolean; day: string; message_id: string | null; stage: Stage };


/**
 * Posts the card for a day (today by default) if there isn't one yet. `by` is the player who ran
 * /playtoday or planned the day (their "yes" counts straight away); without it this is the 17:00
 * schedule, which only acts in the poll hour. Either way the INSERT OR IGNORE on the day decides
 * who wins, so a day planned in advance is never posted again by the schedule.
 */
export const openNight = Effect.fnUntraced(function* (by?: string, anyHour = false, forDay?: string) {
  const config = yield* AppConfig;
  const db = yield* Db;
  const discord = yield* Discord;
  const nights = yield* Nights;
  const alerts = yield* Alerts;
  const w = yield* when;
  const { day: todayIs, hour } = localOf(w);
  const day = forDay ?? todayIs;
  if (day < todayIs) return { skipped: "that day is over" };
  const found = yield* nights.get(day);
  if (!found && !by && !anyHour) {
    if (hour !== pollHourOf(day, config.gamePollHour, config.gamePollHourWeekend)) return { skipped: "not poll hour" };
    // 😴 someone snoozed planning: no automatic card (starting one by hand still works)
    if (yield* (yield* Snoozes).isSnoozed(day)) return { skipped: "snoozed" };
  }
  // claim → post → record is never cut short (architecture §15); a failed post keeps the claim
  const posted: StartResult = yield* Effect.uninterruptible(
    Effect.gen(function* () {
      let n = found;
      if (!n) {
        yield* db.insert(gameNights).values({ day, stage: "ask", reminded: false, started_by: by ?? null, stage_at: yield* currentSec }).onConflictDoNothing();
        n = yield* nightOf(day);
      }
      // whoever starts or plans the night is in (also when retrying a claim whose post failed). Only the
      // one who claimed it: someone tapping at the same moment is pointed at the card like anyone later
      if (by && n.started_by === by && n.stage === "ask" && !n.message_id) yield* vote(day, "ask", by, "yes");
      // already posted, or someone else's card: just point at it
      if (n.message_id || n.stage !== "ask") return { started: false, day, message_id: n.message_id, stage: n.stage };
      // otherwise the day is claimed but not posted yet (fresh claim, or an earlier post failed): post it
      return yield* Effect.gen(function* () {
        const msg = yield* discord.createMessage(config.gameChannelId, yield* renderCard(day));
        // only the first writer stores its message; a racing duplicate deletes itself
        const set = yield* db
          .update(gameNights)
          .set({ message_id: msg.id })
          .where(and(eq(gameNights.day, day), isNull(gameNights.message_id)))
          .returning({ day: gameNights.day });
        if (!set.length) {
          yield* discord.deleteMessage(config.gameChannelId, msg.id).pipe(Effect.ignore);
          const again = yield* nightOf(day);
          return { started: false, day, message_id: again.message_id, stage: again.stage };
        }
        return { started: true, day, message_id: msg.id, stage: "ask" as Stage };
      }).pipe(
        // keep the claim (so the daily job can't post a second poll); the next minute (retryUnposted) or /playtoday retries
        Effect.tapError((e) => alerts.failed("posting the game-night card", e, day)),
      );
    }),
  );
  if (posted.started && by) {
    // someone kicked it off by hand: the other two hear about it (the daily card is expected)
    const tonight = day === todayIs ? "tonight" : `on ${weekdayOf(day)}`;
    yield* nudge(day, (yield* theTrio).filter((p) => p !== by), `🎮 ${mention(by)} wants to play ${tonight}! Are you in? ⬆️`).pipe(
      Effect.catch((e) => alerts.failed("the “wants to play” ping", e, day)),
    );
  }
  return posted;
});

/** A claimed day whose card failed to post (today's or a planned one): try again. */
export const retryCards = Effect.gen(function* () {
  const db = yield* Db;
  const days = yield* db
    .select({ day: gameNights.day })
    .from(gameNights)
    .where(and(isNull(gameNights.message_id), eq(gameNights.stage, "ask"), gte(gameNights.day, today(yield* when))));
  for (const { day } of days) yield* openNight(undefined, true, day);
  return days.map((d) => d.day);
});

/** Re-render every open card (after the game list changes, say). */
export const refreshCards = Effect.gen(function* () {
  const db = yield* Db;
  const open = yield* db
    .select({ day: gameNights.day })
    .from(gameNights)
    .where(and(gte(gameNights.day, today(yield* when)), inArray(gameNights.stage, OPEN)));
  for (const { day } of open) yield* refreshCard(day);
});

/** Cards left open past their time get closed so their buttons stop working. */
export const closeStaleCards = Effect.gen(function* () {
  const db = yield* Db;
  const nights = yield* Nights;
  const open = yield* db
    .select({ day: gameNights.day, stage: gameNights.stage })
    .from(gameNights)
    .where(and(sql`${gameNights.day} < ${today(yield* when)}`, inArray(gameNights.stage, OPEN)));
  const stale: string[] = [];
  for (const n of open) if (yield* nights.isOver(n)) stale.push(n.day);
  for (const day of stale) yield* closeCard(day);
  return stale;
});

/**
 * Closes a card that's past its time. From the minute job it re-renders the card itself; from a click
 * (`rerender` false) the stage is already flipped and the reply shows the closed card, so this
 * only tidies the nudge.
 */
const closeCard = Effect.fnUntraced(function* (day: string, rerender = true) {
  const n = yield* (yield* Nights).get(day);
  if (!n) return;
  if (rerender) {
    if (!OPEN.includes(n.stage)) return;
    // the day ran out: anyone who had an hour to vote and didn't (or said no) still gets roasted,
    // in the morning; a vote that only just opened closes quietly
    const { who } = yield* culprits(n);
    const fair = (yield* currentSec) - (n.stage_at ?? 0) >= RENUDGE_AFTER;
    if (!(yield* callNightOff(n, fair ? who : {}, fair && Object.keys(who).length ? undefined : closeNote(n.stage)))) return;
    yield* refreshCard(day);
    return;
  }
  yield* clearNudge(n);
});

/**
 * Call the night off (once: compare-and-set on the stage), with the culprits recorded for the roast.
 * The roast posts right away, or at 09:30 if it happened in the small hours. With nobody to
 * blame (say, the day simply ended) it just closes.
 */
const callNightOff = Effect.fnUntraced(function* (n: Night, who: Record<string, Reason>, note?: string) {
  const db = yield* Db;
  const anyone = Object.keys(who).length > 0;
  const line = note ?? (anyone ? `🔥 Called off: ${blame(who)}.` : closeNote(n.stage));
  if (!(yield* advance(n.day, n.stage, "off", { note: line }))) return false;
  if (anyone) {
    const w = yield* when;
    yield* db
      .update(gameNights)
      .set({ roast: { who, stage: n.stage }, roast_due: awakeTime(w, w.now), roasted_at: null })
      .where(eq(gameNights.day, n.day));
  }
  yield* clearNudge(yield* nightOf(n.day));
  return true;
});

/**
 * Re-render a card in place (used outside interactions, where we can't reply with an update), and
 * everyone's private copies of it with it. If someone deleted the card by hand, forget it: an "are
 * we playing?" card then gets reposted by the next minute, and later stages simply stop trying to
 * edit it. `mine` is the panel a tap just answered, so its notice survives the sync.
 */
export const refreshCard = Effect.fnUntraced(function* (day: string, mine?: Mine) {
  const config = yield* AppConfig;
  const db = yield* Db;
  const n = yield* (yield* Nights).get(day);
  if (!n) return;
  if (n.message_id) {
    const id = n.message_id;
    yield* (yield* Discord)
      .editMessage(config.gameChannelId, id, yield* renderCard(day))
      .pipe(Effect.catchTag("DiscordNotFound", () => db.update(gameNights).set({ message_id: null }).where(and(eq(gameNights.day, day), eq(gameNights.message_id, id)))));
  }
  yield* syncCopies(day, mine);
});

/** Bring everyone's private copies of a day's card up to date (panels.ts). */
export const syncCopies = Effect.fnUntraced(function* (day: string, mine?: Mine) {
  const ctx = yield* Effect.context<Effect.Services<ReturnType<typeof renderCard>>>();
  yield* (yield* Panels).sync(`gn:${day}`, (user, notice) => renderCard(day, user, notice).pipe(Effect.provideContext(ctx)), mine);
});

/** Remember a private copy of a day's card, so it follows along (panels.ts). */


/** Slow side effects of a tap (pings, the event): handed to whoever answers the tap, to run after it. */
type Later = (effect: Effect.Effect<unknown, DbError | DiscordError | NightGone, Needs>) => Effect.Effect<void>;
/** The same, as callers of the service see it: the work they're handed has its services already. */
export type Deferred = (effect: Effect.Effect<unknown, DbError | DiscordError | NightGone>) => Effect.Effect<void>;

/**
 * A player clicked something. Slow side effects (events, pings) go through `later` so the
 * interaction can be answered within Discord's 3 seconds.
 */
export const actOn = Effect.fnUntraced(function* (day: string, user: string, action: string, value: string | undefined, later: Later) {
  const db = yield* Db;
  const nights = yield* Nights;
  const w = yield* when;
  const n = yield* nights.get(day);
  if (!n) return say("This poll has vanished 🫥");
  const ps = yield* theTrio;
  if (!ps.includes(user)) return say("This one's for the trio 😅");
  if (OPEN.includes(n.stage) && (yield* nights.isOver(n))) {
    // close in the background; the reply below already shows the closed card
    yield* later(closeCard(day, false));
    yield* advance(day, n.stage, "off", { note: closeNote(n.stage) });
    return say("That poll has closed. Start a new one with **/playtoday** 🎮", true);
  }

  // null: the tap changed something, so the night moves forward if the votes allow it
  const outcome: Outcome | null = yield* Match.value(action).pipe(
    Match.whenOr("yes", "no", "maybe", () =>
      Effect.gen(function* () {
        // an out-of-date panel: say where things stand instead of silently jumping ahead
        if (n.stage !== "ask")
          return say(n.stage === "off" ? "Game night's off 🫡 Changed your mind? Tap 🔄 Reopen on the card." : "Everyone's answered already, we're past that step 🙂", true);
        if (action === "maybe" && finalCall(n)) return say("No more maybes: this is the final call. ✅ In or ✖️ out?", true);
        yield* vote(day, "ask", user, action);
        return null;
      }),
    ),
    Match.when("game", () =>
      Effect.gen(function* () {
        if (n.stage !== "game") return say(n.stage === "off" ? "Game night's off 🫡" : n.game ? `The game's already picked: **${n.game}** 🎮` : "We're not picking games yet 🙂", true);
        if (!value) return ok;
        yield* vote(day, "game", user, value);
        return null;
      }),
    ),
    Match.when("suggest", () =>
      Effect.gen(function* () {
        if (n.stage !== "game") return say("Game picking is already over for today.", true);
        const name = yield* (yield* Games).add(value ?? "", user);
        if (!name) return say("Give the game a name 🙃");
        yield* vote(day, "game", user, name);
        return null;
      }),
    ),
    Match.whenOr("time", "custom", () =>
      Effect.gen(function* () {
        if (n.stage !== "time")
          return say(n.stage === "set" ? `The time's already set: **${timeLabel(w, n.start_at!, day)}** ⏰` : n.stage === "off" ? "Game night's off 🫡" : "We're not picking times yet 🙂", true);
        const t = action === "custom" ? parseTimeFor(w, value ?? "", day) : Number(value);
        if (typeof t === "string") return say(t);
        if (!Number.isFinite(t)) return ok;
        if (!onNightDay(w, day, t)) return say("That time isn't on this game night's day 🤔", true);
        if (t < w.now + 60) return say(`**${clock(w, t)}** has already passed ⏰ Pick a later time.`, true);
        const mine = (yield* votes(day, "time"))[user];
        // clicking your current pick again takes it back
        if (action === "time" && mine === String(t)) {
          yield* unvote(day, "time", user);
          return null;
        }
        const until = (yield* votes(day, "until"))[user];
        if (until && Number(until) - t < MIN_TOGETHER) {
          return say(
            `You said you have to leave by **${timeLabel(w, Number(until), day)}**, so starting at **${timeLabel(w, t, day)}** leaves you under an hour. Change your 🏁 leave-by first if that's moved.`,
          );
        }
        yield* vote(day, "time", user, String(t));
        return null;
      }),
    ),
    Match.when("until", () =>
      Effect.gen(function* () {
        // 🏁 optional "I have to leave by…"; an empty form clears it
        if (n.stage !== "time") return say("Time picking is already over for this night.", true);
        if (!(value ?? "").trim()) {
          yield* unvote(day, "until", user);
          return null;
        }
        const t = parseTimeFor(w, value ?? "", day);
        if (typeof t === "string") return say(t);
        if (!onNightDay(w, day, t)) return say("That time isn't on this game night's day 🤔");
        if (t < w.now + MIN_TOGETHER) return say(`Leaving by **${clock(w, t)}** doesn't leave time to play 😅 Pick a later time, or tap 🚪 I'm out.`);
        const start = (yield* votes(day, "time"))[user];
        if (start && t - Number(start) < MIN_TOGETHER) {
          return say(
            `Your start is **${timeLabel(w, Number(start), day)}**, so a leave-by of **${timeLabel(w, t, day)}** is under an hour of play. Pick an earlier start first, or a later leave-by.`,
          );
        }
        yield* vote(day, "until", user, String(t));
        return null;
      }),
    ),
    Match.when("out", () =>
      Effect.gen(function* () {
        if (n.stage === "set" && (n.start_at ?? 0) < w.now - 4 * 3600) return say("That game night is already history 🕰️");
        if (n.stage === "off" || n.stage === "ask") return ok;
        // all of us or none of us: a bail calls it off for everyone, even after the start
        if (yield* callNightOff(n, { [user]: "out" })) yield* later(afterBail(n));
        return ok;
      }),
    ),
    Match.when("late", () =>
      Effect.gen(function* () {
        // ⏰ "I'll be late by…" on the locked-in card
        if (n.stage !== "set") return say(n.stage === "off" ? "Game night's off, no need to hurry 🫡" : "Nothing's locked in yet, so you can't be late 😄 Pick a later time instead.");
        const mins = Number(value);
        if (![5, 15, 30, 60].includes(mins)) return ok;
        return yield* runningLate(n, user, mins, later);
      }),
    ),
    Match.when("reopen", () =>
      Effect.gen(function* () {
        // changed your mind after a cancel? Start that day's poll over (same card, fresh votes)
        if (n.stage !== "off") return ok;
        if (day < today(w)) return say("That day is over 🕰️ Start a new one with **/playtoday**.");
        const r = yield* db
          .update(gameNights)
          .set({
            stage: "ask",
            stage_at: w.now,
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
            maybes: 0,
            paused_until: null,
            // a roast still waiting for the morning is dropped: they made up
            roast: null,
            roast_due: null,
            roasted_at: null,
            planned_start: null,
          })
          .where(and(eq(gameNights.day, day), eq(gameNights.stage, "off")))
          .returning({ day: gameNights.day });
        if (!r.length) return ok; // someone else reopened it a moment ago
        yield* db.transaction((tx) => clearDay(tx, day));
        yield* vote(day, "ask", user, "yes");
        const tonight = day === today(w) ? "tonight" : `on ${weekdayOf(day)}`;
        yield* later(nudge(day, ps.filter((p) => p !== user), `🔄 ${mention(user)} reopened game night. Are you in ${tonight}? ⬆️`));
        return null;
      }),
    ),
    Match.orElse(() => Effect.succeed(say("That button is from an older version of me. Try **/playtoday** 🤖"))),
  );
  if (outcome) return outcome;
  yield* settle(day, user, later);
  return { update: true };
});

/**
 * ⏰ Running late. Before the start we wait for everyone (all together or not at all), so the start
 * moves to whoever arrives last: the planned start plus the biggest delay. Tapping your delay again
 * takes it back (and the start moves back). Once the night has started it's an ETA on your slip.
 */
const runningLate = Effect.fnUntraced(function* (n: Night, user: string, mins: number, later: Later) {
  const db = yield* Db;
  const attendances = yield* Attendances;
  const w = yield* when;
  const t = w.now;
  if (n.start_at! < t - 3 * 3600) return say("That game night is already history 🕰️");
  if (n.reminded) return say(yield* attendances.declare(n.day, user, mins));
  const planned = n.planned_start ?? n.start_at!;
  const eta = planned + mins * 60;
  const mine = (yield* attendances.etas(n.day))[user];
  const undo = mine === eta;
  yield* attendances.expect(n.day, user, undo ? null : eta);
  // one statement over every ETA on record, so two taps at once can't leave the start too early;
  // and never in the past (taking it back after the planned time means: start now)
  const latest = sql`(SELECT MAX(${nightAttendance.eta}) FROM ${nightAttendance} WHERE ${nightAttendance.day} = ${n.day} AND ${nightAttendance.state} = 'eta')`;
  const moved = yield* db
    .update(gameNights)
    .set({ start_at: sql`GREATEST(${planned}::bigint, COALESCE(${latest}, 0), ${t + 60}::bigint)`, planned_start: planned })
    .where(and(eq(gameNights.day, n.day), eq(gameNights.stage, "set"), eq(gameNights.reminded, false)))
    .returning({ start: gameNights.start_at });
  if (!moved.length) return say(yield* attendances.declare(n.day, user, mins)); // it started a moment ago
  const start = moved[0].start!;
  const at = (x: number) => timeLabel(w, x, n.day);
  if (start !== n.start_at) yield* later(startMoved(n, start, user, undo ? null : mins));
  if (undo) return say(`✅ Taken back: you'll be on time.${start !== n.start_at ? ` Start's back to **${at(start)}**.` : ""}`, true);
  return say(
    start !== n.start_at
      ? `⏰ Got it. We wait for you: the start moved to **${at(start)}** and the others know.`
      : `⏰ Got it, you'll be there at **${at(eta)}**. The start stays at **${at(start)}** (someone's even later).`,
    true,
  );
});

const isoAt = (sec: number) => DateTime.formatIso(DateTime.makeUnsafe(sec * 1000));

/** The start moved because someone's late (or isn't any more): the event follows, the others hear. */
const startMoved = Effect.fnUntraced(function* (n: Night, start: number, user: string, mins: number | null) {
  const config = yield* AppConfig;
  const db = yield* Db;
  const discord = yield* Discord;
  const alerts = yield* Alerts;
  const w = yield* when;
  const at = (x: number) => timeLabel(w, x, n.day);
  if (n.event_id && n.event_end) {
    // (no end: the event's already over, nothing to move)
    const evStart = Math.max(start, w.now + 60);
    const evEnd = Math.max(n.event_end, evStart + 15 * 60);
    yield* discord
      .editEvent(n.event_id, { scheduled_start_time: isoAt(evStart), scheduled_end_time: isoAt(evEnd) })
      .pipe(Effect.catch((e) => alerts.failed("moving the Discord event", e, n.day)));
    yield* db.update(gameNights).set({ event_end: evEnd }).where(eq(gameNights.day, n.day));
  }
  // a leave-by that now leaves under an hour together is worth a heads-up
  const ps = yield* theTrio;
  const until = yield* votes(n.day, "until");
  const end = Object.values(until).length ? Math.min(...Object.values(until).map(Number)) : null;
  const leavers = end === null ? [] : ps.filter((p) => Number(until[p]) === end);
  const tight =
    end !== null && end - start < MIN_TOGETHER
      ? `\n-# ⚠️ That leaves ${Math.max(0, Math.round((end - start) / 60))} min before ${leavers.map(mention).join(" & ")} ${leavers.length > 1 ? "have" : "has"} to leave (${at(end)}).`
      : "";
  const others = ps.filter((p) => p !== user);
  const content =
    mins === null
      ? `✅ ${mention(user)} will be on time after all: we start at **${at(start)}** ${ts(start, "R")}${tight}`
      : `⏰ ${mention(user)} is running ${mins === 60 ? "an hour" : `${mins} min`} late, so we start at **${at(start)}** ${ts(start, "R")} instead of ${at(n.start_at!)}${tight}`;
  yield* discord.createMessage(config.gameChannelId, {
    content,
    allowed_mentions: yield* allowedMentions(others),
    message_reference: n.message_id ? { message_id: n.message_id, fail_if_not_exists: false } : undefined,
  });
});

/** Moves the night forward if the votes allow it. */
const settle = (day: string, actor: string, later: Later) => Effect.uninterruptible(settleOnce(day, actor, later)); // a stage's claim → what it hands on (§15)
const settleOnce = Effect.fnUntraced(function* (day: string, actor: string, later: Later) {
  const db = yield* Db;
  const n = yield* nightOf(day);
  const ps = yield* theTrio;

  if (n.stage === "ask") {
    const v = yield* votes(day, "ask");
    if (ps.every((p) => v[p] === "yes") && (yield* advance(day, "ask", "game"))) {
      yield* later(nudge(day, ps, "✅ Everyone's in! What are we playing? ⬆️"));
    } else if (ps.every((p) => v[p]) && ps.some((p) => v[p] === "no")) {
      // everyone answered and somebody said no (a maybe can't save it): the votes come out, and so do the roasts
      const who = Object.fromEntries(ps.filter((p) => v[p] === "no").map((p) => [p, "no" as Reason]));
      if (yield* callNightOff(n, who)) yield* later(postRoastOf(day));
    } else if (ps.every((p) => v[p]) && !n.paused_until && n.maybes < HOLDS.length) {
      yield* hold(n, ps.filter((p) => v[p] === "maybe"), later);
    }
    return;
  }

  if (n.stage === "game") {
    // nothing is decided until everyone's voted (or the deadline calls it off)
    const v = yield* votes(day, "game");
    if (!ps.every((p) => v[p])) return;
    const counts = tally(ps, v);
    const top = Math.max(...counts.values());
    const tied = [...counts].filter(([, c]) => c === top).map(([g]) => g);
    if (tied.length === 1) {
      const winner = tied[0];
      if (yield* advance(day, "game", "time", { game: winner })) {
        yield* later(nudge(day, ps, `🗳️ Everyone's voted: ${yield* (yield* Games).emojiFor(winner)} **${winner}** it is! When can you start? ⬆️`));
      }
    } else {
      // a split: the picks are revealed (everyone's voted) and it stays open for a re-vote; one
      // ping per night about it
      const claimed = yield* db
        .update(gameNights)
        .set({ renudged: "split" })
        .where(and(eq(gameNights.day, day), eq(gameNights.stage, "game"), or(isNull(gameNights.renudged), ne(gameNights.renudged, "split"))))
        .returning({ day: gameNights.day });
      if (claimed.length) yield* later(nudge(day, ps, "🔁 Split vote! Everyone picked something different. Talk it out and re-vote until two of you agree ⬆️"));
    }
    return;
  }

  if (n.stage === "time") {
    const f = fit(ps, yield* votes(day, "time"), yield* votes(day, "until"), soonest(yield* when));
    if (!f.ready) return;
    if (f.conflict) {
      // ping the people involved once per distinct clash (not on every click)
      const key = `${f.conflict.leaver}@${f.conflict.leaveBy}/${f.conflict.lateFrom}`;
      const claimed = yield* db
        .update(gameNights)
        .set({ conflict: key })
        .where(and(eq(gameNights.day, day), or(isNull(gameNights.conflict), ne(gameNights.conflict, key))))
        .returning({ day: gameNights.day });
      const who = [...new Set([f.conflict.leaver, ...f.conflict.late])].filter((p) => p !== actor);
      if (claimed.length && who.length) {
        yield* later(nudge(day, who, "⚠️ The times don't fit together yet. Take a look ⬆️"));
      }
      return;
    }
    if (yield* advance(day, "time", "set", { start_at: f.start! })) yield* later(lockIn(day));
  }
});

// ---------------------------------------------------------------- 🤔 maybe

/** Everyone's answered, nobody said no, but someone isn't sure: put the answer on hold (once per round). */
const hold = Effect.fnUntraced(function* (n: Night, unsure: ReadonlyArray<string>, later: Later) {
  const db = yield* Db;
  const w = yield* when;
  const until = awakeTime(w, w.now + HOLDS[n.maybes]);
  const claimed = yield* db
    .update(gameNights)
    .set({ maybes: n.maybes + 1, paused_until: until })
    .where(and(eq(gameNights.day, n.day), eq(gameNights.stage, "ask"), isNull(gameNights.paused_until), eq(gameNights.maybes, n.maybes)))
    .returning({ day: gameNights.day });
  if (!claimed.length) return;
  // the sure ones hear why they're waiting; the unsure get their ping when it's up
  const waiting = (yield* theTrio).filter((p) => !unsure.includes(p));
  yield* later(
    nudge(n.day, waiting, `🤔 ${unsure.map(mention).join(" & ")} ${unsure.length > 1 ? "aren't" : "isn't"} sure yet, so it's on hold until ${stamp(w, until)} (${ts(until, "R")}). Then I'll ask again ⬆️`),
  );
});

/** The night is set: create a Discord event and ping everyone once. */
const lockIn = (day: string) => Effect.uninterruptible(lockInOnce(day)); // the event → its id → the ping (§15)
const lockInOnce = Effect.fnUntraced(function* (day: string) {
  const config = yield* AppConfig;
  const db = yield* Db;
  const discord = yield* Discord;
  const games = yield* Games;
  const alerts = yield* Alerts;
  const n = yield* nightOf(day);
  const ps = yield* theTrio;
  yield* clearNudge(n);
  yield* Effect.gen(function* () {
    const start = n.start_at! * 1000;
    const until = Object.values(yield* votes(day, "until")).map(Number);
    const end = until.length ? Math.min(...until) * 1000 : start + 3 * 3600e3;
    const evStart = Math.max(start, (yield* Clock.currentTimeMillis) + 60e3);
    const evEnd = Math.max(end, evStart + 15 * 60e3);
    const ev = yield* discord.createEvent({
      name: `${yield* games.emojiFor(n.game!)} ${n.game}`,
      description: `Terrible Trio game night: ${n.game}. Planned by Meme Bot 3000.`,
      privacy_level: 2,
      entity_type: 3,
      entity_metadata: { location: "Terrible Trio 🔊" },
      scheduled_start_time: DateTime.formatIso(DateTime.makeUnsafe(evStart)),
      scheduled_end_time: DateTime.formatIso(DateTime.makeUnsafe(evEnd)),
    });
    yield* db.update(gameNights).set({ event_id: ev.id, event_end: Math.floor(evEnd / 1000) }).where(eq(gameNights.day, day));
    yield* refreshCard(day);
  }).pipe(Effect.catch((e) => alerts.failed("creating the Discord event", e, day))); // the night still happens; the card just has no event link
  const isToday = day === today(yield* when);
  yield* discord.createMessage(config.gameChannelId, {
    content: `🎉 ${ps.map(mention).join(" ")} it's on! ${yield* games.emojiFor(n.game!)} **${n.game}** ${isToday ? "at" : "on"} ${ts(n.start_at!, isToday ? "t" : "f")} (${ts(n.start_at!, "R")})`,
    allowed_mentions: yield* allowedMentions(ps),
    message_reference: n.message_id ? { message_id: n.message_id, fail_if_not_exists: false } : undefined,
  });
});

// ---------------------------------------------------------------- 🔥 bails and roasts

/**
 * Someone bailed: ends the night's Discord event (deleted if it hadn't started, marked ended if it
 * had), retires everyone's late slips, and posts the roast.
 */
const afterBail = Effect.fnUntraced(function* (n: Night) {
  const discord = yield* Discord;
  if (n.event_id) {
    const live = n.reminded || (n.start_at ?? Infinity) <= (yield* currentSec);
    yield* (live ? Effect.asVoid(discord.editEvent(n.event_id, { status: 3 })) : discord.deleteEvent(n.event_id)).pipe(Effect.ignore);
  }
  const alerts = yield* Alerts;
  yield* (yield* Attendances).retireSlips(n.day).pipe(Effect.catch((e) => alerts.failed("tidying the late slips", e, n.day)));
  yield* postRoastOf(n.day);
});

/** A late slip's 😴: same as 🚪, the whole night is off. */
export const bailOn = Effect.fnUntraced(function* (day: string, user: string) {
  const n = yield* (yield* Nights).get(day);
  if (n?.stage !== "set") return false;
  if (!(yield* callNightOff(n, { [user]: "out" }))) return false;
  yield* refreshCard(day);
  yield* afterBail(n);
  return true;
});

/** Post a night's roast if it's due (exactly once: claimed in the database first). */
export const postRoastOf = (day: string) =>
  // claim → post is never cut short (architecture §15); a failed post gives the claim back
  Effect.uninterruptible(
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const db = yield* Db;
      const w = yield* when;
      const claimed = yield* db
        .update(gameNights)
        .set({ roasted_at: w.now })
        .where(and(eq(gameNights.day, day), eq(gameNights.stage, "off"), sql`${gameNights.roast} IS NOT NULL`, isNull(gameNights.roasted_at), lte(gameNights.roast_due, w.now)))
        .returning();
      const n = claimed[0];
      if (!n?.roast) return false;
      const roast = n.roast;
      const ps = yield* theTrio;
      const culprits = Object.keys(roast.who);
      const isToday = n.day === today(w);
      const whose = isToday ? "tonight's" : `${weekdayOf(n.day)}'s`;
      yield* Effect.gen(function* () {
        const what =
          roast.stage === "set" && n.game ? `${yield* (yield* Games).emojiFor(n.game)} ${n.game} ${isToday ? "tonight" : `on ${weekdayOf(n.day)}`}` : `${whose} game night`;
        const head =
          culprits.length >= ps.length && ps.every((p) => roast.who[p])
            ? `🔥 **Nobody's in, so ${what} is off**`
            : `🔥 **${what[0].toUpperCase()}${what.slice(1)} is off** · ${blame(roast.who)}`;
        yield* (yield* Discord).createMessage(config.gameChannelId, {
          content: `${head}\n> ${yield* (yield* Roasts).next(culprits)}`,
          // everyone hears it's off; the culprits are named in it
          allowed_mentions: yield* allowedMentions(ps),
          message_reference: n.message_id ? { message_id: n.message_id, fail_if_not_exists: false } : undefined,
        });
      }).pipe(Effect.tapError(() => db.update(gameNights).set({ roasted_at: null }).where(eq(gameNights.day, day)))); // the next minute retries
      return true;
    }),
  );

/** Every minute: roasts that were held for the morning. */
export const dueRoastsNow = Effect.gen(function* () {
  const db = yield* Db;
  const now = yield* currentSec;
  const due = yield* db
    .select({ day: gameNights.day })
    .from(gameNights)
    .where(and(eq(gameNights.stage, "off"), sql`${gameNights.roast} IS NOT NULL`, isNull(gameNights.roasted_at), lte(gameNights.roast_due, now)));
  const posted: string[] = [];
  for (const { day } of due) if (yield* postRoastOf(day)) posted.push(day);
  return posted;
});

/** A hold is up: the maybes are cleared and those players asked again, with an hour to answer. */
const resumeNight = (n: Night) => Effect.uninterruptible(resumeOnce(n)); // the claim → the card → the ping (§15)
const resumeOnce = Effect.fnUntraced(function* (n: Night) {
  const db = yield* Db;
  const ps = yield* theTrio;
  const now = yield* currentSec;
  const unsure = yield* db.transaction((tx) =>
    Effect.gen(function* () {
      const claimed = yield* tx
        .update(gameNights)
        .set({ paused_until: null, stage_at: now, warned: null, renudged: null })
        .where(and(eq(gameNights.day, n.day), eq(gameNights.stage, "ask"), eq(gameNights.paused_until, n.paused_until!)))
        .returning({ day: gameNights.day });
      if (!claimed.length) return null;
      const gone = yield* tx
        .delete(gameNightVotes)
        .where(and(eq(gameNightVotes.day, n.day), eq(gameNightVotes.stage, "ask"), eq(gameNightVotes.choice, "maybe")))
        .returning({ user: gameNightVotes.user_id });
      // in player order, like every other ping (the delete returns rows in any order)
      return ps.filter((p) => gone.some((g) => g.user === p));
    }),
  );
  if (!unsure) return false;
  yield* refreshCard(n.day);
  const w = yield* when;
  const fresh = yield* nightOf(n.day);
  const by = stamp(w, deadlineFor(w, fresh));
  const tonight = n.day === today(w) ? "tonight" : `on ${weekdayOf(n.day)}`;
  yield* nudge(
    n.day,
    unsure,
    finalCall(fresh)
      ? `⏰ Final call: are you in ${tonight}? It's ✅ or ✖️ now, no more maybes. Answer by ${by} ⬆️`
      : `⏰ Decision time: are you in ${tonight}? Still not sure? 🤔 Maybe once more gives you 1 more hour. Answer by ${by} ⬆️`,
  );
  return true;
});

/** An error as today's `String(e)` printed it (the minute job's result names failures with it). */
const errorText = (e: unknown) => (e instanceof Error && "_tag" in e && String(e._tag).startsWith("Discord") ? `Error: ${e.message}` : String(e));

/**
 * Every minute: keep open cards fresh (drops start times that just passed), ping
 * anyone who's left a stage waiting for an hour (once per stage), and ping the squad when a
 * locked-in night starts.
 */
export const maintainAll = Effect.gen(function* () {
  const db = yield* Db;
  const alerts = yield* Alerts;
  const w = yield* when;
  const t = w.now;
  const done: Record<string, unknown> = {};
  const open = yield* db
    .select()
    .from(gameNights)
    .where(and(gte(gameNights.day, today(w)), inArray(gameNights.stage, OPEN), sql`${gameNights.message_id} IS NOT NULL`));

  // reminders wait for daytime: nobody gets pinged about a poll between midnight and 09:00
  const awake = localOf(w).hour >= 9;
  for (const n of open) {
    // one night's trouble (say, a card deleted by hand) must not hold up the others
    yield* maintainNight(n, t, awake, done).pipe(
      Effect.catch((e) =>
        Effect.andThen(alerts.failed("game-night upkeep", e, n.day), Effect.sync(() => void (done[`failed ${n.day}`] = errorText(e).slice(0, 120)))),
      ),
    );
  }

  // a start the timer missed (say, the bot was restarting at that moment): catch up within 30 min
  const due = yield* db
    .select()
    .from(gameNights)
    .where(and(eq(gameNights.stage, "set"), eq(gameNights.reminded, false), lte(gameNights.start_at, t)));
  for (const n of due) if (n.start_at! >= t - 1800 && (yield* claimStart(n))) done.reminded = n.day;
  return done;
});

const maintainNight = Effect.fnUntraced(function* (n: Night, t: number, awake: boolean, done: Record<string, unknown>) {
  const db = yield* Db;
  const w = yield* when;
  // drop start times that just passed (every 15 min is plenty; the tick runs every minute)
  if (n.stage === "time" && localOf(w).minute % 15 === 0) yield* refreshCard(n.day);
  if (n.stage === "ask" && n.paused_until) {
    // 🤔 on hold: no deadline meanwhile. When it's up, the unsure answer again
    if (t >= n.paused_until && (yield* resumeNight(n))) done[`resumed ${n.day}`] = true;
    return;
  }
  const { who, missing } = yield* culprits(n);
  const deadline = deadlineFor(w, n);
  const ps = yield* theTrio;
  // everyone voted for a game but it's split: the clock still runs, for all three
  const split = n.stage === "game" && !missing.length;
  if (split && t >= deadline) {
    if (yield* callNightOff(n, {}, "🤷 We couldn't agree on a game in time. Maybe tomorrow 🫡")) {
      yield* refreshCard(n.day);
      done[`split ran out ${n.day}`] = true;
    }
    return;
  }
  if (split && awake && t >= deadline - WARN_BEFORE && n.warned !== n.stage) {
    // the claim → the ping, never cut short (§15)
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const claimed = yield* db
          .update(gameNights)
          .set({ warned: n.stage })
          .where(and(eq(gameNights.day, n.day), eq(gameNights.stage, n.stage), or(isNull(gameNights.warned), ne(gameNights.warned, n.stage))))
          .returning({ day: gameNights.day });
        if (claimed.length) {
          const left = Math.max(1, Math.round((deadline - t) / 60));
          yield* nudge(n.day, ps, `⏳ Still split: ${left} min for two of you to agree on a game, or the night's off ⬆️`);
          done[`warned ${n.day}`] = "split";
        }
      }),
    );
    return;
  }
  if (missing.length && t >= deadline) {
    // 🔥 time's up: the votes come out, the night's off, and whoever sank it gets roasted
    if (yield* callNightOff(n, who)) {
      yield* refreshCard(n.day);
      yield* postRoastOf(n.day);
      done[`called off ${n.day}`] = who;
    }
    return;
  }
  if (awake && missing.length && t >= deadline - WARN_BEFORE && n.warned !== n.stage) {
    // the claim → the ping, never cut short (§15)
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const claimed = yield* db
          .update(gameNights)
          .set({ warned: n.stage })
          .where(and(eq(gameNights.day, n.day), eq(gameNights.stage, n.stage), or(isNull(gameNights.warned), ne(gameNights.warned, n.stage))))
          .returning({ day: gameNights.day });
        if (claimed.length) {
          const left = Math.max(1, Math.round((deadline - t) / 60));
          yield* nudge(n.day, missing, `⏳ Last call: ${left} min to vote, or game night's off and you get roasted 🔥 ⬆️`);
          done[`warned ${n.day}`] = missing;
        }
      }),
    );
    return;
  }
  if (awake && missing.length && n.renudged !== n.stage && t - (n.stage_at ?? t) >= RENUDGE_AFTER) {
    // the claim → the ping, never cut short (§15)
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const claimed = yield* db
          .update(gameNights)
          .set({ renudged: n.stage })
          .where(and(eq(gameNights.day, n.day), eq(gameNights.stage, n.stage), or(isNull(gameNights.renudged), ne(gameNights.renudged, n.stage))))
          .returning({ day: gameNights.day });
        if (claimed.length) {
          const tonight = n.day === today(w) ? "tonight" : `on ${weekdayOf(n.day)}`;
          const ask = { ask: `are you in ${tonight}?`, game: "pick a game so we can get going", time: "when can you start?" }[n.stage as "ask"];
          yield* nudge(n.day, missing, `⏳ still waiting on you: ${ask} ⬆️`);
          done[`renudged ${n.day}`] = missing;
        }
      }),
    );
  }
});

/** Sleep until `ms` (epoch ms), on the Clock. */
const sleepUntil = (ms: number) =>
  Effect.flatMap(Clock.currentTimeMillis, (now) => Effect.sleep(Duration.millis(Math.max(0, ms - now))));

/** Locked-in nights starting after now and by `until` (unix seconds) that haven't started yet. */
export const upcoming = Effect.fnUntraced(function* (until: number) {
  const db = yield* Db;
  const now = yield* currentSec;
  return yield* db
    .select()
    .from(gameNights)
    .where(and(eq(gameNights.stage, "set"), eq(gameNights.reminded, false), gt(gameNights.start_at, now), lte(gameNights.start_at, until)));
});

/**
 * Starts due by `until` (unix seconds): wait for them, open the room a few seconds early, then
 * move everyone and ping at the exact start time. The scheduler calls this every minute for the
 * next two; the claim in claimStart makes overlapping calls harmless.
 */
export const startsDue = Effect.fnUntraced(function* (until: number) {
  const started: string[] = [];
  const due = yield* upcoming(until);
  // every start at once: each waits for its own second, and one start's failure doesn't cut the others short
  const results = yield* Effect.all(
    due.map((n) => Effect.map(startAt(n), (ok) => void (ok && started.push(n.day)))),
    { concurrency: "unbounded", mode: "result" },
  );
  const failed = results.find(Result.isFailure);
  if (failed) return yield* failed.failure;
  return started;
});

/**
 * Wait until just before the night's start, then run it on the dot (unless it was cancelled or moved
 * meanwhile). `stop` ends the wait early (shutting down: the next leader, or the minute job, starts it).
 */
export const startAt = Effect.fnUntraced(function* (n: Night, stop: Effect.Effect<void> = Effect.never) {
  const stopped = yield* sleepUntil((n.start_at! - ROOM_EARLY) * 1000).pipe(Effect.as(false), Effect.raceFirst(Effect.as(stop, true)));
  if (stopped) return false;
  const fresh = yield* (yield* Nights).get(n.day);
  if (fresh?.stage !== "set" || fresh.start_at !== n.start_at) return false;
  return yield* claimStart(fresh, fresh.start_at! * 1000);
});

/**
 * Claim the start (once, whoever gets there first), then run it; a failure releases the claim. A
 * start that has begun finishes (architecture §15): from the claim on it isn't cut short.
 */
const claimStart = (n: Night, at?: number) =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      const db = yield* Db;
      const alerts = yield* Alerts;
      const claimed = yield* db
        .update(gameNights)
        .set({ reminded: true })
        .where(and(eq(gameNights.day, n.day), eq(gameNights.stage, "set"), eq(gameNights.reminded, false), eq(gameNights.start_at, n.start_at!)))
        .returning({ day: gameNights.day });
      if (!claimed.length) return false;
      const pinged = yield* startReminder(n, at).pipe(
        Effect.as(true),
        Effect.catch((e) =>
          Effect.gen(function* () {
            // the ping didn't go out: release the claim so the next minute tries again
            yield* alerts.failed("the start ping", e, n.day);
            yield* db.update(gameNights).set({ reminded: false }).where(eq(gameNights.day, n.day));
            return false;
          }),
        ),
      );
      if (!pinged) return false;
      // the ping is out: from here on a failure is reported and the claim stays, so it never goes twice
      yield* refreshCard(n.day).pipe(Effect.catch((e) => Effect.logInfo(`card refresh at start ${errorText(e)}`)));
      // a night counts as played once it actually starts (a locked-in night can still be called off)
      yield* db
        .update(gameTable)
        .set({ plays: sql`${gameTable.plays} + 1` })
        .where(eq(gameTable.name, n.game!))
        .pipe(Effect.catch((e) => alerts.failed("counting the night as played", e, n.day)));
      // already playing it unplanned today? Then that session is this night now, counted once
      yield* (yield* Spontaneous).absorb(n.day, n.game!).pipe(Effect.catch((e) => alerts.failed("merging the unplanned session into the night", e, n.day)));
      return true;
    }),
  );

/**
 * It's time: open the room, then (at `at`, epoch ms, when given) move the Lobby in, make the
 * event live and ping the squad.
 */
const startReminder = Effect.fnUntraced(function* (n: Night, at?: number) {
  const config = yield* AppConfig;
  const discord = yield* Discord;
  const alerts = yield* Alerts;
  const voice = yield* Voice;
  const ps = yield* theTrio;
  const emoji = yield* (yield* Games).emojiFor(n.game!);
  // open the game's voice room and bring the Lobby along; the ping still goes out if this fails
  let where = "Hop in 🔊";
  const room = yield* voice.openRoom(n.game!, emoji, { day: n.day, move: false }).pipe(Effect.catch((e) => Effect.as(alerts.failed("opening the game room", e, n.day), null)));
  if (at) yield* sleepUntil(at);
  // external events don't go live on their own (made live alongside the moves)
  const live = n.event_id
    ? yield* Effect.forkDetach(Effect.asVoid(discord.editEvent(n.event_id, { status: 2 })).pipe(Effect.catch((e) => Effect.logInfo(`event start ${errorText(e)}`))), { startImmediately: true })
    : null;
  if (room) {
    const moved = yield* voice.moveFromLobby(room.channelId).pipe(Effect.catch((e) => Effect.as(alerts.failed("moving people from the Lobby", e, n.day), [] as string[])));
    yield* (yield* Attendances).markArrived(n.day, moved);
    where = `Room: <#${room.channelId}>${moved.length ? ` (moved ${moved.map(mention).join(" ")} from the Lobby)` : ""}`;
  }
  if (live) yield* Fiber.join(live);
  yield* discord.createMessage(config.gameChannelId, {
    content: `⏰ ${ps.map(mention).join(" ")} ${emoji} **${n.game}** starts now! ${where}`,
    allowed_mentions: yield* allowedMentions(ps),
    message_reference: n.message_id ? { message_id: n.message_id, fail_if_not_exists: false } : undefined,
  });
});

/** Private heads-up after a click, when we also re-render the card. */

// ---------------------------------------------------------------- rendering

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
export const renderCard = Effect.fnUntraced(function* (day: string, viewer?: string, notice?: string) {
  const config = yield* AppConfig;
  const games = yield* Games;
  const w = yield* when;
  const n = yield* nightOf(day);
  const ps = yield* theTrio;
  const me = viewer && ps.includes(viewer) ? viewer : null;
  const date = ts(Math.floor(Date.parse(`${day}T12:00:00Z`) / 1000), "D");
  const id = (action: string) => `gn:${day}:${action}`;
  const out = button(2, "🚪", "I'm out", id("out"));
  const starter = n.started_by ? ` · ${day > today(w) ? "planned" : "started"} by ${mention(n.started_by)}` : "";
  const deadline = deadlineFor(w, n);
  const closes = `-# ⏳ Vote by ${ts(deadline, day === today(w) ? "t" : "f")} (${ts(deadline, "R")}). No vote by then = night's off and you get roasted 🔥`;
  let body: unknown[] = yield* Match.value(n.stage).pipe(
    Match.when("ask", () =>
      Effect.gen(function* () {
        const v = yield* votes(day, "ask");
        const isToday = day === today(w);
        const hidden = yield* secret(n);
        const last = finalCall(n);
        const unsure = ps.filter((p) => v[p] === "maybe");
        const waiting = ps.filter((p) => !v[p] || (last && v[p] === "maybe"));
        const whom = waiting.length ? ` for ${waiting.map(mention).join(" ")}` : "";
        let status: string;
        if (hidden)
          status = `🤫 Answers stay secret until everyone's answered · waiting on ${waiting.length} more · it's on when all ${ps.length} say yes · not sure yet? 🤔 Maybe puts it on hold for 2 h`;
        else if (n.paused_until)
          status = `Sure already? Change your answer any time: all ✅ and we're on. ${n.maybes < HOLDS.length ? "Still unsure after this? One more 🤔 holds it 1 more hour, then it's yes or no." : "This is the last hold: after it, it's ✅ or ✖️."}`;
        else if (last) status = `⏰ Final call${whom}: it's ✅ or ✖️ now, no more maybes.`;
        else if (n.maybes) status = `⏰ Decision time${whom}: in or out? Still not sure? 🤔 Maybe once more holds it 1 more hour (the last one).`;
        // revealed with nobody unsure means everyone answered and someone can't (all yes would have moved on)
        else status = `😴 Not ${isToday ? "tonight" : "that day"}… unless someone changes their mind (answers can change until the end of ${isToday ? "today" : weekdayOf(day)}).`;
        const mark = (p: string) => (!v[p] ? "⏳" : hidden ? "🗳️" : ANSWER[v[p]]);
        const question = isToday ? "Are we playing today?" : `📅 Are we playing on ${weekdayOf(day)}?`;
        // your answer stays coloured, the others grey out
        const pick = (choice: string, style: number) => (me && v[me] && v[me] !== choice ? 2 : style);
        return [
          text(`## 🎮 Game night? · ${date}\n### ${last ? `⏰ Final call! ${question}` : question}`),
          text(ps.map((p) => `${mark(p)} ${mention(p)}`).join("　")),
          ...(n.paused_until
            ? [text(`⏸️ **On hold** until ${stamp(w, n.paused_until)} (${ts(n.paused_until, "R")}): ${unsure.map(mention).join(" & ")} ${unsure.length > 1 ? "aren't" : "isn't"} sure yet. Then I'll ask again.`)]
            : []),
          text(`-# ${status}${starter}${hidden || (n.maybes && !n.paused_until) ? `\n${closes}` : ""}`),
          row(
            button(pick("yes", 3), "✅", "I'm in", id("yes")),
            ...(last ? [] : [button(pick("maybe", 1), "🤔", "Maybe", id("maybe"))]),
            button(pick("no", 4), "✖️", isToday ? "Not today" : "Can't", id("no")),
          ),
        ];
      }),
    ),
    Match.when("game", () =>
      Effect.gen(function* () {
        const v = yield* votes(day, "game");
        const list = yield* games.list();
        // everyone's voted and we're still here: it's split, so the picks are out and you re-vote
        const split = ps.every((p) => v[p]);
        const picks = split ? yield* gameVotesLine(day) : null;
        return [
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
      }),
    ),
    Match.when("time", () =>
      Effect.gen(function* () {
        const v = yield* votes(day, "time");
        const until = yield* votes(day, "until");
        const f = fit(ps, v, until, soonest(w));
        const at = (t: number) => `**${timeLabel(w, t, day)}**`;
        const hidden = yield* secret(n);
        const lead = f.start === null || hidden ? null : Math.max(...ps.filter((p) => v[p]).map((p) => Number(v[p])));
        const lines = hidden
          ? [ps.map((p) => `${v[p] ? "🗳️" : "⏳"} ${mention(p)}`).join("　")]
          : ps.map((p) => {
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
        const times = timeOptionsFor(w, n, shown).map((t) => {
          const count = hidden ? 0 : ps.filter((p) => v[p] === String(t)).length;
          const style = me ? (t === mine ? 3 : 2) : t === lead ? 3 : 2;
          const b = button(style, null, `${timeLabel(w, t, day)}${count ? ` · ${count}` : ""}`, id(`time:${t}`));
          // on your copy, starts that leave you under an hour before your own 🏁 leave-by are greyed out
          const tooLate = me && until[me] && Number(until[me]) - t < MIN_TOGETHER && t !== mine;
          return tooLate ? { ...b, disabled: true } : b;
        });
        const myLeave = me && until[me] ? `Leave by ${timeLabel(w, Number(until[me]), day)}` : "Leave by";
        // the game vote is decided, so it's revealed
        const gameVotes = n.note ? null : yield* gameVotesLine(day);
        const notes = [...(gameVotes ? [`🗳️ ${gameVotes}`] : []), ...(n.note ? n.note.split("\n") : [])];
        return [
          text(`## ⏰ What time? · ${date}\n${notes.map((l) => `-# ${l}\n`).join("")}### ${yield* games.emojiFor(n.game!)} ${n.game} it is!`),
          text(`Pick the **earliest** time you can start. We kick off when everyone's ready.\n${lines.join("\n")}`),
          text(`${status}${f.ready ? "" : `\n${closes}`}`),
          ...rows([...times, button(1, "✏️", "Other time", id("custom")), button(me && until[me] ? 1 : 2, "🏁", myLeave, id("leaveby")), out]),
        ];
      }),
    ),
    Match.when("set", () =>
      Effect.gen(function* () {
        // different times aren't a tie: we start when the last person is free. Credit them.
        const v = yield* votes(day, "time");
        const picks = ps.filter((p) => v[p]).map((p) => Number(v[p]));
        const latest = Math.max(...picks);
        const slowpokes = ps.filter((p) => Number(v[p]) === latest);
        const flavour =
          picks.length === ps.length && Math.min(...picks) < latest
            ? `\n-# 🐢 Slowpoke of the night: ${slowpokes.map(mention).join(" & ")} (free from ${timeLabel(w, latest, day)}). Everyone else, warm up!`
            : "";
        const until = yield* votes(day, "until");
        const end = Object.values(until).length ? Math.min(...Object.values(until).map(Number)) : null;
        const leavers = end === null ? [] : ps.filter((p) => Number(until[p]) === end);
        const timeVotes = yield* timeVotesLine(day);
        const gameVotes = yield* gameVotesLine(day);
        const endLine = end === null ? "" : `\n🏁 until **${timeLabel(w, end, day)}** (${leavers.map(mention).join(" & ")} ${leavers.length > 1 ? "have" : "has"} to leave)`;
        // ⏰ who said they'd be late (before the start; after it, their slips say it)
        const lateBy = n.reminded ? {} : yield* (yield* Attendances).etas(day);
        const planned = n.planned_start ?? n.start_at!;
        const lateLine = Object.keys(lateBy).length
          ? `\n⏰ Running late: ${ps
              .filter((p) => lateBy[p])
              .map((p) => `${mention(p)} +${Math.round((lateBy[p] - planned) / 60)} min`)
              .join(" · ")}${planned !== n.start_at ? ` · start moved from ${timeLabel(w, planned, day)}` : ""}`
          : "";
        const history = n.start_at! < w.now - 3 * 3600;
        return [
          text(`## 🎉 Game night is ON · ${date}`),
          text(
            `### ${yield* games.emojiFor(n.game!)} ${n.game}\n🕐 **${timeLabel(w, n.start_at!, day)}** · ${ts(n.start_at!, "R")}${endLine}${lateLine}\n👥 ${timeVotes ?? ps.map(mention).join(" ")}${flavour}`,
          ),
          ...(gameVotes ? [text(`-# 🗳️ ${gameVotes}`)] : []),
          ...(history
            ? []
            : [
                text(n.reminded ? "-# ⏰ Running late? Tap your ETA:" : "-# ⏰ Running late? Tap how late: we wait for you, so the start moves for everyone (tap again to undo)"),
                row(...[5, 15, 30, 60].map((m) => button(2, "🏃", m === 60 ? "+1 h" : `+${m} min`, id(`late:${m}`)))),
              ]),
          row(
            ...(n.event_id
              ? [{ type: 2, style: 5, emoji: { name: "📅" }, label: "Event", url: `https://discord.com/events/${config.guildId}/${n.event_id}` }]
              : []),
            button(2, "🚪", "Can't make it", id("out")),
          ),
        ];
      }),
    ),
    Match.when("off", () =>
      Effect.gen(function* () {
        return [
          text(`## 😴 No game night · ${date}`),
          text(n.note ?? "Maybe tomorrow 🫡"),
          ...(yield* revealOff(day)),
          // still today (or a planned day ahead): let anyone who changed their mind start it over
          ...(day >= today(w) ? [row(button(2, "🔄", "Changed our minds? Reopen", id("reopen")))] : []),
        ];
      }),
    ),
    Match.exhaustive,
  );
  if (me) {
    // your private panel: just your answer and the buttons to change it. The card above already
    // shows everyone's progress, so it isn't repeated here.
    type Row = { type: number; components: { custom_id: string; label: string }[] };
    let controls = (body as Row[]).filter((c) => c.type === 1);
    if (n.stage === "ask") {
      const mine = (yield* votes(day, "ask"))[me];
      // you've answered: the only thing left to do is switch
      if (mine)
        controls = [
          row(
            ...controls[0].components
              .filter((b) => !b.custom_id.endsWith(`:${mine}`))
              .map((b) => ({ ...b, style: ({ yes: 3, maybe: 1, no: 4 } as Record<string, number>)[b.custom_id.split(":").pop()!], label: `Change to ${b.label}` })),
          ) as Row,
        ];
    }
    body = [...(notice ? [text(notice)] : []), text(yield* yourVote(n, me)), ...controls, text("-# 🔒 Only you can see this. Tap here to change your answer; the card shows everyone's progress.")];
  }
  return {
    flags: IS_COMPONENTS_V2 | (me ? EPHEMERAL : 0),
    allowed_mentions: { parse: [] as string[] },
    components: [{ type: 17, accent_color: COLORS[n.stage], components: body }],
  };
});

/** The top of your private panel: what you've answered for the night's current step. */
const yourVote = Effect.fnUntraced(function* (n: Night, me: string) {
  const w = yield* when;
  const games = yield* Games;
  const isToday = n.day === today(w);
  const tonight = isToday ? "tonight" : `on ${weekdayOf(n.day)}`;
  const title = `### 🔒 Your vote · ${isToday ? "today" : weekdayOf(n.day)}`;
  return yield* Match.value(n.stage).pipe(
    Match.when("ask", () =>
      Effect.gen(function* () {
        const v = (yield* votes(n.day, "ask"))[me];
        const later = n.paused_until
          ? `I'll ask you again at ${stamp(w, n.paused_until)}.`
          : `Once everyone's answered (and nobody said no), it goes on hold for ${HOLDS[Math.min(n.maybes, HOLDS.length - 1)] / 3600} h and I'll ask you again.`;
        const line =
          v === "yes"
            ? `✅ You're **in** ${tonight}.`
            : v === "no"
              ? `✖️ You said **${isToday ? "not today" : "you can't"}**.`
              : v === "maybe" && !finalCall(n)
                ? `🤔 You said **maybe**. ${later}`
                : finalCall(n)
                  ? `⏰ Final call: are you in ${tonight}? No more maybes.`
                  : n.maybes
                    ? `⏰ Decision time: are you in ${tonight}?`
                    : `Are you in ${tonight}?`;
        return `${title}\n${line}`;
      }),
    ),
    Match.when("game", () =>
      Effect.gen(function* () {
        const v = (yield* votes(n.day, "game"))[me];
        return `${title}\n${v ? `🗳️ You picked ${yield* games.emojiFor(v)} **${v}**` : "🎯 Pick a game:"}`;
      }),
    ),
    Match.when("time", () =>
      Effect.gen(function* () {
        const v = (yield* votes(n.day, "time"))[me];
        const leaves = yield* votes(n.day, "until");
        const until = leaves[me];
        const start = v ? `🕐 You can start from **${timeLabel(w, Number(v), n.day)}**.` : "🕐 When can you start? Tap the earliest time:";
        // someone else's leave-by limits your start too (who it is stays secret)
        const end = Object.values(leaves).length ? Math.min(...Object.values(leaves).map(Number)) : null;
        const theirs =
          end !== null && Number(until) !== end
            ? `\n-# 🏁 Someone has to leave by ${timeLabel(w, end, n.day)}, so start by ${timeLabel(w, end - MIN_TOGETHER, n.day)} to get an hour together.`
            : "";
        return `${title}\n${start}${until ? `\n🏁 You have to leave by **${timeLabel(w, Number(until), n.day)}**.` : ""}${theirs}`;
      }),
    ),
    Match.when("set", () =>
      Effect.map(
        games.emojiFor(n.game!),
        (emoji) => `${title}\n🎉 It's on: ${emoji} **${n.game}** at **${timeLabel(w, n.start_at!, n.day)}**.${n.reminded ? "" : "\n-# ⏰ Running late? Tap how late:"}`,
      ),
    ),
    Match.when("off", () => Effect.succeed(`${title}\n😴 Game night's off.`)),
    Match.exhaustive,
  );
});

/** Ephemeral "which day?" picker for planning ahead: today plus the next 6 days. */
export const planPickerCard = Effect.gen(function* () {
  const db = yield* Db;
  const first = today(yield* when);
  const days = Array.from({ length: 7 }, (_, i) => new Date(Date.parse(`${first}T12:00:00Z`) + i * 864e5).toISOString().slice(0, 10));
  const existing = yield* db
    .select({ day: gameNights.day, stage: gameNights.stage })
    .from(gameNights)
    .where(and(gte(gameNights.day, days[0]), lte(gameNights.day, days[6])));
  const has = new Map(existing.map((n) => [n.day, n.stage]));
  const mark: Record<Stage, string> = { ask: "🗳️", game: "🕹️", time: "⏰", set: "🎉", off: "😴" };
  const buttons = days.map((d, i) => {
    const label = i === 0 ? "Today" : i === 1 ? "Tomorrow" : `${weekdayOf(d).slice(0, 3)} ${Number(d.slice(8))}`;
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
});

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
export const leaveBy = Effect.fnUntraced(function* (day: string, user: string) {
  const w = yield* when;
  const current = (yield* votes(day, "until"))[user];
  return modal(`gn:${day}:until`, "When do you have to leave?", {
    label: "Leave by (HH:MM). Leave empty for no limit",
    placeholder: "22:30",
    max_length: 5,
    required: false,
    ...(current ? { value: clock(w, Number(current)) } : {}),
  });
});

/** Testing/maintenance: wipe a day's night (card, nudge, event, votes). */
export const wipeNight = Effect.fnUntraced(function* (day: string) {
  const config = yield* AppConfig;
  const db = yield* Db;
  const discord = yield* Discord;
  const n = yield* (yield* Nights).get(day);
  if (!n) return { reset: false };
  if (n.message_id) yield* discord.deleteMessage(config.gameChannelId, n.message_id).pipe(Effect.ignore);
  yield* clearNudge(n);
  if (n.event_id) yield* discord.deleteEvent(n.event_id).pipe(Effect.ignore);
  yield* db.transaction((tx) =>
    Effect.gen(function* () {
      yield* clearDay(tx, day);
      yield* tx.delete(gameNights).where(eq(gameNights.day, day));
    }),
  );
  return { reset: true };
});

/** A day's votes and attendance (reopen and reset start the day over). */
const clearDay = (tx: DbTx, day: string) =>
  Effect.gen(function* () {
    yield* tx.delete(gameNightVotes).where(eq(gameNightVotes.day, day));
    yield* tx.delete(nightAttendance).where(eq(nightAttendance.day, day));
  });

// ---------------------------------------------------------------- the service

/** What the night's code runs on. */
type Needs = AppConfig | Db | Discord | Nights | Games | Attendances | Panels | Alerts | Snoozes | Roasts | Voice | Spontaneous;

const makeGameNight = Effect.gen(function* () {
  // the services, captured once; a call's own overrides (quiet, stand-in players) still come from
  // the caller, since providing merges this over the caller's context
  const ctx = yield* Effect.context<Needs>();
  const bound =
    <Args extends ReadonlyArray<unknown>, A, E>(f: (...args: Args) => Effect.Effect<A, E, Needs>) =>
    (...args: Args) =>
      Effect.provideContext(f(...args), ctx);
  return {
    /** Post a day's card if there isn't one yet (see openNight). */
    startNight: bound(openNight),
    retryUnposted: Effect.provideContext(retryCards, ctx),
    refreshOpen: Effect.provideContext(refreshCards, ctx),
    closeStale: Effect.provideContext(closeStaleCards, ctx),
    refresh: bound(refreshCard),
    syncPanels: bound(syncCopies),
    act: (day: string, user: string, action: string, value: string | undefined, later: Deferred) =>
      Effect.provideContext(actOn(day, user, action, value, (e) => later(Effect.provideContext(e, ctx))), ctx),
    bailFromSlip: bound(bailOn),
    postRoast: (day: string) => Effect.provideContext(postRoastOf(day), ctx),
    dueRoasts: Effect.provideContext(dueRoastsNow, ctx),
    maintain: Effect.provideContext(maintainAll, ctx),
    upcomingStarts: bound(upcoming),
    preciseStarts: bound(startsDue),
    startOnTime: (n: Night, stop?: Effect.Effect<void>) => Effect.provideContext(startAt(n, stop), ctx),
    render: (day: string, viewer?: string, notice?: string) => Effect.provideContext(renderCard(day, viewer, notice), ctx),
    planPicker: Effect.provideContext(planPickerCard, ctx),
    leaveByModal: bound(leaveBy),
    resetNight: bound(wipeNight),
  };
});

/** 🎮 The daily game-night planner: the card, its votes, deadlines, roasts and the start. */
export class GameNight extends Context.Service<GameNight, Effect.Success<typeof makeGameNight>>()("meme-bot/gamenight") {
  static readonly layer = Layer.effect(GameNight, makeGameNight);
}
