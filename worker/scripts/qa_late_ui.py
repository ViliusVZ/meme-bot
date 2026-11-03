"""QA helper for real-click late-handling checks (quiet admin routes do the setup).

    python scripts/qa_late_ui.py setup     night on DAY locked in, started 11 min ago, room open, late slips out
    python scripts/qa_late_ui.py tick      run a quiet tick and show late/room results
    python scripts/qa_late_ui.py state     attendance rows + where everyone is
    python scripts/qa_late_ui.py offcard   a second day cancelled at game picking (to test 🔄 Reopen)
"""
import json
import subprocess
import sys
import time

from dc import admin, call
from qa_guard import TEST_DAYS, require_idle, vilnius

sys.stdout.reconfigure(encoding="utf-8")
V, K, L = "306836805825593344", "212567787896307713", "747902984003780651"
DAY, OFFDAY = TEST_DAYS[2], TEST_DAYS[3]


def sql(q):
    out = subprocess.run(["python", "scripts/sql.py", q], capture_output=True, text=True, encoding="utf-8").stdout
    return [json.loads(line) for line in out.splitlines() if line.startswith("{")]


def gn(day, user, choice, value=None):
    return admin("/admin/gamenight", {"action": "vote", "day": day, "user": user, "choice": choice, "value": value})


cmd = sys.argv[1]
if cmd == "setup":
    require_idle()
    admin("/admin/gamenight", {"action": "plan", "user": V, "day": DAY})
    for u in (K, L):
        gn(DAY, u, "yes")
    gn(DAY, V, "game", "Phasmophobia")
    gn(DAY, K, "game", "Phasmophobia")
    t = vilnius(DAY, "18:00")
    for u in (V, K, L):
        gn(DAY, u, "time", t)
    now = int(time.time())
    sql(f"UPDATE game_nights SET start_at = {now} WHERE day = '{DAY}'")
    print("start tick:", admin("/admin/gamenight", {"action": "tick"})["maintain"])
    sql(f"UPDATE game_nights SET start_at = {now - 660} WHERE day = '{DAY}'")
    print("late tick:", admin("/admin/gamenight", {"action": "tick"})["late"])
elif cmd == "tick":
    r = admin("/admin/gamenight", {"action": "tick"})
    print("late:", r["late"], "| rooms:", r["rooms"])
elif cmd == "offcard":
    require_idle()
    admin("/admin/gamenight", {"action": "plan", "user": V, "day": OFFDAY})
    for u in (K, L):
        gn(OFFDAY, u, "yes")
    print(gn(OFFDAY, K, "out"), sql(f"SELECT stage, note FROM game_nights WHERE day = '{OFFDAY}'"))
if cmd in ("state", "tick", "setup"):
    print("attendance:", sql(f"SELECT user_id, state, eta, message_id FROM night_attendance WHERE day = '{DAY}'"))
    print("room:", sql(f"SELECT channel_id, archived_at FROM rooms WHERE day = '{DAY}'"))
    print("Vithis is in:", call("GET", f"/guilds/{{guild}}/voice-states/{V}").get("channel_id"))
