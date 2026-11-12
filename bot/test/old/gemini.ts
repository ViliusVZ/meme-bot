// The old functions of src/gemini.ts, for the tests until phase 6 makes them Effect-native
// (plan 05, phase 5 step 8: the transition left src; the tests change only their imports).
export * from "../../src/gemini.js";
import { run } from "./legacy.js";
import { Gemini } from "../../src/gemini.js";
import type { Env } from "./env.js";
import { Schema } from "effect";

// the old function, for the code that isn't on Effect yet: any JSON answer, typed by the caller
export const ask = <T>(env: Env, prompt: string, schema: object): Promise<T | null> =>
  run(env, Gemini.use((g) => g.ask(prompt, schema, Schema.Unknown))) as Promise<T | null>;
