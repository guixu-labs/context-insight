from __future__ import annotations

import json
import pytest
from agentlineage_core.api import Core, CoreError
from agentlineage_core.observations import observations
from test_native_sources import deveco_bytes


def activity(**changes):
    return json.dumps({"schema": "agentlineage.host-activity/v1", "name": "Build a page",
        "status": "Paused", "started_at": "2026-01-01T00:00:00Z", "duration_ms": 2000,
        "cost_usd": 0.02, "trace": [{"name": "compile", "kind": "tool", "status": "error", "durationMs": 12}],
        "events": [{"id": "event.1", "observedAt": "2026-01-01T00:00:01Z", "kind": "output", "status": "ok", "message": {"role": "assistant", "text": "Historical answer"}}],
        "resources": [{"displayName": "Layout", "kind": "skill", "usage": {"readCount": 1, "invocationCount": 0}}],
        **changes}).encode()


def test_host_history_has_component_owned_logs_overview_and_persistence(tmp_path):
    core = Core(tmp_path)
    assert "agent-run-v1" in core.capabilities()["features"]
    source = core.upload_source(activity(), "activity.json", "host-activity")
    run = core.create_run("old-run")
    snap = core.create_snapshot(run["id"], [source["id"]])
    view = observations(Core(tmp_path), snap["id"], {"kind": "host-event"})
    assert view["records"][0]["text"] == "Historical answer"
    assert view["records"][0]["provider"] == "host"
    assert view["overview"]["origin"] == "host-history"
    assert view["overview"]["trace"][0]["status"] == "error"
    assert view["overview"]["resources"][0]["displayName"] == "Layout"
    assert view["coverage"]["semantic_verified"] is False
    assert source["sha256"] == view["records"][0]["evidence"]["sha256"]
    assert view["overview"]["usage"]["input_tokens"] is None


def test_native_and_host_records_are_separate_and_snapshot_stable(tmp_path):
    core = Core(tmp_path)
    run = core.create_run("mixed")
    native = core.upload_source(deveco_bytes())
    host = core.upload_source(activity(), "activity.json", "host-activity")
    snap = core.create_snapshot(run["id"], [native["id"], host["id"]])
    page = observations(core, snap["id"], {"limit": 1})
    assert page["overview"]["origin"] == "native"
    assert page["total"] == 6
    assert page["overview"]["tool_calls"] == 3
    assert len(page["overview"]["calls"]) == 3
    assert page["overview"]["calls"][0]["duration_ms"] == 1000
    assert observations(core, snap["id"], {"kind": "host-event"})["total"] == 1
    assert observations(core, snap["id"], {"record_id": page["records"][0]["id"]})["has_more"] is False
    changed = core.upload_source(activity(status="Completed"), "activity.json", "host-activity")
    second = core.create_snapshot(run["id"], [native["id"], changed["id"]])
    assert second["id"] != snap["id"]
    assert observations(core, snap["id"], {})["overview"]["status"] == "Paused"


def test_host_input_rejects_schema_and_does_not_accept_hidden_reasoning(tmp_path):
    core = Core(tmp_path)
    with pytest.raises(CoreError):
        core.upload_source(b'{"schema":"fake"}', "bad.json", "host-activity")
    source = core.upload_source(activity(events=[{"output": {"thinking": "PRIVATE", "authorization": "Bearer secret"}}]), "activity.json", "host-activity")
    snap = core.create_snapshot(core.create_run("safe")["id"], [source["id"]])
    page = observations(core, snap["id"], {})
    assert "PRIVATE" not in json.dumps(page)
    assert "Bearer secret" not in json.dumps(page)


def test_torn_native_tail_is_preserved_and_gap_is_explicit(tmp_path):
    core = Core(tmp_path)
    raw = b'{"type":"session_meta","payload":{"id":"thread","cwd":"/project"}}\n{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"prefix"}]}}\n{"type":'
    source = core.upload_source(raw, allow_partial=True)
    assert (core.root / "sources" / source["id"] / "raw").read_bytes() == raw
    snap = core.create_snapshot(core.create_run("torn")["id"], [source["id"]])
    page = observations(core, snap["id"], {})
    assert page["records"][0]["text"] == "prefix"
    assert page["records"][0]["evidence"]["pointer"] == "/lines/2"
    assert page["coverage"]["completeness"] == "partial"
    assert page["coverage"]["gaps"] == [{"code": "invalid-json", "line": 3}]


