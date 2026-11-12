// The metrics (architecture §14): jobs, Discord calls, alerts and background work are counted, and
// OTLP_URL switches the export on (and nothing goes out without it).
import { expect, it } from "@effect/vitest";
import { Deferred, Duration, Effect, Layer, ManagedRuntime, Metric, Option } from "effect";
import { OtlpExporter } from "effect/observability";
import { HttpClient, HttpClientResponse } from "effect/http";
import { Alerts } from "../src/alerts.js";
import { Background } from "../src/background.js";
import { AppConfig } from "../src/config.js";
import { Discord } from "../src/discord.js";
import { Jobs } from "../src/jobs.js";
import { alertsHeld, alertsSent, backgroundInFlight, discordCalls, jobsFailed, jobsRun, jobTime } from "../src/metrics.js";
import { OtlpLive } from "../src/runtime.js";
import { harness, json } from "./fx.js";

const h = harness({ discord: { firstId: 70000 }, clock: "2026-11-06T01:05:00Z" }); // 03:05 in Vilnius: the sweep's time

const counted = (m: Metric.Counter<number>, attributes: Metric.Metric.Attributes = {}) => Effect.map(Metric.value(Metric.withAttributes(m, attributes)), (s) => s.count);

it.effect("a minute counts each job run and how long it took; a failing job is counted as failed", () =>
  Effect.gen(function* () {
    h.override = (c) => {
      if (c.path === "/users/@me") return json({ id: "bot" });
      if (c.method === "GET" && c.path.startsWith("/channels/gn/messages")) return json({ message: "Missing Access", code: 50001 }, 403);
      return undefined;
    };
    const before = { run: yield* counted(jobsRun, { job: "gateway" }), failed: yield* counted(jobsFailed, { job: "cleanup" }), ok: yield* counted(jobsFailed, { job: "gateway" }) };
    const timed = (yield* Metric.value(Metric.withAttributes(jobTime, { job: "gateway" }))).count;
    yield* Jobs.use((j) => j.minute);
    expect(yield* counted(jobsRun, { job: "gateway" })).toBe(before.run + 1);
    expect((yield* Metric.value(Metric.withAttributes(jobTime, { job: "gateway" }))).count).toBe(timed + 1);
    expect(yield* counted(jobsFailed, { job: "cleanup" })).toBe(before.failed + 1);
    expect(yield* counted(jobsFailed, { job: "gateway" })).toBe(before.ok); // one that worked isn't
  }).pipe(h.provide),
);

it.effect("Discord calls are counted by outcome: ok, or the error's name", () =>
  Effect.gen(function* () {
    h.override = (c) => (c.path === "/channels/gone/messages/1" ? json({ message: "Unknown Message", code: 10008 }, 404) : undefined);
    const ok = yield* counted(discordCalls, { outcome: "ok" });
    const gone = yield* counted(discordCalls, { outcome: "DiscordNotFound" });
    const discord = yield* Discord;
    yield* discord.request("GET", "/channels/here/messages/1");
    yield* discord.request("GET", "/channels/gone/messages/1").pipe(Effect.catchTag("DiscordNotFound", () => Effect.void));
    expect(yield* counted(discordCalls, { outcome: "ok" })).toBe(ok + 1);
    expect(yield* counted(discordCalls, { outcome: "DiscordNotFound" })).toBe(gone + 1);
  }).pipe(h.provide),
);

it.effect("alerts: one sent, the same problem again held back as a repeat", () =>
  Effect.gen(function* () {
    const alerts = yield* Alerts;
    yield* alerts.setOwner("owner");
    const sent = yield* counted(alertsSent);
    const held = yield* counted(alertsHeld, { why: "repeat" });
    yield* alerts.failed("posting the card", new Error("boom"));
    yield* alerts.failed("posting the card", new Error("boom"));
    yield* alerts.settle;
    expect(yield* counted(alertsSent)).toBe(sent + 1);
    expect(yield* counted(alertsHeld, { why: "repeat" })).toBe(held + 1);
  }).pipe(h.provide),
);

it.effect("background work in flight: up while a task runs, back down when it's done", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const background = yield* Background;
    yield* background.run(Deferred.await(gate));
    expect((yield* Metric.value(backgroundInFlight)).value).toBe(1);
    yield* Deferred.succeed(gate, undefined);
    yield* h.settle;
    expect((yield* Metric.value(backgroundInFlight)).value).toBe(0);
  }).pipe(h.provide),
);

// ---------------------------------------------------------------- the export

/** The export layer alone, on this configuration, with every request it makes kept. */
const exporting = (otlpUrl: string | undefined) => {
  const sent: string[] = [];
  const client = HttpClient.make((request) => Effect.sync(() => (sent.push(`${request.method} ${request.url}`), HttpClientResponse.fromWeb(request, new Response("{}", { status: 200 })))));
  const layer = OtlpLive.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(AppConfig, { ...h.config, otlpUrl }), Layer.succeed(HttpClient.HttpClient, client))));
  return { sent, runtime: ManagedRuntime.make(layer) };
};

it.effect("OTLP_URL set: spans go to the collector (sent on shutdown at the latest)", () =>
  Effect.gen(function* () {
    const { sent, runtime } = exporting("http://otel.test");
    expect(Option.isSome(yield* Effect.promise(() => runtime.runPromise(Effect.serviceOption(OtlpExporter.Flusher))))).toBe(true);
    yield* Effect.promise(() => runtime.runPromise(Effect.withSpan(Effect.void, "a job")));
    yield* Effect.promise(() => runtime.dispose());
    expect(sent).toContain("POST http://otel.test/v1/traces");
  }),
);

it.effect("OTLP_URL unset: no exporter at all, and nothing is sent anywhere", () =>
  Effect.gen(function* () {
    const { sent, runtime } = exporting(undefined);
    expect(Option.isNone(yield* Effect.promise(() => runtime.runPromise(Effect.serviceOption(OtlpExporter.Flusher))))).toBe(true);
    yield* Effect.promise(() => runtime.runPromise(Effect.withSpan(Effect.void, "a job")));
    yield* Effect.promise(() => runtime.dispose());
    expect(sent).toEqual([]);
  }),
);

it.effect("background work in flight: a task interrupted (drain out of time) is counted down too", () =>
  Effect.gen(function* () {
    const background = yield* Background;
    const before = (yield* Metric.value(backgroundInFlight)).value;
    yield* background.run(Effect.never);
    expect((yield* Metric.value(backgroundInFlight)).value).toBe(before + 1);
    expect(yield* background.drain(Duration.millis(20))).toBe(1);
    yield* Effect.sleep(Duration.millis(50));
    expect((yield* Metric.value(backgroundInFlight)).value).toBe(before);
  }).pipe(h.provide),
);
