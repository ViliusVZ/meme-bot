// 😴 Snoozing game-night planning: no automatic daily card (17:00, 14:00 on weekends) until the
// snooze runs out. Anyone in the trio can snooze it for 3 days, a week or a month, or wake it back
// up early. Only the automatic card sleeps: 🎮 Play today and 📅 Plan a day still work.
import { eq } from "drizzle-orm";
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import type { Env } from "./env.js";
import { settings } from "./db/index.js";
import { Db, type DbError } from "./db/db.js";
import { AppConfig, allowedMentions, players } from "./config.js";
import { Discord, EPHEMERAL, IS_COMPONENTS_V2 } from "./discord.js";
import { Alerts } from "./alerts.js";
import { LocalTime } from "./localtime.js";
import { Nights } from "./nights.js";
import { utcDayAt } from "./memes.js";
import { nowSec } from "./clock.js";
import { run } from "./legacy.js"; // LEGACY-BRIDGE

const KEY = "snooze";
export type Span = "3d" | "week" | "month";
const SPANS: Record<Span, string> = { "3d": "3 days", week: "a week", month: "a month" };
/** `until` is the first local day the daily card is back. */
const SnoozeRow = Schema.Struct({ until: Schema.String, by: Schema.String, span: Schema.optional(Schema.Literals(["3d", "week", "month"])) });
type Snooze = typeof SnoozeRow.Type;

const mention = (id: string) => `<@${id}>`;

/** A local day shifted by days (and months), as YYYY-MM-DD. */
export function shift(day: string, days: number, months = 0) {
  const [y, m, d] = day.split("-").map(Number);
  return utcDayAt(Date.UTC(y, m - 1 + months, d + days));
}

export class Snoozes extends Context.Service<
  Snoozes,
  {
    /** The snooze in force, if any (one that has run out doesn't count). */
    readonly current: Effect.Effect<Snooze | null, DbError>;
    /** Is the automatic card for `day` snoozed? */
    isSnoozed(day: string): Effect.Effect<boolean, DbError>;
    /** When the next automatic card goes out (unix seconds), snooze included. */
    readonly nextCard: Effect.Effect<number, DbError>;
    /** 😴 Snooze the daily card for 3 days, a week or a month, counted from the next one due. */
    snooze(user: string, span: Span): Effect.Effect<string, DbError>;
    /** ⏰ Wake planning back up. */
    wake(user: string): Effect.Effect<string, DbError>;
    /** The private 😴 panel: what's on, and the snooze buttons. */
    panel(notice?: string): Effect.Effect<object, DbError>;
  }
