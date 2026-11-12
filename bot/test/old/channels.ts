// The old functions of src/channels.ts, for the tests until phase 6 makes them Effect-native
// (plan 05, phase 5 step 8: the transition left src; the tests change only their imports).
export * from "../../src/channels.js";
import { runSync } from "../../src/legacy.js";
import { Channel, Channels } from "../../src/channels.js";

// the old functions, for the code that isn't on Effect yet
export const snapshot = (list: Channel[]) => runSync(Channels.use((c) => c.snapshot(list)));
export const upsert = (c: Channel) => runSync(Channels.use((s) => s.upsert(c)));
export const reposition = (moves: { id: string; position: number }[]) => runSync(Channels.use((c) => c.reposition(moves)));
export const remove = (id: string) => runSync(Channels.use((c) => c.remove(id)));
export const invalidate = () => runSync(Channels.use((c) => c.invalidate));
export const cached = (): Channel[] | null => runSync(Channels.use((c) => c.cached)) as Channel[] | null;
/** Tests only. */
export const _reset = () => runSync(Channels.use((c) => c.reset));
