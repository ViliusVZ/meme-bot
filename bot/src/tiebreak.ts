// Fun tiebreakers, shared by game-night game picks and polls.
//
// When a vote ends in a tie, the host card shows a ⚔️ section: 🎰 spin the wheel (an animated
// slot reel) or ✊✋✌️ rock-paper-scissors between the tied voters (secret throws, rounds revealed,
// draws replay, after 5 draws the wheel takes over). One tiebreak per host, enforced by a unique
// index; every state change is compare-and-set, so simultaneous clicks can't double-resolve.
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Env } from "./env.js";
import { tiebreaks } from "./db/index.js";
import { now } from "./memes.js";

export type Hand = "r" | "p" | "s";
export type Tiebreak = typeof tiebreaks.$inferSelect;

const HAND: Record<Hand, { emoji: string; name: string }> = {
  r: { emoji: "🪨", name: "Rock" },
  p: { emoji: "✋", name: "Paper" },
  s: { emoji: "✌️", name: "Scissors" },
};
const BEATS: Record<Hand, Hand> = { r: "s", p: "r", s: "p" };
const MAX_DRAWS = 5;
const mention = (u: string) => `<@${u}>`;

export const get = async (env: Env, kind: Tiebreak["kind"], ref: string): Promise<Tiebreak | null> =>
  (await env.db.select().from(tiebreaks).where(and(eq(tiebreaks.kind, kind), eq(tiebreaks.ref, ref))))[0] ?? null;
export const getById = async (env: Env, id: number): Promise<Tiebreak | null> =>
  (await env.db.select().from(tiebreaks).where(eq(tiebreaks.id, id)))[0] ?? null;

/** Opens the tiebreak for a host (idempotent: a second call returns the first one). */
export async function open(env: Env, kind: Tiebreak["kind"], ref: string, options: string[], contenders: Record<string, string>) {
  await env.db
    .insert(tiebreaks)
    .values({ kind, ref, options, contenders, alive: Object.keys(contenders), round: 1, hands: {}, history: [], created_at: now() })
    .onConflictDoNothing();
  return (await get(env, kind, ref))!;
}

export const remove = (env: Env, kind: Tiebreak["kind"], ref: string) => env.db.delete(tiebreaks).where(and(eq(tiebreaks.kind, kind), eq(tiebreaks.ref, ref)));

/**
 * One rock-paper-scissors round among the players still in it. Exactly two different hands
 * means the winning hand's throwers survive; anything else (all same, or all three hands) is a
 * draw and everyone throws again.
 */
export function resolveRound(alive: string[], hands: Record<string, Hand>) {
  const kinds = [...new Set(alive.map((u) => hands[u]))];
  if (kinds.length !== 2) return { draw: true as const, survivors: alive };
  const [a, b] = kinds;
  const win = BEATS[a] === b ? a : b;
  return { draw: false as const, win, survivors: alive.filter((u) => hands[u] === win) };
}

export type TbOutcome = { notice?: string; update: boolean; resolved?: boolean; spin?: string[] };

/** A player pressed a tiebreak button: wheel | rps | hand (value r/p/s). */
export async function act(env: Env, id: number, user: string, action: string, value?: string): Promise<TbOutcome> {
  const tb = await getById(env, id);
  if (!tb) return { notice: "That tiebreak has vanished 🫥", update: false };
  if (tb.result) return { update: true };
  const options = tb.options;

  if (action === "wheel") {
    // allowed before RPS starts, or as a way out of a stalled RPS
    const winner = options[Math.floor(Math.random() * options.length)];
    const how = `🎰 ${mention(user)} spun the wheel and it landed on`;
    const r = await env.db
      .update(tiebreaks)
      .set({ mode: "wheel", result: winner, how })
      .where(and(eq(tiebreaks.id, id), isNull(tiebreaks.result)))
      .returning({ id: tiebreaks.id });
    if (!r.length) return { update: true };
    return { update: true, resolved: true, spin: spinFrames(options, winner) };
  }

  if (action === "rps") {
    await env.db.update(tiebreaks).set({ mode: "rps" }).where(and(eq(tiebreaks.id, id), isNull(tiebreaks.mode)));
    return { update: true };
  }

  if (action === "hand") {
    if (tb.mode !== "rps") return { update: true };
    const alive = tb.alive;
    if (!alive.includes(user)) return { notice: "You're not in this duel. Grab popcorn 🍿", update: false };
    if (!value || !(value in HAND)) return { update: true };
    // merging into the stored object keeps simultaneous throws from overwriting each other
    const thrown = await env.db
      .update(tiebreaks)
      .set({ hands: sql`${tiebreaks.hands} || jsonb_build_object(${user}::text, ${value}::text)` })
      .where(and(eq(tiebreaks.id, id), eq(tiebreaks.round, tb.round), isNull(tiebreaks.result)))
      .returning({ id: tiebreaks.id });
    const fresh = (await getById(env, id))!;
    if (!thrown.length) {
      // the round finished between our read and write: don't pretend the throw counted
      if (fresh.result) return { update: true };
      const stillIn = fresh.alive.includes(user);
      return { notice: stillIn ? `⏩ That round just finished. Throw again for round ${fresh.round}!` : "You're out of this duel. Grab popcorn 🍿", update: true };
    }
    const hands = fresh.hands;
    const notice = `You threw ${HAND[value as Hand].emoji} ${HAND[value as Hand].name}. Shh 🤫`;
    if (!alive.every((u) => hands[u])) return { notice, update: true };
    return { notice, ...(await finishRound(env, fresh, alive, hands)) };
  }
  return { update: true };
}

