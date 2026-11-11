# Query coverage (G3): every database query in src/ must be executed by a test. Run after
#   npx vitest run --coverage --coverage.reporter=json
#   python scripts/qcov.py [--expect N]
import json, re, os
cov = json.load(open('coverage/coverage-final.json', encoding='utf-8'))
total = hit = 0
missed = []
for path, data in cov.items():
    p = path.replace(os.sep, '/').replace('\\', '/')
    if not p.endswith('.ts') or '/src/' not in p:
        continue
    src = open(path, encoding='utf-8').read().split('\n')
    stm = [(v['start']['line'], v['end']['line'], data['s'][k]) for k, v in data['statementMap'].items()]
    for i, line in enumerate(src, 1):
        if re.search(r'\b(env\.db|tx)\b(\s*$|\.(select|insert|update|delete|execute|transaction))', line) and 'import' not in line and not line.strip().startswith('//') and 'type Tx' not in line:
            total += 1
            cands = [s for s in stm if s[0] <= i <= s[1]]
            ran = min(cands, key=lambda s: s[1] - s[0])[2] > 0 if cands else False
            if ran:
                hit += 1
            else:
                missed.append(f"{os.path.basename(path)}:{i}: {line.strip()[:100]}")
print(f"query sites: {total}, executed by unit/flow tests: {hit}")
print("\n".join(missed))
# plan 05 (verification.md §3, G3): every site executed, and as many sites as the baseline
import sys
if missed:
    sys.exit(f"G3 red: {len(missed)} query site(s) never executed")
if "--expect" in sys.argv:
    want = int(sys.argv[sys.argv.index("--expect") + 1])
    if total != want:
        sys.exit(f"G3 red: {total} query sites, the baseline is {want} (explain the difference in STATUS.md)")
