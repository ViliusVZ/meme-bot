"""Run SQL against the remote D1 database and print rows.   python scripts/sql.py "SELECT ..." """
import json
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8")
out = subprocess.run(
    ["npx", "wrangler", "d1", "execute", "meme-bot", "--remote", "--json", "-y", "--command", sys.argv[1]],
    capture_output=True, shell=True, cwd=__file__.rsplit("scripts", 1)[0],
).stdout.decode("utf-8-sig")
for result in json.loads(out):
    for row in result["results"]:
        print(json.dumps(row, ensure_ascii=False))
    print("--")
