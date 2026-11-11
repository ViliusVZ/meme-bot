// Where this copy stands: leading or not, shutting down or not. /health reads both; the server's
// watchdog and Caddy act on them.
import { Context, Effect, Layer, Ref } from "effect";
import { runSync } from "./legacy.js"; // LEGACY-BRIDGE

export class Lifecycle extends Context.Service<
  Lifecycle,
  {
    readonly leader: Effect.Effect<boolean>;
    readonly shuttingDown: Effect.Effect<boolean>;
    setLeader(leading: boolean): Effect.Effect<void>;
    /** From now on /health answers 503, so the proxy sends new requests to the other copy. */
    readonly markShuttingDown: Effect.Effect<void>;
  }
>()("meme-bot/lifecycle") {
  static readonly layer = Layer.effect(
    Lifecycle,
    Effect.gen(function* () {
      const leader = yield* Ref.make(false);
      const shuttingDown = yield* Ref.make(false);
      return Lifecycle.of({
        leader: Ref.get(leader),
        shuttingDown: Ref.get(shuttingDown),
        setLeader: (leading) => Ref.set(leader, leading),
        markShuttingDown: Ref.set(shuttingDown, true),
      });
    }),
  );
}

// for main.ts and app.ts until they move to Effect
export const isLeader = () => runSync(Lifecycle.use((l) => l.leader)); // LEGACY-BRIDGE
export const isShuttingDown = () => runSync(Lifecycle.use((l) => l.shuttingDown)); // LEGACY-BRIDGE
export const setLeader = (leading: boolean) => runSync(Lifecycle.use((l) => l.setLeader(leading))); // LEGACY-BRIDGE
export const markShuttingDown = () => runSync(Lifecycle.use((l) => l.markShuttingDown)); // LEGACY-BRIDGE
