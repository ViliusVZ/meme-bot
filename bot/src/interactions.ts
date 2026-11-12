// Discord interactions: buttons, menus, forms and slash commands. Each handler answers within
// Discord's 3 seconds; anything slow (posting, animating, pinging) continues in the background.
import { and, gte, isNull, lt, sql } from "drizzle-orm";
import { Clock, Context, DateTime, Effect, Layer, Match, Schema } from "effect";
import { memes } from "./db/schema.js";
import { Db, type DbError } from "./db/db.js";
import { AppConfig, players } from "./config.js";
import { avatarUrl, Discord, type DiscordError, EPHEMERAL, IS_COMPONENTS_V2, Response as R } from "./discord.js";
import { Background } from "./background.js";
import { Alerts } from "./alerts.js";
import { Memes, utcDayAt, type VoteKind } from "./memes.js";
import { GameNight, type NightGone, suggestModal, customTimeModal } from "./gamenight.js";
import { Games } from "./games.js";
import { Hub, addGameModal } from "./hub.js";
import { Panels } from "./panels.js";
import { Polls, pollModal } from "./polls.js";
import { Voice, otherRoomModal, roomLine } from "./voice.js";
import { Activity, type Kind } from "./activity.js";
import { LateSlips } from "./late.js";
import { Attendances } from "./attendance.js";
import { Snoozes, type Span } from "./snooze.js";
import { Spontaneous, type Notice } from "./spontaneous.js";
import { LocalTime } from "./localtime.js";
import { Nights } from "./nights.js";
import { leaderboardMessage, memeMessage, statsMessage, streakNote } from "./ui.js";

// ---------------------------------------------------------------- the parts of an interaction the bot reads

const User = Schema.Struct({
  id: Schema.String,
  username: Schema.String,
  global_name: Schema.optional(Schema.NullOr(Schema.String)),
  avatar: Schema.optional(Schema.NullOr(Schema.String)),
});
type User = typeof User.Type;
const Field = Schema.Struct({ custom_id: Schema.optional(Schema.String), value: Schema.optional(Schema.String) });
/** A form's rows: each holds its text input as `components[0]` (or `component` in newer payloads). */
const Row = Schema.Struct({ components: Schema.optional(Schema.Array(Field)), component: Schema.optional(Field) });

export const Interaction = Schema.Struct({
  type: Schema.Number,
  token: Schema.optional(Schema.String),
  channel_id: Schema.optional(Schema.String),
  member: Schema.optional(Schema.Struct({ user: User })),
  user: Schema.optional(User),
  message: Schema.optional(Schema.Struct({ id: Schema.optional(Schema.String), flags: Schema.optional(Schema.Number) })),
  data: Schema.optional(
    Schema.Struct({
      custom_id: Schema.optional(Schema.String),
      name: Schema.optional(Schema.String),
      values: Schema.optional(Schema.Array(Schema.String)),
      components: Schema.optional(Schema.Array(Row)),
      options: Schema.optional(Schema.Array(Schema.Struct({ value: Schema.optional(Schema.Unknown) }))),
      resolved: Schema.optional(
        Schema.Struct({
          users: Schema.optional(Schema.Record(Schema.String, User)),
          members: Schema.optional(Schema.Record(Schema.String, Schema.Struct({ nick: Schema.optional(Schema.NullOr(Schema.String)) }))),
        }),
      ),
    }),
  ),
});
export type Interaction = typeof Interaction.Type;

/** The interaction's body didn't hold what a Discord interaction holds. */
export class InteractionMalformed extends Schema.TaggedError<InteractionMalformed>()("InteractionMalformed", { detail: Schema.String }) {}

// ---------------------------------------------------------------- what was tapped

/**
 * A `custom_id` (and the kind of interaction) as what it asks for. The order is the order the
 * handlers always checked them in; anything that matches none is from an older version of the bot.
 */
