// The old functions of src/late.ts, for the tests until phase 6 makes them Effect-native
// (plan 05, phase 5 step 8: the transition left src; the tests change only their imports).
export * from "../../src/late.js";
// the data half moved to attendance.ts; still offered from here to the tests
export { declare, etas, expect, get, markArrived, render, retireSlips, type Attendance } from "./attendance.js";
import { run } from "../../src/legacy.js";
import { LateSlips } from "../../src/late.js";
import type { Env } from "../../src/env.js";

// the old functions, for the code that isn't on Effect yet
const asOld = (e: unknown) => {
  throw e instanceof Error && "_tag" in e && String(e._tag).startsWith("Discord") ? new Error(e.message) : e;
};
export const watch = (env: Env) => run(env, LateSlips.use((l) => l.watch));
export const act = (env: Env, day: string, owner: string, clicker: string, choice: string) => run(env, LateSlips.use((l) => l.act(day, owner, clicker, choice))).catch(asOld);
