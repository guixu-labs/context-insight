# Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
# This program is free software: you can redistribute it and/or modify it under the terms of
# CANN Open Software License Agreement Version 2.0 (the "License").
# Please refer to the License for details. You may not use this file except in compliance with the License.
# THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
# INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
# See LICENSE in the root of the software repository for the full text of the License.

import base64
import json

import pytest

from test_core_http import request, service as service

BASE = 1767225600000


def native(session="dsh-parent", *, failed=False, ptc=False):
    header = {"type": "session", "version": 4, "id": session, "createdAt": BASE,
              "cwd": "/project", "isSeeded": False, "delegationDepth": 0}
    events = [
        {"type": "user/message", "data": {"role": "user", "content": [
            {"type": "text", "text": "Write a greeting"}], "source": {"kind": "user"}}},
        {"type": "tool/call", "data": {"turn": 0, "step": 0, "callId": "write-1",
            "name": "write", "arguments": json.dumps({"file_path": "/project/hello.txt", "content": "hello\n"})}},
        {"type": "tool/result", "data": {"turn": 0, "step": 0, "message": {
            "role": "tool", "toolCallId": "write-1", "isError": failed,
            "source": {"kind": "tool"}, "content": [{"type": "text", "text": "done"}]}}},
    ]
    if ptc:
        events[1] = {"type": "tool/ptc-dispatch-start", "data": {
            "rootCallId": "outer", "parentCallId": "outer", "subCallId": "inner",
            "name": "write", "arguments": {"file_path": "/project/hello.txt", "content": "hello\n"}}}
        events[2] = {"type": "tool/ptc-dispatch", "data": {
            **events[1]["data"], "isError": failed, "content": [{"type": "text", "text": "done"}]}}
    return [header] + [{**e, "seq": seq, "time": BASE + (seq + 1) * 1000}
                       for seq, e in enumerate(events)]


def encode(rows):
    return ("\n".join(json.dumps(row) for row in rows) + "\n").encode()


def imported(base, rows):
    raw = encode(rows)
    status, body, _ = request(base, "/v1/sources?name=session.v4.jsonl&format=dsh", raw, raw=True)
    assert status == 201, body
    source = json.loads(body)
    _, body, _ = request(base, "/v1/runs", {"external_key": rows[0]["id"]})
    run = json.loads(body)
    status, body, _ = request(base, f"/v1/runs/{run['id']}/snapshots", {"source_ids": [source["id"]]})
    assert status == 201, body
    return source, json.loads(body), raw


@pytest.mark.parametrize("ptc", [False, True])
def test_dsh_native_http_write_receipts_and_original_anchors(service, ptc):
    source, snap, raw = imported(service, native(ptc=ptc))
    status, body, _ = request(service, "/v1/lineage", {
        "snapshot_id": snap["id"], "path": "/project/hello.txt", "at": "2026-01-01T00:00:04Z"})
    result = json.loads(body)
    assert status == 200 and result["write_count"] == 1
    assert result["status"] == "replayed" and result["semantic_verified"] is False
    _, body, _ = request(service, "/v1/lineage", {
        "snapshot_id": snap["id"], "path": "/project/hello.txt", "at": "2026-01-01T00:00:02Z"})
    assert json.loads(body)["status"] == "not_observed"
    _, body, _ = request(service, f"/v1/sources/{source['id']}/content")
    assert base64.b64decode(json.loads(body)["content"]) == raw
    _, body, _ = request(service, f"/v1/snapshots/{snap['id']}/resolve", {
        "source_id": source["id"], "sha256": source["sha256"], "pointer": "/lines/3"})
    resolved = json.loads(body)
    assert resolved["status"] == "resolved"
    assert resolved["records"][0]["kind"] == "tool-call"
    _, body, _ = request(service, f"/v1/snapshots/{snap['id']}/observations", {"limit": 30})
    assert b"Write a greeting" in body


def test_dsh_failed_and_fork_inherited_writes_are_not_attributed(service):
    _, snap, _ = imported(service, native(failed=True))
    _, body, _ = request(service, "/v1/lineage", {
        "snapshot_id": snap["id"], "path": "/project/hello.txt", "at": "2026-01-01T00:00:09Z"})
    assert json.loads(body)["status"] == "not_observed"
    rows = native(session="child")
    rows[0].update(parentSession="dsh-parent", isSeeded=True, delegationDepth=1)
    rows.append({"type": "session/end-seed", "seq": 3, "time": BASE + 4000, "data": {"inherited": True}})
    _, snap, _ = imported(service, rows)
    _, body, _ = request(service, "/v1/lineage", {
        "snapshot_id": snap["id"], "path": "/project/hello.txt", "at": "2026-01-01T00:00:09Z"})
    assert json.loads(body)["write_count"] == 0


@pytest.mark.parametrize("change", ["version", "sequence", "seed", "timestamp", "tool", "receipt"])
def test_dsh_invalid_material_refused(service, change):
    rows = native()
    if change == "version":
        rows[0]["version"] = 5
    elif change == "sequence":
        rows[2]["seq"] = 88
    elif change == "seed":
        rows[0]["isSeeded"] = True
    elif change == "timestamp":
        rows[1]["time"] = 10**20
    elif change == "tool":
        rows[2]["data"]["name"] = None
    else:
        rows[3]["data"]["message"] = []
    status, _, _ = request(service, "/v1/sources?name=session.jsonl", encode(rows), raw=True)
    assert status == 422


def test_dsh_blank_lines_keep_original_coordinates_and_cwd_changes(service):
    rows = native()
    rows.insert(2, {"type": "working-directory/change", "data": {"cwd": "/different"},
                    "seq": 1, "time": BASE + 1500})
    rows[3]["seq"], rows[4]["seq"] = 2, 3
    rows[3]["data"]["arguments"] = json.dumps({"file_path": "hello.txt", "content": "hello"})
    rows.append({"type": "plugin:opaque/record", "seq": 4, "time": BASE + 5000, "data": ["opaque"]})
    raw = ("\n\n".join(json.dumps(row) for row in rows) + "\n").encode()
    status, body, _ = request(service, "/v1/sources?name=spaced.jsonl", raw, raw=True)
    assert status == 201, body
    source = json.loads(body)
    _, body, _ = request(service, "/v1/runs", {"external_key": "spaced"})
    run = json.loads(body)
    _, body, _ = request(service, f"/v1/runs/{run['id']}/snapshots", {"source_ids": [source["id"]]})
    snap = json.loads(body)
    _, body, _ = request(service, "/v1/lineage", {
        "snapshot_id": snap["id"], "path": "/different/hello.txt", "at": snap["at"]})
    assert json.loads(body)["write_count"] == 1
    _, body, _ = request(service, f"/v1/snapshots/{snap['id']}/resolve", {
        "source_id": source["id"], "sha256": source["sha256"], "pointer": "/lines/7"})
    assert json.loads(body)["records"][0]["kind"] == "tool-call"
