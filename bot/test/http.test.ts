// Test 13 (plan 05, verification.md §7): the HTTP contract, route by route: the good case, a bad
// token, a bad signature, a malformed body, an unknown admin action, an internal failure, an
// unknown route, a body over the limit, and /health while shutting down.
import { expect, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { AppStatus, ROUTER_CONFIG, routesOn, type Status } from "../src/app.js";
import { Alerts } from "../src/alerts.js";
import { AppConfig } from "../src/config.js";
import type { AppServices } from "../src/runtime.js";
import { harness } from "./fx.js";

const h = harness({ discord: { firstId: 40000 }, clock: "2026-11-06T15:00:00Z" });

const up = { leader: () => true, shuttingDown: () => false };

/**
 * The app's routes on this test's services, answering injected requests through the web handler (as
 * the old app object's `inject`). `publicKey` and `alertUserId` stand in for the configuration's.
 */
const build = (status: Status, o: { publicKey?: string; alertUserId?: string } = {}) =>
  Effect.gen(function* () {
    let ctx = yield* Effect.context<AppServices>();
    if (o.alertUserId !== undefined) ctx = Context.add(ctx, AppConfig, { ...Context.get(ctx, AppConfig), alertUserId: o.alertUserId });
    const statusLayer = Layer.succeed(AppStatus, AppStatus.of({ leader: Effect.sync(status.leader), shuttingDown: Effect.sync(status.shuttingDown), publicKey: o.publicKey ?? h.env.DISCORD_PUBLIC_KEY }));
    const { handler } = HttpRouter.toWebHandler(routesOn(statusLayer, ctx).pipe(Layer.provide(HttpServer.layerServices)), { disableLogger: true, routerConfig: ROUTER_CONFIG });
    return {
      inject: (r: { method: string; url: string; payload?: unknown; headers?: Record<string, string> }) =>
        Effect.promise(async () => {
          const body = r.payload === undefined ? undefined : typeof r.payload === "string" ? r.payload : JSON.stringify(r.payload);
          const headers = { ...(body !== undefined && typeof r.payload !== "string" ? { "content-type": "application/json" } : {}), ...r.headers };
          // the request runs on this test's services, clock and logger
          const res = await handler(new Request(`http://local${r.url}`, { method: r.method, headers, body }), ctx);
          const text = await res.text();
          return { statusCode: res.status, headers: Object.fromEntries(res.headers), body: text, json: () => JSON.parse(text) };
        }),
    };
  });

async function signerKeys() {
  const keys = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as unknown as import("node:crypto").webcrypto.CryptoKeyPair;
  const pub = Buffer.from(await crypto.subtle.exportKey("raw", keys.publicKey)).toString("hex");
  const sign = async (body: string, ts: string) => Buffer.from(await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(ts + body))).toString("hex");
  return { pub, sign: (body: string, ts: string) => Effect.promise(() => sign(body, ts)) };
}
const signer = () => Effect.promise(signerKeys);

it.effect("GET /health: the good case, and 503 while shutting down", () =>
  Effect.gen(function* () {
    const ok = yield* (yield* build(up)).inject({ method: "GET", url: "/health" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, leader: true, gateway: false, background: 0 });
    const down = yield* (yield* build({ leader: () => false, shuttingDown: () => true })).inject({ method: "GET", url: "/health" });
    expect([down.statusCode, down.json()]).toEqual([503, { ok: false, shuttingDown: true }]);
  }).pipe(h.provide),
);

it.effect("GET /: the greeting", () =>
  Effect.gen(function* () {
    const r = yield* (yield* build(up)).inject({ method: "GET", url: "/" });
    expect([r.statusCode, r.body]).toEqual([200, "Meme Bot 3000 🔥"]);
  }).pipe(h.provide),
);

