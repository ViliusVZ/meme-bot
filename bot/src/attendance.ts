// Who is coming to a started night, and when: the attendance rows, ETAs said ahead, and the late
// slip that shows them. Split out of late.ts so game night can record attendance without importing
// late.ts, which calls back into game night (plan 05 removes that import cycle).
import { and, eq, isNull, like, not, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import type { Env } from "./env.js";
import { gameNights, nightAttendance, rooms } from "./db/index.js";
import { Db, type DbError } from "./db/db.js";
import { AppConfig } from "./config.js";
import { Discord, type DiscordError, IS_COMPONENTS_V2 } from "./discord.js";
import { Voice } from "./voice.js";
import { nowSec } from "./clock.js";
import { run } from "./legacy.js"; // LEGACY-BRIDGE

export type Attendance = typeof nightAttendance.$inferSelect;
type Changes = Partial<Omit<Attendance, "day" | "user_id">>;

const mention = (id: string) => `<@${id}>`;

export const real = not(like(rooms.channel_id, "pending:%"));

export class Attendances extends Context.Service<
  Attendances,
  {
    get(day: string, user: string): Effect.Effect<Attendance | null, DbError>;
    /** Their row with these changes, written and given back. */
    put(day: string, user: string, set: Changes): Effect.Effect<Attendance, DbError>;
    /** ⏰ said ahead of the start: they'll be here at `eta` (null takes it back). */
    expect(day: string, user: string, eta: number | null): Effect.Effect<void, DbError>;
    /** Who said they'd be late, and when they'll be here: { user: eta }. */
    etas(day: string): Effect.Effect<Record<string, number>, DbError>;
    /** ⏰ on the card after the start: an ETA from now, on their slip (posted now if they had none). */
    declare(day: string, user: string, mins: number): Effect.Effect<string, DbError | DiscordError>;
    /** People the start-time reminder already moved count as here (and won't be moved again). */
    markArrived(day: string, users: ReadonlyArray<string>): Effect.Effect<void, DbError>;
    /** The night was called off: every slip still asking "running late?" says so instead. */
    retireSlips(day: string): Effect.Effect<void, DbError>;
    /** Renders a late slip in its current state. */
    render(day: string, user: string): Effect.Effect<ReturnType<typeof slipFor>, DbError>;
  }
>()("meme-bot/attendance/Attendances") {
  static readonly layer = Layer.effect(
    Attendances,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const db = yield* Db;
      const discord = yield* Discord;
      const voice = yield* Voice;

      const get = Effect.fn("Attendances.get")(function* (day: string, user: string) {
        const rows = yield* db.select().from(nightAttendance).where(and(eq(nightAttendance.day, day), eq(nightAttendance.user_id, user)));
        return rows.length ? rows[0] : null;
      });

      const put = Effect.fn("Attendances.put")(function* (day: string, user: string, set: Changes) {
        const cur = yield* get(day, user);
        const row = { day, user_id: user, state: "arrived", eta: null, message_id: null, arrived_at: null, roast: null, ...cur, ...set } as Attendance;
        const values = { state: row.state, eta: row.eta, message_id: row.message_id, arrived_at: row.arrived_at, roast: row.roast };
        yield* db
          .insert(nightAttendance)
          .values({ day, user_id: user, ...values })
          .onConflictDoUpdate({ target: [nightAttendance.day, nightAttendance.user_id], set: values });
        return row;
      });

      const render = Effect.fn("Attendances.render")(function* (day: string, user: string) {
        const row = (yield* get(day, user))!;
        const [n] = yield* db.select({ game: gameNights.game, start_at: gameNights.start_at }).from(gameNights).where(eq(gameNights.day, day));
        const [room] = yield* db.select({ channel_id: rooms.channel_id }).from(rooms).where(and(eq(rooms.day, day), real));
        return slipFor(day, user, row, n.game!, n.start_at ?? undefined, room?.channel_id);
      });

      return Attendances.of({
        get,
        put,
        expect: Effect.fn("Attendances.expect")(function* (day: string, user: string, eta: number | null) {
          if (eta === null) {
            yield* db.delete(nightAttendance).where(and(eq(nightAttendance.day, day), eq(nightAttendance.user_id, user), eq(nightAttendance.state, "eta")));
            return;
          }
          yield* put(day, user, { state: "eta", eta });
        }),
        etas: Effect.fn("Attendances.etas")(function* (day: string) {
          const rows = yield* db
            .select({ user: nightAttendance.user_id, eta: nightAttendance.eta })
            .from(nightAttendance)
            .where(and(eq(nightAttendance.day, day), eq(nightAttendance.state, "eta")));
          return Object.fromEntries(rows.map((r) => [r.user, r.eta!])) as Record<string, number>;
        }),
        declare: Effect.fn("Attendances.declare")(function* (day: string, user: string, mins: number) {
          const row = yield* get(day, user);
          const [room] = yield* db.select({ channel_id: rooms.channel_id }).from(rooms).where(and(eq(rooms.day, day), isNull(rooms.archived_at), real));
          const inRoom = room && (yield* voice.voiceChannel(user).pipe(Effect.catch(() => Effect.succeed(null)))) === room.channel_id;
          if (row?.state === "arrived" || inRoom) return "You're already here 👋";
          const r = yield* put(day, user, { state: "eta", eta: (yield* nowSec) + mins * 60 });
          const body = yield* render(day, user);
          if (r.message_id) {
            yield* discord.editMessage(config.gameChannelId, r.message_id, body).pipe(Effect.ignore);
          } else {
            const [n] = yield* db.select({ message_id: gameNights.message_id }).from(gameNights).where(eq(gameNights.day, day));
            const msg = yield* discord.createMessage(config.gameChannelId, {
              ...body,
              allowed_mentions: { parse: [] },
              message_reference: n?.message_id ? { message_id: n.message_id, fail_if_not_exists: false } : undefined,
            });
            yield* db.update(nightAttendance).set({ message_id: msg.id }).where(and(eq(nightAttendance.day, day), eq(nightAttendance.user_id, user)));
          }
          return `Got it 🏃 ETA <t:${r.eta}:t>. Everyone can see it on your slip.`;
        }),
        markArrived: Effect.fn("Attendances.markArrived")(function* (day: string, users: ReadonlyArray<string>) {
          for (const u of users) yield* put(day, u, { state: "arrived", arrived_at: yield* nowSec });
        }),
        retireSlips: Effect.fn("Attendances.retireSlips")(function* (day: string) {
          const rows = yield* db.select().from(nightAttendance).where(and(eq(nightAttendance.day, day), sql`${nightAttendance.message_id} IS NOT NULL`));
          for (const r of rows) {
            if (r.state === "arrived" || !r.message_id) continue;
            const content = r.state === "absent" ? `🚪 ${mention(r.user_id)} bailed, so game night's off. Roast below 🔥` : `~~⏰ Running late?~~ Never mind ${mention(r.user_id)}, game night's off 🫡`;
            yield* discord
              .editMessage(config.gameChannelId, r.message_id, { flags: IS_COMPONENTS_V2, allowed_mentions: { parse: [] }, components: [{ type: 10, content }] })
              .pipe(Effect.ignore);
          }
        }),
        render,
      });
    }),
  );
}

