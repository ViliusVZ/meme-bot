# 01 · Spontaneous play

Read `README.md` in this folder first.

## Why

On 2026-11-10 the night was voted off (Lionixity was out). Later Koral whispered Vithis inside WoW
and they decided to run a dungeon. In Discord they had to dig the archived WoW room out of
🗄️ Recent games. The bot did nothing useful, and the 46 minutes they played don't count as a game
night anywhere. The owner wants the bot to notice the trio gathering and get them into a room with
at most one tap.

## What the trio will see

**The Lobby question.** Two or more of the trio sit in 🛋️ Lobby for 30 seconds, and no planned
night is running or about to start. The bot posts in the Lobby's own text chat (the chat attached
to the voice channel): "🎮 Playing something?" with up to three game buttons (most recently played
first), "Other…" and "Just hanging out". One tap from any of the three opens that game's room (the
archived one comes back if it exists), moves everyone in the Lobby into it, and the question
disappears. "Other…" opens the existing room picker. "Just hanging out" removes the question, and
the bot stays quiet until that gathering breaks up.

**Auto-move (phase 2).** If Discord shows two of the people in the Lobby already playing the same
game, the bot skips the question and moves them straight into that game's room. A short note in
the room's chat says why and offers "↩ Back to the Lobby".

**The quiet line.** Two minutes into an unplanned session, if one of the trio isn't there, a
silent line appears in #game-night: "🎮 Koral and Vithis are in **World of Warcraft** → (room
link)". When the session ends it is edited to "…played **World of Warcraft** for 46 min", listing
everyone who took part. No ping, ever.

**Stats.** An unplanned session of ten minutes or more counts as a game night: in "N game nights
played" (shown as, say, "5 game nights played (2 unplanned)"), and in the game's play count that
orders the game list.

**Latecomers.** While an unplanned session is running, anyone of the trio who joins the Lobby is
pulled into its room once, the same way planned nights already do it.

## Rules (decided, don't reopen)

- A **gathering** is two or more of the trio in the Lobby at the same moment. It ends when fewer
  than two remain there. One question at most per gathering. An unanswered question is deleted
  when the gathering ends or after 10 minutes, and is not posted again for that gathering.
- A **session** is two or more of the trio in the same game room at the same time, when that room
  isn't serving a planned night that has started. It doesn't matter how they got there: the
  question, auto-move, the 🔊 Game room button, or walking into an archived room like on the 10th.
- **No vote.** The first tap wins. A second tap that lost the race gets a private "Koral already
  picked World of Warcraft".
- **Planned nights own the Lobby.** No question and no auto-move while a planned night is live, or
  when one starts within 15 minutes. Voting still in progress doesn't block anything: the two
  flows are independent.
- **Sessions are not nights.** No Discord event, no late slips, no roasts, no "all or none". The
  day's game-night row is never touched by a session.
- **No double counting.** If a session for a game runs into that day's planned night for the same
  game (same room, the night claims it via `openRoom(..., { day })`), it is one night: the planned
  one. A different game on the same day counts separately.
- **One person alone** never triggers anything, with one exception: if exactly one game room has
  any of the trio in it and someone else joins the Lobby, they are pulled into that room once,
  with the same undo note as auto-move. If two rooms are occupied, do nothing.
- **Undo** (↩ Back to the Lobby) moves the people who were moved back, and silences the bot for
  that gathering. The room then empties and archives on its normal clock.
- Guests and other bots don't count as people for any rule here. Only `players(env)`.

## Where it goes in the code

- `live.ts` already hears every join, leave and move for the trio and already calls `late.watch`
  when someone joins the Lobby. The gathering timer, the session tracker and the latecomer pull
  belong here (or in a new module it calls), inside the existing `enqueue` queue.
- `voice.openRoom(env, game, emoji, { by, move: true })` already opens or revives the room and
  moves the Lobby. `voice.moveFromLobby` moves and returns who moved. `voice.roomPicker` /
  `otherRoomModal` are the "Other…" UI. `voice.checkRooms` and `archiveIfIdle` already wrap rooms
  up 15 minutes after they empty; hook the session's end to that, don't build a second clock.
