// 🚨 Alert DMs: what the owner gets when something breaks, and how repeats and bursts are held back.
import { expect, it } from "@effect/vitest";
import { Duration, Effect } from "effect";
import { Alerts } from "../src/alerts.js";
import { Presence } from "../src/presence.js";
import { Background } from "../src/background.js";
import { harness, json } from "./fx.js";

// every test starts with fresh services: alerts with the owner from ALERT_USER_ID, no gateway yet
const h = harness({
  db: false,
  env: { ALERT_USER_ID: "owner" },
  discord: { firstId: 0, answer: (c) => json(c.path === "/users/@me/channels" ? { id: `dm-${c.body.recipient_id}` } : { id: "m" }) },
  clock: "2026-11-09T17:00:00Z",
});
const calls = h.calls;

const dms = () => calls.filter((c) => c.method === "POST" && c.path === "/channels/dm-owner/messages").map((c) => c.body.content as string);

it.effect("a failure DMs the owner: what broke, where, the error, and how to read the logs", () =>
  Effect.gen(function* () {
    const alerts = yield* Alerts;
    yield* alerts.failed("posting the game-night card", new Error("POST /channels/1/messages -> 403 Missing Access"), "2026-11-09");
    yield* alerts.settle;
    expect(calls[0]).toMatchObject({ method: "POST", path: "/users/@me/channels", body: { recipient_id: "owner" } });
    const [dm] = dms();
    expect(dm).toContain("🚨 **posting the game-night card** failed · 2026-11-09");
    expect(dm).toContain("403 Missing Access");
    expect(dm).toContain("ssh vps app-logs meme-bot 1h");
    expect(calls.find((c) => c.path === "/channels/dm-owner/messages")!.body.allowed_mentions).toEqual({ parse: [] });
  }).pipe(h.provide),
);

it.effect("the same problem again within 3 hours is counted, not re-sent, then mentioned", () =>
  Effect.gen(function* () {
    const alerts = yield* Alerts;
    yield* alerts.failed("the start ping", new Error("timeout after 10000 ms"), "2026-11-09");
    yield* alerts.failed("the start ping", new Error("timeout after 10001 ms"), "2026-11-10"); // same problem, other numbers
    yield* alerts.failed("the start ping", new Error("timeout after 10002 ms"));
    yield* alerts.settle;
    expect(dms()).toHaveLength(1);
    expect(calls.filter((c) => c.path === "/users/@me/channels")).toHaveLength(1); // the DM channel is opened once
    yield* h.setTime("2026-11-09T20:01:00Z");
    yield* alerts.failed("the start ping", new Error("timeout after 10003 ms"));
    yield* alerts.settle;
    expect(dms()).toHaveLength(2);
    expect(dms()[1]).toContain("(2 more times since the last DM about it)");
    yield* alerts.failed("opening the game room", new Error("timeout after 10003 ms")); // a different problem goes out at once
    yield* alerts.settle;
    expect(dms()).toHaveLength(3);
  }).pipe(h.provide),
);

it.effect("a burst is capped at 5 DMs per 10 minutes; the next one says how many were held back", () =>
  Effect.gen(function* () {
    const alerts = yield* Alerts;
    for (let i = 0; i < 7; i++) yield* alerts.failed(`job ${"abcdefg"[i]}`, new Error("boom"));
    yield* alerts.settle;
    expect(dms()).toHaveLength(5);
    yield* h.setTime("2026-11-09T17:11:00Z");
    yield* alerts.failed("job h", new Error("boom"));
    yield* alerts.settle;
    expect(dms()).toHaveLength(6);
    expect(dms()[5]).toContain("2 other problems were held back");
  }).pipe(h.provide),
);

it.effect("without an owner (the test bot) failures are only logged", () =>
  Effect.gen(function* () {
    const alerts = yield* Alerts;
    yield* alerts.setOwner(undefined);
    yield* alerts.failed("posting the game-night card", new Error("boom"));
    yield* alerts.settle;
    expect(calls).toEqual([]);
  }).pipe(h.provide),
);

it.effect("background work that fails is reported", () =>
  Effect.gen(function* () {
    const background = yield* Background;
    yield* background.run(Effect.die(new Error("PATCH /channels/1/messages/2 -> 500")), "card refresh");
    yield* background.drain(Duration.millis(5000));
    yield* Alerts.use((a) => a.settle);
    expect(dms()[0]).toContain("🚨 **card refresh** failed");
  }).pipe(h.provide),
);

it.effect("the Discord gateway gets 5 minutes to reconnect before a DM, and one DM per outage", () =>
  Effect.gen(function* () {
    const alerts = yield* Alerts;
    expect(yield* alerts.watchGateway).toEqual({}); // down since now
    yield* h.setTime("2026-11-09T17:04:00Z");
    expect(yield* alerts.watchGateway).toEqual({});
    yield* h.setTime("2026-11-09T17:05:00Z");
    expect(yield* alerts.watchGateway).toEqual({ gatewayDown: 5 });
    yield* h.setTime("2026-11-09T17:30:00Z");
    expect(yield* alerts.watchGateway).toEqual({});
    yield* alerts.settle;
    expect(dms()).toHaveLength(1);
    expect(dms()[0]).toContain("staying connected to Discord");
    // back up, then down again: a new outage is a new DM (after its own 5 minutes)
    yield* Presence.use((p) => p.snapshot([]));
    expect(yield* alerts.watchGateway).toEqual({});
  }).pipe(h.provide),
);

it.effect("the admin test DM reaches whoever it's sent to", () =>
  Effect.gen(function* () {
    const alerts = yield* Alerts;
    expect(yield* alerts.test("someone")).toEqual({ sent: "someone" });
    expect(calls.map((c) => c.path)).toEqual(["/users/@me/channels", "/channels/dm-someone/messages"]);
    expect(calls[1].body.content).toContain("🧪 Test alert");
    expect(yield* alerts.test(undefined)).toEqual({ skipped: "no ALERT_USER_ID and no user given" }); // (the test bot has no ALERT_USER_ID)
  }).pipe(h.provide),
);
