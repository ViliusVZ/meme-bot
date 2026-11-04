// @ts-nocheck: ported from the plain-JS suite
import { test as vt, afterEach } from "vitest";
// Time-logic tests for game night.
// Fakes the clock.
import assert from "node:assert/strict";

import * as gn from "../src/gamenight.js";

const env = { TIMEZONE: "Europe/Vilnius", PLAYERS: "a,b,c" };
const realNow = Date.now;
afterEach(() => {
  Date.now = realNow;
});
const at = (iso) => (Date.now = () => Date.parse(iso));
const hm = (sec) => gn.local(env, new Date(sec * 1000)).hm;
const test = (name: string, fn: () => void | Promise<void>) => vt(name, fn);

test("winter offset is UTC+2", () => assert.equal(gn.wallToUnix(env, 2026, 11, 3, 17, 0), Date.parse("2026-11-03T15:00:00Z") / 1000));
test("summer offset is UTC+3", () => assert.equal(gn.wallToUnix(env, 2026, 7, 1, 17, 0), Date.parse("2026-07-01T14:00:00Z") / 1000));
test("DST start day (29 Mar 2026), evening", () => assert.equal(gn.wallToUnix(env, 2026, 3, 29, 20, 0), Date.parse("2026-03-29T17:00:00Z") / 1000));
test("DST end day (25 Oct 2026), evening", () => assert.equal(gn.wallToUnix(env, 2026, 10, 25, 20, 0), Date.parse("2026-10-25T18:00:00Z") / 1000));
test("local day/hour across DST", () => {
  assert.equal(gn.local(env, new Date("2026-03-29T14:00:00Z")).hour, 17); // already summer time
  assert.equal(gn.local(env, new Date("2026-10-25T15:00:00Z")).hour, 17); // back to winter time
  assert.equal(gn.local(env, new Date("2026-11-03T22:30:00Z")).day, "2026-11-04"); // 00:30 local
});

const presets = (stageIso, nowIso, votes = {}) => {
  at(nowIso);
  return gn.timeOptions(env, { day: gn.local(env).day, stage_at: Date.parse(stageIso) / 1000 }, votes).map(hm);
};
test("time stage at 14:00 → afternoon presets", () =>
  assert.deepEqual(presets("2026-11-03T12:00:00Z", "2026-11-03T12:00:00Z"), ["15:00", "15:30", "16:00", "17:00", "18:00"]));
test("time stage at 17:00 → evening presets", () =>
  assert.deepEqual(presets("2026-11-03T15:00:00Z", "2026-11-03T15:00:00Z"), ["18:00", "18:30", "19:00", "20:00", "21:00"]));
test("time stage at 17:20 → starts at 18:30", () => assert.equal(presets("2026-11-03T15:20:00Z", "2026-11-03T15:20:00Z")[0], "18:30"));
test("passed presets disappear", () =>
  assert.deepEqual(presets("2026-11-03T15:00:00Z", "2026-11-03T16:40:00Z"), ["19:00", "20:00", "21:00"]));
test("too few left → regenerated from now", () =>
  assert.deepEqual(presets("2026-11-03T12:00:00Z", "2026-11-03T15:10:00Z"), ["18:00", "18:30", "19:00", "20:00", "21:00"]));
test("custom votes are offered as buttons", () =>
  assert.deepEqual(presets("2026-11-03T15:00:00Z", "2026-11-03T15:00:00Z", { a: String(Date.parse("2026-11-03T18:15:00Z") / 1000) }), [
    "18:00", "18:30", "19:00", "20:00", "20:15", "21:00",
  ]));
test("late night → after-midnight presets", () =>
  assert.deepEqual(presets("2026-11-03T21:00:00Z", "2026-11-03T21:00:00Z"), ["00:00", "00:30", "01:00", "02:00", "03:00"]));

