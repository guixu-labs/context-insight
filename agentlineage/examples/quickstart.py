"""Offline SDK example with synthetic native sessions; never calls a model."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from uuid import uuid4

from agentlineage_core.api import Core
from agentlineage_core.export import export_document
from agentlineage_learning.api import Learning

DATA = Path(__file__).with_name("data")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path,
                        default=Path(".work/examples") / ("sdk-" + uuid4().hex[:8]))
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    sources = [DATA / "generation.jsonl", DATA / "repair.jsonl"]

    core = Core(output / "core")
    imported = core.import_files("spacing-demo", sources)
    snapshot = imported["snapshot_id"]
    history = core.query(snapshot, {
        "op": "file", "key": "/demo/view.py",
        "at": "2026-01-01T00:00:09Z", "view": "relations",
    })["result"]
    lineage = core.file_lineage(snapshot, "/demo/view.py", "2026-01-01T00:00:09Z")
    assert history["total"] == 2, history
    assert lineage["takeovers"][0]["by"] == "demo-session:fixer", lineage
    (output / "report.html").write_text(export_document(core, snapshot), encoding="utf-8")

    learning = Learning(output / "learning")
    initial = learning.initialize()
    triage = json.loads((DATA / "triage.json").read_text(encoding="utf-8"))
    investigation = learning.prepare("spacing-demo", sources, triage)
    draft = json.loads((DATA / "case-draft.json").read_text(encoding="utf-8"))
    case = learning.pack_case(investigation["id"], investigation["jobs"][0]["id"], draft)
    assert case["status"] == "valid", case

    # These explicit calls illustrate a publisher's actions after reviewing a draft.
    state = learning.ingest([case["path"]], initial["revision"])
    published = learning.apply_proposal({
        "base_revision": state["revision"],
        "topic_descriptions": {"code": "Implementing requirements accurately"},
        "upsert": [{
            "title": "Preserve specified spacing", "topic": ["code"],
            "when": "Implementing explicit layout constraints",
            "why": "The recorded output differed from the stated requirement",
            "how": ["Compare the generated value with the requirement"],
            "status": "active",
            "evidence": [{"case": case["case_id"], "revision": case["revision"],
                          "claim": "diagnosis"}],
        }],
    })
    found = learning.search("spacing")
    assert found["total"] == 1, found
    knowledge = learning.export(output / "knowledge")
    result = {
        "fixture": "synthetic; supplied draft, no model call",
        "run_id": imported["run_id"], "snapshot_id": snapshot,
        "confirmed_writes": history["total"], "takeovers": lineage["takeovers"],
        "case_status": case["status"], "semantic_verified": case["semantic_verified"],
        "memory_revision": published["revision"], "retrieved_lessons": found["total"],
        "report": str(output / "report.html"), "knowledge": knowledge["entry"],
        "core_data": str(output / "core"), "learning_data": str(output / "learning"),
    }
    (output / "result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
