// Leadership: exactly one running copy owns the Discord gateway, the clock and live voice (blue and
// green overlap for a few seconds during a deploy; both serve clicks, only the leader runs timers).
// The lock is a session advisory lock on a connection of its own, so it's released the moment that
// copy stops or loses its connection (spike S2: a one-connection client in the term's scope).
import { PgClient } from "@effect/sql-pg";
import { Context, Duration, Effect, Exit, Layer, Ref, Schema, Scope } from "effect";
import { Reactivity } from "effect/reactivity";
import { AppConfig } from "./config.js";
import { DbOptions, int8AsNumber } from "./db/db.js";
import { Lifecycle } from "./lifecycle.js";
import { Live } from "./live.js";
import { Ticker } from "./scheduler.js";
import { Gateway } from "./gateway.js";

const LEADER_LOCK = 4_242_002;
const TRY_AGAIN = Duration.seconds(1); // someone else leads: ask again in a second
const PING = Duration.seconds(1); // a killed connection fails the next statement at once; nothing reports it without one
const PING_TIMEOUT = Duration.seconds(2); // a hung socket: a ping that doesn't come back is a lost lock too
const KEEPALIVE = Duration.seconds(10); // TCP keepalive on the lock's connection, so the OS notices a dead peer
const BETWEEN_TERMS = Duration.seconds(2);

/** The lock's connection stopped answering. */
export class LockLost extends Schema.TaggedError<LockLost>()("LockLost", { detail: Schema.String }) {}

export interface LeadOptions {
  /** One minute's jobs have been stuck this many minutes (main restarts the bot). */
  readonly onStall?: (mins: number) => Effect.Effect<void>;
}

export class Leadership extends Context.Service<
  Leadership,
  {
    /**
     * Lead whenever this copy can, until interrupted. A term: take the lock on a connection of its
     * own; inside it Live, the clock and the gateway (connecting in the background). The term ends
     * when the lock's connection is lost or this is interrupted; everything in it stops, then the
     * connection closes, which frees the lock. Then wait 2 s and try again.
     */
    lead(opts?: LeadOptions): Effect.Effect<never>;
  }
>()("meme-bot/leadership") {
  static readonly layer = Layer.effect(
    Leadership,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const options = yield* DbOptions;
      const lifecycle = yield* Lifecycle;
      const live = yield* Live;
      const ticker = yield* Ticker;
      const gateway = yield* Gateway;
      const reactivity = yield* Reactivity.Reactivity;

      /**
       * Everything a leader runs, until the scope closes. Each part has its own scope, so the term's end
       * goes in today's order: /health stops saying we lead, then the gateway closes (the other copy
       * can connect), then the clock and live voice stop together (a start under way finishes, what's
       * queued is handled).
       */
      const inTerm = (opts: LeadOptions): Effect.Effect<void, never, Scope.Scope> =>
        Effect.gen(function* () {
          yield* lifecycle.setLeader(true);
          yield* Effect.logInfo("leader: took over");
          const [voice, clock, gw] = [yield* Scope.make(), yield* Scope.make(), yield* Scope.make()];
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              yield* lifecycle.setLeader(false);
              yield* Scope.close(gw, Exit.void);
              yield* Effect.all([Scope.close(clock, Exit.void), Scope.close(voice, Exit.void)], { concurrency: 2, discard: true });
            }),
          );
          const watching = yield* live.watch.pipe(Scope.provide(voice));
          yield* Effect.forkIn(ticker.run({ onStall: opts.onStall }).pipe(Scope.provide(clock)), clock);
          // the gateway connects in the background, retrying with back-off (say, Discord is down); until
          // it's up, voice lookups fall back to REST and everything else carries on as normal
          yield* gateway.hold(watching.resync).pipe(Scope.provide(gw));
        });

      const term = (opts: LeadOptions) =>
        Effect.gen(function* () {
          const led = yield* Ref.make(false);
          yield* Effect.scoped(
            Effect.gen(function* () {
              const client = yield* PgClient.makeClient({
                url: config.databaseUrl,
                applicationName: config.appName,
                startupOptions: options.startupOptions,
                types: int8AsNumber(),
                keepAlive: KEEPALIVE,
              }).pipe(Effect.provideService(Reactivity.Reactivity, reactivity));
              for (;;) {
                const [row] = yield* client<{ ok: boolean }>`SELECT pg_try_advisory_lock(${LEADER_LOCK}) AS ok`;
                if (row?.ok) break;
                yield* Effect.sleep(TRY_AGAIN);
              }
              yield* Ref.set(led, true);
              // lead until the lock's connection is lost (a failing ping), or this is interrupted
              return yield* Effect.scoped(
                Effect.gen(function* () {
                  yield* inTerm(opts);
                  for (;;) {
                    yield* Effect.sleep(PING);
                    yield* client`SELECT 1`.pipe(Effect.timeoutOrElse({ duration: PING_TIMEOUT, orElse: () => Effect.fail(new LockLost({ detail: "the ping didn't come back in 2 s" })) }));
                  }
                }),
              );
            }),
          ).pipe(
            Effect.catch((e) => Effect.flatMap(Ref.get(led), (was) => Effect.logInfo(`leader lock: ${was ? "lost" : "retrying"} ${String(e)}`))),
            Effect.ensuring(Effect.flatMap(Ref.get(led), (was) => (was ? Effect.logInfo("leader: stepped down") : Effect.void))),
          );
        });

      return Leadership.of({
        lead: (opts = {}) => Effect.forever(Effect.andThen(term(opts), Effect.sleep(BETWEEN_TERMS))),
      });
    }),
  );
}
