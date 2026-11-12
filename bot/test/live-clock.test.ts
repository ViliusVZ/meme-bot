// Test 10 (plan 05, verification.md §7), under TestClock: voice events are handled one at a time, in
// order; one failing event alerts and the next is still handled; a replaced timer never fires; a
// room's wrap-up fires exactly at its grace period; the heartbeat runs every minute while anyone's in
// voice. Real Presence, stand-ins for what Live calls. (live.test.ts checks the same on the database.)
import { assert, describe, it } from "@effect/vitest";
import { Clock, Effect, Exit, Fiber, Layer, Ref, Scope } from "effect";
import { TestClock } from "effect/testing";
import { Live } from "./old/live.js";
import { Presence } from "./old/presence.js";
import { AppConfig } from "../src/config.js";
import { Activity } from "./old/activity.js";
import { Voice } from "./old/voice.js";
import { LateSlips } from "./old/late.js";
import { Spontaneous } from "./old/spontaneous.js";
import { Alerts } from "./old/alerts.js";
import { configFromEnv } from "./old/legacy.js";
import { testEnv } from "./pg.js";

const T0 = Date.parse("2026-11-10T19:00:00Z");
/** Let the forked fibers (presence → queue → handler) catch up: TestClock moves time, not turns. */
const flush = Effect.repeat(Effect.yieldNow, { times: 200 });
const adjust = (d: Parameters<typeof TestClock.adjust>[0]) => Effect.andThen(Effect.andThen(flush, TestClock.adjust(d)), flush);
const setTime = (ms: number) => Effect.andThen(Effect.andThen(flush, TestClock.setTime(ms)), flush);
const sec = (ms: number) => Math.floor(ms / 1000);

interface Stand {
  /** How long a leave takes to record (to see whether the next event waits for it). */
  readonly leaveTakes?: (user: string) => Effect.Effect<void>;
  /** The wrap-up due after each room check, in turn (unix seconds; null: none due). */
  readonly due?: ReadonlyArray<number | null>;
}

const setup = (stand: Stand = {}) =>
  Effect.gen(function* () {
    const log = yield* Ref.make<string[]>([]);
    const checks = yield* Ref.make<number[]>([]); // when each room check ran (ms)
    const tracks = yield* Ref.make<number[]>([]); // when each track ran (ms)
    const failed = yield* Ref.make<string[]>([]);
    const note = (s: string) => Ref.update(log, (l) => [...l, s]);
    const layer = Live.layer.pipe(
      Layer.provideMerge(Presence.layer),
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(AppConfig, { ...configFromEnv(testEnv({} as never)), players: ["a", "b", "c"], lobbyChannelId: "lobby" }),
          Layer.mock(Activity, { track: () => Effect.flatMap(Clock.currentTimeMillis, (t) => Ref.update(tracks, (l) => [...l, t])) }),
          Layer.mock(Voice, {
            leftRoom: (room: string) =>
              Effect.gen(function* () {
                const user = room.slice(5); // rooms are named "room-<user>"
                yield* note(`leave ${user}`);
                yield* stand.leaveTakes?.(user) ?? Effect.void;
                yield* note(`left ${user}`);
              }),
            checkRooms: () =>
              Effect.gen(function* () {
                const t = yield* Clock.currentTimeMillis;
                const n = (yield* Ref.updateAndGet(checks, (c) => [...c, t])).length;
                const due = stand.due ?? [];
                return { archived: [], nextDue: due.length ? (due[Math.min(n, due.length) - 1] ?? null) : null };
              }),
          }),
          Layer.mock(LateSlips, { watch: Effect.succeed({}) }),
          Layer.mock(Spontaneous, { react: () => Effect.succeed(null), learn: () => Effect.succeed([]) }),
          Layer.mock(Alerts, { failed: (what: string) => Ref.update(failed, (f) => [...f, what]) }),
        ),
      ),
    );
    return { layer, log, checks, tracks, failed };
  });

/** Live watching for the rest of the test's scope (subscribed before anything moves); the snapshot says who's where to begin with. */
const watching = (start: ReadonlyArray<{ user_id: string; channel_id: string | null }>) =>
  Effect.gen(function* () {
    const p = yield* Presence;
    yield* Live.use((l) => l.watch);
    yield* p.snapshot(start);
    yield* flush;
    return { p };
  });

