// The old functions of src/live.ts, for the tests until phase 6 makes them Effect-native
// (plan 05, phase 5 step 8: the transition left src; the tests change only their imports).
export * from "../../src/live.js";
import { forkDetached, runDetached } from "./legacy.js";
import { Live } from "../../src/live.js";
import type { Env } from "./env.js";
import { Effect, Fiber } from "effect";

// the old function, for main.ts until Leadership owns the term
export function start(env: Env) {
  let resync: Effect.Effect<void> = Effect.void;
  let ready!: () => void;
  const started = new Promise<void>((ok) => (ready = ok));
  const fiber = forkDetached(env, Effect.scoped(Effect.flatMap(Live.use((l) => l.watch), (w) => Effect.andThen(Effect.sync(() => ((resync = w.resync), ready())), Effect.never))));
  return {
    resync: () => started.then(() => runDetached(resync)),
    stop: () => runDetached(Fiber.interrupt(fiber)),
  };
}
