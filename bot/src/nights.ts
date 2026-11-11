// Reading a game night's row. Moved out of gamenight.ts so the modules game night itself uses can
// read a night without importing it back (plan 05 removes that import cycle).
import { eq } from "drizzle-orm";
import type { Env } from "./env.js";
import { gameNights, type Stage } from "./db/index.js";
import { local, wallToUnix } from "./localtime.js";

export type Night = typeof gameNights.$inferSelect;

const nowSec = () => Math.floor(Date.now() / 1000);

export const getNight = async (env: Env, day: string): Promise<Night | null> =>
  (await env.db.select().from(gameNights).where(eq(gameNights.day, day)))[0] ?? null;

/**
 * Is an unfinished card past its time? Asking and game picking end at midnight, but time picking
 * runs until the small hours, because 🌙 after-midnight starts (up to 06:00) are fair game.
 */
export function isOver(env: Env, n: { day: string; stage: Stage }) {
  if (n.day >= local(env).day) return false;
  if (n.stage !== "time") return true;
  const [y, mo, d] = n.day.split("-").map(Number);
  return nowSec() >= wallToUnix(env, y, mo, d, 0, 0) + 30 * 3600;
}
