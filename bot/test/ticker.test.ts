// Test 9 (plan 05, verification.md §7): the leader's clock under TestClock. It never fires early,
// never overlaps a slow minute, catches up once at start, and its watchdog reports once at 5
// minutes. (The fake-timer tests in resilience.test.ts keep their own assertions beside these.)
import { assert, describe, it } from "@effect/vitest";
import { Clock, Effect, Fiber, Layer, Ref } from "effect";
import { TestClock } from "effect/testing";
import { Ticker } from "../src/scheduler.js";
import { Jobs } from "../src/jobs.js";
import { GameNight } from "../src/gamenight.js";
import { Alerts } from "../src/alerts.js";
import type { Night } from "../src/nights.js";

const START = Date.parse("2026-11-09T17:00:30Z");

/** A ticker over stand-in jobs and nights: `soon` are the nights about to start, `started` counts their timers. */
const ticker = (soon: Night[] = []) =>
  Effect.gen(function* () {
    const started = yield* Ref.make<string[]>([]);
    const failed = yield* Ref.make<string[]>([]);
    const layer = Ticker.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(Jobs, {}),
          Layer.mock(GameNight, {
            upcomingStarts: () => Effect.succeed(soon),
            startOnTime: (n: Night) => Effect.as(Ref.update(started, (s) => [...s, n.day]), true),
          }),
          Layer.mock(Alerts, { failed: (what: string) => Ref.update(failed, (f) => [...f, what]) }),
        ),
      ),
    );
    return { layer, started, failed };
  });

/** Runs the clock in its own fiber with `minute`; `stop` ends its term. */
const running = (minute: Effect.Effect<Record<string, unknown>>, onStall?: (mins: number) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    const t = yield* Ticker;
    const fiber = yield* Effect.forkChild(Effect.scoped(t.run({ minute, onStall })));
    yield* Effect.yieldNow;
    return { fiber, sinceTick: t.sinceTick };
  });

const at = (ms: number) => TestClock.setTime(ms);
const seconds = (ms: number) => Math.round(ms / 1000);

describe("the ticker (TestClock)", () => {
  it.effect("catches up once at start, then runs just past the top of every minute, never early", () =>
    Effect.gen(function* () {
      yield* at(START);
      const { layer } = yield* ticker();
      yield* Effect.gen(function* () {
        const runs = yield* Ref.make<number[]>([]);
        const minute = Effect.flatMap(Clock.currentTimeMillis, (now) => Effect.as(Ref.update(runs, (r) => [...r, now]), {}));
        const { fiber, sinceTick } = yield* running(minute);
        assert.deepStrictEqual(yield* Ref.get(runs), [START]); // the catch-up, at once
        assert.strictEqual(yield* sinceTick, 0);
        yield* at(Date.parse("2026-11-09T17:01:00.049Z"));
        assert.strictEqual((yield* Ref.get(runs)).length, 1); // not before the minute has turned (and 50 ms more)
        assert.strictEqual(yield* sinceTick, 30);
        yield* at(Date.parse("2026-11-09T17:01:00.050Z"));
        yield* at(Date.parse("2026-11-09T17:03:30Z"));
        assert.deepStrictEqual((yield* Ref.get(runs)).slice(1).map((t) => new Date(t).toISOString()), [
          "2026-11-09T17:01:00.050Z",
          "2026-11-09T17:02:00.050Z",
          "2026-11-09T17:03:00.050Z",
        ]);
        yield* Fiber.interrupt(fiber);
        assert.strictEqual(yield* sinceTick, null); // a follower has no clock
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("a slow minute is never overlapped: the next one waits for it, then for the next top of the minute", () =>
    Effect.gen(function* () {
      yield* at(START);
      const { layer } = yield* ticker();
      yield* Effect.gen(function* () {
        const busy = yield* Ref.make(0);
        const most = yield* Ref.make(0);
        const runs = yield* Ref.make<number[]>([]);
        const minute = Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          yield* Ref.update(runs, (r) => [...r, now]);
          const n = yield* Ref.updateAndGet(busy, (b) => b + 1);
          yield* Ref.update(most, (m) => Math.max(m, n));
          if ((yield* Ref.get(runs)).length === 1) yield* Effect.sleep("150 seconds"); // the first one takes 2½ minutes
          yield* Ref.update(busy, (b) => b - 1);
          return {};
        });
        const { fiber, sinceTick } = yield* running(minute);
        yield* at(Date.parse("2026-11-09T17:02:59Z"));
        assert.strictEqual((yield* Ref.get(runs)).length, 1); // still the first
        assert.strictEqual(yield* sinceTick, seconds(Date.parse("2026-11-09T17:02:59Z") - START)); // falling behind, as /health shows
        yield* at(Date.parse("2026-11-09T17:04:30Z"));
        assert.deepStrictEqual((yield* Ref.get(runs)).map((t) => new Date(t).toISOString()), [
          "2026-11-09T17:00:30.000Z",
          "2026-11-09T17:04:00.050Z", // it ended at 17:03:00, so the next top of the minute after that
        ]);
        assert.strictEqual(yield* Ref.get(most), 1);
        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("a minute stuck for 5 minutes is reported once", () =>
    Effect.gen(function* () {
      yield* at(START);
      const { layer } = yield* ticker();
      yield* Effect.gen(function* () {
        const stalls = yield* Ref.make<number[]>([]);
        const { fiber } = yield* running(Effect.never, (mins) => Ref.update(stalls, (s) => [...s, mins]));
        yield* TestClock.adjust("4 minutes");
        assert.deepStrictEqual(yield* Ref.get(stalls), []);
        yield* TestClock.adjust("59 seconds");
        assert.deepStrictEqual(yield* Ref.get(stalls), []); // the watchdog looks every 30 s: 4:30 is its last look before 5 minutes
        yield* TestClock.adjust("31 seconds");
        assert.deepStrictEqual(yield* Ref.get(stalls), [5]);
        yield* TestClock.adjust("20 minutes");
        assert.deepStrictEqual(yield* Ref.get(stalls), [5]); // once
        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("a minute that dies is reported, and the next minute still runs", () =>
    Effect.gen(function* () {
      yield* at(START);
      const { layer, failed } = yield* ticker();
      yield* Effect.gen(function* () {
        const runs = yield* Ref.make(0);
        const minute = Effect.flatMap(Ref.updateAndGet(runs, (n) => n + 1), (n) => (n === 1 ? Effect.die(new Error("a bug")) : Effect.succeed({})));
        const { fiber } = yield* running(minute);
        yield* TestClock.adjust("1 minute");
        assert.strictEqual(yield* Ref.get(runs), 2);
        assert.deepStrictEqual(yield* Ref.get(failed), ["the minute jobs"]);
        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("a night about to start gets one timer, however many minutes see it coming", () =>
    Effect.gen(function* () {
      yield* at(START);
      const night = { day: "2026-11-09", start_at: Math.floor(START / 1000) + 100, game: "R.E.P.O." } as Night;
      const { layer, started } = yield* ticker([night]);
      yield* Effect.gen(function* () {
        const { fiber } = yield* running(Effect.succeed({}));
        yield* TestClock.adjust("3 minutes"); // four minutes have seen it (the catch-up and three more)
        assert.deepStrictEqual(yield* Ref.get(started), ["2026-11-09"]);
        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(layer));
    }),
  );
});
