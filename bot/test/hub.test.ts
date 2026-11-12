// The HQ panel, /help and the 🕹️ game list manager.
import { beforeAll, expect, test } from "vitest";
import * as hub from "./old/hub.js";
import { games } from "../src/db/schema.js";
import { harness, type TestDb } from "./harness.js";
import type { Env } from "./old/env.js";

const h = harness({ tables: [games] });
let t: TestDb;
let env: Env;
beforeAll(() => void ({ t, env } = h));

test("🕹️ the game list shows every game; the remove menu offers the least played first", async () => {
  await t.db.insert(games).values(Array.from({ length: 30 }, (_, i) => ({ name: `Game ${String(i).padStart(2, "0")}`, emoji: "🎮", added_at: "2026-11-03", plays: i })));
  const m = (await hub.gamesManager(env)) as { components: { components: { type: number; content?: string; components?: { options?: { label: string }[] }[] }[] }[] };
  const parts = m.components[0].components;
  const list = parts[1].content!;
  for (let i = 0; i < 30; i++) expect(list).toContain(`**Game ${String(i).padStart(2, "0")}**`);
  const menu = parts.find((p) => p.type === 1 && p.components?.[0]?.options)!.components![0].options!;
  expect(menu).toHaveLength(25);
  expect(menu[0].label).toBe("Game 00");
  expect(menu[24].label).toBe("Game 24");
});

test("/help and the HQ panel point at the right channels", () => {
  for (const m of [hub.helpMessage(env), hub.hubPanel(env)]) {
    const all = JSON.stringify(m);
    expect(all).toContain(`### 🎮 Game night · <#${env.GAME_CHANNEL_ID}>`);
    expect(all).toContain(`### 🔊 Voice · <#${env.LOBBY_CHANNEL_ID}>`);
    expect(all).toContain(`### 😂 Memes · <#${env.CHANNEL_ID}>`);
  }
  expect(hub.helpMessage(env).flags & (1 << 6)).toBeTruthy(); // /help is private
  expect(hub.hubPanel(env).flags & (1 << 6)).toBeFalsy(); // the panel is for everyone
});
