import * as db from "./db";
import {
  api,
  avatarUrl,
  EPHEMERAL,
  followup,
  originalMessage,
  Response as R,
  verifySignature,
} from "./discord";
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
}

// keep in sync with wrangler.toml [triggers]
const CRON_DAILY_FALLBACK = "30 13 * * *";
const CRON_WEEKLY = "0 18 * * SUN";
const CRON_MONTHLY = "0 9 1 * *";

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
      return interaction(JSON.parse(body), env, ctx);
    }

    if (req.headers.get("Authorization") !== `Bearer ${env.INGEST_SECRET}`) return new Response("nope", { status: 401 });
    const input = (await req.json().catch(() => ({}))) as Record<string, any>;
    switch (pathname) {
      case "/ingest": {
        const ingested = await db.ingest(env, input.memes ?? []);
        const daily = input.post_daily ? await postDaily(env) : null;
        return json({ ingested, daily });
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
    const job = { [CRON_DAILY_FALLBACK]: postDaily, [CRON_WEEKLY]: weeklyRecap, [CRON_MONTHLY]: monthlyRecap }[event.cron];
    if (job) ctx.waitUntil(job(env).then((r) => console.log(event.cron, JSON.stringify(r))));
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

  if (i.type !== 2) return ephemeral("🤷");
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
  }
  return ephemeral("Unknown command 🤔");
}

const message = (data: object) => json({ type: R.Message, data });
const ephemeral = (content: string) => json({ type: R.Message, data: { content, flags: EPHEMERAL } });
