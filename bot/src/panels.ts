// 🔒 Private copies of a card: the "only you can see this" reply a tap on a game-night card or a poll
// gets. Discord lets us edit one for 15 minutes after the tap that made or last updated it, so every
// copy follows its card for that long instead of staying on whatever it showed when you tapped (the
// game picker after the game's decided, say, so you pick again).
import { and, eq, lt } from "drizzle-orm";
import type { Env } from "./env.js";
import { panels } from "./db/index.js";
import { editOriginal, EPHEMERAL, originalMessage } from "./discord.js";

/** Discord takes edits to a tap's reply for 15 minutes; stop a little before that. */
const LIFE = 14 * 60;

const nowSec = () => Math.floor(Date.now() / 1000);

/** The copy a tap just answered: the sync keeps its notice ("already picked…") instead of wiping it. */
export type Mine = { message_id: string; notice?: string };

/** Someone's private copy of the card, as of now. */
type Render = (user: string, notice?: string) => Promise<{ flags: number }>;

/**
 * Remember a private copy someone got or tapped. A tap on the copy names it; a fresh one from the
 * card is looked up once Discord has posted it. Each tap renews the 15 minutes.
 * `card` is what it's a copy of: `gn:<day>` or `poll:<id>`.
 */
export async function track(env: Env, card: string, user: string, token: string, messageId?: string) {
  const id = messageId ?? (await originalMessage(env, token)).id;
  const t = nowSec();
  await env.db
    .insert(panels)
    .values({ message_id: id, card, user_id: user, token, tapped_at: t })
    .onConflictDoUpdate({ target: panels.message_id, set: { token, tapped_at: t } });
}

const syncing = new Map<string, Promise<void>>();

/**
 * Bring every live private copy of a card up to date. Syncs for one card run one after another, so
 * an older state never lands on top of a newer one.
 */
export function sync(env: Env, card: string, render: Render, mine?: Mine) {
  const next = (syncing.get(card) ?? Promise.resolve()).catch(() => {}).then(() => push(env, card, render, mine));
  syncing.set(card, next);
  const done = () => void (syncing.get(card) === next && syncing.delete(card));
  next.then(done, done);
  return next;
}

async function push(env: Env, card: string, render: Render, mine?: Mine) {
  await env.db.delete(panels).where(lt(panels.tapped_at, nowSec() - LIFE));
  const live = await env.db.select().from(panels).where(eq(panels.card, card));
  await Promise.all(
    live.map(async (p) => {
      const { flags, ...copy } = await render(p.user_id, p.message_id === mine?.message_id ? mine.notice : undefined);
      // an edit can't set "ephemeral" again (and needn't: it stays only theirs)
      const r = await editOriginal(env, p.token, { ...copy, flags: flags & ~EPHEMERAL });
      // dismissed, or the token ran out: let it go (unless a newer tap renewed it meanwhile)
      if (!r?.ok) await env.db.delete(panels).where(and(eq(panels.message_id, p.message_id), eq(panels.token, p.token)));
    }),
  );
}
