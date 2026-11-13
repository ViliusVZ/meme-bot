# 03 · The bot speaks

Read `README.md` in this folder first.

> **Since plan 05 (2026-11): the bot is Effect-native.** Build this as Effect services, as the
> house rules in `README.md` and `bot/README.md` describe (nothing of it is built yet).

## Resume here (2026-11-13)

- Step 0 done the owner-away way (below): samples rendered, a default chosen, checked by
  speech-to-text. The build follows plan 07's deploy (it touches the same start path).
- **Production gets the code with the 🔇 toggle off** (nobody has listened yet); the test bot runs it
  with the toggle on. The owner joins the test server, listens, and turns it on himself.

## Why

The owner asked about replacing Rythm with our own music player. That was dropped (it needs a
logged-in YouTube account on a server YouTube treats as a bot, and breaks both YouTube's and
Spotify's terms). What survives is the safe part: the bot playing **its own audio** in voice, so it
feels present. No third-party accounts or content are involved.

## What the trio will hear

The bot joins a voice channel, says one thing, and leaves. Three moments:

1. **A planned night starts.** Once the night's room is open and people have been moved in: a
   short jingle, then the game's name ("Game night: World of Warcraft", in the bot's voice).
2. **A latecomer arrives.** Someone who was late to a planned night joins its room: the bot reads
   them a roast. Check `late.ts` for what the bot already writes when a latecomer arrives; speak
   that if it reads well aloud, otherwise draft a small pool of spoken lateness lines (with the
   person's name and how many minutes late) in the same voice as `roasts.ts`.
3. **The Lobby question** (plan 01): when the bot posts "🎮 Playing something?" it also joins the
   Lobby and asks it aloud. Not on auto-move: there the bot stays silent.
4. **The lone early bird** (from plan 07; the owner's idea, 2026-11-13): one of the trio alone in
   voice (the Lobby or the night's room) before a locked-in night, inside plan 07's window (start
   at most three hours away), nobody else in voice, for a random four to nine minutes. The bot
   joins, waits 3 s, a short beep and one line ("beep beep, what are you waiting for, Koral?
   Chilling alone?"), waits 3 s, leaves, and leaves him confused. Lines hand-written in the voice
   of `roasts.ts`, mixed Lithuanian and English, a pool per person plus a shared one, drawn from a
   shuffle-bag so none repeats within a cycle; Ieva's jokes non-sexual. Once per person per night;
   not if anyone else joins first; off with the 🔇 toggle; every rule below applies.

## The owner's timing rule (explicit, do not shave)

Discord plays a sound when anyone joins or leaves a channel. Speech must never overlap it:

- after the bot's connection is fully ready, wait **3 seconds** before the first sound;
- after the last sound ends, wait **3 seconds** before leaving.

Make both constants. The listening test at the end is where they get tuned.

## Rules

- **It never sits in a channel.** Hard cap: 30 seconds from join to leave, whatever happens. It
  leaves at once if the channel empties. On shutdown, on losing leadership and on startup (a crash
  can leave a ghost connection), it makes sure it is not in voice.
- **One visit at a time**, through a queue. Things to say that are more than 20 seconds old are
  dropped: late speech is worse than none. Two things for the same channel in the same moment are
  said in one visit.
- **The bot is not a person.** Its being in a room must not keep the room alive, count as
  occupancy, start a gathering or a session (plan 01), appear in voice stats, or extend a night's
  event. All of those already look only at `players(env)`; prove it with tests.
- **Voice can never hurt the planner.** Every voice action is wrapped: a failed join or a
  connection that isn't ready within 10 seconds is abandoned quietly and reported with
  `alerts.failed("speaking in voice", …)`. Nothing else waits on speech: the room opens, people
  are moved and messages are posted first, and speaking happens after, on its own.
- **An off switch.** A "🔇 Bot voice" toggle on the Game Night HQ panel (stored in `settings`),
  on by default. The owner didn't ask for it; an audible feature needs one.
- **Spoken text is cleaned:** no emoji, no markdown, no small-print lines, mentions replaced by
  spoken names. Spoken names are a map (start with Vithis, Koral, Ieva; confirm with the owner at
  the listening step).

## Technical shape

- **Library:** `@discordjs/voice` 0.19 or newer. Discord has required its end-to-end encryption
  (DAVE) for all voice since March 2026, and this version carries it (`@snazzah/davey`). The bot
  doesn't use discord.js, so write a small adapter over the existing `@discordjs/ws` gateway
  (`gateway.ts`): send the voice-state payload through the gateway, and feed the bot's own
  `VOICE_STATE_UPDATE` and `VOICE_SERVER_UPDATE` events into the adapter. `GuildVoiceStates` is
  already requested. Leader only.
- **No ffmpeg and no encoder in the image.** Play pre-encoded Ogg Opus (or WebM Opus) through the
  library's demuxer. Every clip is 48 kHz and loudness-normalised to the same level, so the jingle
  and the voice match and nothing is startling.
- **The image is `node:24-alpine`.** Check first that every native piece (the DAVE module, and an
  encryption backend if Node's built-in AES-GCM isn't enough) ships a musl build. If not, moving
  to `node:24-slim` is acceptable, but the image's health check uses `wget`, which slim doesn't
  have: replace it in the same change.
- **The container stays locked down** (`deploy/compose.yml`: read-only, all capabilities dropped,
  no new privileges, 256 processes, 1 GB). Voice needs outbound UDP to Discord's voice servers;
  confirm the server's firewall and Docker network allow it before writing code (a ten-line
  throwaway script on the test bot that joins and leaves settles it).
- **Clips are cached in Postgres** (a table keyed by a hash of text + voice, the audio as bytes).
  They're tens of kilobytes each, survive deploys, and get backed up with everything else. The
  filesystem is read-only, so not on disk.
- **Speech is made ahead of time where possible**: when a game is added, when a roast line enters
  a bag. At the moment of speaking, a cache miss may synthesise if it fits inside the 20-second
  freshness rule; otherwise the bot plays the jingle alone or says nothing.

## Step 0: choose the voice by ear

The roast lines mix Lithuanian and English, sometimes in one sentence. That is the hard part, and
only the owner's ears can judge it. Before building anything else:

1. Find which free options actually work today for Lithuanian. Candidates (all unverified): Azure
   AI Speech's free tier (official, has Lithuanian neural voices and Opus output; needs an account
   with a card on file), the same Microsoft voices through the unofficial Edge read-aloud endpoint
   (no account; can break without notice), Google Cloud Text-to-Speech's free tier, speech from the
   Gemini key of plan 04, and a local engine (Piper) for English only.
2. Render the same six sentences with each: two Lithuanian, two English, two mixed, including the
   three names and one real line from `roasts.ts`.
3. Make three short original jingles (synthesised tones are fine; nothing copyrighted).
4. Give the owner the files and let him pick a voice, a jingle and the spoken names. If the chosen
   engine needs a key, collect it through the secure prompt (never chat), into the server's
   `secrets.env`.

Prefer an option that keeps working if the provider disappears: with the clip cache, every line
already spoken keeps playing, and only new lines need the engine.

### Step 0 findings (2026-11-13, the owner away)

Samples: `C:\p\meme-bot-voice-samples\` (see its README.txt)
(`samples/` the voices, `jingles/` the three jingles, `stt_small.txt` the speech-to-text check).

- **Rendered** the six sentences (two Lithuanian, two English, two mixed; the three names and the
  real line "We had a plan. {who} had other plans. Gaila, bet ne labai.") with: Microsoft's neural
  voices through the Edge read-aloud endpoint (no account): `lt-LT-LeonasNeural`,
  `lt-LT-OnaNeural`, `en-US-AndrewMultilingualNeural`, `en-US-AvaMultilingualNeural`,
  `en-US-BrianMultilingualNeural`; Gemini's own TTS on the free key (`gemini-3.8-flash-tts`, voice
  Charon, 2–3 s a clip); and a split render: English spans in Brian, Lithuanian spans in Leonas.
  Azure's and Google Cloud's free tiers need an account with a card (the owner's): not tried. Piper
  has no Lithuanian.
- **Checked without ears** by local speech-to-text (Whisper small; weak at Lithuanian, and it picks
  one language per clip, so mixed lines lose a language in transcription): the English voices read
  Lithuanian with English sounds ("Labas Coral, Cochacea Divinas"); the Lithuanian voices mangle
  English ("Gemeinnigt"). Mean word match: split Brian+Leonas 0.70, Brian 0.66, Ava and Gemini
  0.61, Andrew 0.59, Ona 0.39, Leonas alone 0.38. "Jeva" for Ieva and "Coral" for Koral are spelling,
  not sound.
- **Default chosen (the owner can swap it):** the split render: English in
  `en-US-BrianMultilingualNeural`, Lithuanian in `lt-LT-LeonasNeural`, every spoken line
  hand-marked into language spans. Jingles (original, synthesised): `jingle1-arpeggio` for a
  night's start, `jingle2-beepbeep` for the lone early bird, `jingle3-fanfare` spare. The Edge
  endpoint is unofficial and can break: every line spoken once stays in the clip cache, and a miss
  falls back to the jingle alone. Gemini TTS is the second engine if Edge stops answering.

## Edge cases to cover with tests

Use fake timers and a fake voice connection; assert on the sequence and the gaps.

1. Join → ready → 3 s → play → end → 3 s → leave, in that order with those gaps.
2. The connection never becomes ready: abandoned at 10 s, one alert, the night is unaffected.
3. Everyone leaves while it is speaking: it stops and leaves at once.
4. Two things to say in two channels: one visit each, in order, never in two channels at once.
5. A queued line older than 20 s: dropped.
6. The 30-second cap fires even if playback hangs.
7. Shutdown and loss of leadership while connected: it leaves first.
8. Startup while Discord still shows the bot in a channel: it disconnects.
9. The toggle is off: no joins at all.
10. The bot in a room alone: the room still wraps up on its normal 15 minutes, and plan 01 sees no
    gathering or session.
11. A clip is missing from the cache and synthesis fails: no speech, no alert storm.

## Rollout

1. Test bot only. Verify joins, timing and leaves from the logs and voice-state events.
2. **Listening test with the owner** on the test server (he joins voice there in the T3 browser or
   his own client): all three moments, tune the two 3-second gaps and the loudness to his taste.
   Nobody else can verify how it sounds; say so plainly instead of claiming it works.
3. Production when nobody is in voice. The first real night is the real test: read the logs after.

## Done means

All edge cases tested and failing without their code, query coverage still 100%, existing suites
green, the owner has heard and approved it on the test server, and the first production night's
log shows a clean join, speech and leave.
