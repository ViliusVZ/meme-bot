// The old functions of src/cleanup.ts, for the tests until phase 6 makes them Effect-native
// (plan 05, phase 5 step 8: the transition left src; the tests change only their imports).
export * from "../../src/cleanup.js";
import { run } from "./legacy.js";
import { Cleanup } from "../../src/cleanup.js";
import type { Env } from "./env.js";

// the old functions, for the code that isn't on Effect yet
const asOld = (e: unknown) => {
  throw e instanceof Error && "_tag" in e && String(e._tag).startsWith("Discord") ? new Error(e.message) : e;
};
export const sweep = (env: Env, cutoffMs: number) => run(env, Cleanup.use((c) => c.sweep(cutoffMs))).catch(asOld);
export const nightly = (env: Env) => run(env, Cleanup.use((c) => c.nightly)).catch(asOld);
