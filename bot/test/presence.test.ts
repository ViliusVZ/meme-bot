// Live voice state and the channel cache (presence.ts, channels.ts), on their own: which changes
// are reported to listeners, when lookups can be trusted, and what the cache keeps.
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { Presence } from "../src/presence.js";
import { Channels } from "../src/channels.js";

describe("Presence", () => {
  const seen = () => {
    const changes: string[] = [];
    return { changes, fn: (u: string, from: string | null, to: string | null) => void changes.push(`${u}:${from}->${to}`) };
  };

  it.effect("changes before the first snapshot aren't reported, and lookups can't be trusted yet", () =>
    Effect.gen(function* () {
      const p = yield* Presence;
      const s = seen();
      yield* p.onChange(s.fn);
      yield* p.update("a", "lobby");
      assert.deepStrictEqual(s.changes, []);
      assert.strictEqual(yield* p.channelOf("a"), undefined);
      assert.isFalse(yield* p.hasSnapshot);
    }).pipe(Effect.provide(Presence.layer)),
  );

  it.effect("a snapshot reports what changed while we weren't looking, then live moves are reported", () =>
    Effect.gen(function* () {
      const p = yield* Presence;
      const s = seen();
      yield* p.onChange(s.fn);
      yield* p.snapshot([{ user_id: "a", channel_id: "lobby" }]);
      yield* p.snapshot([{ user_id: "a", channel_id: "room" }, { user_id: "b", channel_id: "lobby" }]);
      yield* p.update("b", null);
      yield* p.update("b", null); // no change, no report
      assert.deepStrictEqual(s.changes, ["a:null->lobby", "a:lobby->room", "b:null->lobby", "b:lobby->null"]);
      assert.strictEqual(yield* p.channelOf("a"), "room");
      assert.strictEqual(yield* p.channelOf("b"), null);
    }).pipe(Effect.provide(Presence.layer)),
  );

  it.effect("after a drop, lookups wait for the resume; moves replayed meanwhile still count", () =>
    Effect.gen(function* () {
      const p = yield* Presence;
      const s = seen();
      yield* p.snapshot([{ user_id: "a", channel_id: "lobby" }]);
      yield* p.onChange(s.fn);
      yield* p.invalidate;
      assert.strictEqual(yield* p.channelOf("a"), undefined);
      assert.strictEqual(yield* p.lastKnown("a"), "lobby");
      yield* p.update("a", "room");
      assert.deepStrictEqual(s.changes, ["a:lobby->room"]);
      yield* p.revalidate;
      assert.strictEqual(yield* p.channelOf("a"), "room");
    }).pipe(Effect.provide(Presence.layer)),
  );

  it.effect("what people play: only real changes are reported; one listener's error doesn't stop the next", () =>
    Effect.gen(function* () {
      const p = yield* Presence;
      const heard: string[] = [];
      yield* p.onPlaying(() => {
        throw new Error("boom");
      });
      yield* p.onPlaying((u, names) => void heard.push(`${u}:${names.join("+")}`));
      yield* p.setActivities("a", [{ type: 0, name: "World of Warcraft" }, { type: 2, name: "Spotify" }]);
      yield* p.setActivities("a", [{ type: 0, name: "World of Warcraft" }]);
      yield* p.setActivities("a", []);
      assert.deepStrictEqual(heard, ["a:World of Warcraft", "a:"]);
      assert.deepStrictEqual(yield* p.playing("a"), []);
    }).pipe(Effect.provide(Presence.layer)),
  );
});

describe("Channels", () => {
  const room = { id: "1", name: "R.E.P.O.", type: 2, position: 3, parent_id: "voice" };

  it.effect("nothing is cached before the gateway's snapshot; changes before it are ignored", () =>
    Effect.gen(function* () {
      const c = yield* Channels;
      yield* c.upsert(room);
      assert.strictEqual(yield* c.cached, null);
      yield* c.snapshot([]);
      assert.deepStrictEqual(yield* c.cached, []);
    }).pipe(Effect.provide(Channels.layer)),
  );

  it.effect("after the snapshot: created, moved and deleted channels are kept current; a drop forgets the list", () =>
    Effect.gen(function* () {
      const c = yield* Channels;
      yield* c.snapshot([{ id: "lobby", name: "Lobby", type: 2, position: 0, parent_id: "voice" }]);
      yield* c.upsert(room);
      yield* c.reposition([{ id: "1", position: 1 }]);
      assert.deepStrictEqual((yield* c.cached)?.find((x) => x.id === "1")?.position, 1);
      yield* c.remove("lobby");
      assert.deepStrictEqual((yield* c.cached)?.map((x) => x.id), ["1"]);
      yield* c.invalidate;
      assert.strictEqual(yield* c.cached, null);
    }).pipe(Effect.provide(Channels.layer)),
  );
});
