// The roast shuffle-bag across cycles (roasts.ts): a new cycle never opens with the line the chat
// saw last, so no line ever shows up twice in a row.
import { beforeAll, expect, test } from "vitest";
import { roastBags } from "../src/db/schema.js";
import * as roasts from "./old/roasts.js";
import type { Env } from "./old/env.js";
import { harness } from "./harness.js";

const h = harness({ tables: [roastBags] });
let env: Env;
beforeAll(() => void ({ env } = h));

test("across cycles, no line comes twice in a row", async () => {
  const lines = ["x", "y"];
  const drawn: string[] = [];
  for (let i = 0; i < 20; i++) drawn.push(await roasts.draw(env, "test-family", lines, lines));
  for (let i = 1; i < drawn.length; i++) expect(drawn[i]).not.toBe(drawn[i - 1]);
  expect(new Set(drawn)).toEqual(new Set(lines));
});
