// The app's metrics (architecture §14). They live in the runtime's registry (`Metric.snapshot`) and
// go out over OTLP when OTLP_URL is set (runtime.ts); nothing reads them otherwise yet.
import { Cause, Duration, Exit, Metric } from "effect";

/** Taps and commands handled, by outcome ("ok", "failed"). */
export const taps = Metric.counter("taps", { description: "interactions handled", incremental: true });
/** How long a tap took to answer. */
export const tapTime = Metric.timer("tap_duration", { description: "time to answer an interaction" });

/** Jobs run each minute, by job. */
export const jobsRun = Metric.counter("jobs_run", { description: "minute jobs run", incremental: true });
/** Jobs that failed (or were cut off), by job. */
export const jobsFailed = Metric.counter("jobs_failed", { description: "minute jobs that failed", incremental: true });
/** How long each job took, by job. */
export const jobTime = Metric.timer("job_duration", { description: "time a minute job took" });

/** Discord REST calls, by outcome: "ok", or the error's tag after the retries (`DiscordNotFound`…). */
export const discordCalls = Metric.counter("discord_calls", { description: "Discord REST calls", incremental: true });

/** Alerts DMed to the owner. */
export const alertsSent = Metric.counter("alerts_sent", { description: "alert DMs sent", incremental: true });
/** Alerts not DMed, by why: "repeat" (the same problem within 3 h) or "burst" (the 10-minute cap). */
export const alertsHeld = Metric.counter("alerts_held", { description: "alerts held back", incremental: true });

/** Background tasks running now. */
export const backgroundInFlight = Metric.gauge("background_in_flight", { description: "background tasks in flight" });

/** An outcome attribute for an exit: "ok", "interrupted", or the failure's tag. */
export const outcomeOf = (exit: Exit.Exit<unknown, unknown>): string => {
  if (Exit.isSuccess(exit)) return "ok";
  if (Cause.hasInterruptsOnly(exit.cause)) return "interrupted";
  const e = Cause.squash(exit.cause);
  return typeof e === "object" && e !== null && "_tag" in e ? String(e._tag) : "defect";
};

/** Count one under these attributes. */
export const count = (metric: Metric.Counter<number>, attributes: Metric.Metric.Attributes = {}) => Metric.update(Metric.withAttributes(metric, attributes), 1);

/** Record a duration under these attributes. */
export const time = (metric: Metric.Histogram<Duration.Duration>, d: Duration.Duration, attributes: Metric.Metric.Attributes = {}) =>
  Metric.update(Metric.withAttributes(metric, attributes), d);
