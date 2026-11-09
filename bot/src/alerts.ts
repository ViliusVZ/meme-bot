// 🚨 When something breaks (a card that didn't post, a start that missed its second, a tap that
// errored, a crash), the bot DMs its owner (ALERT_USER_ID, set for production only) so they hear
// about it before the trio does. The same problem again within 3 hours is counted, not re-sent, and
// there's a cap overall, so a bad day is a handful of DMs, never a flood.
import type { Env } from "./env.js";
import { api } from "./discord.js";
import * as presence from "./presence.js";

const QUIET_FOR = 3 * 3600_000; // the same problem again within this: counted, mentioned next time
const BURST = 5; // at most this many DMs…
const BURST_WINDOW = 10 * 60_000; // …in any 10 minutes
const GATEWAY_GRACE = 5 * 60; // seconds without the gateway before it's worth a DM (reconnects take seconds)

let owner: Env | null = null;
const seen = new Map<string, { at: number; held: number }>();
let recent: number[] = [];
let heldBack = 0;

/** Turn DMs on (main.ts); without ALERT_USER_ID (the test bot, tests) failures are only logged. */
export function setup(env: Env) {
  owner = env.ALERT_USER_ID ? env : null;
}

/** Log a failure the way we always have (`<what> failed …`), and DM the owner about it. */
export function failed(what: string, error: unknown, ...context: unknown[]) {
  console.log(`${what} failed`, ...context, error);
  report(what, error, context);
}

let queue: Promise<void> = Promise.resolve();

/** DM the owner about a problem (logged by the caller). Never throws; DMs go out one at a time. */
export function report(what: string, error: unknown, context: unknown[] = []) {
  if (!owner) return;
  const env = owner;
  queue = queue.then(() => send(env, what, error, context)).catch((e) => console.log("alert DM failed", String(e)));
}

async function send(env: Env, what: string, error: unknown, context: unknown[]) {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  // the same failure on another day or channel is still the same problem
  const key = `${what}|${detail.split("\n")[0].replace(/\d+/g, "#").slice(0, 160)}`;
  const now = Date.now();
  const last = seen.get(key);
  if (last && now - last.at < QUIET_FOR) {
    last.held++;
    return;
  }
  recent = recent.filter((t) => now - t < BURST_WINDOW);
  if (recent.length >= BURST) {
    heldBack++;
    return;
  }
  recent.push(now);
  seen.set(key, { at: now, held: 0 });
  const again = last?.held ? ` (${last.held} more time${last.held === 1 ? "" : "s"} since the last DM about it)` : "";
  const flood = heldBack ? `\n-# ${heldBack} other problem${heldBack === 1 ? " was" : "s were"} held back so this doesn't turn into a flood; the logs have them.` : "";
  heldBack = 0;
  await dm(env, env.ALERT_USER_ID!, alertMessage(what, detail, context, again) + flood);
}

/** The DM itself: what broke, where, the error, and how to read the logs. */
export function alertMessage(what: string, detail: string, context: unknown[] = [], again = "") {
  const where = context.length ? ` · ${context.map(String).join(" · ")}` : "";
  const app = process.env.APP_NAME ?? "meme-bot";
  const logs = app.replace(/-(blue|green)$/, ""); // app-logs covers both colours, across deploys
  const lines = detail.split("\n").slice(0, 6).join("\n").slice(0, 1200);
  return [
    `🚨 **${what}** failed${where}${again}`,
    "```",
    lines,
    "```",
    `-# ${app} · <t:${Math.floor(Date.now() / 1000)}:f> · logs: \`ssh vps app-logs ${logs} 1h\``,
  ].join("\n");
}

const dmChannels = new Map<string, string>();

async function dm(env: Env, to: string, content: string) {
  let ch = dmChannels.get(to);
  if (!ch) {
    ch = (await api(env, "POST", "/users/@me/channels", { recipient_id: to })).id as string;
    dmChannels.set(to, ch);
  }
  return api(env, "POST", `/channels/${ch}/messages`, { content, allowed_mentions: { parse: [] } });
}

/** 🧪 The admin route's test: proves DMs reach someone (the owner by default). */
export async function test(env: Env, to?: string) {
  const who = to ?? env.ALERT_USER_ID;
  if (!who) return { skipped: "no ALERT_USER_ID and no user given" };
  await dm(env, who, "🧪 Test alert from Meme Bot 3000: if something breaks, I'll DM you here, like this. Nothing's wrong right now.");
  return { sent: who };
}

let gatewayDown: number | null = null;
let gatewayReported = false;

/**
 * A minute job: the leader holds the Discord gateway for live voice (Lobby pulls, room wrap-ups,
 * stats). It reconnects on its own within seconds; if it's still down after 5 minutes, say so.
 */
export async function watchGateway(_env: Env) {
  const t = Math.floor(Date.now() / 1000);
  if (presence.isReady()) {
    gatewayDown = null;
    gatewayReported = false;
    return {};
  }
  gatewayDown ??= t;
  if (gatewayReported || t - gatewayDown < GATEWAY_GRACE) return {};
  gatewayReported = true;
  const mins = Math.round((t - gatewayDown) / 60);
  console.log("gateway down", mins, "min");
  report("staying connected to Discord", `no gateway connection for ${mins} min: Lobby pulls, room wrap-ups and voice stats fall back to slower checks until it's back`);
  return { gatewayDown: mins };
}

/** Tests: wait for queued DMs. */
export const _settle = () => queue;

/** Tests: forget throttles and the DM channel. */
export function _reset() {
  seen.clear();
  recent = [];
  heldBack = 0;
  dmChannels.clear();
  gatewayDown = null;
  gatewayReported = false;
}
