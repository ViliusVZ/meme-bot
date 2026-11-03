import * as db from "./db";
import {
  api,
  avatarUrl,
  editOriginal,
  EPHEMERAL,
  IS_COMPONENTS_V2,
  followup,
  originalMessage,
  Response as R,
  verifySignature,
} from "./discord";
import * as gn from "./gamenight";
import * as hub from "./hub";
import * as polls from "./polls";
import { leaderboardMessage, memeMessage, statsMessage, streakNote } from "./ui";

export interface Env {
  DB: D1Database;
  DISCORD_TOKEN: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_APP_ID: string;
  INGEST_SECRET: string;
  GUILD_ID: string;
  CHANNEL_ID: string;
  SUBREDDIT: string;
  POST_HOUR_UTC: string;
  GAME_CHANNEL_ID: string;
  PLAYERS: string;
  TIMEZONE: string;
  GAME_POLL_HOUR: string;
  QUIET?: boolean;
}

// keep in sync with wrangler.toml [triggers]
const CRON_TICK = "*/15 * * * *";
const CRON_WEEKLY = "0 18 * * SUN";
const CRON_MONTHLY = "0 9 1 * *";

/**
 * Every 15 minutes. Each job is idempotent and guarded by the database, so a tick can be
 * repeated or skipped safely, and one failing job doesn't stop the others.
 */
async function tick(env: Env) {
  const jobs: [string, (env: Env) => Promise<unknown>][] = [
    ["meme", postDaily], // posts once per day at or after POST_HOUR_UTC, from memes the fetcher ingested
    ["close", gn.closeStale], // midnight: close yesterday's unfinished poll
    ["start", (e) => gn.startNight(e)], // 17:00 poll, unless /playtoday already started one
    ["maintain", gn.maintain], // refresh time options, re-nudge, start-time reminders
  ];
  const out: Record<string, unknown> = {};
  for (const [name, job] of jobs) out[name] = await job(env).catch((e) => ({ error: String(e) }));
  return out;
}

