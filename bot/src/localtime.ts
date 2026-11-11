// Wall-clock time in the configured timezone (Europe/Vilnius), and the daily poll's hour. Moved out
// of gamenight.ts so the modules game night itself uses can read the local time without importing
// it back (plan 05 removes that import cycle).
import type { Env } from "./env.js";

/** Wall-clock parts in the configured timezone. Intl handles Lithuanian DST for us. */
export function local(env: Env, d = new Date(Date.now())) {
  const p: Record<string, string> = {};
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: env.TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  for (const x of fmt.formatToParts(d)) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day, day: `${p.year}-${p.month}-${p.day}`, hour: +p.hour, minute: +p.minute, hm: `${p.hour}:${p.minute}` };
}

/** Unix seconds for a wall-clock time in the configured timezone. */
export function wallToUnix(env: Env, y: number, m: number, d: number, hour: number, minute: number) {
  const guess = Date.UTC(y, m - 1, d, hour, minute) / 1000;
  // shift by the zone's offset at that moment (twice, so DST changeover days land right)
  let t = guess;
  for (let i = 0; i < 2; i++) {
    const l = local(env, new Date(t * 1000));
    t -= Date.UTC(l.y, l.m - 1, l.d, l.hour, l.minute) / 1000 - guess;
  }
  return t;
}

/** Local hour of the automatic daily card on `day`: 17:00, but 14:00 on Saturdays and Sundays. */
export function pollHour(env: Env, day: string) {
  const [y, m, d] = day.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return Number(dow === 0 || dow === 6 ? env.GAME_POLL_HOUR_WEEKEND : env.GAME_POLL_HOUR);
}

/** "Friday", for cards about a day other than today. */
export function weekday(env: Env, day: string) {
  return new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" }).format(new Date(`${day}T12:00:00Z`));
}
