// The leader's clock: the minute jobs at the top of every minute, and an exact timer for each game
// night about to start (room opens 10 s early, moves and ping on the second).
import { Cause, Clock, Context, Duration, Effect, Fiber, FiberMap, Layer, Ref, type Scope } from "effect";
import { Jobs } from "./jobs.js";
import { GameNight } from "./gamenight.js";
import { Alerts } from "./alerts.js";

const LOOKAHEAD = 120; // seconds: nights starting this soon get their own timer
const STALL = 5 * 60_000; // one minute's jobs running this long are stuck (every call has a timeout, so it's a bug)
const WATCH_EVERY = Duration.seconds(30);
const HOLD_KEY = Duration.minutes(5); // a start's key stays taken this long after it, so it isn't armed twice
const PAST_THE_MINUTE = 50; // ms: wake just past the top of the minute

export interface TickerOptions {
  /** One minute's jobs have been stuck this many minutes; everything after them waits meanwhile. */
  readonly onStall?: (mins: number) => Effect.Effect<void>;
  readonly minute?: Effect.Effect<Record<string, unknown>>;
}

/**
 * The clock's own net (architecture §6: the ticker, per minute and per start timer, as today's
 * `.catch`): a failure is reported and the clock goes on. Being stopped isn't a failure.
 */
const reported = (alerts: Alerts["Service"], what: string, ...context: string[]) => <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.catchCause(Effect.asVoid(effect), (cause) => (Cause.hasInterruptsOnly(cause) ? Effect.interrupt : alerts.failed(what, Cause.squash(cause), ...context)));

/** A job result worth a log line: it did something or failed (not skipped, not "already posted"). */
function isBusy(v: unknown) {
  if (!v || typeof v !== "object" || !Object.keys(v).length) return false;
  return !("skipped" in v) && (v as { started?: boolean }).started !== false;
}

export class Ticker extends Context.Service<
  Ticker,
  {
    /** Seconds since this copy's clock last finished a minute; null when it isn't running one (a follower). */
    readonly sinceTick: Effect.Effect<number | null>;
    /**
     * The clock for a leader's term: catch up at once (a restart may have skipped a minute), then
     * every minute, never early and never overlapping; start timers for nights about to start.
     * Runs until its scope closes: start timers still sleeping stand down (the next leader arms its
     * own); a start already under way finishes first.
     */
    run(opts?: TickerOptions): Effect.Effect<never, never, Scope.Scope>;
  }
>()("meme-bot/scheduler/Ticker") {
  static readonly layer = Layer.effect(
    Ticker,
    Effect.gen(function* () {
      const jobs = yield* Jobs;
      const gameNight = yield* GameNight;
      const alerts = yield* Alerts;
      const lastTick = yield* Ref.make<number | null>(null); // when the clock last finished a minute (null: it has none)

      const run = (opts: TickerOptions = {}) =>
        Effect.gen(function* () {
          const minute = opts.minute ?? jobs.minute;
          yield* Ref.set(lastTick, yield* Clock.currentTimeMillis);
          yield* Effect.addFinalizer(() => Ref.set(lastTick, null));
          const tickStarted = yield* Ref.make<number | null>(null);
          const starts = yield* FiberMap.make<string>(); // `${day}@${start_at}` → its start timer

          const armStarts = Effect.gen(function* () {
            const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
            for (const n of yield* gameNight.upcomingStarts(now + LOOKAHEAD)) {
              yield* FiberMap.run(
                starts,
                `${n.day}@${n.start_at}`,
                gameNight.startOnTime(n).pipe(
                  Effect.tap((ok) => (ok ? Effect.logInfo(`started on time ${n.day} ${n.game}`) : Effect.void)),
                  reported(alerts, "starting the game night on time", n.day),
                  Effect.andThen(Effect.sleep(HOLD_KEY)),
                ),
                { onlyIfMissing: true },
              );
            }
          });

          const tick = Effect.gen(function* () {
            const t0 = yield* Clock.currentTimeMillis;
            yield* Ref.set(tickStarted, t0);
            yield* armStarts.pipe(Effect.catch((e) => alerts.failed("lining up the exact start", e)));
            const out = yield* minute;
            const ms = (yield* Clock.currentTimeMillis) - t0;
            // quiet minutes aren't worth a log line; anything that did something (or failed) is
            const busy = Object.entries(out).filter(([, v]) => isBusy(v));
            if (busy.length || ms > 5000) yield* Effect.logInfo(`minute ${ms} ms ${JSON.stringify(Object.fromEntries(busy))}`);
          }).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                yield* Ref.set(tickStarted, null);
                yield* Ref.set(lastTick, yield* Clock.currentTimeMillis);
              }),
            ),
          );

          // a stuck minute holds up every minute after it, silently: say so once, and let the owner act
          yield* Effect.forkScoped(
            Effect.gen(function* () {
              let stalled = false;
              for (;;) {
                yield* Effect.sleep(WATCH_EVERY);
                const started = yield* Ref.get(tickStarted);
                const now = yield* Clock.currentTimeMillis;
                if (started === null || stalled || now - started < STALL) continue;
                stalled = true;
                yield* opts.onStall?.(Math.round((now - started) / 60_000)) ?? Effect.void;
              }
            }),
          );

          for (;;) {
            yield* tick.pipe(reported(alerts, "the minute jobs"));
            const now = yield* Clock.currentTimeMillis;
            yield* Effect.sleep(Duration.millis(60_000 - (now % 60_000) + PAST_THE_MINUTE)); // just past the top of the next minute
          }
        });

      return Ticker.of({
        sinceTick: Effect.gen(function* () {
          const last = yield* Ref.get(lastTick);
          return last === null ? null : Math.round(((yield* Clock.currentTimeMillis) - last) / 1000);
        }),
        run,
      });
    }),
  );
}
