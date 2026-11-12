// The old functions of src/interactions.ts, for the tests until phase 6 makes them Effect-native
// (plan 05, phase 5 step 8: the transition left src; the tests change only their imports).
export * from "../../src/interactions.js";
import { run } from "./legacy.js";
import { Interactions } from "../../src/interactions.js";
import type { Env } from "./env.js";

// the old function, for the code that isn't on Effect yet (app.ts's route, the tests)
export const interaction = (i: unknown, env: Env): Promise<object> => run(env, Interactions.use((x) => x.handle(i)));
