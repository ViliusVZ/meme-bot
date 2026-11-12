// The old functions of src/spontaneous.ts, for the tests until phase 6 makes them Effect-native
// (plan 05, phase 5 step 8: the transition left src; the tests change only their imports).
export * from "../../src/spontaneous.js";
import { run } from "./legacy.js";
import { Change, Spontaneous, names } from "../../src/spontaneous.js";
import type { Env } from "./env.js";
import { Where } from "../../src/spontaneous.js";

// the old functions, for the code that isn't on Effect yet
export const react = (env: Env, where: Where, t?: number, change?: Change) =>
  run(env, Spontaneous.use((s) => s.react(where, t, change))).catch((e: unknown) => {
    throw e instanceof Error && "_tag" in e && String(e._tag).startsWith("Discord") ? new Error(e.message) : e; // today's text, which the alert DM quotes
  });
export const learn = (env: Env, names: string[], t?: number) => run(env, Spontaneous.use((s) => s.learn(names, t)));
export const recentGames = (env: Env, n?: number) => run(env, Spontaneous.use((s) => s.recentGames(n)));
export const answer = (env: Env, id: number, user: string, what: string, game?: string) => run(env, Spontaneous.use((s) => s.answer(id, user, what, game)));
export const goBack = (env: Env, channel: string, users: string[], messageId: string | undefined, t?: number) =>
  run(env, Spontaneous.use((s) => s.goBack(channel, users, messageId, t)));
export const absorb = (env: Env, day: string, game: string) => run(env, Spontaneous.use((s) => s.absorb(day, game)));
export const minute = (env: Env, t?: number) => run(env, Spontaneous.use((s) => s.minute(t)));
export const counted = (env: Env, fromDay: string, toDay: string) => run(env, Spontaneous.use((s) => s.counted(fromDay, toDay)));
