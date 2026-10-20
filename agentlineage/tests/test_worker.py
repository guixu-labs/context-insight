from __future__ import annotations

import pytest

from agentlineage_learning.api import Learning
from agentlineage_learning.worker import Investigations
from test_learning_roundtrip import triage, draft


class FakeExecutor:
    def __init__(self):
        self.requests = []

    def execute(self, request, timeout):
        self.requests.append(request)
        return {"draft": draft(), "usage": {"input_tokens": 10, "output_tokens": 20}}


@pytest.fixture
def prepared(tmp_path, native_pool):
    learning = Learning(tmp_path / "learning")
    learning.initialize()
    investigation = learning.prepare("repair", [native_pool], triage())
    return learning, investigation


def budget(**overrides):
    return {"max_calls": 3, "max_attempts": 2, "timeout_seconds": 30,
            "max_tokens": 1000, **overrides}


def test_worker_checks_case_and_never_publishes_memory(prepared):
    learning, inv = prepared
    executor = FakeExecutor()
    worker = Investigations(learning, executor)
    job = worker.submit(inv["id"], budget())
    assert job["status"] == "queued"
    before = learning.memory.current()["revision"]
    result = worker.run(inv["id"])
    assert result["status"] == "draft_ready", result
    assert result["usage"]["calls"] == 1 and result["usage"]["tokens"] == 30
    assert result["cases"][0]["semantic_verified"] is False
    assert learning.memory.current()["revision"] == before


def test_no_usage_receipt_is_not_treated_as_free_execution(prepared):
    learning, inv = prepared
    class MissingUsage:
        def execute(self, request, timeout):
            return {"draft": draft()}
    worker = Investigations(learning, MissingUsage())
    assert worker.submit(inv["id"], budget())["status"] == "queued"
    result = worker.run(inv["id"])
    assert result["status"] == "failed"
    assert result["error"]["code"] == "USAGE_UNKNOWN"
    assert result["cases"] == []


def test_budget_stops_before_a_second_model_call(prepared):
    learning, inv = prepared
    class InvalidDraft(FakeExecutor):
        def execute(self, request, timeout):
            self.requests.append(request)
            return {"draft": {"title": "bad"}, "usage": {"input_tokens": 10, "output_tokens": 20}}
    executor = InvalidDraft()
    worker = Investigations(learning, executor)
    assert worker.submit(inv["id"], budget(max_calls=1))["status"] == "queued"
    result = worker.run(inv["id"])
    assert result["status"] == "budget_exhausted"
    assert len(executor.requests) == 1
    assert result["attempts"][0]["feedback"]


def test_cancel_queued_and_missing_executor(prepared):
    learning, inv = prepared
    worker = Investigations(learning)
    assert worker.submit(inv["id"], budget())["status"] == "queued"
    assert worker.run(inv["id"])["status"] == "executor_unavailable"
    assert worker.cancel(inv["id"])["status"] == "cancelled"


def test_restart_requires_explicit_resume_without_spending_again(prepared):
    learning, inv = prepared
    executor = FakeExecutor()
    worker = Investigations(learning, executor)
    assert worker.submit(inv["id"], budget())["status"] == "queued"
    restarted = Investigations(learning, executor)
    assert restarted.get(inv["id"])["status"] == "interrupted"
    assert executor.requests == []
    restarted.resume(inv["id"])
    assert restarted.run(inv["id"])["status"] == "draft_ready"
