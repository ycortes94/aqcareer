"""Check exact Python/tool/CDN versions against OSV; fail if lookup is unavailable."""
import json
from pathlib import Path
import re
import subprocess
import tomllib

lock = tomllib.loads(Path('uv.lock').read_text())
queries = [{'package':{'name':p['name'],'ecosystem':'PyPI'},'version':p['version']}
           for p in lock['package'] if 'registry' in p.get('source',{})]
queries.append({'package':{'name':'uv','ecosystem':'PyPI'},
                'version':json.loads(Path('tools/uv-bootstrap.json').read_text())['version']})
source = Path('assets/js/analytics.js').read_text()
for package,pattern in [('@amplitude/analytics-browser',r'analytics-browser@([\d.]+)'),
                        ('@amplitude/plugin-session-replay-browser',r'plugin-session-replay-browser-([\d.]+)-'),
                        ('@statsig/js-client',r'@statsig/js-client@([\d.]+)')]:
    version = re.search(pattern,source).group(1)
    queries.append({'package':{'name':package,'ecosystem':'npm'},'version':version})
response = subprocess.check_output(['curl','--fail','--silent','--show-error','--max-time','60',
    '-H','Content-Type: application/json','--data-binary','@-','https://api.osv.dev/v1/querybatch'],
    input=json.dumps({'queries':queries}).encode())
results = json.loads(response)['results']
if len(results) != len(queries): raise SystemExit('Incomplete advisory lookup')
failed=False
for query,result in zip(queries,results):
    if result.get('vulns'):
        print(query['package']['name'],query['version'],[v['id'] for v in result['vulns']]);failed=True
    else: print('PASS advisory lookup:',query['package']['name'],query['version'])
if failed: raise SystemExit('Review published dependency advisories before release')
