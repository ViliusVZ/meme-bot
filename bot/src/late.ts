// Running late. Once a locked-in night has started (its room is open), every minute, and the moment
// anyone joins the Lobby (live.ts), we check where each player is:
//   in the room      → they're here (a late slip, if any, becomes "✅ made it, 12 min late 🐢")
//   in the Lobby     → pulled into the room, once (if they wander back to the Lobby later, we leave
//                       them be)
//   anywhere else    → 10 min after start they get one late slip: "Running late?" with 🏃 ETA
//                       buttons and 😴 can't make it
// "Can't make it" (😴 on the slip, or on the card) calls the whole night off: we play all together
// or not at all (gamenight.ts posts the roast). Everyone's slips then say so.
// Saying it ahead (⏰ on the locked-in card): before the start, gamenight.ts moves the start to the
// latest ETA (we wait for everyone); after it, it's an ETA on your slip. Someone who said they'd be
// late and still isn't here 10 min after their ETA gets a slip like everyone else.
import { and, eq, gt, isNull, lte } from "drizzle-orm";
import { Context, Effect, Layer, Match } from "effect";
import { gameNights, nightAttendance, rooms } from "./db/schema.js";
import { Db, type DbError } from "./db/db.js";
import { AppConfig, allowedMentions, players } from "./config.js";
import { Discord, type DiscordError } from "./discord.js";
import { Attendances, real, slipFor, type Attendance } from "./attendance.js";
import { GameNight, type NightGone } from "./gamenight.js";
import { Voice } from "./voice.js";
import { BotVoice } from "./botvoice.js";
import { Alerts } from "./alerts.js";
import { nowSec } from "./clock.js";

const LATE_AFTER = 10 * 60; // grace before a late slip
const WATCH_FOR = 3 * 3600; // stop watching this long after the start

type Night = { day: string; game: string | null; start_at: number | null; message_id: string | null };

export class LateSlips extends Context.Service<
  LateSlips,
  {
    /** Every minute (and on Lobby joins): handle everyone for every night that's under way. */
    readonly watch: Effect.Effect<Record<string, string[]>, DbError>;
    /** A late slip button: late:<day>:<user>:<5|15|30|out>. Only the late person can answer it. */
    act(day: string, owner: string, clicker: string, choice: string): Effect.Effect<{ notice: string | undefined }, DbError | DiscordError | NightGone>;
  }