def test_foreign_deveco_parts_are_rejected(tmp_path):
    document = json.loads(deveco_bytes())
    document["messages"][0]["info"]["sessionID"] = "foreign"
    with pytest.raises(CoreError, match="Foreign"):
        Core(tmp_path).upload_source(json.dumps(document).encode())


def test_activity_filters_search_full_history_and_stable_record_identity(tmp_path):
    core = Core(tmp_path)
    run = core.create_run("logs")
    events = [{"id": str(i), "type": "tool.failed" if i == 1 else "text", "kind": "output",
               "spanId": "compile", "status": "error" if i == 1 else "ok", "detail": f"log {i}"} for i in range(350)]
    events[1]["detail"] = '{"number":9007199254740993,"text":"<script>needle</script>"}'
    source = core.upload_source(activity(events=events), "host.json", "host-activity")
    snap = core.create_snapshot(run["id"], [source["id"]])
    query = {"kind": "host-event", "event_type": "tool.failed", "source": "output", "span_id": "compile", "level": "error", "search": "NEEDLE"}
    result = observations(core, snap["id"], query)
    assert result["total"] == 1
    assert result["records"][0]["text"] == events[1]["detail"]
    assert result["activity_filters"]["types"] == ["text", "tool.failed"]
    assert result["overview"]["host_failed_stages"] == 1
    changed = core.upload_source(activity(events=events + [{"id": "new", "detail": "arrival"}]), "host.json", "host-activity")
    newer = core.create_snapshot(run["id"], [changed["id"]])
    assert observations(core, newer["id"], query)["records"][0]["id"] == result["records"][0]["id"]
    assert observations(core, snap["id"], {"offset": 100, "limit": 100})["total"] == 350
    assert observations(core, newer["id"], {"offset": 100, "limit": 100})["total"] == 351


def test_completion_only_events_do_not_fabricate_zero_duration(tmp_path):
    from test_native_sources import codex_bytes
    core = Core(tmp_path)
    source = core.upload_source(codex_bytes())
    snap = core.create_snapshot(core.create_run("completion-only")["id"], [source["id"]])
    page = observations(core, snap["id"], {})
    assert page["overview"]["calls"][0]["duration_ms"] is None
    assert page["overview"]["calls"][0]["timing"] == "completion-only"


def test_native_session_intervals_and_resource_usage_cross_child_sessions(tmp_path):
    core = Core(tmp_path)
    document = json.loads(deveco_bytes())
    document["info"]["parentID"] = "parent"
    tool = document["messages"][0]["parts"][0]
    tool["state"]["input"] = {"filePath": "C:/runtime/skills/layout/SKILL.md"}
    invocation = document["messages"][1]["parts"][0]
    invocation["tool"] = "skill"
    invocation["state"]["input"] = {"name": "layout"}
    script = document["messages"][2]["parts"][0]
    script["tool"] = "bash"
    script["state"]["input"] = {"command": 'python "C:\\runtime\\skills\\layout\\scripts\\check.py"'}
    resources = [{"id": "layout", "displayName": "layout", "kind": "skill", "native_paths": ["C:/runtime/skills/layout/SKILL.md"], "native_name": "layout", "native_root": "C:/runtime/skills/layout", "usage": {"readCount": 0, "invocationCount": 0}},
                 {"id": "unused", "displayName": "unused", "kind": "skill"}]
    native = core.upload_source(json.dumps(document).encode())
    host = core.upload_source(activity(resources=resources), "activity.json", "host-activity")
    snap = core.create_snapshot(core.create_run("native-usage")["id"], [native["id"], host["id"]])
    view = observations(core, snap["id"], {})["overview"]
    assert view["sessions"][0]["duration_ms"] == 6000
    assert view["sessions"][0]["timing"] == "observed-range"
    assert view["resources"][0]["usage"]["readCount"] == 1
    assert view["resources"][0]["usage"]["invocationCount"] == 2
    assert view["resources"][0]["usage"]["source"] == "native-session"
    assert len(view["resources"][0]["usage"]["observations"]) == 3
    assert view["resources"][1]["usage"]["source"] == "not-observed"
