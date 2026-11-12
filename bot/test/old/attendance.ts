// The old functions of src/attendance.ts, for the tests until phase 6 makes them Effect-native
// (plan 05, phase 5 step 8: the transition left src; the tests change only their imports).
export * from "../../src/attendance.js";
import { run } from "../../src/legacy.js";
import { Attendance, Attendances, slipFor } from "../../src/attendance.js";
import type { Env } from "../../src/env.js";
import { Changes } from "../../src/attendance.js";

// the old functions, for the code that isn't on Effect yet
export const get = (env: Env, day: string, user: string) => run(env, Attendances.use((a) => a.get(day, user)));
export const put = (env: Env, day: string, user: string, set: Changes) => run(env, Attendances.use((a) => a.put(day, user, set)));
export const expect = (env: Env, day: string, user: string, eta: number | null) => run(env, Attendances.use((a) => a.expect(day, user, eta)));
export const etas = (env: Env, day: string) => run(env, Attendances.use((a) => a.etas(day)));
export const declare = (env: Env, day: string, user: string, mins: number) =>
  run(env, Attendances.use((a) => a.declare(day, user, mins))).catch((e: unknown) => {
    throw e instanceof Error && "_tag" in e && String(e._tag).startsWith("Discord") ? new Error(e.message) : e; // today's text, which the alert DM quotes
  });
export const markArrived = (env: Env, day: string, users: string[]) => run(env, Attendances.use((a) => a.markArrived(day, users)));
export const retireSlips = (env: Env, day: string) => run(env, Attendances.use((a) => a.retireSlips(day)));
export const render = (env: Env, day: string, user: string) => run(env, Attendances.use((a) => a.render(day, user)));
export const slip = (_env: Env, day: string, user: string, row: Attendance, game: string, startAt?: number, roomId?: string) => slipFor(day, user, row, game, startAt, roomId);
