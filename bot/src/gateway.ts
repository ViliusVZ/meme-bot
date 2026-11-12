// The live connection to Discord (leader only). We only need voice: which channel each person is
// in, the moment it changes. @discordjs/ws handles heartbeats, reconnects and session resumes
// (a resume replays the events we missed, so the picture stays exact across short drops).
// Interactions still arrive over HTTP (app.ts), so clicks keep working even while this reconnects.
//
// A boundary file (architecture §16): @discordjs/ws is callback- and promise-based. Its callbacks
// only put events on a queue; one fiber handles them, in order, on the services.
import { REST } from "@discordjs/rest";
import { WebSocketManager, WebSocketShardEvents } from "@discordjs/ws";
import { GatewayDispatchEvents, GatewayIntentBits, type GatewayDispatchPayload } from "discord-api-types/v10";
import { Context, Duration, Effect, Fiber, Layer, Queue, Redacted, Ref, Schema, type Scope } from "effect";
import { AppConfig } from "./config.js";
import { Presence } from "./presence.js";
import { Channels, type Channel } from "./channels.js";
import { Alerts } from "./alerts.js";

const CONNECT_TIMEOUT = Duration.seconds(30);
const DISALLOWED_INTENTS = 4014;
const FIRST_RETRY = 2000; // ms, doubling each failed connect…
const LAST_RETRY = 60_000; // …up to a minute

/** What the gateway told us, in the order it told us. */
export type GatewayEvent =
  | { readonly _tag: "Dispatch"; readonly payload: GatewayDispatchPayload }
  | { readonly _tag: "Ready" }
  | { readonly _tag: "Resumed" }
  | { readonly _tag: "Closed"; readonly code: number }
  | { readonly _tag: "Error"; readonly message: string };

/** A connect that failed, timed out, or was refused. */
export class GatewayUnavailable extends Schema.TaggedError<GatewayUnavailable>()("GatewayUnavailable", { detail: Schema.String }) {}

/** One connection to Discord's gateway, as the library gives it: events out, connect, destroy. */
export interface Socket {
  readonly connect: Effect.Effect<void, GatewayUnavailable>;
  readonly destroy: Effect.Effect<void>;
}

/** Makes connections (@discordjs/ws in production; a fake in tests). */
export class GatewayClient extends Context.Service<
  GatewayClient,
  { open(intents: number, emit: (e: GatewayEvent) => void): Effect.Effect<Socket> }
>()("meme-bot/gateway/GatewayClient") {
  static readonly layer = Layer.effect(
    GatewayClient,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      return GatewayClient.of({
        open: (intents, emit) =>
          Effect.sync(() => {
            const token = Redacted.value(config.discordToken);
            const manager = new WebSocketManager({ token, intents, rest: new REST({ version: "10" }).setToken(token), shardCount: 1 });
            // the library's callbacks: each only queues what happened (§16)
            manager.on(WebSocketShardEvents.Dispatch, (payload: GatewayDispatchPayload) => emit({ _tag: "Dispatch", payload }));
            manager.on(WebSocketShardEvents.Ready, () => emit({ _tag: "Ready" }));
            manager.on(WebSocketShardEvents.Resumed, () => emit({ _tag: "Resumed" }));
            manager.on(WebSocketShardEvents.Closed, (code: number) => emit({ _tag: "Closed", code }));
            manager.on(WebSocketShardEvents.Error, (e: Error) => emit({ _tag: "Error", message: e.message }));
            return {
              connect: Effect.tryPromise({ try: () => Promise.resolve(manager.connect()), catch: (e) => new GatewayUnavailable({ detail: String(e) }) }),
              destroy: Effect.ignore(Effect.tryPromise(() => Promise.resolve(manager.destroy()))),
            };
          }),
      });
    }),
  );
}

export class Gateway extends Context.Service<
  Gateway,
  {
    /**
     * Hold the gateway for a leader's term: connect in the background, retrying with back-off (say,
     * Discord is down); until it's up, voice lookups fall back to REST and everything else carries
     * on. `onSnapshot` runs after each fresh snapshot of who's in voice. Closing the scope
     * disconnects (and stops trusting what we had).
     */
    hold(onSnapshot: Effect.Effect<void>): Effect.Effect<void, never, Scope.Scope>;
  }
