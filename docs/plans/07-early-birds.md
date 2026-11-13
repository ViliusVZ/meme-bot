# 07 · Early birds: a locked-in night knows when people show up early

Read `README.md` in this folder and `bot/README.md` first. Written 2026-11-13 by the planning
thread, from what happened on 2026-11-12 and the owner's words the morning after.

## Why

What happened on 2026-11-12 (Vilnius time, from production's logs and tables):

| When | What |
|------|------|
| 18:14 | The night locks in: World of Warcraft at 19:00. |
| 18:29:00 | Koral joins the 🛋️ Lobby, alone. The bot does nothing for 14 minutes. |
| 18:43:31, 18:43:45 | The other two join the Lobby. |
| 18:44:01 | The bot posts "🎮 Playing something?" in the Lobby's chat. The start was 15 min 59 s away, one minute outside the 15 minutes in which a planned night keeps the Lobby quiet (`PLANNED_SOON`). |
| 18:44:28 | Koral taps World of Warcraft. The room opens, all three are moved in. |
| 19:00:00 | The night starts and pings all three: "⏰ … World of Warcraft starts now! Room: …". They had been in that room for 15 minutes. |

The owner: the bot asked what we're playing while we were waiting for a night it had planned
itself, and then announced the room a second time. In his words: "there has to be this idea of an
upcoming game, and it should understand that you're playing." And: if we voted seven and all
joined at 6:15, "let's not wait … move those guys to the game night and start tracking already."

Also found while looking: production's `game_aliases` is empty. Both times the bot asked Gemini
what "World of Warcraft: Forever" is (and "CurseForge"), Gemini answered 503, and a failed ask is
only retried a day later. So game detection has never worked for the one game the trio plays.

## What the trio will see

"The night" below means today's locked-in night (stage `set`, not started) whose start is at most
three hours away. "Here" means in the Lobby or in an open room of the night's game.

1. **Everyone is here early: the night starts now.** All three here for 30 seconds, and the bot
   starts the night on the spot: the room opens, the Lobby is moved in, the card says it's on, the
   event goes live, everyone counts as arrived, the play is counted. One silent line under the
   card, pinging nobody (they are all there):
   `⚔️ Everyone's here early, so World of Warcraft is on now (was 19:00) → #room`.
   In the room, the usual self-removing note with ↩ Back to the Lobby. At 19:00 nothing happens.
2. **Two are here, one isn't.** Never "Playing something?". Instead, in the Lobby's chat:

   ```
   ### ⚔️ World of Warcraft at 19:00 · you're early
   -# Still waiting on @Ieva. Want the room already?
   [⚔️ Open the room]  [🛋️ Just hanging out]
   ```

   "Open the room" opens the night's room and brings the Lobby along. The night itself hasn't
   started: it starts the moment the third shows up (rule 1), or at 19:00. If Discord already
   shows both of them in the night's game, skip the card and move them (the existing auto-move
   with its ↩ note). The existing silent line in #game-night tells the missing one where they are,
   and the existing pull-in brings the third from the Lobby when they arrive.
3. **The planned time arrives while some are already in the room.** The start pings only the
   people who are not in the room yet, and says who is:
   `⏰ @Ieva ⚔️ World of Warcraft starts now! Koral and Vithis are already in → #room`.
   **The start never pings someone who is already in the night's room.** If everyone is, it posts
   rule 1's silent line.
4. **One of us alone.** No text. Later, by voice: see the last section.

Everything else stays as plan 01 built it: no night today, a vote that is still open, or a night
more than three hours away all keep "Playing something?" and the unplanned sessions.

## Rules

- **"Just hanging out" is an answer.** After that tap the bot leaves this gathering alone, rule 1
  included, until it breaks up; the planned start then runs as usual.
- **Don't start the wrong game.** If Discord shows two or more of them in another game of ours,
  rule 1 doesn't fire; the card of rule 2 goes up instead (without the "waiting on" line).
