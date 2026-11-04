// The live connection to Discord (leader only). We only need voice: which channel each person is
// in, the moment it changes. @discordjs/ws handles heartbeats, reconnects and session resumes
// (a resume replays the events we missed, so the picture stays exact across short drops).
// Interactions still arrive over HTTP (app.ts), so clicks keep working even while this reconnects.
import { REST } from "@discordjs/rest";
import { WebSocketManager, WebSocketShardEvents } from "@discordjs/ws";
import { GatewayDispatchEvents, GatewayIntentBits, type GatewayDispatchPayload } from "discord-api-types/v10";
import type { Env } from "./env.js";
import * as presence from "./presence.js";

export async function connect(env: Env, onSnapshot: () => void) {
  const rest = new REST({ version: "10" }).setToken(env.DISCORD_TOKEN);
  const manager = new WebSocketManager({
    token: env.DISCORD_TOKEN,
    intents: GatewayIntentBits.Guilds | GatewayIntentBits.GuildVoiceStates,
    rest,
    shardCount: 1,
  });

  manager.on(WebSocketShardEvents.Dispatch, (payload: GatewayDispatchPayload) => {
    if (payload.t === GatewayDispatchEvents.GuildCreate && payload.d.id === env.GUILD_ID) {
      // a fresh connection: the full picture of who's in voice right now
      presence.snapshot(payload.d.voice_states ?? []);
      console.log("gateway: voice snapshot", (payload.d.voice_states ?? []).length, "in voice");
      onSnapshot();
    } else if (payload.t === GatewayDispatchEvents.VoiceStateUpdate && payload.d.guild_id === env.GUILD_ID) {
      presence.update(payload.d.user_id, payload.d.channel_id);
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
  });
  manager.on(WebSocketShardEvents.Error, (e: Error) => console.log("gateway: error", e.message));

  await manager.connect();
  return {
    close: async () => {
      presence.invalidate();
      await manager.destroy();
    },
  };
}
