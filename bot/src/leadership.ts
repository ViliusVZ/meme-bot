// Leadership: exactly one running copy owns the Discord gateway, the clock and live voice (blue and
// green overlap for a few seconds during a deploy; both serve clicks, only the leader runs timers).
// The lock is a session advisory lock on a connection of its own, so it's released the moment that
// copy stops or loses its connection (spike S2: a one-connection client in the term's scope).
import { PgClient } from "@effect/sql-pg";
import { Context, Duration, Effect, Layer, Ref, type Scope } from "effect";
import { Reactivity } from "effect/reactivity";
import { AppConfig } from "./config.js";
import { DbOptions, int8AsNumber } from "./db/db.js";
import { Lifecycle } from "./lifecycle.js";
import { Live } from "./live.js";
import { Ticker } from "./scheduler.js";
import { Gateway } from "./gateway.js";

const LEADER_LOCK = 4_242_002;
const TRY_AGAIN = Duration.seconds(1); // someone else leads: ask again in a second
const PING = Duration.seconds(5); // a killed connection fails the next statement at once; nothing reports it without one
const BETWEEN_TERMS = Duration.seconds(2);

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

      /** Everything a leader runs, until the scope closes: the order of shutdown is the reverse. */
      const inTerm = (opts: LeadOptions): Effect.Effect<void, never, Scope.Scope> =>
        Effect.gen(function* () {
          yield* lifecycle.setLeader(true);
          yield* Effect.logInfo("leader: took over");
          const watching = yield* live.watch;
          yield* Effect.forkScoped(ticker.run({ onStall: opts.onStall }));
          // the gateway connects in the background, retrying with back-off (say, Discord is down); until
          // it's up, voice lookups fall back to REST and everything else carries on as normal
          yield* gateway.hold(watching.resync);
          // first thing at the term's end: /health stops saying we lead
          yield* Effect.addFinalizer(() => lifecycle.setLeader(false));
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
                    yield* client`SELECT 1`;
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
