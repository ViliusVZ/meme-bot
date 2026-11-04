"""QA: 🏁 leave-by on a test Monday night (quiet admin routes; pair with real clicks in the browser).

    python scripts/qa_leaveby.py setup       plan Monday, everyone in, Palworld → time stage
    python scripts/qa_leaveby.py state       print the card, votes and night row
    python scripts/qa_leaveby.py vote <who> <time|until> <HH:MM or "">
"""
import json
import subprocess
import sys

from target import BOT_ID, GAME_CHANNEL
from dc import admin, call
from qa_guard import TEST_DAYS, require_idle, vilnius, wall

sys.stdout.reconfigure(encoding="utf-8")
WHO = {"V": "306836805825593344", "K": "212567787896307713", "L": "747902984003780651"}
DAY, CH = TEST_DAYS[7], GAME_CHANNEL


def at(hhmm):
    return vilnius(DAY, hhmm)


def vote(who, choice, value=None):
    return admin("/admin/gamenight", {"action": "vote", "day": DAY, "user": WHO[who], "choice": choice, "value": value})


def sql(q):
    out = subprocess.run(["python", "scripts/sql.py", q], capture_output=True, text=True, encoding="utf-8").stdout
    return [json.loads(line) for line in out.splitlines() if line.startswith("{")]


cmd = sys.argv[1]
if cmd == "setup":
    require_idle()
    print(admin("/admin/gamenight", {"action": "plan", "user": WHO["V"], "day": DAY}))
    for w in ("K", "L"):
        vote(w, "yes")
    vote("V", "game", "Palworld")
    print(vote("K", "game", "Palworld"))
elif cmd == "vote":
    who, kind, hhmm = sys.argv[2:5]
    if kind == "time":
        print(vote(who, "time", at(hhmm)))
    else:  # until: a typed HH:MM like the modal, or "" to clear
        print(vote(who, "until", hhmm))
if cmd in ("state", "vote"):
    night = sql(f"SELECT stage, start_at, conflict, nudge_id, event_id, message_id FROM game_nights WHERE day='{DAY}'")
    print("NIGHT", night)
    for v in sql(f"SELECT stage, user_id, choice FROM game_night_votes WHERE day='{DAY}' AND stage IN ('time','until')"):
        who = next(k for k, u in WHO.items() if u == v["user_id"])
        print("  ", v["stage"], who, wall(v["choice"]))
    if night and night[0]["message_id"]:
        m = call("GET", f"/channels/{CH}/messages/{night[0]['message_id']}")
        texts = []

        def walk(cs):
            for c in cs:
                if c.get("content"):
                    texts.append(c["content"].replace("\n", " / "))
                if c.get("type") == 2:
                    texts.append(f"[{c.get('label')}]")
                walk(c.get("components", []))

        walk(m["components"])
        print("CARD", " | ".join(texts))
