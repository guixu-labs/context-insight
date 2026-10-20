from __future__ import annotations

import base64
import json
import pytest
from agentlineage_core.api import Core, CoreError
from agentlineage_core.observations import observations


def setup(root):
    core = Core(root)
    assert "live-streams-v1" in core.capabilities()["features"]
    from agentlineage_core.streams import LiveStore
    live = LiveStore(core)
    run = core.create_run("tail")
    return core, live, run["id"]


def append(live, run, raw, offset=0, **changes):
    return live.append(run, {"key": "main", "format": "codex", "session_id": "thread",
        "offset": offset, "content": base64.b64encode(raw).decode(), **changes})


def message(text):
    return (json.dumps({"type": "response_item", "payload": {"type": "message",
        "role": "assistant", "content": [{"type": "output_text", "text": text}]}}, ensure_ascii=False) + "\n").encode()


HEADER = b'{"type":"session_meta","payload":{"id":"thread","cwd":"/project"}}\n'


def test_split_utf8_partial_line_retry_and_restart(tmp_path):
    core, live, run = setup(tmp_path)
    line = message("追尾输出")
    split = line.index("尾".encode()) + 1
    first = HEADER + line[:split]
    ack = append(live, run, first)
    assert ack["offset"] == len(first)
    assert live.query(run, {})["records"] == []
    assert append(live, run, first) == ack
    _, resumed, same_run = setup(tmp_path)
    assert same_run == run
    append(resumed, run, line[split:], len(first))
    view = resumed.query(run, {})
    assert [r["text"] for r in view["records"]] == ["追尾输出"]
    assert view["records"][0]["evidence"]["pointer"] == "/lines/2"
    assert live.query(run, {"after": view["cursor"]})["changes"] == []
    with core._db() as db:
        assert db.execute("SELECT COUNT(*) FROM snapshots").fetchone()[0] == 0


def test_conflicts_foreign_identity_and_invalid_complete_lines_are_atomic(tmp_path):
    _, live, run = setup(tmp_path)
    append(live, run, HEADER)
    for raw, offset in [(message("gap"), len(HEADER) + 1), (b"wrong", 0),
                        (b'{bad}\n', len(HEADER)),
                        (b'{"type":"session_meta","payload":{"id":"foreign"}}\n', len(HEADER))]:
        with pytest.raises(CoreError):
            append(live, run, raw, offset)
    assert live.state(run)["sources"][0]["offset"] == len(HEADER)
    assert live.query(run, {})["total"] == 0


def test_tail_beyond_first_page_and_cursor_catchup_without_duplicates(tmp_path):
    _, live, run = setup(tmp_path)
    raw = HEADER + b"".join(message(str(i)) for i in range(135))
    append(live, run, raw)
    first = live.query(run, {"limit": 30})
    assert [r["text"] for r in first["records"]] == [str(i) for i in range(120, 135)]
    assert first["total"] == 135
    append(live, run, message("last"), len(raw))
    changes = live.query(run, {"after": first["cursor"], "limit": 30})
    assert [c["record"]["text"] for c in changes["changes"]] == ["last"]
    ids, cursor = [], 0
    while True:
        batch = live.query(run, {"after": cursor, "limit": 19})
        ids.extend(c["id"] for c in batch["changes"])
        cursor = batch["cursor"]
        if not batch["has_more"]:
            break
    assert len(ids) == len(set(ids)) == 136
    with pytest.raises(CoreError):
        live.query(run, {"after": cursor + 1})


def doc(text):
    return {"info": {"id": "dev"}, "messages": [{"info": {"id": "m", "sessionID": "dev", "role": "assistant"},
        "parts": [{"id": "p", "messageID": "m", "sessionID": "dev", "type": "text", "text": text}]}]}


def upsert(live, run, value, revision=0):
    return live.upsert(run, {"key": "dev", "format": "deveco", "session_id": "dev",
        "revision": revision, **value})


def test_deveco_native_part_updates_replace_and_evidence_keeps_each_revision(tmp_path):
    _, live, run = setup(tmp_path)
    ack = upsert(live, run, doc("draft"))
    first = live.query(run, {})
    record = first["records"][0]
    assert upsert(live, run, doc("draft")) == ack
    ack2 = upsert(live, run, doc("finished"), ack["revision"])
    delta = live.query(run, {"after": first["cursor"]})
    assert delta["total"] == 1
    updated = delta["changes"][0]["record"]
    assert updated["id"] == record["id"]
    assert updated["text"] == "finished"
    old = live.query(run, {"record_id": record["id"], "revision": record["revision"]})
    assert "draft" in old["text"] and "finished" not in old["text"]
    filtered = live.query(run, {"after": first["cursor"], "search": "draft"})
    assert filtered["changes"][0]["op"] == "remove"
    assert ack2["revision"] > ack["revision"]
    with pytest.raises(CoreError):
        upsert(live, run, doc("stale"), 0)


