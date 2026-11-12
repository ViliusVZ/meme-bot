// The old functions of src/discord.ts, for the tests until phase 6 makes them Effect-native
// (plan 05, phase 5 step 8: the transition left src; the tests change only their imports).
export * from "../../src/discord.js";
import { run } from "../../src/legacy.js";
import { Discord, DiscordError, Response, WebhookResult } from "../../src/discord.js";
import type { Env } from "../../src/env.js";
import { Effect } from "effect";
import { Channel } from "../../src/channels.js";

/** Today's error, as text: "<METHOD> <path> -> 404 <body>" etc., which old callers match on. */
const asOldError = (e: DiscordError) => new Error(e.message);
/** Discord REST call with the bot token (the Discord service's rules). */
export async function api(env: Env, method: string, path: string, body?: unknown): Promise<any> {
  return run(env, Discord.use((d) => d.request(method, path, body)).pipe(Effect.mapError(asOldError)));
}
/** All channels: from the live cache, or over REST when we don't have one. */
export async function listChannels(env: Env): Promise<Channel[]> {
  return run(env, Discord.use((d) => d.listChannels).pipe(Effect.mapError(asOldError))) as Promise<Channel[]>;
}
/** True when an api() error is Discord's 404 (the thing is gone). */
export const isNotFound = (e: unknown) => / -> 404 /.test(String(e));
const asResponse = (r: WebhookResult) => (r ? new globalThis.Response(r.status === 204 || r.status === 205 || r.status === 304 ? null : r.text, { status: r.status }) : null);
/** Interaction webhooks (followups, @original) don't need the bot token. */
export function followup(env: Env, token: string, body: unknown) {
  return run(env, Discord.use((d) => d.followup(token, body))).then(asResponse);
}
/** Fill in a deferred ("thinking…") interaction response. */
export function editOriginal(env: Env, token: string, body: unknown) {
  return run(env, Discord.use((d) => d.editOriginal(token, body))).then(asResponse);
}
export async function originalMessage(env: Env, token: string): Promise<{ id: string; channel_id: string }> {
  const r = await run(env, Discord.use((d) => d.originalMessage(token)));
  if (!r?.ok) throw new Error(`@original -> ${r?.status}`);
  return JSON.parse(r.text) as { id: string; channel_id: string };
}
