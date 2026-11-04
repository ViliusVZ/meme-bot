// @ts-nocheck: ported from the plain-JS suite
import { test as vt, afterEach } from "vitest";
// Rock-paper-scissors and wheel logic.
import assert from "node:assert/strict";

import * as tb from "../src/tiebreak.js";

const test = (name: string, fn: () => void | Promise<void>) => vt(name, fn);

const round = (hands) => tb.resolveRound(Object.keys(hands), hands);
test("rock beats scissors", () => assert.deepEqual(round({ a: "r", b: "s" }), { draw: false, win: "r", survivors: ["a"] }));
test("paper beats rock", () => assert.deepEqual(round({ a: "r", b: "p" }), { draw: false, win: "p", survivors: ["b"] }));
test("scissors beat paper", () => assert.deepEqual(round({ a: "s", b: "p" }), { draw: false, win: "s", survivors: ["a"] }));
test("same hands draw", () => assert.equal(round({ a: "r", b: "r" }).draw, true));
test("three-way: all same is a draw", () => assert.equal(round({ a: "p", b: "p", c: "p" }).draw, true));
test("three-way: all different is a draw", () => assert.equal(round({ a: "r", b: "p", c: "s" }).draw, true));
test("three-way: two winners go to a final", () => assert.deepEqual(round({ a: "r", b: "r", c: "s" }).survivors, ["a", "b"]));
test("three-way: one winner", () => assert.deepEqual(round({ a: "p", b: "r", c: "r" }).survivors, ["a"]));
test("only living players count", () => assert.deepEqual(tb.resolveRound(["a", "c"], { a: "s", b: "r", c: "p" }).survivors, ["a"]));

test("wheel frames land on the winner", () => {
  for (const options of [["A", "B"], ["A", "B", "C"]]) {
    for (const w of options) {
      // spinFrames is internal; exercise it through spinFrame's pointer text
      const frame = tb.spinFrame(options, w, (o) => o, true);
      assert.match(frame.components[1].content, new RegExp(`▶ \\*\\*${w}\\*\\* ◀`));
      assert.match(frame.components[2].content, new RegExp(`🎯 ${w}!`));
    }
  }
});

