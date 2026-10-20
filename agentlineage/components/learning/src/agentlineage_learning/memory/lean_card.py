"""Final cards contain the authored analysis and small historical labels only."""

from typing import Any
import copy

SCHEMA = "migloop-case/4"


def metadata_of(context, packager=None):
    provenance = context.get("provenance", {})
    allowed = ("id", "server_session_id", "root_session_ids", "project", "platforms", "models",
               "provider", "tool_versions", "skill_versions", "runtime_versions", "source_revision")
    result = {key: {k: copy.deepcopy(v) for k, v in provenance.get(key, {}).items()
                    if k in allowed and v} for key in ("migration", "analysis")}
    # Pool labels are not a claim about the model of any particular blamed node.
    result["observed_in_materials"] = {k: copy.deepcopy(v) for k, v in provenance.get("observed", {}).items()
                                       if k in ("platforms", "models", "providers", "client_versions") and v}
    for key in ("source_set_id", "db_root_session_id"):
        if provenance.get(key):
            result[key] = provenance[key]
    result["environment"] = copy.deepcopy(context.get("environment", {}).get("facts", []))
    if packager and packager.get("version"):
        result["card_tool_version"] = packager["version"]
    return {k: v for k, v in result.items() if v}


def validate(card):
    from .case_format import CONTENT, content
    from .card_contract import validate_draft
    allowed = {"schema", "id", "created_at", "job", "migration_key", "metadata", "revision", "graphs", *CONTENT}
    if set(card) - allowed:
        raise ValueError("Final cards contain authored fields and metadata only; no receipts or derived payloads")
    if not isinstance(card.get("metadata"), dict):
        raise ValueError("Final card requires metadata (an empty object is allowed)")
    validate_draft(content(card))
    # Pure shape check. Historical relations are checked by pack and rebuilt
    # against the original session for display, not certified by a saved receipt.
    for number, graph in enumerate(card["graphs"], 1):
        adjacent: dict[Any, Any]
        adjacent = {}
        for edge in graph["edges"]:
            adjacent.setdefault(edge["from"], []).append(edge["to"])
        pending = [i for i, node in enumerate(graph["nodes"], 1) if node.get("problem")]
        seen = set()
        while pending:
            node = pending.pop()
            if node == "target":
                break
            if node not in seen:
                seen.add(node)
                pending.extend(adjacent.get(node, []))
        else:
            raise ValueError(f"Graph {number}: no declared deviation path reaches the target")