const COMMANDS = [
  { name: "meme", description: "Summon a fresh top meme right now" },
  {
    name: "top",
    description: "The server's favourite memes",
    options: [
      {
        type: 3,
        name: "period",
        description: "Time range (default: this week)",
        choices: [
          { name: "This week", value: "week" },
          { name: "This month", value: "month" },
          { name: "All time", value: "all" },
        ],
      },
    ],
  },
  {
    name: "stats",
    description: "Meme voting stats, streak and persona",
    options: [{ type: 6, name: "user", description: "Whose stats (default: yours)" }],
  },
  { name: "hall-of-fame", description: "The 10 greatest memes this server has ever voted on" },
  { name: "playtoday", description: "Start today's game-night poll right now (counts as your yes)" },
  { name: "plan", description: "Plan a game night for any day this week" },
  { name: "poll", description: "Ask the trio a question and let democracy decide" },
  { name: "games", description: "See, add or remove games in the game-night list" },
  { name: "help", description: "How to use Meme Bot 3000" },
];

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const { pathname } = new URL(req.url);
    if (req.method !== "POST") return new Response("Meme Bot 3000 🔥");

    if (pathname === "/interactions") {
      const body = await req.text();
      if (!(await verifySignature(req, body, env.DISCORD_PUBLIC_KEY))) return new Response("bad signature", { status: 401 });
      const i = JSON.parse(body);
      try {
        return await interaction(i, env, ctx);
      } catch (e) {
        // a private apology beats Discord's generic "This interaction failed"
        console.log("interaction failed", i.data?.custom_id ?? i.data?.name, e);
        return ephemeral("Something went wrong on my end 🤕 Try again in a moment.");
      }
    }

    if (req.headers.get("Authorization") !== `Bearer ${env.INGEST_SECRET}`) return new Response("nope", { status: 401 });
    const input = (await req.json().catch(() => ({}))) as Record<string, any>;
    switch (pathname) {
      case "/ingest": {
        const ingested = await db.ingest(env, input.memes ?? []);
        const daily = input.post_daily ? await postDaily(env) : null;
        return json({ ingested, daily });
      }
      case "/admin/discord": // raw bot-token passthrough for maintenance scripts
        return json(await api(env, input.method ?? "GET", input.path, input.body ?? undefined).catch((e) => ({ error: String(e) })));
      case "/admin/gamenight": {
        // testing without pinging anyone: start [as user] | tick | reset | vote (as a player)
        const quiet = { ...env, QUIET: true };
        if (input.action === "start") return json(await gn.startNight(quiet, input.user, true));
        if (input.action === "tick") return json(await tick(quiet));
        if (input.action === "reset") return json(await gn.resetNight(env, input.day ?? gn.local(env).day));
        if (input.action === "plan") return json(await gn.startNight(quiet, input.user, true, input.day));
        if (input.action === "hub") {
          // post the button panel in the game-night channel and pin it
          const msg = await api(env, "POST", `/channels/${env.GAME_CHANNEL_ID}/messages`, hub.hubPanel(env));
          await api(env, "PUT", `/channels/${env.GAME_CHANNEL_ID}/pins/${msg.id}`);
          return json({ hub: msg.id });
        }
        if (input.action === "vote") {
          const day = input.day ?? gn.local(env).day;
          const r = await gn.act(quiet, day, input.user, input.choice, input.value, (p) => ctx.waitUntil(p));
          if (r.update) await gn.refresh(quiet, day);
          return json(r);
        }
        return json({ error: "action?" }, 400);
      }
      case "/admin/register":
        return json(await api(env, "PUT", `/applications/${env.DISCORD_APP_ID}/guilds/${env.GUILD_ID}/commands`, COMMANDS));
      case "/admin/recap":
        return json(await (input.period === "month" ? monthlyRecap(env) : weeklyRecap(env)));
      case "/admin/mark-posted": // seed ids that were posted before the bot had a database
        await env.DB.batch(
          (input.ids as string[]).map((id) =>
            env.DB.prepare(
              `INSERT INTO memes (id, title, image, link, author, published, ingested_at, post_kind, posted_at)
               VALUES (?, '(posted before DB)', '', '', '', '', ?, 'request', ?)
               ON CONFLICT(id) DO UPDATE SET post_kind = COALESCE(post_kind, 'request'), posted_at = COALESCE(posted_at, excluded.posted_at)`,
            ).bind(id, db.now(), db.now()),
          ),
        );
        return json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    const job = { [CRON_TICK]: tick, [CRON_WEEKLY]: weeklyRecap, [CRON_MONTHLY]: monthlyRecap }[event.cron];
    if (job) {
      ctx.waitUntil(
        job(env).then(
          (r) => console.log(event.cron, JSON.stringify(r)),
          (e) => console.log(event.cron, "failed", e),
        ),
      );
    }
  },
};

// ---------------------------------------------------------------- daily post

/**
 * Post the top meme published yesterday (UTC). Safe to call any number of times: the
 * database allows exactly one daily per day, so the fetcher and the fallback cron can't
 * double-post.
 */
async function postDaily(env: Env) {
  if (new Date().getUTCHours() < Number(env.POST_HOUR_UTC)) return { skipped: "too early" };
  const day = db.utcDay(-1);
  const existing = await env.DB.prepare("SELECT id FROM memes WHERE post_kind = 'daily' AND day = ?").bind(day).first();
  if (existing) return { skipped: "already posted", day };

  const candidates = await env.DB.prepare(
    "SELECT * FROM memes WHERE post_kind IS NULL AND substr(published, 1, 10) = ? ORDER BY rank LIMIT 5",
  )
    .bind(day)
    .all<db.Meme>();
  for (const cand of candidates.results) {
    if (!(await db.claim(env, cand.id, "daily", { day }))) continue;
    const meme = { ...cand, post_kind: "daily" as const, day };
    let msg: { id: string };
    try {
      msg = await api(env, "POST", `/channels/${env.CHANNEL_ID}/messages`, memeMessage(meme, {}, env.SUBREDDIT));
    } catch (e) {
      await db.unclaim(env, cand.id);
      throw e;
    }
    await db.setMessage(env, cand.id, env.CHANNEL_ID, msg.id);
    await api(env, "POST", `/channels/${env.CHANNEL_ID}/messages/${msg.id}/threads`, {
      name: `💬 ${cand.title}`.slice(0, 100),
      auto_archive_duration: 1440,
    }).catch((e) => console.log("thread failed", e));
    return { posted: cand.id, day };
  }
  return { skipped: "no candidate", day };
}

// ---------------------------------------------------------------- recaps

