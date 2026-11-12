// The old functions of src/activity.ts, for the tests until phase 6 makes them Effect-native
// (plan 05, phase 5 step 8: the transition left src; the tests change only their imports).
export * from "../../src/activity.js";
import { run } from "./legacy.js";
import { Activity, Crunched, Kind, periodAt } from "../../src/activity.js";
import type { Env } from "./env.js";
import { When } from "../../src/gamenight.js";

const W = (env: Env): When => ({ zone: env.TIMEZONE, now: Math.floor(Date.now() / 1000) });
export const period = (env: Env, kind: Kind, offset = 0) => periodAt(W(env), kind, offset);
// the old functions, for the code that isn't on Effect yet
const asOld = (e: unknown) => {
  throw e instanceof Error && "_tag" in e && String(e._tag).startsWith("Discord") ? new Error(e.message) : e;
};
export const track = (env: Env, where: Map<string, string | null>, t?: number) => run(env, Activity.use((a) => a.track(where, t)));
export const crunch = (env: Env, from: number, to: number) => run(env, Activity.use((a) => a.crunch(from, to)));
export const statsBody = (env: Env, title: string, s: Crunched, prev?: Crunched, prevName?: string) => run(env, Activity.use((a) => a.statsBody(title, s, prev, prevName)));
export const statsPanel = (env: Env, kind: Kind = "week", offset = 0, sharedBy?: string) => run(env, Activity.use((a) => a.statsPanel(kind, offset, sharedBy)));
export const recaps = (env: Env) => run(env, Activity.use((a) => a.recaps)).catch(asOld);
