"""Check manual examples without installing DSH or calling a model."""
from pathlib import Path
import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import tarfile
import time
import urllib.error
import urllib.request
import yaml

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
TEMP = ROOT / 'tmp' / 'pdfs' / 'example-check'
TEMP.mkdir(parents=True, exist_ok=True)
errors = []
commands = []


def run(argv, cwd=HERE):
    env = os.environ.copy()
    env['npm_config_cache'] = str(TEMP / 'npm-cache')
    result = subprocess.run(argv, cwd=cwd, env=env, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=60)
    commands.append({'command': argv[:3], 'cwd': str(cwd), 'exit': result.returncode})
    if result.returncode:
        raise RuntimeError(result.stdout[-1000:] + result.stderr[-2000:])
    return result.stdout


class Loader(yaml.SafeLoader):
    pass


Loader.add_constructor('tag:yaml.org,2002:js', lambda loader, node: loader.construct_scalar(node))
text = (HERE / 'README.zh-CN.md').read_text(encoding='utf-8')
fenced = False
headings = []
for line in text.splitlines():
    if line.startswith('```'):
        fenced = not fenced
    elif not fenced:
        match = re.match(r'^#{2,3} (.+)$', line)
        if match:
            headings.append(match[1])
slugs = {re.sub(r'[^\w\-\s]', '', h.lower()).replace(' ', '-') for h in headings}
links = re.findall(r'\[([^\]]+)\]\(([^)]+)\)', text)
for label, target in links:
    if target.startswith('#'):
        if target[1:] not in slugs:
            errors.append('Missing anchor: ' + target)
    elif not target.startswith('http') and not (HERE / target.split('#')[0]).exists():
        errors.append('Missing local link: ' + target)
blocks = re.findall(r'^```(json|yaml)\s*\n(.*?)^```', text, re.M | re.S)
for kind, content in blocks:
    try:
        json.loads(content) if kind == 'json' else yaml.load(content, Loader=Loader)
    except Exception as exc:
        errors.append(str(exc))
if '\ufffd' in text or any(line.rstrip() != line for line in text.splitlines()):
    errors.append('Encoding or whitespace')

node = shutil.which('node')
npm = shutil.which('npm.cmd' if os.name == 'nt' else 'npm')
packages = []
for folder in ['http-bundle', 'mcp-bundle', 'skills-bundle', 'http-skills-bundle']:
    directory = HERE / 'examples' / folder
    manifest = json.loads((directory / 'package.json').read_text(encoding='utf-8'))
    for entry in directory.glob('*.js'):
        run([node, '--check', str(entry)])
    packed = json.loads(run([npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', str(TEMP)], directory))[0]
    archive = TEMP / packed['filename']
    with tarfile.open(archive) as tar:
        names = {member.name.removeprefix('package/') for member in tar.getmembers() if member.isfile()}
        for required in ['package.json', 'README.md', manifest['dsh']['bundle']['patch'].removeprefix('./')]:
            if required not in names:
                errors.append(folder + ': missing tarball file ' + required)
        for key, value in manifest.get('exports', {}).items():
            if isinstance(value, str) and '*' not in value and value.removeprefix('./') not in names:
                errors.append(folder + ': missing export ' + value)
        if 'skills' in folder:
            for required in ['assets/skills/component-check/SKILL.md', 'assets/skills/component-check/references/checklist.md']:
                if required not in names:
                    errors.append(folder + ': missing skill resource ' + required)
    packages.append({'package': manifest['name'], 'files': len(names), 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest()})

for target, original in [('http.js', 'http-bundle/index.js'), ('skills.js', 'skills-bundle/index.js')]:
    if (HERE / 'examples/http-skills-bundle' / target).read_bytes() != (HERE / 'examples' / original).read_bytes():
        errors.append('Combined example diverged: ' + target)

fixture = HERE / 'examples/fixtures/health-server.mjs'
run([node, '--check', str(fixture)])
service_checks = []
for mode, token in [('ok', ''), ('degraded', ''), ('invalid', ''), ('http-error', ''), ('slow', ''), ('ok', 'example-local-test-token')]:
    with socket.socket() as reservation:
        reservation.bind(('127.0.0.1', 0))
        port = reservation.getsockname()[1]
    env = os.environ.copy()
    env.pop('COMPONENT_TOKEN', None)
    env.update(DEMO_PORT=str(port), DEMO_MODE=mode)
    if token:
        env['COMPONENT_TOKEN'] = token
    proc = subprocess.Popen([node, str(fixture)], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    try:
        for attempt in range(50):
            if proc.poll() is not None:
                raise RuntimeError('Fixture exited')
            try:
                with socket.create_connection(('127.0.0.1', port), timeout=.1):
                    break
            except OSError:
                time.sleep(.05)
        url = f'http://127.0.0.1:{port}/health'
        if mode == 'slow':
            try:
                urllib.request.urlopen(url, timeout=.25)
                raise AssertionError('Slow endpoint did not time out')
            except TimeoutError:
                service_checks.append('slow: client timeout')
            continue
        if token:
            try:
                urllib.request.urlopen(url, timeout=2)
                raise AssertionError('Unauthenticated request accepted')
            except urllib.error.HTTPError as exc:
                assert exc.code == 401
        request = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + token} if token else {})
        try:
            with urllib.request.urlopen(request, timeout=2) as response:
                body = json.load(response)
            assert body == ({'ready': True} if mode == 'invalid' else {'status': mode})
            service_checks.append(mode + (': auth 401/200' if token else ': expected JSON'))
        except urllib.error.HTTPError as exc:
            assert mode == 'http-error' and exc.code == 503
            service_checks.append('http-error: 503')
    finally:
        proc.terminate()
        proc.wait(timeout=5)

report = {'markdown_links': len(links), 'config_blocks': len(blocks), 'packages': packages,
          'service_checks': service_checks, 'errors': errors,
          'dsh_activation': 'not tested: outside local example checks; no DSH activation or model invocation',
          'commands': commands}
output = ROOT / 'output/pdf/DSH-examples-validation.json'
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({k: v for k, v in report.items() if k != 'commands'}, ensure_ascii=True))
raise SystemExit(bool(errors))
