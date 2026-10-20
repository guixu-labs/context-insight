from __future__ import annotations
from agentlineage_core.resource_usage import resource_usage


def records(tool, args, success=True, session="s"):
    return [{"id": "request", "kind": "tool-call", "call_id": "call", "session_id": session,
             "tool": tool, "input": args, "timestamp": None, "evidence": {"ref": "source:1"}},
            {"id": "result", "kind": "tool-result", "call_id": "call", "session_id": session, "success": success}]


def test_native_usage_never_counts_denials_mentions_or_ambiguous_skill_names():
    resource = {"id": "a", "kind": "skill", "displayName": "layout", "native_root": "C:/skills/layout"}
    for events in [records("skill", {"name": "layout"}, False),
                   records("bash", {"command": 'echo "C:/skills/layout/run.py"'}),
                   records("read", {"filePath": "C:/skills/layout-other/SKILL.md"})]:
        assert resource_usage([resource], events)[0]["usage"]["source"] == "not-observed"
    ambiguous = resource_usage([resource, {**resource, "id": "b"}], records("skill", {"name": "layout"}))
    assert all(item["usage"]["source"] == "not-observed" for item in ambiguous)


def test_usage_deduplicates_repeated_events_but_keeps_independent_subagent_calls():
    resource = {"id": "a", "kind": "skill", "displayName": "layout"}
    events = records("skill", {"name": "layout"})
    result = resource_usage([resource], events + events + records("skill", {"name": "layout"}, session="child"))
    assert result[0]["usage"]["invocationCount"] == 2
    assert {item["session_id"] for item in result[0]["usage"]["observations"]} == {"s", "child"}
