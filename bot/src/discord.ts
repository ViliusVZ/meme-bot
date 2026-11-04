import type { Env } from "./env.js";

const API = "https://discord.com/api/v10";

export const IS_COMPONENTS_V2 = 1 << 15;
export const EPHEMERAL = 1 << 6;

/** Interaction response types. */
export const Response = {
  Pong: 1,
  Message: 4,
  DeferredMessage: 5,
  DeferredUpdate: 6,
  UpdateMessage: 7,
  Autocomplete: 8,
  Modal: 9,
} as const;

const keys = new Map<string, Promise<import("node:crypto").webcrypto.CryptoKey>>();

/** Discord signs every interaction; anything that doesn't verify is rejected. */
export async function verifySignature(sig: string | undefined, ts: string | undefined, body: string, publicKey: string) {
  if (!sig || !ts || !/^[0-9a-f]{128}$/i.test(sig)) return false;
  if (!keys.has(publicKey)) keys.set(publicKey, crypto.subtle.importKey("raw", hex(publicKey), { name: "Ed25519" }, false, ["verify"]));
  return crypto.subtle.verify("Ed25519", await keys.get(publicKey)!, hex(sig), new TextEncoder().encode(ts + body));
}

function hex(s: string) {
  return new Uint8Array(s.match(/../g)!.map((h) => parseInt(h, 16)));
}

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

/**
 * Discord REST call with the bot token. Rate limits are always retried. 5xx and network errors are
 * retried too, except for POST: a POST that failed with a 5xx may still have gone through, and
 * retrying would duplicate a message, channel or event. Callers of POST handle failure themselves.
 */
export async function api(env: Env, method: string, path: string, body?: unknown): Promise<any> {
  let last = "";
  const idempotent = method !== "POST";
  for (let attempt = 0; attempt < 4; attempt++) {
    let r: globalThis.Response;
    try {
      r = await fetch(API + path, {
        method,
        headers: {
          Authorization: `Bot ${env.DISCORD_TOKEN}`,
          "Content-Type": "application/json",
          "User-Agent": "DiscordBot (https://github.com/ViliusVZ/meme-bot, 3.0)",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      last = String(e);
      if (!idempotent) break;
      await sleep(300 * 2 ** attempt);
      continue;
    }
    if (r.status === 429) {
      const { retry_after = 1 } = (await r.json().catch(() => ({}))) as { retry_after?: number };
      last = "rate limited";
      await sleep(Math.min(retry_after, 10) * 1000 + 100);
      continue;
    }
    if (r.status >= 500) {
      last = `${r.status}`;
      if (!idempotent) break;
      await sleep(300 * 2 ** attempt);
      continue;
    }
    if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${await r.text()}`);
    return r.status === 204 ? null : r.json();
  }
  throw new Error(`${method} ${path} -> gave up: ${last}`);
}

/** True when an api() error is Discord's 404 (the thing is gone). */
export const isNotFound = (e: unknown) => / -> 404 /.test(String(e));

/**
 * Webhook calls tied to an interaction (followups, @original). These run in the background, which
 * can start before Discord has processed our reply, so a 404 means "not yet": wait and try again.
 */
async function webhook(url: string, init: RequestInit) {
  let r: globalThis.Response | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await sleep(400 * attempt);
    r = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) }).catch(() => null);
    if (r && r.status !== 404 && r.status !== 429 && r.status < 500) return r;
  }
  if (r && !r.ok) console.log("webhook failed", init.method, url.split("/webhooks/")[1]?.slice(0, 30), r.status);
  return r;
}

/** Interaction webhooks (followups, @original) don't need the bot token. */
export function followup(env: Env, token: string, body: unknown) {
  return webhook(`${API}/webhooks/${env.DISCORD_APP_ID}/${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Fill in a deferred ("thinking…") interaction response. */
export function editOriginal(env: Env, token: string, body: unknown) {
  return webhook(`${API}/webhooks/${env.DISCORD_APP_ID}/${token}/messages/@original`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function originalMessage(env: Env, token: string): Promise<{ id: string; channel_id: string }> {
  const r = await webhook(`${API}/webhooks/${env.DISCORD_APP_ID}/${token}/messages/@original`, { method: "GET" });
  if (!r?.ok) throw new Error(`@original -> ${r?.status}`);
  return r.json() as Promise<{ id: string; channel_id: string }>;
}

export function messageLink(guildId: string, channelId: string, messageId: string) {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

export function avatarUrl(user: { id: string; avatar?: string | null }) {
  if (user.avatar) return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`;
  return `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(user.id) >> 22n) % 6n)}.png`;
}

/** Escape markdown so meme titles like `*args` or `__init__` render literally. */
export function esc(s: string) {
  return s.replace(/([\\*_~`|>\[\]()#-])/g, "\\$1");
}
