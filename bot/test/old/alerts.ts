// The old functions of src/alerts.ts, for the tests until phase 6 makes them Effect-native
// (plan 05, phase 5 step 8: the transition left src; the tests change only their imports).
export * from "../../src/alerts.js";
import { run, runDetached, runSync } from "../../src/legacy.js";
import { Alerts } from "../../src/alerts.js";
import type { Env } from "../../src/env.js";

// the old functions, for the code that isn't on Effect yet
/** Turn DMs on (main.ts); without ALERT_USER_ID (the test bot, tests) failures are only logged. */
export const setup = (env: Env) => runSync(Alerts.use((a) => a.setOwner(env.ALERT_USER_ID)));
export const failed = (what: string, error: unknown, ...context: unknown[]) => runSync(Alerts.use((a) => a.failed(what, error, ...context)));
export const report = (what: string, error: unknown, context: unknown[] = []) => runSync(Alerts.use((a) => a.report(what, error, context)));
export const test = (env: Env, to?: string) =>
  run(env, Alerts.use((a) => a.test(to ?? env.ALERT_USER_ID))).catch((e: unknown) => {
    throw e instanceof Error && "_tag" in e ? new Error(e.message) : e; // today's error text
  });
export const watchGateway = (env: Env) => run(env, Alerts.use((a) => a.watchGateway));
/** Tests: wait for queued DMs. */
export const _settle = () => runDetached(Alerts.use((a) => a.settle));
/** Tests: forget throttles and the DM channel. */
export const _reset = () => runSync(Alerts.use((a) => a.reset));
