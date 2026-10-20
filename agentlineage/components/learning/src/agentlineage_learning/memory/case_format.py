"""The formal card format. Authoring YAML is independent of persistence.

Only the authored graph is persisted. Bound operations are display-time data.
Shared-context handling exists only for reading older case/3 cards.
"""
from __future__ import annotations

from typing import Any

import copy
import os
import tempfile
from datetime import datetime
from pathlib import Path, PurePosixPath

from .common import fingerprint, load
from .lean_card import SCHEMA, metadata_of

SHARED_SCHEMA = "migloop-case/3"
CONTENT = ("title", "when", "description", "summary", "recommendations", "unknown", "unresolved_targets")
PRESENTATION_ORDER = (
    "schema", "id", "created_at", "migration_key",
    "title", "when", "description", "summary",
    "recommendations", "changes", "participants", "graphs",
    "unknown", "unresolved_targets",
    "job", "metadata", "identity_basis", "context", "references", "packager", "check", "revision",
)


def presentation(card):
    """Order top-level fields for reading; preserve every value and list order.

Revisions use canonical sorted-key JSON, so presentation is not a new revision.
Unrecognized extension fields remain intact instead of being silently omitted.
"""
    keys = (*PRESENTATION_ORDER, *(key for key in card if key not in PRESENTATION_ORDER))
    return {key: copy.deepcopy(card[key]) for key in keys if key in card}


def content(card):
    if card.get("schema") == SCHEMA:
        return {k: copy.deepcopy(card[k]) for k in (*CONTENT, "graphs") if k in card}
    if card.get("schema") != SHARED_SCHEMA:
        return copy.deepcopy(card["draft"])
    result = {k: copy.deepcopy(card[k]) for k in CONTENT if k in card}
    refs = card["references"]
    result["graphs"] = []
    for graph in card["graphs"]:
        value = {k: copy.deepcopy(v) for k, v in graph.items() if k not in ("nodes", "edges")}
        value["target"].pop("resolved", None)
        value["nodes"] = [{k: copy.deepcopy(v) for k, v in n.items() if k != "resolved"}
                          for n in graph["nodes"] if not n.get("derived")]
        value["edges"] = []
        for edge in graph["edges"]:
            if edge.get("derived"):
                continue
            item = {k: copy.deepcopy(v) for k, v in edge.items() if k != "operations"}
            if "evidence" in item:
                item["evidence"] = [copy.deepcopy(refs[r]) for r in item["evidence"]]
            value["edges"].append(item)
        result["graphs"].append(value)
    return result


def claims(card):
    value = content(card)
    return {"diagnosis": {"text": value["summary"], "kind": "diagnosis", "status": "model_claim"},
            **{f"recommendation:{i}": {"text": text, "kind": "recommendation", "status": "model_claim"}
               for i, text in enumerate(value["recommendations"], 1)}}


def _digest(value):
    if not isinstance(value, str) or len(value) != 64 or any(c not in "0123456789abcdef" for c in value):
        raise ValueError("Invalid shared session fingerprint")
    return value


def shared_objects(card, directory):
    """Resolve only fixed content-addressed names, never a path supplied by a card."""
    if card.get("schema") != SHARED_SCHEMA:
        return {}
    objects = {}
    for key, digest in card["context"].items():
        _digest(digest)
        path = Path(directory) / (digest + ".json")
        if not path.is_file():
            raise ValueError(f"Missing shared session metadata ({key}): {path}; copy the card's sessions directory with it")
        obj = load(path)
        if fingerprint(obj) != digest:
            raise ValueError(f"Shared session metadata hash mismatch: {key} {digest}")
        objects[digest] = obj
    context(card, objects)
    return objects