it.effect("POST /interactions: a ping, a bad signature, a body that isn't JSON, a body over 1 MB", () =>
  Effect.gen(function* () {
    const { pub, sign } = yield* signer();
    const app = yield* build(up, { publicKey: pub });
    const post = (payload: string, ts = "42", sig?: string) =>
      Effect.gen(function* () {
        return yield* app.inject({ method: "POST", url: "/interactions", payload, headers: { "content-type": "application/json", "x-signature-ed25519": sig ?? (yield* sign(payload, ts)), "x-signature-timestamp": ts } });
      });
    const ping = yield* post(JSON.stringify({ type: 1 }));
    expect([ping.statusCode, ping.json()]).toEqual([200, { type: 1 }]);
    const forged = yield* post(JSON.stringify({ type: 1 }), "42", yield* sign("something else", "42"));
    expect([forged.statusCode, forged.body]).toEqual([401, "bad signature"]);
    const garbage = yield* post("{not json");
    expect(garbage.statusCode).toBe(500);
    expect(garbage.json()).toHaveProperty("error");
    const huge = yield* post(JSON.stringify({ type: 1, pad: "x".repeat(1_100_000) }));
    expect(huge.statusCode).toBe(500);
    expect(huge.json()).toEqual({ error: "FastifyError [FST_ERR_CTP_BODY_TOO_LARGE]: Request body is too large" });
  }).pipe(h.provide),
);

it.effect("POST /ingest: a bad token, then the good case", () =>
  Effect.gen(function* () {
    const app = yield* build(up);
    const bad = yield* app.inject({ method: "POST", url: "/ingest", headers: { authorization: "Bearer nope" }, payload: { memes: [] } });
    expect([bad.statusCode, bad.body]).toEqual([401, "nope"]);
    const good = yield* app.inject({ method: "POST", url: "/ingest", headers: { authorization: "Bearer i" }, payload: { memes: [] } });
    expect([good.statusCode, good.json()]).toEqual([200, { ingested: 0, daily: null }]);
  }).pipe(h.provide),
);

it.effect("admin routes: a bad token, an unknown action, an internal failure", () =>
  Effect.gen(function* () {
    const app = yield* build(up);
    const bad = yield* app.inject({ method: "POST", url: "/admin/gamenight", headers: { authorization: "Bearer i" }, payload: { action: "reset" } });
    expect([bad.statusCode, bad.body]).toEqual([401, "nope"]);
    const unknown = yield* app.inject({ method: "POST", url: "/admin/gamenight", headers: { authorization: "Bearer a" }, payload: { action: "dance" } });
    expect([unknown.statusCode, unknown.json()]).toEqual([400, { error: "action?" }]);
    // a private copy of a card that doesn't exist: our failure, answered 500 with what went wrong
    const broken = yield* app.inject({ method: "POST", url: "/admin/gamenight", headers: { authorization: "Bearer a" }, payload: { action: "copy", day: "2026-01-01", user: "a" } });
    expect(broken.statusCode).toBe(500);
    expect(broken.json()).toHaveProperty("error");
  }).pipe(h.provide),
);

it.effect("an unknown route answers like Fastify's 404", () =>
  Effect.gen(function* () {
    const r = yield* (yield* build(up)).inject({ method: "GET", url: "/nope" });
    expect([r.statusCode, r.json()]).toEqual([404, { message: "Route GET:/nope not found", error: "Not Found", statusCode: 404 }]);
  }).pipe(h.provide),
);

it.effect("a tap whose handling breaks gets a private apology, not Discord's failure", () =>
  Effect.gen(function* () {
    const { pub, sign } = yield* signer();
    const app = yield* build(up, { publicKey: pub });
    const payload = JSON.stringify({ type: 3, token: "tok", data: { custom_id: "v:t3_x:fire" } }); // no user: the handler can't go on
    const r = yield* app.inject({ method: "POST", url: "/interactions", payload, headers: { "content-type": "application/json", "x-signature-ed25519": yield* sign(payload, "42"), "x-signature-timestamp": "42" } });
    expect([r.statusCode, r.json()]).toEqual([200, { type: 4, data: { content: "Something went wrong on my end 🤕 Try again in a moment.", flags: 64 } }]);
  }).pipe(h.provide),
);

it.effect("a failure of ours is reported to the owner; a request that's too large isn't", () =>
  Effect.gen(function* () {
    const alerts = yield* Alerts;
    yield* alerts.setOwner("owner");
    const { pub, sign } = yield* signer();
    const app = yield* build(up, { publicKey: pub });
    const dms = () => h.calls.filter((c) => c.method === "POST" && c.path === "/users/@me/channels");
    const huge = JSON.stringify({ type: 1, pad: "x".repeat(1_100_000) });
    yield* app.inject({ method: "POST", url: "/interactions", payload: huge, headers: { "content-type": "application/json", "x-signature-ed25519": yield* sign(huge, "42"), "x-signature-timestamp": "42" } });
    yield* alerts.settle;
    expect(dms()).toEqual([]);
    yield* app.inject({ method: "POST", url: "/admin/gamenight", headers: { authorization: "Bearer a" }, payload: { action: "copy", day: "2026-01-01", user: "a" } });
    yield* alerts.settle;
    expect(dms()).toHaveLength(1);
  }).pipe(h.provide),
);

