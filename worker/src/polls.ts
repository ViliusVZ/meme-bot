// Quick democratic polls: /poll (or the 🗳️ button) opens a form, the answers become buttons.
// One vote each, changeable (tap again to take it back), and 🤫 secret: the card shows only who
// has voted until the poll is decided, then reveals who picked what. The first answer to reach a
// majority of the trio wins automatically. If everyone has voted without a majority, or someone 🔒 closes a
// tied poll, it goes to a ⚔️ tiebreaker (wheel or rock-paper-scissors, see tiebreak.ts).
import type { Env } from "./index";
import { api, IS_COMPONENTS_V2 } from "./discord";
import { now } from "./db";
import { players } from "./gamenight";
import * as tiebreak from "./tiebreak";

interface Poll {
  id: number;
  question: string;
  options: string; // JSON string[]
  created_by: string;
  closed_at: string | null;
  result: string | null; // win:<answer>
  channel_id: string | null;
  message_id: string | null;
}
type Outcome = { notice?: string; update: boolean };

const LETTERS = ["🇦", "🇧", "🇨", "🇩", "🇪", "🇫", "🇬", "🇭", "🇮", "🇯"];
const majority = (env: Env) => Math.floor(players(env).length / 2) + 1;
const SECRET = "\n-# 🤫 Only you can see this. Everyone's votes are revealed once the poll's decided.";

export const pollModal = () => ({
  custom_id: "poll:new",
  title: "New poll",
  components: [
    { type: 1, components: [{ type: 4, custom_id: "question", style: 1, label: "Question", placeholder: "Pizza or kebab tonight?", max_length: 200, required: true }] },
    {
      type: 1,
      components: [
        {
          type: 4,
          custom_id: "options",
          style: 2,
          label: "Answers, one per line (empty = Yes / No)",
          placeholder: "Pizza\nKebab\nBoth, obviously",
          max_length: 800,
          required: false,
        },
      ],
    },
  ],
});

/** Creates a poll from the modal's fields; returns its id. */
export async function createPoll(env: Env, user: string, question: string, rawOptions: string) {
  let options = [...new Set(rawOptions.split("\n").map((o) => o.trim().slice(0, 80)).filter(Boolean))].slice(0, 10);
  if (options.length < 2) options = ["👍 Yes", "👎 No"];
  const r = await env.DB.prepare("INSERT INTO polls (question, options, created_by, created_at) VALUES (?, ?, ?, ?) RETURNING id")
    .bind(question.trim().slice(0, 200), JSON.stringify(options), user, now())
    .first<{ id: number }>();
  return r!.id;
}

const getPoll = (env: Env, id: number) => env.DB.prepare("SELECT * FROM polls WHERE id = ?").bind(id).first<Poll>();

async function counts(env: Env, poll: Poll) {
  const options: string[] = JSON.parse(poll.options);
  const r = await env.DB.prepare("SELECT user_id, choice FROM poll_votes WHERE poll_id = ?").bind(poll.id).all<{ user_id: string; choice: number }>();
  const voters = options.map((_, i) => r.results.filter((v) => v.choice === i).map((v) => v.user_id));
  return { options, voters, total: r.results.length, mine: (u: string) => r.results.find((v) => v.user_id === u)?.choice };
}

/** Closes a poll once; returns false if someone else closed it first. */
async function close(env: Env, id: number, result: string) {
  const r = await env.DB.prepare("UPDATE polls SET closed_at = ?, result = ? WHERE id = ? AND closed_at IS NULL").bind(now(), result, id).run();
  return r.meta.changes > 0;
}

/** The tied leaders go to a ⚔️ tiebreaker; their voters are the contenders. */
async function startTiebreak(env: Env, poll: Poll, c: Awaited<ReturnType<typeof counts>>) {
  const top = Math.max(...c.voters.map((v) => v.length));
  const leaders = c.options.map((_, i) => i).filter((i) => c.voters[i].length === top);
  const contenders: Record<string, string> = {};
  for (const i of leaders) for (const u of c.voters[i]) contenders[u] = c.options[i];
  await tiebreak.open(env, "poll", String(poll.id), leaders.map((i) => c.options[i]), contenders);
}

