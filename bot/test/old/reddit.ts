// The old functions of src/reddit.ts, for the tests until phase 6 makes them Effect-native
// (plan 05, phase 5 step 8: the transition left src; the tests change only their imports).
export * from "../../src/reddit.js";
import { run, runSync } from "./legacy.js";
import { restart } from "./legacy.js";
import { Reddit } from "../../src/reddit.js";
import type { Env } from "./env.js";

// the old functions, for the code that isn't on Effect yet
export const maybeRefill = (env: Env) => run(env, Reddit.use((r) => r.maybeRefill));
export const refilling = () => runSync(Reddit.use((r) => r.refilling));
/** Fresh state: a new runtime (every in-memory state starts again, as after a deploy). */
export const _reset = () => restart();
