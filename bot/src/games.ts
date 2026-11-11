// The game list. Moved out of gamenight.ts so the modules game night itself uses can read it
// without importing it back (plan 05 removes that import cycle).
import { asc, desc, eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import type { Env } from "./env.js";
import { games as gameTable } from "./db/index.js";
import { Db, type DbError } from "./db/db.js";
import { nowIso } from "./clock.js";
import { run } from "./legacy.js"; // LEGACY-BRIDGE

export interface Game {
  name: string;
  emoji: string | null;
  plays: number;
}

export class Games extends Context.Service<
  Games,
  {
    /** The game list, most played first (a dropdown holds 25). */
    list(limit?: number): Effect.Effect<Game[], DbError>;
    /** Adds a game if it's new; gives its stored name (names are case-insensitive), or null for a blank one. */
    add(raw: string, user: string): Effect.Effect<string | null, DbError>;
    remove(name: string): Effect.Effect<void, DbError>;
    /** "👻 Phasmophobia", using each game's emoji. */
    readonly label: Effect.Effect<(game: string) => string, DbError>;
    emojiFor(game: string): Effect.Effect<string, DbError>;
  }
>()("meme-bot/games") {
  static readonly layer = Layer.effect(
    Games,
    Effect.gen(function* () {
      const db = yield* Db;
      return Games.of({
        list: Effect.fn("Games.list")(function* (limit = 25) {
          return yield* db
            .select({ name: gameTable.name, emoji: gameTable.emoji, plays: gameTable.plays })
            .from(gameTable)
            .orderBy(desc(gameTable.plays), asc(gameTable.seq))
            .limit(limit);
        }),
        add: Effect.fn("Games.add")(function* (raw: string, user: string) {
          const name = raw.replace(/\s+/g, " ").trim().slice(0, 60);
          if (!name) return null;
          yield* db.insert(gameTable).values({ name, emoji: null, added_by: user, added_at: yield* nowIso }).onConflictDoNothing();
          return (yield* db.select({ name: gameTable.name }).from(gameTable).where(eq(gameTable.name, name)))[0].name;
        }),
        remove: Effect.fn("Games.remove")(function* (name: string) {
          yield* db.delete(gameTable).where(eq(gameTable.name, name));
        }),
        label: Effect.gen(function* () {
          const list = yield* db.select({ name: gameTable.name, emoji: gameTable.emoji }).from(gameTable);
          const emoji = new Map(list.map((g) => [g.name.toLowerCase(), g.emoji]));
          return (g: string) => `${emoji.get(g.toLowerCase()) ?? "🎮"} ${g}`;
        }).pipe(Effect.withSpan("Games.label")),
        emojiFor: Effect.fn("Games.emojiFor")(function* (game: string) {
          const [g] = yield* db.select({ emoji: gameTable.emoji }).from(gameTable).where(eq(gameTable.name, game));
          return g?.emoji ?? "🎮";
        }),
      });
    }),
  );
}

// the old functions, for the code that isn't on Effect yet
export const games = (env: Env, limit = 25) => run(env, Games.use((g) => g.list(limit))); // LEGACY-BRIDGE
export const addGame = (env: Env, raw: string, user: string) => run(env, Games.use((g) => g.add(raw, user))); // LEGACY-BRIDGE
export const removeGame = (env: Env, name: string) => run(env, Games.use((g) => g.remove(name))); // LEGACY-BRIDGE
export const gameLabel = (env: Env) => run(env, Games.use((g) => g.label)); // LEGACY-BRIDGE
export const emojiFor = (env: Env, game: string) => run(env, Games.use((g) => g.emojiFor(game))); // LEGACY-BRIDGE