export async function pollAct(env: Env, id: number, user: string, action: string): Promise<Outcome> {
  const poll = await getPoll(env, id);
  if (!poll) return { notice: "That poll has vanished 🫥", update: false };
  if (poll.closed_at) return { notice: "This poll is already decided 🔒", update: true };
  if (await tiebreak.get(env, "poll", String(id))) return { notice: "It's tiebreaker time ⚔️ Settle it on the card.", update: true };

  const c = await counts(env, poll);
  if (action === "close") {
    const top = Math.max(...c.voters.map((v) => v.length));
    if (!top) return { notice: "Nobody has voted yet 🤷", update: false };
    const leaders = c.options.filter((_, i) => c.voters[i].length === top);
    if (leaders.length === 1) await close(env, id, `win:${leaders[0]}`);
    else await startTiebreak(env, poll, c);
    return { update: true };
  }

  const choice = Number(action);
  if (!Number.isInteger(choice) || choice < 0 || choice >= c.options.length) return { update: true };
  if (c.mine(user) === choice) {
    await env.DB.prepare("DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?").bind(id, user).run();
    return { notice: `🗳️ Took your vote back.${SECRET}`, update: true };
  }
  await env.DB.prepare(
    `INSERT INTO poll_votes (poll_id, user_id, choice, voted_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(poll_id, user_id) DO UPDATE SET choice = excluded.choice, voted_at = excluded.voted_at`,
  )
    .bind(id, user, choice, now())
    .run();
  const after = await counts(env, poll);
  const winner = after.options.findIndex((_, i) => after.voters[i].length >= majority(env));
  if (winner >= 0) await close(env, id, `win:${after.options[winner]}`);
  // everyone in the trio has voted and there's no majority: straight to the tiebreaker
  else if (players(env).every((p) => after.voters.some((v) => v.includes(p)))) await startTiebreak(env, poll, after);
  // still open: the card doesn't say what you picked, so tell you privately
  else return { notice: `🗳️ Your vote: ${LETTERS[choice]} **${c.options[choice]}**. Tap another answer to change it.${SECRET}`, update: true };
  return { update: true };
}

/** A tiebreak on this poll finished: close it with the winner. */
export async function applyTiebreak(env: Env, id: number) {
  const tb = await tiebreak.get(env, "poll", String(id));
  if (tb?.result) await close(env, id, `win:${tb.result}`);
}

export async function setMessage(env: Env, id: number, channelId: string, messageId: string) {
  await env.DB.prepare("UPDATE polls SET channel_id = ?, message_id = ? WHERE id = ?").bind(channelId, messageId, id).run();
}

/** Re-render a poll in place (used outside interactions). */
export async function refreshPoll(env: Env, id: number) {
  const p = await getPoll(env, id);
  if (p?.message_id) await api(env, "PATCH", `/channels/${p.channel_id}/messages/${p.message_id}`, await renderPoll(env, id));
}

export async function renderPoll(env: Env, id: number) {
  const poll = (await getPoll(env, id))!;
  const c = await counts(env, poll);
  const tb = await tiebreak.get(env, "poll", String(id));
  const hidden = !poll.closed_at && !tb; // decided (or tied into a tiebreak) = revealed
  const top = Math.max(1, ...c.voters.map((v) => v.length));
  const lines = c.options.map((o, i) => {
    if (hidden) return `${LETTERS[i]} **${o}**`;
    const n = c.voters[i].length;
    const filled = Math.round((n / top) * 8);
    return `${LETTERS[i]} **${o}**\n\`${"█".repeat(filled)}${"░".repeat(8 - filled)}\` ${n}${n ? ` · ${c.voters[i].map((u) => `<@${u}>`).join(" ")}` : ""}`;
  });
  const ballots = players(env)
    .map((p) => `${c.voters.some((v) => v.includes(p)) ? "🗳️" : "⏳"} <@${p}>`)
    .join("　");

  const body: unknown[] = [text(`## 🗳️ ${poll.question}`), text(hidden ? `${lines.join("\n")}\n\n${ballots}` : lines.join("\n"))];
  const label = (o: string) => `${LETTERS[c.options.indexOf(o)] ?? ""} ${o}`;
  if (!poll.closed_at && tb) {
    body.push(...tiebreak.section(tb, label), text(`-# asked by <@${poll.created_by}>`));
  } else if (!poll.closed_at) {
    body.push(
      text(
        `-# asked by <@${poll.created_by}> · 🤫 votes stay secret until it's decided · first to ${majority(env)} votes wins · tap again to take yours back · 🔒 Close decides it now`,
      ),
    );
    const buttons = c.options.map((o, i) => ({
      type: 2,
      style: 2,
      emoji: { name: LETTERS[i] },
      label: o.slice(0, 80),
      custom_id: `poll:${id}:${i}`,
    }));
    buttons.push({ type: 2, style: 2, emoji: { name: "🔒" }, label: "Close", custom_id: `poll:${id}:close` });
    for (let i = 0; i < buttons.length; i += 5) body.push({ type: 1, components: buttons.slice(i, i + 5) });
  } else {
    const value = poll.result!.slice(poll.result!.indexOf(":") + 1);
    if (tb?.result) body.push(text(`### ⚔️ Tiebreaker\n${tiebreak.story(tb, label)}`));
    body.push(text(`### ✅ Decided: ${value}`));
    body.push(text(`-# asked by <@${poll.created_by}> · ${c.total} vote${c.total === 1 ? "" : "s"}`));
  }
  return {
    flags: IS_COMPONENTS_V2,
    allowed_mentions: { parse: [] },
    components: [{ type: 17, accent_color: poll.closed_at ? 0x57f287 : 0x5865f2, components: body }],
  };
}

const text = (content: string) => ({ type: 10, content });
