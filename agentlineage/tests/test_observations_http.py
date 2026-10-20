from __future__ import annotations

import json

import pytest

from test_core_http import request, service as _service
from test_native_sources import claude_bytes, codex_bytes, deveco_bytes

service = _service


def imported(service, raw, name):
    status, body, _ = request(service, "/v1/runs", {"external_key": name})
    assert status == 201
    run = json.loads(body)
    status, body, _ = request(service, "/v1/sources?name=" + name + ".jsonl", raw, raw=True)
    assert status == 201, body
    source = json.loads(body)
    status, body, _ = request(service, f"/v1/runs/{run['id']}/snapshots",
                              {"source_ids": [source["id"]]})
    assert status == 201, body
    return json.loads(body), source


@pytest.mark.parametrize(("raw", "provider"), [
    (claude_bytes, "claude"), (codex_bytes, "codex"), (deveco_bytes, "deveco"),
])
def test_observation_contract_filters_before_paging_and_preserves_native_refs(service, raw, provider):
    snapshot, source = imported(service, raw(), provider)
    status, body, _ = request(service, f"/v1/snapshots/{snapshot['id']}/observations",
                              {"limit": 1, "search": "spacing=4"})
    assert status == 200, body
    page = json.loads(body)
    assert page["contract"] == "agentlineage.observations/v1"
    assert page["snapshot_id"] == snapshot["id"]
    assert page["total"] >= 2 and len(page["records"]) == 1
    assert page["records"][0]["evidence"]["source_id"] == source["id"]
    assert page["records"][0]["evidence"]["sha256"] == source["sha256"]
    assert page["records"][0]["evidence"]["pointer"]
    assert page["coverage"]["semantic_verified"] is False
    assert page["files"] and page["sessions"]
    status, body, _ = request(service, f"/v1/sources/{source['id']}/content")
    assert status == 200 and json.loads(body)["sha256"] == source["sha256"]


def test_repair_chain_is_persisted_and_never_claims_semantic_cause(service):
    before, _ = imported(service, claude_bytes(), "before")
    after, _ = imported(service, claude_bytes().replace(b"session-1", b"repair-1"), "after")
    payload = {"baseline_snapshot_id": before["id"], "repair_snapshot_id": after["id"],
               "path": "/project/view.py", "issue": "spacing mismatch"}
    status, body, _ = request(service, "/v1/repairs", payload)
    assert status == 201, body
    repair = json.loads(body)
    assert repair["semantic_verified"] is False
    assert repair["before"]["observations"] and repair["after"]["observations"]
    assert repair["status"] == "evidence_ready"
    status, body, _ = request(service, "/v1/repairs/" + repair["id"])
    assert status == 200 and json.loads(body) == repair
    status, body, _ = request(service, f"/v1/runs/{after['run_id']}/repairs")
    assert status == 200 and json.loads(body)["items"][0]["id"] == repair["id"]


def test_observation_bad_cursor_and_foreign_evidence_are_rejected(service):
    snapshot, _ = imported(service, claude_bytes(), "invalid")
    status, _, _ = request(service, f"/v1/snapshots/{snapshot['id']}/observations",
                           {"offset": -1})
    assert status == 400
    status, _, _ = request(service, "/v1/repairs", {
        "baseline_snapshot_id": snapshot["id"], "repair_snapshot_id": snapshot["id"],
        "path": "/project/view.py", "issue": "same snapshot"})
    assert status == 400
    assert request(service, f"/v1/snapshots/{snapshot['id']}/observations",
                   {}, token="wrong")[0] == 401


@pytest.mark.parametrize(("raw", "provider"), [
    (claude_bytes, "claude"), (codex_bytes, "codex"), (deveco_bytes, "deveco"),
])
def test_record_anchor_returns_exact_call_pair_and_rejects_foreign_scope(service, raw, provider):
    snapshot, _ = imported(service, raw(), "anchor-" + provider)
    path = f"/v1/snapshots/{snapshot['id']}/observations"
    status, body, _ = request(service, path, {})
    assert status == 200
    call = next(r for r in json.loads(body)["records"] if r["kind"] == "tool-call")
    query = {"anchor_id": call["id"], "session_id": call["session_id"], "limit": 1}
    status, body, _ = request(service, path, query)
    result = json.loads(body)
    assert status == 200
    assert result["anchor_id"] == call["id"]
    assert result["records"][0]["id"] == call["id"]
    assert result["records"][0]["pair"]["kind"] == "tool-result"
    assert request(service, path, {**query, "session_id": "foreign-session"})[0] == 404
    assert request(service, path, {**query, "anchor_id": ""})[0] == 400
    assert request(service, path, {**query, "page_unit": "messages"})[0] == 200
