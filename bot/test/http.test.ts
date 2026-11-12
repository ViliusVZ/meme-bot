// Test 13 (plan 05, verification.md §7): the HTTP contract, route by route: the good case, a bad
// token, a bad signature, a malformed body, an unknown admin action, an internal failure, an
// unknown route, a body over the limit, and /health while shutting down.
import { beforeAll, expect, test, vi } from "vitest";
import { build } from "./old/app.js";
import * as alerts from "./old/alerts.js";
import { harness } from "./harness.js";
import type { Env } from "./old/env.js";

const h = harness({ discord: { firstId: 40000 }, clock: "2026-11-06T15:00:00Z" });
let env: Env;
beforeAll(() => void ({ env } = h));

const up = { leader: () => true, shuttingDown: () => false };
const quietLog = () => vi.spyOn(console, "log").mockImplementation(() => {});

async function signer() {
  const keys = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as unknown as import("node:crypto").webcrypto.CryptoKeyPair;
  const pub = Buffer.from(await crypto.subtle.exportKey("raw", keys.publicKey)).toString("hex");
  const sign = async (body: string, ts: string) => Buffer.from(await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(ts + body))).toString("hex");
  return { pub, sign };
}

test("GET /health: the good case, and 503 while shutting down", async () => {
  const ok = await build(env, up).inject({ method: "GET", url: "/health" });
  expect(ok.statusCode).toBe(200);
  expect(ok.json()).toMatchObject({ ok: true, leader: true, gateway: false, background: 0 });
  const down = await build(env, { leader: () => false, shuttingDown: () => true }).inject({ method: "GET", url: "/health" });
  expect([down.statusCode, down.json()]).toEqual([503, { ok: false, shuttingDown: true }]);
});

test("GET /: the greeting", async () => {
  const r = await build(env, up).inject({ method: "GET", url: "/" });
  expect([r.statusCode, r.body]).toEqual([200, "Meme Bot 3000 🔥"]);
});

test("POST /interactions: a ping, a bad signature, a body that isn't JSON, a body over 1 MB", async () => {
  const { pub, sign } = await signer();
  const app = build({ ...env, DISCORD_PUBLIC_KEY: pub }, up);
  const post = async (payload: string, ts = "42", sig?: string) =>
    app.inject({ method: "POST", url: "/interactions", payload, headers: { "content-type": "application/json", "x-signature-ed25519": sig ?? (await sign(payload, ts)), "x-signature-timestamp": ts } });
  const ping = await post(JSON.stringify({ type: 1 }));
  expect([ping.statusCode, ping.json()]).toEqual([200, { type: 1 }]);
  const forged = await post(JSON.stringify({ type: 1 }), "42", await sign("something else", "42"));
  expect([forged.statusCode, forged.body]).toEqual([401, "bad signature"]);
  const log = quietLog();
  const garbage = await post("{not json");
  expect(garbage.statusCode).toBe(500);
  expect(garbage.json()).toHaveProperty("error");
  const huge = await post(JSON.stringify({ type: 1, pad: "x".repeat(1_100_000) }));
  log.mockRestore();
  expect(huge.statusCode).toBe(500);
  expect(huge.json()).toEqual({ error: "FastifyError [FST_ERR_CTP_BODY_TOO_LARGE]: Request body is too large" });
});

test("POST /ingest: a bad token, then the good case", async () => {
  const app = build(env, up);
  const bad = await app.inject({ method: "POST", url: "/ingest", headers: { authorization: "Bearer nope" }, payload: { memes: [] } });
  expect([bad.statusCode, bad.body]).toEqual([401, "nope"]);
  const good = await app.inject({ method: "POST", url: "/ingest", headers: { authorization: "Bearer i" }, payload: { memes: [] } });
  expect([good.statusCode, good.json()]).toEqual([200, { ingested: 0, daily: null }]);
});

test("admin routes: a bad token, an unknown action, an internal failure", async () => {
  const app = build(env, up);
  const bad = await app.inject({ method: "POST", url: "/admin/gamenight", headers: { authorization: "Bearer i" }, payload: { action: "reset" } });
  expect([bad.statusCode, bad.body]).toEqual([401, "nope"]);
  const unknown = await app.inject({ method: "POST", url: "/admin/gamenight", headers: { authorization: "Bearer a" }, payload: { action: "dance" } });
  expect([unknown.statusCode, unknown.json()]).toEqual([400, { error: "action?" }]);
  const log = quietLog();
  // a private copy of a card that doesn't exist: our failure, answered 500 with what went wrong
  const broken = await app.inject({ method: "POST", url: "/admin/gamenight", headers: { authorization: "Bearer a" }, payload: { action: "copy", day: "2026-01-01", user: "a" } });
  log.mockRestore();
  expect(broken.statusCode).toBe(500);
  expect(broken.json()).toHaveProperty("error");
});

test("an unknown route answers like Fastify's 404", async () => {
  const r = await build(env, up).inject({ method: "GET", url: "/nope" });
  expect([r.statusCode, r.json()]).toEqual([404, { message: "Route GET:/nope not found", error: "Not Found", statusCode: 404 }]);
});

test("a tap whose handling breaks gets a private apology, not Discord's failure", async () => {
  const { pub, sign } = await signer();
  const app = build({ ...env, DISCORD_PUBLIC_KEY: pub }, up);
  const payload = JSON.stringify({ type: 3, token: "tok", data: { custom_id: "v:t3_x:fire" } }); // no user: the handler can't go on
  const log = quietLog();
  const r = await app.inject({ method: "POST", url: "/interactions", payload, headers: { "content-type": "application/json", "x-signature-ed25519": await sign(payload, "42"), "x-signature-timestamp": "42" } });
  log.mockRestore();
  expect([r.statusCode, r.json()]).toEqual([200, { type: 4, data: { content: "Something went wrong on my end 🤕 Try again in a moment.", flags: 64 } }]);
});

test("a failure of ours is reported to the owner; a request that's too large isn't", async () => {
  alerts._reset();
  alerts.setup({ ...env, ALERT_USER_ID: "owner" });
  const { pub, sign } = await signer();
  const app = build({ ...env, DISCORD_PUBLIC_KEY: pub }, up);
  const dms = () => h.calls.filter((c) => c.method === "POST" && c.path === "/users/@me/channels");
  const log = quietLog();
  const huge = JSON.stringify({ type: 1, pad: "x".repeat(1_100_000) });
  await app.inject({ method: "POST", url: "/interactions", payload: huge, headers: { "content-type": "application/json", "x-signature-ed25519": await sign(huge, "42"), "x-signature-timestamp": "42" } });
  await alerts._settle();
  expect(dms()).toEqual([]);
  await app.inject({ method: "POST", url: "/admin/gamenight", headers: { authorization: "Bearer a" }, payload: { action: "copy", day: "2026-01-01", user: "a" } });
  await alerts._settle();
  log.mockRestore();
  expect(dms()).toHaveLength(1);
  alerts._reset();
});
