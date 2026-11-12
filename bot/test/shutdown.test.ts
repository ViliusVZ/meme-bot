// Test 12 (plan 05, verification.md §7; architecture.md §13): shutdown runs its steps in order: /health
// says 503 first; the leader's term ends at once (given at most 15 s), with at least 3 s for the proxy
// to move traffic; then the server stops; then background work gets its 20 s. The pool closes after
// all of it (main.ts disposes the runtime last). Under TestClock, with stand-ins for each part.
// Test 14: the complete app layer builds with test config and the fake Discord.
import { assert, describe, it } from "@effect/vitest";
import { Clock, Context, Effect, Fiber, Layer, Ref, Scope } from "effect";
import { TestClock } from "effect/testing";
import { shutdown } from "../src/shutdown.js";
import { Lifecycle } from "../src/lifecycle.js";
import { Background } from "../src/background.js";
import { Alerts } from "../src/alerts.js";
import { appLayerFor } from "../src/runtime.js";
import { Leadership } from "../src/leadership.js";
import { configFromEnv } from "../src/legacy.js";
import { testEnv, url } from "./pg.js";

const T0 = Date.parse("2026-11-10T19:00:00Z");
const flush = Effect.repeat(Effect.yieldNow, { times: 200 });

/** Advance the clock a second at a time until `fiber` is done (or `limit` seconds pass). */
const runOut = (fiber: Fiber.Fiber<unknown, unknown>, limit: number) =>
  Effect.gen(function* () {
    for (let s = 0; s < limit && !fiber.pollUnsafe(); s++) {
      yield* flush;
      yield* TestClock.adjust("1 second");
    }
    yield* flush;
    return yield* Fiber.await(fiber);
  });

const parts = Effect.gen(function* () {
  const log = yield* Ref.make<string[]>([]);
  const note = (s: string) => Effect.flatMap(Clock.currentTimeMillis, (t) => Ref.update(log, (l) => [...l, `${(t - T0) / 1000}s ${s}`]));
  const layer = Layer.mergeAll(Lifecycle.layer, Background.layer.pipe(Layer.provide(Layer.mock(Alerts, { failed: () => Effect.void }))));
  return { log, note, layer };
});

describe("shutdown (TestClock)", () => {
  it.effect("503 first; the term ends; 3 s for the proxy; the server stops; background gets 20 s", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const { log, note, layer } = yield* parts;
      yield* Effect.gen(function* () {
        const lifecycle = yield* Lifecycle;
        const background = yield* Background;
        // a term that takes a second to end; a server; a background task that needs 10 s more
        const leading = yield* Effect.forkDetach(Effect.onInterrupt(Effect.never, () => Effect.andThen(Effect.sleep("1 second"), note("term ended"))));
        const server = yield* Scope.make();
        yield* Scope.addFinalizer(server, note("server stopped"));
        yield* background.run(Effect.andThen(Effect.sleep("10 seconds"), note("background done")), "a test task");
        yield* flush;
        const down = yield* Effect.forkChild(
          Effect.andThen(shutdown("SIGTERM", { leading, server }), note("shutdown done")),
        );
        yield* flush;
        assert.isTrue(yield* lifecycle.shuttingDown); // /health says 503 before anything else
        yield* runOut(down, 60);
        assert.deepStrictEqual(yield* Ref.get(log), ["1s term ended", "3s server stopped", "10s background done", "10s shutdown done"]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("a term that won't end is given 15 s; background work still unfinished at 20 s is interrupted", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const { log, note, layer } = yield* parts;
      yield* Effect.gen(function* () {
        const background = yield* Background;
        const leading = yield* Effect.forkDetach(Effect.uninterruptible(Effect.never));
        const server = yield* Scope.make();
        yield* Scope.addFinalizer(server, note("server stopped"));
        yield* background.run(Effect.andThen(Effect.sleep("1 hour"), note("background done")), "a stuck task");
        yield* flush;
        const down = yield* Effect.forkChild(Effect.andThen(shutdown("SIGTERM", { leading, server }), note("shutdown done")));
        yield* runOut(down, 120);
        assert.deepStrictEqual(yield* Ref.get(log), ["15s server stopped", "35s shutdown done"]);
        assert.strictEqual(yield* background.inFlight, 0);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("a second signal changes nothing", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const { log, note, layer } = yield* parts;
      yield* Effect.gen(function* () {
        const leading = yield* Effect.forkDetach(Effect.never);
        const server = yield* Scope.make();
        yield* Scope.addFinalizer(server, note("server stopped"));
        const first = yield* Effect.forkChild(shutdown("SIGTERM", { leading, server }));
        yield* flush;
        yield* shutdown("SIGINT", { leading, server });
        yield* runOut(first, 60);
        assert.deepStrictEqual(yield* Ref.get(log), ["3s server stopped"]);
      }).pipe(Effect.provide(layer));
    }),
  );
});

describe("the app's layer", () => {
  // on the live clock: the pool connects for real
  it.live("builds complete with test config (no missing or circular dependency)", () =>
    Effect.gen(function* () {
      const ctx = yield* Layer.build(appLayerFor(configFromEnv(testEnv({} as never), { databaseUrl: url() })));
      assert.isFunction(Context.get(ctx, Leadership).lead);
    }).pipe(Effect.scoped),
  );
});
