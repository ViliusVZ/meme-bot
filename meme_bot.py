"""Post the top r/ProgrammerHumor meme of the day to a Discord webhook.

Stdlib only. Reddit's JSON API now requires approved OAuth apps, but the
public Atom feed still works and is already sorted by score.

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

SUBREDDIT = os.environ.get("SUBREDDIT", "ProgrammerHumor")
FEED_URL = f"https://www.reddit.com/r/{SUBREDDIT}/top/.rss?t=day&limit=10"
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


def top_meme():
    root = ET.fromstring(fetch(FEED_URL))
    for entry in root.iterfind("a:entry", NS):
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
    webhook = os.environ.get("DISCORD_WEBHOOK_URL")
    if not webhook and not os.environ.get("DRY_RUN"):
        sys.exit("DISCORD_WEBHOOK_URL is not set")
    meme = top_meme()
    if not meme:
        sys.exit("no image post in today's top 10")
    post(webhook, meme)
    print(f"posted: {meme['title']} -> {meme['image']}")


if __name__ == "__main__":
    main()
