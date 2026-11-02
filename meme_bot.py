"""Fetch this week's top r/ProgrammerHumor image posts and hand them to the Worker.

Stdlib only. Reddit's JSON API now requires approved OAuth apps, but the
public Atom feed still works and is already sorted by score. Reddit is fetched
from GitHub Actions rather than the Worker because it's proven to work from here.

The Worker (worker/) stores everything in D1, posts the daily meme, and handles
votes and slash commands. Calling it repeatedly is safe: the database allows
exactly one daily meme per day.

Env:
  WORKER_URL      e.g. https://meme-bot.<account>.workers.dev
  INGEST_SECRET   shared secret, same as the Worker's
  SUBREDDIT       (default: ProgrammerHumor)
  DRY_RUN=1       print what would be sent instead of sending
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

SUBREDDIT = os.environ.get("SUBREDDIT", "ProgrammerHumor")
FEED_URL = f"https://www.reddit.com/r/{SUBREDDIT}/top/.rss?t=week&limit=100"
USER_AGENT = "discord-meme-bot/3.0 (daily top post)"
NS = {"a": "http://www.w3.org/2005/Atom"}
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


def image_posts():
    root = ET.fromstring(fetch(FEED_URL))
    for rank, entry in enumerate(root.iterfind("a:entry", NS), start=1):
        match = IMAGE_RE.search(html.unescape(entry.findtext("a:content", "", NS)))
        if not match:  # video, gallery, text post
            continue
        yield {
            "id": entry.findtext("a:id", "", NS),
            "title": html.unescape(entry.findtext("a:title", "", NS)),
            "image": match.group(1),
            "link": entry.find("a:link", NS).get("href"),
            "author": entry.findtext("a:author/a:name", "", NS),
            "published": entry.findtext("a:published", "", NS),
            "rank": rank,
        }


def main():
    memes = list(image_posts())
    print(f"fetched {len(memes)} image posts")
    if os.environ.get("DRY_RUN"):
        print(json.dumps(memes[:3], indent=2, ensure_ascii=False))
        return
    url = os.environ["WORKER_URL"].strip("﻿ \r\n/") + "/ingest"
    secret = os.environ["INGEST_SECRET"].strip("﻿ \r\n")
    req = urllib.request.Request(
        url, method="POST",
        data=json.dumps({"memes": memes, "post_daily": True}).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {secret}",
                 "User-Agent": USER_AGENT},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        print(r.read().decode())


if __name__ == "__main__":
    main()