async function recap(env: Env, period: string, title: string, since: Date, until: Date, accent?: number) {
  if (!(await db.claimRecap(env, period))) return { skipped: "already posted", period };
  try {
    const rows = await db.leaderboard(env, since.toISOString(), until.toISOString(), 5);
    if (!rows.length) {
      await db.unclaimRecap(env, period);
      return { skipped: "no votes", period };
    }
    const voter = await db.topVoter(env, since.toISOString(), until.toISOString());
    const streak = await db.longestLiveStreak(env);
    const extras = [
      voter && `🗳️ Most votes: <@${voter.user_id}> (${voter.n})`,
      streak && streak.streak > 1 && `🔥 Longest streak: <@${streak.user_id}> (${streak.streak} days)`,
    ].filter(Boolean) as string[];
    await api(env, "POST", `/channels/${env.CHANNEL_ID}/messages`, leaderboardMessage(title, rows, env.GUILD_ID, extras, accent));
    return { posted: period };
  } catch (e) {
    await db.unclaimRecap(env, period);
    throw e;
  }
}

function weeklyRecap(env: Env) {
  const until = new Date();
  const since = new Date(until.getTime() - 7 * 864e5);
  return recap(env, `week:${db.utcDay()}`, "## 🏆 Meme of the Week\n-# The server has spoken. Top 5 by votes:", since, until);
}

function monthlyRecap(env: Env) {
  const until = new Date();
  until.setUTCDate(1);
  until.setUTCHours(0, 0, 0, 0);
  const since = new Date(until);
  since.setUTCMonth(since.getUTCMonth() - 1);
  const label = since.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  return recap(env, `month:${since.toISOString().slice(0, 7)}`, `## 👑 Hall of Fame · ${label}`, since, until, 0xe91e63);
}

// ---------------------------------------------------------------- interactions

type User = { id: string; username: string; global_name?: string | null; avatar?: string | null };

