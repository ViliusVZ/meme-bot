// The transition's runtime for the tests (plan 05, phase 5 step 8: it left src), until phase 6 makes
// the harness layers.
import { Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/http";
import type { AppConfigShape } from "../../src/config.js";
import { appLayerFor, type LayerOptions } from "../../src/runtime.js";
export * from "../../src/runtime.js";

/**
 * Outbound HTTP through whatever global fetch is in place at each request (not captured once), so
 * the tests' fetch stub and its recorder see the Effect client's requests, until phase 6 gives the
 * tests a fake client.
 */
const HttpLive = FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, ((input, init) => globalThis.fetch(input, init)) as typeof globalThis.fetch)));

/** One runtime per test file: promise code reaches the services through it (legacy.ts). */
export const makeRuntime = (config: AppConfigShape, options: LayerOptions = {}) => ManagedRuntime.make(appLayerFor(config, { http: HttpLive, ...options }));
