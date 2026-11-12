// 🚨 Alert DMs: what the owner gets when something breaks, and how repeats and bursts are held back.
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import * as alerts from "./old/alerts.js";
import * as presence from "./old/presence.js";
import { defer, drain } from "./old/background.js";
import { harness, json } from "./harness.js";
import { testEnv } from "./pg.js";
import type { Env } from "./old/env.js";

const h = harness({
  db: false,
  env: { ALERT_USER_ID: "owner" },
  discord: { firstId: 0, answer: (c) => json(c.path === "/users/@me/channels" ? { id: `dm-${c.body.recipient_id}` } : { id: "m" }) },
  clock: "2026-11-09T17:00:00Z",
});
const calls = h.calls;
let env: Env;
beforeAll(() => void ({ env } = h));
beforeEach(() => {
  alerts._reset();
  presence._reset();
  alerts.setup(env);
});

const dms = () => calls.filter((c) => c.method === "POST" && c.path === "/channels/dm-owner/messages").map((c) => c.body.content as string);

test("a failure DMs the owner: what broke, where, the error, and how to read the logs", async () => {
  alerts.failed("posting the game-night card", new Error("POST /channels/1/messages -> 403 Missing Access"), "2026-11-09");
  await alerts._settle();
  expect(calls[0]).toMatchObject({ method: "POST", path: "/users/@me/channels", body: { recipient_id: "owner" } });
  const [dm] = dms();
  expect(dm).toContain("🚨 **posting the game-night card** failed · 2026-11-09");
  expect(dm).toContain("403 Missing Access");
  expect(dm).toContain("ssh vps app-logs meme-bot 1h");
  expect(calls.find((c) => c.path === "/channels/dm-owner/messages")!.body.allowed_mentions).toEqual({ parse: [] });
});

test("the same problem again within 3 hours is counted, not re-sent, then mentioned", async () => {
  alerts.failed("the start ping", new Error("timeout after 10000 ms"), "2026-11-09");
  alerts.failed("the start ping", new Error("timeout after 10001 ms"), "2026-11-10"); // same problem, other numbers
  alerts.failed("the start ping", new Error("timeout after 10002 ms"));
  await alerts._settle();
  expect(dms()).toHaveLength(1);
  expect(calls.filter((c) => c.path === "/users/@me/channels")).toHaveLength(1); // the DM channel is opened once
  vi.setSystemTime(Date.parse("2026-11-09T20:01:00Z"));
  alerts.failed("the start ping", new Error("timeout after 10003 ms"));
  await alerts._settle();
  expect(dms()).toHaveLength(2);
  expect(dms()[1]).toContain("(2 more times since the last DM about it)");
  alerts.failed("opening the game room", new Error("timeout after 10003 ms")); // a different problem goes out at once
  await alerts._settle();
  expect(dms()).toHaveLength(3);
});

test("a burst is capped at 5 DMs per 10 minutes; the next one says how many were held back", async () => {
  for (let i = 0; i < 7; i++) alerts.failed(`job ${"abcdefg"[i]}`, new Error("boom"));
  await alerts._settle();
  expect(dms()).toHaveLength(5);
  vi.setSystemTime(Date.parse("2026-11-09T17:11:00Z"));
  alerts.failed("job h", new Error("boom"));
  await alerts._settle();
  expect(dms()).toHaveLength(6);
  expect(dms()[5]).toContain("2 other problems were held back");
});

test("without an owner (the test bot) failures are only logged", async () => {
  alerts.setup(testEnv({} as never));
  alerts.failed("posting the game-night card", new Error("boom"));
  await alerts._settle();
  expect(calls).toEqual([]);
});

test("background work that fails is reported", async () => {
  defer(Promise.reject(new Error("PATCH /channels/1/messages/2 -> 500")), "card refresh");
  await drain(5000);
  await alerts._settle();
  expect(dms()[0]).toContain("🚨 **card refresh** failed");
});

test("the Discord gateway gets 5 minutes to reconnect before a DM, and one DM per outage", async () => {
  expect(await alerts.watchGateway(env)).toEqual({}); // down since now
  vi.setSystemTime(Date.parse("2026-11-09T17:04:00Z"));
  expect(await alerts.watchGateway(env)).toEqual({});
  vi.setSystemTime(Date.parse("2026-11-09T17:05:00Z"));
  expect(await alerts.watchGateway(env)).toEqual({ gatewayDown: 5 });
  vi.setSystemTime(Date.parse("2026-11-09T17:30:00Z"));
  expect(await alerts.watchGateway(env)).toEqual({});
  await alerts._settle();
  expect(dms()).toHaveLength(1);
  expect(dms()[0]).toContain("staying connected to Discord");
  // back up, then down again: a new outage is a new DM (after its own 5 minutes)
  presence.snapshot([]);
  expect(await alerts.watchGateway(env)).toEqual({});
});

test("the admin test DM reaches whoever it's sent to", async () => {
  expect(await alerts.test(testEnv({} as never), "someone")).toEqual({ sent: "someone" });
  expect(calls.map((c) => c.path)).toEqual(["/users/@me/channels", "/channels/dm-someone/messages"]);
  expect(calls[1].body.content).toContain("🧪 Test alert");
  expect(await alerts.test(testEnv({} as never))).toEqual({ skipped: "no ALERT_USER_ID and no user given" });
});