def test_deveco_rejects_foreign_parts_and_tracks_removed_parts(tmp_path):
    _, live, run = setup(tmp_path)
    value = doc("keep")
    ack = upsert(live, run, value)
    before = live.query(run, {})
    value["messages"][0]["parts"][0]["sessionID"] = "foreign"
    with pytest.raises(CoreError):
        upsert(live, run, value, ack["revision"])
    assert live.query(run, {})["records"] == before["records"]
    value["messages"][0]["parts"] = []
    upsert(live, run, value, ack["revision"])
    assert live.query(run, {"after": before["cursor"]})["changes"][0]["op"] == "remove"


def test_freeze_preserves_original_bytes_and_old_snapshot(tmp_path):
    core, live, run = setup(tmp_path)
    raw = HEADER + message("before")
    append(live, run, raw)
    first = live.freeze(run, {"context": {"external_run_id": "host-run"}})
    assert observations(core, first["id"], {})["records"][0]["text"] == "before"
    assert (core.root / "sources" / first["sources"][0]["id"] / "raw").read_bytes() == raw
    append(live, run, message("after"), len(raw))
    second = live.freeze(run, {})
    assert second["id"] != first["id"]
    assert observations(core, first["id"], {})["total"] == 1
    assert observations(core, second["id"], {})["total"] == 2


def test_claude_host_and_cross_run_isolation(tmp_path):
    core, live, run = setup(tmp_path)
    raw = b'{"sessionId":"cc","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"answer"}]}}\n'
    append(live, run, raw, format="claude", session_id="cc")
    activity = {"schema": "agentlineage.host-activity/v1", "name": "Task", "status": "Running",
                "events": [{"id": "e", "detail": "output", "kind": "output"}]}
    live.upsert(run, {"key": "host", "format": "host-activity", "session_id": "host", "revision": 0, **activity})
    assert live.query(run, {})["total"] == 1
    assert live.query(run, {"kind": "host-event"})["records"][0]["text"] == "output"
    other = core.create_run("other")["id"]
    record = live.query(run, {})["records"][0]
    with pytest.raises(CoreError):
        live.query(other, {"record_id": record["id"], "revision": record["revision"]})
    assert live.query(other, {})["total"] == 0


def test_freeze_partial_utf8_keeps_raw_and_gap(tmp_path):
    core, live, run = setup(tmp_path)
    raw = HEADER + message("visible") + b'{"type":"response_item","text":"' + "尾".encode()[:1]
    append(live, run, raw)
    snap = live.freeze(run, {})
    assert observations(core, snap["id"], {})["records"][0]["text"] == "visible"
    assert any(g["code"] == "incomplete-utf8" for g in snap["gaps"])
    assert (core.root / "sources" / snap["sources"][0]["id"] / "raw").read_bytes() == raw


def test_tool_pair_survives_page_boundary_and_host_becomes_native(tmp_path):
    _, live, run = setup(tmp_path)
    host = {"key": "host", "format": "host-activity", "session_id": "host", "revision": 0,
            "schema": "agentlineage.host-activity/v1", "events": [{"id": "e", "detail": "starting"}]}
    live.upsert(run, host)
    before = live.query(run, {})
    assert before["origin"] == "host-history"
    request = {"type": "response_item", "payload": {"type": "function_call", "call_id": "call", "name": "exec_command", "arguments": "pwd"}}
    result = {"type": "response_item", "payload": {"type": "function_call_output", "call_id": "call", "output": "done"}}
    raw = HEADER + (json.dumps(request) + "\n" + json.dumps(result) + "\n").encode()
    append(live, run, raw)
    latest = live.query(run, {"limit": 1})
    assert latest["offset"] == 1
    assert latest["origin"] == "native"
    assert latest["records"][0]["kind"] == "tool-result"
    assert latest["records"][0]["pair"]["kind"] == "tool-call"
    pair = latest["records"][0]["pair"]
    assert live.query(run, {"record_id": pair["id"], "revision": pair["revision"], "content_only": True})["text"] == "pwd"


