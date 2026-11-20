# 09 · One tap, and four smaller fixes (20 Nov 2026)

**Status:** live in production since 20 Nov 12:11 (`fe079ed`). The flaky-test fix went first, as `e2cc2f7`.

## 1. One tap instead of three steps

The 17:00 card is answered with one tap. It names the game it assumes: the usual game, by the same rule showing up uses (≥60 % of the last 21 days' nights, at least 2).

| Row | Buttons |
|---|---|
| 1 | ⚡ Now (today's card only), then the start times our recent nights used (30 days, to the half hour, most used first, at most 4; still in the future; 19:00 / 20:00 / 20:30 / 21:00 with no history) |
| 2 | ✅ Yes, any time · 🤔 Maybe · ❌ No |
| 3 | 🎮 Different game · ⌨️ Other time |

**What a tap means:**
- **A time** (or ⚡ Now) means: I'm in, free from then, for the game shown. Tapping another time changes it.
- **Yes, any time** goes with whatever the others pick. It's kept in `gn:any:<day>`; any-time people are left out of the time fit and never count as missing in the time step. Whoever starts a card by hand is in at any time.
- **Different game** shows the games row on the same card. The game step's rule (most votes, a tie stays open) settles it.
- **Other time** is the old custom-time box, now usable from the first step.
- **🤔 / ❌** take back any time you'd picked.

**How the night moves:** the stage machine is unchanged (ask → game → time → set), and so is how the night is decided: who counts, the latest "free from", early birds, everyone on Now starts now. One tap records the ask, game and time answers together, and the settle step runs every step whose answers are already in, in one go. "What are we playing?" and "When can you start?" go out only if someone hasn't answered them.

**Unchanged:** a card in the older shape still works (its ✅ is a plain yes, and the old steps follow). The quick-start row and ⚡ Ready now remain. Showing up still overrides everything.

On the test bot, Koral started a card by hand (so "any time"), Vilius tapped 21:00 and Ieva tapped Now: it locked at 21:00 in World of Warcraft with one "it's on" and no other question. In the second run, Vilius tapped Different game → Enshrouded, Koral was on any time and Ieva typed 21:15: World of Warcraft won 2–1 and the night locked at 21:15.

## 2. Showing up and the late streak

It already worked as asked. Since 16 Nov, "late" means "chased on that card" or "👻 in its roast", and a night started by showing up has no roast. So:
- showing up with no reminder is on time, and breaks a streak;
- a reminder and then showing up is late;
- neither answering nor showing up is late.

A test now pins this. 19 Nov was scored right: Ieva got the 20:12 last call before showing up at 20:24.

## 3. The "you're early" card

It's posted in #game-night now, and goes when the night starts or the gathering breaks up. The 03:00 sweep takes any that's left. Deletes try both channels, so a card from before this change still goes.

## 4. Jokes that learn from the votes

`GET /jokes/stock` now gives each recent joke `posted` (the day, or null while in stock) and `votes` (🔥 fire, 😂 lol, 💀 dead, 🗑️ mid counts). The routine's joke step needs a paragraph to use it (given to the coordinator).

## 5. The flaky clock test

`TestClock.adjust(15 s)` woke the minute at 17:01:00 and carried on to 17:01:05. Whether the minute recorded its finish before or after the jump was down to scheduling. The test now advances exactly to the wake-up (17:01:00.050) and expects 0 s. It passed 10 runs in a row.
