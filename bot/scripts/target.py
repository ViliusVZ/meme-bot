"""Which bot the scripts talk to. The TEST bot unless you say BOT=prod; QA belongs on the test server.

    BOT=prod python scripts/dc.py GET /guilds/{guild}/channels
"""
import os
import pathlib

_root = pathlib.Path(__file__).resolve().parent.parent
_secrets = dict(line.split("=", 1) for line in (_root / ".env.qa").read_text().split() if "=" in line)
_config = dict(
    line.split("=", 1) for line in (_root / "deploy" / ("prod.env" if os.environ.get("BOT") == "prod" else "dev.env")).read_text().splitlines()
    if "=" in line and not line.startswith("#")
)

PROD = os.environ.get("BOT") == "prod"
URL = "https://srv2140520.hstgr.cloud/bot" if PROD else "https://srv2140520.hstgr.cloud/bot-dev"
ADMIN_SECRET = _secrets["ADMIN_SECRET_PROD" if PROD else "ADMIN_SECRET_DEV"]
DATABASE = "meme_bot" if PROD else "meme_bot_dev"
GUILD = _config["GUILD_ID"]
GAME_CHANNEL = _config["GAME_CHANNEL_ID"]
LOBBY = _config["LOBBY_CHANNEL_ID"]
BOT_ID = _config["DISCORD_APP_ID"]
PLAYERS = tuple(_config["PLAYERS"].split(","))
