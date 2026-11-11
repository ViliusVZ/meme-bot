// The live connection to Discord (leader only). We only need voice: which channel each person is
// in, the moment it changes. @discordjs/ws handles heartbeats, reconnects and session resumes
// (a resume replays the events we missed, so the picture stays exact across short drops).
// Interactions still arrive over HTTP (app.ts), so clicks keep working even while this reconnects.
import { REST } from "@discordjs/rest";
import { WebSocketManager, WebSocketShardEvents } from "@discordjs/ws";
import { GatewayDispatchEvents, GatewayIntentBits, type GatewayDispatchPayload } from "discord-api-types/v10";
import type { Env } from "./env.js";
import * as presence from "./presence.js";
import * as channels from "./channels.js";
import * as alerts from "./alerts.js";

const CONNECT_TIMEOUT = 30_000;
const DISALLOWED_INTENTS = 4014;
/** Discord refused the presence intent (it's off in the Developer Portal): carry on without it. */
let presencesRefused = false;

export async function connect(env: Env, onSnapshot: () => void, signal?: AbortSignal) {
  const rest = new REST({ version: "10" }).setToken(env.DISCORD_TOKEN);
  const manager = new WebSocketManager({
    token: env.DISCORD_TOKEN,
    intents:
      GatewayIntentBits.Guilds | GatewayIntentBits.GuildVoiceStates | (env.PRESENCES && !presencesRefused ? GatewayIntentBits.GuildPresences : 0),
    rest,
    shardCount: 1,
  });

  manager.on(WebSocketShardEvents.Dispatch, (payload: GatewayDispatchPayload) => {
    if (payload.t === GatewayDispatchEvents.GuildCreate && payload.d.id === env.GUILD_ID) {
      // during a Discord outage the guild arrives "unavailable", without voice states: that's
      // not "everyone left", so keep waiting for the real thing (lookups fall back to REST)
      if ((payload.d as { unavailable?: boolean }).unavailable) {
        presence.invalidate();
        channels.invalidate();
        console.log("gateway: guild unavailable (Discord outage)");
        return;
      }
      // a fresh connection: the full picture of who's in voice right now, and of the channels
      channels.snapshot((payload.d.channels ?? []) as channels.Channel[]);
      presence.snapshot(payload.d.voice_states ?? []);
      for (const p of payload.d.presences ?? []) presence.setActivities(p.user.id, p.activities as { type: number; name: string }[]);
      console.log("gateway: voice snapshot", (payload.d.voice_states ?? []).length, "in voice");
      onSnapshot();
    } else if (
      (payload.t === GatewayDispatchEvents.ChannelCreate || payload.t === GatewayDispatchEvents.ChannelUpdate) &&
      "guild_id" in payload.d &&
      payload.d.guild_id === env.GUILD_ID
    ) {
      channels.upsert(payload.d as channels.Channel);
    } else if (payload.t === GatewayDispatchEvents.ChannelDelete && "guild_id" in payload.d && payload.d.guild_id === env.GUILD_ID) {
      channels.remove(payload.d.id);
    } else if (payload.t === GatewayDispatchEvents.GuildDelete && payload.d.id === env.GUILD_ID) {
      presence.invalidate(); // outage (or we were removed): stop trusting what we had
      channels.invalidate();
      console.log("gateway: guild gone", payload.d.unavailable ? "(outage)" : "");
    } else if (payload.t === GatewayDispatchEvents.VoiceStateUpdate && payload.d.guild_id === env.GUILD_ID) {
      presence.update(payload.d.user_id, payload.d.channel_id);
    } else if (payload.t === GatewayDispatchEvents.PresenceUpdate && payload.d.guild_id === env.GUILD_ID) {
      presence.setActivities(payload.d.user.id, payload.d.activities as { type: number; name: string }[]);
    }
  });
  manager.on(WebSocketShardEvents.Ready, () => console.log("gateway: ready"));
  manager.on(WebSocketShardEvents.Resumed, () => {
    // the missed events were replayed in order, so what we had is still right
    presence.revalidate();
    console.log("gateway: resumed");
  });
  manager.on(WebSocketShardEvents.Closed, (code: number) => {
    // until we resume (or get a new snapshot), fall back to asking Discord over REST
    presence.invalidate();
    console.log("gateway: closed", code);
    if (code === DISALLOWED_INTENTS && env.PRESENCES && !presencesRefused) {
      // the next connect goes without it: voice (and everything else) must not depend on it
      presencesRefused = true;
      alerts.failed("connecting with the presence intent", "Discord refused it (4014): turn on Presence Intent in the Developer Portal. Carrying on without game detection.");
    }
  });
  manager.on(WebSocketShardEvents.Error, (e: Error) => console.log("gateway: error", e.message));

  // connect() waits for READY with no limit of its own (it keeps retrying inside), so bound it:
  // on timeout or abort, tear the manager down and let the caller retry with back-off
  try {
    await new Promise<void>((ok, fail) => {
      const t = setTimeout(() => fail(new Error("gateway connect timed out")), CONNECT_TIMEOUT);
      signal?.addEventListener("abort", () => fail(new Error("aborted")), { once: true });
      Promise.resolve(manager.connect()).then(ok, fail).finally(() => clearTimeout(t));
    });
  } catch (e) {
    await Promise.resolve(manager.destroy()).catch(() => {});
    throw e;
  }
  return {
    close: async () => {
      presence.invalidate();
      channels.invalidate();
      await manager.destroy();
    },
  };
}
