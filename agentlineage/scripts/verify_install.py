"""Build-artifact smoke test in a fresh venv with no host/source imports."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tomllib
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]


def run(argv: list[str], directory: Path, env: dict[str, str]) -> str:
    result = subprocess.run(argv, cwd=directory, env=env, capture_output=True,
                            text=True, encoding="utf-8", timeout=180)
    if result.returncode:
        raise RuntimeError(result.stdout + result.stderr)
    return result.stdout


def main() -> None:
    evidence = ROOT / "artifacts" / "installation-check.json"
    evidence.parent.mkdir(exist_ok=True)
    evidence.write_text(json.dumps({"status": "running"}), encoding="utf-8")
    directory = ROOT / ".work" / "install-check" / uuid4().hex[:8]
    directory.mkdir(parents=True)
    wheels = ROOT / ".work" / "wheelhouse"
    wheels.mkdir(parents=True, exist_ok=True)
    env = {key: value for key, value in os.environ.items()
           if key not in ("PYTHONPATH", "PYTHONHOME")}
    env["PYTHONIOENCODING"] = "utf-8"
    run([sys.executable, "-m", "pip", "download", "--only-binary=:all:",
         "--dest", str(wheels), "PyYAML==6.0.3"], directory, env)
    run([sys.executable, "-m", "venv", str(directory / "venv")], directory, env)
    python = directory / "venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    components = ("core", "learning")
    versions = {
        component: tomllib.loads(
            (ROOT / "components" / component / "pyproject.toml").read_text(encoding="utf-8")
        )["project"]["version"]
        for component in components
    }
    artifacts = [ROOT / "components" / component / "dist" /
                 f"agentlineage_{component}-{versions[component]}-py3-none-any.whl"
                 for component in components]
    # Core is installed and executed first, before Learning is present.
    run([str(python), "-m", "pip", "install", "--no-index", "--find-links", str(wheels),
         str(artifacts[0])], directory, env)
    core_check = """
import importlib.util, json
from pathlib import Path
import agentlineage_core
from agentlineage_core.api import Core
from agentlineage_core.export import export_document
assert 'site-packages' in agentlineage_core.__file__
assert importlib.util.find_spec('agentlineage_learning') is None
assert importlib.util.find_spec('migbot') is None
rows = []
for second,tool,args,reply in [
 (1,'Read',{'file_path':'/project/spec'},'gap=4'),
 (3,'Write',{'file_path':'/project/file','content':'gap=8'},'ok'),
 (6,'Edit',{'file_path':'/project/file','old_string':'gap=8','new_string':'gap=4'},'ok')]:
 common={'sessionId':'s','agentId':'a','cwd':'/project'}
 rows.extend([
  {**common,'type':'assistant','timestamp':f'2026-01-01T00:00:{second:02d}Z',
   'message':{'content':[{'type':'tool_use','id':str(second),'name':tool,'input':args}]}},
  {**common,'type':'user','timestamp':f'2026-01-01T00:00:{second+1:02d}Z',
   'message':{'content':[{'type':'tool_result','tool_use_id':str(second),'content':reply}]}}
 ])
Path('native.jsonl').write_text('\\n'.join(map(json.dumps,rows))+'\\n',encoding='utf-8')
core=Core('state')
snapshot=core.import_files('independent-install',['native.jsonl'])['snapshot_id']
answer=core.query(snapshot,{'op':'file','key':'/project/file','at':'2026-01-01T00:00:09Z','view':'relations'})
assert answer['result']['total']==2
assert 'Observed operations' in export_document(core,snapshot)
Path('snapshot.txt').write_text(snapshot,encoding='utf-8')
print(json.dumps({'core_import':True,'native_query':True,'offline_export':True,'snapshot_id':snapshot}))
"""
    core_result = json.loads(run([str(python), "-c", core_check], directory, env))
    run([str(python), "-m", "pip", "install", "--no-index", "--find-links", str(wheels),
         str(artifacts[1])], directory, env)
    learning_check = """
import json
from pathlib import Path
import agentlineage_learning
from agentlineage_learning.api import Learning
assert 'site-packages' in agentlineage_learning.__file__
instructions=Path(agentlineage_learning.__file__).parent/'instructions'
assert (instructions/'AGENTLINEAGE.md').is_file()
assert (instructions/'migloop-build-cards'/'SKILL.md').is_file()
store=Learning('learning')
first=store.initialize()
assert Learning('learning').initialize()['revision']==first['revision']
triage={'scope':{'project_roots':['/project'],'generation_end':'2026-01-01T00:00:05Z',
 'observation_end':'2026-01-01T00:00:09Z'},'issues':[{'title':'Fixture gap',
 'changes':[{'files':['/project/file'],'change':'8 to 4','evidence':['native.jsonl:L5-L6']}]}]}
investigation=store.prepare('installed-roundtrip',['native.jsonl'],triage)
draft={'title':'Fixture gap','when':'Preserving constraints','description':'Synthetic installation test',
 'summary':'Observed mismatch','recommendations':['Preserve recorded gap'],'unknown':[],
 'graphs':[{'target':{'key':'/project/file','since':'2026-01-01T00:00:05Z','at':'2026-01-01T00:00:09Z'},
 'nodes':[{'key':'/project/spec','at':'2026-01-01T00:00:02Z','reason':'input'},
          {'key':'s:a','at':'2026-01-01T00:00:04Z','reason':'different value','problem':True}],
 'edges':[{'from':1,'to':2},{'from':2,'to':'target'}]}]}
packed=store.pack_case(investigation['id'],investigation['jobs'][0]['id'],draft)
assert packed['status']=='valid', packed
state=store.ingest([packed['path']],first['revision'])
store.apply_proposal({'base_revision':state['revision'],
 'topic_descriptions':{'code':'Coding constraints and observable changes'},'upsert':[{
 'title':'Preserve gap','topic':['code'],'when':'Layout implementation','why':'Observed mismatch',
 'how':['Preserve specified gap'],'status':'active',
 'evidence':[{'case':packed['case_id'],'revision':packed['revision'],'claim':'diagnosis'}]}]})
assert store.search('gap')['total']==1
store.export('knowledge')
print(json.dumps({'learning_import':True,'memory_restart':True,'packaged_instructions':True,
                  'installed_case_memory_roundtrip':True,'installed_memory_export':True}))
"""
    learning_result = json.loads(run([str(python), "-c", learning_check], directory, env))
    for component in components:
        module = "agentlineage_" + component
        output = json.loads(run([str(python), "-m", module + ".cli",
                                 "--data-dir", "state-" + module, "capabilities"], directory, env))
        assert output["package_version"] == versions[component]
    result = {"status": "passed", **core_result, **learning_result, "platform": sys.platform,
              "python": sys.version, "host_imports": False, "source_imports": False,
              "artifacts": [{"name": path.name,
                             "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
                            for path in artifacts]}
    destination = ROOT / "artifacts" / "installation-check.json"
    destination.parent.mkdir(exist_ok=True)
    destination.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        evidence = ROOT / "artifacts" / "installation-check.json"
        evidence.parent.mkdir(exist_ok=True)
        evidence.write_text(json.dumps({"status": "failed", "message": "See command log"}), encoding="utf-8")
        raise