def test_http_auth_and_native_stream_restart_receipts(tmp_path):
    from urllib.request import Request, urlopen
    from urllib.error import HTTPError
    from agentlineage_core.http import create_server
    import threading
    core, _, run = setup(tmp_path)
    server = create_server(core, token="test-secret")
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_port}/v1/runs/{run}/live/"
    try:
        with pytest.raises(HTTPError) as error:
            urlopen(base + "state")
        assert error.value.code == 401
        headers = {"Authorization": "Bearer test-secret", "Content-Type": "application/json"}
        data = {"key": "main", "format": "codex", "session_id": "thread", "offset": 0,
                "content": base64.b64encode(HEADER + message("visible" )).decode()}
        with urlopen(Request(base + "append", data=json.dumps(data).encode(), headers=headers)) as response:
            assert response.status == 200
        with urlopen(Request(base + "query", data=b"{}", headers=headers)) as response:
            value = json.load(response)
            assert value["records"][0]["text"] == "visible"
        record = value["records"][0]
        body = {"record_id": record["id"], "revision": record["revision"], "content_only": True}
        with urlopen(Request(base + "query", data=json.dumps(body).encode(), headers=headers)) as response:
            assert json.load(response)["text"] == "visible"
        large = {"key": "dev", "format": "deveco", "session_id": "dev", "revision": 0,
                 "info": {"id": "dev"}, "messages": [{"info": {"id": "m", "sessionID": "dev", "role": "assistant"},
                 "parts": [{"id": "p", "messageID": "m", "sessionID": "dev", "type": "text", "text": "x" * (1024 * 1024)}]}]}
        with urlopen(Request(base + "upsert", data=json.dumps(large).encode(), headers=headers)) as response:
            assert json.load(response)["revision"] == 1
        foreign = {**headers, "Origin": "https://foreign.invalid"}
        with pytest.raises(HTTPError) as error:
            urlopen(Request(base + "append", data=json.dumps(data).encode(), headers=foreign))
        assert error.value.code == 403
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_message_pages_do_not_spend_slots_on_tools_and_transport_is_pinned(tmp_path):
    core, live, run = setup(tmp_path)
    chunks = [HEADER]
    for n in range(103):
        chunks.append(message(f"message-{n}"))
        for step in range(3):
            chunks.append((json.dumps({"type": "response_item", "payload": {
                "type": "function_call", "call_id": f"call-{n}-{step}", "name": "exec_command", "arguments": "pwd"}}) + "\n").encode())
    raw = b"".join(chunks)
    append(live, run, raw)
    latest = live.query(run, {"page_unit": "messages", "limit": 100})
    assert (latest["offset"], latest["end_offset"], latest["total"]) == (100, 103, 103)
    assert latest["page_record_count"] == 12
    assert [r["text"] for r in latest["records"] if r["kind"] == "message"] == [f"message-{n}" for n in range(100, 103)]
    snapshot = live.freeze(run, {})
    page = observations(core, snapshot["id"], {"page_unit": "messages", "limit": 100})
    assert (page["total"], page["end_offset"], page["next_offset"]) == (103, 100, 100)
    assert page["page_record_count"] == 400
    assert page["next_record_offset"] == 20
    second = observations(core, snapshot["id"], {"page_unit": "messages", "offset": 100, "limit": 100})
    assert len(second["records"]) == 12
    # Transport continuation is bound to the old revision even when a new tail arrives.
    first = live.query(run, {"page_unit": "messages", "limit": 100, "offset": 0})
    append(live, run, message("new tail"), offset=len(raw))
    continued = live.query(run, {"page_unit": "messages", "limit": 100, "offset": 0,
                                "at_cursor": first["cursor"], "record_offset": first["next_record_offset"]})
    assert continued["total"] == 103
    assert continued["records"][0]["text"] == "message-5"
    assert live.query(run, {"page_unit": "messages"})["total"] == 104


def test_native_session_names_are_preserved_redacted_and_snapshot_stable(tmp_path):
    core, live, run = setup(tmp_path)
    document = doc("body")
    document["info"]["title"] = "  编译检查 Bearer private-token  "
    ack = upsert(live, run, document)
    view = live.query(run, {})
    assert view["sessions"][0]["name"] == "编译检查 Bearer [REDACTED]"
    frozen = live.freeze(run, {})
    assert observations(core, frozen["id"], {})["sessions"][0]["name"] == "编译检查 Bearer [REDACTED]"
    document["info"]["title"] = "返修检查"
    upsert(live, run, document, ack["revision"])
    assert live.query(run, {})["sessions"][0]["name"] == "返修检查"
    assert observations(core, frozen["id"], {})["sessions"][0]["name"] == "编译检查 Bearer [REDACTED]"
    assert core.get_snapshot(frozen["id"])["run_id"] == run
