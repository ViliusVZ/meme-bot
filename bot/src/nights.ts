// Reading a game night's row. Moved out of gamenight.ts so the modules game night itself uses can
// read a night without importing it back (plan 05 removes that import cycle).
import { eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import type { Env } from "./env.js";
import { gameNights, type Stage } from "./db/index.js";
import { Db, type DbError } from "./db/db.js";
import { LocalTime } from "./localtime.js";
import { nowSec } from "./clock.js";

export type Night = typeof gameNights.$inferSelect;

export class Nights extends Context.Service<
  Nights,
  {
    get(day: string): Effect.Effect<Night | null, DbError>;
    /**
     * Is an unfinished card past its time? Asking and game picking end at midnight, but time picking
     * runs until the small hours, because 🌙 after-midnight starts (up to 06:00) are fair game.
     */
    isOver(n: { day: string; stage: Stage }): Effect.Effect<boolean>;
  }
>()("meme-bot/nights") {
  static readonly layer = Layer.effect(
    Nights,
    Effect.gen(function* () {
      const db = yield* Db;
      const time = yield* LocalTime;
      return Nights.of({
        get: Effect.fn("Nights.get")(function* (day: string) {
          return (yield* db.select().from(gameNights).where(eq(gameNights.day, day)))[0] ?? null;
        }),
        isOver: Effect.fn("Nights.isOver")(function* (n: { day: string; stage: Stage }) {
          if (n.day >= (yield* time.now).day) return false;
          if (n.stage !== "time") return true;
          const [y, mo, d] = n.day.split("-").map(Number);
          return (yield* nowSec) >= time.wallToUnix(y, mo, d, 0, 0) + 30 * 3600;
        }),
      });
    }),
  );
}