export function slipFor(day: string, user: string, row: Attendance, game: string, startAt?: number, roomId?: string) {
  const where = roomId ? ` in <#${roomId}>` : "";
  const buttons = [
    { type: 2, style: 1, emoji: { name: "🏃" }, label: "5 min", custom_id: `late:${day}:${user}:5` },
    { type: 2, style: 1, emoji: { name: "🏃" }, label: "15 min", custom_id: `late:${day}:${user}:15` },
    { type: 2, style: 1, emoji: { name: "🏃" }, label: "30 min", custom_id: `late:${day}:${user}:30` },
    { type: 2, style: 2, emoji: { name: "😴" }, label: "Can't make it", custom_id: `late:${day}:${user}:out` },
  ];
  let body: unknown[];
  let accent = 0xfee75c;
  if (row.state === "arrived") {
    const mins = startAt && row.arrived_at ? Math.max(0, Math.round((row.arrived_at - startAt) / 60)) : null;
    const onTime = row.eta && row.arrived_at && row.arrived_at <= row.eta + 120;
    accent = 0x57f287;
    body = [{ type: 10, content: `✅ ${mention(user)} made it${mins ? `, ${mins} min late` : ""}${onTime ? " (right on their ETA 👏)" : mins && mins >= 20 ? " 🐢" : ""}` }];
  } else if (row.state === "absent") {
    return { flags: IS_COMPONENTS_V2, allowed_mentions: { parse: [] as string[] }, components: [{ type: 10, content: `🚪 ${mention(user)} bailed, so game night's off. Roast below 🔥` }] as unknown[] };
  } else if (row.state === "eta") {
    body = [
      { type: 10, content: `🏃 ${mention(user)} is on the way · ETA <t:${row.eta}:t> (<t:${row.eta}:R>)` },
      { type: 1, components: buttons.map((b) => ({ ...b, style: 2 })) }, // still changeable
    ];
  } else {
    body = [{ type: 10, content: `⏰ ${mention(user)} we've started ${game ? `**${game}**` : ""}${where}. Running late?` }, { type: 1, components: buttons }];
  }
  // edits never re-ping; the first post overrides this with a ping for the late person only
  return { flags: IS_COMPONENTS_V2, allowed_mentions: { parse: [] as string[] }, components: [{ type: 17, accent_color: accent, components: body }] as unknown[] };
}

// the old functions, for the code that isn't on Effect yet
export const get = (env: Env, day: string, user: string) => run(env, Attendances.use((a) => a.get(day, user))); // LEGACY-BRIDGE
export const put = (env: Env, day: string, user: string, set: Changes) => run(env, Attendances.use((a) => a.put(day, user, set))); // LEGACY-BRIDGE
export const expect = (env: Env, day: string, user: string, eta: number | null) => run(env, Attendances.use((a) => a.expect(day, user, eta))); // LEGACY-BRIDGE
export const etas = (env: Env, day: string) => run(env, Attendances.use((a) => a.etas(day))); // LEGACY-BRIDGE
export const declare = (env: Env, day: string, user: string, mins: number) => // LEGACY-BRIDGE
  run(env, Attendances.use((a) => a.declare(day, user, mins))).catch((e: unknown) => { // LEGACY-BRIDGE
    throw e instanceof Error && "_tag" in e && String(e._tag).startsWith("Discord") ? new Error(e.message) : e; // today's text, which the alert DM quotes // LEGACY-BRIDGE
  }); // LEGACY-BRIDGE
export const markArrived = (env: Env, day: string, users: string[]) => run(env, Attendances.use((a) => a.markArrived(day, users))); // LEGACY-BRIDGE
export const retireSlips = (env: Env, day: string) => run(env, Attendances.use((a) => a.retireSlips(day))); // LEGACY-BRIDGE
export const render = (env: Env, day: string, user: string) => run(env, Attendances.use((a) => a.render(day, user))); // LEGACY-BRIDGE
export const slip = (_env: Env, day: string, user: string, row: Attendance, game: string, startAt?: number, roomId?: string) => slipFor(day, user, row, game, startAt, roomId); // LEGACY-BRIDGE
