// Shutting down, in this order (architecture.md §13; blue/green handover depends on it):
//   1. /health answers 503 from now on, so the proxy sends new requests to the other copy
//   2. end the leader's term at once, so the other copy takes the gateway and the clock; at most
//      15 s. Meanwhile wait 3 s, so the proxy's health check has moved traffic away
//   3. stop the HTTP server: no new requests, finish those in flight
//   4. drain background work, up to 20 s
//   5. (the caller) close the pool, last
import { Duration, Effect, Exit, Fiber, Scope } from "effect";
import { Lifecycle } from "./lifecycle.js";
import { Background } from "./background.js";

const TERM_CAP = Duration.seconds(15);
const PROXY_MOVES = Duration.seconds(3);
const DRAIN = Duration.seconds(20);

export interface Running {
  /** The leadership loop (its current term, if any). */
  readonly leading: Fiber.Fiber<unknown, unknown>;
  /** The HTTP server's scope: closing it stops taking requests and finishes those in flight. */
  readonly server: Scope.Closeable;
}

/** Steps 1 to 4. A second call (say, SIGINT after SIGTERM) does nothing. */
export const shutdown = Effect.fn("shutdown")(function* (signal: string, running: Running) {
  const lifecycle = yield* Lifecycle;
  const background = yield* Background;
  if (yield* lifecycle.shuttingDown) return;
  yield* lifecycle.markShuttingDown;
  yield* Effect.logInfo(`${signal}: shutting down`);
  // the term's end runs on its own: the cap bounds how long we wait for it, not the term itself
  yield* Effect.forkDetach(Fiber.interrupt(running.leading), { startImmediately: true });
  yield* Effect.all([Effect.timeoutOption(Fiber.await(running.leading), TERM_CAP), Effect.sleep(PROXY_MOVES)], { concurrency: 2, discard: true });
  yield* Scope.close(running.server, Exit.void);
  const left = yield* background.drain(DRAIN);
  if (left) yield* Effect.logInfo(`exiting with ${left} background task(s) unfinished`);
});
