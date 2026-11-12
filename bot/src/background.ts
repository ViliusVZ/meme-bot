// Work that continues after we've answered Discord (followups, panel edits, pings). Tracked, so a
// deploy or restart waits for it to finish before the process exits.
import { Cause, Context, Duration, Effect, FiberSet, Layer } from "effect";
import { Alerts } from "./alerts.js";
import { runDetached, runSync } from "./legacy.js"; // LEGACY-BRIDGE

export class Background extends Context.Service<
  Background,
  {
    /** Run `effect` in the background; a failure is reported under `label`, never thrown. */
    run<A, E, R>(effect: Effect.Effect<A, E, R>, label?: string): Effect.Effect<void, never, R>;
    /** Wait for in-flight background work, up to `timeout`, then interrupt what's left; how many were left. */
    drain(timeout: Duration.Input): Effect.Effect<number>;
    /** How many are running now (/health). */
    readonly inFlight: Effect.Effect<number>;
  }
>()("meme-bot/background") {
  static readonly layer = Layer.effect(
    Background,
    Effect.gen(function* () {
      const alerts = yield* Alerts;
      const set = yield* FiberSet.make();
      return Background.of({
        run: (effect, label = "background work") =>
          // the boundary for background work: whatever a task lets through is reported, per task
          // (an interruption is shutdown or a replaced task, not a failure)
          Effect.asVoid(FiberSet.run(set, effect.pipe(Effect.catchCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.void : alerts.failed(label, Cause.squash(cause))))))),
        drain: (timeout) =>
          Effect.gen(function* () {
            yield* Effect.timeoutOption(FiberSet.awaitEmpty(set), timeout);
            const left = yield* FiberSet.size(set);
            if (left) yield* FiberSet.clear(set); // out of time: the rest is interrupted (architecture §11)
            return left;
          }),
        inFlight: FiberSet.size(set),
      });
    }),
  );
}

// the old functions, for the code that isn't on Effect yet
/** Run `p` in the background; failures are logged with `label`, never thrown. */
export function defer(p: Promise<unknown>, label = "background work") { // LEGACY-BRIDGE
  runSync(Background.use((b) => b.run(Effect.promise(() => p), label))); // LEGACY-BRIDGE
} // LEGACY-BRIDGE

/** Wait for in-flight background work, up to `ms`. */
export const drain = (ms: number) => runDetached(Background.use((b) => b.drain(Duration.millis(ms)))); // LEGACY-BRIDGE

export const inFlight = () => runSync(Background.use((b) => b.inFlight)); // LEGACY-BRIDGE
