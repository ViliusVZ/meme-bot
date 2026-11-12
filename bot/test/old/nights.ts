// The old functions of src/nights.ts, for the tests until phase 6 makes them Effect-native
// (plan 05, phase 5 step 8: the transition left src; the tests change only their imports).
export * from "../../src/nights.js";
import { run, runSync } from "../../src/legacy.js";
import { Nights } from "../../src/nights.js";
import type { Env } from "../../src/env.js";
import { Stage } from "../../src/db/schema.js";

// the old functions, for the code that isn't on Effect yet
export const getNight = (env: Env, day: string) => run(env, Nights.use((n) => n.get(day)));
// synchronous, as it always was (callers filter with it)
export const isOver = (_env: Env, n: { day: string; stage: Stage }) => runSync(Nights.use((x) => x.isOver(n)));
