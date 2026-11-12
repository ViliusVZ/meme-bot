// The old functions of src/polls.ts, for the tests until phase 6 makes them Effect-native
// (plan 05, phase 5 step 8: the transition left src; the tests change only their imports).
export * from "../../src/polls.js";
import { run } from "../../src/legacy.js";
import { Polls } from "../../src/polls.js";
import type { Env } from "../../src/env.js";
import { Mine } from "../../src/panels.js";

// the old functions, for the code that isn't on Effect yet
const asOld = (e: unknown) => {
  throw e instanceof Error && "_tag" in e && String(e._tag).startsWith("Discord") ? new Error(e.message) : e;
};
export const createPoll = (env: Env, user: string, question: string, rawOptions: string) => run(env, Polls.use((p) => p.create(user, question, rawOptions)));
export const pollAct = (env: Env, id: number, user: string, action: string) => run(env, Polls.use((p) => p.act(id, user, action)));
export const isClosed = (env: Env, id: number) => run(env, Polls.use((p) => p.isClosed(id)));
export const setMessage = (env: Env, id: number, channelId: string, messageId: string) => run(env, Polls.use((p) => p.setMessage(id, channelId, messageId)));
export const refreshPoll = (env: Env, id: number, mine?: Mine) => run(env, Polls.use((p) => p.refresh(id, mine))).catch(asOld);
export const syncPollPanels = (env: Env, id: number, mine?: Mine) => run(env, Polls.use((p) => p.syncPanels(id, mine)));
export const renderPoll = (env: Env, id: number, viewer?: string, notice?: string) => run(env, Polls.use((p) => p.render(id, viewer, notice)));
