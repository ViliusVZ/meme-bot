// 🔌 The bot's own place in voice, between our gateway (gateway.ts) and @discordjs/voice
// (voiceconn.ts). The library doesn't know our @discordjs/ws connection, so it asks an adapter to
// send its voice-state payloads (op 4: join, move, leave) and to hand it the bot's own
// VOICE_STATE_UPDATE and VOICE_SERVER_UPDATE. This is that adapter:
//   • the gateway attaches its sender for as long as a connection is up (`attach`, scoped), and
//     feeds the bot's own voice events in (`selfState`, `serverUpdate`)
//   • the library's payloads queue here and the attached gateway sends them in order; with no
//     gateway the adapter says so at once (the library then gives the join up)
//   • on every fresh snapshot (`snapshot`), a bot Discord still shows in a channel we aren't using
//     (a crash can leave a ghost connection) is taken out of it
// The library's callbacks are synchronous, so they only touch plain state and the queue.
import type { DiscordGatewayAdapterCreator, DiscordGatewayAdapterLibraryMethods } from "@discordjs/voice";
import { GatewayOpcodes, type GatewayVoiceServerUpdateDispatchData, type GatewayVoiceStateUpdate, type GatewayVoiceStateUpdateDispatchData } from "discord-api-types/v10";
import { Context, Duration, Effect, Layer, Queue, Ref, type Scope } from "effect";
import { AppConfig } from "./config.js";

/** Sends one payload on the gateway; fails quietly (the gateway logs its own trouble). */
export type Sender = (payload: GatewayVoiceStateUpdate) => Effect.Effect<void>;

const LEAVE_WAIT = Duration.seconds(2);

export const leavePayload = (guildId: string): GatewayVoiceStateUpdate => ({
  op: GatewayOpcodes.VoiceStateUpdate,
  d: { guild_id: guildId, channel_id: null, self_mute: false, self_deaf: false },
});

export class VoiceLink extends Context.Service<
  VoiceLink,
  {
    /** The gateway is up: send voice payloads through `send` until the scope closes. */
    attach(send: Sender): Effect.Effect<void, never, Scope.Scope>;
    /** READY: who the bot is. */
    setSelf(userId: string): Effect.Effect<void>;
    /** A VOICE_STATE_UPDATE (anyone's: only the bot's own is used). */
    selfState(d: GatewayVoiceStateUpdateDispatchData): Effect.Effect<void>;
    serverUpdate(d: GatewayVoiceServerUpdateDispatchData): Effect.Effect<void>;
    /** A fresh snapshot of the guild's voice states: a ghost of ours in a channel is taken out. */
    snapshot(voiceStates: ReadonlyArray<{ user_id: string; channel_id: string | null }>): Effect.Effect<void>;
    /** The channel Discord last showed the bot in (null: none). */
    readonly selfChannel: Effect.Effect<string | null>;
    /** Make sure the bot isn't in voice: if Discord shows it in a channel, leave (waits up to 2 s for the send). */
    readonly leave: Effect.Effect<void>;
    /** For @discordjs/voice: our gateway as its adapter. */
    readonly adapterCreator: DiscordGatewayAdapterCreator;
  }
>()("meme-bot/voicelink") {
  static readonly layer = Layer.effect(
    VoiceLink,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const outbound = yield* Queue.unbounded<GatewayVoiceStateUpdate>();
      const sender = yield* Ref.make<Sender | null>(null);
      // read by the library's synchronous callbacks
      const live = { attached: false, self: config.discordAppId, channel: null as string | null, library: null as DiscordGatewayAdapterLibraryMethods | null };

      const adapterCreator: DiscordGatewayAdapterCreator = (methods) => {
        live.library = methods;
        return {
          sendPayload: (payload: GatewayVoiceStateUpdate) => {
            if (!live.attached) return false;
            Queue.offerUnsafe(outbound, payload);
            return true;
          },
          destroy: () => {
            if (live.library === methods) live.library = null;
          },
        };
      };

      const sendNow = (payload: GatewayVoiceStateUpdate) =>
        Effect.flatMap(Ref.get(sender), (send) => (send ? send(payload) : Effect.void)).pipe(Effect.timeoutOption(LEAVE_WAIT), Effect.asVoid);

      return VoiceLink.of({
        attach: (send) =>
          Effect.gen(function* () {
            yield* Ref.set(sender, send);
            yield* Effect.sync(() => void (live.attached = true));
            yield* Effect.addFinalizer(() =>
              Effect.gen(function* () {
                yield* Ref.set(sender, null);
                yield* Effect.sync(() => {
                  live.attached = false;
                  // the gateway's gone: the library's connection can't be signalled any more
                  live.library?.destroy();
                  live.library = null;
                });
                // anything queued for a gateway that's gone is stale: the next one starts clean
                yield* Queue.clear(outbound);
              }),
            );
            yield* Effect.forkScoped(Effect.forever(Effect.flatMap(Queue.take(outbound), send)));
          }),
        setSelf: (userId) => Effect.sync(() => void (live.self = userId)),
        selfState: (d) =>
          Effect.sync(() => {
            if (d.user_id !== live.self) return;
            live.channel = d.channel_id;
            live.library?.onVoiceStateUpdate(d);
          }),
        serverUpdate: (d) => Effect.sync(() => live.library?.onVoiceServerUpdate(d)),
        snapshot: (voiceStates) =>
          Effect.gen(function* () {
            const mine = voiceStates.find((v) => v.user_id === live.self)?.channel_id ?? null;
            yield* Effect.sync(() => void (live.channel = mine));
            if (!mine || live.library) return;
            yield* Effect.logInfo(`voice: Discord shows me in ${mine} with no visit under way, leaving`);
            yield* sendNow(leavePayload(config.guildId));
          }),
        selfChannel: Effect.sync(() => live.channel),
        leave: Effect.gen(function* () {
          if (!live.channel) return;
          yield* Effect.logInfo(`voice: making sure I'm out of ${live.channel}`);
          yield* sendNow(leavePayload(config.guildId));
        }),
        adapterCreator,
      });
    }),
  );
}
