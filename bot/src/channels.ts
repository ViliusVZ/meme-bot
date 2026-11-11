// The server's channel list, kept live from the gateway (GUILD_CREATE has them all; CHANNEL_CREATE,
// UPDATE and DELETE keep it current) and from our own channel calls (discord.ts reports them, so a
// channel we just made is known before its event arrives). Room upkeep reads it every minute and on
// every room it opens, which over REST would run into Discord's rate limit on that endpoint.
export type Channel = { id: string; name: string; type: number; position: number; parent_id?: string | null };

const cache = new Map<string, Channel>();
let ready = false;

export function snapshot(list: Channel[]) {
  cache.clear();
  for (const c of list) cache.set(c.id, slim(c));
  ready = true;
}

export function upsert(c: Channel) {
  if (ready && c?.id && typeof c.type === "number") cache.set(c.id, slim(c));
}

/** A bulk position change (PATCH /guilds/{id}/channels). */
export function reposition(moves: { id: string; position: number }[]) {
  for (const m of moves) {
    const c = cache.get(m.id);
    if (c) c.position = m.position;
  }
}

export function remove(id: string) {
  cache.delete(id);
}

export function invalidate() {
  ready = false;
}

const slim = (c: Channel): Channel => ({ id: c.id, name: c.name, type: c.type, position: c.position, parent_id: c.parent_id ?? null });

/** The cached list, or null before the gateway has sent one. */
export function cached(): Channel[] | null {
  return ready ? [...cache.values()] : null;
}

/** Tests only. */
export function _reset() {
  cache.clear();
  ready = false;
}
