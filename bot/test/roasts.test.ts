// The roast shuffle-bag across cycles (roasts.ts): a new cycle never opens with the line the chat
// saw last, so no line ever shows up twice in a row.
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { roastBags } from "../src/db/schema.js";
import { Roasts } from "../src/roasts.js";
import { harness } from "./fx.js";

const h = harness({ tables: [roastBags] });

it.effect("across cycles, no line comes twice in a row", () =>
  Effect.gen(function* () {
    const roasts = yield* Roasts;
    const lines = ["x", "y"];
    const drawn: string[] = [];
    for (let i = 0; i < 20; i++) drawn.push(yield* roasts.draw("test-family", lines, lines));
    for (let i = 1; i < drawn.length; i++) expect(drawn[i]).not.toBe(drawn[i - 1]);
    expect(new Set(drawn)).toEqual(new Set(lines));
  }).pipe(h.provide),
);
