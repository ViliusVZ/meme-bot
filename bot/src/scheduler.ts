// The leader's clock: the minute jobs at the top of every minute, and an exact timer for each game
// night about to start (room opens 10 s early, moves and ping on the second).
import type { Env } from "./env.js";
import * as jobs from "./jobs.js";
import * as gn from "./gamenight.js";
import * as alerts from "./alerts.js";

const LOOKAHEAD = 120; // seconds: nights starting this soon get their own timer
const STALL = 5 * 60_000; // one minute's jobs running this long are stuck (every call has a timeout, so it's a bug)

let lastTick: number | null = null; // when this copy's clock last finished a minute (null: it has none)

/** Seconds since this copy's clock last finished a minute; null when it isn't running one (a follower). */
export const sinceTick = () => (lastTick === null ? null : Math.round((Date.now() - lastTick) / 1000));

export interface ClockOptions {
  /** One minute's jobs have been stuck this many minutes; everything after them waits meanwhile. */
  onStall?: (mins: number) => void;
  minute?: (env: Env) => Promise<Record<string, unknown>>;
}

export function start(env: Env, opts: ClockOptions = {}) {
  const minute = opts.minute ?? jobs.minute;
  lastTick = Date.now();
  let tickStarted: number | null = null;
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
        .catch((e) => alerts.failed("starting the game night on time", e, n.day))
        .finally(() => setTimeout(() => waiting.delete(key), 5 * 60_000).unref());
      waiting.set(key, p);
    }
  };

  const tick = async () => {
    const t0 = (tickStarted = Date.now());
    try {
      await armStarts().catch((e) => alerts.failed("lining up the exact start", e));
      const out = await minute(env);
      const ms = Date.now() - t0;
      // quiet minutes aren't worth a log line; anything that did something (or failed) is
      const busy = Object.entries(out).filter(([, v]) => isBusy(v));
      if (busy.length || ms > 5000) console.log("minute", ms, "ms", JSON.stringify(Object.fromEntries(busy)));
    } finally {
      tickStarted = null;
      lastTick = Date.now();
    }
  };

  // a stuck minute holds up every minute after it, silently: say so once, and let the owner act
  let stalled = false;
  const watchdog = setInterval(() => {
    if (tickStarted === null || stalled || Date.now() - tickStarted < STALL) return;
    stalled = true;
    opts.onStall?.(Math.round((Date.now() - tickStarted) / 60_000));
  }, 30_000);
  watchdog.unref();

  const schedule = () => {
    if (stopped) return;
    const ms = 60_000 - (Date.now() % 60_000) + 50; // just past the top of the next minute
    timer = setTimeout(() => {
      running = tick().catch((e) => alerts.failed("the minute jobs", e)).finally(schedule);
    }, ms);
  };

  // catch up straight away (a restart may have skipped a minute), then every minute
  running = tick().catch((e) => alerts.failed("the minute jobs", e)).finally(schedule);

  return {
    /**
     * Stop: no new minutes, and start timers that haven't fired yet stand down (the next leader
     * arms its own). A start already under way finishes first.
     */
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      clearInterval(watchdog);
      lastTick = null;
      abort.abort();
      await Promise.all([running, ...waiting.values()]);
    },
  };
}

/** A job result worth a log line: it did something or failed (not skipped, not "already posted"). */
function isBusy(v: unknown) {
  if (!v || typeof v !== "object" || !Object.keys(v).length) return false;
  return !("skipped" in v) && (v as { started?: boolean }).started !== false;
}
