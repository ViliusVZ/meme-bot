// HTTP: Discord interactions, meme intake from the GitHub fetcher, admin/test routes, health.
import Fastify from "fastify";
import { timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Env } from "./env.js";
import { memes } from "./db/index.js";
import { api, EPHEMERAL, Response as R, verifySignature } from "./discord.js";
import { inFlight } from "./background.js";
import { interaction } from "./interactions.js";
import * as db from "./memes.js";
import { memeMessage } from "./ui.js";
import * as jobs from "./jobs.js";
import * as gn from "./gamenight.js";
import * as hub from "./hub.js";
import * as polls from "./polls.js";
import * as voice from "./voice.js";
import * as activity from "./activity.js";
import * as late from "./late.js";
import * as presence from "./presence.js";

export const COMMANDS = [
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
  { name: "snooze", description: "Pause the daily game-night poll for 3 days, a week or a month" },
  { name: "poll", description: "Ask the trio a question and let democracy decide" },
  { name: "games", description: "See, add or remove games in the game-night list" },
  { name: "room", description: "Open a voice room for a game and bring everyone from the Lobby" },
  { name: "gamestats", description: "Voice time, calls and games played: this week, month, year or all time" },
  { name: "help", description: "How to use Meme Bot 3000" },
];

export interface Status {
  leader: () => boolean;
  shuttingDown: () => boolean;
}

/** Constant-time bearer check. */
function authorized(header: string | undefined, secret: string) {
  const want = Buffer.from(`Bearer ${secret}`);
  const got = Buffer.from(header ?? "");
  return got.length === want.length && timingSafeEqual(got, want);
}

