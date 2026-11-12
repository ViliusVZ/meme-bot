// Quick democratic polls: /poll (or the 🗳️ button) opens a form, the answers become buttons.
// One vote each, changeable (tap again to take it back), and 🤫 secret: the card shows only who
// has voted until the poll is decided, then reveals who picked what. Once everyone's voted the answer
// with the most votes wins; on a split the votes are revealed and stay open for a re-vote until
// one answer leads (🔒 Close decides it then too). Clicking gives you a private copy with your
// answer highlighted (see gamenight.ts).
import { and, eq, isNull } from "drizzle-orm";
import { Context, Effect, Layer, Match } from "effect";
import type { Env } from "./env.js";
import { polls, pollVotes } from "./db/index.js";
import { Db, type DbError } from "./db/db.js";
import { AppConfig, players } from "./config.js";
import { Discord, type DiscordError, EPHEMERAL, IS_COMPONENTS_V2 } from "./discord.js";
import { Panels, type Mine } from "./panels.js";
import { nowIso } from "./clock.js";

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

const text = (content: string) => ({ type: 10, content });

export class Polls extends Context.Service<
  Polls,
  {
    /** Creates a poll from the modal's fields; returns its id. */
    create(user: string, question: string, rawOptions: string): Effect.Effect<number, DbError>;
    act(id: number, user: string, action: string): Effect.Effect<Outcome, DbError>;
    isClosed(id: number): Effect.Effect<boolean, DbError>;
    setMessage(id: number, channelId: string | undefined, messageId: string): Effect.Effect<void, DbError>;
    /**
     * Re-render a poll in place (used outside interactions), and everyone's private copies of it.
     * `mine` is the copy a tap just answered, so its notice survives the sync.
     */
    refresh(id: number, mine?: Mine): Effect.Effect<void, DbError | DiscordError>;
    /** Bring everyone's private copies of a poll up to date (panels.ts). */
    syncPanels(id: number, mine?: Mine): Effect.Effect<void, DbError>;
    /** The poll card; with a `viewer`, their private copy (their answer highlighted, `notice` on top). */
    render(id: number, viewer?: string, notice?: string): Effect.Effect<{ flags: number; allowed_mentions: { parse: string[] }; components: unknown[] }, DbError>;
  }