describe("Live (TestClock)", () => {
  it.effect("voice events are handled one at a time, in order", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const s = yield* setup({ leaveTakes: (u) => (u === "a" ? Effect.sleep("2 seconds") : Effect.void) });
      yield* Effect.gen(function* () {
        const { p } = yield* watching([
          { user_id: "a", channel_id: "room-a" },
          { user_id: "b", channel_id: "room-b" },
        ]);
        yield* p.update("a", null); // takes 2 s to record
        yield* p.update("b", null);
        yield* p.update("a", "room-a");
        yield* p.update("a", null);
        yield* adjust("10 seconds");
        assert.deepStrictEqual(yield* Ref.get(s.log), ["leave a", "left a", "leave b", "left b", "leave a", "left a"]);
      }).pipe(Effect.scoped, Effect.provide(s.layer));
    }),
  );

  it.effect("one failing event alerts, and the next one is still handled", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const s = yield* setup({ leaveTakes: (u) => (u === "a" ? Effect.die(new Error("a bug")) : Effect.void) });
      yield* Effect.gen(function* () {
        const { p } = yield* watching([
          { user_id: "a", channel_id: "room-a" },
          { user_id: "b", channel_id: "room-b" },
        ]);
        yield* p.update("a", null);
        yield* p.update("b", null);
        yield* adjust("1 second");
        assert.deepStrictEqual(yield* Ref.get(s.failed), ["live voice (voice change)"]);
        assert.deepStrictEqual(yield* Ref.get(s.log), ["leave a", "leave b", "left b"]);
      }).pipe(Effect.scoped, Effect.provide(s.layer));
    }),
  );

  it.effect("a room's wrap-up fires exactly at its grace period, never before", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const s = yield* setup({ due: [sec(T0) + 900] });
      yield* Effect.gen(function* () {
        const { p } = yield* watching([{ user_id: "a", channel_id: "room-a" }]);
        yield* p.update("a", null);
        yield* flush;
        const before = (yield* Ref.get(s.checks)).length;
        yield* setTime(T0 + 900_499);
        assert.strictEqual((yield* Ref.get(s.checks)).length, before);
        yield* setTime(T0 + 900_500); // the timer aims half a second past, so it's never early
        assert.deepStrictEqual((yield* Ref.get(s.checks)).slice(before), [T0 + 900_500]);
      }).pipe(Effect.scoped, Effect.provide(s.layer));
    }),
  );

  it.effect("a replaced wrap-up timer never fires", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      // the first checks see a wrap-up due at +15 min; once b leaves too, the next is due at +30 min
      const s = yield* setup({ due: [sec(T0) + 900, sec(T0) + 900, sec(T0) + 900, sec(T0) + 1800] });
      yield* Effect.gen(function* () {
        const { p } = yield* watching([
          { user_id: "a", channel_id: "room-a" },
          { user_id: "b", channel_id: "room-b" },
        ]);
        yield* p.update("a", null);
        yield* adjust("5 minutes");
        yield* p.update("b", null); // its check replaces the timer
        yield* flush;
        const before = (yield* Ref.get(s.checks)).length;
        yield* setTime(T0 + 1_000_000); // past the first timer's time
        const after = yield* Ref.get(s.checks);
        assert.isTrue(after.slice(before).every((t) => t >= T0 + 1_800_500), `checks at ${after.slice(before).map((t) => (t - T0) / 1000)}`);
        yield* setTime(T0 + 1_800_500);
        assert.deepStrictEqual((yield* Ref.get(s.checks)).slice(before), [T0 + 1_800_500]);
      }).pipe(Effect.scoped, Effect.provide(s.layer));
    }),
  );

  it.effect("the heartbeat runs every minute while anyone's in voice, and stops when nobody is", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const s = yield* setup();
      yield* Effect.gen(function* () {
        const { p } = yield* watching([{ user_id: "a", channel_id: "room-a" }]);
        const start = (yield* Ref.get(s.tracks)).length;
        yield* adjust("3 minutes");
        const beats = (yield* Ref.get(s.tracks)).slice(start);
        assert.isTrue(beats.length >= 3, `${beats.length} tracks in 3 minutes`);
        yield* p.update("a", null);
        yield* flush;
        const after = (yield* Ref.get(s.tracks)).length;
        yield* adjust("5 minutes");
        assert.strictEqual((yield* Ref.get(s.tracks)).length, after); // nobody's here: no beats
      }).pipe(Effect.scoped, Effect.provide(s.layer));
    }),
  );

  it.effect("only the players' moves are handled", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const s = yield* setup();
      yield* Effect.gen(function* () {
        const { p } = yield* watching([{ user_id: "x", channel_id: "room-x" }]);
        yield* p.update("x", null); // someone else on the server
        yield* adjust("1 second");
        assert.deepStrictEqual(yield* Ref.get(s.log), []);
      }).pipe(Effect.scoped, Effect.provide(s.layer));
    }),
  );

  it.effect("when the term ends, what's queued is still handled", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const s = yield* setup({ leaveTakes: (u) => (u === "a" ? Effect.sleep("2 seconds") : Effect.void) });
      yield* Effect.gen(function* () {
        const p = yield* Presence;
        const term = yield* Scope.make();
        yield* Live.use((l) => l.watch).pipe(Scope.provide(term));
        yield* p.snapshot([
          { user_id: "a", channel_id: "room-a" },
          { user_id: "b", channel_id: "room-b" },
        ]);
        yield* flush;
        yield* p.update("a", null); // takes 2 s
        yield* p.update("b", null); // queued behind it
        yield* flush;
        const ending = yield* Effect.forkChild(Scope.close(term, Exit.void));
        yield* adjust("5 seconds");
        yield* Fiber.join(ending);
        assert.deepStrictEqual(yield* Ref.get(s.log), ["leave a", "left a", "leave b", "left b"]);
      }).pipe(Effect.provide(s.layer));
    }),
  );
});
