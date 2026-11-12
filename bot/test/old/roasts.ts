// The old functions of src/roasts.ts, for the tests until phase 6 makes them Effect-native
// (plan 05, phase 5 step 8: the transition left src; the tests change only their imports).
export * from "../../src/roasts.js";
import { run } from "./legacy.js";
import { Roasts } from "../../src/roasts.js";
import type { Env } from "./env.js";

// the old functions, for the code that isn't on Effect yet
export const next = (env: Env, users: string[]) => run(env, Roasts.use((r) => r.next(users)));
export const draw = (env: Env, family: string, all: string[], fits: string[]) => run(env, Roasts.use((r) => r.draw(family, all, fits)));
