// Discord interactions: buttons, menus, forms and slash commands. Each handler answers within
// Discord's 3 seconds; anything slow (posting, animating, pinging) continues in the background.
import { and, gte, isNull, lt, sql } from "drizzle-orm";
import type { Env } from "./env.js";
import { memes } from "./db/index.js";
import { avatarUrl, editOriginal, EPHEMERAL, IS_COMPONENTS_V2, followup, originalMessage, Response as R } from "./discord.js";
import { defer } from "./background.js";
import * as db from "./memes.js";
import * as gn from "./gamenight.js";
import * as hub from "./hub.js";
import * as polls from "./polls.js";
import * as voice from "./voice.js";
import * as activity from "./activity.js";
import * as late from "./late.js";
import * as snooze from "./snooze.js";
import { leaderboardMessage, memeMessage, statsMessage, streakNote } from "./ui.js";

type User = { id: string; username: string; global_name?: string | null; avatar?: string | null };

/** The click came from someone's private copy of a card (an ephemeral message), not the card. */
const fromPrivateCopy = (i: any) => ((i.message?.flags ?? 0) & EPHEMERAL) !== 0;

export async function interaction(i: any, env: Env): Promise<object> {
  if (i.type === 1) return reply({ type: R.Pong });
  const user: User = i.member?.user ?? i.user;
  const name = user.global_name ?? user.username;

  if (i.type === 3 && i.data.custom_id.startsWith("v:")) {
    const [, memeId, kind] = i.data.custom_id.split(":") as [string, string, db.VoteKind];
    const meme = await db.getMeme(env, memeId);
    if (!meme) return ephemeral("That meme has left the building 🫥");
    const result = await db.castVote(env, memeId, user.id, kind);
    const streak = result === "new" && meme.post_kind === "daily" ? await db.bumpStreak(env, user.id, name) : null;
    if (streak) defer(followup(env, i.token, { content: streakNote(streak), flags: EPHEMERAL }));
    return reply({ type: R.UpdateMessage, data: memeMessage(meme, await db.tally(env, memeId), env.SUBREDDIT, await db.voters(env, memeId)) });
  }

  // game night: buttons/selects (type 3) and the suggest/custom-time modals (type 5)
  // custom_id is gn:<day>:<action>[:<value>], e.g. gn:2026-11-03:time:1793736000
  if ((i.type === 3 || i.type === 5) && i.data.custom_id.startsWith("gn:")) {
    const [, day, action, arg] = i.data.custom_id.split(":");
    if (i.type === 3 && (action === "suggest" || action === "custom" || action === "leaveby")) {
      if (!gn.players(env).includes(user.id)) return ephemeral("This one's for the trio 😅");
      const modal =
        action === "suggest" ? gn.suggestModal(day) : action === "custom" ? gn.customTimeModal(day) : await gn.leaveByModal(env, day, user.id);
      return reply({ type: R.Modal, data: modal });
    }
    const field = i.data.components?.[0]?.components?.[0] ?? i.data.components?.[0]?.component;
    const value: string | undefined = i.type === 5 ? field?.value : (arg ?? i.data.values?.[0]);
    const r = await gn.act(env, day, user.id, action, value, (p) => defer(p, "gn"));
    // a refusal on your private panel shows up in the panel itself, not as another message
    if (!r.update && fromPrivateCopy(i) && gn.players(env).includes(user.id))
      return reply({ type: R.UpdateMessage, data: await gn.render(env, day, user.id, `⚠️ ${r.notice ?? "🤷"}`) });
    if (!r.update) return ephemeral(r.notice ?? "🤷");
    // still voting: the clicker gets (or keeps) their private copy with their picks highlighted, and
    // the public card follows along. Nothing left to pick (locked in, called off): just the card.
    const night = await gn.getNight(env, day);
    if (!fromPrivateCopy(i) && !["ask", "game", "time"].includes(night?.stage ?? "")) {
      if (r.notice) defer(gn.notify(env, i.token, r.notice));
      return reply({ type: R.UpdateMessage, data: await gn.render(env, day) });
    }
    defer(gn.refresh(env, day), "card refresh");
    const mine = await gn.render(env, day, user.id, r.notice);
    return reply({ type: fromPrivateCopy(i) ? R.UpdateMessage : R.Message, data: mine });
  }

  const isPlayer = gn.players(env).includes(user.id);
  const cid: string = i.data?.custom_id ?? "";
  const modalValue = (field: string) =>
    (i.data.components ?? [])
      .map((r: any) => r.components?.[0] ?? r.component)
      .find((c: any) => c?.custom_id === field)?.value ?? "";

  // ---- the HQ panel / help buttons
  if (i.type === 3 && cid.startsWith("hub:")) {
    const what = cid.slice(4);
    if (what === "help") return reply({ type: R.Message, data: hub.helpMessage(env) });
    if (what === "stats") return reply({ type: R.Message, data: await activity.statsPanel(env) });
    if (!isPlayer) return ephemeral("This one's for the trio 😅");
    if (what === "play") return playToday(env, i, user.id);
    if (what === "plan") return reply({ type: R.Message, data: await gn.planPicker(env) });
    if (what === "poll") return reply({ type: R.Modal, data: polls.pollModal() });
    if (what === "games") return reply({ type: R.Message, data: await hub.gamesManager(env) });
    if (what === "room") return reply({ type: R.Message, data: await voice.roomPicker(env) });
    if (what === "snooze") return reply({ type: R.Message, data: await snooze.panel(env) });
  }

  // ---- 😴 snooze panel: snz:<3d|week|month|wake>
  if (i.type === 3 && cid.startsWith("snz:")) {
    if (!isPlayer) return ephemeral("This one's for the trio 😅");
    const what = cid.slice(4);
    const notice = what === "wake" ? await snooze.wake(env, user.id) : ["3d", "week", "month"].includes(what) ? await snooze.snooze(env, user.id, what as snooze.Span) : "🤷";
    return reply({ type: R.UpdateMessage, data: await snooze.panel(env, notice) });
  }

  // ---- 📊 stats panel: st:<week|month|year|all>:<offset>[:share]
  if (i.type === 3 && cid.startsWith("st:")) {
    const [, kind, off, share] = cid.split(":");
    const k = (["week", "month", "year", "all"].includes(kind) ? kind : "week") as activity.Kind;
    const offset = Math.min(0, Math.max(-520, Number(off) || 0));
    if (share) return reply({ type: R.Message, data: await activity.statsPanel(env, k, offset, user.id) });
    return reply({ type: R.UpdateMessage, data: await activity.statsPanel(env, k, offset) });
  }

  // ---- ⏰ late slips: late:<day>:<user>:<5|15|30|out>
  if (i.type === 3 && cid.startsWith("late:")) {
    const [, day, owner, choice] = cid.split(":");
    const r = await late.act(env, day, owner, user.id, choice);
    if (r.notice) return ephemeral(r.notice);
    return reply({ type: R.UpdateMessage, data: await late.render(env, day, owner) });
  }

  // ---- 🔊 game rooms: room:open (game dropdown), room:other (button → form → submit)
  if (cid === "room:other" && i.type === 3) return reply({ type: R.Modal, data: voice.otherRoomModal() });
  if ((cid === "room:open" && i.type === 3) || (cid === "room:other" && i.type === 5)) {
    if (!isPlayer) return ephemeral("This one's for the trio 😅");
    const game = (i.type === 5 ? modalValue("value") : i.data.values?.[0] ?? "").replace(/\s+/g, " ").trim();
    if (!game) return ephemeral("Give the room a name 🙃");
    // creating + moving takes a few API calls, so acknowledge first and fill the picker in after
    defer(
      (async () => {
        const emoji = (await gn.games(env)).find((g) => g.name.toLowerCase() === game.toLowerCase())?.emoji ?? null;
        const r = await voice.openRoom(env, game, emoji, { by: user.id });
        return voice.roomResult(env, r);
      })()
        .catch((e) => {
          console.log("room failed", e);
          return "😵 Couldn't open the room just now. Try again in a moment.";
        })
        .then((note) => editOriginal(env, i.token, { flags: IS_COMPONENTS_V2, components: [{ type: 17, accent_color: 0x5865f2, components: [{ type: 10, content: note }] }] })),
    );
    return reply({ type: R.DeferredUpdate });
  }

  // ---- 📅 plan picker: plan:<day>
  if (i.type === 3 && cid.startsWith("plan:")) {
    if (!isPlayer) return ephemeral("This one's for the trio 😅");
    const day = cid.slice(5);
    defer(
      gn
        .startNight(env, user.id, false, day)
        .then((r) => {
          if (!("day" in r)) return "That day is already over 🕰️";
          const when = day === gn.local(env).day ? "today" : gn.weekday(env, day);
          const link = r.message_id ? `https://discord.com/channels/${env.GUILD_ID}/${env.GAME_CHANNEL_ID}/${r.message_id}` : `<#${env.GAME_CHANNEL_ID}>`;
          return r.started ? `🎮 Poll for **${when}** is up, with your ✅ already in: ${link}` : `**${when}** already has a poll: ${link}`;
        })
        .catch((e) => {
          console.log("plan failed", e);
          return "😵 Couldn't post that poll just now. Try again in a minute.";
        })
        .then((note) => editOriginal(env, i.token, { flags: IS_COMPONENTS_V2, components: [{ type: 17, accent_color: 0x5865f2, components: [{ type: 10, content: note }] }] })),
    );
    return reply({ type: R.DeferredUpdate });
  }

  // ---- 🕹️ games manager
  if (cid.startsWith("games:") && !isPlayer) return ephemeral("This one's for the trio 😅");
  if (cid === "games:add" && i.type === 3) return reply({ type: R.Modal, data: hub.addGameModal() });
  if (cid === "games:add" && i.type === 5) {
    const name = await gn.addGame(env, modalValue("value"), user.id);
    defer(gn.refreshOpen(env).catch(() => {}));
    return reply({ type: R.UpdateMessage, data: await hub.gamesManager(env, name ? `➕ Added **${name}**` : "Give the game a name 🙃") });
  }
  if (cid === "games:remove" && i.type === 3) {
    const name: string = i.data.values?.[0] ?? "";
    await gn.removeGame(env, name);
    defer(gn.refreshOpen(env).catch(() => {}));
    return reply({ type: R.UpdateMessage, data: await hub.gamesManager(env, `🗑️ Removed **${name}**`) });
  }

  // ---- ⚔️ old tiebreaker buttons (retired: a split is a re-vote now)
  if (cid.startsWith("tb:") && i.type === 3) return ephemeral("Tiebreakers are retired 🔁 A split means a re-vote now: pick again on the card.");

  // ---- 🗳️ polls: poll:new (modal) and poll:<id>:<choice|close>
  if (cid === "poll:new" && i.type === 5) {
    const id = await polls.createPoll(env, user.id, modalValue("question"), modalValue("options"));
    defer(
      originalMessage(env, i.token)
        .then((m) => polls.setMessage(env, id, m.channel_id, m.id))
        .catch((e) => console.log("poll @original", e)),
    );
    return reply({ type: R.Message, data: await polls.renderPoll(env, id) });
  }
  if (cid.startsWith("poll:") && i.type === 3) {
    // trio-only: polls decide things for the three of us
    if (!isPlayer) return ephemeral("This one's for the trio 😅");
    const [, id, action] = cid.split(":");
    const r = await polls.pollAct(env, Number(id), user.id, action);
    if (!r.update && fromPrivateCopy(i) && gn.players(env).includes(user.id))
      return reply({ type: R.UpdateMessage, data: await polls.renderPoll(env, Number(id), user.id, `⚠️ ${r.notice ?? "🤷"}`) });
    if (!r.update) return ephemeral(r.notice ?? "🤷");
    // like game-night cards: the poll follows along, the voter gets a private copy with their answer
    // (once it's decided there's nothing left to pick, so the poll itself just updates)
    if (!fromPrivateCopy(i) && (await polls.isClosed(env, Number(id)))) {
      if (r.notice) defer(gn.notify(env, i.token, r.notice));
      return reply({ type: R.UpdateMessage, data: await polls.renderPoll(env, Number(id)) });
    }
    defer(polls.refreshPoll(env, Number(id)), "poll refresh");
    const mine = await polls.renderPoll(env, Number(id), user.id, r.notice);
    return reply({ type: fromPrivateCopy(i) ? R.UpdateMessage : R.Message, data: mine });
  }

  if (i.type !== 2) return ephemeral("That button is from an older version of me. Try **/help** 🤖");
  switch (i.data.name) {
    case "meme": {
      // pool: unposted memes from 2-7 days ago, so /meme never steals an upcoming daily
      const [pick] = await env.db
        .select()
        .from(memes)
        .where(and(isNull(memes.post_kind), gte(memes.published, db.utcDay(-7)), lt(memes.published, db.utcDay(-1))))
        .orderBy(sql`random()`)
        .limit(1);
      if (!pick || !(await db.claim(env, pick.id, "request", { requestedBy: user.id })))
        return ephemeral("The meme well is dry 🏜️ The pool refills every few hours, so try again later.");
      const meme = { ...pick, post_kind: "request" as const, requested_by: user.id };
      defer(
        originalMessage(env, i.token)
          .then((m) => db.setMessage(env, pick.id, m.channel_id, m.id))
          .catch((e) => console.log("no @original", e)),
      );
      return reply({ type: R.Message, data: memeMessage(meme, {}, env.SUBREDDIT) });
    }
    case "top": {
      const period: string = i.data.options?.[0]?.value ?? "week";
      const days = { week: 7, month: 30, all: 0 }[period] ?? 7;
      const since = days ? new Date(Date.now() - days * 864e5).toISOString() : null;
      const label = { week: "this week", month: "this month", all: "of all time" }[period];
      return message(leaderboardMessage(`## 🏆 Top memes ${label}`, await db.leaderboard(env, since, null, 5), env.GUILD_ID));
    }
    case "hall-of-fame":
      return message(
        leaderboardMessage("## 👑 Hall of Fame\n-# The 10 greatest memes ever voted on here", await db.leaderboard(env, null, null, 10), env.GUILD_ID, [], 0xe91e63),
      );
    case "stats": {
      const targetId: string = i.data.options?.[0]?.value ?? user.id;
      const target: User = i.data.resolved?.users?.[targetId] ?? user;
      const member = i.data.resolved?.members?.[targetId];
      const s = await db.userStats(env, targetId);
      return message(
        statsMessage(member?.nick ?? target.global_name ?? target.username, avatarUrl(target), {
          kinds: s.kinds,
          agree: s.agree,
          streak: db.liveStreak(s.user),
          best: s.user?.best_streak ?? 0,
          summoned: s.summoned,
        }),
      );
    }
    case "playtoday":
      if (!isPlayer) return ephemeral("This one's for the trio 😅");
      return playToday(env, i, user.id);
    case "plan":
      if (!isPlayer) return ephemeral("This one's for the trio 😅");
      return reply({ type: R.Message, data: await gn.planPicker(env) });
    case "snooze":
      if (!isPlayer) return ephemeral("This one's for the trio 😅");
      return reply({ type: R.Message, data: await snooze.panel(env) });
    case "poll":
      if (!isPlayer) return ephemeral("This one's for the trio 😅");
      return reply({ type: R.Modal, data: polls.pollModal() });
    case "games":
      if (!isPlayer) return ephemeral("This one's for the trio 😅");
      return reply({ type: R.Message, data: await hub.gamesManager(env) });
    case "help":
      return reply({ type: R.Message, data: hub.helpMessage(env) });
    case "gamestats":
      return reply({ type: R.Message, data: await activity.statsPanel(env) });
    case "room":
      if (!isPlayer) return ephemeral("This one's for the trio 😅");
      return reply({ type: R.Message, data: await voice.roomPicker(env) });
  }
  return ephemeral("Unknown command 🤔");
}

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

