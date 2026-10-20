"""Explicit recorded environment facts; domain-specific inference is opt-in."""
from __future__ import annotations

import copy
from datetime import datetime
from pathlib import Path

from .common import fingerprint, load, write_new

EXPECTED: tuple[str, ...] = ()


def _instant(value):
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return result if result.tzinfo else None
    except (AttributeError, ValueError):
        return None


class Observer:
    def __init__(self):
        self.observations = {}

    def observe(self, row, ref):
        metadata = row.get("metadata")
        facts = metadata.get("environment", []) if isinstance(metadata, dict) else []
        for value in facts if isinstance(facts, list) else []:
            if not isinstance(value, dict) or not all(isinstance(value.get(k), str) for k in ("name", "value")):
                continue
            fact = {"name": value["name"], "value": value["value"], "basis": "recorded_metadata",
                    "artifact": "", "cwd": row.get("cwd", ""), "ref": ref, "at": row.get("timestamp")}
            self.observations[(ref, fact["name"], fact["value"])] = fact


def for_card(metadata, scope):
    """Keep first evidence for each distinct observed value before the card's cutoff, not a global state claim."""
    end, generation = _instant(scope.get("observation_end")), _instant(scope.get("generation_end"))
    observations = [fact for source in metadata.get("sources", []) for fact in source.get("environment", [])]
    facts, selected_sources = {}, {}
    source_hashes = {source["source"]: source["sha256"] for source in metadata.get("sources", [])}
    skipped = 0
    for observation in sorted(observations, key=lambda f: (
            _instant(f.get("at")).timestamp() if _instant(f.get("at")) else float("inf"), f["ref"])):
        at = _instant(observation.get("at"))
        if at is None or end is None:
            skipped += 1
            continue
        if at > end:
            continue
        key = tuple(observation[k] for k in ("name", "value", "basis", "artifact", "cwd"))
        if key in facts:
            continue
        fact = copy.deepcopy(observation)
        fact["phase"] = "generation" if generation and at <= generation else "repair" if generation else "unknown"
        facts[key] = fact
        source = fact["ref"].rsplit(":L", 1)[0]
        selected_sources[source] = source_hashes[source]
    result = {"schema": "migloop-case-environment/1", "through": scope.get("observation_end"),
              "facts": list(facts.values()), "sources": selected_sources,
              "unknown": [key for key in EXPECTED if not any(f["name"] == key for f in facts.values())],
              "unscoped_observations": skipped,
              "boundary": "Recorded configuration/tool outputs, not a continuous environment state, resolved dependency proof, or lesson compatibility range. Missing values stay unknown; no current project files are read."}
    result["snapshot_id"] = fingerprint(result)
    return result


def enrich_cards(paths, metadata_path, out):
    """Create additive card revisions; preserve all authored claims, graph evidence and validation."""
    from .provenance import verify_materials
    from .registry import revision_of, validate_case
    from .case_format import SCHEMA, context, shared_objects, finalize

    metadata, output = load(metadata_path), Path(out).resolve()
    if metadata.get("schema") != "migloop-provenance/1":
        raise ValueError("Use triage metadata output for --metadata, not hand-authored environment values")
    if output.exists():
        raise ValueError("Enrichment output must be a new directory; existing cards are preserved")
    verify_materials(metadata)
    source_hashes = {s["source"]: s["sha256"] for s in metadata["sources"]}
    prepared, objects = [], {}
    for path in paths:
        card = load(path)
        validate_case(card)
        objects.update(shared_objects(card, Path(path).parent / "sessions"))
        card_context = context(card, objects)
        provenance = card_context["provenance"]
        if card["schema"] == SCHEMA:
            if provenance.get("source_set_id") != metadata.get("source_set_id"):
                raise ValueError(f"{card['id']}: environment material version differs from the card")
        elif Path(provenance.get("materials", "")).resolve() != Path(metadata["materials"]).resolve():
            raise ValueError(f"{card['id']}: environment pool differs from the card's migration materials")
        sources = provenance.get("sources", {})
        sources = sources if isinstance(sources, dict) else {s["source"]: s["sha256"] for s in sources}
        if card["schema"] != SCHEMA and (not sources or any(source_hashes.get(name) != digest for name, digest in sources.items())):
            raise ValueError(f"{card['id']}: original transcript hashes do not match; do not relabel another history")
        enriched = finalize(card, objects)
        facts = for_card(metadata, card_context["scope"])["facts"]
        if facts:
            enriched["metadata"]["environment"] = facts
        else:
            enriched["metadata"].pop("environment", None)
        enriched["revision"] = revision_of(enriched)
        validate_case(enriched)
        prepared.append((card, enriched))
    if not prepared or len({new["id"] for _, new in prepared}) != len(prepared):
        raise ValueError("Supply one existing card per identity")
    results = []
    for old, new in prepared:
        target = output / (new["id"] + ".json")
        write_new(target, new)
        results.append({"case": new["id"], "from": old["revision"], "to": new["revision"], "path": str(target)})
    return {"cards": results, "claims_changed": False, "source_cards_changed": False,
            "next": "Ingest as normal revisions; existing review gates still apply. Rebind lessons only after reviewing added context."}