>()("meme-bot/late/LateSlips") {
  static readonly layer = Layer.effect(
    LateSlips,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const db = yield* Db;
      const discord = yield* Discord;
      const attendances = yield* Attendances;
      const gameNight = yield* GameNight;
      const voice = yield* Voice;
      const botVoice = yield* BotVoice;
      const alerts = yield* Alerts;
      const trio = Effect.provideService(players, AppConfig, config);

      const watchPlayer = Effect.fnUntraced(function* (n: Night, roomId: string, p: string, t: number, note: (k: string, v: string) => void) {
        const at = yield* voice.voiceChannel(p).pipe(
          Effect.map((channel) => ({ channel })),
          Effect.catch((e) => Effect.as(Effect.logInfo(`late: voice lookup failed ${p} ${e}`), null)),
        );
        if (!at) return; // never act on a guess
        const row = yield* attendances.get(n.day, p);
        const updateSlip = (r: Attendance) =>
          r.message_id ? discord.editMessage(config.gameChannelId, r.message_id, slipFor(n.day, p, r, n.game!, n.start_at!)).pipe(Effect.ignore) : Effect.void;

        if (at.channel === roomId) {
          // here (even if they'd said they couldn't make it: plans change, nice surprise)
          if (row?.state === "arrived") return;
          yield* updateSlip(yield* attendances.put(n.day, p, { state: "arrived", arrived_at: t }));
          note("arrived", p);
          // 🔊 a spoken welcome for the latecomer (queued; nothing here waits on it)
          yield* botVoice.latecomer(roomId, p, Math.floor((t - n.start_at!) / 60));
          return;
        }
        if (row?.state === "absent") return;

        if (at.channel === config.lobbyChannelId && row?.state !== "arrived") {
          // late arrival waiting in the Lobby: bring them in (once; arrived means we never move again)
          yield* discord.moveMember(p, roomId);
          yield* updateSlip(yield* attendances.put(n.day, p, { state: "arrived", arrived_at: t }));
          note("moved", p);
          yield* botVoice.latecomer(roomId, p, Math.floor((t - n.start_at!) / 60));
          return;
        }

        // said ahead they'd be late, and 10 min past that ETA they're still not here
        const overdue = row?.state === "eta" && !row.message_id && t - Math.max(row.eta!, n.start_at!) >= LATE_AFTER;
        if ((!row && t - n.start_at! >= LATE_AFTER) || overdue) {
          // not here, not in the Lobby, no word from them: one late slip. Claim the row first so two
          // overlapping runs can't both post one; claim → slip → its id is never cut short (§15)
          yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const claim = row
                ? yield* db
                    .update(nightAttendance)
                    .set({ state: "late", eta: null })
                    .where(and(eq(nightAttendance.day, n.day), eq(nightAttendance.user_id, p), eq(nightAttendance.state, "eta"), isNull(nightAttendance.message_id)))
                    .returning({ day: nightAttendance.day })
                : yield* db.insert(nightAttendance).values({ day: n.day, user_id: p, state: "late" }).onConflictDoNothing().returning({ day: nightAttendance.day });
              if (!claim.length) return;
              const fresh: Attendance = { day: n.day, user_id: p, state: "late", eta: null, message_id: null, arrived_at: null, roast: null };
              yield* Effect.gen(function* () {
                const msg = yield* discord.createMessage(config.gameChannelId, {
                  ...slipFor(n.day, p, fresh, n.game!, n.start_at!, roomId),
                  allowed_mentions: yield* allowedMentions([p]),
                  message_reference: n.message_id ? { message_id: n.message_id, fail_if_not_exists: false } : undefined,
                });
                yield* db.update(nightAttendance).set({ message_id: msg.id }).where(and(eq(nightAttendance.day, n.day), eq(nightAttendance.user_id, p)));
                note("slipped", p);
              }).pipe(
                // release the claim so the next minute can try again
                Effect.tapError(() =>
                  row
                    ? Effect.asVoid(attendances.put(n.day, p, { state: "eta", eta: row.eta }))
                    : db
                        .delete(nightAttendance)
                        .where(and(eq(nightAttendance.day, n.day), eq(nightAttendance.user_id, p), isNull(nightAttendance.message_id), eq(nightAttendance.state, "late"))),
                ),
              );
            }),
          );
        }
      });

      const watch = Effect.gen(function* () {
        const t = yield* nowSec;
        const nights: Night[] = yield* db
          .select({ day: gameNights.day, game: gameNights.game, start_at: gameNights.start_at, message_id: gameNights.message_id })
          .from(gameNights)
          .where(and(eq(gameNights.stage, "set"), eq(gameNights.reminded, true), lte(gameNights.start_at, t), gt(gameNights.start_at, t - WATCH_FOR)));
        const done: Record<string, string[]> = {};
        const note = (k: string, v: string) => void (done[k] ??= []).push(v);

        for (const n of nights) {
          const [room] = yield* db
            .select({ channel_id: rooms.channel_id })
            .from(rooms)
            .where(and(eq(rooms.day, n.day), isNull(rooms.archived_at), real));
          if (!room) continue;
          for (const p of yield* trio) {
            // one player's trouble (a failed move or post) must not hold up the others
            yield* watchPlayer(n, room.channel_id, p, t, note).pipe(Effect.catch((e) => alerts.failed("latecomer upkeep", e, n.day, p)));
          }
        }
        return done;
      }).pipe(Effect.withSpan("LateSlips.watch"));

      return LateSlips.of({
        watch,
        act: Effect.fn("LateSlips.act")(function* (day: string, owner: string, clicker: string, choice: string) {
          if (clicker !== owner) return { notice: "That's not your late slip 😄" };
          const row = yield* attendances.get(day, owner);
          if (!row) return { notice: "That slip has expired 🫥" };
          const [night] = yield* db.select({ stage: gameNights.stage }).from(gameNights).where(eq(gameNights.day, day));
          if (night?.stage !== "set") return { notice: "Game night's off, no need to hurry 🫡" };
          if (row.state === "arrived") return { notice: "You're already here 👋" };
          const notice = yield* Match.value(choice).pipe(
            Match.when("out", () =>
              Effect.gen(function* () {
                // all of us or none of us: the night's off (this also retires every slip, this one included)
                yield* attendances.put(day, owner, { state: "absent" });
                yield* gameNight.bailFromSlip(day, owner);
                return undefined;
              }),
            ),
            // an ETA: 5, 15 or 30 minutes from now
            Match.orElse(() =>
              Effect.gen(function* () {
                const mins = Number(choice);
                if (![5, 15, 30].includes(mins)) return "🤷";
                yield* attendances.put(day, owner, { state: "eta", eta: (yield* nowSec) + mins * 60 });
                return undefined;
              }),
            ),
          );
          return { notice };
        }),
      });
    }),
  );
}

