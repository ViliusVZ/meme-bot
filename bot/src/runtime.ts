// The app's services, as one layer. main.ts runs it with the real configuration; tests with theirs.
import { Layer, Logger, ManagedRuntime } from "effect";
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

/** Every service the app provides (grows as modules move to Effect). */
export type AppServices = AppConfig | Db | PgClient.PgClient | SqlClient.SqlClient | Reactivity.Reactivity | HttpClient.HttpClient | Channels | Discord | Presence | Lifecycle | Alerts | Background
  | LocalTime | Games | Nights | Memes | Roasts | Panels | Gemini
  | Snoozes | Voice | Attendances | Reddit | Spontaneous | GameNight | LateSlips | Polls | Activity | Hub | Cleanup | MemeShame | Jobs | Interactions;

/** What a test changes about the app's layer (its throwaway schema). */
export interface LayerOptions {
  readonly db?: { readonly startupOptions?: string };
}

/**
 * Logs: one line per entry on stdout (journald keeps them; `ssh vps app-logs` reads them), as
 * logfmt: `level=INFO message="leader: took over" key=value…` (spike S10). Each message is one
 * string, so the phrases the owner greps for stay whole.
 */
export const LoggerLive = Logger.layer([Logger.consoleLogFmt]);

/**
 * Outbound HTTP (Discord, Reddit, the Blizzard feed, Gemini). Fetch is read from the global on every
 * request, not captured once (FetchHttpClient's default, spike S5), so the tests' global fetch stub
 * and its recorder see the Effect client's requests too, until phase 6 gives the tests a fake client.
 */
const HttpLive = FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, ((input, init) => globalThis.fetch(input, init)) as typeof globalThis.fetch))); // LEGACY-BRIDGE

/** Our trace ids are no business of Discord's, Reddit's or Google's: no traceparent header outbound. */
const NoTracePropagation = Layer.succeed(HttpClient.TracerPropagationEnabled, false);

/** Everything the app runs on, given where its configuration comes from. */
export const appLayer = <E>(config: Layer.Layer<AppConfig, E>, options: LayerOptions = {}) =>
  // bottom to top (architecture.md §4): each line may use only the lines below it
  Layer.mergeAll(Interactions.layer).pipe(
    Layer.provideMerge(Layer.mergeAll(Jobs.layer)),
    Layer.provideMerge(Layer.mergeAll(LateSlips.layer)),
    Layer.provideMerge(Layer.mergeAll(GameNight.layer, Activity.layer)),
    Layer.provideMerge(Layer.mergeAll(Attendances.layer, Spontaneous.layer)),
    Layer.provideMerge(Layer.mergeAll(Snoozes.layer, MemeShame.layer, Cleanup.layer, Hub.layer, Polls.layer, Voice.layer, Reddit.layer)),
    Layer.provideMerge(Layer.mergeAll(Games.layer, Nights.layer, Memes.layer, Roasts.layer, Panels.layer, Gemini.layer)),
    Layer.provideMerge(Layer.mergeAll(Background.layer, LocalTime.layer)),
    Layer.provideMerge(Alerts.layer),
    Layer.provideMerge(Layer.mergeAll(Db.layer, Discord.layer)),
    Layer.provideMerge(
      Layer.mergeAll(config, Reactivity.layer, Layer.succeed(DbOptions, options.db ?? {}), Channels.layer, Presence.layer, Lifecycle.layer, HttpLive, NoTracePropagation),
    ),
    Layer.provideMerge(LoggerLive),
  );

/** The app's layer for a configuration already read (tests). */
export const appLayerFor = (config: AppConfigShape, options: LayerOptions = {}) => appLayer(Layer.succeed(AppConfig, config), options);

/** One runtime for the transition: promise code reaches the services through it (legacy.ts). */
export const makeRuntime = (config: AppConfigShape, options: LayerOptions = {}) => ManagedRuntime.make(appLayerFor(config, options)); // LEGACY-BRIDGE