const parse = (input, nowIso) => {
  at(nowIso);
  const r = gn.parseTime(env, input);
  return typeof r === "number" ? hm(r) : r;
};
test("parse 20:30 / 2030 / 20.30 / 20h30 / 20", () => {
  for (const s of ["20:30", "2030", "20.30", "20h30", " 20 : 30 "]) assert.equal(parse(s, "2026-11-03T15:00:00Z"), "20:30", s);
  assert.equal(parse("20", "2026-11-03T15:00:00Z"), "20:00");
});
test("parse rejects nonsense and past", () => {
  assert.match(parse("25:00", "2026-11-03T15:00:00Z"), /Couldn't read/);
  assert.match(parse("abc", "2026-11-03T15:00:00Z"), /Couldn't read/);
  assert.match(parse("10:00", "2026-11-03T15:00:00Z"), /already passed/);
});
test("parse 01:00 late at night means after midnight", () => {
  at("2026-11-03T21:30:00Z"); // 23:30 local
  const r = gn.parseTime(env, "01:00");
  assert.equal(r, Date.parse("2026-11-03T23:00:00Z") / 1000);
});
test("parse respects summer time", () => {
  at("2026-07-01T10:00:00Z");
  assert.equal(gn.parseTime(env, "20:00"), Date.parse("2026-07-01T17:00:00Z") / 1000);
});

test("planned day → that day's 16:00-21:00", () => {
  at("2026-11-03T10:00:00Z");
  assert.deepEqual(gn.timeOptions(env, { day: "2026-11-06", stage_at: Date.now() / 1000 }, {}).map((s) => new Date(s * 1000).toISOString().slice(0, 16)), [
    "2026-11-06T14:00", "2026-11-06T15:00", "2026-11-06T16:00", "2026-11-06T17:00", "2026-11-06T18:00", "2026-11-06T19:00",
  ]);
});
test("custom time on a planned day", () => {
  at("2026-11-03T20:00:00Z"); // 22:00 today: 19:30 has passed today but not on Friday
  assert.equal(gn.parseTime(env, "19:30", "2026-11-06"), Date.parse("2026-11-06T17:30:00Z") / 1000);
  assert.equal(gn.parseTime(env, "01:00", "2026-11-06"), Date.parse("2026-11-06T23:00:00Z") / 1000);
});
test("weekday names", () => assert.equal(gn.weekday(env, "2026-11-06"), "Friday"));
test("every voted time keeps a button, even with many custom picks", () => {
  at("2026-11-03T10:00:00Z");
  const fri = (h, m = 0) => String(Date.parse(`2026-11-06T${String(h - 2).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`) / 1000);
  const votes = { a: fri(16, 45), b: fri(20, 15), c: fri(22, 30) }; // 3 customs + 6 presets = 9
  const opts = gn.timeOptions(env, { day: "2026-11-06", stage_at: Date.now() / 1000 }, votes).map(String);
  assert.ok(opts.length <= 8, `at most 8 buttons, got ${opts.length}`);
  for (const v of Object.values(votes)) assert.ok(opts.includes(v), `voted ${v} missing`);
});

// ---- 🏁 leave-by: does everyone get at least an hour together?
const H = 3600;
const T = (h) => String(Date.parse("2026-11-03T00:00:00Z") / 1000 + h * H); // hours as unix strings
const ps = ["a", "b", "c"];
const fitAt = (starts, untils = {}) => gn.fit(ps, starts, untils, 0);
test("no leave-by: start at the latest pick", () => {
  const f = fitAt({ a: T(17), b: T(18), c: T(20) });
  assert.deepEqual([f.ready, f.start, f.end, f.conflict], [true, +T(20), null, null]);
});
test("leave-by with room to play: fits, ends at the earliest leave-by", () => {
  const f = fitAt({ a: T(17), b: T(18), c: T(19) }, { a: T(22), b: T(23) });
  assert.deepEqual([f.ready, f.start, f.end, f.conflict], [true, +T(19), +T(22), null]);
});
test("exactly one hour together is enough", () => assert.equal(fitAt({ a: T(17), b: T(18), c: T(20) }, { a: T(21) }).conflict, null));
test("under an hour together is a clash naming who and when", () => {
  const f = fitAt({ a: T(17), b: T(18), c: T(20) }, { a: T(20.5) });
  assert.deepEqual(f.conflict, { leaver: "a", leaveBy: +T(20.5), late: ["c"], lateFrom: +T(20), bumped: false });
});
test("leaving before the start is a clash", () => assert.ok(fitAt({ a: T(17), b: T(18), c: T(20) }, { a: T(19) }).conflict));
test("the earliest leave-by is the one that matters", () => {
  const f = fitAt({ a: T(17), b: T(17), c: T(18) }, { a: T(23), b: T(18.5) });
  assert.equal(f.conflict.leaver, "b");
  assert.deepEqual(f.conflict.late, ["c"]);
});
test("several late starters are all named", () => assert.deepEqual(fitAt({ a: T(17), b: T(20), c: T(20) }, { a: T(20) }).conflict.late, ["b", "c"]));
test("partial picks: not ready, but an early clash warning shows", () => {
  const f = fitAt({ a: T(20) }, { b: T(20.5) });
  assert.equal(f.ready, false);
  assert.equal(f.conflict.leaver, "b");
});
test("no picks yet: nothing to clash", () => {
  const f = fitAt({}, { a: T(19) });
  assert.deepEqual([f.ready, f.start, f.end, f.conflict], [false, null, +T(19), null]);
});
test("passed picks are bumped to `soonest`, and that can clash", () => {
  const f = gn.fit(ps, { a: T(17), b: T(17), c: T(17) }, { a: T(18.5) }, +T(18));
  assert.equal(f.start, +T(18));
  assert.equal(f.conflict.bumped, true);
});

// ---- when does an unfinished card close? (asking/game picking at midnight, time picking at 06:00)
test("ask/game cards close at midnight", () => {
  at("2026-11-03T22:05:00Z"); // 00:05 local on the 4th
  assert.equal(gn.isOver(env, { day: "2026-11-03", stage: "ask" }), true);
  assert.equal(gn.isOver(env, { day: "2026-11-03", stage: "game" }), true);
});
test("time cards stay open after midnight for 🌙 starts", () => {
  at("2026-11-03T22:05:00Z"); // 00:05 local
  assert.equal(gn.isOver(env, { day: "2026-11-03", stage: "time" }), false);
  at("2026-11-04T03:59:00Z"); // 05:59 local
  assert.equal(gn.isOver(env, { day: "2026-11-03", stage: "time" }), false);
  at("2026-11-04T04:00:00Z"); // 06:00 local
  assert.equal(gn.isOver(env, { day: "2026-11-03", stage: "time" }), true);
});
test("today's and future cards are never over", () => {
  at("2026-11-03T21:59:00Z"); // 23:59 local
  assert.equal(gn.isOver(env, { day: "2026-11-03", stage: "ask" }), false);
  assert.equal(gn.isOver(env, { day: "2026-11-09", stage: "time" }), false);
});
test("after-midnight custom time on DST-end night stays a wall-clock time", () => {
  at("2026-10-24T19:00:00Z"); // Sat 22:00 local, the night clocks go back
  assert.equal(gn.local(env, new Date(gn.parseTime(env, "01:30", "2026-10-24") * 1000)).hm, "01:30");
});

