// Phase 7, "read the traces": a tap, a minute and a card are each one trace under a named root,
// the tap's saying what was tapped and by whom (architecture §14).
import { expect, it } from "@effect/vitest";
import { Effect, Option, Tracer } from "effect";
import { GameNight } from "../src/gamenight.js";
import { Interactions } from "../src/interactions.js";
import { Jobs } from "../src/jobs.js";
import { harness } from "./fx.js";

const h = harness({ discord: { firstId: 95000 }, clock: "2026-11-10T17:00:00Z" });

/** Run `effect` under a tracer that keeps its spans; the roots' names and attributes. */
const roots = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const spans: Tracer.NativeSpan[] = [];
    const tracer = Tracer.make({
      span(o) {
        const s = new Tracer.NativeSpan(o);
        spans.push(s);
        return s;
      },
    });
    yield* effect.pipe(Effect.withTracer(tracer));
    return spans.filter((s) => Option.isNone(s.parent)).map((s) => [s.name, Object.fromEntries(s.attributes)]);
  });

it.effect("a tap is one trace, saying what was tapped and by whom", () =>
  Effect.gen(function* () {
    const tap = { type: 2, token: "tok", data: { name: "meme" }, member: { user: { id: "a", username: "a" } } };
    expect(yield* roots(Interactions.use((x) => x.handle(tap)))).toEqual([["Interactions.handle", { tapped: "/meme", by: "a" }]]);
  }).pipe(h.provide),
);

it.effect("a minute is one trace", () =>
  Effect.gen(function* () {
    expect((yield* roots(Jobs.use((j) => j.minute))).map(([name]) => name)).toEqual(["minute"]);
  }).pipe(h.provide),
);

it.effect("posting a card is one trace", () =>
  Effect.gen(function* () {
    expect(yield* roots(GameNight.use((g) => g.startNight("a")))).toEqual([["GameNight.startNight", { by: "a", day: "today" }]]);
  }).pipe(h.provide),
);
