// The old functions of src/app.ts, for the tests until phase 6 makes them Effect-native
// (plan 05, phase 5 step 8: the transition left src; the tests change only their imports).
export * from "../../src/app.js";
import { appContext } from "./legacy.js";
import { AppStatus, ROUTER_CONFIG, type Status } from "../../src/app.js";
import { HttpRouter, HttpServer } from "effect/http";
import type { Env } from "./env.js";
import { Context, Effect, Layer } from "effect";
import { AppServices } from "../../src/runtime.js";
import { routesOn } from "../../src/app.js";

/** The old app object, for the tests: they inject requests (Fastify's `inject`, over the web handler). */
export function build(env: Env, status: Status) {
  const statusLayer = Layer.succeed(AppStatus, AppStatus.of({ leader: Effect.sync(status.leader), shuttingDown: Effect.sync(status.shuttingDown), publicKey: env.DISCORD_PUBLIC_KEY }));
  const webOn = (ctx: Context.Context<AppServices>) => HttpRouter.toWebHandler(routesOn(statusLayer, ctx).pipe(Layer.provide(HttpServer.layerServices)), { disableLogger: true, routerConfig: ROUTER_CONFIG });
  let web: Promise<ReturnType<typeof webOn>> | null = null;
  return {
    async inject(o: { method: string; url: string; payload?: unknown; headers?: Record<string, string> }) {
      web ??= appContext().then(webOn);
      const { handler } = await web;
      const body = o.payload === undefined ? undefined : typeof o.payload === "string" ? o.payload : JSON.stringify(o.payload);
      const headers = { ...(body !== undefined && typeof o.payload !== "string" ? { "content-type": "application/json" } : {}), ...o.headers };
      const res = await handler(new Request(`http://local${o.url}`, { method: o.method, headers, body }));
      const text = await res.text();
      return { statusCode: res.status, headers: Object.fromEntries(res.headers), body: text, json: () => JSON.parse(text) };
    },
  };
}
