// The game list. Moved out of gamenight.ts so the modules game night itself uses can read it
// without importing it back (plan 05 removes that import cycle).
import { asc, desc, eq } from "drizzle-orm";
import type { Env } from "./env.js";
import { games as gameTable } from "./db/index.js";
import { now } from "./memes.js";

export interface Game {
  name: string;
  emoji: string | null;
  plays: number;
}

/** The game list, most played first (a dropdown holds 25). */
export async function games(env: Env, limit = 25): Promise<Game[]> {
  return env.db
    .select({ name: gameTable.name, emoji: gameTable.emoji, plays: gameTable.plays })
    .from(gameTable)
    .orderBy(desc(gameTable.plays), asc(gameTable.seq))
    .limit(limit);
}

/** Adds a game if it's new; returns its stored name (names are case-insensitive). */
export async function addGame(env: Env, raw: string, user: string) {
  const name = raw.replace(/\s+/g, " ").trim().slice(0, 60);
  if (!name) return null;
  await env.db.insert(gameTable).values({ name, emoji: null, added_by: user, added_at: now() }).onConflictDoNothing();
  return (await env.db.select({ name: gameTable.name }).from(gameTable).where(eq(gameTable.name, name)))[0].name;
}

export const removeGame = (env: Env, name: string) => env.db.delete(gameTable).where(eq(gameTable.name, name));

/** Compare-and-set on the stage, so concurrent clicks can only advance a night once. */

/** "👻 Phasmophobia", using each game's emoji. */
export async function gameLabel(env: Env) {
  const list = await env.db.select({ name: gameTable.name, emoji: gameTable.emoji }).from(gameTable);
  const emoji = new Map(list.map((g) => [g.name.toLowerCase(), g.emoji]));
  return (g: string) => `${emoji.get(g.toLowerCase()) ?? "🎮"} ${g}`;
}

export async function emojiFor(env: Env, game: string) {
  const [g] = await env.db.select({ emoji: gameTable.emoji }).from(gameTable).where(eq(gameTable.name, game));
  return g?.emoji ?? "🎮";
}
