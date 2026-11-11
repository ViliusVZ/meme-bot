// Stand-in players through an admin route (plan 05, verification.md §7 test 2): the players deep
// code sees are the stand-ins, and the real trio's rows are untouched.
import { beforeAll, expect, test } from "vitest";
import { voiceSegments } from "../src/db/schema.js";
import { build } from "../src/app.js";
import type { Env } from "../src/env.js";
import { harness } from "./harness.js";

const h = harness({ tables: [voiceSegments], discord: { firstId: 100 }, clock: "2026-11-06T15:00:00Z" });
let env: Env;
beforeAll(() => void ({ env } = h));

test("an admin stats call with stand-ins tracks only the stand-ins, though the real players are in voice too", async () => {
  const app = build(env, { leader: () => true, shuttingDown: () => false });
  const t = Math.floor(Date.now() / 1000);
  const res = await app.inject({
    method: "POST",
    url: "/admin/gamenight",
    headers: { authorization: `Bearer ${env.ADMIN_SECRET}`, "content-type": "application/json" },
    payload: JSON.stringify({ action: "stats", players: "qa-1,qa-2", track: { "qa-1": "room", "qa-2": "room", a: "room", b: "room" }, t }),
  });
  expect(res.json()).toEqual({ tracked: true });
  const rows = await h.t.db.select().from(voiceSegments);
  expect(rows.map((r) => r.user_id).sort()).toEqual(["qa-1", "qa-2"]);
});
