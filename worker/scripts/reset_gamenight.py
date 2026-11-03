"""Testing helper: wipe the given game-night days (card, nudge, event, votes, tiebreak, attendance)
and the bot's other messages about them (pings, late slips). Never touches anyone else's messages.

    python scripts/reset_gamenight.py <day> [day ...]
    python scripts/reset_gamenight.py --real <day>     a real (non-test) day: asks the guard first
"""
import json
import sys

from dc import admin, call
from qa_guard import BOT_ID, GAME_CHANNEL, REAL_UNTIL, require_idle

sys.stdout.reconfigure(encoding="utf-8")
days = [a for a in sys.argv[1:] if not a.startswith("--")]
if not days:
    sys.exit(__doc__)
if any(d <= REAL_UNTIL for d in days):
    if "--real" not in sys.argv:
        sys.exit(f"🛑 {[d for d in days if d <= REAL_UNTIL]} could be a real night. Pass --real if you really mean it.")
    require_idle()

# the bot's messages that belong to these days: cards and late slips carry the day in their buttons;
# nudges and pings reply to a card
recent = call("GET", f"/channels/{GAME_CHANNEL}/messages?limit=100")
mine = [m for m in recent if m["author"]["id"] == BOT_ID and not m.get("pinned")]
cards = {m["id"] for m in mine if any(f"gn:{d}:" in json.dumps(m.get("components", [])) or f"late:{d}:" in json.dumps(m.get("components", [])) for d in days)}
doomed = cards | {m["id"] for m in mine if (m.get("message_reference") or {}).get("message_id") in cards}
for d in days:
    print(d, admin("/admin/gamenight", {"action": "reset", "day": d}))
for mid in doomed:
    call("DELETE", f"/channels/{GAME_CHANNEL}/messages/{mid}")
print("deleted", len(doomed), "bot messages")
