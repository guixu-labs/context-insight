"""Verify a1 -> a2 Core data compatibility using independently installed wheels."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    directory = ROOT / ".work" / "upgrade-check" / uuid4().hex[:8]
    directory.mkdir(parents=True)
    env = {key: value for key, value in os.environ.items()
           if key not in ("PYTHONPATH", "PYTHONHOME")}
    env["PYTHONIOENCODING"] = "utf-8"

    def run(*args: str) -> str:
        result = subprocess.run(args, cwd=directory, env=env, capture_output=True,
                                text=True, encoding="utf-8", timeout=120)
        if result.returncode:
            raise RuntimeError(result.stdout + result.stderr)
        return result.stdout

    run(sys.executable, "-m", "venv", str(directory / "venv"))
    python = directory / "venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    old = ROOT / "components/core/dist/agentlineage_core-0.1.0a1-py3-none-any.whl"
    new = ROOT / "components/core/dist/agentlineage_core-0.1.0a2-py3-none-any.whl"
    for wheel in (old, new):
        if not wheel.is_file():
            raise FileNotFoundError("Build/archive required component wheel: " + str(wheel))
    run(str(python), "-m", "pip", "install", "--no-index", "--find-links",
        str(ROOT / ".work/wheelhouse"), str(old))
    snapshot = json.loads(run(str(python), "-c", """
import json
from agentlineage_core.api import Core
from agentlineage_core import __version__
assert __version__ == '0.1.0a1'
core = Core('state')
raw = json.dumps({'sessionId':'upgrade-session','type':'assistant',
    'timestamp':'2026-10-08T00:00:00Z','message':{'content':[{'type':'text','text':'preserved text'}]}}).encode()
source = core.upload_source(raw)
snap = core.create_snapshot(core.create_run('upgrade')['id'],[source['id']])
print(json.dumps({'id':snap['id'],'sha256':source['sha256']}))
"""))
    run(str(python), "-m", "pip", "install", "--no-index", "--find-links",
        str(ROOT / ".work/wheelhouse"), str(new))
    result = json.loads(run(str(python), "-c", """
import json
from agentlineage_core.api import Core
from agentlineage_core.observations import observations
from agentlineage_core import __version__
assert __version__ == '0.1.0a2'
core = Core('state')
snap = core.create_run('upgrade')['latest_snapshot_id']
page = observations(core,snap,{})
assert page['records'][0]['text'] == 'preserved text'
print(json.dumps({'id':snap,'sha256':page['records'][0]['evidence']['sha256']}))
"""))
    assert result == snapshot
    evidence = {"status": "passed", "from": "0.1.0a1", "to": "0.1.0a2",
                "native_snapshot_preserved": True, "source_sha256_preserved": True}
    (ROOT / "artifacts/upgrade-a1-a2.json").write_text(json.dumps(evidence, indent=2),
                                                    encoding="utf-8")
    print(json.dumps(evidence))


if __name__ == "__main__":
    main()
