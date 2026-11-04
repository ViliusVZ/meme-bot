"""Give the "Bot Test Lab" server the same layout the bot expects on the real one, as the test bot,
and write the new channel ids into deploy/dev.env. Safe to re-run: existing channels are reused.

    python scripts/setup_test_server.py
"""
import pathlib
import re
import sys

from dc import call
from target import PROD

if PROD:
    sys.exit("this sets up the TEST server; don't run it with BOT=prod")
sys.stdout.reconfigure(encoding="utf-8")

channels = call("GET", "/guilds/{guild}/channels")


def find(name, kind, parent=None):
    for c in channels:
        if c["name"] == name and c["type"] == kind and (parent is None or c.get("parent_id") == parent):
            return c["id"]
    return None


def ensure(name, kind, **extra):
    cid = find(name, kind, extra.get("parent_id"))
    if cid:
        return cid
    c = call("POST", "/guilds/{guild}/channels", {"name": name, "type": kind, **extra})
    channels.append(c)
    print(f"created {name}: {c['id']}")
    return c["id"]


games_cat = ensure("🎮 Game Night", 4)
game_night = ensure("game-night", 0, parent_id=games_cat)
voice_cat = ensure("🔊 Voice", 4)
lobby = ensure("🛋️ Lobby", 2, parent_id=voice_cat)
memes_cat = ensure("😂 Memes", 4)
daily = ensure("daily-memes", 0, parent_id=memes_cat)

env = pathlib.Path(__file__).resolve().parent.parent / "deploy" / "dev.env"
text = env.read_text()
for key, value in {"GAME_CHANNEL_ID": game_night, "LOBBY_CHANNEL_ID": lobby, "VOICE_CATEGORY_ID": voice_cat, "CHANNEL_ID": daily}.items():
    text = re.sub(rf"^{key}=.*$", f"{key}={value}", text, flags=re.M)
env.write_text(text, newline="\n")
print(f"game-night {game_night} · lobby {lobby} · voice {voice_cat} · daily-memes {daily} → {env.name}")
