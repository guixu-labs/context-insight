from __future__ import annotations

import json

import pytest

from agentlineage_core.api import Core, CoreError
from agentlineage_core.observations import observations, create_repair, get_repair
from conftest import claude_bytes


def snapshot(core, raw, name="task"):
    source = core.upload_source(raw, name + ".jsonl")
    return core.create_snapshot(core.create_run(name)["id"], [source["id"]])


def test_messages_hide_reasoning_redact_credentials_and_open_full_evidence(tmp_path):
    core = Core(tmp_path)
    text = "public text " + "long payload " * 3000
    rows = [{"sessionId": "s", "type": "assistant", "message": {"role": "assistant", "content": [
        {"type": "thinking", "thinking": "private hidden reasoning"},
        {"type": "text", "text": text},
        {"type": "tool_use", "name": "request", "id": "call", "input": {
            "authorization": "Bearer very-secret-token", "password": "secret-value"}}]}}]
    snap = snapshot(core, json.dumps(rows[0]).encode())
    page = observations(core, snap["id"], {})
    assert page["total"] == 2
    assert "private hidden reasoning" not in json.dumps(page)
    assert "very-secret-token" not in json.dumps(page)
    assert "secret-value" not in json.dumps(page)
    record = page["records"][0]
    assert record["excerpted"] is True
    content, offset = "", 0
    while True:
        part = observations(core, snap["id"], {"record_id": record["id"], "text_offset": offset})
        content += part["text"]
        offset = part["next_offset"]
        if not part["has_more"]:
            break
    assert json.loads(content)["text"] == text
    with pytest.raises(CoreError):
        observations(core, snap["id"], {"record_id": "foreign"})


def test_frozen_pages_are_stable_after_new_snapshot_and_service_restart(tmp_path):
    core = Core(tmp_path)
    old = snapshot(core, claude_bytes())
    first = observations(core, old["id"], {"limit": 1})
    new = snapshot(core, claude_bytes().replace(b"spacing=8", b"spacing=9"))
    assert old["id"] != new["id"]
    restarted = Core(tmp_path)
    assert observations(restarted, old["id"], {"limit": 1}) == first
    repair = create_repair(core, {"baseline_snapshot_id": old["id"],
        "repair_snapshot_id": new["id"], "path": "/project/view.py", "issue": "spacing"})
    assert get_repair(restarted, repair["id"]) == repair
    source = old["sources"][0]
    (tmp_path / "sources" / source["id"] / "raw").write_bytes(b"tampered")
    with pytest.raises(CoreError, match="checksum"):
        get_repair(restarted, repair["id"])


def test_metadata_only_session_is_not_fabricated_as_conversation(tmp_path):
    core = Core(tmp_path)
    snap = snapshot(core, b'{"type":"session_meta","payload":{"id":"empty","cwd":"/p"}}')
    page = observations(core, snap["id"], {})
    assert page["records"] == []
    assert page["sessions"][0]["id"] == "empty"
    assert page["coverage"]["semantic_verified"] is False


def test_non_message_metadata_does_not_break_public_view(tmp_path):
    core = Core(tmp_path)
    raw = b'{"sessionId":"s","type":"system","message":null}\n' + b'{"sessionId":"s","type":"assistant","message":{"content":"visible"}}\n'
    raw = raw.replace(b"\\n", b"\n")
    snap = snapshot(core, raw)
    assert observations(core, snap["id"], {})["records"][0]["text"] == "visible"

def test_context_only_pages_skip_expensive_overview_without_losing_records(tmp_path, monkeypatch):
    core = Core(tmp_path)
    snap = snapshot(core, claude_bytes())
    original = observations(core, snap["id"], {})
    def unexpected(*args):
        raise AssertionError("Continuation must not recompute overview")
    monkeypatch.setattr("agentlineage_core.activity.overview", unexpected)
    context = observations(core, snap["id"], {"include_overview": False})
    assert "overview" not in context
    assert context["records"] == original["records"]
    assert context["sessions"] == original["sessions"]
    with pytest.raises(CoreError):
        observations(core, snap["id"], {"include_overview": "false"})


def test_history_projection_is_reused_but_source_integrity_is_checked(tmp_path, monkeypatch):
    core = Core(tmp_path)
    snap = snapshot(core, claude_bytes())
    original = observations(core, snap["id"], {})
    def unexpected(*args):
        raise AssertionError("Immutable history must not be reparsed per page")
    monkeypatch.setattr("agentlineage_core.observations._records", unexpected)
    assert observations(core, snap["id"], {}) == original
    source = snap["sources"][0]
    (tmp_path / "sources" / source["id"] / "raw").write_bytes(b"tampered")
    with pytest.raises(CoreError, match="checksum"):
        observations(core, snap["id"], {})


def test_byte_bounded_history_returns_entire_message_page_without_tiny_batches(tmp_path):
    core = Core(tmp_path)
    rows = []
    for n in range(101):
        rows.append({"sessionId": "s", "type": "assistant", "message": {"role": "assistant", "content": [
            {"type": "text", "text": str(n)},
            {"type": "tool_use", "name": "read", "id": str(n), "input": {"path": "/project/view.py"}}]}})
        rows.append({"sessionId": "s", "type": "user", "message": {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": str(n), "content": "中文" * 4096}]}})
    snap = snapshot(core, "\n".join(json.dumps(row, ensure_ascii=False) for row in rows).encode())
    query = {"page_unit": "messages", "limit": 100, "include_overview": False, "transport_bytes": 524288}
    records, chunks = [], 0
    while True:
        page = observations(core, snap["id"], query)
        assert len(json.dumps(page, ensure_ascii=False).encode()) < 2 * 1024 * 1024
        records.extend(page["records"])
        chunks += 1
        if page["next_record_offset"] is None:
            break
        query["record_offset"] = page["next_record_offset"]
    assert len(records) == 300
    assert len({r["id"] for r in records}) == 300
    assert chunks < 15
    assert sum(r["kind"] == "message" for r in records) == 100
    assert records[1]["pair"]["id"] == records[2]["id"]
    with pytest.raises(CoreError):
        observations(core, snap["id"], {"transport_bytes": True})


def test_projection_cache_is_bounded_and_does_not_share_mutable_api_results(tmp_path):
    core = Core(tmp_path)
    snaps = [snapshot(core, claude_bytes().replace(b"spacing=8", f"spacing={n}".encode()), str(n)) for n in range(10)]
    expected = observations(core, snaps[0]["id"], {})
    changed = observations(core, snaps[0]["id"], {})
    changed["records"][0]["evidence"]["ref"] = "corrupted-caller-copy"
    changed["sessions"][0]["id"] = "foreign"
    assert observations(core, snaps[0]["id"], {}) == expected
    for snap in snaps[1:]:
        observations(core, snap["id"], {"include_overview": False})
    assert len(core._observation_cache) == 8
    assert snaps[0]["id"] not in core._observation_cache
    assert observations(core, snaps[0]["id"], {}) == expected
