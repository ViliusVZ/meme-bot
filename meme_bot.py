"""Post the top r/ProgrammerHumor meme of the day to a Discord webhook.

Stdlib only. Reddit's JSON API now requires approved OAuth apps, but the
public Atom feed still works and is already sorted by score.

Already-posted post IDs live in posted.txt, so the same meme is never sent
twice. The workflow commits that file back after each run.

Env:
  DISCORD_WEBHOOK_URL  (required)
  SUBREDDIT            (default: ProgrammerHumor)
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
from pathlib import Path

SUBREDDIT = os.environ.get("SUBREDDIT", "ProgrammerHumor")
FEED_URL = f"https://www.reddit.com/r/{SUBREDDIT}/top/.rss?t=day&limit=25"
USER_AGENT = "discord-meme-bot/2.0 (daily top post)"
NS = {"a": "http://www.w3.org/2005/Atom", "media": "http://search.yahoo.com/mrss/"}
IMAGE_RE = re.compile(r'href="(https://i\.redd\.it/[^"]+\.(?:png|jpe?g|gif|webp))"')
POSTED_FILE = Path(__file__).with_name("posted.txt")
POSTED_KEEP = 1000  # plenty: a post only stays in the t=day feed for ~a day


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


def load_posted():
    return POSTED_FILE.read_text().split() if POSTED_FILE.exists() else []


def save_posted(posted):
    POSTED_FILE.write_text("\n".join(posted[-POSTED_KEEP:]) + "\n")


def top_meme(posted):
    root = ET.fromstring(fetch(FEED_URL))
    for entry in root.iterfind("a:entry", NS):
        post_id = entry.findtext("a:id", "", NS)
        if post_id in posted:
            continue
        content = html.unescape(entry.findtext("a:content", "", NS))
        match = IMAGE_RE.search(content)
        if not match:  # video, gallery, text post - skip to the next best
            continue
        return {
            "id": post_id,
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
    posted = load_posted()
    meme = top_meme(set(posted))
    if not meme:
        sys.exit("no new image post in today's top 25")
    post(webhook, meme)
    if not os.environ.get("DRY_RUN"):
        save_posted(posted + [meme["id"]])
    print(f"posted: {meme['title']} -> {meme['image']}")


if __name__ == "__main__":
    main()