// ---------------------------------------------------------------- as Fastify did it (plan 05, phase 5 audit)

it.effect("paths match as Fastify's did: HEAD for a GET route, case and a trailing slash count", () =>
  Effect.gen(function* () {
    const app = yield* build(up);
    const head = yield* app.inject({ method: "HEAD", url: "/health" });
    expect(head.statusCode).toBe(200);
    for (const url of ["/HEALTH", "/health/"]) {
      const r = yield* app.inject({ method: "GET", url });
      expect([r.statusCode, r.json()]).toEqual([404, { message: `Route GET:${url} not found`, error: "Not Found", statusCode: 404 }]);
    }
  }).pipe(h.provide),
);

it.effect("answers carry Fastify's content types, charset included", () =>
  Effect.gen(function* () {
    const app = yield* build(up);
    expect((yield* app.inject({ method: "GET", url: "/health" })).headers["content-type"]).toBe("application/json; charset=utf-8");
    expect((yield* app.inject({ method: "GET", url: "/" })).headers["content-type"]).toBe("text/plain; charset=utf-8");
  }).pipe(h.provide),
);

it.effect("an admin body that isn't JSON is a 400 with the reason, not an empty object", () =>
  Effect.gen(function* () {
    const r = yield* (yield* build(up)).inject({ method: "POST", url: "/admin/gamenight", headers: { authorization: "Bearer a", "content-type": "application/json" }, payload: "{not json" });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toEqual(expect.any(String));
    expect(r.json().error).not.toBe("action?"); // the body's own problem, not an empty body's missing action
  }).pipe(h.provide),
);

it.effect("a body over 1 MB is answered before the token is looked at, as Fastify read bodies first", () =>
  Effect.gen(function* () {
    const r = yield* (yield* build(up)).inject({ method: "POST", url: "/ingest", headers: { authorization: "Bearer nope" }, payload: { memes: [], pad: "x".repeat(1_100_000) } });
    expect([r.statusCode, r.json()]).toEqual([500, { error: "FastifyError [FST_ERR_CTP_BODY_TOO_LARGE]: Request body is too large" }]);
  }).pipe(h.provide),
);

it.effect("the alert test goes to the owner when no user is given", () =>
  Effect.gen(function* () {
    // the owner in the configuration, as production has it (Alerts reads it at startup, the route per call)
    const alerts = yield* Alerts;
    yield* alerts.setOwner("owner");
    const r = yield* (yield* build(up, { alertUserId: "owner" })).inject({ method: "POST", url: "/admin/gamenight", headers: { authorization: "Bearer a" }, payload: { action: "alert-test" } });
    yield* alerts.settle;
    expect(r.json()).toHaveProperty("sent");
    expect(h.calls.filter((c) => c.method === "POST" && c.path === "/users/@me/channels").map((c) => c.body?.recipient_id)).toEqual(["owner"]);
  }).pipe(h.provide),
);

it.effect("a public key that can't be read answers 500 with the reason, as before", () =>
  Effect.gen(function* () {
    const r = yield* (yield* build(up, { publicKey: "zz" })).inject({
      method: "POST",
      url: "/interactions",
      payload: "{}",
      headers: { "content-type": "application/json", "x-signature-ed25519": "a".repeat(128), "x-signature-timestamp": "42" },
    });
    expect(r.statusCode).toBe(500);
    expect(r.json().error).not.toContain("SignatureUnreadable");
    expect(r.json().error).toMatch(/Error/);
  }).pipe(h.provide),
);

it.effect("the admin schema takes what the QA scripts send, null for none included", () =>
  Effect.gen(function* () {
    const r = yield* (yield* build(up)).inject({ method: "POST", url: "/admin/gamenight", headers: { authorization: "Bearer a" }, payload: { action: "lobby", players: "qa_s1,qa_s2", where: {}, t: 1794000000, change: null } });
    expect(r.statusCode).toBe(200);
  }).pipe(h.provide),
);
