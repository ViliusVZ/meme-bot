// 😐 Meme slackers: every evening (19:00 Vilnius) the bot looks at the last few daily memes, and
// whoever stopped voting on them (skipped the last 3 in a row, or voted on 1 or fewer of the last
// 5) gets called out in #daily-memes. Lines rotate like the roasts (roasts.ts shared bags), and
// nobody gets it more than once every 3 days.
import { and, desc, eq, gt, inArray, like, lte, sql } from "drizzle-orm";
import type { Env } from "./env.js";
import { memes, recaps, votes } from "./db/index.js";
import { api } from "./discord.js";
import { claimRecap, unclaimRecap } from "./memes.js";
import { local, players } from "./gamenight.js";
import * as roasts from "./roasts.js";

const HOUR = 19; // local
const WINDOW = 5; // daily memes looked at
const IN_A_ROW = 3; // skipped this many latest ones → called out
const AT_MOST = 1; // or voted on this many or fewer of the WINDOW
const SETTLE = 6 * 3600; // a meme counts once it's been up this long
const COOLDOWN = 3 * 86400;

const V = "306836805825593344";
const K = "212567787896307713";
const L = "747902984003780651";

// {who} the slacker · {n} how many of the last few they skipped · {since} when they last voted
export const LINES = [
  "{who}, so you don't like fun? {n} memes in a row without a single vote 😐",
  "{who} has seen the memes. {who} has chosen silence. Respect? No.",
  "Too busy for memes, {who}? The rest of us have lives too and still found 2 seconds to tap 😂",
  "{who}, it's one button. One. Tap. That's all we ask.",
  "Memai liūdi be tavęs, {who} 😢 Paspausk bent 🗑️, jei nepatinka.",
  "{who} is apparently reading the memes in incognito mode.",
  "Breaking: {who} hasn't laughed since {since}. Doctors are concerned.",
  "{who}, tu šitos grupės narys ar ne? Memai patys už save nebalsuoja.",
  "Even 🗑️ counts, {who}. Hating is participation.",
  "{who} treats #daily-memes like a museum: look, don't touch.",
  "{n} memes without your vote, {who}. Pradedam galvot, kad tu mūsų nemyli 💔",
  "{who} is too busy being an adult to vote on a cat in a tie. Sad.",
  "Ar tu gyvas, {who}? Paspausk 💀, kad žinotume.",
  "The algorithm misses you, {who}. So do we. Mostly the algorithm.",
  "{who}, your voting streak called. It's dead 💀",
  "{who} has left the meme channel on read. Again.",
  "Imagine scrolling past {n} memes and feeling nothing. {who} doesn't have to imagine.",
  "{who}, tu per rimtas memams? Nuo kada?",
  "Friendly reminder from your bot: humour is mandatory here, {who} 😂🔫",
  "Missing: {who}'s sense of humour. Last seen {since}. If found, tap 🔥.",
  "{who}, viena sekundė per dieną. Tiek kainuoja draugystė.",
  "Not voting on memes is how it starts, {who}. Next thing you know you're skipping game night.",
  "{who}, we can see you were online. We can see everything 👀",
  "Too busy, {who}? Too important? Too cool for 😂? Choose one.",
];

const PERSONAL: Record<string, string[]> = {
  [V]: [
    "{who}, you BUILT the meme bot and you don't even vote on the memes. Ironija.",
    "{who} is too busy pushing commits to push a 😂 button.",
    "{who}, tavo botas tave matė. Tavo botas nusivylęs.",
  ],
  [L]: [
    "{who}, nails drying? Tap 😂 with your nose, we'll allow it 💅",
    "{who} is watching Netflix instead of our memes. Ours are shorter, promise.",
    "Pūkis would've tapped 😂 by now, {who}. Just saying 🐈",
  ],
  [K]: [
    "{who}, you deliver 200 parcels a day but can't deliver one 🔥?",
    "{who}'s kurjeriai friends probably have better memes. Ouch.",
    "{who}, siunta \"vienas paspaudimas\" laukia atsiėmimo jau {n} dienas 📦",
  ],
};

export const ALL = [...LINES, ...Object.values(PERSONAL).flat()];
export const fitsFor = (user: string) => [...LINES, ...(PERSONAL[user] ?? [])];

const fmtDay = (iso: string) => `<t:${Math.floor(Date.parse(iso) / 1000)}:D>`;

/** Who stopped voting on the daily memes, and how badly. */
export async function slackers(env: Env, t = Math.floor(Date.now() / 1000)) {
  const settled = new Date((t - SETTLE) * 1000).toISOString();
  const recent = await env.db
    .select({ id: memes.id, posted_at: memes.posted_at, message_id: memes.message_id, channel_id: memes.channel_id })
    .from(memes)
    .where(and(eq(memes.post_kind, "daily"), sql`${memes.message_id} IS NOT NULL`, lte(memes.posted_at, settled)))
    .orderBy(desc(memes.posted_at))
    .limit(WINDOW);
  if (recent.length < IN_A_ROW) return { recent, who: [] as { user: string; missed: number; since: string | null }[] };
  const vs = await env.db.select({ meme: votes.meme_id, user: votes.user_id }).from(votes).where(inArray(votes.meme_id, recent.map((m) => m.id)));
  const who = [];
  for (const p of players(env)) {
    const mine = new Set(vs.filter((v) => v.user === p).map((v) => v.meme));
    const streak = recent.findIndex((m) => mine.has(m.id)); // how many of the latest in a row they skipped
    const inARow = streak === -1 ? recent.length : streak;
    const voted = mine.size;
    if (inARow >= IN_A_ROW || (recent.length >= WINDOW && voted <= AT_MOST)) {
      const [last] = await env.db.select({ at: votes.voted_at }).from(votes).where(eq(votes.user_id, p)).orderBy(desc(votes.voted_at)).limit(1);
      who.push({ user: p, missed: recent.length - voted, since: last?.at ?? null });
    }
  }
  return { recent, who };
}

/** Minute job: the 19:00 call-out, once a day; each person at most once every 3 days. */
export async function evening(env: Env) {
  const l = local(env);
  if (l.hour < HOUR) return {};
  const today = `meme-shame:${l.day}`;
  if (!(await claimRecap(env, today))) return {};
  try {
    const { recent, who } = await slackers(env);
    const called: string[] = [];
    const cooldownSince = new Date(Date.now() - COOLDOWN * 1000).toISOString();
    for (const s of who) {
      const [recently] = await env.db
        .select({ p: recaps.period })
        .from(recaps)
        .where(and(like(recaps.period, `meme-shamed:${s.user}:%`), gt(recaps.posted_at, cooldownSince)));
      if (recently) continue;
      if (!(await claimRecap(env, `meme-shamed:${s.user}:${l.day}`))) continue;
      // one bag for everybody's call-outs: no line repeats in the channel until all have been used
      const line = (await roasts.draw(env, "memes", ALL, fitsFor(s.user)))
        .replaceAll("{who}", `<@${s.user}>`)
        .replaceAll("{n}", String(s.missed))
        .replaceAll("{since}", s.since ? fmtDay(s.since) : "forever");
      const latest = recent[0];
      await api(env, "POST", `/channels/${env.CHANNEL_ID}/messages`, {
        content: `😐 ${line}`,
        allowed_mentions: env.QUIET ? { parse: [] } : { users: [s.user] },
        message_reference: latest.message_id ? { message_id: latest.message_id, fail_if_not_exists: false } : undefined,
      });
      called.push(s.user);
    }
    return called.length ? { called } : {};
  } catch (e) {
    await unclaimRecap(env, today); // the next minute tries again
    throw e;
  }
}

