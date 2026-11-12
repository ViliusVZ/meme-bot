// @ts-nocheck: ported from the plain-JS suite
import { it } from "@effect/vitest";
import { Effect } from "effect";
import * as TestClock from "effect/testing/TestClock";
// Time-logic tests for game night.
// Sets the clock (the test's TestClock).
import assert from "node:assert/strict";

import * as gn from "../src/gamenight.js";
import { parseTimeFor, timeOptionsFor } from "../src/gamenight.js";
import { localAt, wallToUnixIn, weekdayOf } from "../src/localtime.js";
import { Nights } from "../src/nights.js";
import { nowSec } from "../src/clock.js";
import { harness } from "./fx.js";

const h = harness({ db: false, clock: "test" }); // the app's services (isOver is the Nights service's)

const env = { TIMEZONE: "Europe/Vilnius", PLAYERS: "a,b,c" };
const at = (iso) => TestClock.setTime(Date.parse(iso));
const W = Effect.map(nowSec, (now) => ({ zone: env.TIMEZONE, now }));
const local = (d) => localAt(env.TIMEZONE, d.getTime());
const hm = (sec) => local(new Date(sec * 1000)).hm;
const wallToUnix = (y, m, d, hour, minute) => wallToUnixIn(env.TIMEZONE, y, m, d, hour, minute);
const isOver = (n) => Nights.use((x) => x.isOver(n));

it.effect("winter offset is UTC+2", () => Effect.sync(() => assert.equal(wallToUnix(2026, 11, 3, 17, 0), Date.parse("2026-11-03T15:00:00Z") / 1000)).pipe(h.provide));
it.effect("summer offset is UTC+3", () => Effect.sync(() => assert.equal(wallToUnix(2026, 7, 1, 17, 0), Date.parse("2026-07-01T14:00:00Z") / 1000)).pipe(h.provide));
it.effect("DST start day (29 Mar 2026), evening", () => Effect.sync(() => assert.equal(wallToUnix(2026, 3, 29, 20, 0), Date.parse("2026-03-29T17:00:00Z") / 1000)).pipe(h.provide));
it.effect("DST end day (25 Oct 2026), evening", () => Effect.sync(() => assert.equal(wallToUnix(2026, 10, 25, 20, 0), Date.parse("2026-10-25T18:00:00Z") / 1000)).pipe(h.provide));
it.effect("local day/hour across DST", () =>
  Effect.sync(() => {
    assert.equal(local(new Date("2026-03-29T14:00:00Z")).hour, 17); // already summer time
    assert.equal(local(new Date("2026-10-25T15:00:00Z")).hour, 17); // back to winter time
    assert.equal(local(new Date("2026-11-03T22:30:00Z")).day, "2026-11-04"); // 00:30 local
  }).pipe(h.provide),
);

const presets = (stageIso, nowIso, votes = {}) =>
  Effect.gen(function* () {
    yield* at(nowIso);
    const w = yield* W;
    return timeOptionsFor(w, { day: localAt(w.zone, w.now * 1000).day, stage_at: Date.parse(stageIso) / 1000 }, votes).map(hm);
  });
it.effect("time stage at 14:00 → afternoon presets", () =>
  Effect.gen(function* () {
    assert.deepEqual(yield* presets("2026-11-03T12:00:00Z", "2026-11-03T12:00:00Z"), ["15:00", "15:30", "16:00", "17:00", "18:00"]);
  }).pipe(h.provide),
);
it.effect("time stage at 17:00 → evening presets", () =>
  Effect.gen(function* () {
    assert.deepEqual(yield* presets("2026-11-03T15:00:00Z", "2026-11-03T15:00:00Z"), ["18:00", "18:30", "19:00", "20:00", "21:00"]);
  }).pipe(h.provide),
);
it.effect("time stage at 17:20 → starts at 18:30", () =>
  Effect.gen(function* () {
    assert.equal((yield* presets("2026-11-03T15:20:00Z", "2026-11-03T15:20:00Z"))[0], "18:30");
  }).pipe(h.provide),
);
it.effect("passed presets disappear", () =>
  Effect.gen(function* () {
    assert.deepEqual(yield* presets("2026-11-03T15:00:00Z", "2026-11-03T16:40:00Z"), ["19:00", "20:00", "21:00"]);
  }).pipe(h.provide),
);
it.effect("too few left → regenerated from now", () =>
  Effect.gen(function* () {
    assert.deepEqual(yield* presets("2026-11-03T12:00:00Z", "2026-11-03T15:10:00Z"), ["18:00", "18:30", "19:00", "20:00", "21:00"]);
  }).pipe(h.provide),
);
it.effect("custom votes are offered as buttons", () =>
  Effect.gen(function* () {
    assert.deepEqual(yield* presets("2026-11-03T15:00:00Z", "2026-11-03T15:00:00Z", { a: String(Date.parse("2026-11-03T18:15:00Z") / 1000) }), [
      "18:00", "18:30", "19:00", "20:00", "20:15", "21:00",
    ]);
  }).pipe(h.provide),
);
it.effect("late night → after-midnight presets", () =>
  Effect.gen(function* () {
    assert.deepEqual(yield* presets("2026-11-03T21:00:00Z", "2026-11-03T21:00:00Z"), ["00:00", "00:30", "01:00", "02:00", "03:00"]);
  }).pipe(h.provide),
);

