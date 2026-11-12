// Private copies (panels.ts), verification.md §7 test 7: two syncs of one card run one after the
// other (an older state never lands on a newer one); syncs of two cards run side by side.
import { expect, it } from "@effect/vitest";
import { Clock, Effect } from "effect";
import { panels } from "../src/db/schema.js";
import { Panels } from "../src/panels.js";
import { Db } from "../src/db/db.js";
import { harness } from "./fx.js";

const h = harness({ tables: [panels], discord: { firstId: 100 }, clock: "2026-11-06T15:00:00Z" });

it.effect("two syncs of one card run one after the other; syncs of two cards run together", () =>
  Effect.gen(function* () {
    const t = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const db = yield* Db;
    yield* db.insert(panels).values([
      { message_id: "m1", card: "gn:2026-11-06", user_id: "a", token: "ta", tapped_at: t },
      { message_id: "m2", card: "poll:7", user_id: "b", token: "tb", tapped_at: t },
    ]);
    const log: string[] = [];
    const render = (name: string) => (user: string) =>
      Effect.gen(function* () {
        log.push(`${name} start ${user}`);
        yield* Effect.sleep("60 millis");
        log.push(`${name} end ${user}`);
        return { flags: 1 << 15, components: [{ type: 10, content: name }] };
      });
    const sync = (card: string, name: string) => Panels.use((p) => p.sync(card, render(name)));
    yield* Effect.all([sync("gn:2026-11-06", "card-1"), sync("gn:2026-11-06", "card-2"), sync("poll:7", "poll")], { concurrency: "unbounded" });
    // the card's two syncs never overlap, and the first one's state is the first to land
    expect(log.indexOf("card-1 end a")).toBeLessThan(log.indexOf("card-2 start a"));
    const edits = h.calls.filter((c) => c.method === "PATCH" && c.path.includes("/webhooks/app/ta/"));
    expect(edits.map((c) => c.body.components[0].content)).toEqual(["card-1", "card-2"]);
    // the poll's sync ran alongside the card's first one
    expect(log.indexOf("poll start b")).toBeLessThan(log.indexOf("card-1 end a"));
  }).pipe(h.provide),
);
