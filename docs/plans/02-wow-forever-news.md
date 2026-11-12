# 02 · WoW: Forever news

Read `README.md` in this folder first.

> **Since plan 05 (2026-11): the bot is Effect-native.** Build this as Effect services, as the
> house rules in `README.md` and `bot/README.md` describe (a branch (`wow-news`, f298ce4) written in the old promise style was paused mid-rollout on 2026-11-11; porting it means rewriting `news.ts` as a service).

## Why

The trio plays World of Warcraft: Forever (Blizzard's permanent "Classic plus" realms, launched
2026-11-04). The owner wants its news to land in Discord without anyone having to go looking. He
left the details to us: "whatever you see fit".

## What the trio will see

A new text channel, `wow-news`, named and placed to match the server's existing channels (look at
the live channel list for the emoji-and-separator style; it belongs with the game channels). The
bot posts each official Blizzard item about WoW: Forever there once: a small card with the title
as a link, one or two lines of summary, the picture if there is one, and when it was published.
Silent, no pings. Dated roadmap events (a raid unlock, a new mode) get a silent "tomorrow" line and
a "today" line.

## Decisions

- **Official sources only** to start: Blizzard's news posts, hotfix notes and maintenance notices
  that concern WoW: Forever, European region, in English. Wowhead and similar are out for now
  (more and faster, but noisy). Make sources a list, so one can be added later without redesign.
- **As they come, capped.** Check every 30 minutes. Post oldest first, at most 5 items a day; the
  rest wait for tomorrow. No weekly-reset reminders: they know.
- **First run posts nothing old.** On the very first check (and whenever a new source is added),
  mark everything already published as seen, and post at most the single newest item. A channel
  that opens with thirty back-dated posts is a failure.
- **Hotfix notes are one article that Blizzard keeps editing.** Post it when it first appears, and
  after that at most one silent "Hotfixes updated" line a day when its content changed.

## Step 0: find the feeds (do this before designing anything)

Nobody has verified where Blizzard publishes this in a machine-readable form. Candidates to check:

- the Blizzard news site's own listing endpoints for World of Warcraft (JSON behind the news page);
- the official forums, which run Discourse: every category and the staff ("blue") tracker have
  `.rss` and `.json` views;
- the game site's news pages for the European region.

For each candidate: does it carry Forever posts, does it say which game version a post is about,
does it send `ETag` / `Last-Modified`, and **does it answer from the server's IP**. Fetch from the
VPS, not from the workstation: Reddit rate-limits that IP and Blizzard might too. Save real
responses as fixtures in `bot/test/fixtures`. Also confirm the roadmap dates against Blizzard's own
roadmap post before any reminder is scheduled; the dates floating around (raids on 2026-12-09,
Hardcore "this winter") come from second-hand sites.

If no official feed is usable, stop and tell the owner what the options are. Don't quietly fall
back to scraping HTML or to an unofficial site.

## Where it goes in the code

`reddit.ts` is the model: fetch with a real User-Agent and a timeout, parse with
`fast-xml-parser`, and keep the time of the last successful and last attempted fetch in the
`settings` table so a restart never refetches (`restore` / `remember` there). Failures are logged
and retried on the next cycle; the owner is alerted with `alerts.failed` only after 24 hours
without one successful fetch. The check runs from the minute scheduler on the leader, like the
other jobs in `jobs.ts`.

## Data

- `news_items`: primary key `(source, item_id)`. Title, link, published time, a hash of the
  content (for the hotfix-updated rule), the Discord message id, when it was posted. Claim the row
  first, then post, and release the claim if posting fails, like the daily meme does.
- Reminders: a small table keyed by `(event, kind)` so "tomorrow" and "today" each post once.
- The per-day cap counts rows posted today (Vilnius time), so it survives restarts.

## Edge cases to cover with tests

1. First run with 30 existing items: one post at most, the rest marked seen.
2. The same item appears in two fetches, or in two sources: posted once.
3. Seven new items in one day: five posted oldest first, two the next day.
4. A hotfix article edited four times in a day: one "updated" line.
5. The post to Discord fails: the item is tried again next cycle, and isn't lost or doubled.
6. Restart right after a fetch: no refetch until the 30 minutes are up.
7. A feed returns garbage, a 403, or a 429: logged, no alert until 24 hours of failure.
8. An item not about Forever (retail, other Classic versions): ignored.
9. The channel was deleted by hand: alert once, don't recreate it silently.

## Rollout

1. Create the channel on the test server through the bot's API, run on the test bot for a day and
   look at what it posted.
2. Show the owner two or three real cards from the test server before production.
3. Create the channel on the real server through the bot's API (the owner approved a new channel),
   with the channel id in production's `config.env`. Deploy when nobody is in voice.

## Done means

Parser tests on real fixtures, tests for every edge case above, query coverage still 100%, a day
of clean running on the test bot, and the first real item posted once in production.