>()("meme-bot/gateway") {
  static readonly layer = Layer.effect(
    Gateway,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const client = yield* GatewayClient;
      const presence = yield* Presence;
      const channels = yield* Channels;
      const alerts = yield* Alerts;
      // Discord refused the presence intent (it's off in the Developer Portal): from then on, connect without it
      const presencesRefused = yield* Ref.make(false);
      const ours = (d: { guild_id?: string }) => d.guild_id === config.guildId;

      const dispatch = (payload: GatewayDispatchPayload, onSnapshot: Effect.Effect<void>) =>
        Effect.gen(function* () {
          if (payload.t === GatewayDispatchEvents.GuildCreate && payload.d.id === config.guildId) {
            // during a Discord outage the guild arrives "unavailable", without voice states: that's
            // not "everyone left", so keep waiting for the real thing (lookups fall back to REST)
            if ((payload.d as { unavailable?: boolean }).unavailable) {
              yield* presence.invalidate;
              yield* channels.invalidate;
              return yield* Effect.logInfo("gateway: guild unavailable (Discord outage)");
            }
            // a fresh connection: the full picture of who's in voice right now, and of the channels
            yield* channels.snapshot((payload.d.channels ?? []) as Channel[]);
            yield* presence.snapshot(payload.d.voice_states ?? []);
            for (const p of payload.d.presences ?? []) yield* presence.setActivities(p.user.id, p.activities as { type: number; name: string }[]);
            yield* Effect.logInfo(`gateway: voice snapshot ${(payload.d.voice_states ?? []).length} in voice`);
            yield* onSnapshot;
          } else if ((payload.t === GatewayDispatchEvents.ChannelCreate || payload.t === GatewayDispatchEvents.ChannelUpdate) && "guild_id" in payload.d && ours(payload.d)) {
            yield* channels.upsert(payload.d as Channel);
          } else if (payload.t === GatewayDispatchEvents.ChannelDelete && "guild_id" in payload.d && ours(payload.d)) {
            yield* channels.remove(payload.d.id);
          } else if (payload.t === GatewayDispatchEvents.GuildDelete && payload.d.id === config.guildId) {
            yield* presence.invalidate; // outage (or we were removed): stop trusting what we had
            yield* channels.invalidate;
            yield* Effect.logInfo(`gateway: guild gone${payload.d.unavailable ? " (outage)" : ""}`);
          } else if (payload.t === GatewayDispatchEvents.VoiceStateUpdate && ours(payload.d)) {
            yield* presence.update(payload.d.user_id, payload.d.channel_id);
          } else if (payload.t === GatewayDispatchEvents.PresenceUpdate && ours(payload.d)) {
            yield* presence.setActivities(payload.d.user.id, payload.d.activities as { type: number; name: string }[]);
          }
        });

      const handle = (e: GatewayEvent, onSnapshot: Effect.Effect<void>) =>
        Effect.gen(function* () {
          switch (e._tag) {
            case "Dispatch":
              return yield* dispatch(e.payload, onSnapshot);
            case "Ready":
              return yield* Effect.logInfo("gateway: ready");
            case "Resumed":
              // the missed events were replayed in order, so what we had is still right
              yield* presence.revalidate;
              return yield* Effect.logInfo("gateway: resumed");
            case "Closed": {
              // until we resume (or get a new snapshot), fall back to asking Discord over REST
              yield* presence.invalidate;
              yield* Effect.logInfo(`gateway: closed ${e.code}`);
              if (e.code === DISALLOWED_INTENTS && config.presences && !(yield* Ref.get(presencesRefused))) {
                // the next connect goes without it: voice (and everything else) must not depend on it
                yield* Ref.set(presencesRefused, true);
                yield* alerts.failed("connecting with the presence intent", "Discord refused it (4014): turn on Presence Intent in the Developer Portal. Carrying on without game detection.");
              }
              return;
            }
            case "Error":
              return yield* Effect.logInfo(`gateway: error ${e.message}`);
          }
        });

      /** One connection, held until the scope closes: connected within 30 s, or torn down and failed. */
      const session = (onSnapshot: Effect.Effect<void>) =>
        Effect.gen(function* () {
          const intents =
            GatewayIntentBits.Guilds | GatewayIntentBits.GuildVoiceStates | (config.presences && !(yield* Ref.get(presencesRefused)) ? GatewayIntentBits.GuildPresences : 0);
          const events = yield* Queue.unbounded<GatewayEvent>();
          yield* Effect.forkScoped(Effect.forever(Effect.flatMap(Queue.take(events), (e) => handle(e, onSnapshot))));
          const socket = yield* Effect.acquireRelease(
            client.open(intents, (e) => void Queue.offerUnsafe(events, e)),
            (s) => Effect.andThen(Effect.andThen(presence.invalidate, channels.invalidate), s.destroy),
          );
          // the library waits for READY with no limit of its own (it keeps retrying inside), so bound it
          yield* socket.connect.pipe(Effect.timeoutOrElse({ duration: CONNECT_TIMEOUT, orElse: () => Effect.fail(new GatewayUnavailable({ detail: "Error: gateway connect timed out" })) }));
        });

      const hold = (onSnapshot: Effect.Effect<void>) =>
        Effect.asVoid(
          Effect.forkScoped(
            Effect.gen(function* () {
              for (let attempt = 0; ; attempt++) {
                const wait = Math.min(LAST_RETRY, FIRST_RETRY * 2 ** attempt);
                // each attempt in its own scope: a failed one is torn down at once; a good one is held
                // until the term ends (it never returns)
                yield* Effect.andThen(session(onSnapshot), Effect.never).pipe(
                  Effect.scoped,
                  Effect.catch((e) => Effect.logInfo(`gateway: connect failed, retrying in ${wait / 1000} s ${e.detail}`)),
                );
                yield* Effect.sleep(Duration.millis(wait));
              }
            }),
          ),
        );

      return Gateway.of({ hold });
    }),
  );
}
