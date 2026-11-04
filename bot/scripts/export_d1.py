"""Export every table of the Cloudflare D1 database to one JSON file (for import-d1.ts).

    python scripts/export_d1.py d1-export.json

Runs wrangler from ../worker (it's logged in there). games keeps its rowid, which is the
insertion order the game list sorts by after plays.
"""
import json
import subprocess
import sys

TABLES = {
    "memes": "SELECT * FROM memes",
    "votes": "SELECT * FROM votes",
    "users": "SELECT * FROM users",
    "recaps": "SELECT * FROM recaps",
    "game_nights": "SELECT * FROM game_nights",
    "game_night_votes": "SELECT * FROM game_night_votes",
    "games": "SELECT rowid AS seq, * FROM games ORDER BY rowid",
    "polls": "SELECT * FROM polls",
    "poll_votes": "SELECT * FROM poll_votes",
    "tiebreaks": "SELECT * FROM tiebreaks",
    "rooms": "SELECT * FROM rooms",
    "night_attendance": "SELECT * FROM night_attendance",
    "voice_segments": "SELECT * FROM voice_segments",
}
worker = __file__.replace("\\", "/").rsplit("/bot/", 1)[0] + "/worker"
out = {}
for table, q in TABLES.items():
    r = subprocess.run(
        ["npx", "wrangler", "d1", "execute", "meme-bot", "--remote", "--json", "-y", "--command", q],
        capture_output=True, shell=True, cwd=worker,
    )
    data = json.loads(r.stdout.decode("utf-8-sig"))
    out[table] = data[0]["results"]
    print(f"{table}: {len(out[table])}", file=sys.stderr)
with open(sys.argv[1], "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False)
