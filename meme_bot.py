"""Post yesterday's top r/ProgrammerHumor meme to a Discord webhook.

Stdlib only. Reddit's JSON API now requires approved OAuth apps, but the
public Atom feed still works and is already sorted by score.

Picks the highest-scoring image post *published yesterday* (UTC). Every Reddit
post belongs to exactly one day, so it can only ever be picked once: no
duplicates and no state to store, as long as it runs once per day (which the
scheduled workflow does).

Env:
  DISCORD_WEBHOOK_URL  (required)
  SUBREDDIT            (default: ProgrammerHumor)
  DAY=YYYY-MM-DD       pick a specific UTC day instead of yesterday
  DRY_RUN=1            print the payload instead of posting
"""
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

SUBREDDIT = os.environ.get("SUBREDDIT", "ProgrammerHumor")
# Top 100 of the week holds ~10-16 posts per day, so yesterday's best is always in it.
FEED_URL = f"https://www.reddit.com/r/{SUBREDDIT}/top/.rss?t=week&limit=100"
USER_AGENT = "discord-meme-bot/2.0 (daily top post)"
NS = {"a": "http://www.w3.org/2005/Atom", "media": "http://search.yahoo.com/mrss/"}
IMAGE_RE = re.compile(r'href="(https://i\.redd\.it/[^"]+\.(?:png|jpe?g|gif|webp))"')


def fetch(url, attempts=5):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for i in range(attempts):
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code not in (429, 500, 502, 503) or i == attempts - 1:
                raise
            wait = int(e.headers.get("x-ratelimit-reset") or 0) + 2 if e.code == 429 else 2 ** i
            print(f"reddit {e.code}, retrying in {wait}s", file=sys.stderr)
            time.sleep(min(wait, 60))


def top_meme(day):
    root = ET.fromstring(fetch(FEED_URL))
    for entry in root.iterfind("a:entry", NS):  # sorted by score
        # e.g. 2026-11-02T08:31:53+00:00 - always UTC
        if not entry.findtext("a:published", "", NS).startswith(day):
            continue
        content = html.unescape(entry.findtext("a:content", "", NS))
        match = IMAGE_RE.search(content)
        if not match:  # video, gallery, text post - skip to the next best
            continue
        return {
            "title": html.unescape(entry.findtext("a:title", "", NS)),
            "image": match.group(1),
            "link": entry.find("a:link", NS).get("href"),
            "author": entry.findtext("a:author/a:name", "", NS),
        }
    return None


def post(webhook, meme):
    payload = {
        "username": "Meme Bot 3000",
        "embeds": [{
            "title": meme["title"][:256],
            "url": meme["link"],
            "image": {"url": meme["image"]},
            "color": 0xFF4500,
            "footer": {"text": f"r/{SUBREDDIT} · {meme['author']}"},
        }],
    }
    if os.environ.get("DRY_RUN"):
        print(json.dumps(payload, indent=2))
        return
    req = urllib.request.Request(
        webhook, data=json.dumps(payload).encode(), method="POST",
        headers={"Content-Type": "application/json", "User-Agent": USER_AGENT},
    )
    urllib.request.urlopen(req, timeout=20).close()


def main():
    webhook = os.environ.get("DISCORD_WEBHOOK_URL", "").strip("﻿ \r\n")
    if not webhook and not os.environ.get("DRY_RUN"):
        sys.exit("DISCORD_WEBHOOK_URL is not set")
    yesterday = datetime.now(timezone.utc).date() - timedelta(days=1)
    day = os.environ.get("DAY") or yesterday.isoformat()
    meme = top_meme(day)
    if not meme:
        sys.exit(f"no image post from {day} in this week's top 100")
    post(webhook, meme)
    print(f"{day}: {meme['title']} -> {meme['image']}")


if __name__ == "__main__":
    main()
