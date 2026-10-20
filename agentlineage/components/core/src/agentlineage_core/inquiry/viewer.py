"""Human-view projections. No state replay, cause inference or collector changes."""

from __future__ import annotations

from typing import Any

import json
import re

from .engine import packet_text
from .native_text import change_outline, change_payloads
from .store import iso, parts, timestamp


def reports_for_view(engine, offset=0, limit=100):
    """Latest saved result per file in this migration's index, not its repair list.

    Group before pagination: repeated drafts of one file cannot hide another
    file. Keep every original report addressable by id; listing needs no source
    replay, graph rebuild or model call.
    """
    if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 100:
        raise ValueError("reports require offset >= 0 and limit between 1 and 100")
    rows = engine.store.rows(
        "SELECT id, json_extract(data,'$.target.file') AS file, "
        "json_extract(data,'$.target.at') AS at, "
        "json_array_length(data,'$.document.findings') AS count, "
        "COALESCE(json_extract(data,'$.document.findings[0].title'),'调查结果') AS title "
        "FROM runs WHERE rowid IN (SELECT MAX(rowid) FROM runs WHERE kind='report' "
        "GROUP BY json_extract(data,'$.target.file')) ORDER BY file,id"
    )
    return engine._page(rows, offset, limit)


def scope_for_view(engine, request):
    kind = request.get("kind")
    if kind not in ("file", "agent"):
        raise ValueError("display scope must be file or agent")
    # Reuse the kernel's identity/time validation and normalization.
    query = {"op": kind, "key": request["key"], "at": request["at"], "limit": 1}
    if request.get("since") is not None:
        query["since"] = request["since"]
    return engine.query(query)["scope"]


def operation_refs(engine, operation):
    originals = []
    for ref in (operation.get("request"), operation.get("result")):
        if ref:
            record, _ = engine.store.source_record(ref)
            originals.append(
                {
                    "ref": ref,
                    "source": record["name"],
                    "line": record["line"],
                    "at": iso(record["at"]),
                }
            )
    return originals


def file_history(engine, scope, request):
    at, since = timestamp(scope["at"], required=True), timestamp(scope.get("since"))
    operations = engine.relations(scope["kind"], scope["key"], at, since)
    confirmed = [
        r for r in operations if r["strength"] == "confirmed" and r["at"] is not None
    ]
    category = request.get("category", "changes")
    if category not in ("changes", "reads", "all"):
        raise ValueError("invalid history category")
    selected = [
        r
        for r in confirmed
        if category == "all" or (r["op"] == "read") == (category == "reads")
    ]
    offset, limit = request.get("offset", 0), request.get("limit", 20)
    if (
        type(offset) is not int
        or offset < 0
        or type(limit) is not int
        or not 1 <= limit <= 100
    ):
        raise ValueError("invalid display pagination")
    rows = []
    for index, operation in enumerate(selected[offset : offset + limit], offset + 1):
        originals = operation_refs(engine, operation)
        rows.append(
            {
                "id": operation["id"],
                "number": index,
                "at": iso(operation["at"]),
                "op": operation["op"],
                "file": operation["path"],
                "agent": operation["agent"],
                "originals": originals,
                "label": {"write": "写入", "read": "读取原文", "delete": "删除"}.get(
                    operation["op"], operation["op"]
                ),
            }
        )
    return {
        "scope": scope,
        "category": category,
        "rows": rows,
        "total": len(selected),
        "next": offset + len(rows) if offset + len(rows) < len(selected) else None,
        "changes": sum(r["op"] != "read" for r in confirmed),
        "reads": sum(r["op"] == "read" for r in confirmed),
        "note": "修改时刻与读取记录分开列出；不在相邻记录间推定完整文件状态。",
    }


