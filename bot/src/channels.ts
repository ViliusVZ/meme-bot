// The server's channel list, kept live from the gateway (GUILD_CREATE has them all; CHANNEL_CREATE,
// UPDATE and DELETE keep it current) and from our own channel calls (discord.ts reports them, so a
// channel we just made is known before its event arrives). Room upkeep reads it every minute and on
// every room it opens, which over REST would run into Discord's rate limit on that endpoint.
import { Context, Effect, Layer, Ref } from "effect";

export type Channel = { id: string; name: string; type: number; position: number; parent_id?: string | null };

const slim = (c: Channel): Channel => ({ id: c.id, name: c.name, type: c.type, position: c.position, parent_id: c.parent_id ?? null });

export class Channels extends Context.Service<
  Channels,
  {
    /** The full list (gateway GUILD_CREATE): from now on the cache is the truth. */
    snapshot(list: ReadonlyArray<Channel>): Effect.Effect<void>;
    /** One channel created or changed (ignored until there's a snapshot). */
    upsert(c: Channel): Effect.Effect<void>;
    /** A bulk position change (PATCH /guilds/{id}/channels). */
    reposition(moves: ReadonlyArray<{ id: string; position: number }>): Effect.Effect<void>;
    remove(id: string): Effect.Effect<void>;
    /** The gateway dropped: the cache can't be trusted until the next snapshot. */
    readonly invalidate: Effect.Effect<void>;
    /** The cached list, or null before the gateway has sent one. */
    readonly cached: Effect.Effect<ReadonlyArray<Channel> | null>;
    /** Tests only (until phase 5 builds the state fresh per test). */
    readonly reset: Effect.Effect<void>; // LEGACY-BRIDGE
  }
>()("meme-bot/channels") {
  static readonly layer = Layer.effect(
    Channels,
    Effect.gen(function* () {
      const state = yield* Ref.make<{ cache: Map<string, Channel>; ready: boolean }>({ cache: new Map(), ready: false });
      return Channels.of({
        snapshot: (list) => Ref.set(state, { cache: new Map(list.map((c) => [c.id, slim(c)])), ready: true }),
        upsert: (c) =>
          Ref.update(state, (s) => {
            if (!(s.ready && c?.id && typeof c.type === "number")) return s;
            const cache = new Map(s.cache);
            cache.set(c.id, slim(c));
            return { ...s, cache };
          }),
        reposition: (moves) =>
          Ref.update(state, (s) => {
            const cache = new Map(s.cache);
            for (const m of moves) {
              const c = cache.get(m.id);
              if (c) cache.set(m.id, { ...c, position: m.position });
            }
            return { ...s, cache };
          }),
        remove: (id) =>
          Ref.update(state, (s) => {
            const cache = new Map(s.cache);
            cache.delete(id);
            return { ...s, cache };
          }),
        invalidate: Ref.update(state, (s) => ({ ...s, ready: false })),
        cached: Effect.map(Ref.get(state), (s) => (s.ready ? [...s.cache.values()] : null)),
        reset: Ref.set(state, { cache: new Map(), ready: false }), // LEGACY-BRIDGE
      });
    }),
  );
}
