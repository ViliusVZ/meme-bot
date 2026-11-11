// The app's services, as one layer. main.ts runs it with the real configuration; tests with theirs.
import { Layer, ManagedRuntime } from "effect";
import { AppConfig, type AppConfigShape } from "./config.js";

/** Every service the app provides (grows as modules move to Effect). */
export type AppServices = AppConfig;

/** Everything the app runs on, given where its configuration comes from. */
export const appLayer = <E>(config: Layer.Layer<AppConfig, E>) => config;

/** The app's layer for a configuration already read (tests, and main.ts after reading it). */
export const appLayerFor = (config: AppConfigShape) => appLayer(Layer.succeed(AppConfig, config));

/** One runtime for the transition: promise code reaches the services through it (legacy.ts). */
export const makeRuntime = (config: AppConfigShape) => ManagedRuntime.make(appLayerFor(config)); // LEGACY-BRIDGE
