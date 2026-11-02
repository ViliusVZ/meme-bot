import type { Env } from "./index";

const API = "https://discord.com/api/v10";

export const IS_COMPONENTS_V2 = 1 << 15;
export const EPHEMERAL = 1 << 6;

export const enum Response {
  Pong = 1,
  Message = 4,
  DeferredMessage = 5,
  UpdateMessage = 7,
}

export async function verifySignature(req: Request, body: string, publicKey: string) {
  const sig = req.headers.get("x-signature-ed25519");
  const ts = req.headers.get("x-signature-timestamp");
  if (!sig || !ts) return false;
  const key = await crypto.subtle.importKey("raw", hex(publicKey), { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify("Ed25519", key, hex(sig), new TextEncoder().encode(ts + body));
}

function hex(s: string) {
  return new Uint8Array(s.match(/../g)!.map((h) => parseInt(h, 16)));
}

/** Discord REST call with the bot token; retries on rate limits. */
export async function api(env: Env, method: string, path: string, body?: unknown): Promise<any> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(API + path, {
      method,
      headers: {
        Authorization: `Bot ${env.DISCORD_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "DiscordBot (https://github.com/ViliusVZ/meme-bot, 3.0)",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (r.status === 429) {
      const { retry_after = 1 } = (await r.json()) as { retry_after?: number };
      await new Promise((ok) => setTimeout(ok, retry_after * 1000 + 100));
      continue;
    }
    if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${await r.text()}`);
    return r.status === 204 ? null : r.json();
  }
  throw new Error(`${method} ${path} -> still rate limited`);
}

/** Interaction webhooks (followups, @original) don't need the bot token. */
export function followup(env: Env, token: string, body: unknown) {
  return fetch(`${API}/webhooks/${env.DISCORD_APP_ID}/${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function originalMessage(env: Env, token: string): Promise<{ id: string; channel_id: string }> {
  const r = await fetch(`${API}/webhooks/${env.DISCORD_APP_ID}/${token}/messages/@original`);
  if (!r.ok) throw new Error(`@original -> ${r.status}`);
  return r.json();
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
