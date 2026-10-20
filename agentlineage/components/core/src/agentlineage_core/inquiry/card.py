"""Compact authoring coordinates -> the existing evidence checker, not a new graph.

The submitted bytes remain the source of truth. This projection only supplies
identities and bookkeeping; it never writes reasons, causal roles or new facts.
"""

from typing import Any

import json
from pathlib import PurePosixPath

from .edge_submission import agent_key
from .store import digest, encode, iso, timestamp

AUTO_PARENT = object()


def supplemental_file_key(key):
    """Unindexed files need explicit paths; unknown transcript IDs stay errors."""
    path = key.replace("\\", "/")
    return ("/" in path and not path.endswith("/") and "://" not in path
            and not any(ord(c) < 32 for c in path)
            and not path.casefold().endswith((".jsonl", ".jsonl.gz")))


class CardError(ValueError):
    def __init__(self, issues):
        grouped: dict[Any, Any]
        grouped = {}
        for issue in issues:
            detail = {k: v for k, v in issue.items() if k != "where"}
            group = grouped.setdefault(encode(detail), {**detail, "where": []})
            group["where"].append(issue["where"])
        self.issues = list(grouped.values())
        super().__init__(encode({"code": "invalid_card", "issues": self.issues,
            "note": "No report saved. Correct these coordinates/fields together; no force permission granted."}))


def compact(document):
    return isinstance(document, dict) and "schema" not in document and "findings" not in document


def latest_parent(engine, target):
    """Only this investigation's previous check; loaders pass a frozen parent."""
    for row in engine.store.rows("SELECT id,data FROM runs WHERE kind='report' ORDER BY rowid DESC"):
        old = json.loads(row["data"])
        if old.get("submission_format") != "coordinates/1" or old.get("trace_session") != engine.session:
            continue
        other = old["target"]
        if (other["file"], timestamp(other["at"]), timestamp(other.get("since"))) == (
                target["file"], timestamp(target["at"]), timestamp(target.get("since"))):
            return row["id"]
    return None


