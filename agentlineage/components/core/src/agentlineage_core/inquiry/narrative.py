"""File-level synthesis and stopping claims; never synthesize model conclusions.

Optional in inquiry/1 for old-report compatibility. The case-card skill requires
them for new delivery. Shape, references and paths are not semantic approval.
"""

from typing import Any


def _object(value, fields, where):
    if not isinstance(value, dict) or set(value) != set(fields):
        raise ValueError(f"{where} requires exactly: {', '.join(fields)}")


def _text(value, where):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{where} must be nonempty text")


def _ids(value, available, where, *, empty=False):
    if (not isinstance(value, list) or any(not isinstance(v, str) for v in value)
            or len(value) != len(set(value)) or set(value) - available
            or not value and not empty):
        raise ValueError(f"{where} must name unique existing IDs" + (" (may be empty)" if empty else ""))


def validate(document):
    """Run after base findings/nodes have been validated; do not mutate the draft."""
    findings = {f["id"]: f for f in document["findings"]}
    if "summary" in document:
        summary = document["summary"]
        _object(summary, ("generation", "repair", "unknown", "findings"), "summary")
        for field in ("generation", "repair"):
            _text(summary[field], "summary." + field)
        if not isinstance(summary["unknown"], list):
            raise ValueError("summary.unknown must be a list of text")
        for value in summary["unknown"]:
            _text(value, "summary.unknown")
        _ids(summary["findings"], set(findings), "summary.findings", empty=not findings)
    if "recommendations" in document:
        recommendations = document["recommendations"]
        if not isinstance(recommendations, list) or len(recommendations) > 100:
            raise ValueError("recommendations must be a list of at most 100 items")
        for index, item in enumerate(recommendations):
            where = f"recommendations[{index}]"
            fields = ("target", "action", "reason", "validation", "findings")
            _object(item, fields, where)
            for field in fields[:-1]:
                _text(item[field], where + "." + field)
            _ids(item["findings"], set(findings), where + ".findings", empty=not findings)
    for fid, finding in findings.items():
        if "boundary" not in finding:
            continue
        boundary = finding["boundary"]
        where = fid + ".boundary"
        _object(boundary, ("status", "nodes", "reason"), where)
        if boundary["status"] not in ("supported_input", "not_generation_error", "unresolved"):
            raise ValueError(where + ".status must be supported_input, not_generation_error or unresolved")
        _text(boundary["reason"], where + ".reason")
        nodes = {n["id"]: n for n in finding.get("nodes", [])}
        _ids(boundary["nodes"], set(nodes), where + ".nodes", empty=boundary["status"] == "unresolved")
        if boundary["status"] == "supported_input" and not any(
                nodes[n]["role"] == "context" for n in boundary["nodes"]):
            raise ValueError(where + " must point to an explicit context/input judgment")


def review_gaps(graph):
    """Delivery gaps only. A connected, well-written boundary can still be wrong."""
    document = graph["document"]
    if graph.get("submission_format") == "coordinates/1":
        return [{"node": p["node"], "error": p["diagnostic"]}
                for p in graph["tree"]["paths"] + graph["tree"].get("context_paths", [])
                if p["status"] == "unclosed"]
    gaps: list[dict[str, Any]] = []
    if "summary" not in document:
        gaps.append({"error": "Add a file-level summary of generation, repairs and unknowns"})
    else:
        missing = {f["id"] for f in document["findings"]} - set(document["summary"]["findings"])
        if missing:
            gaps.append({"error": "summary does not account for all findings", "findings": sorted(missing)})
    if "recommendations" not in document:
        gaps.append({"error": "Add consolidated recommendations (or an explicit empty list with limitations in summary)"})
    paths = {p["node"]: p for p in graph["tree"]["paths"] + graph["tree"].get("context_paths", [])}
    for finding in document["findings"]:
        fid = finding["id"]
        boundary = finding.get("boundary")
        if not boundary:
            gaps.append({"finding": fid, "error": "State where and why this branch stops; local writer reachability is insufficient"})
        elif boundary["status"] == "unresolved":
            gaps.append({"finding": fid, "error": "Input/origin boundary remains unresolved", "reason": boundary["reason"]})
        else:
            for node in boundary["nodes"]:
                path = paths.get(fid + ":" + node)
                if not path or path["status"] == "unclosed":
                    gaps.append({"finding": fid, "node": node, "error": "Declared stopping evidence is not connected to this finding's target"})
    return gaps
