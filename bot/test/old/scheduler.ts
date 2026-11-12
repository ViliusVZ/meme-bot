// The old functions of src/scheduler.ts, for the tests until phase 6 makes them Effect-native
// (plan 05, phase 5 step 8: the transition left src; the tests change only their imports).
export * from "../../src/scheduler.js";
import { forkDetached, runDetached, runSync } from "../../src/legacy.js";
import { ClockOptions, Ticker, TickerOptions } from "../../src/scheduler.js";
import type { Env } from "../../src/env.js";
import { Effect, Fiber } from "effect";

// the old functions, for the code that isn't on Effect yet (main.ts, the fake-timer tests)
export const sinceTick = () => runSync(Ticker.use((t) => t.sinceTick));
export function start(env: Env, opts: ClockOptions = {}) {
  const ticker: TickerOptions = {
    onStall: opts.onStall ? (mins) => Effect.sync(() => opts.onStall!(mins)) : undefined,
    minute: opts.minute ? Effect.promise(() => opts.minute!(env)) : undefined,
  };
  const fiber = forkDetached(env, Effect.scoped(Ticker.use((t) => t.run(ticker))));
  return { stop: () => runDetached(Fiber.interrupt(fiber)) };
}
