// Resilience: the leader's clock notices when it's stuck (and /health shows how it's ticking), and the
// bot's database connections give up on a stuck query instead of hanging the job behind it.
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import * as scheduler from "../src/scheduler.js";
import { connect } from "../src/db/index.js";
import { build } from "../src/app.js";
import { testEnv, url } from "./pg.js";
import { harness, type TestDb } from "./harness.js";

const h = harness();
let t: TestDb;
beforeAll(() => void ({ t } = h));
afterEach(() => {
  vi.useRealTimers();
});

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

test("the clock says how long since its last minute, and nothing once it stops", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(Date.parse("2026-11-09T17:00:30Z"));
  const env = testEnv(t.db);
  const minutes: number[] = [];
  const clock = scheduler.start(env, { minute: async () => (minutes.push(Date.now()), {}) });
  await vi.waitFor(() => expect(minutes).toHaveLength(1)); // catches up at once
  expect(scheduler.sinceTick()).toBe(0);
  await tick(20_000);
  expect(scheduler.sinceTick()).toBe(20);
  await tick(15_000); // past the top of the minute
  await vi.waitFor(() => expect(minutes).toHaveLength(2));
  expect(minutes[1]).toBeGreaterThanOrEqual(Date.parse("2026-11-09T17:01:00Z"));
  expect(scheduler.sinceTick()).toBeLessThan(2);
  const app = build(env, { leader: () => true, shuttingDown: () => false });
  expect((await app.inject({ method: "GET", url: "/health" })).json()).toMatchObject({ ok: true, leader: true, clock: expect.any(Number), version: "dev" });
  await clock.stop();
  expect(scheduler.sinceTick()).toBeNull(); // a follower has no clock
});

test("a minute stuck for 5 minutes is reported once, so the bot can restart itself", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(Date.parse("2026-11-09T17:00:30Z"));
  let release!: () => void;
  const stuck = new Promise<Record<string, unknown>>((ok) => (release = () => ok({})));
  const stalls: number[] = [];
  const clock = scheduler.start(testEnv(t.db), { minute: () => stuck, onStall: (mins) => stalls.push(mins) });
  await tick(4 * 60_000);
  expect(stalls).toEqual([]);
  expect(scheduler.sinceTick()).toBe(240); // /health shows it falling behind
  await tick(90_000);
  expect(stalls).toEqual([5]);
  await tick(10 * 60_000);
  expect(stalls).toEqual([5]); // once
  release();
  await clock.stop();
});

test("a query stuck on a lock gives up after 30 s instead of hanging its job", async () => {
  const { pool } = connect(url());
  try {
    const { rows } = await pool.query("SELECT current_setting('statement_timeout') AS st, current_setting('idle_in_transaction_session_timeout') AS idle");
    expect(rows[0]).toEqual({ st: "30s", idle: "1min" });
  } finally {
    await pool.end();
  }
});
