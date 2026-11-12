// The old functions of src/hub.ts, for the tests until phase 6 makes them Effect-native
// (plan 05, phase 5 step 8: the transition left src; the tests change only their imports).
export * from "../../src/hub.js";
import { run, runSync } from "./legacy.js";
import { Hub } from "../../src/hub.js";
import type { Env } from "./env.js";

// the old functions, for the code that isn't on Effect yet
export const helpMessage = (_env: Env) => runSync(Hub.use((h) => h.helpMessage));
export const hubPanel = (_env: Env) => runSync(Hub.use((h) => h.hubPanel));
export const gamesManager = (env: Env, notice?: string) => run(env, Hub.use((h) => h.gamesManager(notice)));
