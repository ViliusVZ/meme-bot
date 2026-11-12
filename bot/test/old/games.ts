// The old functions of src/games.ts, for the tests until phase 6 makes them Effect-native
// (plan 05, phase 5 step 8: the transition left src; the tests change only their imports).
export * from "../../src/games.js";
import { run } from "../../src/legacy.js";
import { Games } from "../../src/games.js";
import type { Env } from "../../src/env.js";

// the old functions, for the code that isn't on Effect yet
export const games = (env: Env, limit = 25) => run(env, Games.use((g) => g.list(limit)));
export const addGame = (env: Env, raw: string, user: string) => run(env, Games.use((g) => g.add(raw, user)));
export const removeGame = (env: Env, name: string) => run(env, Games.use((g) => g.remove(name)));
export const gameLabel = (env: Env) => run(env, Games.use((g) => g.label));
export const emojiFor = (env: Env, game: string) => run(env, Games.use((g) => g.emojiFor(game)));