type Tap =
  | { readonly _tag: "Vote"; readonly memeId: string; readonly kind: VoteKind }
  | { readonly _tag: "Night"; readonly day: string; readonly action: string; readonly arg: string | undefined }
  | { readonly _tag: "Hub"; readonly what: string }
  | { readonly _tag: "Snooze"; readonly what: string }
  | { readonly _tag: "Stats"; readonly kind: string; readonly offset: string; readonly share: string | undefined }
  | { readonly _tag: "Late"; readonly day: string; readonly owner: string; readonly choice: string }
  | { readonly _tag: "Lobby"; readonly id: string; readonly what: string; readonly rest: ReadonlyArray<string> }
  | { readonly _tag: "RoomForm" }
  | { readonly _tag: "Room" }
  | { readonly _tag: "Plan"; readonly day: string }
  | { readonly _tag: "Games"; readonly what: string }
  | { readonly _tag: "Tiebreak" }
  | { readonly _tag: "PollNew" }
  | { readonly _tag: "Poll"; readonly id: string; readonly action: string }
  | { readonly _tag: "Command"; readonly name: string | undefined }
  | { readonly _tag: "Older" };

export function tapOf(i: Interaction): Tap {
  const cid = i.data?.custom_id ?? "";
  const button = i.type === 3;
  const form = i.type === 5;
  if (button && cid.startsWith("v:")) {
    const [, memeId, kind] = cid.split(":");
    return { _tag: "Vote", memeId, kind: kind as VoteKind };
  }
  // game night: buttons/selects (type 3) and the suggest/custom-time modals (type 5)
  // custom_id is gn:<day>:<action>[:<value>], e.g. gn:2026-11-03:time:1793736000
  if ((button || form) && cid.startsWith("gn:")) {
    const [, day, action, arg] = cid.split(":");
    return { _tag: "Night", day, action, arg };
  }
  if (button && cid.startsWith("hub:")) return { _tag: "Hub", what: cid.slice(4) };
  if (button && cid.startsWith("snz:")) return { _tag: "Snooze", what: cid.slice(4) };
  if (button && cid.startsWith("st:")) {
    const [, kind, offset, share] = cid.split(":");
    return { _tag: "Stats", kind, offset, share };
  }
  if (button && cid.startsWith("late:")) {
    const [, day, owner, choice] = cid.split(":");
    return { _tag: "Late", day, owner, choice };
  }
  if (button && cid.startsWith("lob:")) {
    const [, id, what, ...rest] = cid.split(":");
    return { _tag: "Lobby", id, what, rest };
  }
  if (cid === "room:other" && button) return { _tag: "RoomForm" };
  if ((cid === "room:open" && button) || (cid === "room:other" && form)) return { _tag: "Room" };
  if (button && cid.startsWith("plan:")) return { _tag: "Plan", day: cid.slice(5) };
  if (cid.startsWith("games:")) return { _tag: "Games", what: cid.slice(6) };
  if (cid.startsWith("tb:") && button) return { _tag: "Tiebreak" };
  if (cid === "poll:new" && form) return { _tag: "PollNew" };
  if (cid.startsWith("poll:") && button) {
    const [, id, action] = cid.split(":");
    return { _tag: "Poll", id, action };
  }
  if (i.type === 2) return { _tag: "Command", name: i.data?.name };
  return { _tag: "Older" };
}

// ---------------------------------------------------------------- answers

const reply = <T extends object>(data: T) => data;
const message = (data: object) => reply({ type: R.Message, data });
const ephemeral = (content: string) => reply({ type: R.Message, data: { content, flags: EPHEMERAL } });
const TRIO_ONLY = "This one's for the trio 😅";
const OLDER = "That button is from an older version of me. Try **/help** 🤖";

/** The click came from someone's private copy of a card (an ephemeral message), not the card. */
const fromPrivateCopy = (i: Interaction) => ((i.message?.flags ?? 0) & EPHEMERAL) !== 0;

export class Interactions extends Context.Service<
  Interactions,
  {
    /** One interaction (already verified), answered within Discord's 3 seconds. */
    handle(raw: unknown): Effect.Effect<object, InteractionMalformed | DbError | DiscordError | NightGone>;
  }
