// Message layouts, built with Discord's Components V2 (containers, media galleries, text displays).
import { esc, IS_COMPONENTS_V2, messageLink } from "./discord";
import { score, VOTES, type Meme, type Ranked, type Tally } from "./db";

const ORANGE = 0xff4500;
const GOLD = 0xf1c40f;
const PURPLE = 0x9b59b6;
const MEDALS = ["🥇", "🥈", "🥉", "4.", "5.", "6.", "7.", "8.", "9.", "10."];

const text = (content: string) => ({ type: 10, content });
const gallery = (url: string, description?: string) => ({
  type: 12,
  items: [{ media: { url }, description: description?.slice(0, 1024) }],
});
const divider = { type: 14, divider: true, spacing: 1 };
const container = (accent: number, components: unknown[]) => ({ type: 17, accent_color: accent, components });

/** <t:…:D> renders in each viewer's own locale and timezone */
const stamp = (iso: string, style = "D") => `<t:${Math.floor(Date.parse(iso) / 1000)}:${style}>`;

function header(m: Meme) {
  if (m.post_kind === "daily") return `## 🗓️ Daily Meme · ${stamp(m.day + "T12:00:00Z")}`;
  return `## 🎲 Summoned by <@${m.requested_by}>`;
}

/** Vote bar like `🔥 ▰▰▰▰▱▱▱▱ 50%` for the leading reaction. */
function bar(t: Tally) {
  const total = VOTES.reduce((s, v) => s + (t[v.key] ?? 0), 0);
  if (!total) return "-# No votes yet. Be the first 👇";
  const lead = VOTES.reduce((a, b) => ((t[b.key] ?? 0) > (t[a.key] ?? 0) ? b : a));
  const share = (t[lead.key] ?? 0) / total;
  const filled = Math.round(share * 10);
  const s = score(t);
  return `${lead.emoji} \`${"▰".repeat(filled)}${"▱".repeat(10 - filled)}\` ${Math.round(share * 100)}% · Score **${s > 0 ? "+" : ""}${s}** · ${total} vote${total === 1 ? "" : "s"}`;
}

export function memeMessage(m: Meme, t: Tally, subreddit: string) {
  const lead = Math.max(0, ...VOTES.map((v) => t[v.key] ?? 0));
  return {
    flags: IS_COMPONENTS_V2,
    allowed_mentions: { parse: [] },
    components: [
      container(ORANGE, [
        text(`${header(m)}\n### [${esc(m.title)}](${m.link})`),
        gallery(m.image, m.title),
        text(`-# ${esc(m.author)} · r/${subreddit}${m.rank ? ` · #${m.rank} on Reddit this week` : ""}`),
        divider,
        text(bar(t)),
        {
          type: 1,
          components: [
            ...VOTES.map((v) => ({
              type: 2,
              // the winning reaction lights up green
              style: lead > 0 && (t[v.key] ?? 0) === lead ? 3 : 2,
              emoji: { name: v.emoji },
              label: String(t[v.key] ?? 0),
              custom_id: `v:${m.id}:${v.key}`,
            })),
            { type: 2, style: 5, label: "Reddit", url: m.link },
          ],
        },
      ]),
    ],
  };
}

function link(m: Meme, guildId: string) {
  return m.message_id && m.channel_id ? messageLink(guildId, m.channel_id, m.message_id) : m.link;
}

export function leaderboardMessage(
  title: string,
  rows: Ranked[],
  guildId: string,
  extras: string[] = [],
  accent = GOLD,
) {
  if (!rows.length) {
    return {
      flags: IS_COMPONENTS_V2,
      components: [container(accent, [text(`${title}\n-# Nothing voted on yet. Smash those buttons 🔥`)])],
    };
  }
  const [winner] = rows;
  const lines = rows.map(
    (r, i) =>
      `${MEDALS[i]} [${esc(r.title)}](${link(r, guildId)}) · **${r.score > 0 ? "+" : ""}${r.score}** · ${r.votes} vote${r.votes === 1 ? "" : "s"}`,
  );
  return {
    flags: IS_COMPONENTS_V2,
    allowed_mentions: { parse: [] },
    components: [
      container(accent, [
        text(title),
        gallery(winner.image, winner.title),
        text(lines.join("\n")),
        ...(extras.length ? [divider, text(extras.join(" · "))] : []),
      ]),
    ],
  };
}

export function statsMessage(
  name: string,
  avatar: string,
  s: {
    kinds: Tally;
    agree: { total: number; agreed: number | null };
    streak: number;
    best: number;
    summoned: number;
  },
) {
  const total = VOTES.reduce((n, v) => n + (s.kinds[v.key] ?? 0), 0);
  const fav = VOTES.reduce((a, b) => ((s.kinds[b.key] ?? 0) > (s.kinds[a.key] ?? 0) ? b : a));
  const persona = total ? fav.persona : "👻 Lurker";
  const breakdown = VOTES.map((v) => `${v.emoji} ${s.kinds[v.key] ?? 0}`).join("  ");
  const agree = s.agree.total ? `${Math.round(((s.agree.agreed ?? 0) / s.agree.total) * 100)}%` : "–";
  return {
    flags: IS_COMPONENTS_V2,
    allowed_mentions: { parse: [] },
    components: [
      container(PURPLE, [
        {
          type: 9,
          components: [text(`## 📊 ${esc(name)}\n**${persona}**`)],
          accessory: { type: 11, media: { url: avatar } },
        },
        divider,
        text(
          [
            `**Votes cast** · ${total}  ${breakdown}`,
            `**Voting streak** · 🔥 ${s.streak} day${s.streak === 1 ? "" : "s"} (best ${s.best})`,
            `**Agrees with the crowd** · ${agree}`,
            `**Memes summoned** · ${s.summoned}`,
          ].join("\n"),
        ),
      ]),
    ],
  };
}

export function streakNote(streak: number) {
  if (streak === 1) return "🗳️ Vote counted! Vote again tomorrow to start a 🔥 streak.";
  const flair = streak >= 100 ? "👑" : streak >= 30 ? "🏆" : streak >= 7 ? "⚡" : "🔥";
  return `${flair} **${streak}-day voting streak!** See you tomorrow.`;
}
