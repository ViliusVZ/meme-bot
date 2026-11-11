// Reacting to voice as it happens (leader only; presence.ts is fed by the gateway):
//   • every join, leave and move is recorded for 📊 stats right away, plus a heartbeat every
//     minute while anyone's in voice
//   • someone joining the Lobby during a game night is pulled into the game's room at once
//   • when a room empties, its 15-minute wrap-up timer starts; it fires exactly on time
//   • 🎮 spontaneous play (spontaneous.ts): the Lobby question, unplanned sessions, pulling people in
import type { Env } from "./env.js";
import * as presence from "./presence.js";
import * as activity from "./activity.js";
import * as voice from "./voice.js";
import * as late from "./late.js";
import * as spontaneous from "./spontaneous.js";
import { players } from "./gamenight.js";
import * as alerts from "./alerts.js";

const HEARTBEAT = 60_000;
const nowSec = () => Math.floor(Date.now() / 1000);

export function start(env: Env) {
  const ps = new Set(players(env));
  let heartbeat: NodeJS.Timeout | null = null;
  let wrapUp: NodeJS.Timeout | null = null;
  let lobbyTimer: NodeJS.Timeout | null = null;
  let stopped = false;
  // changes are handled one at a time, in order, so a quick leave-and-rejoin can't race itself
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = (label: string, fn: () => Promise<unknown>) => {
    queue = queue.then(fn).catch((e) => alerts.failed(`live voice (${label})`, e));
    return queue;
  };

  const where = () => new Map([...ps].map((p) => [p, presence.lastKnown(p)]));
  const occupied = () => new Set([...where().values()].filter(Boolean) as string[]);

  /** Re-check rooms now, and set a timer for the next empty room's wrap-up. */
  const checkRooms = async () => {
    if (!presence.isReady()) return;
    const { archived, nextDue } = await voice.checkRooms(env, occupied());
    if (archived.length) console.log("rooms wrapped up", archived);
    if (wrapUp) clearTimeout(wrapUp);
    wrapUp = null;
    if (nextDue !== null && !stopped) {
      // already due means the wrap-up just failed (Discord trouble): try again in a minute, not now
      const ms = nextDue * 1000 <= Date.now() ? 60_000 : nextDue * 1000 - Date.now() + 500;
      wrapUp = setTimeout(() => void enqueue("wrap-up", checkRooms), Math.min(ms, 2 ** 31 - 1));
    }
  };

  /** 🎮 Spontaneous play, and a timer for whatever it says is due next (the question's 30 s, say). */
  const lobby = async (change?: spontaneous.Change) => {
    if (!presence.isReady()) return;
    const due = await spontaneous.react(env, where(), nowSec(), change);
    if (lobbyTimer) clearTimeout(lobbyTimer);
    lobbyTimer = null;
    if (due !== null && !stopped) {
      const ms = Math.max(1000, due * 1000 - Date.now() + 500);
      lobbyTimer = setTimeout(() => void enqueue("lobby", () => lobby()), Math.min(ms, 2 ** 31 - 1));
    }
  };

  const beat = async () => {
    if (!presence.isReady()) return; // never record "nobody's here" just because we can't see
    const w = where();
    await activity.track(env, w, nowSec());
    const anyone = [...w.values()].some(Boolean);
    if (anyone && !heartbeat && !stopped) heartbeat = setInterval(() => void enqueue("heartbeat", beat), HEARTBEAT);
    if (!anyone && heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    // busy rooms: keep their last_seen fresh (and their night's event alive)
    if (anyone) await checkRooms();
    if (anyone) await lobby();
  };

  const unsubscribe = presence.onChange((user, from, to) => {
    if (!ps.has(user) || stopped) return;
    const t = nowSec();
    void enqueue("voice change", async () => {
      if (!presence.hasSnapshot()) return;
      if (from) await voice.leftRoom(env, from, t);
      if (to === env.LOBBY_CHANNEL_ID) {
        const r = await late.watch(env);
        if (Object.keys(r).length) console.log("late", r);
      }
      await activity.track(env, where(), t);
      await beat();
      await checkRooms();
      await lobby({ user, from, to });
    });
  });

  /** The gateway (re)connected and sent a fresh snapshot: catch up on everything. */
  const resync = () =>
    enqueue("resync", async () => {
      await beat();
      await checkRooms();
      await lobby();
    });

  return {
    resync,
    stop: async () => {
      stopped = true;
      unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
      if (wrapUp) clearTimeout(wrapUp);
      if (lobbyTimer) clearTimeout(lobbyTimer);
      await queue;
    },
  };
}
