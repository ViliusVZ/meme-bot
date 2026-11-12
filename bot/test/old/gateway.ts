// The old functions of src/gateway.ts, for the tests until phase 6 makes them Effect-native
// (plan 05, phase 5 step 8: the transition left src; the tests change only their imports).
export * from "../../src/gateway.js";
import { forkDetached, runDetached } from "../../src/legacy.js";
import { Gateway } from "../../src/gateway.js";
import type { Env } from "../../src/env.js";
import { Effect, Fiber } from "effect";

// the old shape, for main.ts until Leadership owns the term: connect in the background, close when done
export function start(env: Env, onSnapshot: () => void) {
  const fiber = forkDetached(env, Effect.scoped(Effect.andThen(Gateway.use((g) => g.hold(Effect.sync(onSnapshot))), Effect.never)));
  return { close: () => runDetached(Fiber.interrupt(fiber)) };
}
