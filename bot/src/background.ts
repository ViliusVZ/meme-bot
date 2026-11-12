// Work that continues after we've answered Discord (followups, panel edits, pings). Tracked, so a
// deploy or restart waits for it to finish before the process exits.
import { Cause, Context, Duration, Effect, FiberSet, Layer } from "effect";
import { Alerts } from "./alerts.js";

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
            // out of time: the rest is interrupted (architecture §11), without waiting for it, so the count
            // is logged at once (a task in a protected region finishes first, or the hard exit ends it)
            if (left) yield* Effect.forkDetach(FiberSet.clear(set), { startImmediately: true });
            return left;
          }),
        inFlight: FiberSet.size(set),
      });
    }),
  );
}
