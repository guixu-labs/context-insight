# Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
# This program is free software: you can redistribute it and/or modify it under the terms of
# CANN Open Software License Agreement Version 2.0 (the "License").
# Please refer to the License for details. You may not use this file except in compliance with the License.
# THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
# INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
# See LICENSE in the root of the software repository for the full text of the License.

"""Verify a packaged plugin in an isolated installed DSH Profile without a model."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import urllib.error
import urllib.request

DRIVER = r"""
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createAssistantMessage, createToolResultMessage } from LLM;
export const inject = ['tools', 'sessions', 'sessionQuery', 'fs', 'workingDirectory'];
export async function apply(ctx) {
  for (let i=0; i<600 && !ctx.tools.get('lineage_status'); i++) await delay(50);
  const visible=['lineage_query','lineage_open','lineage_check','lineage_import',
    'lineage_sessions','lineage_bind','lineage_status'].filter(n=>ctx.tools.get(n));
  assert.equal(visible.length,7);
  const session=ctx.sessions.create('packaged-task',{meta:{cwd:WORKSPACE}});
  let calls=0;
  const call=async(name,args={})=>{
    const result=await ctx.tools.execute({callId:'verify-'+(++calls),name,arguments:args,
      agent:{session,ctx},signal:AbortSignal.timeout(30000)});
    assert.equal(result.isError,false,JSON.stringify(result));
    return result.value;
  };
  const args={file_path:TARGET,content:'managed native task\n'};
  session.append('turn/start',{turn:1});
  session.append('step/start',{turn:1,step:1});
  session.append('assistant/message',{turn:1,step:1,stream:[],message:createAssistantMessage({
    content:[{type:'tool-call',id:'write-native',name:'write',arguments:JSON.stringify(args)}],
    source:{kind:'model',provider:'test-fixture',model:'keyless'}})},{surfaceOp:'append'});
  session.append('tool/call',{turn:1,step:1,callId:'write-native',name:'write',arguments:JSON.stringify(args)});
  const receipt=await ctx.tools.execute({callId:'write-native',name:'write',arguments:args,
    agent:{session,ctx},signal:AbortSignal.timeout(30000)});
  assert.equal(receipt.isError,false);
  session.append('tool/result',{turn:1,step:1,message:createToolResultMessage({
    callId:'write-native',content:receipt.content,isError:receipt.isError})},{surfaceOp:'append'});
  session.append('step/end',{turn:1,step:1});
  session.append('turn/end',{turn:1,reason:{kind:'completed'}});
  assert.equal(await readFile(TARGET,'utf8'),'managed native task\n');
  const query=await call('lineage_query',{path:TARGET});
  assert.equal(query.results[0].result.total,1);
  const initial=await call('lineage_status');
  assert.equal(initial.capabilities.package_version,'0.1.0a10');
  let historical=null;
  if (SAVED) {
    const imported=await call('lineage_import',{session_id:SAVED,include_children:false});
    assert.ok(imported.records>0);
    const answer=await call('lineage_query');
    assert.equal(answer.results[0].status,'ok');
    historical={status:'passed',records:imported.records,files:answer.results[0].result.total,
      input:'isolated copy of an existing native DSH v4 zstd session'};
    await call('lineage_import');
  }
  const failure=await ctx.tools.execute({callId:'missing',name:'lineage_open',
    arguments:{snapshot_id:'snap_'+'0'.repeat(64)},agent:{session,ctx},signal:AbortSignal.timeout(30000)});
  assert.equal(failure.isError,true);
  const final=await call('lineage_status');
  await writeFile(PROOF,JSON.stringify({status:'passed',visible,core_version:final.capabilities.package_version,
    core_url:final.core_url,current_session_auto_import:true,confirmed_writes:1,
    real_file_verified:true,missing_snapshot_refused:true,historical,model_called:false},null,2));
  setTimeout(()=>{
    void ctx.root.fiber.dispose().then(()=>process.exit(0),error=>{console.error(error);process.exit(1)});
  },200);
}
"""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dsh-cli", type=Path, required=True)
    parser.add_argument("--python", type=Path, required=True)
    parser.add_argument("--package", type=Path, required=True)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--saved-session", type=Path)
    args = parser.parse_args()
    root = args.directory.resolve()
    root.mkdir(parents=True, exist_ok=False)
    env = {key: value for key, value in os.environ.items() if key not in (
        "PYTHONPATH", "PYTHONHOME", "AGENTLINEAGE_TOKEN")}
    env["DSH_HOME"] = str(root / "dsh-home")
    env["AGENTLINEAGE_PYTHON"] = str(args.python.resolve())
    env["PYTHONIOENCODING"] = "utf-8"
    profile = root / "dsh-home" / "profiles" / "lineage-managed"
    cli = args.dsh_cli.resolve()
    command = ["node", str(cli), "plugin", "--profile", "lineage-managed", "add", str(args.package.resolve())]
    result = subprocess.run(command, env=env, capture_output=True, text=True, encoding="utf-8", timeout=120)
    (root / "install.log").write_text(result.stdout + result.stderr, encoding="utf-8")
    if result.returncode:
        raise RuntimeError("DSH package installation failed; see install.log")
    saved = None
    if args.saved_session:
        source = args.saved_session.resolve()
        if source.name != "session.v4.jsonl.zstd":
            raise ValueError("Choose one native DSH v4 zstd file")
        saved = source.parent.name
        destination = root / "dsh-home" / "sessions" / source.parent.parent.name / saved
        destination.mkdir(parents=True)
        shutil.copyfile(source, destination / source.name)
    proof = root / "profile.json"
    workspace = root / "workspace"
    workspace.mkdir()
    driver = DRIVER
    for key, value in {
        "LLM": (cli.parents[1] / "node_modules/@deepseek-ai/dsh-llm/lib/index.js").as_uri(),
        "WORKSPACE": str(workspace), "TARGET": str(workspace / "native.txt"),
        "SAVED": saved, "PROOF": str(proof),
    }.items():
        driver = driver.replace(key, json.dumps(value))
    (profile / "verify.mjs").write_text(driver, encoding="utf-8")
    (profile / "cordis.patch.yml").write_text(
        "- id: agentlineage\n  config:\n    mode: managed\n    pythonPath: "
        + json.dumps(str(args.python.resolve()))
        + "\n- insert:\n    - id: lineage-verify\n      name: "
        + json.dumps((profile / "verify.mjs").as_posix()) + "\n", encoding="utf-8")
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    result = subprocess.run(["node", str(cli), "--profile", "lineage-managed"], env=env,
                            capture_output=True, text=True, encoding="utf-8", timeout=60,
                            creationflags=flags)
    (root / "boot.log").write_text(result.stdout + result.stderr, encoding="utf-8")
    if result.returncode or not proof.exists():
        raise RuntimeError("DSH Profile verification failed; see boot.log")
    evidence = json.loads(proof.read_text(encoding="utf-8"))
    try:
        urllib.request.urlopen(evidence["core_url"] + "/health", timeout=2).close()
    except urllib.error.URLError:
        evidence["core_port_closed_after_profile_exit"] = True
    else:
        raise RuntimeError("Managed Core still responds after Profile exit")
    evidence["package"] = {"name": args.package.name,
                           "sha256": hashlib.sha256(args.package.read_bytes()).hexdigest()}
    evidence["python_source_imports"] = False
    identity = hashlib.sha256((profile.as_uri() + "/").encode()).hexdigest()[:20]
    state = root / "dsh-home" / "agentlineage" / identity
    if not (state / "core-token").is_file() or not (state / "bindings/managed/bindings.json").is_file():
        raise RuntimeError("Default Core state is not isolated by the Profile path")
    evidence["default_state_scoped_to_profile"] = True
    proof.write_text(json.dumps(evidence, indent=2), encoding="utf-8")
    print(json.dumps({"status": "passed", "proof": str(proof), "model_called": False}))


if __name__ == "__main__":
    main()
