"""Small persistent cards; raw checker replies are optional debugging output."""
from __future__ import annotations

from typing import Any

import copy
import json
from pathlib import Path, PurePosixPath

from .common import fingerprint, write_new


def check_summary(receipt):
    """Keep outcomes and actionable errors, never the expanded document/coverage."""
    keys = ("schema", "report_id", "mechanical_status", "path_status", "status", "error", "code",
            "semantic_verified", "submission_format", "issues", "path_feedback")
    summary = {k: copy.deepcopy(receipt[k]) for k in keys if k in receipt}
    if "delivery" in receipt:
        summary["delivery"] = {k: receipt["delivery"][k] for k in
                               ("status", "semantic_verified", "coverage_verified") if k in receipt["delivery"]}
    if receipt.get("unverified_edges"):
        summary["unverified_edges"] = [
            {k: copy.deepcopy(edge[k]) for k in ("from", "to", "code", "diagnostic", "force_eligible", "next_call",
                "where", "coordinates", "nearby_operations", "operation_count", "inspect", "next_step")
             if k in edge} for edge in receipt["unverified_edges"]]
    if "path_feedback" not in receipt:
        # Old persisted receipts predate the shared diagnostic projection.
        tree = receipt.get("tree", {})
        diagnostics = list(dict.fromkeys(p["diagnostic"] for p in
                           tree.get("paths", []) + tree.get("context_paths", []) if p.get("diagnostic")))
        if diagnostics:
            summary["path_diagnostics"] = diagnostics
    return summary


def compact_card(card):
    """Preserve authored content exactly; replace session inventories/debug replies."""
    from .registry import revision_of, validate_case
    validate_case(card)
    if card["schema"] in ("migloop-case/2", "migloop-case/3", "migloop-case/4"):
        return copy.deepcopy(card)
    result = copy.deepcopy({k: v for k, v in card.items()
                            if k not in ("provenance", "node_provenance", "validation", "revision")})
    result["schema"] = "migloop-case/2"
    metadata = card["provenance"]
    # Pool-level labels are useful for filtering, not a per-agent identity assertion.
    result["provenance"] = {"schema": "migloop-case-provenance/1", **{
        k: copy.deepcopy(metadata[k]) for k in
        ("materials", "db_root_session_id", "source_set_id", "collector", "observed", "migration", "analysis", "unknown")
        if k in metadata}}
    relevant = json.dumps([card["draft"], card.get("changes", []), card.get("participants", [])], ensure_ascii=False)
    result["provenance"]["sources"] = {
        s["source"]: s["sha256"] for s in metadata.get("sources", [])
        if PurePosixPath(s["source"].replace("\\", "/")).name in relevant}
    bindings, checks = [], []
    for checked in card.get("validation", {}).get("graph_checks", []):
        receipt = checked["receipt"]
        # Resolve native/model-reviewed evidence without copying reasons, quotes or code.
        edges = [{k: copy.deepcopy(e[k]) for k in
                  ("from", "to", "relation", "at", "source", "strength", "evidence", "quote_verified") if k in e}
                 for e in receipt.get("edges", [])]
        if edges:
            endpoints = {e[k] for e in edges for k in ("from", "to")}
            bindings.append({"graph": checked["graph"],
                             "nodes": [{k: n[k] for k in ("id", "kind", "key", "at", "existence_basis") if k in n}
                                       for n in receipt.get("nodes", []) if n["id"] in endpoints],
                             "edges": edges})
        checks.append({"graph": checked["graph"], "draft_sha256": checked["draft_sha256"],
                       "receipt": check_summary(receipt)})
    result["graph_evidence"] = bindings
    result["validation"] = {k: copy.deepcopy(v) for k, v in card.get("validation", {}).items() if k != "graph_checks"}
    result["validation"]["graph_checks"] = checks
    result["revision"] = revision_of(result)
    validate_case(result)
    return result


def compact_store(memory, out):
    """Migrate into a new directory, remapping every historical source binding."""
    from .registry import Memory
    from .case_format import finalize, content, claims, shared_objects
    out = Path(out).resolve()
    if out.exists() or out.is_relative_to(memory.root) or memory.root.is_relative_to(out):
        raise ValueError("Compact output must be a new directory outside the source store")
    head = memory.current()["revision"]
    states = {p.stem: memory.current(p.stem) for p in (memory.root / "snapshots").glob("*.json")}
    revision_map: dict[Any, Any]
    cards, card_map, snapshots, revision_map, objects = {}, {}, {}, {}, {}
    for state in states.values():
        for identity, item in state["cases"].items():
            key = (identity, item["revision"])
            if key not in card_map:
                original = memory.case(identity, item["revision"], state=state)
                objects.update(shared_objects(original, memory.root / "sessions"))
                packed = finalize(original, objects)
                assert content(packed) == content(original) and claims(packed) == claims(original)
                card_map[key] = packed["revision"]
                cards[(identity, packed["revision"])] = packed
    # Parent-first traversal, independent of file order. Reject cycles/broken history.
    pending = dict(states)
    while pending:
        ready = [key for key, s in pending.items() if s.get("parent") is None or s["parent"] in revision_map]
        if not ready:
            raise ValueError("Snapshot history has a cycle or missing parent")
        for key in ready:
            state = copy.deepcopy(pending.pop(key))
            state.pop("revision")
            if state.get("parent"):
                state["parent"] = revision_map[state["parent"]]
            for identity, item in state["cases"].items():
                item["revision"] = card_map[(identity, item["revision"])]
                for metadata_key in ("observed", "migration", "analysis"):
                    item.pop(metadata_key, None)
            for lesson in state["lessons"].values():
                for ref in lesson["evidence"]:
                    old_key = (ref["case"], ref["revision"])
                    if old_key not in card_map:
                        # A historical source may no longer be a case HEAD.
                        original = memory.case(*old_key, state=states[key])
                        objects.update(shared_objects(original, memory.root / "sessions"))
                        packed = finalize(original, objects)
                        card_map[old_key] = packed["revision"]
                        cards[(old_key[0], packed["revision"])] = packed
                    ref["revision"] = card_map[old_key]
            state["revision"] = fingerprint(state)
            revision_map[key] = state["revision"]
            snapshots[state["revision"]] = state
    # No output exists until all inputs and hashes have been checked.
    for (identity, revision), card in cards.items():
        write_new(out / "cases" / identity / (revision + ".json"), card)
    for revision, state in snapshots.items():
        write_new(out / "snapshots" / (revision + ".json"), state)
    write_new(out / "HEAD.json", {"revision": revision_map[head]})
    Memory(out).current()
    return {"store": str(out), "previous_revision": head, "revision": revision_map[head],
            "cards": len(cards), "snapshots": len(snapshots), "claims_changed": False,
            "case_revisions": [{"case": k[0], "from": k[1], "to": v} for k, v in sorted(card_map.items())],
            "source_changed": False}