def context(card, objects):
    if card.get("schema") == SCHEMA:
        meta = card["metadata"]
        targets = [g["target"] for g in card["graphs"]]
        return {"provenance": {"migration": meta.get("migration", {}), "analysis": meta.get("analysis", {}),
                "materials": meta.get("transcript_root", ""),
                "observed": meta.get("observed_in_materials", {}), "source_set_id": meta.get("source_set_id")},
                "scope": {"generation_end": targets[0].get("since"), "observation_end": targets[0]["at"]},
                "environment": {"facts": copy.deepcopy(meta.get("environment", []))}}
    if card.get("schema") != SHARED_SCHEMA:
        return {k: copy.deepcopy(card.get(k, {})) for k in ("provenance", "scope", "environment")}
    values = {}
    for key, digest in card["context"].items():
        obj = objects.get(_digest(digest))
        if (obj is None or fingerprint(obj) != digest or obj.get("kind") != key
                or obj.get("schema") != "migloop-session-context/1"):
            raise ValueError(f"Missing/mismatched shared session object: {key} {digest}")
        values[key] = copy.deepcopy(obj["value"])
    values["provenance"]["sources"] = values.pop("sources")
    return values


def write_shared(directory, objects):
    if not objects:
        return
    Path(directory).mkdir(parents=True, exist_ok=True)
    for digest, obj in objects.items():
        if fingerprint(obj) != _digest(digest):
            raise ValueError("Cannot publish shared metadata under a different fingerprint")
        path = Path(directory) / (digest + ".json")
        # Publish a complete immutable file atomically, including concurrent pack
        # workers. A reader must never observe another worker's partial JSON.
        fd, temporary_name = tempfile.mkstemp(prefix=".session-", dir=directory)
        os.close(fd)
        temporary = Path(temporary_name)
        try:
            import json
            temporary.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            try:
                os.link(temporary, path)
            except FileExistsError:
                if load(path) != obj:
                    raise ValueError(f"Existing shared metadata differs: {path}")
        finally:
            temporary.unlink()


