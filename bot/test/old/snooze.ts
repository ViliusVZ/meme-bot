// The old functions of src/snooze.ts, for the tests until phase 6 makes them Effect-native
// (plan 05, phase 5 step 8: the transition left src; the tests change only their imports).
export * from "../../src/snooze.js";
import { run } from "../../src/legacy.js";
import { Snoozes, Span } from "../../src/snooze.js";
import type { Env } from "../../src/env.js";

// the old functions, for the code that isn't on Effect yet
export const current = (env: Env) => run(env, Snoozes.use((s) => s.current));
export const isSnoozed = (env: Env, day: string) => run(env, Snoozes.use((s) => s.isSnoozed(day)));
export const nextCard = (env: Env) => run(env, Snoozes.use((s) => s.nextCard));
export const snooze = (env: Env, user: string, span: Span) => run(env, Snoozes.use((s) => s.snooze(user, span)));
export const wake = (env: Env, user: string) => run(env, Snoozes.use((s) => s.wake(user)));
export const panel = (env: Env, notice?: string) => run(env, Snoozes.use((s) => s.panel(notice)));
