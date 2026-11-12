// The old functions of src/panels.ts, for the tests until phase 6 makes them Effect-native
// (plan 05, phase 5 step 8: the transition left src; the tests change only their imports).
export * from "../../src/panels.js";
import { run } from "../../src/legacy.js";
import { CopyNotFound, Panels } from "../../src/panels.js";
import type { Env } from "../../src/env.js";

// the old functions, for the code that isn't on Effect yet
export const track = (env: Env, card: string, user: string, token: string, messageId?: string) =>
  run(env, Panels.use((p) => p.track(card, user, token, messageId))).catch((e: unknown) => {
    throw e instanceof CopyNotFound ? new Error(e.message) : e; // today's text, which the alert DM quotes
  });
