// 🧹 Every night at 03:00 (Vilnius) #game-night is swept: the bot's messages from before then go
// (yesterday's cards, nudges, pings, late slips, roasts), so the channel only ever shows what's
// current. Kept: pinned messages (the HQ panel), stats recaps, and anything belonging to a night
// that's still going (a card still taking votes, a planned day ahead, a started night whose room is
// still open). People's own messages are never touched. A night still going at 03:00 doesn't wait
// for the next sweep: once it has ended (its rooms wrapped up), a catch-up sweep takes it, once.
//
// "Only you can see this" messages aren't in the channel at all: Discord keeps them on your
// device, and they disappear when Discord reloads.
import { and, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { Clock, Context, Effect, Layer } from "effect";
import { gameNights, nightAttendance, rooms } from "./db/schema.js";
import { Db, type DbError } from "./db/db.js";
import { AppConfig } from "./config.js";
import { Discord, type DiscordError } from "./discord.js";
import { Memes } from "./memes.js";
import { Nights } from "./nights.js";
import { LocalTime } from "./localtime.js";
import { jsonText } from "./json.js";

const HOUR = 3; // local
const JUST_STARTED = 30 * 60; // a night this fresh counts as going even before its room shows up
const DISCORD_EPOCH = 1420070400000n;

const createdMs = (id: string) => Number((BigInt(id) >> 22n) + DISCORD_EPOCH);

export class Cleanup extends Context.Service<
  Cleanup,
  {
    /** Sweep #game-night: the bot's messages from before `cutoffMs`, except the keepers. */
    sweep(cutoffMs: number): Effect.Effect<{ deleted: number; kept: number }, DbError | DiscordError>;
    /** Minute job: the 03:00 sweep, once a day (claimed in the database, so it can't run twice). */
    readonly nightly: Effect.Effect<{ deleted?: number; kept?: number }, DbError | DiscordError>;
  }
>()("meme-bot/cleanup") {
  static readonly layer = Layer.effect(
    Cleanup,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const db = yield* Db;
      const discord = yield* Discord;
      const memes = yield* Memes;
      const nights = yield* Nights;
      const time = yield* LocalTime;

      /**
       * A started (or planned) night that's still going: not started yet, started in the last 30 min,
       * or a room of its still open (voice.ts archives a room once everyone has left for a while).
       */
      const going = Effect.fnUntraced(function* (n: typeof gameNights.$inferSelect, t: number) {
        if (!n.reminded) return (n.start_at ?? 0) > t; // planned and still ahead (a start that never happened: not going)
        if ((n.start_at ?? 0) > t - JUST_STARTED) return true;
        const open = yield* db.select({ id: rooms.channel_id }).from(rooms).where(and(eq(rooms.day, n.day), isNull(rooms.archived_at)));
        return open.length > 0;
      });

      /** Message ids still in use: cards, nudges and late slips of nights that aren't over. */
      const keepers = Effect.gen(function* () {
        const t = Math.floor((yield* Clock.currentTimeMillis) / 1000);
        const today = (yield* time.now).day;
        const all = yield* db.select().from(gameNights).where(or(gte(gameNights.day, today), inArray(gameNights.stage, ["ask", "game", "time", "set"])));
        const live: typeof all = [];
        for (const n of all) {
          if (n.day >= today || (["ask", "game", "time"].includes(n.stage) && !(yield* nights.isOver(n))) || (n.stage === "set" && (yield* going(n, t)))) live.push(n);
        }
        const ids = new Set<string>();
        for (const n of live) for (const id of [n.message_id, n.nudge_id]) if (id) ids.add(id);
        if (live.length) {
          const slips = yield* db
            .select({ id: nightAttendance.message_id })
            .from(nightAttendance)
            .where(and(inArray(nightAttendance.day, live.map((n) => n.day)), sql`${nightAttendance.message_id} IS NOT NULL`));
          for (const s of slips) ids.add(s.id!);
        }
        return ids;
      });

      const sweep = Effect.fn("Cleanup.sweep")(function* (cutoffMs: number) {
        const me = (yield* discord.currentUser).id;
        const keep = yield* keepers;
        const doomed: string[] = [];
        let before: string | undefined;
        // newest first, 100 at a time, back to the start of the channel
        for (;;) {
          const page = yield* discord.listMessages(config.gameChannelId, `?limit=100${before ? `&before=${before}` : ""}`);
          if (!page.length) break;
          for (const m of page) {
            if (m.author.id !== me || m.pinned || keep.has(m.id) || createdMs(m.id) >= cutoffMs) continue;
            if (jsonText(m.components ?? []).includes("recap ·")) continue; // 📊 weekly/monthly/yearly recaps stay
            doomed.push(m.id);
          }
          before = page[page.length - 1].id;
          if (page.length < 100) break;
        }
        // bulk delete takes 2–100 messages younger than 14 days; anything else goes one by one
        const now = yield* Clock.currentTimeMillis;
        const young = doomed.filter((id) => now - createdMs(id) < 13.5 * 86400_000);
        const old = doomed.filter((id) => !young.includes(id));
        for (let i = 0; i < young.length; i += 100) {
          const batch = young.slice(i, i + 100);
          if (batch.length === 1) old.push(batch[0]);
          else yield* discord.bulkDelete(config.gameChannelId, batch);
        }
        for (const id of old) yield* discord.deleteMessage(config.gameChannelId, id).pipe(Effect.ignore);
        // whatever we deleted is no longer a card or a nudge
        if (doomed.length) {
          yield* db.update(gameNights).set({ message_id: null }).where(inArray(gameNights.message_id, doomed));
          yield* db.update(gameNights).set({ nudge_id: null }).where(inArray(gameNights.nudge_id, doomed));
        }
        return { deleted: doomed.length, kept: keep.size };
      });

      /**
       * After today's sweep: a night from an earlier day that was still going at 03:00 and has ended
       * since gets the sweep again (once per night), so no finished night's card lives into the day.
       */
      const catchUp = Effect.fnUntraced(function* (l: { day: string; y: number; m: number; d: number }) {
        const t = Math.floor((yield* Clock.currentTimeMillis) / 1000);
        const left = yield* db
          .select()
          .from(gameNights)
          .where(and(lt(gameNights.day, l.day), eq(gameNights.stage, "set"), sql`${gameNights.message_id} IS NOT NULL`));
        for (const n of left) {
          if (yield* going(n, t)) continue;
          if (!(yield* memes.claimRecap(`cleanup:after:${n.day}`))) continue;
          const r = yield* sweep(time.wallToUnix(l.y, l.m, l.d, HOUR, 0) * 1000).pipe(Effect.tapError(() => memes.unclaimRecap(`cleanup:after:${n.day}`)));
          return { catchUp: n.day, ...r };
        }
        return {};
      });

      return Cleanup.of({
        sweep,
        nightly: Effect.gen(function* () {
          const l = yield* time.now;
          if (l.hour < HOUR) return {};
          const key = `cleanup:${l.day}`;
          // the claim → the deletes → the cleared ids is never cut short (§15): cut after the
          // deletes, the nights would keep ids of messages that no sweep lists again
          return yield* Effect.uninterruptible(
            Effect.gen(function* () {
              if (!(yield* memes.claimRecap(key))) return yield* catchUp(l); // swept today already: only the catch-up
              // a failure gives the claim back: the next minute tries again
              return yield* sweep(time.wallToUnix(l.y, l.m, l.d, HOUR, 0) * 1000).pipe(Effect.tapError(() => memes.unclaimRecap(key)));
            }),
          );
        }).pipe(Effect.withSpan("Cleanup.nightly")),
      });
    }),
  );
}


/** A snowflake for a given time (tests). */
export const snowflakeAt = (ms: number, n = 0) => String(((BigInt(ms) - DISCORD_EPOCH) << 22n) + BigInt(n));
