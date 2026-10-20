"""Diagnostic projections shared by MCP and the card audit; never add edges."""

from typing import Any

def coordinate_feedback(engine, graph):
    """Name the exact failed connection and nearby observations, not opaque IDs."""
    from .store import iso, timestamp

    nodes = {n["id"].split(":", 1)[1]: n for n in graph["nodes"]}
    submitted = graph["submitted_document"]["edges"]
    declarations = graph["document"]["findings"][0]["edges"]
    for warning in graph["unverified_edges"]:
        pair = tuple(warning.get(k) for k in ("from", "to"))
        indices = [i for i, edge in enumerate(declarations) if tuple(edge[k] for k in ("from", "to")) == pair]
        warning["where"] = [f"edges[{i}]" for i in indices]
        if indices:
            warning["coordinates"] = {k: submitted[indices[0]][k] for k in ("from", "to")}
        endpoints: list[Any] = [nodes.get(k) for k in pair]
        if None in endpoints:
            continue
        relation = warning.get("relation")
        if relation not in ("read", "write"):
            continue
        origin, destination = endpoints
        file, actor = (origin, destination) if relation == "read" else (destination, origin)
        cutoff = min(timestamp(n["at"], required=True) for n in endpoints)
        operations = [r for r in engine.relations("file", file["key"], timestamp(graph["target"]["at"]))
                      if r["agent"] == actor["key"] and r["op"] == relation]
        operations.sort(key=lambda r: (abs(r["at"] - cutoff) if r["at"] is not None else float("inf"), r["id"]))
        warning["operation_count"] = len(operations)
        warning["nearby_operations"] = [{"at": iso(r["at"]), "strength": r["strength"],
            "request": r["request"], "result": r["result"], "inside_cutoff": r["at"] is not None and r["at"] <= cutoff}
            for r in operations[:4]]
        warning["inspect"] = {"op": "file", "key": file["key"], "at": graph["target"]["at"], "view": "relations"}
        warning["next_step"] = (
            "Check exact event times below. at is a history cutoff: a confirmed Write/Read is available at its result/completion time, "
            "not merely the request time. Do not move a later read before an earlier output. If the claimed operation is genuinely an "
            "unparsed call, reopen its original request/result, then retry only this unchanged connection with force:true, reason and evidence. "
            "The server tracks the previous submission; do not fill revision_of."
            if warning.get("force_eligible") else
            "Fix the reported identity/time/source problem and resubmit normally. force cannot bypass it. Nearby operations are navigation, not automatically selected replacements.")


def path_feedback(graph):
    """One lossless, small path diagnostic shared by all submission frontends."""
    from .store import timestamp
    nodes = {n["id"]: n for n in graph["nodes"]}
    declared = graph.get("document", {}).get("findings", [])
    positions = {f["id"] + ":" + n["id"]: i for f in declared
                 for i, n in enumerate(f.get("nodes", []))}
    def coordinate(nid):
        n = nodes[nid]
        where = nid
        if graph.get("submission_format") == "coordinates/1":
            i = positions.get(nid, len(graph["submitted_document"]["nodes"]))
            where = f"nodes[{i}]" if i < len(graph["submitted_document"]["nodes"]) else "target"
        return {"key": n["key"], "at": n["at"], "where": where}

    outgoing: dict[Any, Any]
    outgoing = {}
    for edge in graph["edges"]:
        outgoing.setdefault(edge["from"], set()).add(edge["to"])
    root = graph["tree"]["root"]
    def dead_ends(start):
        pending, seen, ends = [start], set(), []
        while pending:
            nid = pending.pop()
            if nid in seen:
                continue
            seen.add(nid)
            node = nodes[nid]
            if (node["kind"], node["key"], timestamp(node["at"])) == (root["kind"], root["key"], timestamp(root["at"])):
                continue
            children = outgoing.get(nid, set())
            if not children:
                ends.append(coordinate(nid))
            pending.extend(sorted(children))
        return sorted(ends, key=lambda row: row["where"])

    paths = graph["tree"]["paths"] + graph["tree"].get("context_paths", [])
    return [{**coordinate(p["node"]),
             "status": p["status"], "code": p.get("code"),
             "diagnostic": p["diagnostic"], "blocked_branches": p["blocked_branches"],
             "via": coordinate(p["via"]) if p.get("via") else None,
             "dead_ends": dead_ends(p.get("via") or p["node"]),
             "next_step": ("核对列出的上游与下游原始调用；晚到输入不能解释较早输出。"
                           if p.get("code") == "time_reversal" else
                           "按列出的分支局部核查；搜索达到预算不证明关系不存在。"
                           if p.get("code") == "path_search_limit" else
                           "检查 via 分支与 dead_ends 末端的真实后续交接；若只是读后未写的旁支查阅，"
                           "保留在说明中而非伪造写边。无需补修复者。")}
            for p in paths if p["status"] not in ("native", "model_review")]


def compact_feedback(graph):
    """One concise mechanical response; full histories remain expandable."""
    from .store import iso

    nodes = {n["id"]: n for n in graph["nodes"]}
    return {**{k: graph[k] for k in ("report_id", "source_sha256", "mechanical_status", "path_status", "delivery", "issues", "unverified_edges")},
        "nodes": len(nodes), "bound_edges": len(graph["edges"]),
        "paths": graph["path_feedback"],
        "revision": {"tracked_by_server": True, "parent": graph["revision_parent"],
                     "note": "Correct the same card and resubmit. Only previously checked unchanged endpoints may use force; no model-written IDs or revision field."},
        "coverage": {"semantic_coverage_verified": False,
                     "native_writes_not_manually_reconciled": [{**r, "at": iso(r["at"])} for r in graph["coverage"]["unattributed_native_writes"]],
                     "unassessed_calls": len(graph["coverage"]["unassessed"]),
                     "note": "Automatically attached operations are NOT automatically explained modifications. These counts are inventory, not new missing schema fields."},
        "review_query": {"op": "review", "report_id": graph["report_id"], "limit": 100},
        "coverage_query": {"op": "review", "report_id": graph["report_id"], "view": "coverage", "limit": 100}}

def related_evidence(graph):
    # Retain the persisted graph field for old cards; it never meant a required
    # causal handoff. Expose actual operation times, not just opaque scopes.
    return {
        "required": False,
        "operations": [
            {k: row.get(k) for k in ("link", "op", "agent", "path", "at", "strength", "request", "result")}
            for row in graph["missing_evidence_links"]
        ],
        "note": "Optional already-cited operations, not missing required edges or suggested paths. A later read may be a readback, not input to an earlier write. Do not add it merely to remove this list.",
    }


def time_conflict(upstream, downstream):
    def operation(event):
        return {k: event[k] for k in ("id", "relation", "evidence", "at")}
    return {"code": "time_reversal", "upstream": operation(upstream),
            "downstream": operation(downstream),
            "note": "This branch uses a later operation as input to an earlier one. Expanding cutoffs or force does not reorder events. If this indexed operation is not the claimed handoff, find its actual earlier input (including script-internal reads) and resubmit that connection with relation + original evidence, without force. An unresolved result can then authorize a reviewed force in the next revision. Do not retain a known-wrong readback just because its individual edge binds. Other branches may fail for different reasons."}
