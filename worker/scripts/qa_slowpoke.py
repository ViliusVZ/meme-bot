"""QA: a planned night through to lock-in with three different start times (quiet, no pings)."""
import sys
import time

from dc import admin, call
from qa_guard import TEST_DAYS, require_idle, vilnius

sys.stdout.reconfigure(encoding="utf-8")
V, K, L = "306836805825593344", "212567787896307713", "747902984003780651"
DAY, CH = TEST_DAYS[7], "1567132345213911240"
at = lambda hh: vilnius(DAY, f"{hh}:00")
vote = lambda u, c, v=None: admin("/admin/gamenight", {"action": "vote", "day": DAY, "user": u, "choice": c, "value": v})

if "--resume" not in sys.argv:
    require_idle()
    print("plan", admin("/admin/gamenight", {"action": "plan", "user": V, "day": DAY})["started"])
    for u in (K, L):
        vote(u, "yes")
    vote(V, "game", "Palworld")
    vote(K, "game", "Palworld")
    print("wrong-day time:", vote(V, "time", str(int(time.time()) + 3600)))
vote(V, "time", at(18))
vote(L, "time", at(19))
vote(K, "time", at(20))
time.sleep(4)
night = admin("/admin/discord", {"method": "GET", "path": f"/channels/{CH}/messages?limit=10"})
for m in reversed(night):
    texts = []

    def walk(cs):
        for c in cs:
            if c.get("content"):
                texts.append(c["content"].replace("\n", " / "))
            walk(c.get("components", []))

    walk(m["components"])
    print("MSG", m["content"][:120] or " | ".join(texts)[:400])
print("EVENTS", [(e["name"], e["scheduled_start_time"]) for e in call("GET", "/guilds/{guild}/scheduled-events")])
