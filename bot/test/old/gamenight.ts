// The old functions of src/gamenight.ts, for the tests until phase 6 makes them Effect-native
// (plan 05, phase 5 step 8: the transition left src; the tests change only their imports).
export * from "../../src/gamenight.js";
// moved out to break import cycles (plan 05); still offered from here to the tests
export { players } from "../../src/env.js";
export { local, pollHour, wallToUnix, weekday } from "./localtime.js";
export { getNight, isOver } from "./nights.js";
export { addGame, emojiFor, gameLabel, games, removeGame } from "./games.js";
import { run } from "../../src/legacy.js";
import { Outcome, StartResult, When, deadlineFor, parseTimeFor, timeOptionsFor } from "../../src/gamenight.js";
import type { Env } from "../../src/env.js";

type Defer = (p: Promise<unknown>) => void;
import { Effect } from "effect";
import { Mine } from "../../src/panels.js";
import { Night } from "../../src/nights.js";
import { Votes, actOn, bailOn, closeStaleCards, dueRoastsNow, leaveBy, maintainAll, openNight, planPickerCard, postRoastOf, refreshCard, refreshCards, renderCard, retryCards, startAt, startsDue, syncCopies, upcoming, wipeNight } from "../../src/gamenight.js";

const nowSec = () => Math.floor(Date.now() / 1000);
const W = (env: Env): When => ({ zone: env.TIMEZONE, now: nowSec() });
export const timeOptions = (env: Env, n: Night, v: Votes) => timeOptionsFor(W(env), n, v);
export const parseTime = (env: Env, raw: string, day?: string) => parseTimeFor(W(env), raw, day);
export const voteDeadline = (env: Env, n: Pick<Night, "day" | "stage_at"> & Partial<Pick<Night, "stage" | "maybes">>) => deadlineFor(W(env), n);
/** Discord's typed errors turned back into today's error text, for the promise code that reads it. */
const asOld = (e: unknown) => {
  throw e instanceof Error && "_tag" in e && String(e._tag).startsWith("Discord") ? new Error(e.message) : e;
};
export const startNight = (env: Env, by?: string, anyHour = false, forDay?: string): Promise<StartResult | { skipped: string }> =>
  run(env, openNight(by, anyHour, forDay)).catch(asOld);
export const retryUnposted = (env: Env) => run(env, retryCards).catch(asOld);
export const refreshOpen = (env: Env) => run(env, refreshCards).catch(asOld);
export const closeStale = (env: Env) => run(env, closeStaleCards).catch(asOld);
export const refresh = (env: Env, day: string, mine?: Mine) => run(env, refreshCard(day, mine)).catch(asOld);
export const syncPanels = (env: Env, day: string, mine?: Mine) => run(env, syncCopies(day, mine));
export const act = (env: Env, day: string, user: string, action: string, value: string | undefined, defer: Defer): Promise<Outcome> =>
  run(env, actOn(day, user, action, value, (e) => Effect.sync(() => defer(run(env, e).catch(asOld))))).catch(asOld);
export const bailFromSlip = (env: Env, day: string, user: string) => run(env, bailOn(day, user)).catch(asOld);
export const postRoast = (env: Env, day: string) => run(env, postRoastOf(day)).catch(asOld);
export const dueRoasts = (env: Env) => run(env, dueRoastsNow).catch(asOld);
export const maintain = (env: Env) => run(env, maintainAll).catch(asOld);
export const upcomingStarts = (env: Env, until: number) => run(env, upcoming(until));
export const preciseStarts = (env: Env, until: number) => run(env, startsDue(until));
/** The old signal, as something to wait on. */
const aborted = (signal?: AbortSignal): Effect.Effect<void> =>
  signal ? Effect.callback<void>((resume) => (signal.aborted ? resume(Effect.void) : signal.addEventListener("abort", () => resume(Effect.void), { once: true }))) : Effect.never;
export const startOnTime = (env: Env, n: Night, signal?: AbortSignal) => run(env, startAt(n, aborted(signal)));
export const render = (env: Env, day: string, viewer?: string, notice?: string) => run(env, renderCard(day, viewer, notice));
export const planPicker = (env: Env) => run(env, planPickerCard);
export const leaveByModal = (env: Env, day: string, user: string) => run(env, leaveBy(day, user));
export const resetNight = (env: Env, day: string) => run(env, wipeNight(day));
