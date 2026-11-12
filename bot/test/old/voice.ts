// The old functions of src/voice.ts, for the tests until phase 6 makes them Effect-native
// (plan 05, phase 5 step 8: the transition left src; the tests change only their imports).
export * from "../../src/voice.js";
import { run } from "../../src/legacy.js";
import { Opened, RoomStillCreating, Voice, roomLine } from "../../src/voice.js";
import type { Env } from "../../src/env.js";
import { isDiscordError } from "../../src/voice.js";

// the old functions, for the code that isn't on Effect yet, with today's error texts (callers log
// them and the alert DM quotes them)
const asOld = (e: unknown) => {
  throw e instanceof RoomStillCreating || (e instanceof Error && "_tag" in e && isDiscordError(e as { _tag: string })) ? new Error(e.message) : e;
};
export const voiceChannel = (env: Env, user: string) => run(env, Voice.use((v) => v.voiceChannel(user))).catch(asOld);
export const openRooms = (env: Env) => run(env, Voice.use((v) => v.openRooms));
export const openRoom = (env: Env, game: string, emoji: string | null, opts: { day?: string; by?: string; move?: boolean } = {}) =>
  run(env, Voice.use((v) => v.openRoom(game, emoji, opts))).catch(asOld);
export const moveFromLobby = (env: Env, channelId: string) => run(env, Voice.use((v) => v.moveFromLobby(channelId)));
export const whereIs = (env: Env) => run(env, Voice.use((v) => v.whereIs));
export const checkRooms = (env: Env, occupied: Set<string>, t?: number) => run(env, Voice.use((v) => v.checkRooms(occupied, t)));
export const leftRoom = (env: Env, channelId: string, t?: number) => run(env, Voice.use((v) => v.leftRoom(channelId, t)));
export const maintainRooms = (env: Env) => run(env, Voice.use((v) => v.maintainRooms)).catch(asOld);
export const roomPicker = (env: Env) => run(env, Voice.use((v) => v.roomPicker));
export const roomResult = (env: Env, r: Opened) => roomLine(env.LOBBY_CHANNEL_ID, r);