def prepare(engine, source, parent=AUTO_PARENT):
    resolved: dict[Any, Any]
    issues, resolved = [], {}
    pending_files: list[Any]
    pending_files = []

    def reject(where, error, **details):
        issues.append({"where": where, "error": error, **details})

    def fields(value, allowed, required, where):
        if not isinstance(value, dict) or set(value) - set(allowed) or set(required) - set(value):
            reject(where, "Invalid fields", required=list(required), allowed=list(allowed))
            return False
        return True

    def text(value, where):
        if not isinstance(value, str) or not value.strip():
            reject(where, "Expected nonempty text")
            return False
        return True

    def resolve(key):
        if key in resolved:
            return resolved[key]
        possibilities = []
        try:
            possibilities.append(("agent", agent_key(engine.store, key)))
        except ValueError:
            pass
        file = engine.store.resolve_file(key)
        registered = engine.store.rows("SELECT 1 FROM files WHERE path=?", (file,))
        if (registered or not possibilities and "/" in file) and engine.store.has_records("file", file, observation):
            possibilities.append(("file", file))
        elif not possibilities and supplemental_file_key(key):
            # Retain a declaration for feedback, NOT an indexed entity. Only
            # a later evidence-backed incident force can admit it to the tree.
            possibilities.append(("file", file))
        if len(possibilities) != 1:
            name = PurePosixPath(key.replace("\\", "/")).name
            alternatives = engine.store.rows("SELECT path FROM files WHERE path LIKE ? LIMIT 8", ("%/" + name,))
            raise ValueError("Unknown or ambiguous key. Copy its exact file path / registered transcript name from catalog; "
                             "do not change case or omit parent directories. Exact-basename candidates (not auto-selected): "
                             + encode([x["path"] for x in alternatives]))
        resolved[key] = possibilities[0]
        return resolved[key]

    def coord(value, where):
        if not fields(value, ("key", "at"), ("key", "at"), where) or not text(value.get("key"), where + ".key"):
            return None
        try:
            at = timestamp(value["at"], required=True)
            if at > observation:
                raise ValueError("Node cutoff is later than task observation cutoff " + iso(observation))
            kind, key = resolve(value["key"])
            if not engine.store.has_records(kind, key, at):
                if kind != "file" or not supplemental_file_key(key):
                    raise ValueError("Entity has no recorded evidence before this cutoff; inspect its actual history/time")
                alternatives = engine.store.rows("SELECT path FROM files WHERE path LIKE ? LIMIT 8",
                                                ("%/" + PurePosixPath(key).name,))
                pending_files.append({"where": where, "code": "unrecorded_file",
                    "error": "File has no recorded evidence at cutoff; verify its path. Known candidates: "
                             + encode([r["path"] for r in alternatives]), "supplied": value,
                    "query": {"op": "catalog", "kind": "file", "q": PurePosixPath(key).name}})
            return kind, key, at
        except (ValueError, TypeError, OSError) as exc:
            name = PurePosixPath(value["key"].replace("\\", "/")).name
            catalog_kind = "file" if "." in name and not name.endswith(".jsonl") else "source"
            reject(where, str(exc), supplied=value,
                   query={"op": "catalog", "kind": catalog_kind, "q": name})
            return None

    required = ("target", "summary", "recommendations", "nodes", "edges")
    if not fields(source, required, required, "card"):
        raise CardError(issues)
    target = source["target"]
    if not fields(target, ("key", "at", "since"), ("key", "at"), "target"):
        raise CardError(issues)
    try:
        observation = timestamp(target["at"], required=True)
        since = timestamp(target["since"], required=True) if target.get("since") is not None else None
        if since is not None and since > observation:
            raise ValueError("target.since is after target.at")
        if not isinstance(target["key"], str) or not target["key"]:
            raise ValueError("target.key must be a real file path")
        target_key = engine.store.resolve_file(target["key"])
        if not engine.store.has_records("file", target_key, observation):
            raise ValueError("target file has no recorded evidence; copy the task file path exactly")
    except (ValueError, TypeError) as exc:
        raise CardError([{"where": "target", "error": str(exc)}]) from exc
    target = {"file": target_key, "at": iso(observation), "since": iso(since)}
    text(source["summary"], "summary")
    if not isinstance(source["recommendations"], list) or len(source["recommendations"]) > 100:
        reject("recommendations", "Expected a list of at most 100 concrete recommendation strings")
    else:
        for i, value in enumerate(source["recommendations"]):
            text(value, f"recommendations[{i}]")
    if not isinstance(source["nodes"], list) or not 1 <= len(source["nodes"]) <= 200:
        reject("nodes", "Expected 1–200 nodes")
    if not isinstance(source["edges"], list) or len(source["edges"]) > 500:
        reject("edges", "Expected at most 500 edges")
    if issues:
        raise CardError(issues)
    nodes, identities = [], {}
    declared_coordinates = [None] * len(source["nodes"])
    for i, item in enumerate(source["nodes"]):
        where = f"nodes[{i}]"
        if not fields(item, ("key", "at", "reason", "problem"), ("key", "at", "reason"), where):
            continue
        text(item["reason"], where + ".reason")
        if type(item.get("problem", False)) is not bool:
            reject(where + ".problem", "Expected boolean; true marks a model accusation, not proven first authorship")
        identity = coord({k: item[k] for k in ("key", "at")}, where)
        if identity is None:
            continue
        if identity in identities:
            reject(where, "Duplicate key + time. Declare once and reference it from multiple edges; "
                          "different times must be separate nodes. Merge judgments in reason, not by inventing timestamps.")
            continue
        nid = "n-" + digest(encode(identity).encode())[:16]
        identities[identity] = nid
        declared_coordinates[i] = identity
        nodes.append({"id": nid, "kind": identity[0], "key": identity[1], "at": iso(identity[2]),
                      "reason": item["reason"], "role": "problem" if item.get("problem") else "context"})
    root_identity = ("file", target_key, observation)
    if root_identity not in identities:
        nid = "n-" + digest(encode(root_identity).encode())[:16]
        identities[root_identity] = nid
        nodes.append({"id": nid, "kind": "file", "key": target_key, "at": iso(observation),
                      "reason": "返修目标端点（系统坐标，无额外归因判断）。", "role": "repaired"})

    def endpoint(value, where):
        # Authoring shorthand only: resolve once to the exact same coordinates.
        # Integers are positions in THIS submission, never persistent identities.
        if type(value) is int:
            if not 1 <= value <= len(declared_coordinates):
                reject(where, "Node number is 1-based in this submission's nodes list; "
                       "use 1 through " + str(len(declared_coordinates)) + " or 'target'", supplied=value)
                return None
            identity = declared_coordinates[value - 1]
            if identity is None:
                reject(where, f"Referenced nodes[{value - 1}] is invalid; fix that declaration first", supplied=value)
            return identity
        if value == "target":
            return root_identity
        if isinstance(value, dict):
            return coord(value, where)
        reject(where, "Expected a 1-based node number, 'target', or an explicit {key, at} coordinate", supplied=value)
        return None

    edges = []
    for i, item in enumerate(source["edges"]):
        where = f"edges[{i}]"
        if not fields(item, ("from", "to", "force", "reason", "evidence"), ("from", "to"), where):
            continue
        endpoints = [endpoint(item[k], where + "." + k) for k in ("from", "to")]
        if None in endpoints:
            continue
        if any(c not in identities for c in endpoints):
            reject(where, "Each endpoint must exactly match a declared node's key + time (or the target endpoint)", supplied=item)
            continue
        if type(item.get("force", False)) is not bool:
            reject(where + ".force", "Expected boolean")
        forced = item.get("force") is True
        if not forced and any(k in item for k in ("reason", "evidence")):
            reject(where, "Ordinary edges need only from/to; evidence and edge reason are for a reviewed force only")
        if forced and (not text(item.get("reason"), where + ".reason") or not isinstance(item.get("evidence"), list) or not item["evidence"]):
            reject(where, "force requires nonempty reason and original evidence list")
            continue
        if endpoints[0] == endpoints[1] or endpoints[0][0] == endpoints[1][0] == "file":
            reject(where, "Not a read/write/dispatch handoff. File-to-file or self-identity is not a historical edge; include the actual agent")
            continue
        edge: dict[str, Any] = {"from": identities[endpoints[0]], "to": identities[endpoints[1]]}
        if forced:
            edge.update(force=True, claim=item["reason"], evidence=item["evidence"])
        edges.append(edge)
    if issues:
        raise CardError(issues + pending_files)
    parent = latest_parent(engine, target) if parent is AUTO_PARENT else parent
    document = {"schema": "inquiry/1", "target": target,
        "summary": source["summary"], "recommendations": source["recommendations"],
        "findings": [{"id": "card", "title": PurePosixPath(target_key).name,
                      "reason": source["summary"], "nodes": nodes, "edges": edges}]}
    if parent is not None:
        document["revision_of"] = parent
    return document


