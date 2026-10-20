from __future__ import annotations

import threading

import pytest

from agentlineage_learning.api import Learning
from agentlineage_learning.worker import Investigations
from test_learning_roundtrip import draft, triage
from test_worker import budget


def test_cancellation_waits_for_receipt_and_counts_spent_tokens(tmp_path, native_pool):
    started, release = threading.Event(), threading.Event()
    class ControlledExecutor:
        def execute(self, request, timeout):
            started.set()
            assert release.wait(5)
            return {"draft": draft(), "usage": {"input_tokens": 7, "output_tokens": 9}}
    learning = Learning(tmp_path)
    inv = learning.prepare("cancel", [native_pool], triage())
    worker = Investigations(learning, ControlledExecutor())
    worker.submit(inv["id"], budget())
    thread = threading.Thread(target=worker.run, args=(inv["id"],))
    thread.start()
    try:
        assert started.wait(5)
        assert worker.cancel(inv["id"])["status"] == "cancel_requested"
    finally:
        release.set()
        thread.join(10)
    value = worker.get(inv["id"])
    assert value["status"] == "cancelled" and value["usage"]["tokens"] == 16
    assert value["cases"] == []


def test_unknown_in_flight_cost_blocks_resume(tmp_path, native_pool):
    learning = Learning(tmp_path)
    inv = learning.prepare("interrupted", [native_pool], triage())
    worker = Investigations(learning)
    value = worker.submit(inv["id"], budget())
    value.update(status="running", in_flight=True)
    value["usage"]["calls"] = 1
    worker.save(value)
    restarted = Investigations(learning)
    with pytest.raises(ValueError, match="usage is unknown"):
        restarted.resume(inv["id"])


def test_mechanical_feedback_is_given_to_next_attempt(tmp_path, native_pool):
    seen = []
    class CorrectingExecutor:
        def execute(self, request, timeout):
            seen.append(request)
            return {"draft": {"title": "incomplete"} if len(seen) == 1 else draft(),
                    "usage": {"input_tokens": 10, "output_tokens": 20}}
    learning = Learning(tmp_path)
    inv = learning.prepare("feedback", [native_pool], triage())
    worker = Investigations(learning, CorrectingExecutor())
    worker.submit(inv["id"], budget())
    result = worker.run(inv["id"])
    assert result["status"] == "draft_ready", result
    assert seen[0]["feedback"] is None
    assert seen[1]["feedback"]["status"] == "invalid"
    assert seen[1]["remaining_tokens"] == 970
