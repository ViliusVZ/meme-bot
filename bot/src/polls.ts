// Quick democratic polls: /poll (or the 🗳️ button) opens a form, the answers become buttons.
// One vote each, changeable (tap again to take it back), and 🤫 secret: the card shows only who
// has voted until the poll is decided, then reveals who picked what. Once everyone's voted the answer
// with the most votes wins; on a split the votes are revealed and stay open for a re-vote until
// one answer leads (🔒 Close decides it then too). Clicking gives you a private copy with your
// answer highlighted (see gamenight.ts).
import { and, eq, isNull } from "drizzle-orm";
import type { Env } from "./env.js";
import { polls, pollVotes } from "./db/index.js";
import { api, EPHEMERAL, IS_COMPONENTS_V2 } from "./discord.js";
import { now } from "./memes.js";
import { players } from "./gamenight.js";

type Poll = typeof polls.$inferSelect;
type Outcome = { notice?: string; update: boolean };

const LETTERS = ["🇦", "🇧", "🇨", "🇩", "🇪", "🇫", "🇬", "🇭", "🇮", "🇯"];


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
  const [r] = await env.db
    .insert(polls)
    .values({ question: question.trim().slice(0, 200), options, created_by: user, created_at: now() })
    .returning({ id: polls.id });
  return r.id;
}

const getPoll = async (env: Env, id: number): Promise<Poll | null> => (await env.db.select().from(polls).where(eq(polls.id, id)))[0] ?? null;

async function counts(env: Env, poll: Poll) {
  const options = poll.options;
  const r = await env.db.select({ user_id: pollVotes.user_id, choice: pollVotes.choice }).from(pollVotes).where(eq(pollVotes.poll_id, poll.id));
  const voters = options.map((_, i) => r.filter((v) => v.choice === i).map((v) => v.user_id));
  return { options, voters, total: r.length, mine: (u: string) => r.find((v) => v.user_id === u)?.choice };
}

/** Closes a poll once; returns false if someone else closed it first. */
async function close(env: Env, id: number, result: string) {
  const r = await env.db
    .update(polls)
    .set({ closed_at: now(), result })
    .where(and(eq(polls.id, id), isNull(polls.closed_at)))
    .returning({ id: polls.id });
  return r.length > 0;
}

export async function pollAct(env: Env, id: number, user: string, action: string): Promise<Outcome> {
  const poll = await getPoll(env, id);
  if (!poll) return { notice: "That poll has vanished 🫥", update: false };
  if (poll.closed_at) return { notice: "This poll is already decided 🔒", update: true };

  const c = await counts(env, poll);
  if (action === "close") {
    const top = Math.max(...c.voters.map((v) => v.length));
    if (!top) return { notice: "Nobody has voted yet 🤷", update: false };
    if (c.total < 2) return { notice: "One vote isn't a decision 😅 Wait for at least one more.", update: false };
    const leaders = c.options.filter((_, i) => c.voters[i].length === top);
    if (leaders.length > 1) return { notice: `🔁 Still split (${leaders.join(" vs ")}). Someone has to change their vote first.`, update: false };
    await close(env, id, `win:${leaders[0]}`);
    return { update: true };
  }

  const choice = Number(action);
  if (!Number.isInteger(choice) || choice < 0 || choice >= c.options.length) return { update: true };
  if (c.mine(user) === choice) {
    await env.db.delete(pollVotes).where(and(eq(pollVotes.poll_id, id), eq(pollVotes.user_id, user)));
    return { notice: "🗳️ Took your vote back.", update: true };
  }
  const at = now();
  await env.db
    .insert(pollVotes)
    .values({ poll_id: id, user_id: user, choice, voted_at: at })
    .onConflictDoUpdate({ target: [pollVotes.poll_id, pollVotes.user_id], set: { choice, voted_at: at } });
  const after = await counts(env, poll);
  // nothing is decided until everyone's voted: then most votes wins; a split stays open (revealed)
  // for a re-vote
  if (!players(env).every((p) => after.voters.some((v) => v.includes(p)))) return { update: true };
  const top = Math.max(...after.voters.map((v) => v.length));
  const leaders = after.options.filter((_, i) => after.voters[i].length === top);
  if (leaders.length === 1) await close(env, id, `win:${leaders[0]}`);
  return { update: true };
}

