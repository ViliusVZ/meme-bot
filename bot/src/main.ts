// Meme Bot 3000. Every running copy serves HTTP (Discord clicks, meme intake); exactly one, the
// leader, also holds the Discord gateway and runs the scheduler. During a deploy the new copy
// serves alongside the old one, and takes over leadership the moment the old one lets go.
import { fileURLToPath } from "node:url";
import { connect, runMigrations, acquireLeadership } from "./db/index.js";
import { loadConfig, type Env } from "./env.js";
import { build } from "./app.js";
import { drain } from "./background.js";
import * as gateway from "./gateway.js";
import * as live from "./live.js";
import * as scheduler from "./scheduler.js";
import * as alerts from "./alerts.js";

const config = loadConfig();
const { pool, db } = connect(config.DATABASE_URL);
const env: Env = { ...config, db };
alerts.setup(env);

await runMigrations(pool, fileURLToPath(new URL("../drizzle", import.meta.url)));

let leader = false;
let shuttingDown = false;
const app = build(env, { leader: () => leader, shuttingDown: () => shuttingDown });
await app.listen({ host: "0.0.0.0", port: config.PORT });
console.log(`listening on :${config.PORT}`);

// ---------------------------------------------------------------- leadership
const stopLeading = new AbortController();

async function lead() {
  while (!stopLeading.signal.aborted) {
    let lost!: () => void;
    const lostP = new Promise<void>((ok) => (lost = ok));
    const lock = await acquireLeadership(pool, () => lost(), stopLeading.signal);
    if (!lock) return;
    leader = true;
    console.log("leader: took over");
    const done = new AbortController();
    const watcher = live.start(env);
    const clock = scheduler.start(env);
    // the gateway connects in the background, retrying with back-off (say, Discord is down); until
    // it's up, voice lookups fall back to REST and everything else carries on as normal
    const gw = connectGateway(() => void watcher.resync(), done.signal);
    // lead until we lose the lock (connection died) or shut down
    await Promise.race([lostP, new Promise<void>((ok) => stopLeading.signal.addEventListener("abort", () => ok(), { once: true }))]);
    leader = false;
    done.abort();
    await (await gw)?.close().catch((e) => console.log("gateway close", e));
    await Promise.all([clock.stop(), watcher.stop()]).catch((e) => console.log("leader: stop failed", e));
    await lock.release();
    console.log("leader: stepped down");
    if (!stopLeading.signal.aborted) await new Promise((ok) => setTimeout(ok, 2000));
  }
}

async function connectGateway(onSnapshot: () => void, signal: AbortSignal) {
  for (let attempt = 0; !signal.aborted; attempt++) {
    try {
      const gw = await gateway.connect(env, onSnapshot, signal);
      if (signal.aborted) {
        await gw.close();
        return null;
      }
      return gw;
    } catch (e) {
      const wait = Math.min(60_000, 2000 * 2 ** attempt);
      console.log(`gateway: connect failed, retrying in ${wait / 1000} s`, String(e));
      await new Promise<void>((ok) => {
        const t = setTimeout(ok, wait);
        signal.addEventListener("abort", () => (clearTimeout(t), ok()), { once: true });
      });
    }
  }
  return null;
}
const leading = lead();

// ---------------------------------------------------------------- shutdown
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal}: shutting down`);
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
