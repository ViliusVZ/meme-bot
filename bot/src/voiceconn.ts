// 🔊 Joining a voice channel and playing clips, through @discordjs/voice (0.19, with Discord's
// end-to-end encryption, DAVE, from @snazzah/davey; transport encryption on Node's own AES-GCM).
// The library signals over our own gateway (voicelink.ts). Its events are wrapped one at a time
// (Effect.callback), so nothing here is a promise; tests replace the whole connector with a fake.
//
// Clips are WebM Opus (Edge, the jingles) or Ogg Opus (Gemini, opusogg.ts): played as they are
// through the library's demuxers, no ffmpeg anywhere.
import { Readable } from "node:stream";
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  joinVoiceChannel,
  type AudioPlayerState,
  type VoiceConnectionState,
} from "@discordjs/voice";
import { Context, Effect, Layer, Schema } from "effect";
import { AppConfig } from "./config.js";
import { VoiceLink } from "./voicelink.js";
import { isOgg } from "./opusogg.js";

/** A join, a connection or a playback that went wrong. */
export class VoiceFailed extends Schema.TaggedError<VoiceFailed>()("VoiceFailed", { detail: Schema.String }) {
  override get message() {
    return this.detail;
  }
}

/** One visit's connection. */
export interface VoiceConnection {
  /** Done once the connection is ready to play (fails if it's torn down first). */
  readonly ready: Effect.Effect<void, VoiceFailed>;
  /** Play one clip (WebM Opus) to its end. */
  play(clip: Uint8Array): Effect.Effect<void, VoiceFailed>;
  /** Stop and leave the channel. Never fails; safe to call twice. */
  readonly leave: Effect.Effect<void>;
}

export class VoiceConnector extends Context.Service<VoiceConnector, { join(channelId: string): Effect.Effect<VoiceConnection, VoiceFailed> }>()("meme-bot/voiceconn/VoiceConnector") {
  static readonly layer = Layer.effect(
    VoiceConnector,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const link = yield* VoiceLink;
      return VoiceConnector.of({
        join: (channelId) =>
          Effect.try({
            catch: (e) => new VoiceFailed({ detail: `join: ${String(e)}` }),
            try: () => {
              const conn = joinVoiceChannel({ channelId, guildId: config.guildId, adapterCreator: link.adapterCreator, selfDeaf: true, selfMute: false });
              // the library's own errors arrive as events; unheard, an "error" event would crash the process
              conn.on("error", () => {});
              const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
              player.on("error", () => {});
              conn.subscribe(player);
              const ready = Effect.callback<void, VoiceFailed>((resume) => {
                const check = (s: VoiceConnectionState) => {
                  if (s.status === VoiceConnectionStatus.Ready) resume(Effect.void);
                  else if (s.status === VoiceConnectionStatus.Destroyed) resume(Effect.fail(new VoiceFailed({ detail: "the connection was torn down" })));
                };
                const on = (_: VoiceConnectionState, s: VoiceConnectionState) => check(s);
                conn.on("stateChange", on);
                check(conn.state);
                return Effect.sync(() => void conn.off("stateChange", on));
              });
              const play = (clip: Uint8Array) =>
                Effect.callback<void, VoiceFailed>((resume) => {
                  const resource = createAudioResource(Readable.from([Buffer.from(clip)]), { inputType: isOgg(clip) ? StreamType.OggOpus : StreamType.WebmOpus });
                  const onState = (_: AudioPlayerState, s: AudioPlayerState) => {
                    if (s.status === AudioPlayerStatus.Idle) resume(Effect.void);
                  };
                  const onError = (e: Error) => resume(Effect.fail(new VoiceFailed({ detail: `playback: ${e.message}` })));
                  player.on("stateChange", onState);
                  player.on("error", onError);
                  player.play(resource);
                  return Effect.sync(() => {
                    player.off("stateChange", onState);
                    player.off("error", onError);
                  });
                });
              const leave = Effect.sync(() => {
                player.stop(true);
                if (conn.state.status !== VoiceConnectionStatus.Destroyed) conn.destroy();
              });
              return { ready, play, leave } satisfies VoiceConnection;
            },
          }),
      });
    }),
  );
}