>()("meme-bot/polls") {
  static readonly layer = Layer.effect(
    Polls,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const db = yield* Db;
      const discord = yield* Discord;
      const panels = yield* Panels;
      const trio = Effect.provideService(players, AppConfig, config);

      const getPoll = Effect.fnUntraced(function* (id: number) {
        const rows = yield* db.select().from(polls).where(eq(polls.id, id));
        return rows.length ? rows[0] : null;
      });

      const counts = Effect.fnUntraced(function* (poll: Poll) {
        const options = poll.options;
        const r = yield* db.select({ user_id: pollVotes.user_id, choice: pollVotes.choice }).from(pollVotes).where(eq(pollVotes.poll_id, poll.id));
        const voters = options.map((_, i) => r.filter((v) => v.choice === i).map((v) => v.user_id));
        return { options, voters, total: r.length, mine: (u: string) => r.find((v) => v.user_id === u)?.choice };
      });

      /** Closes a poll once; returns false if someone else closed it first. */
      const close = Effect.fnUntraced(function* (id: number, result: string) {
        const r = yield* db
          .update(polls)
          .set({ closed_at: yield* nowIso, result })
          .where(and(eq(polls.id, id), isNull(polls.closed_at)))
          .returning({ id: polls.id });
        return r.length > 0;
      });

      const render = Effect.fn("Polls.render")(function* (id: number, viewer?: string, notice?: string) {
        const poll = (yield* getPoll(id))!;
        const ps = yield* trio;
        const me = viewer && ps.includes(viewer) ? viewer : null;
        const c = yield* counts(poll);
        const everyone = ps.every((p) => c.voters.some((v) => v.includes(p)));
        const split = !poll.closed_at && everyone; // everyone's voted and it's still open: a split
        const hidden = !poll.closed_at && !split; // decided or split = revealed
        const top = Math.max(1, ...c.voters.map((v) => v.length));
        const lines = c.options.map((o, i) => {
          if (hidden) return `${LETTERS[i]} **${o}**`;
          const n = c.voters[i].length;
          const filled = Math.round((n / top) * 8);
          return `${LETTERS[i]} **${o}**\n\`${"█".repeat(filled)}${"░".repeat(8 - filled)}\` ${n}${n ? ` · ${c.voters[i].map((u) => `<@${u}>`).join(" ")}` : ""}`;
        });
        const ballots = ps.map((p) => `${c.voters.some((v) => v.includes(p)) ? "🗳️" : "⏳"} <@${p}>`).join("　");

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
          const controls = (body as { type: number }[]).filter((x) => x.type === 1);
          const head = poll.closed_at
            ? `### 🔒 ${poll.question}\n✅ Decided: ${poll.result!.slice(poll.result!.indexOf(":") + 1)}`
            : `### 🔒 ${poll.question}\n${mine === undefined || mine === null ? "Tap your answer:" : `🗳️ You voted ${LETTERS[mine]} **${c.options[mine]}**. Tap another answer to switch, or yours again to take it back.`}`;
          body.splice(0, body.length, ...(notice ? [text(notice)] : []), text(head), ...controls, text("-# Only you can see this; the poll shows everyone's progress."));
        }
        return {
          flags: IS_COMPONENTS_V2 | (me ? EPHEMERAL : 0),
          allowed_mentions: { parse: [] as string[] },
          components: [{ type: 17, accent_color: poll.closed_at ? 0x57f287 : 0x5865f2, components: body }] as unknown[],
        };
      });

      const syncPanels = Effect.fn("Polls.syncPanels")(function* (id: number, mine?: Mine) {
        yield* panels.sync(`poll:${id}`, (user, notice) => render(id, user, notice), mine);
      });

      return Polls.of({
        create: Effect.fn("Polls.create")(function* (user: string, question: string, rawOptions: string) {
          let options = [...new Set(rawOptions.split("\n").map((o) => o.trim().slice(0, 80)).filter(Boolean))].slice(0, 10);
          if (options.length < 2) options = ["👍 Yes", "👎 No"];
          const [r] = yield* db
            .insert(polls)
            .values({ question: question.trim().slice(0, 200), options, created_by: user, created_at: yield* nowIso })
            .returning({ id: polls.id });
          return r.id;
        }),
        act: Effect.fn("Polls.act")(function* (id: number, user: string, action: string) {
          const poll = yield* getPoll(id);
          if (!poll) return { notice: "That poll has vanished 🫥", update: false };
          if (poll.closed_at) return { notice: "This poll is already decided 🔒", update: true };

          const c = yield* counts(poll);
          return yield* Match.value(action).pipe(
            Match.when("close", () =>
              Effect.gen(function* () {
                const top = Math.max(...c.voters.map((v) => v.length));
                if (!top) return { notice: "Nobody has voted yet 🤷", update: false };
                if (c.total < 2) return { notice: "One vote isn't a decision 😅 Wait for at least one more.", update: false };
                const leaders = c.options.filter((_, i) => c.voters[i].length === top);
                if (leaders.length > 1) return { notice: `🔁 Still split (${leaders.join(" vs ")}). Someone has to change their vote first.`, update: false };
                yield* close(id, `win:${leaders[0]}`);
                return { update: true };
              }),
            ),
            // an answer's number
            Match.orElse(() =>
              Effect.gen(function* () {
                const choice = Number(action);
                if (!Number.isInteger(choice) || choice < 0 || choice >= c.options.length) return { update: true };
                if (c.mine(user) === choice) {
                  yield* db.delete(pollVotes).where(and(eq(pollVotes.poll_id, id), eq(pollVotes.user_id, user)));
                  return { notice: "🗳️ Took your vote back.", update: true };
                }
                const at = yield* nowIso;
                yield* db
                  .insert(pollVotes)
                  .values({ poll_id: id, user_id: user, choice, voted_at: at })
                  .onConflictDoUpdate({ target: [pollVotes.poll_id, pollVotes.user_id], set: { choice, voted_at: at } });
                const after = yield* counts(poll);
                // nothing is decided until everyone's voted: then most votes wins; a split stays open (revealed)
                // for a re-vote
                if (!(yield* trio).every((p) => after.voters.some((v) => v.includes(p)))) return { update: true };
                const top = Math.max(...after.voters.map((v) => v.length));
                const leaders = after.options.filter((_, i) => after.voters[i].length === top);
                if (leaders.length === 1) yield* close(id, `win:${leaders[0]}`);
                return { update: true };
              }),
            ),
          );
        }),
        isClosed: Effect.fn("Polls.isClosed")(function* (id: number) {
          return !!(yield* getPoll(id))?.closed_at;
        }),
        setMessage: Effect.fn("Polls.setMessage")(function* (id: number, channelId: string | undefined, messageId: string) {
          yield* db.update(polls).set({ channel_id: channelId, message_id: messageId }).where(eq(polls.id, id));
        }),
        refresh: Effect.fn("Polls.refresh")(function* (id: number, mine?: Mine) {
          const p = yield* getPoll(id);
          if (!p) return;
          if (p.message_id) yield* discord.editMessage(p.channel_id!, p.message_id, yield* render(id));
          yield* syncPanels(id, mine);
        }),
        syncPanels,
        render,
      });
    }),
  );
}
