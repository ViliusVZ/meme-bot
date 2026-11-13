// The app's services, as one layer. main.ts runs it with the real configuration; tests with theirs.
import { Effect, Layer, Logger } from "effect";
import { Otlp } from "effect/observability";
import { Reactivity } from "effect/reactivity";
import type { PgClient } from "@effect/sql-pg";
import type { SqlClient } from "effect/sql";
import { AppConfig, type AppConfigShape } from "./config.js";
import { Db, DbOptions } from "./db/db.js";
import { FetchHttpClient, HttpClient } from "effect/http";
import { Channels } from "./channels.js";
import { Discord } from "./discord.js";
import { Alerts } from "./alerts.js";
import { Background } from "./background.js";
import { Presence } from "./presence.js";
import { Lifecycle } from "./lifecycle.js";
import { LocalTime } from "./localtime.js";
import { Games } from "./games.js";
import { Nights } from "./nights.js";
import { Memes } from "./memes.js";
import { Roasts } from "./roasts.js";
import { Panels } from "./panels.js";
import { Gemini } from "./gemini.js";
import { Snoozes } from "./snooze.js";
import { Voice } from "./voice.js";
import { Attendances } from "./attendance.js";
import { Reddit } from "./reddit.js";
import { News } from "./news.js";
import { RedditNews } from "./newsfeeds.js";
import { Spontaneous } from "./spontaneous.js";
import { GameNight } from "./gamenight.js";
import { LateSlips } from "./late.js";
import { Interactions } from "./interactions.js";
import { Jobs } from "./jobs.js";
import { MemeShame } from "./memeshame.js";
import { Cleanup } from "./cleanup.js";
import { Hub } from "./hub.js";
import { Activity } from "./activity.js";
import { Polls } from "./polls.js";
import { Ticker } from "./scheduler.js";
import { Live } from "./live.js";
import { Gateway, GatewayClient } from "./gateway.js";
import { Leadership } from "./leadership.js";
import * as NodeWS from "@effect/platform-node/NodeWS";
import { Tts } from "./tts.js";
import { Clips } from "./clips.js";
import { VoiceLink } from "./voicelink.js";
import { VoiceConnector } from "./voiceconn.js";
import { BotVoice } from "./botvoice.js";

/** Every service the app provides (grows as modules move to Effect). */
export type AppServices = AppConfig | Db | PgClient.PgClient | SqlClient.SqlClient | Reactivity.Reactivity | HttpClient.HttpClient | Channels | Discord | Presence | Lifecycle | Alerts | Background
  | LocalTime | Games | Nights | Memes | Roasts | Panels | Gemini
  | RedditNews
  | Tts | Clips | VoiceLink | VoiceConnector | BotVoice
  | Snoozes | Voice | Attendances | Reddit | News | Spontaneous | GameNight | LateSlips | Polls | Activity | Hub | Cleanup | MemeShame | Jobs | Interactions | Ticker | Live | Gateway | GatewayClient | Leadership;

/** What a test changes about the app's layer (its throwaway schema). */
export interface LayerOptions {
  readonly db?: { readonly startupOptions?: string };
  /** Outbound HTTP (Discord, Reddit, the Blizzard feed, Gemini): fetch, unless a test gives its own. */
  readonly http?: Layer.Layer<HttpClient.HttpClient>;
  /** Joining voice (@discordjs/voice), unless a test gives a fake. */
  readonly voice?: Layer.Layer<VoiceConnector, never, VoiceLink | AppConfig>;
  /** Speech synthesis (the Edge endpoint), unless a test gives a fake. */
  readonly tts?: Layer.Layer<Tts, never, AppConfig | Db | HttpClient.HttpClient>;
}

/**
 * Logs: one line per entry on stdout (journald keeps them; `ssh vps app-logs` reads them), as
 * logfmt: `level=INFO message="leader: took over" key=value…` (spike S10). Each message is one
 * string, so the phrases the owner greps for stay whole.
 */
export const LoggerLive = Logger.layer([Logger.consoleLogFmt]);


/** Our trace ids are no business of Discord's, Reddit's or Google's: no traceparent header outbound. */
const NoTracePropagation = Layer.succeed(HttpClient.TracerPropagationEnabled, false);

/** An interaction's webhook URL carries its token (valid 15 minutes): those calls get no span, so no export can hold one. */
const NoWebhookSpans = Layer.succeed(HttpClient.TracerDisabledWhen, (request) => request.url.includes("/webhooks/"));

/**
 * Logs, metrics and spans exported over OTLP, only when OTLP_URL is set (architecture §14); the
 * log lines still go to stdout as well.
 */
export const OtlpLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* AppConfig;
    if (config.otlpUrl === undefined) return Layer.empty;
    return Otlp.layerJson({ baseUrl: config.otlpUrl, resource: { serviceName: config.appName, serviceVersion: config.revision }, loggerMergeWithExisting: true });
  }),
);

/** Everything the app runs on, given where its configuration comes from. */
export const appLayer = <E>(config: Layer.Layer<AppConfig, E>, options: LayerOptions = {}) =>
  // bottom to top (architecture.md §4): each line may use only the lines below it
  Layer.mergeAll(Leadership.layer).pipe(
    Layer.provideMerge(Layer.mergeAll(Interactions.layer, Ticker.layer, Live.layer, Gateway.layer)),
    Layer.provideMerge(Layer.mergeAll(Jobs.layer)),
    Layer.provideMerge(Layer.mergeAll(LateSlips.layer)),
    Layer.provideMerge(Layer.mergeAll(GameNight.layer, Activity.layer)),
    Layer.provideMerge(Layer.mergeAll(Attendances.layer, Spontaneous.layer, Hub.layer)),
    Layer.provideMerge(Layer.mergeAll(Snoozes.layer, MemeShame.layer, Cleanup.layer, BotVoice.layer, Polls.layer, Voice.layer, Reddit.layer, News.layer)),
    Layer.provideMerge(RedditNews.layer),
    Layer.provideMerge(Layer.mergeAll(Games.layer, Nights.layer, Memes.layer, Roasts.layer, Panels.layer, Gemini.layer, Clips.layer)),
    Layer.provideMerge(Layer.mergeAll(Background.layer, LocalTime.layer, options.tts ?? Tts.layer)),
    Layer.provideMerge(Alerts.layer),
    Layer.provideMerge(Layer.mergeAll(Db.layer, Discord.layer, GatewayClient.layer, options.voice ?? VoiceConnector.layer)),
    Layer.provideMerge(VoiceLink.layer),
    Layer.provideMerge(OtlpLive),
    Layer.provideMerge(
      Layer.mergeAll(
        config,
        Reactivity.layer,
        Layer.succeed(DbOptions, options.db ?? {}),
        Channels.layer,
        Presence.layer,
        Lifecycle.layer,
        options.http ?? FetchHttpClient.layer,
        NodeWS.layerWebSocketConstructor,
        NoTracePropagation,
        NoWebhookSpans,
      ),
    ),
    Layer.provideMerge(LoggerLive),
  );

/** The app's layer for a configuration already read (tests). */
export const appLayerFor = (config: AppConfigShape, options: LayerOptions = {}) => appLayer(Layer.succeed(AppConfig, config), options);
