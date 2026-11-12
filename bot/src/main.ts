// Meme Bot 3000. Every running copy serves HTTP (Discord clicks, meme intake); exactly one, the
// leader, also holds the Discord gateway and runs the scheduler. During a deploy the new copy
// serves alongside the old one, and takes over leadership the moment the old one lets go.
import { fileURLToPath } from "node:url";
import { connect, acquireLeadership } from "./db/index.js";
import { runMigrations } from "./db/db.js";
import { ManagedRuntime, Redacted } from "effect"; // LEGACY-BRIDGE
import type { Env } from "./env.js";
import { AppConfig } from "./config.js";
import { appLayer } from "./runtime.js";
import * as legacy from "./legacy.js"; // LEGACY-BRIDGE
import { build } from "./app.js";
import { drain } from "./background.js";
import * as gateway from "./gateway.js";
import * as live from "./live.js";
import * as scheduler from "./scheduler.js";
import * as alerts from "./alerts.js";
import * as lifecycle from "./lifecycle.js"; // LEGACY-BRIDGE

// one runtime for the transition: the Effect services, which the code that still takes `env` reaches
// through legacy.ts. Reading the configuration fails startup with every missing variable named.
const runtime = ManagedRuntime.make(appLayer(AppConfig.layer)); // LEGACY-BRIDGE
legacy.install(runtime); // LEGACY-BRIDGE
const config = await runtime.runPromise(AppConfig); // LEGACY-BRIDGE
const { pool, db } = connect(Redacted.value(config.databaseUrl)); // LEGACY-BRIDGE
const env: Env = { ...legacy.envFields(config), db }; // LEGACY-BRIDGE
alerts.setup(env);

await legacy.run(env, runMigrations(fileURLToPath(new URL("../drizzle", import.meta.url)))); // LEGACY-BRIDGE

const app = build(env, { leader: lifecycle.isLeader, shuttingDown: lifecycle.isShuttingDown }); // LEGACY-BRIDGE
await app.listen({ host: "0.0.0.0", port: config.port });
console.log(`listening on :${config.port}`);

// ---------------------------------------------------------------- leadership
const stopLeading = new AbortController();

async function lead() {
  while (!stopLeading.signal.aborted) {
    let lost!: () => void;
    const lostP = new Promise<void>((ok) => (lost = ok));
    const lock = await acquireLeadership(pool, () => lost(), stopLeading.signal);
    if (!lock) return;
    lifecycle.setLeader(true); // LEGACY-BRIDGE
    console.log("leader: took over");
    const done = new AbortController();
    const watcher = live.start(env);
    const clock = scheduler.start(env, {
      onStall: (mins) => {
        alerts.failed("the clock (minute jobs)", `one minute's jobs have been stuck for ${mins} min, and no game-night or meme job runs while they are. Restarting myself to unstick it.`);
        setTimeout(() => void shutdown("clock stuck"), 2000); // the DM goes out first; Docker starts us again
      },
    });
    // the gateway connects in the background, retrying with back-off (say, Discord is down); until
    // it's up, voice lookups fall back to REST and everything else carries on as normal
    const gw = gateway.start(env, () => void watcher.resync());
    // lead until we lose the lock (connection died) or shut down
    await Promise.race([lostP, new Promise<void>((ok) => stopLeading.signal.addEventListener("abort", () => ok(), { once: true }))]);
    lifecycle.setLeader(false); // LEGACY-BRIDGE
    done.abort();
    await gw.close().catch((e) => console.log("gateway close", e));
    await Promise.all([clock.stop(), watcher.stop()]).catch((e) => console.log("leader: stop failed", e));
    await lock.release();
    console.log("leader: stepped down");
    if (!stopLeading.signal.aborted) await new Promise((ok) => setTimeout(ok, 2000));
  }
}

const leading = lead();

// ---------------------------------------------------------------- shutdown
async function shutdown(signal: string) {
  if (lifecycle.isShuttingDown()) return; // LEGACY-BRIDGE
  lifecycle.markShuttingDown(); // LEGACY-BRIDGE
  console.log(`${signal}: shutting down`);
  // whatever hangs below, we're gone in 35 s (Docker would kill us at 40 anyway; a self-restart has no Docker to)
  setTimeout(() => process.exit(1), 35_000).unref();
  // 1. stop leading, so the other copy can take over the gateway and the clock right away; meanwhile
  //    /health says 503, and within one health check (2 s) Caddy sends new clicks to the other copy
  stopLeading.abort();
  const capped = Promise.race([leading, new Promise((ok) => setTimeout(ok, 15_000))]); // never hang here
  await Promise.all([capped, new Promise((ok) => setTimeout(ok, 3000))]);
  // 2. stop taking requests and finish what's in flight
  await app.close();
  const left = await drain(20_000);
  if (left) console.log(`exiting with ${left} background task(s) unfinished`);
  await pool.end();
  await runtime.dispose(); // the Effect pool and services, last // LEGACY-BRIDGE
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (e) => alerts.failed("something in the background (unhandled)", e));
// last resort: log it and exit, Docker restarts us within seconds (better than limping on); the DM
// gets a moment to go out first
process.on("uncaughtException", (e) => {
  alerts.failed("the bot itself (crashed; Docker restarts it)", e);
  setTimeout(() => process.exit(1), 2000);
});
