// Time-logic tests for game night.   node test/time.test.mjs
// Bundles src/gamenight.ts with esbuild (ships with wrangler) and fakes the clock.
import { build } from "esbuild";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const out = join(mkdtempSync(join(tmpdir(), "gn-")), "gn.mjs");
const res = await build({ entryPoints: ["src/gamenight.ts"], bundle: true, format: "esm", write: false });
writeFileSync(out, res.outputFiles[0].text);
const gn = await import(pathToFileURL(out).href);

const env = { TIMEZONE: "Europe/Vilnius", PLAYERS: "a,b,c" };
const realNow = Date.now;
const at = (iso) => (Date.now = () => Date.parse(iso));
const hm = (sec) => gn.local(env, new Date(sec * 1000)).hm;
let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error(`✗ ${name}\n  ${e.message}`);
    process.exitCode = 1;
  } finally {
    Date.now = realNow;
  }
};

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

console.log(`${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
