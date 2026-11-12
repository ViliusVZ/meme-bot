// The old functions of src/reddit.ts, for the tests until phase 6 makes them Effect-native
// (plan 05, phase 5 step 8: the transition left src; the tests change only their imports).
export * from "../../src/reddit.js";
import { run, runSync } from "../../src/legacy.js";
import { Reddit } from "../../src/reddit.js";
import type { Env } from "../../src/env.js";

// the old functions, for the code that isn't on Effect yet
export const maybeRefill = (env: Env) => run(env, Reddit.use((r) => r.maybeRefill));
export const refilling = () => runSync(Reddit.use((r) => r.refilling));
export const _reset = () => runSync(Reddit.use((r) => r.reset));
