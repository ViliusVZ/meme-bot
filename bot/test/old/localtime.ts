// The old functions of src/localtime.ts, for the tests until phase 6 makes them Effect-native
// (plan 05, phase 5 step 8: the transition left src; the tests change only their imports).
export * from "../../src/localtime.js";
import { localAt, pollHourOf, wallToUnixIn, weekdayOf } from "../../src/localtime.js";
import type { Env } from "../../src/env.js";

/** Wall-clock parts in the configured timezone. */
export function local(env: Env, d?: Date) {
  return localAt(env.TIMEZONE, d ? d.getTime() : Date.now());
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
