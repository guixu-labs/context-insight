"""Rebuildable observation views over native evidence; no host transcript dependency."""
from __future__ import annotations

import base64
import copy
import json
import re
from typing import Any, TYPE_CHECKING

from .inquiry.source_adapters import adapter_for
from .inquiry.store import iso

if TYPE_CHECKING:
    from .api import Core

CONTRACT = "agentlineage.observations/v1"


def safe(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(k): "[REDACTED]" if re.search(
            r"(?i)^(thinking|reasoning|reasoning_content|encrypted_content|signature|system_prompt|system_instructions|authorization|api[_-]?key|access[_-]?token|password|secret)$", str(k))
            else safe(v) for k, v in value.items()}
    if isinstance(value, list):
        return [safe(v) for v in value]
    if isinstance(value, str):
        value = re.sub(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+", "Bearer [REDACTED]", value)
        value = re.sub(r"\bsk-[A-Za-z0-9_-]{12,}", "[REDACTED]", value)
        return re.sub(r"(?i)\b(api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*[^\s,;]+",
                      r"\1=[REDACTED]", value)
    return value


def session_name(info: dict[str, Any]) -> str | None:
    title = info.get("title")
    return " ".join(safe(title).split())[:256] or None if isinstance(title, str) else None


def _text_parts(row: dict[str, Any]):
    adapter = adapter_for(row)
    if adapter is None:
        return
    if adapter.name == "dsh":
        native = row["record"]
        if native["type"] not in ("user/message", "assistant/message", "system/message", "developer/message"):
            return
        data = native.get("data", {})
        message = data.get("message", data)
        for slot, block in enumerate(message.get("content", [])):
            if isinstance(block, dict) and block.get("type") == "text":
                yield slot, message.get("role"), block.get("text", "")
        return
    if adapter.name == "deveco":
        part, message = row.get("part", {}), row.get("message", {})
        if row.get("phase") == "message" and part.get("type") == "text":
            yield 0, message.get("role"), part.get("text", "")
        return
    message = row.get("message", {}) if adapter.name == "claude" else row.get("payload", {})
    if not isinstance(message, dict):
        return
    if adapter.name == "codex" and (
        row.get("type") != "response_item" or message.get("type") != "message"
    ):
        return
    role, content = message.get("role", row.get("type")), message.get("content")
    if role not in ("assistant", "user", "system", "developer"):
        return
    if isinstance(content, str):
        yield 0, role, content
    elif isinstance(content, list):
        for slot, block in enumerate(content):
            if isinstance(block, dict) and block.get("type") in ("text", "input_text", "output_text"):
                yield slot, role, block.get("text", "")


def _records(core: Core, snapshot_id: str):
    snapshot = core.get_snapshot(snapshot_id)
    with core.evidence(snapshot_id) as engine:
        source_map = {f"{i:03d}-{s['name']}": s for i, s in enumerate(snapshot["sources"])}
        pointers = {}
        for source in snapshot["sources"]:
            if source["projection"] == "deveco-native-export/1":
                raw = (core.root / "sources" / source["id"] / "raw").read_text("utf-8-sig")
                if raw.startswith("Exporting session:"):
                    raw = raw.split("\n", 1)[1]
                doc = json.loads(raw)
                for mi, msg in enumerate(doc["messages"]):
                    for pi, part in enumerate(msg.get("parts", [])):
                        pointers[(source["id"], msg["info"]["id"], part["id"])] = (
                            f"/messages/{mi}/parts/{pi}")
        rows = engine.store.rows(
            "SELECT r.ref,r.line,r.at,s.name,s.agent,m.platform,m.parent "
            "FROM records r JOIN sources s ON r.source=s.id "
            "JOIN source_metadata m ON s.id=m.source ORDER BY r.at,r.source,r.line")
        for meta in rows:
            _, raw = engine.store.source_record(meta["ref"])
            if not raw.strip():
                continue
            row = json.loads(raw)
            source = source_map[meta["name"]]
            origin = row.get("origin", {})
            pointer = pointers.get((source["id"], origin.get("message"), origin.get("part")),
                                   "/lines/" + str(meta["line"]))
            evidence = {"ref": meta["ref"], "source_id": source["id"],
                        "sha256": source["sha256"], "pointer": pointer,
                        "coordinate": "json-pointer" if source["projection"] == "deveco-native-export/1" else "jsonl-line"}
            base = {"session_id": meta["agent"], "provider": meta["platform"],
                    "parent_session_id": meta["parent"], "timestamp": iso(meta["at"]),
                    "evidence": evidence}
            yield from project_record(row, meta["ref"], base)


def project_record(row: dict[str, Any], ref: str, base: dict[str, Any]):
    """Project one native record identically in live and frozen observations."""
    for slot, role, text in _text_parts(row):
        yield {**base, "id": ref + f":message:{slot}",
               "kind": "message", "role": role, "text": safe(text)}
    adapter = adapter_for(row)
    for slot, _, phase, cid, tool, payload, success in adapter.parts(row) if adapter else ():
        kind = "tool-call" if phase in ("request", "patch") else "tool-result"
        item = {**base, "id": ref + f":{kind}:{slot}", "kind": kind,
                "call_id": cid, "tool": tool, "slot": slot,
                "input" if kind == "tool-call" else "output": safe(payload)}
        if success is not None:
            item["success"] = bool(success)
        yield item


def _projection(core: Core, snapshot: dict[str, Any]) -> dict[str, Any]:
    from .api import encoded
    snapshot_id = snapshot["id"]
    with core._observation_lock:
        cached = core._observation_cache.get(snapshot_id)
        if cached:
            core._observation_cache.move_to_end(snapshot_id)
            return cached[0]
        projection = _build_projection(core, snapshot)
        weight = len(encoded(projection).encode("utf-8"))
        if weight <= 32 * 1024 * 1024:
            core._observation_cache[snapshot_id] = (projection, weight)
            while len(core._observation_cache) > 8 or sum(v[1] for v in core._observation_cache.values()) > 32 * 1024 * 1024:
                core._observation_cache.popitem(last=False)
        return projection


def _build_projection(core: Core, snapshot: dict[str, Any]) -> dict[str, Any]:
    snapshot_id = snapshot["id"]
    native_records = list(_records(core, snapshot_id))
    names = {(r["session_id"], r.get("call_id")): r.get("tool") for r in native_records if r["kind"] == "tool-call" and r.get("call_id")}
    for record in native_records:
        if record["kind"] == "tool-result" and not record.get("tool"):
            record["tool"] = names.get((record["session_id"], record.get("call_id")), "")
    from .activity import activity_records
    host_records = list(activity_records(core, snapshot_id))
    with core.evidence(snapshot_id) as engine:
        sessions = engine.store.rows(
            "SELECT s.agent AS id,m.platform AS provider,m.parent AS parent_id "
            "FROM sources s JOIN source_metadata m ON s.id=m.source ORDER BY s.name")
        files = engine.store.rows(
            "SELECT path,COUNT(*) AS observations,"
            "SUM(CASE WHEN op='write' AND strength='confirmed' THEN 1 ELSE 0 END) AS confirmed_writes "
            "FROM effects GROUP BY path ORDER BY path LIMIT 500")
    names = {}
    for source in snapshot["sources"]:
        if source["projection"] == "deveco-native-export/1":
            raw = (core.root / "sources" / source["id"] / "raw").read_text("utf-8-sig")
            if raw.startswith("Exporting session:"):
                raw = raw.split("\n", 1)[1]
            info = json.loads(raw)["info"]
            names[info["id"]] = session_name(info)
    sessions = [{**session, "name": names.get(session["id"])} for session in sessions]
    return {"native": native_records, "host": host_records, "sessions": sessions, "files": files}


def observations(core: Core, snapshot_id: str, query: dict[str, Any]) -> dict[str, Any]:
    from .api import CoreError, encoded
    if set(query) - {"offset", "limit", "kind", "search", "session_id", "record_id",
                     "text_offset", "text_limit", "content_only", "span_id", "level", "event_type", "source", "page_unit", "record_offset", "anchor_id", "include_overview", "transport_bytes"}:
        raise CoreError("INVALID_QUERY", "Unknown observation query field")
    offset, limit = query.get("offset", 0), query.get("limit", 50)
    search, kind, session = query.get("search", ""), query.get("kind"), query.get("session_id")
    if (type(offset) is not int or not 0 <= offset <= 1_000_000
        or type(limit) is not int or not 1 <= limit <= 100
        or not isinstance(search, str) or len(search) > 500
        or kind not in (None, "message", "tool-call", "tool-result", "host-event")
        or session is not None and not isinstance(session, str)):
        raise CoreError("INVALID_QUERY", "Invalid observation query")
    if query.get("level") not in (None, "info", "warn", "error") or any(k in query and (not isinstance(query[k], str) or len(query[k]) > 300) for k in ("span_id", "event_type", "source")):
        raise CoreError("INVALID_QUERY", "Invalid activity filter")
    if type(query.get("include_overview", True)) is not bool:
        raise CoreError("INVALID_QUERY", "Invalid overview option")
    budget = query.get("transport_bytes")
    if budget is not None and (type(budget) is not int or not 65536 <= budget <= 1048576):
        raise CoreError("INVALID_QUERY", "Invalid transport byte budget")
    snapshot = core.get_snapshot(snapshot_id)
    core._verify_snapshot(snapshot)
    projection = _projection(core, snapshot)
    native_records, host_records = projection["native"], projection["host"]
    records = native_records + host_records if query.get("record_id") else (
        host_records if kind == "host-event" or not native_records else native_records)
    if query.get("record_id") is not None:
        record = next((r for r in records if r["id"] == query["record_id"]), None)
        if record is None:
            raise CoreError("NOT_FOUND", "Evidence record does not belong to snapshot", 404)
        start, size = query.get("text_offset", 0), query.get("text_limit", 16384)
        if (type(start) is not int or start < 0 or type(size) is not int
            or not 1 <= size <= 32768):
            raise CoreError("INVALID_QUERY", "Invalid evidence text cursor")
        if type(query.get("content_only", False)) is not bool:
            raise CoreError("INVALID_QUERY", "Invalid content query")
        visible = record.get("text", record.get("input", record.get("output", "")))
        content = (visible if isinstance(visible, str) else encoded(visible)) if query.get("content_only") else encoded(record)
        return {"contract": CONTRACT, "snapshot_id": snapshot_id, "record_id": record["id"],
                "evidence": record["evidence"], "text": content[start:start + size],
                "offset": start, "next_offset": min(start + size, len(content)),
                "total_characters": len(content), "has_more": start + size < len(content)}
    matches = [r for r in records if (not kind or r["kind"] == kind)
               and (not session or r["session_id"] == session)
               and (not search or search.casefold() in encoded(r).casefold())
               and (not query.get("span_id") or r.get("event", {}).get("spanId") == query["span_id"])
               and (not query.get("event_type") or r.get("event", {}).get("type") == query["event_type"])
               and (not query.get("source") or r.get("event", {}).get("kind", "event") == query["source"])
               and (not query.get("level") or (r.get("event", {}).get("level") or ("error" if r.get("event", {}).get("status") == "error" else "info")) == query["level"])]
    by_call = {(r["session_id"], r.get("call_id"), r["kind"]): r for r in native_records if r.get("call_id")}
    selected, paging = record_page(matches, query, transport_size=1000 if budget else None)
    items: list[dict[str, Any]] = []
    size = 0
    for record in selected:
        item = public_record(record, by_call)
        weight = len(encoded(item).encode("utf-8")) + 1
        if budget and items and size + weight > budget:
            break
        items.append(item)
        size += weight
    position = paging["record_offset"] + len(items)
    paging["next_record_offset"] = position if position < paging["page_record_count"] else None
    from .activity import overview
    return {"contract": CONTRACT, "snapshot_id": snapshot_id, "records": items,
            **paging,
            "sessions": copy.deepcopy(projection["sessions"]), "files": copy.deepcopy(projection["files"]),
            **({"overview": overview(core, snapshot_id, native_records)} if query.get("include_overview", True) else {}),
            "sources": snapshot["sources"],
            "activity_filters": {"types": sorted({str(r["event"]["type"]) for r in host_records if r["event"].get("type")}),
                                 "sources": sorted({str(r["event"].get("kind", "event")) for r in host_records})},
            "coverage": {"completeness": snapshot["completeness"], "gaps": snapshot["gaps"],
                         "semantic_verified": False, "native_records": snapshot["records"],
                         "visible_records": len(records)}}



def record_page(records, query, latest=False, *, transport_size=None):
    from .api import CoreError
    unit = query.get("page_unit", "records")
    start = query.get("record_offset", 0)
    if unit not in ("records", "messages") or type(start) is not int or start < 0:
        raise CoreError("INVALID_QUERY", "Invalid page unit or transport offset")
    limit = query.get("limit", 100 if latest else 50)
    boundaries = [i for i, record in enumerate(records) if record["kind"] == "message"
                  and record.get("role") in ("user", "assistant")] if unit == "messages" else list(range(len(records)))
    total = len(boundaries)
    offset = query.get("offset", max(0, (total - 1) // limit) * limit if latest else 0)
    if type(offset) is not int or not 0 <= offset <= 1_000_000:
        raise CoreError("INVALID_QUERY", "Invalid page offset")
    if "anchor_id" in query:
        anchor = query["anchor_id"]
        if not isinstance(anchor, str) or not 1 <= len(anchor) <= 300:
            raise CoreError("INVALID_QUERY", "Invalid record anchor")
        index = next((i for i, record in enumerate(records) if record["id"] == anchor), None)
        if index is None:
            raise CoreError("NOT_FOUND", "Record anchor does not belong to this query", 404)
        from bisect import bisect_right
        offset = max(0, bisect_right(boundaries, index) - 1) // limit * limit
    first = 0 if offset == 0 else boundaries[offset] if offset < total else len(records)
    last = boundaries[offset + limit] if offset + limit < total else len(records)
    window = records[first:last]
    size = (transport_size or 20) if unit == "messages" else limit
    if start > len(window):
        raise CoreError("INVALID_QUERY", "Transport offset exceeds page")
    return window[start:start + size], {
        "page_unit": unit, "offset": offset, "limit": limit, "total": total,
        **({"anchor_id": query["anchor_id"]} if "anchor_id" in query else {}),
        "end_offset": min(offset + limit, total),
        "next_offset": offset + limit if offset + limit < total else None,
        "record_offset": start, "next_record_offset": start + size if start + size < len(window) else None,
        "page_record_count": len(window), "first_record_id": window[0]["id"] if window else None,
    }


def public_record(record, by_call=None):
    from .api import encoded
    summary = {k: v for k, v in record.items() if k not in ("text", "input", "output", "event")}
    visible = record.get("text", record.get("input", record.get("output", "")))
    summary.update(text=(visible if isinstance(visible, str) else encoded(visible))[:8192],
                   excerpted=len(encoded(record)) > 8192)
    if by_call and record.get("call_id") and record["kind"] in ("tool-call", "tool-result"):
        other_kind = "tool-result" if record["kind"] == "tool-call" else "tool-call"
        pair = by_call.get((record["session_id"], record["call_id"], other_kind))
        if pair:
            summary["pair"] = public_record(pair)
    return copy.deepcopy(summary)



def source_content(core: Core, source_id: str) -> dict[str, Any]:
    from .api import CoreError, digest
    source = core._read("source", source_id)
    raw = (core.root / "sources" / source_id / "raw").read_bytes()
    if digest(raw) != source["sha256"]:
        raise CoreError("SOURCE_TAMPERED", "Immutable source checksum mismatch", 409)
    return {**source, "encoding": "base64", "content": base64.b64encode(raw).decode("ascii")}


def create_repair(core: Core, data: dict[str, Any]) -> dict[str, Any]:
    from .api import CoreError, digest, encoded
    if set(data) != {"baseline_snapshot_id", "repair_snapshot_id", "path", "issue"}:
        raise CoreError("INVALID_REPAIR", "Repair requires two snapshots, a file and an issue")
    path, issue = data["path"], data["issue"]
    if (not isinstance(path, str) or not 1 <= len(path) <= 4096
        or not isinstance(issue, str) or not 1 <= len(issue.strip()) <= 8000):
        raise CoreError("INVALID_REPAIR", "Invalid repair file or issue")
    baseline, repaired = (core.get_snapshot(data[k]) for k in
                          ("baseline_snapshot_id", "repair_snapshot_id"))
    if baseline["id"] == repaired["id"]:
        raise CoreError("INVALID_REPAIR", "Two distinct snapshots are required")
    if core.get_run(baseline["run_id"])["project_id"] != core.get_run(repaired["run_id"])["project_id"]:
        raise CoreError("INVALID_REPAIR", "Snapshots must belong to the same evidence workspace")
    before = core.file_lineage(baseline["id"], path, baseline["at"])
    after = core.file_lineage(repaired["id"], path, repaired["at"])
    repair = {"id": "repair_" + digest(encoded(data).encode()), **safe(data),
              "baseline_run_id": baseline["run_id"], "repair_run_id": repaired["run_id"],
              "baseline_context": baseline.get("context", {}),
              "repair_context": repaired.get("context", {}),
              "baseline_sources": baseline["sources"], "repair_sources": repaired["sources"],
              "generation_end": baseline["at"], "observation_end": repaired["at"],
              "before": safe(before), "after": safe(after), "semantic_verified": False,
              "status": "evidence_ready" if before["observations"] and after["observations"]
                        else "insufficient_evidence",
              "limitation": "Recorded writes and handoffs are evidence, not proof of defect cause or repair success."}
    with core._db() as db:
        db.execute("INSERT OR IGNORE INTO repairs VALUES(?,?,?)",
                   (repair["id"], repaired["run_id"], encoded(repair)))
    return repair


def get_repair(core: Core, repair_id: str) -> dict[str, Any]:
    from .api import CoreError, valid_id
    valid_id(repair_id, "repair")
    with core._db() as db:
        row = db.execute("SELECT value FROM repairs WHERE id=?", (repair_id,)).fetchone()
    if row is None:
        raise CoreError("NOT_FOUND", "Repair not found", 404)
    result = json.loads(row[0])
    for key in ("baseline_snapshot_id", "repair_snapshot_id"):
        core._verify_snapshot(core.get_snapshot(result[key]))
    return result


def list_repairs(core: Core, run_id: str) -> dict[str, Any]:
    core.get_run(run_id)
    with core._db() as db:
        rows = db.execute("SELECT value FROM repairs WHERE run_id=? ORDER BY rowid DESC LIMIT 100",
                          (run_id,)).fetchall()
    return {"items": [json.loads(row[0]) for row in rows]}