- **The card stays** until it's answered, the Lobby drops below two, or the night starts or is
  called off; then it's deleted. It shows the start as a Discord timestamp, and follows the start
  if ⏰ "running late" moves it. Not posted in the last minute before the start.
- **Starting early is the normal start, moved.** Set `start_at` to now and claim the start in one
  statement, then run what the start already runs; the 19:00 timer finds the night started (or its
  `start_at` changed) and does nothing. Once, by the same claim as today; a failed announcement
  releases it exactly as today's does.
- **Never on a guess:** no voice snapshot, no early start and no card.
- **The warm-up room is an unplanned session until the night starts** (plan 01 tracks it, the start
  absorbs it; that path exists and ran on 2026-11-12). Check the play is counted once.
- **`PLANNED_SOON` goes** where these rules replace it: inside the window the night's own rules
  run right up to the start, so the one-minute gap of 2026-11-12 cannot exist.
- **The name fix:** add the alias "World of Warcraft: Forever" → World of Warcraft in a migration
  (it's a fact, not a guess), and retry an ask that got no answer after an hour, not a day (still
  one claim per name, still inside the Gemini budget).

## Tests (each fails without its code)

Real Postgres and `TestClock`, as everywhere.

1. **The replay of 2026-11-12:** the night set for 19:00; joins at 18:29:00, 18:43:31, 18:43:45.
   No "Playing something?"; the night starts at 18:44:15; one silent line with no mentions; the
   room opened once; three arrivals at that second; nothing at all is posted at 19:00:00.
2. Two early: the night's card and not the question; "Open the room" opens and moves; the line for
   the missing one after two minutes; the third joins the Lobby, is pulled in, and 30 s later the
   night starts quietly; the session is absorbed and the play counted once.
3. Two early in the room, the third never comes: at 19:00 one message that pings only the third;
   their late slip at 19:10 as today.
4. The start pings exactly the people not in the room, for all eight combinations of who is.
5. Two early, both shown in the night's game: moved without a card.
6. "Just hanging out", then the third arrives: no early start; the planned start runs.
7. All three here, two shown in another game: no early start, the card instead.
8. The card goes when the gathering breaks up and when the night is called off; it follows a moved
   start.
9. Outside the window, and while the vote is still open: plan 01's behaviour, unchanged.
10. No voice snapshot: nothing happens.
11. A voice change and the minute tick both see "everyone's here" at once: one start.
12. Interrupted between the claim and the line (`test/interruption.test.ts` gets its entry).
13. The alias resolves "World of Warcraft: Forever"; an unanswered ask is retried after an hour.

## Checking it for real

Only Vithis is a member of the test server, so two and three people in voice can't happen there for
real. Drive it the way `qa_stats.py` does (stand-in players) or through quiet admin actions, extend
`qa_spontaneous.py` with rules 1 to 3, and say plainly in the report which parts ran only that
way. Look at the card, the silent line and the partial ping in the Discord tab and screenshot them.
The first real early gathering in production is the real test: read its log the morning after.

## Rollout

Gates green, the test bot, then `main` when nobody is in voice and no vote is running. Aim to have
it in production before today's 17:00 card.

## The lone early bird (build with plan 03, not before)

Koral often joins ten minutes early and sits alone. The owner's idea: the bot drops into the
channel, says something like "beep beep, what are you waiting for, Koral? Chilling alone?", and
leaves him confused. This is a fourth moment for plan 03 (the bot's voice); add it there when 03 is
built.

- **When:** one of the trio alone in voice (the Lobby or the night's room) before the night, inside
  the window, nobody else in voice, for a random four to nine minutes.
- **What:** join, wait 3 s, a short beep and one line, wait 3 s, leave (plan 03's timing rule). The
  lines are hand-written in the voice of `roasts.ts`, mixed Lithuanian and English, a pool per
  person plus a shared one, drawn from a shuffle-bag so none repeats within a cycle. Keep Ieva's
  jokes non-sexual.
- **Limits:** once per person per night; not if anyone else joins first; off with the 🔇 toggle;
  every rule of plan 03 applies.