async function finishRound(env: Env, tb: Tiebreak, alive: string[], hands: Record<string, Hand>): Promise<TbOutcome> {
  const contenders = tb.contenders;
  const history = [...tb.history];
  const r = resolveRound(alive, hands);
  const throws = alive.map((u) => `${mention(u)} ${HAND[hands[u]].emoji}`).join(" · ");
  history.push(`**Round ${tb.round}:** ${throws} → ${r.draw ? "draw!" : `${HAND[r.win].emoji} wins`}`);

  const draws = history.filter((h) => h.endsWith("draw!")).length;
  const survivingOptions = [...new Set(r.survivors.map((u) => contenders[u]))];
  let result: string | null = null;
  let how: string | null = null;
  if (survivingOptions.length === 1) {
    result = survivingOptions[0];
    how = `✊ ${r.survivors.map(mention).join(" & ")} won rock-paper-scissors, so it's`;
  } else if (draws >= MAX_DRAWS) {
    // only options still in the duel (someone knocked out earlier can't win by wheel)
    result = survivingOptions[Math.floor(Math.random() * survivingOptions.length)];
    how = `🎰 ${MAX_DRAWS} draws, so the wheel took over and picked`;
  }
  const upd = await env.db
    .update(tiebreaks)
    .set({ round: tb.round + 1, hands: {}, alive: r.survivors, history, result, how })
    .where(and(eq(tiebreaks.id, tb.id), eq(tiebreaks.round, tb.round), isNull(tiebreaks.result)))
    .returning({ id: tiebreaks.id });
  return { update: true, resolved: upd.length > 0 && result !== null };
}

/** Slot-reel frames ending on the winner, for the animated wheel. */
function spinFrames(options: string[], winner: string) {
  const w = options.indexOf(winner);
  const n = options.length;
  const steps = [n + 3, n + 2, 2, 1, 0]; // fast, fast, slowing, slowing, landed
  return steps.map((back) => options[(((w - back) % n) + n) % n]);
}

/** The card while the wheel spins: `at` is the option under the pointer. */
export function spinFrame(options: string[], at: string, label: (o: string) => string, last: boolean) {
  const i = options.indexOf(at);
  const n = options.length;
  const prev = options[(i - 1 + n) % n];
  const next = options[(i + 1) % n];
  const reel = n === 2 ? [`▶ **${label(at)}** ◀`, `　 ${label(next)}`] : [`　 ${label(prev)}`, `▶ **${label(at)}** ◀`, `　 ${label(next)}`];
  return {
    type: 17,
    accent_color: last ? 0x57f287 : 0xf1c40f,
    components: [
      { type: 10, content: `## 🎰 ${last ? "And the wheel says…" : "Spinning the wheel…"}` },
      { type: 10, content: reel.join("\n") },
      { type: 10, content: last ? `### 🎯 ${label(at)}!` : `-# ${"🥁".repeat(Math.min(3, 1 + Math.floor(Math.random() * 3)))}` },
    ],
  };
}

/** The ⚔️ tiebreak section for a host card (while unresolved). */
export function section(tb: Tiebreak, label: (o: string) => string, title = "It's a tie!"): unknown[] {
  const options = tb.options;
  const contenders = tb.contenders;
  const backers = (o: string) =>
    Object.entries(contenders)
      .filter(([, c]) => c === o)
      .map(([u]) => mention(u))
      .join(" ");
  const btn = (style: number, emoji: string, text: string, action: string) => ({ type: 2, style, emoji: { name: emoji }, label: text, custom_id: `tb:${tb.id}:${action}` });
  const lineup = options.map((o) => `**${label(o)}** ${backers(o)}`).join("\n⚔️ ");

  if (tb.mode !== "rps") {
    return [
      { type: 10, content: `### ⚔️ ${title}\n${lineup}` },
      { type: 10, content: "-# Settle it: spin the wheel, or the tied voters duel at rock-paper-scissors." },
      { type: 1, components: [btn(1, "🎰", "Spin the wheel", "wheel"), btn(3, "✊", "Rock Paper Scissors", "rps")] },
    ];
  }

  const { alive, hands, history } = tb;
  const status = alive.map((u) => `${hands[u] ? "✅" : "⏳"} ${mention(u)} (${label(contenders[u])})`).join("\n");
  return [
    { type: 10, content: `### ✊✋✌️ Rock Paper Scissors · round ${tb.round}${history.length ? `\n${history.join("\n")}` : ""}` },
    { type: 10, content: status },
    { type: 10, content: `-# Throws are secret until everyone's in. Draws replay; ${MAX_DRAWS} draws and the wheel decides.` },
    {
      type: 1,
      components: [
        btn(2, "🪨", "Rock", "hand:r"),
        btn(2, "✋", "Paper", "hand:p"),
        btn(2, "✌️", "Scissors", "hand:s"),
        btn(2, "🎰", "Just spin it", "wheel"),
      ],
    },
  ];
}

/** One line telling how a resolved tiebreak went, for the host card. */
export function story(tb: Tiebreak, label: (o: string) => string) {
  const history = tb.history;
  return `${history.length ? `${history.join("\n")}\n` : ""}${tb.how} **${label(tb.result!)}**`;
}
