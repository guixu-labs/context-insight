from __future__ import annotations

import pytest

from agentlineage_core.api import Core
from agentlineage_core.lineage import replay_file
from conftest import timestamp


def test_file_lineage_uses_confirmed_native_writes(tmp_path, native_pool):
    core = Core(tmp_path / "state")
    snapshot = core.import_files("repair", [native_pool])["snapshot_id"]
    result = core.file_lineage(snapshot, "/project/view.py", timestamp(9))
    assert result["status"] == "replayed"
    assert result["write_count"] == 2 and result["broken"] is None
    assert result["semantic_verified"] is False
    assert result["observations"][0]["strength"] == "confirmed"
    before = core.file_lineage(snapshot, "/project/view.py", timestamp(1))
    assert before["status"] == "not_observed" and before["segments"] is None


@pytest.mark.parametrize(("events", "reason"), [
    ([("a", "edits", [("missing", "new", False)])], "no-baseline"),
    ([("a", "write", "one"), ("b", "edits", [("missing", "new", False)])], "edit-miss"),
    ([("a", "write", "one"), ("b", "opaque", None)], "opaque-write"),
])
def test_replay_breaks_on_incomplete_history(events, reason):
    result = replay_file(events)
    assert result["segments"] is None and result["broken"] == reason


def test_line_takeover_is_not_a_causal_claim():
    result = replay_file([("first", "write", "one\ntwo\nthree"),
                          ("fixer", "edits", [("two", "TWO", False)])])
    assert result["segments"] == [[1, 1, "first"], [2, 2, "fixer"], [3, 3, "first"]]
    assert result["takeovers"] == [{"by": "fixer", "lines": 1, "from": {"first": 1}}]
