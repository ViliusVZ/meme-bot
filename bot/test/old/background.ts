// The old functions of src/background.ts, for the tests until phase 6 makes them Effect-native
// (plan 05, phase 5 step 8: the transition left src; the tests change only their imports).
export * from "../../src/background.js";
import { runDetached, runSync } from "../../src/legacy.js";
import { Background } from "../../src/background.js";
import { Duration, Effect } from "effect";

// the old functions, for the code that isn't on Effect yet
/** Run `p` in the background; failures are logged with `label`, never thrown. */
export function defer(p: Promise<unknown>, label = "background work") {
  runSync(Background.use((b) => b.run(Effect.promise(() => p), label)));
}
/** Wait for in-flight background work, up to `ms`. */
export const drain = (ms: number) => runDetached(Background.use((b) => b.drain(Duration.millis(ms))));
export const inFlight = () => runSync(Background.use((b) => b.inFlight));
