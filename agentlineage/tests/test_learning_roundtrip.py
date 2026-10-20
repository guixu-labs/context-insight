from __future__ import annotations

import json

import pytest

from agentlineage_learning.api import Learning
from conftest import timestamp


def triage():
    return {"scope": {"project_roots": ["/project"], "generation_end": timestamp(5),
                       "observation_end": timestamp(9)},
            "issues": [{"title": "Spacing mismatch", "changes": [
                {"files": ["/project/view.py"], "change": "8 to 4",
                 "evidence": ["worker.jsonl:L5-L6"]}]}]}


def draft():
    return {"title": "Spacing mismatch", "when": "Implementing explicit constraints",
            "description": "Synthetic regression case", "summary": "Wrong value later corrected",
            "recommendations": ["Preserve the specified spacing"], "unknown": [],
            "graphs": [{"target": {"key": "/project/view.py", "since": timestamp(5), "at": timestamp(9)},
                        "nodes": [{"key": "/project/spec.md", "at": timestamp(2), "reason": "input"},
                                  {"key": "session-1:worker-1", "at": timestamp(4),
                                   "reason": "different value", "problem": True}],
                        "edges": [{"from": 1, "to": 2}, {"from": 2, "to": "target"}]}]}


@pytest.fixture
def packed(tmp_path, native_pool):
    learning = Learning(tmp_path / "learning")
    initial = learning.initialize()
    investigation = learning.prepare("generic-task", [native_pool], triage())
    result = learning.pack_case(investigation["id"], investigation["jobs"][0]["id"], draft())
    assert result["status"] == "valid", result
    return learning, initial, investigation, result


def test_native_evidence_case_memory_and_recall_without_host(packed):
    learning, initial, investigation, result = packed
    assert result["semantic_verified"] is False
    state = learning.ingest([result["path"]], initial["revision"])
    card = json.loads(__import__("pathlib").Path(result["path"]).read_text(encoding="utf-8"))
    lesson = {"title": "Preserve specified spacing", "topic": ["code"],
              "when": "Implementing layout constraints", "why": "Output deviated from the input",
              "how": ["Read and preserve the recorded spacing"], "status": "active",
              "evidence": [{"case": card["id"], "revision": card["revision"], "claim": "diagnosis"}]}
    published = learning.apply_proposal({"base_revision": state["revision"], "upsert": [lesson]})
    found = learning.search("spacing")
    assert found["revision"] == published["revision"]
    assert found["total"] == 1
    assert found["semantic_verified"] is False
    assert found["retrieval_method"] == "lexical"
    again = learning.pack_case(investigation["id"], investigation["jobs"][0]["id"], draft())
    assert again["revision"] == result["revision"] and again["reused"]
    assert learning.get_case(card["id"])["revision"] == card["revision"]
    impact = learning.impact(card["id"])
    assert len(impact["all"]) == 1
    withdrawn = learning.withdraw(card["id"], "New contradictory evidence", published["revision"])
    assert len(withdrawn["affected"]) == 1
    assert learning.search("spacing")["total"] == 0
    state = learning.memory.current()
    assert next(iter(state["lessons"].values()))["status"] == "needs_review"
    learning.ingest([result["path"]], state["revision"])
    assert learning.memory.current()["cases"][card["id"]]["status"] == "withdrawn"


def test_stale_memory_revision_cannot_overwrite_newer_version(packed):
    learning, initial, _, result = packed
    learning.ingest([result["path"]], initial["revision"])
    with pytest.raises(ValueError, match="Stale"):
        learning.apply_proposal({"base_revision": initial["revision"], "upsert": []})
