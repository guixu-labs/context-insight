"""Host execution facts supplement native conversations without impersonating them."""
from __future__ import annotations

import json
from typing import Any
from .observations import safe
from .inquiry.store import timestamp, iso
from .resource_usage import resource_usage


def validate_activity(document: Any) -> None:
    if not isinstance(document, dict) or document.get("schema") != "agentlineage.host-activity/v1":
        raise ValueError("Expected agentlineage.host-activity/v1")
    for key in ("events", "trace", "resources"):
        values = document.get(key, [])
        if not isinstance(values, list) or len(values) > 100000 or any(not isinstance(v, dict) for v in values):
            raise ValueError("Invalid activity collection: " + key)
    if not isinstance(document.get("name", ""), str):
        raise ValueError("Invalid activity name")


def materials(core, snapshot_id):
    snapshot = core.get_snapshot(snapshot_id)
    core._verify_snapshot(snapshot)
    for source in snapshot["sources"]:
        if source["format"] == "host-activity":
            yield source, json.loads((core.root / "sources" / source["id"] / "raw").read_text("utf-8"))


def activity_records(core, snapshot_id):
    for source, doc in materials(core, snapshot_id):
        for index, raw in enumerate(doc.get("events", [])):
            record = safe(raw)
            message = record.get("message") or {}
            text = message.get("text") or record.get("content") or record.get("detail") or record.get("output") or record.get("title") or ""
            if not isinstance(text, str):
                text = json.dumps(text, ensure_ascii=False)
            yield {"id": "host:event:" + str(record.get("id", record.get("sequence", index))), "kind": "host-event",
                   "session_id": record.get("sessionId") or doc.get("session_id") or "host",
                   "provider": "host", "role": message.get("role", "host"),
                   "timestamp": record.get("observedAt"), "text": text,
                   "event": record, "success": False if record.get("status") == "error" else None,
                   "evidence": {"ref": source["id"] + ":" + str(index), "source_id": source["id"],
                                "sha256": source["sha256"], "pointer": "/events/" + str(index),
                                "coordinate": "json-pointer"}}


def native_usage(core, snapshot_id):
    totals = {"input_tokens": None, "output_tokens": None, "cost_usd": None}
    for source in core.get_snapshot(snapshot_id)["sources"]:
        if source["format"] == "host-activity":
            continue
        raw = (core.root / "sources" / source["id"] / ("records.jsonl" if source["format"] in ("claude", "codex") else "raw")).read_text("utf-8-sig")
        values = []
        if source["format"] == "deveco" and source["projection"]:
            if raw.startswith("Exporting session:"):
                raw = raw.split("\n", 1)[1]
            for msg in json.loads(raw).get("messages", []):
                info = msg.get("info", {})
                if info.get("role") == "assistant":
                    tokens = info.get("tokens", {})
                    values.append((tokens.get("input"), tokens.get("output"), info.get("cost")))
        else:
            seen = set()
            for line in raw.splitlines():
                if not line.strip():
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if source["format"] == "claude":
                    message = row.get("message") or {}
                    usage = message.get("usage") or {}
                    key = message.get("id") or row.get("uuid")
                    if usage and key not in seen:
                        seen.add(key)
                        values.append((usage.get("input_tokens"), usage.get("output_tokens"), None))
                elif source["format"] == "codex":
                    payload = row.get("payload") or {}
                    info = payload.get("info") or {}
                    usage = info.get("total_token_usage") or {}
                    if payload.get("type") == "token_count" and usage:
                        values = [(usage.get("input_tokens"), usage.get("output_tokens"), None)]
        for item in values:
            for key, number in zip(totals, item):
                if type(number) in (int, float) and number >= 0:
                    totals[key] = (totals[key] or 0) + number
    return totals


def overview(core, snapshot_id, records):
    facts = list(materials(core, snapshot_id))
    doc = safe(facts[-1][1]) if facts else {}
    results = {(r["session_id"], r.get("call_id")): r for r in records if r["kind"] == "tool-result" and r.get("call_id")}
    calls = []
    session_times: dict[str, list[int]] = {}
    for record in records:
        at = timestamp(record.get("timestamp"))
        if at is not None:
            session_times.setdefault(record["session_id"], []).append(at)
    for record in records:
        if record["kind"] != "tool-call":
            continue
        result = results.get((record["session_id"], record.get("call_id")))
        start = timestamp(record.get("timestamp"))
        end = timestamp(result.get("timestamp")) if result else None
        completion_only = bool(result and record["evidence"]["ref"] == result["evidence"]["ref"])
        timing = "completion-only" if completion_only else "missing" if start is None or end is None else "invalid" if end < start else "same-timestamp" if end == start else "measured"
        calls.append({"id": record["id"], "session_id": record["session_id"],
                      "name": record.get("tool") or "Tool", "started_at": None if completion_only else record.get("timestamp"),
                      "ended_at": result.get("timestamp") if result else None, "timing": timing,
                      "duration_ms": (end - start) / 1000 if timing == "measured" else None,
                      "status": "failed" if result and result.get("success") is False else "completed" if result else "pending",
                      "evidence": record["evidence"], "request_id": record["id"], "result_id": result["id"] if result else None})
    usage = native_usage(core, snapshot_id)
    if usage["cost_usd"] is None and type(doc.get("cost_usd")) in (int, float):
        usage["cost_usd"] = doc["cost_usd"]
    return {"origin": "native" if records else "host-history", "name": doc.get("name"),
            "status": doc.get("status"), "started_at": doc.get("started_at"), "completed_at": doc.get("completed_at"),
            "duration_ms": doc.get("duration_ms"), "usage": usage,
            "sessions": [{"session_id": sid, "started_at": iso(min(times)), "ended_at": iso(max(times)),
                          "duration_ms": (max(times) - min(times)) / 1000 if max(times) > min(times) else None,
                          "timing": "observed-range"} for sid, times in session_times.items()],
            "tool_calls": len(calls), "failed_calls": sum(c["status"] == "failed" for c in calls),
            "calls": calls[:1000], "calls_truncated": len(calls) > 1000,
            "host_failed_stages": sum(t.get("status") == "error" for t in doc.get("trace", [])),
            "trace": doc.get("trace", []), "resources": resource_usage(doc.get("resources", []), records),
            "workflow": doc.get("workflow"), "warnings": doc.get("warnings", [])}
