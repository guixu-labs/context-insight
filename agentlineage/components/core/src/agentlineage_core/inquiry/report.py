"""Bind a model's argument without rewriting its reasons or inventing graph edges."""

from __future__ import annotations

from typing import Any

import json
import uuid

from .citations import inline_refs, reference_hint
from .coverage import reconcile
from .engine import bounds, in_scope
from .evidence_graph import attach
from .evidence_review import review
from .store import digest, encode, iso, timestamp
from .tree import evidence_paths, reviewed_edge
from .check_receipts import bind_checks
from .edge_submission import agent_key, call_window, confirmed_edges, edge_key, previous_feedback
from .card import AUTO_PARENT, compact, prepare, force_review, bind_node_evidence, delivery_status


def parse(text):
    if not isinstance(text, str) or not text.strip() or len(text) > 80000:
        raise ValueError("report must be 1–80000 characters")
    try:
        result = json.loads(text)
    except ValueError:
        import yaml

        try:
            if any(isinstance(event, yaml.AliasEvent) for event in yaml.parse(text)):
                raise ValueError("YAML aliases are not allowed")
            result = yaml.safe_load(text)
        except yaml.YAMLError as exc:
            raise ValueError("invalid YAML") from exc
    if compact(result):
        return result
    if not isinstance(result, dict) or result.get("schema") != "inquiry/1":
        raise ValueError("schema must be inquiry/1")
    if set(result) - {"schema", "target", "findings", "unexplained", "reviewed", "summary", "recommendations", "revision_of"}:
        raise ValueError("unknown report fields")
    if "revision_of" in result and (not isinstance(result["revision_of"], str) or not result["revision_of"]):
        raise ValueError("revision_of must be a returned report_id")
    if not isinstance(result.get("reviewed", []), list):
        raise TypeError("reviewed must be a list")
    findings = result.get("findings")
    if not isinstance(findings, list) or len(findings) > 100:
        raise ValueError("findings must be a list of at most 100 items")
    target = result.get("target")
    if not isinstance(target, dict):
        raise TypeError("target.file required")
    if "scope" in target:
        if set(target) != {"scope"}:
            raise ValueError("target uses scope or file/time, not both")
    else:
        if not isinstance(target.get("file"), str):
            raise TypeError("target.file required")
        bounds(target)
    return result


