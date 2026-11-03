// Button-first entry points: /help (private) and the pinned "Game Night HQ" panel share the same
// guide and action buttons, so nobody has to remember a single command.
import type { Env } from "./index";
import { EPHEMERAL, IS_COMPONENTS_V2 } from "./discord";

const text = (content: string) => ({ type: 10, content });
const divider = { type: 14, divider: true, spacing: 1 };
const button = (style: number, emoji: string, label: string, custom_id: string) => ({ type: 2, style, emoji: { name: emoji }, label, custom_id });

export const actions = () => [
  { type: 1, components: [button(3, "🎮", "Play today", "hub:play"), button(1, "📅", "Plan a day", "hub:plan"), button(1, "🔊", "Game room", "hub:room")] },
  { type: 1, components: [button(1, "🗳️", "New poll", "hub:poll"), button(2, "🕹️", "Games", "hub:games"), button(2, "❓", "Help", "hub:help")] },
];

function guide(env: Env) {
  return [
    text("## 🤖 Meme Bot 3000 · how to use me"),
    text(
      [
        `### 🎮 Game night · <#${env.GAME_CHANNEL_ID}>`,
        "Every day at **17:00** a card asks *Are we playing today?* When all three say ✅ it moves on to **picking a game** (first to 2 votes), then **picking a time**: tap the earliest time you can start, and we start when the last of us is free (🐢 they get called out). Have to leave early? Tap **🏁 Leave by**. The bot only locks a time that gives everyone at least an hour together, and tells you who clashes if it doesn't. Then you get a Discord event and a ping at start time.",
        "• **🎮 Play today** starts today's poll now (the 17:00 one then won't happen)",
        "• **📅 Plan a day** sets up a poll for any day this week. Still one poll per day, never duplicates.",
        "• **🚪 I'm out** on a card cancels that night for everyone",
      ].join("\n"),
    ),
    divider,
    text(
      [
        `### 🔊 Voice · <#${env.LOBBY_CHANNEL_ID}>`,
        "Hang out in the **Lobby**. When a game night starts, the bot opens a room for the game and moves everyone in the Lobby into it. Want to play right now? **🔊 Game room** does the same instantly. Rooms tidy themselves: empty for ~20 min → 🗄️ Recent games, deleted after 3 days (rejoin one to bring it back).",
        "**Running late?** Hop in the Lobby and you'll be pulled into the game. Not there 10 min after the start? You get one late slip to share your ETA (🏃) or bow out (😴), and the others carry on.",
      ].join("\n"),
    ),
    divider,
    text(
      [
        "### 🗳️ Polls",
        "**🗳️ New poll** opens a form: a question plus answers. Everyone taps an answer; the first to 2 votes wins. Not settled? **🔒 Close** it.",
      ].join("\n"),
    ),
    divider,
    text(
      [
        "### ⚔️ Ties",
        "A three-way split on a game, or a tied poll, becomes a tiebreaker: **🎰 spin the wheel** (watch it spin), or the tied players duel at **✊✋✌️ rock-paper-scissors**. Throws stay secret, draws replay, and after 5 draws the wheel takes over.",
      ].join("\n"),
    ),
    divider,
    text(
      [
        `### 😂 Memes · <#${env.CHANNEL_ID}>`,
        "A top r/ProgrammerHumor meme lands every day. Vote 🔥 😂 💀 🗑️ on it to build a voting streak. Weekly and monthly winners are crowned automatically.",
      ].join("\n"),
    ),
    divider,
    text(
      "-# Commands, if you prefer typing: `/playtoday` · `/plan` · `/room` · `/poll` · `/games` · `/meme` · `/top` · `/stats` · `/hall-of-fame` · `/help`",
    ),
    ...actions(),
  ];
}

/** /help and the ❓ button: the guide, privately. */
export const helpMessage = (env: Env) => ({
  flags: IS_COMPONENTS_V2 | EPHEMERAL,
  components: [{ type: 17, accent_color: 0x8e44ad, components: guide(env) }],
});

/** The pinned panel in the game-night channel. */
export const hubPanel = (env: Env) => ({
  flags: IS_COMPONENTS_V2,
  allowed_mentions: { parse: [] },
  components: [{ type: 17, accent_color: 0x8e44ad, components: guide(env) }],
});

/** 🕹️ Games: the list, an add button (form) and a remove dropdown. */
export async function gamesManager(env: Env, notice?: string) {
  // the whole list here (dropdowns elsewhere show the top 25 by plays)
  const list = (await env.DB.prepare("SELECT name, emoji, plays FROM games ORDER BY plays DESC, rowid").all<{ name: string; emoji: string | null; plays: number }>()).results;
  return {
    flags: IS_COMPONENTS_V2 | EPHEMERAL,
    components: [
      {
        type: 17,
        accent_color: 0x57f287,
        components: [
          text(`## 🕹️ Game list${notice ? `\n${notice}` : ""}`),
          text(list.map((g) => `${g.emoji ?? "🎮"} **${g.name}**${g.plays ? ` · played ${g.plays}×` : ""}`).join("\n") || "*Empty. Add something!*"),
          text("-# These are the choices in game-night polls, most played first. ➕ Suggest a game on a poll adds one too."),
          { type: 1, components: [button(3, "➕", "Add a game", "games:add")] },
          ...(list.length
            ? [
                {
                  type: 1,
                  components: [
                    {
                      type: 3,
                      custom_id: "games:remove",
                      placeholder: "🗑️ Remove a game…",
                      // a dropdown holds 25: least-played (and newest) first, as those are the likely removals
                      options: [...list].reverse().slice(0, 25).map((g) => ({ label: g.name, value: g.name, emoji: { name: g.emoji ?? "🎮" } })),
                    },
                  ],
                },
              ]
            : []),
        ],
      },
    ],
  };
}

export const addGameModal = () => ({
  custom_id: "games:add",
  title: "Add a game",
  components: [{ type: 1, components: [{ type: 4, custom_id: "value", style: 1, label: "Game name", placeholder: "Lethal Company", max_length: 60, required: true }] }],
});