def _instant(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _matches(declared, bound, aliases):
    if _instant(declared["at"]) != _instant(bound["at"]):
        return False
    left, right = declared["key"].replace("\\", "/"), bound["key"].replace("\\", "/")
    if left == right:
        return True
    if bound["kind"] != "agent":
        return False
    name = PurePosixPath(left).name
    names = {f"agent-{right}.jsonl", f"main-{right}.jsonl", f"{right}.jsonl"}
    if ":" in right:
        session, agent = right.rsplit(":", 1)
        names.add(f"main-{session}.jsonl" if agent == "main" else f"agent-{agent}.jsonl")
    return name in names or right in aliases.get(left, set())


def _merge_graph(graph, evidence, refs, aliases):
    result = copy.deepcopy(graph)
    bound_nodes = {n["id"]: n for n in evidence.get("nodes", [])}
    mapping: dict[Any, Any]
    mapping = {}
    # Match identities, not array positions. Derived nodes/edges remain in this
    # same graph and are excluded only from the authoring projection.
    for endpoint, declared in [*enumerate(result["nodes"], 1), ("target", result["target"])]:
        matches = [n for n in bound_nodes.values() if _matches(declared, n, aliases)]
        if len(matches) > 1:
            raise ValueError(f"Ambiguous checked node mapping: {declared['key']} @ {declared['at']}")
        if matches:
            node = matches[0]
            mapping.setdefault(node["id"], endpoint)
            resolved = {k: copy.deepcopy(node[k]) for k in ("kind", "existence_basis") if k in node}
            if node["key"] != declared["key"]:
                resolved["key"] = node["key"]
            declared["resolved"] = resolved
    for nid, node in bound_nodes.items():
        if nid not in mapping:
            result["nodes"].append({k: copy.deepcopy(v) for k, v in node.items() if k != "id"} | {"derived": True})
            mapping[nid] = len(result["nodes"])

    def reference(value):
        if value not in refs:
            refs.append(copy.deepcopy(value))
        return refs.index(value)

    by_pair = {}
    for edge in result["edges"]:
        pair = (edge["from"], edge["to"])
        if pair in by_pair:
            raise ValueError("Duplicate authored edges cannot be mapped unambiguously")
        by_pair[pair] = edge
        edge["operations"] = []
        if "evidence" in edge:
            edge["evidence"] = [reference(r) for r in edge["evidence"]]
    for bound in evidence.get("edges", []):
        try:
            pair = (mapping[bound["from"]], mapping[bound["to"]])
        except KeyError as exc:
            raise ValueError("Checked edge has an undeclared endpoint") from exc
        edge = by_pair.get(pair)
        if edge is None:
            edge = {"from": pair[0], "to": pair[1], "derived": True, "operations": []}
            result["edges"].append(edge)
            by_pair[pair] = edge
        operation = {k: copy.deepcopy(bound[k]) for k in ("relation", "at", "source", "strength") if k in bound}
        operation["evidence"] = [reference(r) for r in bound.get("evidence", [])]
        edge["operations"].append(operation)
    # No binding is discarded. An unbound authored edge may represent a path via
    # derived versions; its complete graph still carries every checked operation.
    return result


def finalize(card, objects=None):
    """Convert a passed legacy card without another model call or checker run."""
    from .card_contract import require_valid_card
    from .registry import revision_of, validate_case
    validate_case(card)
    if card["schema"] == SCHEMA:
        return presentation(card)
    require_valid_card(card)
    details, draft = context(card, objects or {}), content(card)
    result = {k: copy.deepcopy(card[k]) for k in ("id", "created_at", "job", "migration_key") if k in card}
    result.update(schema=SCHEMA, metadata=metadata_of(details, card.get("packager")), **draft)
    # Keep an address base only when the author used absolute transcript paths.
    root = details["provenance"].get("materials", "").replace("\\", "/").rstrip("/")
    coordinates = [n["key"] for g in draft["graphs"] for n in g["nodes"]]
    coordinates += [r["source"] for g in draft["graphs"] for e in g["edges"]
                    for r in e.get("evidence", []) if isinstance(r, dict)]
    if root and any(v.replace("\\", "/").startswith(root + "/") or v.replace("\\", "/") == root for v in coordinates):
        result["metadata"]["transcript_root"] = root
    result["revision"] = revision_of(result)
    validate_case(result)
    require_valid_card(result)
    if content(result) != draft or claims(result) != claims(card):
        raise ValueError("Card conversion changed authored content")
    return presentation(result)


def validate_formal(card):
    """Shape/integrity only. Historical relation checks remain in inquiry."""
    if card.get("schema") == SCHEMA:
        from .lean_card import validate
        validate(card)
        return
    from .card_contract import validate_draft
    if set(card) & {"draft", "claims", "graph_evidence", "validation", "validation_sha256", "provenance", "environment", "scope", "targets", "node_provenance"}:
        raise ValueError("Formal cards contain one graph and shared context references, not legacy copies")
    if set(card.get("context", {})) != {"provenance", "sources", "scope", "environment"}:
        raise ValueError("Formal card requires all shared context references")
    for digest in card["context"].values():
        _digest(digest)
    refs = card.get("references")
    if not isinstance(refs, list):
        raise ValueError("Formal card requires an evidence reference table")
    for ref in refs:
        if isinstance(ref, str) and ref:
            continue
        if (isinstance(ref, dict) and set(ref) == {"source", "line"}
                and isinstance(ref["source"], str) and ref["source"]
                and type(ref["line"]) is int and ref["line"] > 0):
            continue
        raise ValueError("Evidence table entries must be record IDs or {source, line} locators")
    for graph in card.get("graphs", []):
        for edge in graph.get("edges", []):
            for entry in [edge, *edge.get("operations", [])]:
                for ref in entry.get("evidence", []):
                    if type(ref) is not int or not 0 <= ref < len(refs):
                        raise ValueError("Graph contains an unresolved evidence reference")
            for endpoint in (edge.get("from"), edge.get("to")):
                if endpoint != "target" and (type(endpoint) is not int or not 1 <= endpoint <= len(graph["nodes"])):
                    raise ValueError("Graph contains an unresolved node reference")
    validate_draft(content(card))
    check = card.get("check", {})
    if (check.get("graphs_sha256") != fingerprint(card["graphs"])
            or check.get("references_sha256") != fingerprint(refs)
            or check.get("mechanical_status") != "valid" or check.get("path_status") != "complete"):
        raise ValueError("Formal card has no matching passed graph receipt; repack its YAML")
