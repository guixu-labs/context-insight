from __future__ import annotations

import json

import pytest

from agentlineage_core.api import Core, CoreError
from conftest import claude_bytes, timestamp


def codex_bytes() -> bytes:
    rows = [{"type": "session_meta", "timestamp": timestamp(0),
             "payload": {"id": "codex-1", "cwd": "/project"}}]
    for second, kind, item in [
        (2, "CommandExecution", {"id": "read-1", "status": "completed", "exit_code": 0,
            "cwd": "file:///project", "command": ["/bin/sh", "-c", "cat spec.md"],
            "parsed_cmd": [{"type": "read", "path": "spec.md"}], "stdout": "spacing=4", "stderr": ""}),
        (4, "FileChange", {"id": "write-1", "status": "completed",
            "changes": {"/project/view.py": {"type": "add", "content": "spacing=8"}}}),
        (7, "FileChange", {"id": "write-2", "status": "completed",
            "changes": {"/project/view.py": {"type": "update", "unified_diff": "-spacing=8\n+spacing=4"}}}),
    ]:
        rows.append({"type": "event_msg", "timestamp": timestamp(second), "payload": {
            "type": "item_completed", "thread_id": "codex-1", "item": {"type": kind, **item}}})
    return ("\n".join(json.dumps(row) for row in rows) + "\n").encode()


def deveco_bytes() -> bytes:
    messages = []
    for second, tool, arguments, output in [
        (1, "read", {"filePath": "/project/spec.md"}, "spacing=4"),
        (3, "write", {"filePath": "/project/view.py", "content": "spacing=8"}, "ok"),
        (6, "edit", {"filePath": "/project/view.py", "oldString": "spacing=8",
                      "newString": "spacing=4"}, "ok"),
    ]:
        messages.append({"info": {"id": f"msg_{second}", "role": "assistant", "modelID": "fixture"},
                         "parts": [{"id": f"part_{second}", "type": "tool", "tool": tool,
                         "callID": f"call_{second}", "state": {"status": "completed",
                         "input": arguments, "output": output, "time": {
                         "start": 1767225600000 + second * 1000,
                         "end": 1767225600000 + (second + 1) * 1000}}}]})
    return json.dumps({"info": {"id": "ses_1", "directory": "/project"},
                       "messages": messages}).encode()


@pytest.mark.parametrize(("raw", "platform"), [
    (claude_bytes, "claude"), (codex_bytes, "codex"), (deveco_bytes, "deveco"),
])
def test_three_native_formats_preserve_writes_and_time_cutoffs(tmp_path, raw, platform):
    core = Core(tmp_path)
    run = core.create_run("task")
    source = core.upload_source(raw())
    assert source["format"] == platform
    snapshot = core.create_snapshot(run["id"], [source["id"]])
    assert snapshot["completeness"] == "unknown"
    query = {"op": "file", "key": "/project/view.py", "at": timestamp(9), "view": "relations"}
    after = core.query(snapshot["id"], query)["result"]
    assert len(after["rows"]) == 2
    assert all(row["strength"] == "confirmed" for row in after["rows"])
    before = core.query(snapshot["id"], {**query, "at": timestamp(1)})["result"]
    assert before["total"] == 0


def test_tampered_frozen_material_is_rejected(tmp_path):
    core = Core(tmp_path)
    source = core.upload_source(claude_bytes())
    run = core.create_run("task")
    snapshot = core.create_snapshot(run["id"], [source["id"]])
    (tmp_path / "sources" / source["id"] / "raw").write_bytes(b"tampered")
    with pytest.raises(CoreError, match="checksum"):
        core.query(snapshot["id"], {"op": "catalog", "kind": "file"})


@pytest.mark.parametrize("name", ["../session.jsonl", "/tmp/session.jsonl", "x\\session.jsonl"])
def test_import_never_accepts_remote_filesystem_paths(tmp_path, name):
    with pytest.raises(CoreError, match="basename"):
        Core(tmp_path).upload_source(claude_bytes(), name)


def test_unknown_or_malformed_input_is_not_silently_analyzed(tmp_path):
    core = Core(tmp_path)
    for body in [b'{"hello":"world"}', claude_bytes() + b'{"broken"', b""]:
        with pytest.raises(CoreError):
            core.upload_source(body)


def test_report_validation_does_not_certify_causality(tmp_path):
    core = Core(tmp_path)
    source = core.upload_source(claude_bytes())
    run = core.create_run("task")
    snapshot = core.create_snapshot(run["id"], [source["id"]])
    draft = {
        "target": {"key": "/project/view.py", "at": timestamp(9)},
        "summary": "Synthetic repair explanation", "recommendations": ["Read the specification"],
        "nodes": [{"key": "/project/spec.md", "at": timestamp(2), "reason": "input"},
                  {"key": "session-1:worker-1", "at": timestamp(4),
                   "reason": "different value", "problem": True}],
        "edges": [{"from": 1, "to": 2}, {"from": 2, "to": "target"}],
    }
    report = core.check_report(snapshot["id"], draft, save=True)
    assert report["mechanical_status"] == "valid", report
    assert report["semantic_verified"] is False
    loaded = core.get_report(snapshot["id"], report["report_id"])
    assert loaded["semantic_verified"] is False
