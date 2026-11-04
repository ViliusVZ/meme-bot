"""Run SQL on the bot's Postgres (test bot's database unless BOT=prod) and print rows as JSON lines.

    python scripts/sql.py "SELECT day, stage FROM game_nights"
    python scripts/sql.py "DELETE FROM rooms WHERE game = 'x'; DELETE FROM ..."

Goes through `ssh vps` (psql inside the postgres container); nothing is exposed to the internet.
"""
import json
import re
import subprocess
import sys

from target import DATABASE


def run(q):
    q = q.strip().rstrip(";")
    returns = re.match(r"(?is)^\s*(select|with)\b", q) or re.search(r"(?is)\breturning\b", q)
    if returns and ";" not in q:
        q = f"WITH qa_rows AS ({q}) SELECT row_to_json(qa_rows) FROM qa_rows" if not re.match(r"(?is)^\s*(select|with)\b", q) else f"SELECT row_to_json(qa_rows) FROM ({q}) qa_rows"
    r = subprocess.run(
        ["ssh", "vps", f"docker exec -i postgres psql -U postgres -d {DATABASE} -v ON_ERROR_STOP=1 -At"],
        input=q + ";\n", capture_output=True, text=True, encoding="utf-8",
    )
    if r.returncode:
        raise RuntimeError(r.stderr.strip())
    return [json.loads(line) for line in r.stdout.splitlines() if line.startswith("{")]


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    for row in run(sys.argv[1]):
        print(json.dumps(row, ensure_ascii=False))
    print("--")
