// Who's in which voice channel, live. The gateway (gateway.ts) feeds this from GUILD_CREATE (a full
// snapshot on every connect) and VOICE_STATE_UPDATE (every join, leave and move), so lookups are
// instant and free. Until a snapshot has arrived (startup, or a copy that isn't the leader) it's
// "not ready" and callers fall back to asking Discord over REST.

const states = new Map<string, string>(); // user → voice channel (absent = not in voice)
let ready = false; // connected and up to date
let known = false; // we've had a snapshot (changes are meaningful even mid-resume)

type Listener = (user: string, from: string | null, to: string | null) => void;
const listeners: Listener[] = [];

/** A full snapshot of the guild's voice states (on connect / reconnect). */
export function snapshot(voiceStates: { user_id: string; channel_id: string | null }[]) {
  const before = new Map(states);
  states.clear();
  for (const v of voiceStates) if (v.channel_id) states.set(v.user_id, v.channel_id);
  ready = true;
  known = true;
  // anything that changed while we weren't looking is reported like a live change
  for (const u of new Set([...before.keys(), ...states.keys()])) {
    const from = before.get(u) ?? null;
    const to = states.get(u) ?? null;
    if (from !== to) emit(u, from, to);
  }
}

/** One VOICE_STATE_UPDATE. */
export function update(user: string, channel: string | null) {
  const from = states.get(user) ?? null;
  if (channel) states.set(user, channel);
  else states.delete(user);
  // a resume replays missed events in order, so changes count even before it completes
  if (known && from !== channel) emit(user, from, channel);
}

/** The gateway dropped: stop trusting lookups until it resumes or sends a new snapshot. */
export function invalidate() {
  ready = false;
}

/** The gateway resumed (missed events replayed): lookups are good again. */
export function revalidate() {
  if (known) ready = true;
}

export const isReady = () => ready;
export const hasSnapshot = () => known;

/** The user's voice channel (null: not in voice), or undefined when we can't know right now. */
export function channelOf(user: string): string | null | undefined {
  return ready ? (states.get(user) ?? null) : undefined;
}

/** The last known channel, even mid-resume (live.ts, which only acts once there's a snapshot). */
export const lastKnown = (user: string) => states.get(user) ?? null;

/** Subscribe to changes; returns the unsubscribe. */
export function onChange(fn: Listener) {
  listeners.push(fn);
  return () => {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };
}

function emit(user: string, from: string | null, to: string | null) {
  for (const fn of listeners) {
    try {
      fn(user, from, to);
    } catch (e) {
      console.log("presence listener failed", e);
    }
  }
}

/** Tests only. */
export function _reset() {
  states.clear();
  ready = false;
  known = false;
  listeners.length = 0;
}