def check(engine, text, *, save=False, _legacy_reviews=False, _compact_parent=AUTO_PARENT):
    submitted = parse(text)
    is_compact = compact(submitted)
    document = prepare(engine, submitted, _compact_parent) if is_compact else submitted
    target = document["target"]
    if "scope" in target:
        coordinate = engine.store.handle_value(target["scope"], "s")
        if coordinate["kind"] != "file":
            raise ValueError("target scope must be a file")
        target = {
            "file": coordinate["key"],
            "at": coordinate["at"],
            "since": coordinate.get("since"),
        }
    bound: Any
    relation: Any
    nodes, edges, unverified, issues = [], [], [], []
    allowed_force = previous_feedback(engine, document, target)
    referenced = set()
    explained_changes = set()

    def verify_refs(refs, at, where, since=None, scope_kind="report_cutoff"):
        if not isinstance(refs, list) or any(not isinstance(ref, str) for ref in refs):
            issues.append(
                {"where": where, "error": "evidence must be a list of original refs"}
            )
            return set()
        at = min(at, timestamp(target["at"], required=True))
        valid = set()
        for ref in refs:
            try:
                record, _ = engine.store.source_record(ref)
                if not in_scope(record["at"], at, since):
                    issues.append(
                        {
                            "where": where,
                            "ref": ref,
                            "error": f"evidence outside {scope_kind} / report observation time range or undated",
                            "scope_kind": scope_kind,
                            "record_at": iso(record["at"]),
                            "required_scope": {"since": iso(since), "at": iso(at)},
                            "note": "changes must be inside the target's original repair interval. Earlier generation context belongs in reason or a correctly bounded node.evidence, not changes; later/undated evidence cannot be made early. Do not change the required target interval just to silence this error."
                            if scope_kind == "target_change_window"
                            else "Use evidence actually within this declared scope, or a separately opened scope appropriate to the claim. No timestamp or report text has been rewritten.",
                        }
                    )
                    continue
                valid.add(record["ref"])
                referenced.add(record["ref"])
            except (ValueError, OSError) as exc:
                issue = {"where": where, "ref": ref, "error": str(exc)}
                hint = reference_hint(engine, ref)
                if hint:
                    issue["resolution_hint"] = hint
                issues.append(issue)
        return valid

    def verify_text(value, at, where, since=None, scope_kind="report_cutoff"):
        # Coordinate cards declare their relationships explicitly. Their prose
        # is not a second, spelling-dependent evidence submission channel.
        if not is_compact:
            verify_refs(inline_refs(value), at, where, since, scope_kind)

    seen_findings = set()
    for index, finding in enumerate(document["findings"]):
        if not isinstance(finding, dict) or set(finding) - {
            "id",
            "title",
            "reason",
            "changes",
            "nodes",
            "edges",
            "reviewed_edges",
            "unknown",
            "hypothesis",
            "recommendation",
            "boundary",
            "checks",
        }:
            raise ValueError("invalid finding fields")
        fid = finding.get("id")
        if not isinstance(fid, str) or not fid or fid in seen_findings:
            raise ValueError("finding IDs must be nonempty and unique")
        seen_findings.add(fid)
        if not isinstance(finding.get("nodes", []), list) or any(
            not isinstance(n, dict) for n in finding.get("nodes", [])
        ):
            raise TypeError("nodes must be a list of objects")
        original_node_ids = {
            n.get("id") for n in finding.get("nodes", []) if isinstance(n, dict)
        }
        if not isinstance(finding.get("reviewed_edges", []), list) or any(
            not isinstance(e, dict) or "review" not in e
            for e in finding.get("reviewed_edges", [])
        ):
            raise ValueError("reviewed_edges must contain explicit relation reviews")
        automatic_edges = "edges" not in finding
        finding = attach(engine, finding, target)
        for field in ("title", "reason", "unknown", "hypothesis", "recommendation", "boundary", "checks"):
            verify_text(
                finding.get(field),
                timestamp(target["at"], required=True),
                f"{fid}.{field}",
            )
        if any(
            not isinstance(finding.get(k), str) or not finding[k].strip()
            for k in ("title", "reason")
        ):
            raise ValueError("finding title and reason required")
        explained_changes.update(
            verify_refs(
                finding.get("changes", []),
                timestamp(target["at"], required=True),
                f"{fid}.changes",
                timestamp(target.get("since")),
                "target_change_window",
            )
        )
        local: dict[Any, Any] = {}
        if not isinstance(finding.get("nodes", []), list) or not isinstance(
            finding.get("edges", []), list
        ):
            raise TypeError("nodes and edges must be lists")
        for node in finding.get("nodes", []):
            if not isinstance(node, dict) or set(node) - {
                "id",
                "kind",
                "key",
                "at",
                "since",
                "role",
                "reason",
                "evidence",
                "scope",
            }:
                raise ValueError("invalid node fields")
            nid = node.get("id")
            if not isinstance(nid, str) or not nid or nid in local:
                raise ValueError("node IDs must be unique within a finding")
            if "scope" in node:
                if any(k in node for k in ("kind", "key", "at", "since")):
                    raise ValueError(
                        "node uses scope or explicit coordinates, not both"
                    )
                coordinate = engine.store.handle_value(node["scope"], "s")
                node = {
                    **node,
                    **{k: coordinate[k] for k in ("kind", "key", "at")},
                    "since": coordinate.get("since"),
                }
            if node.get("kind") not in ("file", "agent") or not isinstance(
                node.get("key"), str
            ):
                raise ValueError("node kind/file-or-agent key required")
            if node.get("role") not in (
                "origin",
                "propagated",
                "context",
                "repaired",
                "unknown",
                "problem",
            ):
                raise ValueError("invalid node role")
            if not isinstance(node.get("reason"), str) or not node["reason"].strip():
                raise ValueError("every node requires its original reason")
            at, since = bounds(node)
            key = node["key"]
            try:
                key = (engine.store.resolve_file(key) if node["kind"] == "file"
                       else agent_key(engine.store, key))
                exists = engine.store.has_records(node["kind"], key, min(at, timestamp(target["at"], required=True)), since=since)
            except ValueError as exc:
                exists = False
                issues.append({"where": f"{fid}.{nid}", "error": str(exc)})
            refs = verify_refs(
                node.get("evidence", []), at, f"{fid}.{nid}", since, "node"
            )
            verify_text(node["reason"], at, f"{fid}.{nid}.reason", since, "node")
            supplemental = is_compact and node["kind"] == "file" and not exists
            if not exists and not supplemental:
                issues.append(
                    {
                        "where": f"{fid}.{nid}",
                        "error": "node has no recorded evidence at cutoff",
                    }
                )
            bound = {
                **node,
                "id": f"{fid}:{nid}",
                "key": key,
                "finding": fid,
                "exists": exists,
                "valid_refs": sorted(refs),
                "semantic_verified": False,
                "generated_context": nid not in original_node_ids,
            }
            if supplemental:
                bound["existence_basis"] = "unverified"
            local[nid] = bound
            nodes.append(bound)
        declared_edges = []
        for edge in finding.get("edges", []):
            if not isinstance(edge, dict):
                raise ValueError("invalid edge fields")
            origin, destination = local.get(edge.get("from")), local.get(edge.get("to"))
            if "link" not in edge and "relation" not in edge and origin and destination:
                relation = {("agent", "file"): "write", ("file", "agent"): "read",
                            ("agent", "agent"): "dispatch"}.get((origin["kind"], destination["kind"]))
                if relation:
                    edge = {**edge, "relation": relation}
            if not edge.get("force") and "review" not in edge:
                edge = {"claim": "历史关系声明；不认证问题传播。", **edge}
            # A bare connection asks about historical relations, not a particular
            # content version. Return ALL confirmed matches with their own times.
            if (not any(k in edge for k in ("link", "evidence", "review")) and not edge.get("force")
                    and origin and destination and origin["exists"] and destination["exists"]
                    and edge.get("relation") in ("read", "write", "dispatch")
                    and (origin["kind"], destination["kind"]) == {"read": ("file", "agent"),
                        "write": ("agent", "file"), "dispatch": ("agent", "agent")}[edge["relation"]]):
                matches = confirmed_edges(engine, origin, destination, edge["relation"], target["at"])
                if matches:
                    for binding in matches:
                        declared_edges.append({**{k: v for k, v in edge.items() if k != "relation"}, **binding})
                    continue
            declared_edges.append(edge)
        for edge in declared_edges:
            operation_id = None
            if not isinstance(edge, dict) or set(edge) - {
                "from",
                "to",
                "relation",
                "evidence",
                "claim",
                "link",
                "review",
                "force",
            }:
                raise ValueError("invalid edge fields")
            if "force" in edge and type(edge["force"]) is not bool:
                raise ValueError("force must be a boolean")
            if any(edge.get(k) not in local for k in ("from", "to")):
                unverified.append({**edge, "finding": fid, "force_eligible": False,
                    "diagnostic": "unknown node ID: " + ", ".join(str(edge.get(k)) for k in ("from", "to") if edge.get(k) not in local)})
                continue
            if "link" in edge:
                if "evidence" in edge or "relation" in edge:
                    raise ValueError(
                        "edge uses link or explicit evidence/relation, not both"
                    )
                coordinate = engine.store.handle_value(edge["link"], "l")
                operation_id = coordinate["operation"]
                edge = {**edge, **{k: coordinate[k] for k in ("relation", "evidence")}}
            if edge.get("relation") not in (
                "read",
                "write",
                "possible_read",
                "possible_write",
                "dispatch",
            ):
                raise ValueError("invalid relation kind")
            if not isinstance(edge.get("claim"), str) or not edge["claim"].strip():
                raise ValueError("edge claim required")
            origin, destination = local.get(edge.get("from")), local.get(edge.get("to"))
            reason = "unknown node ID: " + ", ".join(str(edge[k]) for k in ("from", "to") if edge.get(k) not in local)
            bound = None
            supporting_request = None
            supporting_result = None
            signature = None
            force_eligible = False
            if origin and destination:
                relation = edge.get("relation")
                op = {
                    "read": "read",
                    "write": "write",
                    "possible_read": "read",
                    "possible_write": "write",
                }.get(relation)
                file, agent = (
                    (origin, destination) if op == "read" else (destination, origin)
                )
                if op and (file["kind"] != "file" or agent["kind"] != "agent"):
                    unverified.append({**edge, "finding": fid,
                        "diagnostic": f"{relation} requires {'file -> agent' if op == 'read' else 'agent -> file'}; got {origin['kind']} -> {destination['kind']}. An agent input view is still an agent, not the file it received."})
                    continue
                cutoff = min(
                    timestamp(origin["at"], required=True),
                    timestamp(destination["at"], required=True),
                )
                starts = [
                    timestamp(n["since"], required=True)
                    for n in (origin, destination)
                    if n.get("since") is not None
                ]
                start = max(starts) if starts else None
                signature = edge_key(origin, destination, {"possible_read": "read", "possible_write": "write"}.get(relation, relation))
                forced = edge.get("force") is True or "review" in edge
                legacy_review = _legacy_reviews and "review" in edge and "force" not in edge
                if forced and not legacy_review and signature not in allowed_force:
                    unverified.append({**edge, "finding": fid, "edge_key": signature,
                        "force_eligible": False, "code": "force_before_feedback",
                        "diagnostic": ("Submit this exact connection without force first. The server tracks revisions in this investigation; only checked unresolved endpoints may be forced."
                                       if is_compact else "Submit this exact connection without force/review first. Then use the returned report_id as revision_of; only server-checked unresolved endpoints may be forced.")})
                    continue
                if forced and is_compact:
                    try:
                        variants = force_review(engine, edge, origin, destination)
                    except (ValueError, TypeError, KeyError, OSError) as exc:
                        unverified.append({**edge, "finding": fid, "edge_key": signature,
                            "force_eligible": False, "code": "invalid_force_source", "diagnostic": str(exc)})
                        continue
                    for variant in variants:
                        reviewed = {**edge, **variant}
                        try:
                            before = len(issues)
                            verify_refs(reviewed["evidence"], cutoff, f"{fid}.edge", scope_kind="edge")
                            if len(issues) != before:
                                raise ValueError("Force evidence failed original source/time validation")
                            bound = reviewed_edge(engine, reviewed, origin, destination, fid)
                            bound.update(force=True, edge_key=signature, checked_after=document.get("revision_of"))
                            edges.append(bound)
                        except (ValueError, TypeError, KeyError, OSError) as exc:
                            unverified.append({**reviewed, "finding": fid, "edge_key": signature,
                                "force_eligible": False, "code": "invalid_force_source", "diagnostic": str(exc)})
                    continue
                if forced and "review" not in edge:
                    unverified.append({**edge, "finding": fid, "code": "force_missing_review",
                        "diagnostic": "force requires a reason (claim), original evidence, and review:{at,quotes}."})
                    continue
                dispatch_edge = (
                    "review" not in edge
                    and relation == "dispatch"
                    and origin["kind"] == destination["kind"] == "agent"
                )
                observed_at = (
                    timestamp(target["at"], required=True) if dispatch_edge else cutoff
                )
                issue_count = len(issues)
                refs = verify_refs(
                    edge.get("evidence", []),
                    observed_at,
                    f"{fid}.edge",
                    scope_kind="edge",
                )
                if len(issues) != issue_count:
                    unverified.append(
                        {
                            **edge,
                            "finding": fid,
                            "diagnostic": "Edge evidence failed source/time validation; no bound edge.",
                        }
                    )
                    continue
                reason = (f"No matching confirmed {relation}: {origin['key']} -> {destination['key']} "
                          f"inside [{iso(start)}, {iso(cutoff)}]. This is not proof the operation never happened. "
                          "Check the original tool calls; unresolved read/write may be resubmitted with force after this feedback.")
                force_eligible = bool(op and agent["exists"] and not forced
                    and (file["exists"] or is_compact and file.get("existence_basis") == "unverified"))
                if force_eligible and not file["exists"]:
                    reason = (f"Unrecorded file node {file['key']} at {file['at']}. Verify its exact path and "
                              "original call/return. After this ordinary submission, the unchanged connection may "
                              "use force + reason + evidence to support a report-local file node; "
                              "the tool call does not itself prove the claimed file effect.")
                if "review" in edge:
                    try:
                        bound = reviewed_edge(engine, edge, origin, destination, fid)
                    except (ValueError, TypeError, KeyError, OSError) as exc:
                        reason = str(exc)
                if dispatch_edge:
                    # The native receipt can confirm this historical mapping
                    # later than either endpoint. It must still be available
                    # by the report's observation cutoff, and is not exposed
                    # by an earlier tree step.
                    for dispatch in engine.dispatches(observed_at, agent=origin["key"]):
                        if (dispatch["parent"], dispatch["child"]) != (
                            origin["key"],
                            destination["key"],
                        ):
                            continue
                        if not in_scope(dispatch["at"], cutoff, start):
                            continue
                        if ({dispatch["request"], dispatch["result"]} - {None}) <= refs:
                            supporting_request = dispatch["request"]
                            supporting_result = dispatch["result"]
                            bound = {
                                **edge,
                                "from": origin["id"],
                                "to": destination["id"],
                                "finding": fid,
                                "strength": dispatch["strength"],
                                "operation": dispatch["id"],
                                "at": iso(dispatch["at"]),
                                "occurrence_at": iso(dispatch["at"]),
                                "confirmed_at": iso(dispatch["confirmed_at"]),
                                "request": dispatch["request"],
                                "result": dispatch["result"],
                                "identity_known_at_cutoff": dispatch[
                                    "identity_known_at_cutoff"
                                ],
                                "identity_basis": dispatch["identity_basis"],
                                "semantic_verified": False,
                            }
                            break
                if (
                    "review" not in edge
                    and op
                    and file["kind"] == "file"
                    and agent["kind"] == "agent"
                    and origin["exists"]
                    and destination["exists"]
                ):
                    matches = []
                    operations = engine.relations("file", file["key"], cutoff)
                    for operation in operations:
                        expected = {operation["request"], operation["result"]} - {None}
                        if (
                            operation["agent"] == agent["key"]
                            and (
                                operation_id is None or operation["id"] == operation_id
                            )
                            and operation["op"] == op
                            and expected
                            and expected.intersection(refs)
                        ):
                            if not in_scope(operation["at"], cutoff, start):
                                force_eligible = False
                                reason = (f"Referenced {op} occurs at {iso(operation['at'])}, outside endpoint interval "
                                          f"[{iso(start)}, {iso(cutoff)}]. Reopen this entity's history with the appropriate bounds; "
                                          "a repair-window since excludes generation evidence. No scope was changed.")
                                continue
                            matches.append(
                                {
                                    **edge,
                                    "evidence": sorted(refs | expected),
                                    "from": origin["id"],
                                    "to": destination["id"],
                                    "finding": fid,
                                    "strength": operation["strength"],
                                    "operation": operation["id"],
                                    "at": iso(operation["at"]),
                                    "semantic_verified": False,
                                }
                            )
                    if len(matches) == 1:
                        bound = matches[0]
                        # Selecting one native call need not require copying its
                        # receipt. Recheck the uniquely paired bytes; do not use
                        # a missing/changed mate to disambiguate multiple calls.
                        issue_count = len(issues)
                        verify_refs(bound["evidence"], observed_at, f"{fid}.edge", scope_kind="edge")
                        if len(issues) != issue_count:
                            bound = None
                            reason = "The native operation's paired source evidence failed revalidation."
                        else:
                            supporting_request = next(
                                r["request"] for r in operations if r["id"] == bound["operation"])
                    elif len(matches) > 1:
                        force_eligible = False
                        reason = "multiple operations share these record references; use the returned link to select its exact block"
                if (
                    bound
                    and "review" not in edge
                    and (start is not None or dispatch_edge)
                ):
                    # A receipt inside the interval may answer an earlier request.
                    # Only this bound operation's exact request gets that exception.
                    issue_count = len(issues)
                    verify_refs(
                        sorted(refs - {supporting_request, supporting_result}),
                        cutoff,
                        f"{fid}.edge",
                        start,
                        "edge",
                    )
                    if len(issues) != issue_count:
                        bound = None
                        reason = "Additional edge evidence falls outside the endpoint interval; only the bound native request and dispatch confirmation have timing exceptions."
            if bound:
                if bound.get("source") == "model_review" and not legacy_review:
                    bound.update(force=True, edge_key=signature, checked_after=document.get("revision_of"))
                if bound.get("source") != "model_review":
                    bound["source"] = (
                        "native_evidence" if automatic_edges else "model_edge"
                    )
                edges.append(bound)
            else:
                if force_eligible:
                    force_eligible, next_call = call_window(engine, agent["key"], cutoff, start, target["at"])
                    if not force_eligible:
                        reason = (f"No tool call/return owned by {agent['key']} inside [{iso(start)}, {iso(cutoff)}]; force cannot anchor here. "
                                  f"Next recorded call by report cutoff: {iso(next_call)}. Node at is a history cutoff, not its last write time. "
                                  "If you meant a later interaction, correct the endpoint cutoff and submit that connection normally first.")
                unverified.append({**edge, "finding": fid, "diagnostic": reason,
                    "edge_key": signature, "force_eligible": force_eligible})
    if is_compact:
        bind_node_evidence(engine, nodes, edges)
        reviewed_nodes = {e[k] for e in edges if e.get("source") == "model_review" and e.get("force")
                          for k in ("from", "to")}
        positions = {"card:" + n["id"]: i for i, n in enumerate(document["findings"][0]["nodes"])}
        for node in nodes:
            if node.get("existence_basis") != "unverified":
                continue
            if node["id"] in reviewed_nodes:
                node["existence_basis"] = "model_review"
            else:
                issues.append({"where": f"nodes[{positions[node['id']]}]", "code": "unrecorded_file",
                    "key": node["key"], "at": node["at"],
                    "query": {"op": "catalog", "kind": "file", "q": node["key"].replace("\\", "/").rsplit("/", 1)[-1]},
                    "error": "File node has no recorded evidence and no accepted incident force edge.",
                    "next_step": "Check the path first. If an original call really accessed this file, use its "
                                 "source/line on the unchanged edge only after force_eligible feedback. "
                                 "Do not add node fields or invent an agent; otherwise correct or remove the claim."})
    from .narrative import validate as validate_narrative

    if not is_compact:
        validate_narrative(document)
    check_results = bind_checks(engine, document, nodes, issues)
    for field in ("summary", "recommendations"):
        verify_text(document.get(field), timestamp(target["at"], required=True), field)
    verify_text(
        document.get("unexplained"),
        timestamp(target["at"], required=True),
        "unexplained",
    )
    missing_links = []
    paths = {n["key"] for n in nodes if n["kind"] == "file"} | {
        engine.store.resolve_file(target["file"])
    }
    connected = {edge["operation"] for edge in edges}
    cutoff = timestamp(target["at"], required=True)
    for path in sorted(paths):
        for operation in engine.relations("file", path, cutoff):
            if (
                operation["id"] in connected
                or operation["op"] not in ("read", "write")
                or not referenced.intersection(
                    {operation["request"], operation["result"]}
                )
                or not operation["agent"]
            ):
                continue
            # Suggest only already-cited native relationships, not new causal answers.
            missing_links.append(engine.link_view(operation, iso(cutoff)))
    coverage = reconcile(engine, target, document, explained_changes)
    result = {
        "schema": "inquiry-graph/1",
        "document": document,
        "target": target,
        "nodes": nodes,
        "edges": edges,
        "unverified_edges": unverified,
        "issues": issues,
        "semantic_verified": False,
        "mechanical_status": "needs_revision"
        if issues
        or unverified
        or (not is_compact and coverage["unattributed_native_writes"])
        or coverage["issues"]
        else "valid",
        "missing_evidence_links": missing_links,
        "coverage": coverage,
        "evidence_review": review(engine, document, target, nodes),
        "check_results": check_results,
        "source_sha256": digest(text.encode()),
        "trace_session": engine.session,
        "submission_policy": "checked-force/1",
        "force_permissions": sorted(allowed_force),
        "note": "Reasons are model claims. Bound references/operations are not causal proof.",
    }
    if is_compact:
        result.update(submission_format="coordinates/1", submitted_document=submitted,
                      revision_parent=document.get("revision_of"))
        from .feedback import coordinate_feedback
        coordinate_feedback(engine, result)
    result["tree"] = evidence_paths(engine, result)
    from .feedback import path_feedback
    result["path_feedback"] = path_feedback(result)
    result["path_status"] = "complete" if result["tree"]["complete"] else "needs_path"
    if is_compact:
        result["delivery"] = delivery_status(result)
    if _legacy_reviews:
        result.pop("submission_policy")  # Historical cards do not acquire a fictitious first-check receipt.
    if save:
        identity = uuid.uuid4().hex[:16]
        with engine.store.db:
            engine.store.db.execute(
                "INSERT INTO runs VALUES(?,?,?,?,?)",
                (identity, "report", text, encode(result), ""),
            )
        result["report_id"] = identity
    return result


def load_report(engine, identity, *, recheck=True):
    """Recheck the original document, without saving another report or route."""
    rows = engine.store.rows(
        "SELECT request,data FROM runs WHERE id=? AND kind='report'", (identity,)
    )
    if len(rows) != 1:
        raise ValueError("report not found")
    saved = json.loads(rows[0]["data"])
    if saved["source_sha256"] != digest(rows[0]["request"].encode()):
        raise ValueError("stored report no longer matches its original document")
    if not recheck:
        return {**saved, "report_id": identity}
    from .engine import Engine

    result = check(
        Engine(engine.store, session=saved["trace_session"]), rows[0]["request"],
        _legacy_reviews="submission_policy" not in saved,
        _compact_parent=saved.get("revision_parent"),
    )
    result["report_id"] = identity
    return result
