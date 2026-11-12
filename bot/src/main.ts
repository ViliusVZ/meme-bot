// Meme Bot 3000. Every running copy serves HTTP (Discord clicks, meme intake); exactly one, the
// leader, also holds the Discord gateway and runs the scheduler. During a deploy the new copy
// serves alongside the old one, and takes over leadership the moment the old one lets go.
//
// A boundary file (architecture §16): the process edge. The 35 s hard exit, the signal handlers and
// the two last-resort handlers live here.
import { fileURLToPath } from "node:url";
import { Deferred, Effect, Layer, ManagedRuntime, Scope } from "effect";
import { AppConfig } from "./config.js";
import { appLayer } from "./runtime.js";
import { runMigrations } from "./db/db.js";
import { server } from "./app.js";
import { Alerts } from "./alerts.js";
import { Leadership } from "./leadership.js";
import { shutdown } from "./shutdown.js";

const HARD_EXIT = 35_000; // ms: whatever hangs at shutdown, we're gone (Docker would kill us at 40 anyway; a self-restart has no Docker to)

/** SIGTERM or SIGINT, whichever comes first. */
const signalled = Effect.callback<string>((resume) => {
  const on = (s: string) => () => resume(Effect.succeed(s));
  const term = on("SIGTERM");
  const int = on("SIGINT");
  process.once("SIGTERM", term);
  process.once("SIGINT", int);
  return Effect.sync(() => {
    process.off("SIGTERM", term);
    process.off("SIGINT", int);
  });
});

const main = Effect.gen(function* () {
  const config = yield* AppConfig;
  const alerts = yield* Alerts;
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

  const signal = yield* Effect.raceFirst(signalled, Deferred.await(stuck));
  yield* Effect.sync(() => setTimeout(() => process.exit(1), HARD_EXIT).unref());
  yield* shutdown(signal, { leading, server: http });
});

// reading the configuration fails startup with every missing variable named
const runtime = ManagedRuntime.make(appLayer(AppConfig.layer)); // LEGACY-BRIDGE

const alert = (what: string, e: unknown) => runtime.runFork(Alerts.use((a) => a.failed(what, e))); // LEGACY-BRIDGE
process.on("unhandledRejection", (e) => alert("something in the background (unhandled)", e));
// last resort: log it and exit, Docker restarts us within seconds (better than limping on); the DM
// gets a moment to go out first
process.on("uncaughtException", (e) => {
  alert("the bot itself (crashed; Docker restarts it)", e);
  setTimeout(() => process.exit(1), 2000);
});

await runtime.runPromise(main); // LEGACY-BRIDGE
await runtime.dispose(); // 5. the pool and the services, last // LEGACY-BRIDGE
process.exit(0);
