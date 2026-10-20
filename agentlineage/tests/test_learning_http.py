from __future__ import annotations

import json
import threading
import time

import pytest

from agentlineage_learning.api import Learning
from agentlineage_learning.http import create_server
from agentlineage_learning.worker import Investigations
from conftest import claude_bytes
from test_core_http import request
from test_learning_roundtrip import triage
from test_worker import FakeExecutor, budget


@pytest.fixture
def learning_service(tmp_path):
    component = Learning(tmp_path)
    component.initialize()
    worker = Investigations(component, FakeExecutor())
    server = create_server(component, worker, token="test-token", publish_token="publish-token")
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_port}"
    server.shutdown()
    server.server_close()
    thread.join(5)


def test_learning_is_independently_served(learning_service):
    status, body, _ = request(learning_service, "/v1/capabilities")
    assert status == 200, body
    assert json.loads(body)["component"] == "agentlineage-learning"
    assert request(learning_service, "/v1/capabilities", token="wrong")[0] == 401
    assert request(learning_service, "/v1/memory/proposals",
                   {"base_revision": "wrong", "upsert": []})[0] == 403


def test_http_native_sources_to_draft_and_explicit_publication(learning_service):
    status, body, _ = request(learning_service, "/v1/sources?name=worker.jsonl",
                              claude_bytes(), raw=True)
    assert status == 201, body
    source = json.loads(body)
    payload = {"run_key": "http-task", "source_ids": [source["id"]],
               "triage": triage(), "budget": budget()}
    headers = {"Idempotency-Key": "one-investigation"}
    status, body, _ = request(learning_service, "/v1/investigations", payload, headers=headers)
    assert status == 202, body
    investigation = json.loads(body)
    _, again, _ = request(learning_service, "/v1/investigations", payload, headers=headers)
    assert json.loads(again)["id"] == investigation["id"]
    for _ in range(100):
        _, body, _ = request(learning_service, "/v1/investigations/" + investigation["id"])
        state = json.loads(body)
        if state["status"] not in ("queued", "running"):
            break
        time.sleep(0.02)
    assert state["status"] == "draft_ready", state
    assert state["cases"][0]["semantic_verified"] is False
    status, body, _ = request(learning_service, "/v1/investigations/query", {"run_key": "http-task"})
    assert status == 200 and json.loads(body)["items"][0]["id"] == investigation["id"]
    _, body, _ = request(learning_service, "/v1/investigations/query", {"run_key": "another-task"})
    assert json.loads(body)["items"] == []
    _, body, _ = request(learning_service, "/v1/investigations/" + investigation["id"] + "/cases")
    assert json.loads(body)["items"][0]["card"]["title"] == "Spacing mismatch"
    assert "path" not in state["cases"][0]
    _, body, _ = request(learning_service, "/v1/memory/revision")
    revision = json.loads(body)["revision"]
    assert request(learning_service, "/v1/cases/ingest", {
        "investigation_id": investigation["id"], "expected_revision": revision},
        token="publish-token")[0] == 200
    status, body, _ = request(learning_service, "/v1/memory/search", {"query": "spacing"})
    assert status == 200 and json.loads(body)["semantic_verified"] is False
