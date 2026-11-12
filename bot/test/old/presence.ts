// The old functions of src/presence.ts, for the tests until phase 6 makes them Effect-native
// (plan 05, phase 5 step 8: the transition left src; the tests change only their imports).
export * from "../../src/presence.js";
import { runSync } from "../../src/legacy.js";
import { Presence } from "../../src/presence.js";
import { Listener, PlayingListener } from "../../src/presence.js";

// the old functions, for the code that isn't on Effect yet (all synchronous, as they always were)
export const snapshot = (voiceStates: { user_id: string; channel_id: string | null }[]) => runSync(Presence.use((p) => p.snapshot(voiceStates)));
export const update = (user: string, channel: string | null) => runSync(Presence.use((p) => p.update(user, channel)));
export const invalidate = () => runSync(Presence.use((p) => p.invalidate));
export const revalidate = () => runSync(Presence.use((p) => p.revalidate));
export const isReady = () => runSync(Presence.use((p) => p.isReady));
export const hasSnapshot = () => runSync(Presence.use((p) => p.hasSnapshot));
export const channelOf = (user: string) => runSync(Presence.use((p) => p.channelOf(user)));
export const lastKnown = (user: string) => runSync(Presence.use((p) => p.lastKnown(user)));
export const onChange = (fn: Listener) => runSync(Presence.use((p) => p.onChange(fn)));
export const setActivities = (user: string, activities: { type: number; name: string }[] | undefined) => runSync(Presence.use((p) => p.setActivities(user, activities)));
export const playing = (user: string) => runSync(Presence.use((p) => p.playing(user)));
export const onPlaying = (fn: PlayingListener) => runSync(Presence.use((p) => p.onPlaying(fn)));
/** Tests only. */
export const _reset = () => runSync(Presence.use((p) => p.reset));
