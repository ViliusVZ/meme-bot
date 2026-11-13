# Editor pass 2 (2026-11-13 ~13:30, sheet editor2/sheet.md, prompts v2 + pipeline fixes): findings 7

Cards (6): keep 2 (Fri class tuning; Sun dual spec 50g), fix 3 (Sat Nov 6 hotfixes: headline + "No comments yet." on a staff-only topic; Sun dungeon XP +50%: time/mood from an older anecdote thread, "significantly" overstated; Thu Enhancement nerfs: one sentence the reverse of the post, one invented, framed as new when the changes were 2 days old), cut 1 (Fri Ula'tek: a retail raid, category 235, not Forever).

Gemini's own writing failures (the reason the news line stops, owner's rule "fails the editor twice after real prompt work"):
- Thu card: "Maelstrom Weapon's cast time/mana reduction… reworked to scale with rank" — the post: "now grants 20% reduced cast time and Mana cost per application at all ranks" (only the proc rate scales).
- Thu card: "Maelstrom Weapon now favors slower main-hand weapons" — not in the post (procs per minute stay fixed).
- Sun card: "significantly more rewarding" — Blizzard later said dungeon XP went from 40% to 60% of Classic Era.
(Pass 1's: "using Arcane Explosion while layer hopping" invented from a commenter; "on EU realms" invented.)

Pipeline findings (mine, fixable in code):
1. Blizzard posts not filtered to Forever (category 360 vs 235 retail).
2. A rewritten running post (topic 639885 post #1, v7) loses lists Blizzard overwrote: the Nov 10 hotfix list vanished from the whole week; Fri "old news" judged on Nov 11 text.
3. Hotfix topics never get replies: pair them with the Reddit/forum discussion instead of "No comments yet."
4. A merged card takes time and mood from its main source, not an older matched thread.
5. Repeats by content, not topic id: Thu #7 (Nov 11 hotfixes) and #6 (AH changes moved to Nov 18) were wrongly "a repeat"; skip reasons should name what they repeat.
6. Day bucketing: a 22:24 UTC post landed on the next day, a 21:12 UTC one didn't — check the cut-off (Vilnius midnight = 22:00 UTC).
7. The sheet header still says "Threads are read as they are now…": stale.

Tuesday's three unwritten stories (budget): all three should be cards (quest gold coming for level 48+; PvP faction balance incl. Alliance on EU RP-PvP; Nov 9 hotfixes led by lowered zone populations — without re-announcing the +50% XP).
