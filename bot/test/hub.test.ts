// The HQ panel, /help and the 🕹️ game list manager.
import { beforeAll, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { Hub } from "../src/hub.js";
import { Db } from "../src/db/db.js";
import { games } from "../src/db/schema.js";
import { harness } from "./fx.js";

const h = harness({ tables: [games] });
let env: typeof h.env;
beforeAll(() => void ({ env } = h));

it.effect("🕹️ the game list shows every game; the remove menu offers the least played first", () =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* db.insert(games).values(Array.from({ length: 30 }, (_, i) => ({ name: `Game ${String(i).padStart(2, "0")}`, emoji: "🎮", added_at: "2026-11-03", plays: i })));
    const m = (yield* Hub.use((x) => x.gamesManager())) as { components: { components: { type: number; content?: string; components?: { options?: { label: string }[] }[] }[] }[] };
    const parts = m.components[0].components;
    const list = parts[1].content!;
    for (let i = 0; i < 30; i++) expect(list).toContain(`**Game ${String(i).padStart(2, "0")}**`);
    const menu = parts.find((p) => p.type === 1 && p.components?.[0]?.options)!.components![0].options!;
    expect(menu).toHaveLength(25);
    expect(menu[0].label).toBe("Game 00");
    expect(menu[24].label).toBe("Game 24");
  }).pipe(h.provide),
);

it.effect("/help and the HQ panel point at the right channels", () =>
  Effect.gen(function* () {
    const hub = yield* Hub;
    for (const m of [yield* hub.helpMessage, yield* hub.hubPanel]) {
      const all = JSON.stringify(m);
      expect(all).toContain(`### 🎮 Game night · <#${env.GAME_CHANNEL_ID}>`);
      expect(all).toContain(`### 🔊 Voice · <#${env.LOBBY_CHANNEL_ID}>`);
      expect(all).toContain(`### 😂 Memes · <#${env.CHANNEL_ID}>`);
    }
    expect((yield* hub.helpMessage).flags & (1 << 6)).toBeTruthy(); // /help is private
    expect((yield* hub.hubPanel).flags & (1 << 6)).toBeFalsy(); // the panel is for everyone
  }).pipe(h.provide),
);
