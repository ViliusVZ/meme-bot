// Stand-in players through an admin route (plan 05, verification.md §7 test 2): the players deep
// code sees are the stand-ins, and the real trio's rows are untouched.
import { expect, it } from "@effect/vitest";
import { Clock, Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { voiceSegments } from "../src/db/schema.js";
import { AppStatus, ROUTER_CONFIG, routesOn, type Status } from "../src/app.js";
import type { AppServices } from "../src/runtime.js";
import { Db } from "../src/db/db.js";
import { harness } from "./fx.js";

const h = harness({ tables: [voiceSegments], discord: { firstId: 100 }, clock: "2026-11-06T15:00:00Z" });

/** The app's routes on this test's services, answering injected requests through the web handler (as the old app object's `inject`). */
const build = (status: Status) =>
  Effect.gen(function* () {
    const ctx = yield* Effect.context<AppServices>();
    const statusLayer = Layer.succeed(AppStatus, AppStatus.of({ leader: Effect.sync(status.leader), shuttingDown: Effect.sync(status.shuttingDown), publicKey: h.env.DISCORD_PUBLIC_KEY }));
    const { handler } = HttpRouter.toWebHandler(routesOn(statusLayer, ctx).pipe(Layer.provide(HttpServer.layerServices)), { disableLogger: true, routerConfig: ROUTER_CONFIG });
    return {
      inject: (o: { method: string; url: string; payload?: unknown; headers?: Record<string, string> }) =>
        Effect.promise(async () => {
          const body = o.payload === undefined ? undefined : typeof o.payload === "string" ? o.payload : JSON.stringify(o.payload);
          const headers = { ...(body !== undefined && typeof o.payload !== "string" ? { "content-type": "application/json" } : {}), ...o.headers };
          // the request runs on this test's services, clock and logger
          const res = await handler(new Request(`http://local${o.url}`, { method: o.method, headers, body }), ctx);
          const text = await res.text();
          return { statusCode: res.status, headers: Object.fromEntries(res.headers), body: text, json: () => JSON.parse(text) };
        }),
    };
  });

it.effect("an admin stats call with stand-ins tracks only the stand-ins, though the real players are in voice too", () =>
  Effect.gen(function* () {
    const app = yield* build({ leader: () => true, shuttingDown: () => false });
    const t = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const res = yield* app.inject({
      method: "POST",
      url: "/admin/gamenight",
      headers: { authorization: `Bearer ${h.env.ADMIN_SECRET}`, "content-type": "application/json" },
      payload: JSON.stringify({ action: "stats", players: "qa-1,qa-2", track: { "qa-1": "room", "qa-2": "room", a: "room", b: "room" }, t }),
    });
    expect(res.json()).toEqual({ tracked: true });
    const rows = yield* (yield* Db).select().from(voiceSegments);
    expect(rows.map((r) => r.user_id).sort()).toEqual(["qa-1", "qa-2"]);
  }).pipe(h.provide),
);
