// Wall-clock time in the configured timezone (Europe/Vilnius), and the daily poll's hour. Moved out
// of gamenight.ts so the modules game night itself uses can read the local time without importing
// it back (plan 05 removes that import cycle). The arithmetic is plain functions (pinned by
// test/time.test.ts); LocalTime gives it the configured zone and the current time from Clock.
import { Clock, Context, Effect, Layer } from "effect";
import type { Env } from "./env.js";
import { AppConfig } from "./config.js";

export type Local = { y: number; m: number; d: number; day: string; hour: number; minute: number; hm: string };

/** Wall-clock parts in `timeZone` at `ms` (epoch milliseconds). Intl handles Lithuanian DST for us. */
export function localAt(timeZone: string, ms: number): Local {
  const p: Record<string, string> = {};
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  for (const x of fmt.formatToParts(ms)) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day, day: `${p.year}-${p.month}-${p.day}`, hour: +p.hour, minute: +p.minute, hm: `${p.hour}:${p.minute}` };
}

/** Unix seconds for a wall-clock time in `timeZone`. */
export function wallToUnixIn(timeZone: string, y: number, m: number, d: number, hour: number, minute: number) {
  const guess = Date.UTC(y, m - 1, d, hour, minute) / 1000;
  // shift by the zone's offset at that moment (twice, so DST changeover days land right)
  let t = guess;
  for (let i = 0; i < 2; i++) {
    const l = localAt(timeZone, t * 1000);
    t -= Date.UTC(l.y, l.m - 1, l.d, l.hour, l.minute) / 1000 - guess;
  }
  return t;
}

/** Local hour of the automatic daily card on `day`: 17:00, but 14:00 on Saturdays and Sundays. */
export function pollHourOf(day: string, weekdayHour: number, weekendHour: number) {
  const [y, m, d] = day.split("-").map(Number);
  const dow = (Math.floor(Date.UTC(y, m - 1, d) / 86_400_000) + 4) % 7; // 1 Jan 1970 was a Thursday
  return dow === 0 || dow === 6 ? weekendHour : weekdayHour;
}

/** "Friday", for cards about a day other than today. */
export function weekdayOf(day: string) {
  return new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" }).format(Date.parse(`${day}T12:00:00Z`));
}

export class LocalTime extends Context.Service<
  LocalTime,
  {
    /** The current local time. */
    readonly now: Effect.Effect<Local>;
    /** The local time at unix second `sec`. */
    at(sec: number): Local;
    wallToUnix(y: number, m: number, d: number, hour: number, minute: number): number;
    pollHour(day: string): number;
    weekday(day: string): string;
  }
>()("meme-bot/localtime") {
  static readonly layer = Layer.effect(
    LocalTime,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const zone = config.timezone;
      return LocalTime.of({
        now: Effect.map(Clock.currentTimeMillis, (ms) => localAt(zone, ms)),
        at: (sec) => localAt(zone, sec * 1000),
        wallToUnix: (y, m, d, hour, minute) => wallToUnixIn(zone, y, m, d, hour, minute),
        pollHour: (day) => pollHourOf(day, config.gamePollHour, config.gamePollHourWeekend),
        weekday: weekdayOf,
      });
    }),
  );
}

// the old functions, for the code that isn't on Effect yet (the same arithmetic)
/** Wall-clock parts in the configured timezone. */
export function local(env: Env, d?: Date) {
  return localAt(env.TIMEZONE, d ? d.getTime() : Date.now()); // LEGACY-BRIDGE
}

/** Unix seconds for a wall-clock time in the configured timezone. */
export function wallToUnix(env: Env, y: number, m: number, d: number, hour: number, minute: number) {
  return wallToUnixIn(env.TIMEZONE, y, m, d, hour, minute);
}

/** Local hour of the automatic daily card on `day`: 17:00, but 14:00 on Saturdays and Sundays. */
export function pollHour(env: Env, day: string) {
  return pollHourOf(day, Number(env.GAME_POLL_HOUR), Number(env.GAME_POLL_HOUR_WEEKEND));
}

/** "Friday", for cards about a day other than today. */
export function weekday(_env: Env, day: string) {
  return weekdayOf(day);
}