def force_review(engine, edge, origin, destination):
    """Group original invocations, just as one ordinary edge may bind many calls.

Each group still goes through reviewed_edge. Nothing is collapsed into an
invented single timestamp, and a failed group must remain an explicit error.
"""
    actor = destination if edge["relation"] == "read" else origin
    cutoff = min(timestamp(n["at"], required=True) for n in (origin, destination))
    records = []
    for ref in edge["evidence"]:
        if isinstance(ref, dict) and set(ref) == {"source", "line"}:
            ref = engine.store.locate(ref["source"], ref["line"])
        if not isinstance(ref, str) or not ref:
            raise ValueError("Each force evidence entry must be an original reference string or {source, line}")
        record, _ = engine.store.source_record(ref)
        if record["at"] is None or record["at"] > cutoff:
            raise ValueError(f"Force source {ref} at {iso(record['at'])} is outside endpoint cutoff {iso(cutoff)}")
        records.append(record)
    anchors = [r for r in records if r["agent"] == actor["key"] and engine.store.rows(
        "SELECT 1 FROM calls WHERE record=? UNION ALL SELECT 1 FROM tool_returns WHERE record=? LIMIT 1", (r["ref"], r["ref"]))]
    if not anchors:
        raise ValueError("Force evidence must include an original tool call/return owned by this agent; a message or another agent's call cannot anchor it")
    # A supplied native request cannot backdate its later completion.
    for r in anchors:
        late = engine.store.rows("SELECT at FROM effects WHERE (request=? OR result=?) AND at>?", (r["ref"], r["ref"], cutoff))
        late += engine.store.rows("SELECT r.at FROM call_pairs p JOIN records r ON r.ref=p.result "
                                  "WHERE p.request=? AND r.at>?", (r["ref"], cutoff))
        if late:
            raise ValueError("The cited operation completes after the endpoint cutoff: " + iso(late[0]["at"]) + "; force cannot backdate it")
    groups: dict[Any, Any]
    groups = {}
    for r in anchors:
        pairs = engine.store.rows("SELECT request FROM call_pairs WHERE result=?", (r["ref"],))
        requests = {p["request"] for p in pairs}
        if len(requests) > 1:
            raise ValueError("This return record answers multiple different requests; cite the actual invocation records to separate them")
        key = next(iter(requests)) if requests else r["ref"]
        groups.setdefault(key, []).append(r)
    context = {r["ref"] for r in records} - {r["ref"] for r in anchors}
    reviews = []
    for rows in groups.values():
        anchor = max(rows, key=lambda r: (r["at"], r["ref"]))
        opened = engine.query({"op": "open", "ref": anchor["ref"], "at": iso(cutoff)})
        reviews.append({"review": {"at": iso(anchor["at"]),
            "quotes": [{"ref": anchor["ref"], "text": opened["text"][:1000]}]},
            "evidence": sorted(context | {r["ref"] for r in rows})})
    return reviews


def bind_node_evidence(engine, nodes, edges):
    """Attach only incident operations, not proof of any prose assertion."""
    for node in nodes:
        refs = {ref for e in edges if node["id"] in (e["from"], e["to"]) for ref in e["evidence"]}
        records = [engine.store.source_record(ref)[0] for ref in refs]
        # Dispatch confirmation may legitimately arrive after its occurrence;
        # keep it on the edge, not in an earlier node's evidence drawer.
        visible = {r["ref"] for r in records if r["at"] is not None and r["at"] <= timestamp(node["at"], required=True)}
        node["evidence"] = sorted(visible)
        node["valid_refs"] = sorted(visible)
        node["evidence_basis"] = "incident_operations_not_semantic_proof"


def delivery_status(graph):
    """Compact readiness is a renderable checked argument, NOT a coverage score."""
    paths = graph["tree"]["paths"] + graph["tree"].get("context_paths", [])
    ready = (graph["mechanical_status"] == "valid" and bool(graph["tree"]["paths"])
             and all(p["status"] in ("native", "model_review") for p in paths))
    return {"status": "ready_for_review" if ready else "draft", "semantic_verified": False,
        "coverage_verified": False, "scope": "identities_sources_temporal_paths_only",
        "note": "Ready means the declared evidence tree is mechanically loadable. Auto-attached evidence does not certify reasons, stopping boundaries, or that every modification was explained."}