>()("meme-bot/interactions") {
  static readonly layer = Layer.effect(
    Interactions,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const db = yield* Db;
      const discord = yield* Discord;
      const background = yield* Background;
      const alerts = yield* Alerts;
      const memeService = yield* Memes;
      const gameNight = yield* GameNight;
      const games = yield* Games;
      const hub = yield* Hub;
      const panels = yield* Panels;
      const polls = yield* Polls;
      const voice = yield* Voice;
      const activity = yield* Activity;
      const late = yield* LateSlips;
      const attendances = yield* Attendances;
      const snoozes = yield* Snoozes;
      const spontaneous = yield* Spontaneous;
      const time = yield* LocalTime;
      const nights = yield* Nights;
      const trio = Effect.provideService(players, AppConfig, config);

      /** Run in the background (the tap's answer doesn't wait); a failure is reported under `label`. */
      const later = <A, E, R>(effect: Effect.Effect<A, E, R>, label?: string) => background.run(effect, label);
      const followup = (token: string, body: object) => discord.followup(token, body);
      const editOriginal = (token: string, body: object) => discord.editOriginal(token, body);
      /** The message an interaction's reply became (Discord may not have it yet). */
      const original = Effect.fnUntraced(function* (token: string) {
        const r = yield* discord.originalMessage(token);
        if (!r?.ok) return yield* new InteractionMalformed({ detail: `@original -> ${r?.status}` });
        return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ id: Schema.String, channel_id: Schema.optional(Schema.String) })))(r.text).pipe(
          Effect.mapError((e) => new InteractionMalformed({ detail: String(e) })),
        );
      });
      const note = (token: string, content: string) =>
        editOriginal(token, { flags: IS_COMPONENTS_V2, components: [{ type: 17, accent_color: 0x5865f2, components: [{ type: 10, content }] }] });
      const cardLink = (messageId: string | null) => (messageId ? `https://discord.com/channels/${config.guildId}/${config.gameChannelId}/${messageId}` : `<#${config.gameChannelId}>`);

      /** /playtoday and the 🎮 button. Posting can take a moment (retries), so answer "thinking…" first. */
      const playToday = Effect.fnUntraced(function* (token: string, userId: string) {
        yield* later(
          gameNight.startNight(userId).pipe(
            Effect.map((r) => {
              if (!("day" in r)) return "🤔 Couldn't start a poll.";
              if (r.started) return `🎮 Game night poll is up, with your ✅ already in: ${cardLink(r.message_id)}`;
              const state = { ask: "still collecting yeses", game: "picking a game", time: "picking a time", set: "already locked in 🎉", off: "called off" }[r.stage];
              return `Today's poll already exists (${state}): ${cardLink(r.message_id)}`;
            }),
            Effect.catch((e) => Effect.as(alerts.failed("posting the /playtoday card", e), "😵 Couldn't post the poll just now. I'll keep retrying every minute, or try again.")),
            Effect.flatMap((content) => editOriginal(token, { content })),
          ),
        );
        return reply({ type: R.DeferredMessage, data: { flags: EPHEMERAL } });
      });

      const handle = Effect.fn("Interactions.handle")(function* (raw: unknown) {
        const i = yield* Schema.decodeUnknownEffect(Interaction)(raw).pipe(Effect.mapError((e) => new InteractionMalformed({ detail: String(e).slice(0, 300) })));
        if (i.type === 1) return reply({ type: R.Pong });
        const user = (i.member?.user ?? i.user)!;
        const name = user.global_name ?? user.username;
        const token = i.token ?? "";
        const ps = yield* trio;
        const isPlayer = ps.includes(user.id);
        const modalValue = (field: string) =>
          (i.data?.components ?? []).map((r) => r.components?.[0] ?? r.component).find((c) => c?.custom_id === field)?.value ?? "";

        return yield* Match.value(tapOf(i)).pipe(
          Match.tag("Vote", ({ memeId, kind }) =>
            Effect.gen(function* () {
              const meme = yield* memeService.get(memeId);
              if (!meme) return ephemeral("That meme has left the building 🫥");
              const result = yield* memeService.castVote(memeId, user.id, kind);
              const streak = result === "new" && meme.post_kind === "daily" ? yield* memeService.bumpStreak(user.id, name) : null;
              if (streak) yield* later(followup(token, { content: streakNote(streak), flags: EPHEMERAL }));
              return reply({ type: R.UpdateMessage, data: memeMessage(meme, yield* memeService.tally(memeId), config.subreddit, yield* memeService.voters(memeId)) });
            }),
          ),
          Match.tag("Night", ({ day, action, arg }) =>
            Effect.gen(function* () {
              if (i.type === 3 && (action === "suggest" || action === "custom" || action === "leaveby")) {
                if (!isPlayer) return ephemeral(TRIO_ONLY);
                const modal = action === "suggest" ? suggestModal(day) : action === "custom" ? customTimeModal(day) : yield* gameNight.leaveByModal(day, user.id);
                return reply({ type: R.Modal, data: modal });
              }
              const field = i.data?.components?.[0]?.components?.[0] ?? i.data?.components?.[0]?.component;
              const value = i.type === 5 ? field?.value : (arg ?? i.data?.values?.[0]);
              const r = yield* gameNight.act(day, user.id, action, value, (e) => later(e, "game-night follow-up (pings, event)"));
              const own = fromPrivateCopy(i);
              const panel = own ? i.message?.id : undefined;
              // a refusal on your private panel shows up in the panel itself, not as another message
              if (!r.update && own && isPlayer) {
                yield* later(panels.track(`gn:${day}`, user.id, token, panel), "panel");
                return reply({ type: R.UpdateMessage, data: yield* gameNight.render(day, user.id, `⚠️ ${r.notice ?? "🤷"}`) });
              }
              if (!r.update) return ephemeral(r.notice ?? "🤷");
              // still voting: the clicker gets (or keeps) their private copy with their picks highlighted, and
              // the public card follows along. Nothing left to pick (locked in, called off): just the card.
              const night = yield* nights.get(day);
              if (!own && !["ask", "game", "time"].includes(night?.stage ?? "")) {
                if (r.notice) yield* later(followup(token, { content: r.notice, flags: EPHEMERAL }));
                yield* later(gameNight.syncPanels(day), "panels");
                return reply({ type: R.UpdateMessage, data: yield* gameNight.render(day) });
              }
              // every other private copy follows too (each player's, for 15 min after their last tap)
              yield* later(gameNight.refresh(day, panel ? { message_id: panel, notice: r.notice } : undefined), "card refresh");
              yield* later(panels.track(`gn:${day}`, user.id, token, panel), "panel");
              const mine = yield* gameNight.render(day, user.id, r.notice);
              return reply({ type: own ? R.UpdateMessage : R.Message, data: mine });
            }),
          ),
          // ---- the HQ panel / help buttons
          Match.tag("Hub", ({ what }) =>
            Effect.gen(function* () {
              if (what === "help") return reply({ type: R.Message, data: yield* hub.helpMessage });
              if (what === "stats") return reply({ type: R.Message, data: yield* activity.statsPanel() });
              if (!isPlayer) return ephemeral(TRIO_ONLY);
              if (what === "play") return yield* playToday(token, user.id);
              if (what === "plan") return reply({ type: R.Message, data: yield* gameNight.planPicker });
              if (what === "poll") return reply({ type: R.Modal, data: pollModal() });
              if (what === "games") return reply({ type: R.Message, data: yield* hub.gamesManager() });
              if (what === "room") return reply({ type: R.Message, data: yield* voice.roomPicker });
              if (what === "snooze") return reply({ type: R.Message, data: yield* snoozes.panel() });
              return ephemeral(OLDER);
            }),
          ),
          // ---- 😴 snooze panel: snz:<3d|week|month|wake>
          Match.tag("Snooze", ({ what }) =>
            Effect.gen(function* () {
              if (!isPlayer) return ephemeral(TRIO_ONLY);
              const notice = what === "wake" ? yield* snoozes.wake(user.id) : ["3d", "week", "month"].includes(what) ? yield* snoozes.snooze(user.id, what as Span) : "🤷";
              return reply({ type: R.UpdateMessage, data: yield* snoozes.panel(notice) });
            }),
          ),
          // ---- 📊 stats panel: st:<week|month|year|all>:<offset>[:share]
          Match.tag("Stats", ({ kind, offset: off, share }) =>
            Effect.gen(function* () {
              const k = (["week", "month", "year", "all"].includes(kind) ? kind : "week") as Kind;
              const offset = Math.min(0, Math.max(-520, Number(off) || 0));
              if (share) return reply({ type: R.Message, data: yield* activity.statsPanel(k, offset, user.id) });
              return reply({ type: R.UpdateMessage, data: yield* activity.statsPanel(k, offset) });
            }),
          ),
          // ---- ⏰ late slips: late:<day>:<user>:<5|15|30|out>
          Match.tag("Late", ({ day, owner, choice }) =>
            Effect.gen(function* () {
              const r = yield* late.act(day, owner, user.id, choice);
              if (r.notice) return ephemeral(r.notice);
              return reply({ type: R.UpdateMessage, data: yield* attendances.render(day, owner) });
            }),
          ),
          // ---- 🎮 the Lobby question: lob:<id>:g:<game> | lob:<id>:other | lob:<id>:chill; ↩ notes: lob:back:<users>
          Match.tag("Lobby", ({ id, what, rest }) =>
            Effect.gen(function* () {
              if (!isPlayer) return ephemeral(TRIO_ONLY);
              const tell = (n: Notice) => (n ? Effect.asVoid(followup(token, { ...(typeof n === "string" ? { content: n } : n), flags: EPHEMERAL })) : Effect.void);
              if (id === "back") {
                yield* later(Effect.flatMap(spontaneous.goBack(i.channel_id ?? "", what.split(","), i.message?.id), tell), "moving people back to the Lobby");
                return reply({ type: R.DeferredUpdate });
              }
              if (what === "other") return reply({ type: R.Message, data: yield* voice.roomPicker });
              yield* later(Effect.flatMap(spontaneous.answer(Number(id), user.id, what, rest.join(":")), tell), "answering the Lobby question");
              return reply({ type: R.DeferredUpdate });
            }),
          ),
          // ---- 🔊 game rooms: room:open (game dropdown), room:other (button → form → submit)
          Match.tag("RoomForm", () => Effect.succeed(reply({ type: R.Modal, data: otherRoomModal() }))),
          Match.tag("Room", () =>
            Effect.gen(function* () {
              if (!isPlayer) return ephemeral(TRIO_ONLY);
              const game = (i.type === 5 ? modalValue("value") : (i.data?.values?.[0] ?? "")).replace(/\s+/g, " ").trim();
              if (!game) return ephemeral("Give the room a name 🙃");
              // creating + moving takes a few API calls, so acknowledge first and fill the picker in after
              yield* later(
                Effect.gen(function* () {
                  const emoji = (yield* games.list()).find((g) => g.name.toLowerCase() === game.toLowerCase())?.emoji ?? null;
                  return roomLine(config.lobbyChannelId, yield* voice.openRoom(game, emoji, { by: user.id }));
                }).pipe(
                  Effect.catch((e) => Effect.as(alerts.failed("opening a game room", e), "😵 Couldn't open the room just now. Try again in a moment.")),
                  Effect.flatMap((content) => note(token, content)),
                ),
              );
              return reply({ type: R.DeferredUpdate });
            }),
          ),
          // ---- 📅 plan picker: plan:<day>
          Match.tag("Plan", ({ day }) =>
            Effect.gen(function* () {
              if (!isPlayer) return ephemeral(TRIO_ONLY);
              yield* later(
                gameNight.startNight(user.id, false, day).pipe(
                  Effect.flatMap((r) =>
                    !("day" in r)
                      ? Effect.succeed("That day is already over 🕰️")
                      : Effect.map(time.now, (l) => {
                          const when = day === l.day ? "today" : time.weekday(day);
                          return r.started ? `🎮 Poll for **${when}** is up, with your ✅ already in: ${cardLink(r.message_id)}` : `**${when}** already has a poll: ${cardLink(r.message_id)}`;
                        }),
                  ),
                  Effect.catch((e) => Effect.as(alerts.failed("posting a planned day's card", e), "😵 Couldn't post that poll just now. Try again in a minute.")),
                  Effect.flatMap((content) => note(token, content)),
                ),
              );
              return reply({ type: R.DeferredUpdate });
            }),
          ),
          // ---- 🕹️ games manager
          Match.tag("Games", ({ what }) =>
            Effect.gen(function* () {
              if (!isPlayer) return ephemeral(TRIO_ONLY);
              if (what === "add" && i.type === 3) return reply({ type: R.Modal, data: addGameModal() });
              if (what === "add" && i.type === 5) {
                const added = yield* games.add(modalValue("value"), user.id);
                yield* later(gameNight.refreshOpen.pipe(Effect.ignore));
                return reply({ type: R.UpdateMessage, data: yield* hub.gamesManager(added ? `➕ Added **${added}**` : "Give the game a name 🙃") });
              }
              if (what === "remove" && i.type === 3) {
                const gone = i.data?.values?.[0] ?? "";
                yield* games.remove(gone);
                yield* later(gameNight.refreshOpen.pipe(Effect.ignore));
                return reply({ type: R.UpdateMessage, data: yield* hub.gamesManager(`🗑️ Removed **${gone}**`) });
              }
              return ephemeral(OLDER);
            }),
          ),
          // ---- ⚔️ old tiebreaker buttons (retired: a split is a re-vote now)
          Match.tag("Tiebreak", () => Effect.succeed(ephemeral("Tiebreakers are retired 🔁 A split means a re-vote now: pick again on the card."))),
          // ---- 🗳️ polls: poll:new (modal) and poll:<id>:<choice|close>
          Match.tag("PollNew", () =>
            Effect.gen(function* () {
              const id = yield* polls.create(user.id, modalValue("question"), modalValue("options"));
              yield* later(
                original(token).pipe(
                  Effect.flatMap((m) => polls.setMessage(id, m.channel_id, m.id)),
                  Effect.catch((e) => Effect.logInfo(`poll @original ${e._tag}: ${e.message}`)),
                ),
              );
              return reply({ type: R.Message, data: yield* polls.render(id) });
            }),
          ),
          Match.tag("Poll", ({ id, action }) =>
            Effect.gen(function* () {
              // trio-only: polls decide things for the three of us
              if (!isPlayer) return ephemeral(TRIO_ONLY);
              const pollId = Number(id);
              const r = yield* polls.act(pollId, user.id, action);
              const own = fromPrivateCopy(i);
              const panel = own ? i.message?.id : undefined;
              const track = later(panels.track(`poll:${id}`, user.id, token, panel), "panel");
              if (!r.update && own && isPlayer) {
                yield* track;
                return reply({ type: R.UpdateMessage, data: yield* polls.render(pollId, user.id, `⚠️ ${r.notice ?? "🤷"}`) });
              }
              if (!r.update) return ephemeral(r.notice ?? "🤷");
              // like game-night cards: the poll follows along, the voter gets a private copy with their answer
              // (once it's decided there's nothing left to pick, so the poll itself just updates)
              if (!own && (yield* polls.isClosed(pollId))) {
                if (r.notice) yield* later(followup(token, { content: r.notice, flags: EPHEMERAL }));
                yield* later(polls.syncPanels(pollId), "panels");
                return reply({ type: R.UpdateMessage, data: yield* polls.render(pollId) });
              }
              // every other private copy follows too (each player's, for 15 min after their last tap)
              yield* later(polls.refresh(pollId, panel ? { message_id: panel, notice: r.notice } : undefined), "poll refresh");
              yield* track;
              const mine = yield* polls.render(pollId, user.id, r.notice);
              return reply({ type: own ? R.UpdateMessage : R.Message, data: mine });
            }),
          ),
          Match.tag("Older", () => Effect.succeed(ephemeral(OLDER))),
          Match.tag("Command", ({ name: command }) =>
            Effect.gen(function* () {
              const option = i.data?.options?.[0]?.value;
              return yield* Match.value(command).pipe(
                Match.when("meme", () =>
                  Effect.gen(function* () {
                    // pool: unposted memes from 2-7 days ago, so /meme never steals an upcoming daily
                    const now = yield* Clock.currentTimeMillis;
                    // claim → reply → its message id (§15): the claim stands once the reply is on its way
                    return yield* Effect.uninterruptible(
                      Effect.gen(function* () {
                        const [pick] = yield* db
                          .select()
                          .from(memes)
                          .where(and(isNull(memes.post_kind), gte(memes.published, utcDayAt(now, -7)), lt(memes.published, utcDayAt(now, -1))))
                          .orderBy(sql`random()`)
                          .limit(1);
                        if (!pick || !(yield* memeService.claim(pick.id, "request", { requestedBy: user.id })))
                          return ephemeral("The meme well is dry 🏜️ The pool refills every few hours, so try again later.");
                        const meme = { ...pick, post_kind: "request" as const, requested_by: user.id };
                        // (the record is the last step of the claim's region: it runs to the end too)
                        yield* later(
                          original(token).pipe(
                            Effect.flatMap((m) => memeService.setMessage(pick.id, m.channel_id, m.id)),
                            Effect.catch((e) => Effect.logInfo(`no @original ${e._tag}: ${e.message}`)),
                            Effect.uninterruptible,
                          ),
                        );
                        return reply({ type: R.Message, data: memeMessage(meme, {}, config.subreddit) });
                      }),
                    );
                  }),
                ),
                Match.when("top", () =>
                  Effect.gen(function* () {
                    const period = typeof option === "string" ? option : "week";
                    const days = ({ week: 7, month: 30, all: 0 } as Record<string, number>)[period] ?? 7;
                    const now = yield* Clock.currentTimeMillis;
                    const since = days ? DateTime.formatIso(DateTime.makeUnsafe(now - days * 864e5)) : null;
                    const label = ({ week: "this week", month: "this month", all: "of all time" } as Record<string, string>)[period];
                    return message(leaderboardMessage(`## 🏆 Top memes ${label}`, yield* memeService.leaderboard(since, null, 5), config.guildId));
                  }),
                ),
                Match.when("hall-of-fame", () =>
                  Effect.map(memeService.leaderboard(null, null, 10), (rows) =>
                    message(leaderboardMessage("## 👑 Hall of Fame\n-# The 10 greatest memes ever voted on here", rows, config.guildId, [], 0xe91e63)),
                  ),
                ),
                Match.when("stats", () =>
                  Effect.gen(function* () {
                    const targetId = typeof option === "string" ? option : user.id;
                    const target: User = i.data?.resolved?.users?.[targetId] ?? user;
                    const member = i.data?.resolved?.members?.[targetId];
                    const s = yield* memeService.userStats(targetId);
                    return message(
                      statsMessage(member?.nick ?? target.global_name ?? target.username, avatarUrl(target), {
                        kinds: s.kinds,
                        agree: s.agree,
                        streak: yield* memeService.liveStreak(s.user),
                        best: s.user?.best_streak ?? 0,
                        summoned: s.summoned,
                      }),
                    );
                  }),
                ),
                Match.when("playtoday", () => (isPlayer ? playToday(token, user.id) : Effect.succeed(ephemeral(TRIO_ONLY)))),
                Match.when("plan", () => (isPlayer ? Effect.map(gameNight.planPicker, (data) => reply({ type: R.Message, data })) : Effect.succeed(ephemeral(TRIO_ONLY)))),
                Match.when("snooze", () => (isPlayer ? Effect.map(snoozes.panel(), (data) => reply({ type: R.Message, data })) : Effect.succeed(ephemeral(TRIO_ONLY)))),
                Match.when("poll", () => Effect.succeed(isPlayer ? reply({ type: R.Modal, data: pollModal() }) : ephemeral(TRIO_ONLY))),
                Match.when("games", () => (isPlayer ? Effect.map(hub.gamesManager(), (data) => reply({ type: R.Message, data })) : Effect.succeed(ephemeral(TRIO_ONLY)))),
                Match.when("help", () => Effect.map(hub.helpMessage, (data) => reply({ type: R.Message, data }))),
                Match.when("gamestats", () => Effect.map(activity.statsPanel(), (data) => reply({ type: R.Message, data }))),
                Match.when("room", () => (isPlayer ? Effect.map(voice.roomPicker, (data) => reply({ type: R.Message, data })) : Effect.succeed(ephemeral(TRIO_ONLY)))),
                Match.orElse(() => Effect.succeed(ephemeral("Unknown command 🤔"))),
              );
            }),
          ),
          Match.exhaustive,
        );
      });

      return Interactions.of({ handle });
    }),
  );
}
