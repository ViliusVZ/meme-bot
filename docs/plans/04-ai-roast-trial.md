# 04 · AI roast trial

Read `README.md` in this folder first.

## Why

Roasts come from hand-written pools in `roasts.ts`, drawn through shuffle-bags so no line repeats
within a cycle. The owner would like fresh lines written by a model, **only if it costs nothing**.
He also holds the bot to a high standard, and nobody knows whether a free model writes Lithuanian
banter that is actually funny. So this plan is a trial: produce a sample sheet, let him read it,
and stop. Building it into the bot is a separate decision after that.

## Step 1: the key

Google's Gemini API has a free tier. Its limits have been cut repeatedly and aren't clearly
published (reports range from about 20 to 1,500 requests a day for the Flash models). One request
a day is all this design needs, so it should fit even the stingiest version. Check the live limits
in AI Studio once the key exists.

The owner creates the key at Google AI Studio (free, no card). Collect it with the secure prompt
(`request_secret`, file delivery). Never ask for it in chat, never print it. For the trial it stays
on the workstation, next to the other QA secrets and out of git.

Tell the owner one thing before he creates it: the prompt will send the trio's persona notes
(jobs, hobbies, the cat's name) to Google, and on the free tier Google may use prompts to improve
its models. Whether that applies to users in the EU is unverified.

## Step 2: the sample script

A one-off script in `bot/scripts` (not part of the bot). It builds one prompt and prints a sheet.

The prompt contains:

- what the bot is and who the three people are, taken from the comments at the top of `roasts.ts`;
- the hard tone rules: jokes about Ieva are never sexual; nothing about anyone's looks, health,
  money or family; no slurs; teasing between friends, never contempt;
- the placeholder grammar from `roasts.ts` (`{who}`, `{a}` `{b}`, `{V}` `{K}` `{L}`) and which
  placeholders each family may use;
- ten to fifteen existing lines per family as the style to match, including the
  Lithuanian/English mix and the length;
- the request: structured output, about 30 lines in total: generic solo lines, a few personal
  lines for each person, a few for each pair, a few for "all three flaked";
- a second, smaller request: five lines that react to a made-up situation ("third bail this
  week", "said no four nights running"), to show what writing at the moment of the roast could add.

Then check every line mechanically and mark the ones that fail: placeholders valid for the family,
length within the pools' range, not a near-copy of an existing line, nothing from a banned-words
list.

Use the best Flash model the free tier offers on the day and record its exact name. If its
Lithuanian is clearly poor, run the same prompt once through one other free provider (Groq or
OpenRouter's free models) for comparison, and show both.

## Step 3: the owner decides

Show him the sheet grouped by family, with the mechanically rejected lines marked. Ask two things:
go or no-go, and which lines felt off (that shapes the rules if it goes ahead). Do not build
anything further in this plan.

## If it's a go (outline for a later plan, so the trial tests the right thing)

- **One request a day**, at a quiet hour, on the leader, writes a batch of new lines into a table.
  Each line is unique by its normalised text, so the "never repeat" guarantee holds.
- **The bags don't change.** `roasts.draw` keeps its semantics; approved generated lines simply
  join their family's pool at the next cycle. The hand-written pools stay forever as the floor.
- **A gate before the chat.** Lines pass the mechanical checks, and for the first weeks each batch
  goes to the owner by DM with ✅ / 🗑 buttons before it can be drawn. Once he trusts it, the gate
  can be switched to automatic.
- **Roasting never waits on the model.** Nothing is generated at the moment a roast is posted. If
  the free tier shrinks, errors or disappears, the job skips quietly and the bags carry on with
  what they hold. No alert DMs for this.
- If the bot speaks by then (plan 03), each approved line is turned into speech when it is
  approved, not when it is drawn.

## Done means

The owner has read the sheet and said go or no-go, and the answer (with what he found off) is
written into the memory file.
