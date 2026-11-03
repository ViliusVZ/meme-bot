"""QA: tiebreak edge cases on polls, driven entirely through the quiet admin routes."""
import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

from dc import admin

sys.stdout.reconfigure(encoding="utf-8")
V, K, L = "306836805825593344", "212567787896307713", "747902984003780651"


def sql(q):
    out = subprocess.run(["python", "scripts/sql.py", q], capture_output=True, text=True, encoding="utf-8").stdout
    return [json.loads(line) for line in out.splitlines() if line.startswith("{")]


def new_poll(q, options):
    rows = sql(f"INSERT INTO polls (question, options, created_by, created_at) VALUES ('{q}', '{json.dumps(options)}', '{V}', 'qa') RETURNING id")
    return rows[0]["id"]


pv = lambda pid, u, c: admin("/admin/gamenight", {"action": "poll-vote", "poll": pid, "user": u, "choice": c})
tb = lambda tid, u, c, v=None: admin("/admin/gamenight", {"action": "tb", "id": tid, "user": u, "choice": c, "value": v})
ok = lambda cond, msg: print(("✅ " if cond else "❌ ") + msg)

# 1) 1–1 with one person absent, then Close → RPS between the two; spectator refused; 5 draws → wheel
p = new_poll("qa close tie", ["A", "B", "C"])
pv(p, V, 0)
pv(p, K, 1)
pv(p, p and V, "close")
t = sql(f"SELECT * FROM tiebreaks WHERE kind='poll' AND ref='{p}'")[0]
ok(json.loads(t["options"]) == ["A", "B"], f"close on a 1-1 tie opens a tiebreak between A and B ({t['options']})")
tb(t["id"], V, "rps")
ok("popcorn" in (tb(t["id"], L, "hand", "r")["notice"] or ""), "non-contender can't throw")
for i in range(5):
    tb(t["id"], V, "hand", "r")
    r = tb(t["id"], K, "hand", "r")["tiebreak"]
ok(r["result"] in ("A", "B") and "wheel took over" in (r["how"] or ""), f"5 draws → wheel decides: {r['result']} / {r['how']}")
ok(sql(f"SELECT result FROM polls WHERE id={p}")[0]["result"] == f"win:{r['result']}", "poll closed with the tiebreak winner")
ok("already decided" in pv(p, L, 2)["notice"], "voting after it's decided is refused")

# 2) two simultaneous wheel spins → exactly one result
p2 = new_poll("qa race", ["X", "Y", "Z"])
for u, c in ((V, 0), (K, 1), (L, 2)):
    pv(p2, u, c)
t2 = sql(f"SELECT id FROM tiebreaks WHERE kind='poll' AND ref='{p2}'")[0]["id"]
with ThreadPoolExecutor(2) as ex:
    results = list(ex.map(lambda u: tb(t2, u, "wheel")["tiebreak"], (V, K)))
final = sql(f"SELECT result, how FROM tiebreaks WHERE id={t2}")[0]
ok(all(r["result"] == final["result"] for r in results), f"double spin settles on one result: {final['result']} ({final['how'][:40]}…)")

# 3) majority still wins without any tiebreak
p3 = new_poll("qa majority", ["Yes", "No"])
pv(p3, V, 0)
pv(p3, K, 0)
ok(sql(f"SELECT result FROM polls WHERE id={p3}")[0]["result"] == "win:Yes", "2 of 3 is an instant win")
ok(not sql(f"SELECT id FROM tiebreaks WHERE kind='poll' AND ref='{p3}'"), "no tiebreak for a majority")

sql(f"DELETE FROM poll_votes WHERE poll_id IN ({p},{p2},{p3}); DELETE FROM tiebreaks WHERE kind='poll' AND ref IN ('{p}','{p2}','{p3}'); DELETE FROM polls WHERE id IN ({p},{p2},{p3})")
