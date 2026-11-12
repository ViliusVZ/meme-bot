// Meme Bot 3000. Every running copy serves HTTP (Discord clicks, meme intake); exactly one, the
// leader, also holds the Discord gateway and runs the scheduler. During a deploy the new copy
// serves alongside the old one, and takes over leadership the moment the old one lets go.
//
// A boundary file (architecture §16): the process edge. `runMain`, the 35 s hard exit, which signal
// came, and the two last-resort handlers live here.
import { fileURLToPath } from "node:url";
import { NodeRuntime } from "@effect/platform-node";
import { Cause, Deferred, Effect, Exit, Layer, Scope } from "effect";
import { AppConfig } from "./config.js";
import { appLayer } from "./runtime.js";
import { runMigrations } from "./db/db.js";
import { server } from "./app.js";
import { Alerts } from "./alerts.js";
import { Leadership } from "./leadership.js";
import { shutdown } from "./shutdown.js";

const HARD_EXIT = 35_000; // ms: whatever hangs at shutdown, we're gone (Docker would kill us at 40 anyway; a self-restart has no Docker to)

// runMain interrupts the program on SIGTERM and SIGINT; this listener, added first, notes which came
let signal = "SIGTERM";
for (const s of ["SIGTERM", "SIGINT"] as const) process.on(s, () => void (signal = s));

const main = Effect.gen(function* () {
  const config = yield* AppConfig;
  const alerts = yield* Alerts;

  // last resort: report it; an uncaught exception also exits (Docker restarts us within seconds,
  // better than limping on), after a moment for the DM to go out
  const context = yield* Effect.context<never>();
  const report = (what: string, e: unknown) => Effect.runForkWith(context)(alerts.failed(what, e));
  process.on("unhandledRejection", (e) => report("something in the background (unhandled)", e));
  process.on("uncaughtException", (e) => {
    report("the bot itself (crashed; Docker restarts it)", e);
    // @effect-diagnostics-next-line effect/globalTimers:off the process edge: exit even if the runtime is wedged
    setTimeout(() => process.exit(1), 2000);
  });

  yield* runMigrations(fileURLToPath(new URL("../drizzle", import.meta.url)));

  const http = yield* Scope.make();
  yield* Layer.buildWithScope(server({ host: "0.0.0.0", port: config.port }), http);
  yield* Effect.logInfo(`listening on :${config.port}`);

  // a clock stuck for 5 minutes: say so, then restart ourselves (Docker starts us again)
  const stuck = yield* Deferred.make<string>();
  const onStall = (mins: number) =>
    Effect.gen(function* () {
      yield* alerts.failed("the clock (minute jobs)", `one minute's jobs have been stuck for ${mins} min, and no game-night or meme job runs while they are. Restarting myself to unstick it.`);
      yield* Effect.sleep("2 seconds"); // the DM goes out first
      yield* Deferred.succeed(stuck, "clock stuck");
    });
  const leading = yield* Effect.forkDetach((yield* Leadership).lead({ onStall }));

  const stop = (why: string) =>
    Effect.andThen(
      // @effect-diagnostics-next-line effect/globalTimersInEffect:off the hard cap must fire even if the runtime hangs
      Effect.sync(() => setTimeout(() => process.exit(1), HARD_EXIT).unref()),
      shutdown(why, { leading, server: http }),
    );
  // run until a signal (runMain interrupts us) or a stuck clock; either way, shut down in order
  yield* Deferred.await(stuck).pipe(
    Effect.flatMap(stop),
    Effect.onInterrupt(() => Effect.suspend(() => stop(signal))),
  );
});

// 5. the pool and the services close last, with the layer; then exit 0, or 1 if startup failed
// @effect-diagnostics-next-line effect/strictEffectProvide:off the application's entry point
NodeRuntime.runMain(main.pipe(Effect.provide(appLayer(AppConfig.layer))), {
  teardown: (exit, onExit) => {
    const code = Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause) ? 1 : 0;
    onExit(code);
    process.exit(code);
  },
});
