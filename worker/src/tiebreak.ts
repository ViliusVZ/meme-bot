// Fun tiebreakers, shared by game-night game picks and polls.
//
// When a vote ends in a tie, the host card shows a ⚔️ section: 🎰 spin the wheel (an animated
// slot reel) or ✊✋✌️ rock-paper-scissors between the tied voters (secret throws, rounds revealed,
// draws replay, after 5 draws the wheel takes over). One tiebreak per host, enforced by a unique
// index; every state change is compare-and-set, so simultaneous clicks can't double-resolve.
import type { Env } from "./index";
import { now } from "./db";

export type Hand = "r" | "p" | "s";
export interface Tiebreak {
  id: number;
  kind: "night" | "poll";
  ref: string; // night day, or poll id
  options: string; // JSON string[]: the tied options
  contenders: string; // JSON {user: option}
  alive: string; // JSON user[] still in the rock-paper-scissors
  mode: "wheel" | "rps" | null;
  round: number;
  hands: string; // JSON {user: hand} for the current round
  history: string; // JSON string[]: one line per finished round
  result: string | null;
  how: string | null;
}

const HAND: Record<Hand, { emoji: string; name: string }> = {
  r: { emoji: "🪨", name: "Rock" },
  p: { emoji: "✋", name: "Paper" },
  s: { emoji: "✌️", name: "Scissors" },
};
const BEATS: Record<Hand, Hand> = { r: "s", p: "r", s: "p" };
const MAX_DRAWS = 5;
const mention = (u: string) => `<@${u}>`;

export const get = (env: Env, kind: string, ref: string) =>
  env.DB.prepare("SELECT * FROM tiebreaks WHERE kind = ? AND ref = ?").bind(kind, ref).first<Tiebreak>();
export const getById = (env: Env, id: number) => env.DB.prepare("SELECT * FROM tiebreaks WHERE id = ?").bind(id).first<Tiebreak>();

/** Opens the tiebreak for a host (idempotent: a second call returns the first one). */
export async function open(env: Env, kind: Tiebreak["kind"], ref: string, options: string[], contenders: Record<string, string>) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO tiebreaks (kind, ref, options, contenders, alive, round, hands, history, created_at)
     VALUES (?, ?, ?, ?, ?, 1, '{}', '[]', ?)`,
  )
    .bind(kind, ref, JSON.stringify(options), JSON.stringify(contenders), JSON.stringify(Object.keys(contenders)), now())
    .run();
  return (await get(env, kind, ref))!;
}

export const remove = (env: Env, kind: string, ref: string) => env.DB.prepare("DELETE FROM tiebreaks WHERE kind = ? AND ref = ?").bind(kind, ref).run();

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
  const options: string[] = JSON.parse(tb.options);

  if (action === "wheel") {
    // allowed before RPS starts, or as a way out of a stalled RPS
    const winner = options[Math.floor(Math.random() * options.length)];
    const how = `🎰 ${mention(user)} spun the wheel and it landed on`;
    const r = await env.DB.prepare("UPDATE tiebreaks SET mode = 'wheel', result = ?, how = ? WHERE id = ? AND result IS NULL")
      .bind(winner, how, id)
      .run();
    if (!r.meta.changes) return { update: true };
    return { update: true, resolved: true, spin: spinFrames(options, winner) };
  }

  if (action === "rps") {
    await env.DB.prepare("UPDATE tiebreaks SET mode = 'rps' WHERE id = ? AND mode IS NULL").bind(id).run();
    return { update: true };
  }

  if (action === "hand") {
    if (tb.mode !== "rps") return { update: true };
    const alive: string[] = JSON.parse(tb.alive);
    if (!alive.includes(user)) return { notice: "You're not in this duel. Grab popcorn 🍿", update: false };
    if (!value || !(value in HAND)) return { update: true };
    // json_set keeps simultaneous throws from overwriting each other
    await env.DB.prepare("UPDATE tiebreaks SET hands = json_set(hands, ?, ?) WHERE id = ? AND round = ? AND result IS NULL")
      .bind(`$."${user}"`, value, id, tb.round)
      .run();
    const fresh = (await getById(env, id))!;
    const hands: Record<string, Hand> = JSON.parse(fresh.hands);
    const notice = `You threw ${HAND[value as Hand].emoji} ${HAND[value as Hand].name}. Shh 🤫`;
    if (!alive.every((u) => hands[u])) return { notice, update: true };
    return { notice, ...(await finishRound(env, fresh, alive, hands)) };
  }
  return { update: true };
}

async function finishRound(env: Env, tb: Tiebreak, alive: string[], hands: Record<string, Hand>): Promise<TbOutcome> {
  const contenders: Record<string, string> = JSON.parse(tb.contenders);
  const history: string[] = JSON.parse(tb.history);
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
    const options: string[] = JSON.parse(tb.options);
    result = options[Math.floor(Math.random() * options.length)];
    how = `🎰 ${MAX_DRAWS} draws in a row, so the wheel took over and picked`;
  }
  const upd = await env.DB.prepare(
    `UPDATE tiebreaks SET round = round + 1, hands = '{}', alive = ?, history = ?, result = ?, how = ?
     WHERE id = ? AND round = ? AND result IS NULL`,
  )
    .bind(JSON.stringify(r.survivors), JSON.stringify(history), result, how, tb.id, tb.round)
    .run();
  return { update: true, resolved: upd.meta.changes > 0 && result !== null };
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
  const options: string[] = JSON.parse(tb.options);
  const contenders: Record<string, string> = JSON.parse(tb.contenders);
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

  const alive: string[] = JSON.parse(tb.alive);
  const hands: Record<string, string> = JSON.parse(tb.hands);
  const history: string[] = JSON.parse(tb.history);
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
  const history: string[] = JSON.parse(tb.history);
  return `${history.length ? `${history.join("\n")}\n` : ""}${tb.how} **${label(tb.result!)}**`;
}
