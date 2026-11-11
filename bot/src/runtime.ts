// The app's services, as one layer. main.ts runs it with the real configuration; tests with theirs.
import { Layer, Logger, ManagedRuntime } from "effect";
import { Reactivity } from "effect/reactivity";
import type { PgClient } from "@effect/sql-pg";
import type { SqlClient } from "effect/sql";
import { AppConfig, type AppConfigShape } from "./config.js";
import { Db, DbOptions } from "./db/db.js";

/** Every service the app provides (grows as modules move to Effect). */
export type AppServices = AppConfig | Db | PgClient.PgClient | SqlClient.SqlClient | Reactivity.Reactivity;

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

/** Everything the app runs on, given where its configuration comes from. */
export const appLayer = <E>(config: Layer.Layer<AppConfig, E>, options: LayerOptions = {}) =>
  Db.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(config, Reactivity.layer, Layer.succeed(DbOptions, options.db ?? {}))),
    Layer.provideMerge(LoggerLive),
  );

/** The app's layer for a configuration already read (tests). */
export const appLayerFor = (config: AppConfigShape, options: LayerOptions = {}) => appLayer(Layer.succeed(AppConfig, config), options);

/** One runtime for the transition: promise code reaches the services through it (legacy.ts). */
export const makeRuntime = (config: AppConfigShape, options: LayerOptions = {}) => ManagedRuntime.make(appLayerFor(config, options)); // LEGACY-BRIDGE
