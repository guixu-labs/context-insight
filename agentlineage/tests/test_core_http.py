from __future__ import annotations

import json
import threading
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest

from agentlineage_core.api import Core
from agentlineage_core.http import create_server
from conftest import claude_bytes, timestamp


@pytest.fixture
def service(tmp_path):
    server = create_server(Core(tmp_path), token="test-token")
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_port}"
    server.shutdown()
    server.server_close()
    thread.join(5)


def request(base, path, body=None, token="test-token", raw=False, headers=None):
    values = {"Authorization": "Bearer " + token, **(headers or {})}
    if body is not None and not raw:
        body = json.dumps(body).encode()
        values["Content-Type"] = "application/json"
    try:
        with urlopen(Request(base + path, data=body, headers=values), timeout=15) as response:
            return response.status, response.read(), response.headers
    except HTTPError as exc:
        return exc.code, exc.read(), exc.headers


def test_http_import_query_and_viewer(service):
    status, body, _ = request(service, "/v1/runs", {"external_key": "task", "project_id": "docs"})
    assert status == 201, body
    run = json.loads(body)
    status, body, _ = request(service, "/v1/sources?name=worker.jsonl", claude_bytes(), raw=True)
    assert status == 201, body
    source = json.loads(body)
    status, body, _ = request(service, f"/v1/runs/{run['id']}/snapshots", {"source_ids": [source["id"]]})
    assert status == 201, body
    snapshot = json.loads(body)
    status, body, _ = request(service, "/v1/query", {"snapshot_id": snapshot["id"], "requests": [
        {"op": "file", "key": "/project/view.py", "at": timestamp(9), "view": "relations"}]})
    assert status == 200, body
    assert json.loads(body)["results"][0]["result"]["total"] == 2
    status, body, _ = request(service, f"/v1/snapshots/{snapshot['id']}/viewer")
    assert status == 200 and b"__INQUIRY_CONFIG__" not in body
    assert b"test-token" not in body


def test_idempotency_rejects_reusing_a_key_for_different_input(service):
    headers = {"Idempotency-Key": "create-once"}
    first = request(service, "/v1/runs", {"external_key": "once"}, headers=headers)
    repeated = request(service, "/v1/runs", {"external_key": "once"}, headers=headers)
    assert first[:2] == repeated[:2]
    conflict = request(service, "/v1/runs", {"external_key": "different"}, headers=headers)
    assert conflict[0] == 409


def test_raw_source_idempotency_rejects_changed_material(service):
    headers = {"Idempotency-Key": "native-once"}
    first = request(service, "/v1/sources?name=worker.jsonl", claude_bytes(), raw=True,
                    headers=headers)
    repeated = request(service, "/v1/sources?name=worker.jsonl", claude_bytes(), raw=True,
                       headers=headers)
    changed = request(service, "/v1/sources?name=worker.jsonl",
                      claude_bytes().replace(b"spacing=8", b"spacing=9"), raw=True,
                      headers=headers)
    assert first[:2] == repeated[:2]
    assert changed[0] == 409


def test_viewer_login_uses_cookie_without_exposing_token(service):
    status, body, headers = request(service, "/login", {"token": "test-token"}, token="")
    assert status == 200, body
    cookie = headers["Set-Cookie"].split(";", 1)[0]
    assert "test-token" not in cookie
    assert request(service, "/v1/capabilities", token="", headers={"Cookie": cookie})[0] == 200


def test_wrong_token_and_cross_origin_writes_are_rejected(service):
    assert request(service, "/v1/capabilities", token="wrong")[0] == 401
    assert request(service, "/v1/runs", {"external_key": "x"},
                   headers={"Origin": "https://untrusted.example"})[0] == 403
