from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]


def timestamp(second: int) -> str:
    return f"2026-01-01T00:00:{second:02d}Z"


def claude_bytes() -> bytes:
    rows = []
    for second, tool, arguments, reply in [
        (1, "Read", {"file_path": "/project/spec.md"}, "spacing=4"),
        (3, "Write", {"file_path": "/project/view.py", "content": "spacing=8\n"}, "ok"),
        (6, "Edit", {"file_path": "/project/view.py", "old_string": "spacing=8",
                     "new_string": "spacing=4"}, "ok"),
    ]:
        common = {"sessionId": "session-1", "agentId": "worker-1", "cwd": "/project"}
        rows.extend([
            {**common, "type": "assistant", "timestamp": timestamp(second), "message": {
                "model": "fixture-model", "content": [{"type": "tool_use", "id": str(second),
                "name": tool, "input": arguments}]}},
            {**common, "type": "user", "timestamp": timestamp(second + 1), "message": {
                "content": [{"type": "tool_result", "tool_use_id": str(second), "content": reply}]}},
        ])
    return ("\n".join(json.dumps(row) for row in rows) + "\n").encode()


@pytest.fixture
def native_pool(tmp_path):
    path = tmp_path / "worker.jsonl"
    path.write_bytes(claude_bytes())
    return path


def cli(*args: str):
    env = dict(os.environ)
    env["PYTHONPATH"] = str(ROOT / "components/core/src")
    env["PYTHONIOENCODING"] = "utf-8"
    return subprocess.run(
        [sys.executable, "-m", "agentlineage_core.cli", *map(str, args)],
        capture_output=True, text=True, encoding="utf-8", env=env, timeout=45,
    )