/** /playtoday and the 🎮 button. Posting can take a moment (retries), so answer "thinking…" first. */
function playToday(env: Env, i: any, userId: string) {
  defer(
    gn
      .startNight(env, userId)
      .then((r) => {
        if (!("day" in r)) return "🤔 Couldn't start a poll.";
        const link = r.message_id ? `https://discord.com/channels/${env.GUILD_ID}/${env.GAME_CHANNEL_ID}/${r.message_id}` : `<#${env.GAME_CHANNEL_ID}>`;
        if (r.started) return `🎮 Game night poll is up, with your ✅ already in: ${link}`;
        const state = { ask: "still collecting yeses", game: "picking a game", time: "picking a time", set: "already locked in 🎉", off: "called off" }[r.stage];
        return `Today's poll already exists (${state}): ${link}`;
      })
      .catch((e) => {
        console.log("playtoday failed", e);
        return "😵 Couldn't post the poll just now. I'll keep retrying every minute, or try again.";
      })
      .then((content) => editOriginal(env, i.token, { content })),
  );
  return reply({ type: R.DeferredMessage, data: { flags: EPHEMERAL } });
}

const reply = <T extends object>(data: T) => data;
const message = (data: object) => reply({ type: R.Message, data });
const ephemeral = (content: string) => reply({ type: R.Message, data: { content, flags: EPHEMERAL } });
