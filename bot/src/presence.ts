// Who's in which voice channel, live. The gateway (gateway.ts) feeds this from GUILD_CREATE (a full
// snapshot on every connect) and VOICE_STATE_UPDATE (every join, leave and move), so lookups are
// instant and free. Until a snapshot has arrived (startup, or a copy that isn't the leader) it's
// "not ready" and callers fall back to asking Discord over REST.
//
// 🎮 What people are playing: only with the presence intent (PRESENCES=1). Kept in memory only,
// never stored: "Playing …" activity names per user, straight from Discord.
import { Context, Effect, Layer, PubSub, Ref, Schema, type Scope } from "effect";
import { nowSec } from "./clock.js";

/** A subscriber threw: logged, and the others still hear about the change. */
class ListenerFailed extends Schema.TaggedError<ListenerFailed>()("ListenerFailed", { detail: Schema.String }) {}

export type Listener = (user: string, from: string | null, to: string | null) => void;

/** What changed, as Live hears it: a voice move (with when we saw it) or what someone's playing. */
export type PresenceEvent =
  | { readonly _tag: "Moved"; readonly user: string; readonly from: string | null; readonly to: string | null; readonly at: number }
  | { readonly _tag: "Playing"; readonly user: string; readonly names: ReadonlyArray<string> };
export type PlayingListener = (user: string, names: string[]) => void;

type State = {
  states: Map<string, string>; // user → voice channel (absent = not in voice)
  ready: boolean; // connected and up to date
  known: boolean; // we've had a snapshot (changes are meaningful even mid-resume)
  games: Map<string, string[]>;
};
const empty = (): State => ({ states: new Map(), ready: false, known: false, games: new Map() });

export class Presence extends Context.Service<
  Presence,
  {
    /** A full snapshot of the guild's voice states (on connect / reconnect). */
    snapshot(voiceStates: ReadonlyArray<{ user_id: string; channel_id: string | null }>): Effect.Effect<void>;
    /** One VOICE_STATE_UPDATE. */
    update(user: string, channel: string | null): Effect.Effect<void>;
    /** The gateway dropped: stop trusting lookups until it resumes or sends a new snapshot. */
    readonly invalidate: Effect.Effect<void>;
    /** The gateway resumed (missed events replayed): lookups are good again. */
    readonly revalidate: Effect.Effect<void>;
    readonly isReady: Effect.Effect<boolean>;
    readonly hasSnapshot: Effect.Effect<boolean>;
    /** The user's voice channel (null: not in voice), or undefined when we can't know right now. */
    channelOf(user: string): Effect.Effect<string | null | undefined>;
    /** The last known channel, even mid-resume (live.ts, which only acts once there's a snapshot). */
    lastKnown(user: string): Effect.Effect<string | null>;
    /** Subscribe to changes; gives back the unsubscribe. */
    onChange(fn: Listener): Effect.Effect<() => void>;
    /** Every change from now on, until the scope closes (Live, within the leader's term). */
    readonly changes: Effect.Effect<PubSub.Subscription<PresenceEvent>, never, Scope.Scope>;
    /** One presence (GUILD_CREATE's list or a PRESENCE_UPDATE): their "Playing …" names. */
    setActivities(user: string, activities: ReadonlyArray<{ type: number; name: string }> | undefined): Effect.Effect<void>;
    /** What they're playing right now (empty: nothing we can see). */
    playing(user: string): Effect.Effect<string[]>;
    onPlaying(fn: PlayingListener): Effect.Effect<() => void>;
  }
>()("meme-bot/presence") {
  static readonly layer = Layer.effect(
    Presence,
    Effect.gen(function* () {
      const state = yield* Ref.make(empty());
      const published = yield* PubSub.unbounded<PresenceEvent>();
      // listeners are called synchronously, in order, as the old module did; only the tests still
      // subscribe this way (Live reads `changes`), until phase 6 moves them to the subscription
      const listeners: Listener[] = [];
      const playingListeners: PlayingListener[] = [];
      const call = <A extends unknown[]>(fns: ((...a: A) => void)[], args: A, what: string) =>
        Effect.forEach([...fns], (fn) =>
          Effect.try({ try: () => fn(...args), catch: (e) => new ListenerFailed({ detail: String(e) }) }).pipe(Effect.catch((e) => Effect.logWarning(`${what} listener failed ${e.detail}`))),
        );
      const emit = (user: string, from: string | null, to: string | null) =>
        Effect.gen(function* () {
          yield* PubSub.publish(published, { _tag: "Moved", user, from, to, at: yield* nowSec });
          yield* call(listeners, [user, from, to], "presence");
        });
      const subscribe = <F>(list: F[], fn: F) =>
        Effect.sync(() => {
          list.push(fn);
          return () => {
            const i = list.indexOf(fn);
            if (i >= 0) list.splice(i, 1);
          };
        });

      return Presence.of({
        snapshot: (voiceStates) =>
          Effect.gen(function* () {
            const before = new Map((yield* Ref.get(state)).states);
            const states = new Map<string, string>();
            for (const v of voiceStates) if (v.channel_id) states.set(v.user_id, v.channel_id);
            yield* Ref.update(state, (s) => ({ ...s, states, ready: true, known: true }));
            // anything that changed while we weren't looking is reported like a live change
            for (const u of new Set([...before.keys(), ...states.keys()])) {
              const from = before.get(u) ?? null;
              const to = states.get(u) ?? null;
              if (from !== to) yield* emit(u, from, to);
            }
          }),
        update: (user, channel) =>
          Effect.gen(function* () {
            const s = yield* Ref.get(state);
            const from = s.states.get(user) ?? null;
            const states = new Map(s.states);
            if (channel) states.set(user, channel);
            else states.delete(user);
            yield* Ref.set(state, { ...s, states });
            // a resume replays missed events in order, so changes count even before it completes
            if (s.known && from !== channel) yield* emit(user, from, channel);
          }),
        invalidate: Ref.update(state, (s) => ({ ...s, ready: false })),
        revalidate: Ref.update(state, (s) => (s.known ? { ...s, ready: true } : s)),
        isReady: Effect.map(Ref.get(state), (s) => s.ready),
        hasSnapshot: Effect.map(Ref.get(state), (s) => s.known),
        channelOf: (user) => Effect.map(Ref.get(state), (s) => (s.ready ? (s.states.get(user) ?? null) : undefined)),
        lastKnown: (user) => Effect.map(Ref.get(state), (s) => s.states.get(user) ?? null),
        onChange: (fn) => subscribe(listeners, fn),
        changes: PubSub.subscribe(published),
        setActivities: (user, activities) =>
          Effect.gen(function* () {
            const names = (activities ?? []).filter((a) => a.type === 0 && a.name).map((a) => a.name);
            const s = yield* Ref.get(state);
            const before = s.games.get(user) ?? [];
            const games = new Map(s.games);
            if (names.length) games.set(user, names);
            else games.delete(user);
            yield* Ref.set(state, { ...s, games });
            if (before.join("|") === names.join("|")) return;
            yield* PubSub.publish(published, { _tag: "Playing", user, names });
            yield* call(playingListeners, [user, names], "playing");
          }),
        playing: (user) => Effect.map(Ref.get(state), (s) => s.games.get(user) ?? []),
        onPlaying: (fn) => subscribe(playingListeners, fn),
      });
    }),
  );
}
