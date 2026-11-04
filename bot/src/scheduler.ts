// The leader's clock: the minute jobs at the top of every minute, and an exact timer for each game
// night about to start (room opens 10 s early, moves and ping on the second).
import type { Env } from "./env.js";
import * as jobs from "./jobs.js";
import * as gn from "./gamenight.js";

const LOOKAHEAD = 120; // seconds: nights starting this soon get their own timer

export function start(env: Env) {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<unknown> = Promise.resolve();
  const abort = new AbortController();
  const waiting = new Map<string, Promise<unknown>>(); // `${day}@${start_at}` → its start timer

  const armStarts = async () => {
    const soon = await gn.upcomingStarts(env, Math.floor(Date.now() / 1000) + LOOKAHEAD);
    for (const n of soon) {
      const key = `${n.day}@${n.start_at}`;
      if (waiting.has(key)) continue;
      const p = gn
        .startOnTime(env, n, abort.signal)
        .then((ok) => ok && console.log("started on time", n.day, n.game))
        .catch((e) => console.log("start failed", n.day, e))
        .finally(() => setTimeout(() => waiting.delete(key), 5 * 60_000).unref());
      waiting.set(key, p);
    }
  };

  const tick = async () => {
    const t0 = Date.now();
    await armStarts().catch((e) => console.log("arm starts failed", e));
    const out = await jobs.minute(env);
    const ms = Date.now() - t0;
    // quiet minutes aren't worth a log line; anything that did something (or failed) is
    const busy = Object.entries(out).filter(([, v]) => v && typeof v === "object" && Object.keys(v as object).length && !("skipped" in (v as object)));
    if (busy.length || ms > 5000) console.log("minute", ms, "ms", JSON.stringify(Object.fromEntries(busy)));
  };

  const schedule = () => {
    if (stopped) return;
    const ms = 60_000 - (Date.now() % 60_000) + 50; // just past the top of the next minute
    timer = setTimeout(() => {
      running = tick().catch((e) => console.log("minute failed", e)).finally(schedule);
    }, ms);
  };

  // catch up straight away (a restart may have skipped a minute), then every minute
  running = tick().catch((e) => console.log("minute failed", e)).finally(schedule);

  return {
    /**
     * Stop: no new minutes, and start timers that haven't fired yet stand down (the next leader
     * arms its own). A start already under way finishes first.
     */
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      abort.abort();
      await Promise.all([running, ...waiting.values()]);
    },
  };
}
