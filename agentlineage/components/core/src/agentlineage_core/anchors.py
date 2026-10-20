# Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
# This program is free software: you can redistribute it and/or modify it under the terms of
# CANN Open Software License Agreement Version 2.0 (the "License").
# Please refer to the License for details. You may not use this file except in compliance with the License.
# THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
# INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
# See LICENSE in the root of the software repository for the full text of the License.

from typing import Any

from .api import Core, CoreError
from .observations import _projection


def resolve_evidence(core: Core, snapshot_id: str, anchor: dict[str, Any]) -> dict[str, Any]:
    required = {"source_id", "sha256", "pointer"}
    if (set(anchor) - required - {"record_id"} or not required.issubset(anchor)
            or any(not isinstance(value, str) or not value or len(value) > 1024
                   for value in anchor.values())):
        raise CoreError("INVALID_ANCHOR", "Supply source_id, sha256, pointer and optional record_id")
    snapshot = core.get_snapshot(snapshot_id)
    core._verify_snapshot(snapshot)
    source = next((s for s in snapshot["sources"] if s["id"] == anchor["source_id"]), None)
    if source is None:
        raise CoreError("SOURCE_NOT_IN_SNAPSHOT", "Source does not belong to this snapshot", 404)
    if source["sha256"] != anchor["sha256"]:
        raise CoreError("SOURCE_DIGEST_MISMATCH", "Anchor refers to a different material version", 409)
    projection = _projection(core, snapshot)
    records = [r for r in projection["native"] + projection["host"]
               if r["evidence"]["source_id"] == anchor["source_id"]
               and r["evidence"]["pointer"] == anchor["pointer"]
               and ("record_id" not in anchor or r["id"] == anchor["record_id"])]
    return {
        "contract": "agentlineage.evidence-anchor/v1", "snapshot_id": snapshot_id,
        "status": "unresolved" if not records else "resolved" if len(records) == 1 else "ambiguous",
        "records": [{"record_id": r["id"], "kind": r["kind"], "session_id": r["session_id"],
                     "evidence": r["evidence"]} for r in records],
        "semantic_verified": False,
    }
