// Scheduled work. The scheduler (scheduler.ts) runs `minute()` at the top of every minute; every job
// is idempotent and guarded by the database, so a run can be repeated, skipped or overlap safely,
// and one failing job doesn't stop the others.
import { and, eq, isNull, sql } from "drizzle-orm";
import { Cause, Clock, Context, DateTime, Effect, Layer } from "effect";
import { memes } from "./db/schema.js";
import { Db, type DbError } from "./db/db.js";
import { AppConfig } from "./config.js";
import { Discord, type DiscordError } from "./discord.js";
import { Memes, utcDayAt } from "./memes.js";
import { GameNight } from "./gamenight.js";
import { LateSlips } from "./late.js";
import { Voice } from "./voice.js";
import { Activity } from "./activity.js";
import { Reddit } from "./reddit.js";
import { Cleanup } from "./cleanup.js";
import { MemeShame } from "./memeshame.js";
import { Spontaneous } from "./spontaneous.js";
import { News } from "./news.js";
import { Alerts } from "./alerts.js";
import { leaderboardMessage, memeMessage } from "./ui.js";

const DAY_MS = 864e5;
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
/** A failure as today's `String(e)` printed it (the minute's result names failures with it). */
const errorText = (e: unknown) => (e instanceof Error && "_tag" in e && String(e._tag).startsWith("Discord") ? `Error: ${e.message}` : String(e));

export class Jobs extends Context.Service<
  Jobs,
  {
    /** Every minute. Returns what each job did (for logs and the admin test route). */
    readonly minute: Effect.Effect<Record<string, unknown>>;
    /**
     * Post the top meme published yesterday (UTC). Safe to call any number of times: the
     * database allows exactly one daily per day, so the fetcher and the schedule can't double-post.
     */
    readonly postDaily: Effect.Effect<{ posted?: string; skipped?: string; day?: string }, DbError | DiscordError>;
    readonly weeklyRecap: Effect.Effect<{ posted?: string; skipped?: string; period?: string }, DbError | DiscordError>;
    readonly monthlyRecap: Effect.Effect<{ posted?: string; skipped?: string; period?: string }, DbError | DiscordError>;
  }