async function interaction(i: any, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (i.type === 1) return json({ type: R.Pong });
  const user: User = i.member?.user ?? i.user;
  const name = user.global_name ?? user.username;

  if (i.type === 3 && i.data.custom_id.startsWith("v:")) {
    const [, memeId, kind] = i.data.custom_id.split(":") as [string, string, db.VoteKind];
    const meme = await db.getMeme(env, memeId);
    if (!meme) return ephemeral("That meme has left the building 🫥");
    const result = await db.castVote(env, memeId, user.id, kind);
    const streak = result === "new" && meme.post_kind === "daily" ? await db.bumpStreak(env, user.id, name) : null;
    if (streak) ctx.waitUntil(followup(env, i.token, { content: streakNote(streak), flags: EPHEMERAL }));
    return json({ type: R.UpdateMessage, data: memeMessage(meme, await db.tally(env, memeId), env.SUBREDDIT) });
  }

  // game night: buttons/selects (type 3) and the suggest/custom-time modals (type 5)
  // custom_id is gn:<day>:<action>[:<value>], e.g. gn:2026-11-03:time:1793736000
  if ((i.type === 3 || i.type === 5) && i.data.custom_id.startsWith("gn:")) {
    const [, day, action, arg] = i.data.custom_id.split(":");
    if (i.type === 3 && (action === "suggest" || action === "custom")) {
      if (!gn.players(env).includes(user.id)) return ephemeral("This one's for the trio 😅");
      return json({ type: R.Modal, data: action === "suggest" ? gn.suggestModal(day) : gn.customTimeModal(day) });
    }
    const field = i.data.components?.[0]?.components?.[0] ?? i.data.components?.[0]?.component;
    const value: string | undefined = i.type === 5 ? field?.value : (arg ?? i.data.values?.[0]);
    const r = await gn.act(env, day, user.id, action, value, (p) => ctx.waitUntil(p.catch((e) => console.log("gn", e))));
    if (!r.update) return ephemeral(r.notice ?? "🤷");
    if (r.notice) ctx.waitUntil(gn.notify(env, i.token, r.notice));
    return json({ type: R.UpdateMessage, data: await gn.render(env, day) });
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
    if (what === "help") return json({ type: R.Message, data: hub.helpMessage(env) });
    if (!isPlayer) return ephemeral("This one's for the trio 😅");
    if (what === "play") return playToday(env, i, user.id, ctx);
    if (what === "plan") return json({ type: R.Message, data: await gn.planPicker(env) });
    if (what === "poll") return json({ type: R.Modal, data: polls.pollModal() });
    if (what === "games") return json({ type: R.Message, data: await hub.gamesManager(env) });
  }

  // ---- 📅 plan picker: plan:<day>
  if (i.type === 3 && cid.startsWith("plan:")) {
    if (!isPlayer) return ephemeral("This one's for the trio 😅");
    const day = cid.slice(5);
    ctx.waitUntil(
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
    return json({ type: R.DeferredUpdate });
  }

  // ---- 🕹️ games manager
  if (cid === "games:add" && i.type === 3) return json({ type: R.Modal, data: hub.addGameModal() });
  if (cid === "games:add" && i.type === 5) {
    const name = await gn.addGame(env, modalValue("value"), user.id);
    ctx.waitUntil(gn.refresh(env, gn.local(env).day).catch(() => {}));
    return json({ type: R.UpdateMessage, data: await hub.gamesManager(env, name ? `➕ Added **${name}**` : "Give the game a name 🙃") });
  }
  if (cid === "games:remove" && i.type === 3) {
    const name: string = i.data.values?.[0] ?? "";
    await gn.removeGame(env, name);
    ctx.waitUntil(gn.refresh(env, gn.local(env).day).catch(() => {}));
    return json({ type: R.UpdateMessage, data: await hub.gamesManager(env, `🗑️ Removed **${name}**`) });
  }

  // ---- 🗳️ polls: poll:new (modal) and poll:<id>:<choice|close|dice>
  if (cid === "poll:new" && i.type === 5) {
    const id = await polls.createPoll(env, user.id, modalValue("question"), modalValue("options"));
    return json({ type: R.Message, data: await polls.renderPoll(env, id) });
  }
  if (cid.startsWith("poll:") && i.type === 3) {
    const [, id, action] = cid.split(":");
    const r = await polls.pollAct(env, Number(id), user.id, action);
    if (!r.update) return ephemeral(r.notice ?? "🤷");
    if (r.notice) ctx.waitUntil(gn.notify(env, i.token, r.notice));
    return json({ type: R.UpdateMessage, data: await polls.renderPoll(env, Number(id)) });
  }

  if (i.type !== 2) return ephemeral("That button is from an older version of me. Try **/help** 🤖");
  switch (i.data.name) {
    case "meme": {
      // pool: unposted memes from 2-7 days ago, so /meme never steals an upcoming daily
      const pick = await env.DB.prepare(
        "SELECT * FROM memes WHERE post_kind IS NULL AND published >= ? AND published < ? ORDER BY RANDOM() LIMIT 1",
      )
        .bind(db.utcDay(-7), db.utcDay(-1))
        .first<db.Meme>();
      if (!pick || !(await db.claim(env, pick.id, "request", { requestedBy: user.id })))
        return ephemeral("The meme well is dry 🏜️ The pool refills every few hours, so try again later.");
      const meme = { ...pick, post_kind: "request" as const, requested_by: user.id };
      ctx.waitUntil(
        originalMessage(env, i.token)
          .then((m) => db.setMessage(env, pick.id, m.channel_id, m.id))
          .catch((e) => console.log("no @original", e)),
      );
      return json({ type: R.Message, data: memeMessage(meme, {}, env.SUBREDDIT) });
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
      return playToday(env, i, user.id, ctx);
    case "plan":
      if (!isPlayer) return ephemeral("This one's for the trio 😅");
      return json({ type: R.Message, data: await gn.planPicker(env) });
    case "poll":
      return json({ type: R.Modal, data: polls.pollModal() });
    case "games":
      return json({ type: R.Message, data: await hub.gamesManager(env) });
    case "help":
      return json({ type: R.Message, data: hub.helpMessage(env) });
  }
  return ephemeral("Unknown command 🤔");
}

/** /playtoday and the 🎮 button. Posting can take a moment (retries), so answer "thinking…" first. */
function playToday(env: Env, i: any, userId: string, ctx: ExecutionContext) {
  ctx.waitUntil(
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
        return "😵 Couldn't post the poll just now. I'll retry automatically within 15 minutes, or try again.";
      })
      .then((content) => editOriginal(env, i.token, { content })),
  );
  return json({ type: R.DeferredMessage, data: { flags: EPHEMERAL } });
}

const message = (data: object) => json({ type: R.Message, data });
const ephemeral = (content: string) => json({ type: R.Message, data: { content, flags: EPHEMERAL } });
