"""Install a hash-verified uv executable locally; no shell installer is executed."""
import hashlib
import io
import json
import platform
import subprocess
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parent.parent
manifest = json.loads((root / 'tools/uv-bootstrap.json').read_text())
key = platform.system().lower() + '-' + platform.machine().lower()
if key == 'darwin-aarch64':
    key = 'darwin-arm64'
package = manifest['platforms'].get(key)
if not package:
    raise SystemExit('Install uv ' + manifest['version'] + ' for this platform from https://docs.astral.sh/uv/')
# curl uses the host certificate store, including on macOS.
data = subprocess.check_output(['curl', '--fail', '--location', '--silent', '--show-error',
                                '--max-time', '60', package['url']])
if hashlib.sha256(data).hexdigest() != package['sha256']:
    raise SystemExit('uv package integrity check failed')
with zipfile.ZipFile(io.BytesIO(data)) as wheel:
    entry = next(n for n in wheel.namelist() if n.endswith('.data/scripts/uv'))
    target = root / '.tools/uv'
    target.parent.mkdir(exist_ok=True)
    target.write_bytes(wheel.read(entry))
    target.chmod(0o755)
subprocess.run([str(target), '--version'], check=True)
