# 08 · The bot reads the room (19–20 Nov 2026)

**Status:** live in production since 19 Nov 23:28 (A to F) and 23:40 (G). The brief is `C:\p\klodas-vandamas\brief-2026-11-19.md`, not in the repo.

## Why

On 19 Nov, all three had said yes and picked World of Warcraft by 20:24, and all three sat in the Lobby. The bot got in their way for the next hour:
- It treated the night as unplanned, asked aloud what they were playing, and put the buttons in the Lobby's own chat.
- The card waited an hour for one time pick from someone sitting in the room, then pinged her.
- The night locked at 🌙 00:30, and started at 21:30 only because the early-birds rule fired.

The rule now: **the card is a way to find out whether and when we play, not a gate.**

## What shipped

### A. Showing up is an answer

The logic is `showedUp` and `calledIn` in `gamenight.ts`, run on every voice change and every minute.

- **Everyone is here.** When everyone who hasn't said no sits in one voice room for 30 s (`SETTLE`), the night is on, now, at any step (ask, game, time, even called off).
  - Where the game comes from, in order: the card (picked, or leading the vote), then one of our game rooms they're all in, then what Discord shows them playing, then the "usual" game (≥60 % of the last 21 days' nights, at least 2).
  - Only when none of those gives a game does the Lobby ask.
  - One silent line announces it, with 🛋️ "We're just hanging out". That button restores the card's previous state, moves people back and doesn't start it again that day. When the game was a guess, there are 🔁 switch buttons too.
  - The card marks who 🎧 showed up.
  - A locked night that's ahead keeps the old early-birds start: one silent line, "(was HH:MM)".
- **Two here, the third away and not a no.** The third gets one loud message a night (`gn:called:<day>:<user>`) with three answers:
  - 🏃 On my way: a silent line.
  - ⏰ In 15 min: a silent line.
  - 😴 Not tonight: a no without a roast, after which the two simply play.
- **Anyone in voice.** The card shows "🎧 In voice now", from `gn:invoice:<day>`, which the check writes.
- **No reminder of any kind reaches someone sitting in voice with the others.** The filter is in `nudgeOnce`.

### B. The Lobby question

- It's posted silently in **#game-night**, the spoken line says where to tap, and it stays while they're gathered (`PROMPT_TTL` 6 h; the gathering ending takes it away).
- It isn't asked when the card names a game: the room opens instead ("Tonight's card says …, so I brought you over.").
- The early-bird card ("you're early, want the room?") stays in the Lobby's chat.

### C. The quick row

`e2a24eb` (⚡ Now / In 15 / In 30 / In 1 h, and ⚡ Ready now) is merged.

When a night starts earlier than the picks said, the card says so instead of calling people slowpokes.

### D. A yes is enough

- A game or time step that has had 15 min (`STEP_WAIT`) with at least one pick closes with the picks it has: the most-voted game, or the latest start among the pickers.
- "It's on" says who goes with the group.
- The game and time steps send no reminders of their own. Only the first question's reminder, last call and final call remain.

### E. Fewer notifications

`nudge(…, loud)` is silent by default.

| | What |
|---|---|
| **Loud** | the daily card; the first question's reminder, last and final call; someone starting or reopening tonight; "it's on" (pinging only whoever isn't in voice, and silent when everyone is); the start for whoever isn't there; the "coming?" message; downtime alerts |
| **Silent, names without a ping** | memes, meme of the week, the recap, every roast, late notices, slips, snooze notes, hold and split notes, the morning joke, the news |

### F. Klodas Vandamas

- Production is Klodas Vandamas; the test bot is Klodas Testamas, with a blue headband. The avatars are in `assets/klodas`.
- The username, avatar, About me and app icon were set through the API; the coordinator changed the application names in the portal.
- Messages, help, the event text and the hub panel use the new name. The silent intro line was posted in #game-night.

### G. The morning joke

The bot side is `jokes.ts`.

- **When and where:** 09:00 on weekdays and 10:30 at weekends (Vilnius), silent, with 🔥😂💀🗑️ buttons, in #🌅・morning-joke (`JOKE_CHANNEL_ID`).
- **Stock:** the "WoW news writer" routine keeps it at 6, through its step 4 (`GET /jokes/stock`, `POST /jokes`).
- **Misses:** an empty stock posts nothing; a restart more than 2 hours late skips that day.
- **What's in stock:** 20 approved jokes, in the coordinator's order (the first is for Fri 20 Nov).
- **The writer's instructions:** `C:\p\klodas-vandamas\joke-step.md`, plus the coordinator's two changes: no worn-out classics, no children's jokes or observations without a turn, the dry/dark/absurd register, and Lithuanian jokes that only work in Lithuanian.

### H. Why Discord shows no game for Vilius and Koral

- A read-only gateway snapshot (19 Nov, 23:3x) shows Vilius's presence reaching the bot: idle, on web and desktop. Its only activity is his custom status, with no game.
- Ieva's games arrive (CurseForge).
- Koral was offline, so his couldn't be read.
- The app has the presence intent ("limited", which is right for one server), so the bot side works.
- A presence with a custom status but never a game is what Discord's activity-sharing switch produces. To flip it:
  - **User Settings → Activity Privacy → "Share my activity"** must be on.
  - In this server, **server name → Privacy Settings → "Activity Status"** must be on too.
- Nothing above depends on it.

## Tests

- **On the test bot (read back from Discord):**
  1. Tonight, exactly: the night starts after 30 s, with no question, no reminder and no ping.
  2. Unanswered card.
  3. Called off.
  4. Two in voice with the third a yes: one message, each answer.
  5. Two in voice with the third a no: they play, silently.
  6. One alone: nobody pinged.
  8. A step closing on its own.
  11. The undo.
  13. Name and avatar.
- **Unit tests in `test/readtheroom.test.ts`:**
  - 7: no reminder to someone in voice with the others.
  - The time step sends no reminder and closes after 15 min.
- **Existing tests** were updated for the silent posts and the question's new channel.
- **The joke:** its own tests (`test/jokes.test.ts`). Writer routes checked on the test bot.

## Left open

- The quick-start "In 15 min" answer to the "coming?" message doesn't move the start; it only says so.
- The `G6` gate flags one `try {` in `newsfeeds.ts`, from the Reddit change.
- The local test Postgres in the scratchpad was wiped by the temp cleanup. Tonight's tests ran on a throwaway database on the server through an SSH tunnel, dropped afterwards.