>()("meme-bot/snooze/Snoozes") {
  static readonly layer = Layer.effect(
    Snoozes,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const db = yield* Db;
      const time = yield* LocalTime;
      const nights = yield* Nights;
      const discord = yield* Discord;
      const alerts = yield* Alerts;

      const current = Effect.gen(function* () {
        const [row] = yield* db.select().from(settings).where(eq(settings.key, KEY));
        const s = Option.getOrUndefined(Schema.decodeUnknownOption(SnoozeRow)(row?.value));
        return s && s.until > (yield* time.now).day ? s : null;
      }).pipe(Effect.withSpan("Snoozes.current"));

      /** The first day whose automatic card is still to come: today until its poll hour is over (and no card yet), else tomorrow. */
      const nextCardDay = Effect.gen(function* () {
        const l = yield* time.now;
        return l.hour <= time.pollHour(l.day) && !(yield* nights.get(l.day)) ? l.day : shift(l.day, 1);
      });

      const nextCard = Effect.gen(function* () {
        const s = yield* current;
        const first = yield* nextCardDay;
        const day = s && s.until > first ? s.until : first;
        const [y, m, d] = day.split("-").map(Number);
        // in the middle of the poll hour, it's "within a minute"
        return Math.max(time.wallToUnix(y, m, d, time.pollHour(day), 0), (yield* nowSec) + 60);
      }).pipe(Effect.withSpan("Snoozes.nextCard"));

      const announce = Effect.fn("Snoozes.announce")(function* (user: string, content: string) {
        const others = (yield* Effect.provideService(players, AppConfig, config)).filter((p) => p !== user);
        yield* discord
          .createMessage(config.gameChannelId, { content, allowed_mentions: yield* allowedMentions(others) })
          .pipe(Effect.catch((e) => alerts.failed("the snooze announcement", e)));
      });

      return Snoozes.of({
        current,
        isSnoozed: Effect.fn("Snoozes.isSnoozed")(function* (day: string) {
          const s = yield* current;
          return !!s && day < s.until;
        }),
        nextCard,
        snooze: Effect.fn("Snoozes.snooze")(function* (user: string, span: Span) {
          const from = yield* nextCardDay;
          const until = span === "month" ? shift(from, 0, 1) : shift(from, span === "3d" ? 3 : 7);
          const value: Snooze = { until, by: user, span };
          const at = DateTime.toDate(yield* DateTime.now);
          yield* db.insert(settings).values({ key: KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value, updated_at: at } });
          const next = yield* nextCard;
          yield* announce(
            user,
            `😴 ${mention(user)} snoozed game night planning for ${SPANS[span]}: no daily poll until <t:${next}:f> (<t:${next}:R>). 🎮 Play today and 📅 Plan a day still work.`,
          );
          return `✅ Snoozed for ${SPANS[span]}.`;
        }),
        wake: Effect.fn("Snoozes.wake")(function* (user: string) {
          if (!(yield* current)) return "Planning isn't snoozed 🙂";
          yield* db.delete(settings).where(eq(settings.key, KEY));
          const next = yield* nextCard;
          yield* announce(user, `⏰ ${mention(user)} woke game night planning back up: the next daily poll is <t:${next}:f> (<t:${next}:R>).`);
          return "✅ Back on.";
        }),
        panel: Effect.fn("Snoozes.panel")(function* (notice?: string) {
          const s = yield* current;
          const next = yield* nextCard;
          const button = (style: number, emoji: string, label: string, custom_id: string) => ({ type: 2, style, emoji: { name: emoji }, label, custom_id });
          const status = s
            ? `😴 **Planning is snoozed** (by ${mention(s.by)}). The next daily poll is <t:${next}:f> (<t:${next}:R>).`
            : `🎮 **Planning is on.** The next daily poll is <t:${next}:f> (<t:${next}:R>). Need a break? Snooze it:`;
          return {
            flags: IS_COMPONENTS_V2 | EPHEMERAL,
            allowed_mentions: { parse: [] },
            components: [
              {
                type: 17,
                accent_color: s ? 0x4f545c : 0x5865f2,
                components: [
                  { type: 10, content: `## 😴 Snooze game night planning${notice ? `\n${notice}` : ""}` },
                  { type: 10, content: status },
                  {
                    type: 1,
                    components: [
                      button(s?.span === "3d" ? 1 : 2, "😴", "3 days", "snz:3d"),
                      button(s?.span === "week" ? 1 : 2, "😴", "1 week", "snz:week"),
                      button(s?.span === "month" ? 1 : 2, "😴", "1 month", "snz:month"),
                      ...(s ? [button(3, "⏰", "Wake it up", "snz:wake")] : []),
                    ],
                  },
                  { type: 10, content: "-# Only the automatic daily poll sleeps (17:00, 14:00 on weekends). 🎮 Play today and 📅 Plan a day still work. Snoozing again replaces the old snooze." },
                ],
              },
            ],
          };
        }),
      });
    }),
  );
}

// the old functions, for the code that isn't on Effect yet
export const current = (env: Env) => run(env, Snoozes.use((s) => s.current)); // LEGACY-BRIDGE
export const isSnoozed = (env: Env, day: string) => run(env, Snoozes.use((s) => s.isSnoozed(day))); // LEGACY-BRIDGE
export const nextCard = (env: Env) => run(env, Snoozes.use((s) => s.nextCard)); // LEGACY-BRIDGE
export const snooze = (env: Env, user: string, span: Span) => run(env, Snoozes.use((s) => s.snooze(user, span))); // LEGACY-BRIDGE
export const wake = (env: Env, user: string) => run(env, Snoozes.use((s) => s.wake(user))); // LEGACY-BRIDGE
export const panel = (env: Env, notice?: string) => run(env, Snoozes.use((s) => s.panel(notice))); // LEGACY-BRIDGE
