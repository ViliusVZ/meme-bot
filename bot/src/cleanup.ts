// 🧹 Every night at 03:00 (Vilnius) #game-night is swept: the bot's messages from before then go
// (yesterday's cards, nudges, pings, late slips, roasts), so the channel only ever shows what's
// current. Kept: pinned messages (the HQ panel), stats recaps, and anything belonging to a night
// that's still going (a card still taking votes, a planned day ahead, a night that started in the
// last 6 hours). People's own messages are never touched.
//
// "Only you can see this" messages aren't in the channel at all: Discord keeps them on your
// device, and they disappear when Discord reloads.
import { and, gte, inArray, or, sql } from "drizzle-orm";
import { Clock, Context, Effect, Layer } from "effect";
import type { Env } from "./env.js";
import { gameNights, nightAttendance } from "./db/index.js";
import { Db, type DbError } from "./db/db.js";
import { AppConfig } from "./config.js";
import { Discord, type DiscordError } from "./discord.js";
import { Memes } from "./memes.js";
import { Nights } from "./nights.js";
import { LocalTime } from "./localtime.js";
import { run } from "./legacy.js"; // LEGACY-BRIDGE

const HOUR = 3; // local
const KEEP_AFTER_START = 6 * 3600;
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

      /** Message ids still in use: cards, nudges and late slips of nights that aren't over. */
      const keepers = Effect.gen(function* () {
        const t = Math.floor((yield* Clock.currentTimeMillis) / 1000);
        const today = (yield* time.now).day;
        const all = yield* db.select().from(gameNights).where(or(gte(gameNights.day, today), inArray(gameNights.stage, ["ask", "game", "time", "set"])));
        const live: typeof all = [];
        for (const n of all) {
          if (n.day >= today || (["ask", "game", "time"].includes(n.stage) && !(yield* nights.isOver(n))) || (n.stage === "set" && (n.start_at ?? 0) > t - KEEP_AFTER_START)) live.push(n);
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
            if (JSON.stringify(m.components ?? []).includes("recap ·")) continue; // 📊 weekly/monthly/yearly recaps stay
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

      return Cleanup.of({
        sweep,
        nightly: Effect.gen(function* () {
          const l = yield* time.now;
          if (l.hour < HOUR) return {};
          const key = `cleanup:${l.day}`;
          if (!(yield* memes.claimRecap(key))) return {};
          // the next minute tries again
          return yield* sweep(time.wallToUnix(l.y, l.m, l.d, HOUR, 0) * 1000).pipe(Effect.tapError(() => memes.unclaimRecap(key)));
        }).pipe(Effect.withSpan("Cleanup.nightly")),
      });
    }),
  );
}

// the old functions, for the code that isn't on Effect yet
const asOld = (e: unknown) => { // LEGACY-BRIDGE
  throw e instanceof Error && "_tag" in e && String(e._tag).startsWith("Discord") ? new Error(e.message) : e; // LEGACY-BRIDGE
}; // LEGACY-BRIDGE
export const sweep = (env: Env, cutoffMs: number) => run(env, Cleanup.use((c) => c.sweep(cutoffMs))).catch(asOld); // LEGACY-BRIDGE
export const nightly = (env: Env) => run(env, Cleanup.use((c) => c.nightly)).catch(asOld); // LEGACY-BRIDGE

/** A snowflake for a given time (tests). */
export const snowflakeAt = (ms: number, n = 0) => String(((BigInt(ms) - DISCORD_EPOCH) << 22n) + BigInt(n));