def viewer_operation(engine, scope, request):
    operations = engine.relations(
        scope["kind"],
        scope["key"],
        timestamp(scope["at"], required=True),
        timestamp(scope.get("since")),
    )
    operation = next(
        (
            r
            for r in operations
            if r["id"] == request.get("id") and r["strength"] == "confirmed"
        ),
        None,
    )
    if operation is None:
        raise ValueError("此范围内没有可确认的这次操作")
    originals = operation_refs(engine, operation)
    content, content_kind, changes = None, None, []
    if operation["op"] == "read" and operation["result"]:
        _, raw = engine.store.source_record(operation["result"])
        for slot, family, role, _call, _tool, payload, _ok in parts(json.loads(raw)):
            if role == "result" and slot == operation["result_slot"]:
                # CC normalization adds dispatch metadata around the original
                # result. Display the content, not that internal wrapper.
                if family == "cc":
                    payload = payload["content"]
                content, content_kind = (
                    packet_text(payload, receipt=True),
                    "read_observation",
                )
                break
        note = "这是此次 Read 实际返回的原文，可能只有片段；不等于已知完整文件。"
        if operation["basis"] == "native_command_read":
            content_kind = "command_read_observation"
            note = "这是原生命令执行回执中的输出；同一次命令可能读取多个文件，下面保留合并输出，不将其冒充当前文件的独立全文。"
    else:
        payloads = change_payloads(engine.store, operation)
        changes = change_outline(payloads)
        # Only a native whole-write body is a whole-write observation. An Edit
        # delta is never applied to an earlier snapshot here.
        whole = [
            p["body"]["content"]
            for p in payloads
            if p["tool"].split(".")[-1].casefold() in ("write", "write_file")
            and isinstance(p.get("body"), dict)
            and isinstance(p["body"].get("content"), str)
        ]
        if len(whole) == 1:
            content, content_kind = whole[0], "write_body"
        note = "写入全文是此次调用提交的文本；增删只是此次修改片段，不推演未记录时刻的完整内容。"
    return {
        "id": operation["id"],
        "at": iso(operation["at"]),
        "scope": scope,
        "content": content,
        "content_kind": content_kind,
        "changes": changes,
        "originals": originals,
        "note": note,
    }


def viewer_query(engine, request):
    if not isinstance(request, dict):
        raise ValueError("display request must be an object")
    view = request.get("view")
    if view == "catalog":
        at = engine.store.db.execute("SELECT MAX(at) FROM records").fetchone()[0]
        files = engine.store.rows(
            "SELECT f.path, COUNT(e.id) AS n_events FROM files f LEFT JOIN effects e "
            "ON e.path=f.path AND e.strength='confirmed' AND e.op!='read' "
            "GROUP BY f.path ORDER BY f.path"
        )
        agents = engine.store.rows(
            "SELECT s.agent AS id, MIN(s.name) AS source, COUNT(DISTINCT e.id) AS n_events "
            "FROM sources s LEFT JOIN effects e ON e.agent=s.agent "
            "AND e.strength='confirmed' AND e.op!='read' "
            "WHERE s.agent IS NOT NULL GROUP BY s.agent ORDER BY s.agent"
        )
        parents: dict[Any, Any]
        parents = {}
        for dispatch in engine.dispatches(at):
            if dispatch["strength"] == "confirmed":
                parents.setdefault(dispatch["child"], set()).add(dispatch["parent"])
        for agent in agents:
            session, _, name = agent["id"].partition(":")
            agent["session"] = session[:8]
            agent["label"] = (
                "主会话:" + session[:8]
                if name == "main"
                else re.sub(r"-[0-9a-f]{16,}$", "", name or agent["id"])
            )
            candidates = parents.get(agent["id"], set())
            agent["parent"] = next(iter(candidates)) if len(candidates) == 1 else None
        return {"at": iso(at), "files": files, "agents": agents}
    if view == "reports":
        return reports_for_view(engine, request.get("offset", 0), request.get("limit", 100))
    if view == "overview":
        reports = reports_for_view(engine)
        return {
            "at": iso(
                engine.store.db.execute("SELECT MAX(at) FROM records").fetchone()[0]
            ),
            "files": engine.store.db.execute("SELECT COUNT(*) FROM files").fetchone()[
                0
            ],
            "agents": engine.store.db.execute(
                "SELECT COUNT(DISTINCT agent) FROM sources WHERE agent IS NOT NULL"
            ).fetchone()[0],
            "reports": reports["rows"],
            "reports_total": reports["total"],
            "reports_next": reports["next"],
            "report_limit": 100,
        }
    if view not in ("history", "operation"):
        raise ValueError("unknown display view")
    scope = scope_for_view(engine, request)
    return (
        file_history(engine, scope, request)
        if view == "history"
        else viewer_operation(engine, scope, request)
    )
