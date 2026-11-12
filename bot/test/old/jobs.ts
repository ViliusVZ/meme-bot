// The old functions of src/jobs.ts, for the tests until phase 6 makes them Effect-native
// (plan 05, phase 5 step 8: the transition left src; the tests change only their imports).
export * from "../../src/jobs.js";
import { run } from "../../src/legacy.js";
import { Jobs } from "../../src/jobs.js";
import type { Env } from "../../src/env.js";

// the old functions, for the code that isn't on Effect yet
const asOld = (e: unknown) => {
  throw e instanceof Error && "_tag" in e && String(e._tag).startsWith("Discord") ? new Error(e.message) : e;
};
export const minute = (env: Env) => run(env, Jobs.use((j) => j.minute));
export const postDaily = (env: Env) => run(env, Jobs.use((j) => j.postDaily)).catch(asOld);
export const weeklyRecap = (env: Env) => run(env, Jobs.use((j) => j.weeklyRecap)).catch(asOld);
export const monthlyRecap = (env: Env) => run(env, Jobs.use((j) => j.monthlyRecap)).catch(asOld);
