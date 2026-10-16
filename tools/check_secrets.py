"""Small deterministic preflight; GitHub secret scanning remains recommended.

Only print filenames/line numbers, never matching values. This is intentionally
not advertised as a comprehensive secret detector or a history scan.
"""
from pathlib import Path
import re
import subprocess

patterns = [r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
            r'\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b',
            r'\bgithub_pat_[A-Za-z0-9_]{50,}\b',
            r'\bsecret-[A-Za-z0-9]{20,}\b',
            r'\bAKIA[A-Z0-9]{16}\b']
rule = re.compile('|'.join(patterns))
failed = False
for name in subprocess.check_output(['git','ls-files','-z']).decode().split('\0'):
    if not name: continue
    path = Path(name)
    if not path.is_file() or path.stat().st_size > 2_000_000: continue
    try: lines = path.read_text().splitlines()
    except (UnicodeError, OSError): continue
    for n,line in enumerate(lines,1):
        if rule.search(line):
            print(f'Possible credential: {name}:{n}')
            failed = True
if failed: raise SystemExit(1)
print('PASS tracked-file credential pattern check (not a full secret scan)')