>()("meme-bot/jobs") {
  static readonly layer = Layer.effect(
    Jobs,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const db = yield* Db;
      const discord = yield* Discord;
      const memeService = yield* Memes;
      const gameNight = yield* GameNight;
      const late = yield* LateSlips;
      const voice = yield* Voice;
      const activity = yield* Activity;
      const reddit = yield* Reddit;
      const cleanup = yield* Cleanup;
      const memeShame = yield* MemeShame;
      const spontaneous = yield* Spontaneous;
      const news = yield* News;
      const alerts = yield* Alerts;

      // ---------------------------------------------------------------- daily post

      const postDaily = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (DateTime.toPartsUtc(DateTime.makeUnsafe(now)).hour < config.postHourUtc) return { skipped: "too early" };
        if (yield* reddit.refilling) return { skipped: "waiting for the refill" };
        const day = utcDayAt(now, -1);
        const [existing] = yield* db
          .select({ id: memes.id })
          .from(memes)
          .where(and(eq(memes.post_kind, "daily"), eq(memes.day, day)));
        if (existing) return { skipped: "already posted", day };

        const candidates = yield* db
          .select()
          .from(memes)
          .where(and(isNull(memes.post_kind), sql`substr(${memes.published}, 1, 10) = ${day}`))
          .orderBy(sql`${memes.rank} ASC NULLS LAST`)
          .limit(5);
        for (const cand of candidates) {
          // claim → post → its id is never cut short (architecture §15); a failed post gives the claim back
          const msg = yield* Effect.uninterruptible(
            Effect.gen(function* () {
              if (!(yield* memeService.claim(cand.id, "daily", { day }))) return null;
              const meme = { ...cand, post_kind: "daily" as const, day };
              const posted = yield* discord.createMessage(config.channelId, memeMessage(meme, {}, config.subreddit)).pipe(Effect.tapError(() => memeService.unclaim(cand.id)));
              yield* memeService.setMessage(cand.id, config.channelId, posted.id);
              return posted;
            }),
          );
          if (!msg) continue;
          yield* discord
            .createThread(config.channelId, msg.id, { name: `💬 ${cand.title}`.slice(0, 100), auto_archive_duration: 1440 })
            .pipe(Effect.catch((e) => alerts.failed("opening the meme's comment thread", e)));
          return { posted: cand.id, day };
        }
        return { skipped: "no candidate", day };
      }).pipe(Effect.withSpan("Jobs.postDaily"));

      // ---------------------------------------------------------------- meme recaps

      const recap = (period: string, title: string, since: number, until: number, accent?: number) =>
        // claim → post is never cut short (§15); a failure, or nothing to show, gives the claim back
        Effect.uninterruptible(
          Effect.gen(function* () {
            if (!(yield* memeService.claimRecap(period))) return { skipped: "already posted", period };
            return yield* Effect.gen(function* () {
              const rows = yield* memeService.leaderboard(iso(since), iso(until), 5);
              if (!rows.length) {
                yield* memeService.unclaimRecap(period);
                return { skipped: "no votes", period };
              }
              const voter = yield* memeService.topVoter(iso(since), iso(until));
              const streak = yield* memeService.longestLiveStreak;
              const extras = [
                voter && `🗳️ Most votes: <@${voter.user_id}> (${voter.n})`,
                streak && streak.streak > 1 && `🔥 Longest streak: <@${streak.user_id}> (${streak.streak} days)`,
              ].filter(Boolean) as string[];
              yield* discord.createMessage(config.channelId, leaderboardMessage(title, rows, config.guildId, extras, accent));
              return { posted: period };
            }).pipe(Effect.tapError(() => memeService.unclaimRecap(period)));
          }),
        );

      const weeklyRecap = Effect.gen(function* () {
        const until = yield* Clock.currentTimeMillis;
        return yield* recap(`week:${utcDayAt(until)}`, "## 🏆 Meme of the Week\n-# The server has spoken. Top 5 by votes:", until - 7 * DAY_MS, until);
      });

      const monthlyRecap = Effect.gen(function* () {
        const p = DateTime.toPartsUtc(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
        const until = Date.UTC(p.year, p.month - 1, 1); // the 1st of this month, 00:00 UTC
        const since = Date.UTC(p.year, p.month - 2, 1);
        const label = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(since);
        return yield* recap(`month:${iso(since).slice(0, 7)}`, `## 👑 Hall of Fame · ${label}`, since, until, 0xe91e63);
      });

      /** 🏆 weekly on Sunday from 18:00 UTC, 👑 monthly on the 1st from 09:00 UTC; each posts once. */
      const memeRecaps = Effect.gen(function* () {
        const d = DateTime.toPartsUtc(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
        const out: Record<string, unknown> = {};
        if (d.weekDay === 0 && d.hour >= 18) out.week = yield* weeklyRecap;
        if (d.day === 1 && d.hour >= 9) out.month = yield* monthlyRecap;
        return out;
      });

      const JOBS = [
        ["refill", reddit.maybeRefill], // the meme pool, from Reddit every 6 h (in the background)
        ["meme", postDaily], // posts once per day at or after POST_HOUR_UTC, from memes the fetcher ingested
        ["meme-recaps", memeRecaps], // 🏆 Meme of the Week (Sun 18:00 UTC), 👑 Hall of Fame (1st, 09:00 UTC)
        ["close", gameNight.closeStale], // midnight: close yesterday's unfinished poll
        ["start", gameNight.startNight()], // the daily poll (17:00, 14:00 on weekends), unless started by hand or 😴 snoozed
        ["retry", gameNight.retryUnposted], // planned days whose card failed to post
        ["maintain", gameNight.maintain], // refresh time options, re-nudges, starts the timer missed
        ["roasts", gameNight.dueRoasts], // 🔥 roasts held overnight go out in the morning
        ["late", late.watch], // latecomers: pull from the Lobby, late slips, "made it"
        ["rooms", voice.maintainRooms], // empty game rooms → 🗄️ Recent games → deleted
        ["spontaneous", spontaneous.minute()], // 🎮 unplanned sessions wrap up; stale Lobby questions and notes go
        ["wow-news", news.check], // ⚔️ WoW: Forever news, every 30 min (in the background); off with no channel
        ["recaps", activity.recaps], // 📊 last week / month / year in #game-night, once each
        ["cleanup", cleanup.nightly], // 🧹 03:00: yesterday's bot messages leave #game-night
        ["meme-shame", memeShame.evening], // 😐 19:00: whoever stopped voting on the daily memes hears about it
        ["gateway", alerts.watchGateway], // 🚨 a DM if the live connection to Discord stays down
      ] as const;

      return Jobs.of({
        // the job runner is a boundary (architecture §6): whatever a job lets through is reported
        // under its name and the next job runs; an interruption (shutdown) is never swallowed
        minute: Effect.gen(function* () {
          const out: Record<string, unknown> = {};
          for (const [name, job] of JOBS) {
            const ran: Effect.Effect<unknown, { readonly _tag: string }> = job;
            out[name] = yield* ran.pipe(
              Effect.withSpan(`job ${name}`),
              Effect.catchCause((cause) => {
                if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
                const e = Cause.squash(cause);
                return Effect.as(alerts.failed(`the “${name}” job`, e), { error: errorText(e) });
              }),
            );
          }
          return out;
        }),
        postDaily,
        weeklyRecap,
        monthlyRecap,
      });
    }),
  );
}
