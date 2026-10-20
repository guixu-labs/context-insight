from __future__ import annotations

import pytest
from agentlineage_core.api import CoreError
from agentlineage_core.observations import record_page


def test_anchor_finds_message_page_and_keeps_leading_tools():
    records = [{"id": "before", "kind": "tool-call"}]
    for n in range(205):
        records.extend([{"id": f"message-{n}", "kind": "message", "role": "assistant"},
                        {"id": f"tool-{n}", "kind": "tool-call"}])
    for anchor, offset in [("before", 0), ("message-100", 100), ("tool-99", 0), ("tool-104", 100), ("tool-204", 200)]:
        _, page = record_page(records, {"anchor_id": anchor, "page_unit": "messages", "limit": 100})
        assert page["offset"] == offset
    selected, page = record_page(records, {"anchor_id": "tool-104", "limit": 1})
    assert selected[0]["id"] == "tool-104"
    assert page["total"] == 411


@pytest.mark.parametrize("anchor", ["absent", "", 5])
def test_anchor_never_falls_back_to_an_unrelated_record(anchor):
    with pytest.raises(CoreError):
        record_page([{"id": "one", "kind": "tool-call"}], {"anchor_id": anchor})


def test_anchor_with_only_tools_and_transport_continuation():
    records = [{"id": str(n), "kind": "tool-call"} for n in range(45)]
    selected, page = record_page(records, {"anchor_id": "44", "page_unit": "messages", "record_offset": 40})
    assert page["offset"] == 0
    assert [r["id"] for r in selected] == ["40", "41", "42", "43", "44"]