export function build(env: Env, status: Status) {
  const app = Fastify({
    logger: false,
    bodyLimit: 1_048_576,
    // Discord's signature covers the exact bytes, so keep the raw body
    return503OnClosing: true,
  });
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));
  app.setErrorHandler((e, req, res) => {
    console.log("http error", req.method, req.url, e);
    res.code(500).send({ error: String(e) });
  });

  app.get("/health", async (_req, res) => {
    // ready to serve clicks: the database answers. (Leadership is separate: a follower serves too.)
    if (status.shuttingDown()) return res.code(503).send({ ok: false, shuttingDown: true });
    try {
      await env.db.execute(sql`SELECT 1`);
    } catch (e) {
      return res.code(503).send({ ok: false, db: String(e) });
    }
    return { ok: true, leader: status.leader(), gateway: presence.isReady(), background: inFlight(), uptime: Math.round(process.uptime()) };
  });

  app.get("/", async () => "Meme Bot 3000 🔥");

  app.post("/interactions", async (req, res) => {
    const body = req.body as string;
    const ok = await verifySignature(
      req.headers["x-signature-ed25519"] as string | undefined,
      req.headers["x-signature-timestamp"] as string | undefined,
      body,
      env.DISCORD_PUBLIC_KEY,
    );
    if (!ok) return res.code(401).send("bad signature");
    const i = JSON.parse(body);
    const t0 = performance.now();
    try {
      const out = await interaction(i, env);
      const ms = performance.now() - t0;
      // every tap/command with its handling time (three users: a few lines a day), slow ones flagged
      console.log(ms > 1500 ? "slow interaction" : "interaction", Math.round(ms), "ms", i.data?.custom_id ?? i.data?.name);
      return out;
    } catch (e) {
      // a private apology beats Discord's generic "This interaction failed"
      console.log("interaction failed", i.data?.custom_id ?? i.data?.name, e);
      return { type: R.Message, data: { content: "Something went wrong on my end 🤕 Try again in a moment.", flags: EPHEMERAL } };
    }
  });

  app.post("/ingest", async (req, res) => {
    if (!authorized(req.headers.authorization, env.INGEST_SECRET)) return res.code(401).send("nope");
    const input = parse(req.body);
    const ingested = await db.ingest(env, input.memes ?? []);
    const daily = input.post_daily ? await jobs.postDaily(env) : null;
    return { ingested, daily };
  });

  // ---------------------------------------------------------------- admin (maintenance + QA)
  app.register(async (admin) => {
    admin.addHook("onRequest", async (req, res) => {
      if (!authorized(req.headers.authorization, env.ADMIN_SECRET)) return res.code(401).send("nope");
    });

    // raw bot-token passthrough for maintenance scripts
    admin.post("/admin/discord", async (req) => {
      const input = parse(req.body);
      return api(env, input.method ?? "GET", input.path, input.body ?? undefined).catch((e) => ({ error: String(e) }));
    });

    admin.post("/admin/register", async () => api(env, "PUT", `/applications/${env.DISCORD_APP_ID}/guilds/${env.GUILD_ID}/commands`, COMMANDS));

    // redraw every posted meme with its current votes and who cast them (after a card change)
    admin.post("/admin/refresh-memes", async () => {
      const posted = await env.db.select().from(memes).where(sql`${memes.message_id} IS NOT NULL AND ${memes.channel_id} IS NOT NULL`);
      const out = { updated: 0, failed: [] as string[] };
      for (const m of posted) {
        try {
          await api(env, "PATCH", `/channels/${m.channel_id}/messages/${m.message_id}`, memeMessage(m, await db.tally(env, m.id), env.SUBREDDIT, await db.voters(env, m.id)));
          out.updated++;
        } catch (e) {
          out.failed.push(`${m.id}: ${String(e).slice(0, 80)}`);
        }
      }
      return out;
    });

    admin.post("/admin/recap", async (req) => (parse(req.body).period === "month" ? jobs.monthlyRecap(env) : jobs.weeklyRecap(env)));

    // seed ids that were posted before the bot had a database
    admin.post("/admin/mark-posted", async (req) => {
      const ids: string[] = parse(req.body).ids ?? [];
      const at = db.now();
      if (ids.length)
        await env.db
          .insert(memes)
          .values(ids.map((id) => ({ id, title: "(posted before DB)", image: "", link: "", author: "", published: "", ingested_at: at, post_kind: "request" as const, posted_at: at })))
          .onConflictDoUpdate({
            target: memes.id,
            set: { post_kind: sql`COALESCE(${memes.post_kind}, 'request')`, posted_at: sql`COALESCE(${memes.posted_at}, excluded.posted_at)` },
          });
      return { ok: true };
    });

    // testing without pinging anyone
    admin.post("/admin/gamenight", async (req, res) => {
      const input = parse(req.body);
      const quiet = { ...env, QUIET: true };
      switch (input.action) {
        case "start":
          return gn.startNight(quiet, input.user, true);
        case "tick":
          return jobs.minute(quiet);
        case "stats": {
          // 📊 QA with stand-in players, so real voice time is never touched
          const e = { ...quiet, PLAYERS: input.players ?? env.PLAYERS };
          if (input.track) {
            await activity.track(e, new Map(Object.entries(input.track as Record<string, string | null>)), Number(input.t));
            return { tracked: true };
          }
          if (input.recaps) return activity.recaps(e);
          return activity.statsPanel(e, input.kind ?? "week", Number(input.offset ?? 0));
        }
        case "precise":
          return gn.preciseStarts(quiet, Math.floor(Date.now() / 1000) + Number(input.within ?? 120));
        case "watch": {
          // re-check open rooms against who's in voice right now
          const where = await voice.whereIs(quiet);
          if (!where) return { error: "voice lookup failed" };
          return voice.checkRooms(quiet, new Set([...where.values()].filter(Boolean) as string[]));
        }
        case "reset":
          return gn.resetNight(env, input.day ?? gn.local(env).day);
        case "plan":
          return gn.startNight(quiet, input.user, true, input.day);
        case "room":
          return voice.openRoom(env, input.game, input.emoji ?? null, { by: input.user });
        case "rooms":
          return voice.maintainRooms(env);
        case "late": {
          // simulate a late-slip click by its owner, then update the slip
          const r = await late.act(quiet, input.day, input.user, input.clicker ?? input.user, String(input.choice));
          const row = await late.get(env, input.day, input.user);
          if (!r.notice && row?.message_id) await api(env, "PATCH", `/channels/${env.GAME_CHANNEL_ID}/messages/${row.message_id}`, await late.render(env, input.day, input.user));
          return { ...r, row };
        }
        case "poll-vote": {
          const r = await polls.pollAct(quiet, Number(input.poll), input.user, String(input.choice));
          await polls.refreshPoll(quiet, Number(input.poll));
          return r;
        }
        case "poll-render":
          return polls.renderPoll(env, Number(input.poll), input.user);
        case "copy":
          // someone's private copy of a card (what they see after tapping it)
          return gn.render(env, input.day ?? gn.local(env).day, input.user);
        case "hub": {
          // update the pinned panel in place (the given one, or ours that's already pinned); only
          // post and pin a new one when there's none
          let existing: string | undefined = input.message;
          if (!existing) {
            const pins = await api(env, "GET", `/channels/${env.GAME_CHANNEL_ID}/pins`);
            const list: any[] = Array.isArray(pins) ? pins : (pins?.items ?? []).map((p: any) => p.message);
            existing = list.find((m) => m?.author?.id === env.DISCORD_APP_ID && m.components?.length)?.id;
          }
          if (existing) return api(env, "PATCH", `/channels/${env.GAME_CHANNEL_ID}/messages/${existing}`, hub.hubPanel(env));
          const msg = await api(env, "POST", `/channels/${env.GAME_CHANNEL_ID}/messages`, hub.hubPanel(env));
          await api(env, "PUT", `/channels/${env.GAME_CHANNEL_ID}/pins/${msg.id}`);
          return { hub: msg.id };
        }
        case "vote": {
          const day = input.day ?? gn.local(env).day;
          const pending: Promise<unknown>[] = [];
          const r = await gn.act(quiet, day, input.user, input.choice, input.value, (p) => pending.push(p));
          await Promise.allSettled(pending); // QA wants the side effects done before it looks
          if (r.update) await gn.refresh(quiet, day);
          return r;
        }
      }
      return res.code(400).send({ error: "action?" });
    });
  });

  return app;
}

function parse(body: unknown): Record<string, any> {
  if (typeof body !== "string" || !body) return {};
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