const parse = (input, nowIso) =>
  Effect.gen(function* () {
    yield* at(nowIso);
    const r = parseTimeFor(yield* W, input);
    return typeof r === "number" ? hm(r) : r;
  });
it.effect("parse 20:30 / 2030 / 20.30 / 20h30 / 20", () =>
  Effect.gen(function* () {
    for (const s of ["20:30", "2030", "20.30", "20h30", " 20 : 30 "]) assert.equal(yield* parse(s, "2026-11-03T15:00:00Z"), "20:30", s);
    assert.equal(yield* parse("20", "2026-11-03T15:00:00Z"), "20:00");
  }).pipe(h.provide),
);
it.effect("parse rejects nonsense and past", () =>
  Effect.gen(function* () {
    assert.match(yield* parse("25:00", "2026-11-03T15:00:00Z"), /Couldn't read/);
    assert.match(yield* parse("abc", "2026-11-03T15:00:00Z"), /Couldn't read/);
    assert.match(yield* parse("10:00", "2026-11-03T15:00:00Z"), /already passed/);
  }).pipe(h.provide),
);
it.effect("parse 01:00 late at night means after midnight", () =>
  Effect.gen(function* () {
    yield* at("2026-11-03T21:30:00Z"); // 23:30 local
    const r = parseTimeFor(yield* W, "01:00");
    assert.equal(r, Date.parse("2026-11-03T23:00:00Z") / 1000);
  }).pipe(h.provide),
);
it.effect("parse respects summer time", () =>
  Effect.gen(function* () {
    yield* at("2026-07-01T10:00:00Z");
    assert.equal(parseTimeFor(yield* W, "20:00"), Date.parse("2026-07-01T17:00:00Z") / 1000);
  }).pipe(h.provide),
);

it.effect("planned day → that day's 16:00-21:00", () =>
  Effect.gen(function* () {
    yield* at("2026-11-03T10:00:00Z");
    const w = yield* W;
    assert.deepEqual(timeOptionsFor(w, { day: "2026-11-06", stage_at: w.now }, {}).map((s) => new Date(s * 1000).toISOString().slice(0, 16)), [
      "2026-11-06T14:00", "2026-11-06T15:00", "2026-11-06T16:00", "2026-11-06T17:00", "2026-11-06T18:00", "2026-11-06T19:00",
    ]);
  }).pipe(h.provide),
);
it.effect("custom time on a planned day", () =>
  Effect.gen(function* () {
    yield* at("2026-11-03T20:00:00Z"); // 22:00 today: 19:30 has passed today but not on Friday
    assert.equal(parseTimeFor(yield* W, "19:30", "2026-11-06"), Date.parse("2026-11-06T17:30:00Z") / 1000);
    assert.equal(parseTimeFor(yield* W, "01:00", "2026-11-06"), Date.parse("2026-11-06T23:00:00Z") / 1000);
  }).pipe(h.provide),
);
it.effect("weekday names", () => Effect.sync(() => assert.equal(weekdayOf("2026-11-06"), "Friday")).pipe(h.provide));
it.effect("every voted time keeps a button, even with many custom picks", () =>
  Effect.gen(function* () {
    yield* at("2026-11-03T10:00:00Z");
    const fri = (h, m = 0) => String(Date.parse(`2026-11-06T${String(h - 2).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`) / 1000);
    const votes = { a: fri(16, 45), b: fri(20, 15), c: fri(22, 30) }; // 3 customs + 6 presets = 9
    const w = yield* W;
    const opts = timeOptionsFor(w, { day: "2026-11-06", stage_at: w.now }, votes).map(String);
    assert.ok(opts.length <= 8, `at most 8 buttons, got ${opts.length}`);
    for (const v of Object.values(votes)) assert.ok(opts.includes(v), `voted ${v} missing`);
  }).pipe(h.provide),
);

// ---- 🏁 leave-by: does everyone get at least an hour together?
const H = 3600;
const T = (h) => String(Date.parse("2026-11-03T00:00:00Z") / 1000 + h * H); // hours as unix strings
const ps = ["a", "b", "c"];
const fitAt = (starts, untils = {}) => gn.fit(ps, starts, untils, 0);
it.effect("no leave-by: start at the latest pick", () =>
  Effect.sync(() => {
    const f = fitAt({ a: T(17), b: T(18), c: T(20) });
    assert.deepEqual([f.ready, f.start, f.end, f.conflict], [true, +T(20), null, null]);
  }).pipe(h.provide),
);
it.effect("leave-by with room to play: fits, ends at the earliest leave-by", () =>
  Effect.sync(() => {
    const f = fitAt({ a: T(17), b: T(18), c: T(19) }, { a: T(22), b: T(23) });
    assert.deepEqual([f.ready, f.start, f.end, f.conflict], [true, +T(19), +T(22), null]);
  }).pipe(h.provide),
);
it.effect("exactly one hour together is enough", () => Effect.sync(() => assert.equal(fitAt({ a: T(17), b: T(18), c: T(20) }, { a: T(21) }).conflict, null)).pipe(h.provide));
it.effect("under an hour together is a clash naming who and when", () =>
  Effect.sync(() => {
    const f = fitAt({ a: T(17), b: T(18), c: T(20) }, { a: T(20.5) });
    assert.deepEqual(f.conflict, { leaver: "a", leaveBy: +T(20.5), late: ["c"], lateFrom: +T(20), bumped: false });
  }).pipe(h.provide),
);
it.effect("leaving before the start is a clash", () => Effect.sync(() => assert.ok(fitAt({ a: T(17), b: T(18), c: T(20) }, { a: T(19) }).conflict)).pipe(h.provide));
it.effect("the earliest leave-by is the one that matters", () =>
  Effect.sync(() => {
    const f = fitAt({ a: T(17), b: T(17), c: T(18) }, { a: T(23), b: T(18.5) });
    assert.equal(f.conflict.leaver, "b");
    assert.deepEqual(f.conflict.late, ["c"]);
  }).pipe(h.provide),
);
it.effect("several late starters are all named", () => Effect.sync(() => assert.deepEqual(fitAt({ a: T(17), b: T(20), c: T(20) }, { a: T(20) }).conflict.late, ["b", "c"])).pipe(h.provide));
it.effect("partial picks: not ready, but an early clash warning shows", () =>
  Effect.sync(() => {
    const f = fitAt({ a: T(20) }, { b: T(20.5) });
    assert.equal(f.ready, false);
    assert.equal(f.conflict.leaver, "b");
  }).pipe(h.provide),
);
it.effect("no picks yet: nothing to clash", () =>
  Effect.sync(() => {
    const f = fitAt({}, { a: T(19) });
    assert.deepEqual([f.ready, f.start, f.end, f.conflict], [false, null, +T(19), null]);
  }).pipe(h.provide),
);
it.effect("passed picks are bumped to `soonest`, and that can clash", () =>
  Effect.sync(() => {
    const f = gn.fit(ps, { a: T(17), b: T(17), c: T(17) }, { a: T(18.5) }, +T(18));
    assert.equal(f.start, +T(18));
    assert.equal(f.conflict.bumped, true);
  }).pipe(h.provide),
);

// ---- when does an unfinished card close? (asking/game picking at midnight, time picking at 06:00)
it.effect("ask/game cards close at midnight", () =>
  Effect.gen(function* () {
    yield* at("2026-11-03T22:05:00Z"); // 00:05 local on the 4th
    assert.equal(yield* isOver({ day: "2026-11-03", stage: "ask" }), true);
    assert.equal(yield* isOver({ day: "2026-11-03", stage: "game" }), true);
  }).pipe(h.provide),
);
it.effect("time cards stay open after midnight for 🌙 starts", () =>
  Effect.gen(function* () {
    yield* at("2026-11-03T22:05:00Z"); // 00:05 local
    assert.equal(yield* isOver({ day: "2026-11-03", stage: "time" }), false);
    yield* at("2026-11-04T03:59:00Z"); // 05:59 local
    assert.equal(yield* isOver({ day: "2026-11-03", stage: "time" }), false);
    yield* at("2026-11-04T04:00:00Z"); // 06:00 local
    assert.equal(yield* isOver({ day: "2026-11-03", stage: "time" }), true);
  }).pipe(h.provide),
);
it.effect("today's and future cards are never over", () =>
  Effect.gen(function* () {
    yield* at("2026-11-03T21:59:00Z"); // 23:59 local
    assert.equal(yield* isOver({ day: "2026-11-03", stage: "ask" }), false);
    assert.equal(yield* isOver({ day: "2026-11-09", stage: "time" }), false);
  }).pipe(h.provide),
);
it.effect("after-midnight custom time on DST-end night stays a wall-clock time", () =>
  Effect.gen(function* () {
    yield* at("2026-10-24T19:00:00Z"); // Sat 22:00 local, the night clocks go back
    assert.equal(local(new Date(parseTimeFor(yield* W, "01:30", "2026-10-24") * 1000)).hm, "01:30");
  }).pipe(h.provide),
);
