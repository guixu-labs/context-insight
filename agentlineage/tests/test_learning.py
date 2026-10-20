from __future__ import annotations

import json
import os
import subprocess
import sys

from conftest import ROOT


def learning_cli(*args):
    env = {**os.environ, "PYTHONPATH": os.pathsep.join([
        str(ROOT / "components/core/src"), str(ROOT / "components/learning/src")]),
        "PYTHONIOENCODING": "utf-8"}
    return subprocess.run([sys.executable, "-m", "agentlineage_learning.cli", *map(str, args)],
                          capture_output=True, text=True, encoding="utf-8", env=env, timeout=30)


def test_independent_learning_store_initializes_and_survives_restart(tmp_path):
    first = learning_cli("--data-dir", tmp_path, "init")
    assert first.returncode == 0, first.stdout + first.stderr
    revision = json.loads(first.stdout)["revision"]
    second = learning_cli("--data-dir", tmp_path, "init")
    assert second.returncode == 0
    assert json.loads(second.stdout)["revision"] == revision
