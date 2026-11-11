// The app's services, as one layer. main.ts runs it with the real configuration; tests with theirs.
import { Layer, Logger, ManagedRuntime } from "effect";
import { AppConfig, type AppConfigShape } from "./config.js";

/** Every service the app provides (grows as modules move to Effect). */
export type AppServices = AppConfig;

/**
 * Logs: one line per entry on stdout (journald keeps them; `ssh vps app-logs` reads them), as
 * logfmt: `level=INFO message="leader: took over" key=value…` (spike S10). Each message is one
 * string, so the phrases the owner greps for stay whole.
 */
export const LoggerLive = Logger.layer([Logger.consoleLogFmt]);

/** Everything the app runs on, given where its configuration comes from. */
export const appLayer = <E>(config: Layer.Layer<AppConfig, E>) => Layer.mergeAll(config, LoggerLive);

/** The app's layer for a configuration already read (tests, and main.ts after reading it). */
export const appLayerFor = (config: AppConfigShape) => appLayer(Layer.succeed(AppConfig, config));

/** One runtime for the transition: promise code reaches the services through it (legacy.ts). */
export const makeRuntime = (config: AppConfigShape) => ManagedRuntime.make(appLayerFor(config)); // LEGACY-BRIDGE