export const isClosed = async (env: Env, id: number) => !!(await getPoll(env, id))?.closed_at;

export async function setMessage(env: Env, id: number, channelId: string, messageId: string) {
  await env.db.update(polls).set({ channel_id: channelId, message_id: messageId }).where(eq(polls.id, id));
}

/** Re-render a poll in place (used outside interactions). */
export async function refreshPoll(env: Env, id: number) {
  const p = await getPoll(env, id);
  if (p?.message_id) await api(env, "PATCH", `/channels/${p.channel_id}/messages/${p.message_id}`, await renderPoll(env, id));
}

/** The poll card; with a `viewer`, their private copy (their answer highlighted, `notice` on top). */
export async function renderPoll(env: Env, id: number, viewer?: string, notice?: string) {
  const poll = (await getPoll(env, id))!;
  const me = viewer && players(env).includes(viewer) ? viewer : null;
  const c = await counts(env, poll);
  const everyone = players(env).every((p) => c.voters.some((v) => v.includes(p)));
  const split = !poll.closed_at && everyone; // everyone's voted and it's still open: a split
  const hidden = !poll.closed_at && !split; // decided or split = revealed
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
  if (!poll.closed_at) {
    body.push(
      text(
        split
          ? `### 🔁 Split vote! Re-vote until one answer leads\n-# asked by <@${poll.created_by}> · tap another answer to switch · 🔒 Close decides it once one leads`
          : `-# asked by <@${poll.created_by}> · 🤫 votes stay secret until everyone's voted · then most votes wins · tap again to take yours back · 🔒 Close decides it now`,
      ),
    );
    const buttons = c.options.map((o, i) => ({
      type: 2,
      style: me && c.mine(me) === i ? 3 : 2, // your answer, on your private copy
      emoji: { name: LETTERS[i] },
      label: o.slice(0, 80),
      custom_id: `poll:${id}:${i}`,
    }));
    buttons.push({ type: 2, style: 2, emoji: { name: "🔒" }, label: "Close", custom_id: `poll:${id}:close` });
    for (let i = 0; i < buttons.length; i += 5) body.push({ type: 1, components: buttons.slice(i, i + 5) });
  } else {
    const value = poll.result!.slice(poll.result!.indexOf(":") + 1);
    body.push(text(`### ✅ Decided: ${value}`));
    body.push(text(`-# asked by <@${poll.created_by}> · ${c.total} vote${c.total === 1 ? "" : "s"}`));
  }
  if (me) {
    // your private panel: your answer and the buttons to change it, not a second copy of the poll
    const mine = c.mine(me);
    const controls = (body as any[]).filter((x) => x.type === 1);
    const head = poll.closed_at
      ? `### 🔒 ${poll.question}\n✅ Decided: ${poll.result!.slice(poll.result!.indexOf(":") + 1)}`
      : `### 🔒 ${poll.question}\n${mine === undefined || mine === null ? "Tap your answer:" : `🗳️ You voted ${LETTERS[mine]} **${c.options[mine]}**. Tap another answer to switch, or yours again to take it back.`}`;
    body.splice(0, body.length, ...(notice ? [text(notice)] : []), text(head), ...controls, text("-# Only you can see this; the poll shows everyone's progress."));
  }
  return {
    flags: IS_COMPONENTS_V2 | (me ? EPHEMERAL : 0),
    allowed_mentions: { parse: [] },
    components: [{ type: 17, accent_color: poll.closed_at ? 0x57f287 : 0x5865f2, components: body }],
  };
}

const text = (content: string) => ({ type: 10, content });
