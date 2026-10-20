"""One authored-card contract: template shape and checked historical paths.

Prose is the investigator's judgment. This module does not interpret reasons,
require repair actors, or implement a second read/write checker.
"""
from datetime import datetime
import json

from .common import fields, fingerprint, nonempty, strings


class DraftError(ValueError):
    def __init__(self, issues):
        self.issues = issues
        super().__init__(json.dumps({"code": "invalid_draft", "issues": issues,
            "next_step": "Correct the listed fields and resubmit the same task; keep the existing investigation."},
            ensure_ascii=False))


def graph_shape(graph, where="graph"):
    """Collect template errors without inspecting natural-language assertions."""
    issues = []

    def check(action, location):
        try:
            action()
            return True
        except (ValueError, TypeError) as exc:
            issues.append({"where": location, "error": str(exc)})
            return False

    def time(value, location):
        try:
            if not isinstance(value, str):
                raise ValueError("Expected a timezone-aware ISO timestamp")
            result = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if result.tzinfo is None:
                raise ValueError("Historical timestamps must include a timezone")
            return result
        except ValueError as exc:
            issues.append({"where": location, "error": str(exc), "supplied": value})

    required = ("target", "summary", "recommendations", "nodes", "edges")
    if not check(lambda: fields(graph, required, required, where), where):
        return issues
    end = None
    if check(lambda: fields(graph["target"], ("key", "since", "at"), ("key", "at"), where + ".target"), where + ".target"):
        end = time(graph["target"]["at"], where + ".target.at")
        start = time(graph["target"]["since"], where + ".target.since") if graph["target"].get("since") is not None else None
        if start is not None and end is not None and start > end:
            issues.append({"where": where + ".target.since", "error": "Target since is later than at"})
        check(lambda: nonempty(graph["target"]["key"], "target.key"), where + ".target.key")
    check(lambda: nonempty(graph["summary"], "summary"), where + ".summary")
    check(lambda: strings(graph["recommendations"], "recommendations", empty=False), where + ".recommendations")
    if not isinstance(graph["nodes"], list) or not graph["nodes"] or not isinstance(graph["edges"], list):
        issues.append({"where": where, "error": "Declare nodes and from/to edges for the attribution path"})
        return issues
    for i, node in enumerate(graph["nodes"]):
        location = f"{where}.nodes[{i}]"
        if not check(lambda: fields(node, ("key", "at", "reason", "problem"), ("key", "at", "reason"), location), location):
            continue
        for key in ("key", "reason"):
            check(lambda: nonempty(node[key], key), location + "." + key)
        at = time(node["at"], location + ".at")
        if at is not None and end is not None and at > end:
            issues.append({"where": location + ".at", "error": "Node timestamp exceeds observation end", "supplied": node["at"]})
        if type(node.get("problem", False)) is not bool:
            issues.append({"where": location + ".problem", "error": "problem must be boolean"})
    if not any(isinstance(n, dict) and n.get("problem") is True for n in graph["nodes"]):
        issues.append({"where": where + ".nodes", "error": "Mark the input/output deviation node with problem: true; a context-only tree is not an attribution card"})
    for i, edge in enumerate(graph["edges"]):
        location = f"{where}.edges[{i}]"
        if not check(lambda: fields(edge, ("from", "to", "force", "reason", "evidence"), ("from", "to"), location), location):
            continue
        for key in ("from", "to"):
            endpoint = edge[key]
            if endpoint != "target" and (type(endpoint) is not int or not 1 <= endpoint <= len(graph["nodes"])):
                issues.append({"where": location + "." + key, "supplied": endpoint,
                               "error": "Use a declared 1-based node number or target"})
    return issues


def validate_draft(draft):
    """Return display graphs with inherited prose; never rewrite the author's draft."""
    required = ("title", "when", "description", "summary", "recommendations", "graphs")
    fields(draft, (*required, "unknown", "unresolved_targets"), required, "draft")
    for key in ("title", "when", "description", "summary"):
        nonempty(draft[key], "draft." + key)
    strings(draft["recommendations"], "draft.recommendations", empty=False)
    strings(draft.get("unknown", []), "draft.unknown")
    if not isinstance(draft["graphs"], list) or not draft["graphs"]:
        raise DraftError([{"where": "graphs", "error": "A card needs at least one checked attribution graph; keep an unfinished investigation as its YAML draft"}])
    if not isinstance(draft.get("unresolved_targets", []), list):
        raise DraftError([{"where": "unresolved_targets", "error": "Expected a list; use [] when none"}])
    graphs = [{"summary": draft["summary"], "recommendations": draft["recommendations"], **g}
              if isinstance(g, dict) else g for g in draft["graphs"]]
    issues = [e for i, g in enumerate(graphs) for e in graph_shape(g, f"graphs[{i}]")]
    if issues:
        raise DraftError(issues)
    return graphs


def validation_digest(validation):
    """Bind stable checker outcomes, not run IDs or diagnostic presentation."""
    return fingerprint([{
        "graph": checked.get("graph"),
        "draft_sha256": checked.get("draft_sha256"),
        "mechanical_status": checked.get("receipt", {}).get("mechanical_status"),
        "path_status": checked.get("receipt", {}).get("path_status"),
    } for checked in validation.get("graph_checks", [])])


def require_valid_card(card):
    """Admission contract shared by pack, ingest and lesson source binding.

The inquiry kernel checks actual relations before pack emits a card. Admission
checks the final shape and declared paths, not a retained receipt or a
second semantic review. Legacy formats still validate their historical binding.
"""
    from .case_format import SCHEMA, SHARED_SCHEMA, validate_formal
    if card.get("schema") in (SCHEMA, SHARED_SCHEMA):
        validate_formal(card)
        return
    draft = card.get("draft", {})
    validate_draft(draft)
    validation = card.get("validation", {})
    if card.get("validation_sha256") != validation_digest(validation):
        raise ValueError("Card lacks a matching revision-bound validation summary; run cases.py pack on the final YAML (do not edit its receipt)")
    checks = validation.get("graph_checks", [])
    if validation.get("graph_check") != "performed" or validation.get("mode") == "draft_only":
        raise ValueError("Card has no completed relation check; run cases.py pack on its YAML draft")
    if not isinstance(checks, list) or len(checks) != len(draft["graphs"]):
        raise ValueError("Every graph needs its own successful checker result; repack the final draft")
    for number, (graph, checked) in enumerate(zip(draft["graphs"], checks), 1):
        receipt = checked.get("receipt", {})
        if (checked.get("graph") != number or checked.get("draft_sha256") != fingerprint(graph)
                or receipt.get("mechanical_status") != "valid" or receipt.get("path_status") != "complete"
                or receipt.get("issues") or receipt.get("unverified_edges")):
            raise ValueError(f"Graph {number} is not a valid checked path for this draft; run cases.py pack and resolve its feedback. A repair actor is not required")
