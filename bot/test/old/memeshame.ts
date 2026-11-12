// The old functions of src/memeshame.ts, for the tests until phase 6 makes them Effect-native
// (plan 05, phase 5 step 8: the transition left src; the tests change only their imports).
export * from "../../src/memeshame.js";
import { run } from "./legacy.js";
import { MemeShame } from "../../src/memeshame.js";
import type { Env } from "./env.js";

// the old functions, for the code that isn't on Effect yet
const asOld = (e: unknown) => {
  throw e instanceof Error && "_tag" in e && String(e._tag).startsWith("Discord") ? new Error(e.message) : e;
};
export const slackers = (env: Env, t?: number) => run(env, MemeShame.use((m) => m.slackers(t)));
export const evening = (env: Env) => run(env, MemeShame.use((m) => m.evening)).catch(asOld);
