// Scheduled work. The scheduler (scheduler.ts) runs `minute()` at the top of every minute; every job
// is idempotent and guarded by the database, so a run can be repeated, skipped or overlap safely,
// and one failing job doesn't stop the others.
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Env } from "./env.js";
import { memes } from "./db/index.js";
import { api } from "./discord.js";
import * as db from "./memes.js";
import * as gn from "./gamenight.js";
import * as late from "./late.js";
import * as voice from "./voice.js";
import * as activity from "./activity.js";
import * as reddit from "./reddit.js";
import { leaderboardMessage, memeMessage } from "./ui.js";

const JOBS: [string, (env: Env) => Promise<unknown>][] = [
  ["refill", reddit.maybeRefill], // the meme pool, from Reddit every 6 h (in the background)
  ["meme", postDaily], // posts once per day at or after POST_HOUR_UTC, from memes the fetcher ingested
  ["meme-recaps", memeRecaps], // 🏆 Meme of the Week (Sun 18:00 UTC), 👑 Hall of Fame (1st, 09:00 UTC)
  ["close", gn.closeStale], // midnight: close yesterday's unfinished poll
  ["start", (e) => gn.startNight(e)], // 17:00 poll, unless /playtoday already started one
  ["retry", gn.retryUnposted], // planned days whose card failed to post
  ["maintain", gn.maintain], // refresh time options, re-nudges, starts the timer missed
  ["roasts", gn.dueRoasts], // 🔥 roasts held overnight go out in the morning
  ["late", late.watch], // latecomers: pull from the Lobby, late slips, "made it"
  ["rooms", voice.maintainRooms], // empty game rooms → 🗄️ Recent games → deleted
  ["recaps", activity.recaps], // 📊 last week / month / year in #game-night, once each
];

/** Every minute. Returns what each job did (for logs and the admin test route). */
export async function minute(env: Env) {
  const out: Record<string, unknown> = {};
  for (const [name, job] of JOBS) out[name] = await job(env).catch((e) => ({ error: String(e) }));
  return out;
}

// ---------------------------------------------------------------- daily post

/**
 * Post the top meme published yesterday (UTC). Safe to call any number of times: the
 * database allows exactly one daily per day, so the fetcher and the schedule can't double-post.
 */
export async function postDaily(env: Env) {
  if (new Date().getUTCHours() < Number(env.POST_HOUR_UTC)) return { skipped: "too early" };
  if (reddit.refilling()) return { skipped: "waiting for the refill" };
  const day = db.utcDay(-1);
  const [existing] = await env.db
    .select({ id: memes.id })
    .from(memes)
    .where(and(eq(memes.post_kind, "daily"), eq(memes.day, day)));
  if (existing) return { skipped: "already posted", day };

  const candidates = await env.db
    .select()
    .from(memes)
    .where(and(isNull(memes.post_kind), sql`substr(${memes.published}, 1, 10) = ${day}`))
    .orderBy(sql`${memes.rank} ASC NULLS LAST`)
    .limit(5);
  for (const cand of candidates) {
    if (!(await db.claim(env, cand.id, "daily", { day }))) continue;
    const meme = { ...cand, post_kind: "daily" as const, day };
    let msg: { id: string };
    try {
      msg = await api(env, "POST", `/channels/${env.CHANNEL_ID}/messages`, memeMessage(meme, {}, env.SUBREDDIT));
    } catch (e) {
      await db.unclaim(env, cand.id);
      throw e;
    }
    await db.setMessage(env, cand.id, env.CHANNEL_ID, msg.id);
    await api(env, "POST", `/channels/${env.CHANNEL_ID}/messages/${msg.id}/threads`, {
      name: `💬 ${cand.title}`.slice(0, 100),
      auto_archive_duration: 1440,
    }).catch((e) => console.log("thread failed", e));
    return { posted: cand.id, day };
  }
  return { skipped: "no candidate", day };
}

// ---------------------------------------------------------------- meme recaps

/** 🏆 weekly on Sunday from 18:00 UTC, 👑 monthly on the 1st from 09:00 UTC; each posts once. */
async function memeRecaps(env: Env) {
  const d = new Date();
  const out: Record<string, unknown> = {};
  if (d.getUTCDay() === 0 && d.getUTCHours() >= 18) out.week = await weeklyRecap(env);
  if (d.getUTCDate() === 1 && d.getUTCHours() >= 9) out.month = await monthlyRecap(env);
  return out;
}

async function recap(env: Env, period: string, title: string, since: Date, until: Date, accent?: number) {
  if (!(await db.claimRecap(env, period))) return { skipped: "already posted", period };
  try {
    const rows = await db.leaderboard(env, since.toISOString(), until.toISOString(), 5);
    if (!rows.length) {
      await db.unclaimRecap(env, period);
      return { skipped: "no votes", period };
    }
    const voter = await db.topVoter(env, since.toISOString(), until.toISOString());
    const streak = await db.longestLiveStreak(env);
    const extras = [
      voter && `🗳️ Most votes: <@${voter.user_id}> (${voter.n})`,
      streak && streak.streak > 1 && `🔥 Longest streak: <@${streak.user_id}> (${streak.streak} days)`,
    ].filter(Boolean) as string[];
    await api(env, "POST", `/channels/${env.CHANNEL_ID}/messages`, leaderboardMessage(title, rows, env.GUILD_ID, extras, accent));
    return { posted: period };
  } catch (e) {
    await db.unclaimRecap(env, period);
    throw e;
  }
}

export function weeklyRecap(env: Env) {
  const until = new Date();
  const since = new Date(until.getTime() - 7 * 864e5);
  return recap(env, `week:${db.utcDay()}`, "## 🏆 Meme of the Week\n-# The server has spoken. Top 5 by votes:", since, until);
}

export function monthlyRecap(env: Env) {
  const until = new Date();
  until.setUTCDate(1);
  until.setUTCHours(0, 0, 0, 0);
  const since = new Date(until);
  since.setUTCMonth(since.getUTCMonth() - 1);
  const label = since.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  return recap(env, `month:${since.toISOString().slice(0, 7)}`, `## 👑 Hall of Fame · ${label}`, since, until, 0xe91e63);
}