- `activity.crunch` computes the stats; nights played come from `game_nights` (`stage = set` and
  `reminded`). `games.plays` is bumped where a night starts (`gamenight.ts`, "a night counts as
  played once it actually starts").
- `cleanup.ts` sweeps the bot's old #game-night messages at 03:00. The quiet line will be swept
  like everything else, which is fine; make sure editing an already-swept line doesn't alert.
- Button routing is in `interactions.ts`. Follow the existing custom-id style.

## Data

Suggested, adjust if the code argues for something better (say what and why in the commit):

- `lobby_prompts`: at most one open question. A unique key that makes a second open row
  impossible; columns for the message id, when it was posted, how it ended (picked, dismissed,
  expired, undone) and who. This is also where "this gathering was dismissed" lives, so a restart
  doesn't ask again.
- `sessions`: primary key `(day, game)`. Started, ended, everyone who took part, the #game-night
  message id, and whether it has been counted. The primary key is what stops a second line or a
  second count for the same game on the same day. A session that pauses (they drop to one person,
  come back within the room's 15 minutes) is the same session.
- Stats should stay derivable from `voice_segments`, which is the record of who was where. The
  session of 2026-11-10 (two players, WoW room, 19:27–20:13 UTC) must show up as an unplanned
  night after this ships: either derive unplanned nights from segments inside `crunch`, or
  backfill `sessions` from segments in the migration. Pick one source of truth and test that the
  stats and the play count can't disagree.

## Phase 2: auto-move

- The gateway (`gateway.ts`) asks for `Guilds | GuildVoiceStates`. Add `GuildPresences` **behind a
  config switch** (off by default, set per app in `config.env`). Asking for an intent that isn't
  enabled in the Developer Portal closes the gateway with code 4014, which would take the planner
  down. Order: ship the code dark, flip "Presence Intent" in the portal for the test bot, turn the
  switch on, verify, then the same for production. If 4014 ever happens anyway, reconnect without
  the intent and alert once.
- Keep what each of the trio is playing in memory only (activity type 0, "Playing"). Never store
  activity history.
- Match an activity name to a game from the `games` table: exact name (case-insensitive) or an
  alias. Aliases live in a small table (`activity` → `game`). They are learned with one tap, never
  silently: when someone answers the Lobby question while two people in the Lobby share an
  activity name that matches nothing, the bot adds one more button to its confirmation, "Always
  open World of Warcraft when we're in ‹that name›?". Silent learning is not allowed: two of the
  trio are programmers and will both show "Visual Studio Code".
- First job once the intent is on for the test bot: log what Discord actually reports while the
  owner has WoW: Forever running. Nobody knows yet what name it shows up under.
- Auto-move rule: at the moment the question would be posted, if at least two people in the Lobby
  map to the same game and nobody in the Lobby maps to a different one, move instead of asking. If
  only one person maps to a game, ask, with that game as the first button.
- The note goes in the room's chat, silently, and deletes itself after two minutes.

## Phase 3 (approved by the owner on 2026-11-11)

"The room appears by itself": when two of the trio show the same known game and neither is in
voice, bring that game's room out of the archive (or create it), so it's sitting under the Lobby
when they open Discord. No message. If nobody joins within the existing never-joined hour, it
archives as usual. This would have made 2026-11-10 need zero taps.

Presence Intent is already enabled in the Developer Portal for both apps (checked 2026-11-11 via
`GET /applications/@me`: flag `1 << 13`, GATEWAY_PRESENCE_LIMITED). The code still asks for it
only behind the config switch.

## Edge cases to cover with tests

1. Two in the Lobby for 29 s then one leaves: nothing posted. Rejoin: the 30 s starts over.
2. Third person joins while the question is up: same question, no second one.
3. Two taps at once on different games: one room, one winner, a private note for the other.
4. Restart or leader change while a question is up: exactly one question remains, and it still
   works (or it is removed cleanly and not reposted for that gathering).
5. Restart mid-session: one session, one line, one count.
6. The post to the Lobby chat fails: the claim is released, and the next gathering can ask.
7. No gateway snapshot: nothing happens.
8. A planned night starts in 10 minutes: no question. A night is live: no question, and Lobby
   joiners go to the night's room as today.
9. The session's game is the planned night's game, and the night starts mid-session: one room,
   everyone counts as arrived, one night counted.
10. Session under 10 minutes: the quiet line is deleted, nothing is counted.
11. All three present from the start: no quiet line (nobody is missing), still counted.
12. Undo after auto-move: people are back in the Lobby, no question follows, nothing is counted.
13. The bot's own messages in the Lobby chat and the room chat are all gone once the gathering
    and session are over.
14. The room is deleted by hand mid-session: the session ends without an alert.

## Done means

- Unit and flow tests for every rule and edge case above, each failing without its code. Query
  coverage still 100%.
- A QA script on the test bot (look at `qa_rooms.py` and `qa_timing.py` for how voice is driven
  there) that replays 2026-11-10: night off, two join the Lobby, one tap (phase 1) or none (phase
  2), room revived from the archive, line posted, third person pulled in, room wraps up 15 minutes
  after it empties, line edited, stats show the unplanned night.
- The existing suites still pass (`qa_all`, `qa_rooms`, `qa_timing`, `qa_stats`, vitest).
- Each phase is deployed on its own, test bot first.
