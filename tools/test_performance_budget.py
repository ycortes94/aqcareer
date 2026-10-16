"""Prevent large public-payload regressions; no browser/network dependency."""
import gzip
import json
from pathlib import Path

root = Path(__file__).resolve().parent.parent
budget = json.loads((root / 'tools/performance-budget.json').read_text())
failed = []
for item in budget['files']:
    path = root / item['path']
    size = len(gzip.compress(path.read_bytes(), compresslevel=9, mtime=0))
    if size > item['maxGzipBytes']:
        failed.append(f"{item['path']}: {size} > {item['maxGzipBytes']} compressed bytes")
# Additional browser code needs an explicit budget and review.
known = {item['path'] for item in budget['files']}
for path in (root / 'assets/js').glob('*.js'):
    if str(path.relative_to(root)) not in known:
        failed.append(f'New browser script needs a size budget: {path.name}')
if failed: raise SystemExit('\n'.join(failed))
print(f"PASS compressed payload budgets: {len(budget['files'])} public files")
