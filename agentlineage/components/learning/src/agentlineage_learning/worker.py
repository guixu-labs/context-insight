"""Budgeted draft investigation. Publication is an explicit, separate operation."""
from __future__ import annotations

from contextlib import contextmanager
import json
import logging
from pathlib import Path
import sqlite3
import subprocess
import threading
import time
from typing import Any, Iterator, Protocol

from .api import Learning
from .memory.common import load

LOG = logging.getLogger(__name__)


class Executor(Protocol):
    def execute(self, request: dict[str, Any], timeout: float) -> dict[str, Any]:
        """Return a draft plus measured input_tokens/output_tokens; respect timeout."""


class CommandExecutor:
    """Trusted administrator-supplied argv, never a command accepted from an API caller."""
    def __init__(self, argv: list[str]) -> None:
        if not argv or any(not isinstance(item, str) or not item for item in argv):
            raise ValueError("Executor requires a nonempty argv array")
        self.argv = argv

    def execute(self, request: dict[str, Any], timeout: float) -> dict[str, Any]:
        # The executor must own/terminate its descendants and enforce remaining token allowance.
        result = subprocess.run(self.argv, input=json.dumps(request), text=True, encoding="utf-8",
                                capture_output=True, timeout=timeout, check=False)
        if result.returncode:
            raise ValueError("Executor failed with exit code " + str(result.returncode))
        if len(result.stdout) > 8 * 1024 * 1024:
            raise ValueError("Executor output exceeds 8 MiB")
        value = json.loads(result.stdout)
        if not isinstance(value, dict):
            raise ValueError("Executor must return a JSON object")
        return value


class Investigations:
    def __init__(self, learning: Learning, executor: Executor | None = None) -> None:
        self.learning, self.executor = learning, executor
        self.lock = threading.RLock()
        with self.db() as db:
            db.execute("CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, value TEXT)")
            for identity, raw in db.execute("SELECT id,value FROM jobs").fetchall():
                value = json.loads(raw)
                if value["status"] in ("queued", "running", "cancel_requested"):
                    value["status"] = "interrupted"
                    value["error"] = {"code": "INTERRUPTED",
                                      "message": "Explicit resume required; in-flight cost may be unknown"}
                    db.execute("UPDATE jobs SET value=? WHERE id=?", (json.dumps(value), identity))

    @contextmanager
    def db(self) -> Iterator[sqlite3.Connection]:
        db = sqlite3.connect(self.learning.root / "jobs.sqlite", timeout=30)
        try:
            with db:
                yield db
        finally:
            db.close()

    def get(self, identity: str) -> dict[str, Any]:
        self.learning.get_investigation(identity)
        with self.db() as db:
            row = db.execute("SELECT value FROM jobs WHERE id=?", (identity,)).fetchone()
        if row is None:
            return self.learning.get_investigation(identity)
        return json.loads(row[0])

    def save(self, value: dict[str, Any]) -> None:
        with self.lock, self.db() as db:
            old = db.execute("SELECT value FROM jobs WHERE id=?", (value["id"],)).fetchone()
            if old and json.loads(old[0])["status"] == "cancel_requested":
                value["status"] = "cancelled" if value["status"] != "running" else "cancel_requested"
            db.execute("INSERT OR REPLACE INTO jobs VALUES(?,?)",
                       (value["id"], json.dumps(value, ensure_ascii=False)))

    def submit(self, identity: str, budget: dict[str, Any]) -> dict[str, Any]:
        bounds = {"max_calls": (1, 32), "max_attempts": (1, 5),
                  "timeout_seconds": (1, 3600), "max_tokens": (1, 1000000)}
        if set(budget) != set(bounds):
            raise ValueError("Budget requires max_calls, max_attempts, timeout_seconds and max_tokens")
        for key, (low, high) in bounds.items():
            if type(budget[key]) is not int or not low <= budget[key] <= high:
                raise ValueError("Invalid budget: " + key)
        with self.lock:
            existing = self.get(identity)
            if existing["status"] != "prepared":
                if existing.get("budget") != budget:
                    raise ValueError("Investigation already has a different budget")
                return existing
            value = {**existing, "status": "queued", "budget": budget,
                     "usage": {"calls": 0, "tokens": 0, "elapsed_seconds": 0.0},
                     "attempts": [], "cases": [], "in_flight": False}
            self.save(value)
            return value

    def cancel(self, identity: str) -> dict[str, Any]:
        with self.lock:
            value = self.get(identity)
            if value["status"] == "running":
                value["status"] = "cancel_requested"
            elif value["status"] in ("prepared", "queued", "interrupted", "executor_unavailable"):
                value["status"] = "cancelled"
            self.save(value)
            return value

    def resume(self, identity: str) -> dict[str, Any]:
        with self.lock:
            value = self.get(identity)
            if value["status"] not in ("interrupted", "executor_unavailable"):
                raise ValueError("Only interrupted or executor-unavailable work can resume")
            if value.get("in_flight"):
                raise ValueError("In-flight usage is unknown; reconcile executor receipt before new work")
            value.update(status="queued")
            value.pop("error", None)
            self.save(value)
            return value

    def run(self, identity: str) -> dict[str, Any]:
        with self.lock:
            value = self.get(identity)
            if value["status"] != "queued":
                return value
            if self.executor is None:
                value["status"] = "executor_unavailable"
                self.save(value)
                return value
            value["status"] = "running"
            value.setdefault("deadline_at", time.time() + value["budget"]["timeout_seconds"])
            self.save(value)
        started = time.monotonic()
        previous_seconds = value["usage"]["elapsed_seconds"]
        budget = value["budget"]
        directory = self.learning.root / "investigations" / identity

        def finish(status: str, error: dict[str, str] | None = None) -> dict[str, Any]:
            value["status"] = status
            value["usage"]["elapsed_seconds"] = previous_seconds + time.monotonic() - started
            if error:
                value["error"] = error
            self.save(value)
            return value

        try:
            for job in value["jobs"]:
                if any(case["job_id"] == job["id"] for case in value["cases"]):
                    continue
                attempts = [item for item in value["attempts"] if item["job_id"] == job["id"]]
                while len(attempts) < budget["max_attempts"]:
                    if self.get(identity)["status"] == "cancel_requested":
                        return finish("cancelled")
                    remaining = min(value["deadline_at"] - time.time(),
                                    budget["timeout_seconds"] - previous_seconds - (time.monotonic() - started))
                    if remaining <= 0 or value["usage"]["calls"] >= budget["max_calls"] or value["usage"]["tokens"] >= budget["max_tokens"]:
                        return finish("budget_exhausted")
                    request = {
                        "protocol": "agentlineage-executor/1", "stage": "case-draft",
                        "investigation_id": identity, "snapshot_id": value["snapshot_id"],
                        "job": load(directory / "dispatch" / "jobs" / job["id"] / "job.json"),
                        "evidence_directory": str(directory / "materials"),
                        "instructions": str(Path(__file__).parent / "instructions"),
                        "feedback": attempts[-1]["feedback"] if attempts else None,
                        "remaining_tokens": budget["max_tokens"] - value["usage"]["tokens"],
                        "deadline_seconds": remaining,
                    }
                    value["usage"]["calls"] += 1
                    value["in_flight"] = True
                    value["usage"]["elapsed_seconds"] = previous_seconds + time.monotonic() - started
                    self.save(value)
                    response = self.executor.execute(request, remaining)
                    usage = response.get("usage")
                    if not isinstance(usage, dict) or any(type(usage.get(key)) is not int or usage[key] < 0
                                                         for key in ("input_tokens", "output_tokens")):
                        return finish("failed", {"code": "USAGE_UNKNOWN",
                                                 "message": "Executor did not supply measured token usage"})
                    value["in_flight"] = False
                    value["usage"]["tokens"] += usage["input_tokens"] + usage["output_tokens"]
                    if self.get(identity)["status"] == "cancel_requested":
                        return finish("cancelled")
                    if value["usage"]["tokens"] > budget["max_tokens"] or time.time() >= value["deadline_at"] or time.monotonic() - started + previous_seconds >= budget["timeout_seconds"]:
                        return finish("budget_exhausted")
                    try:
                        packed = self.learning.pack_case(identity, job["id"], response["draft"])
                    except (ValueError, TypeError, KeyError) as exc:
                        packed = {"status": "invalid", "message": str(exc)}
                    attempt = {"job_id": job["id"], "number": len(attempts) + 1,
                               "feedback": packed, "usage": usage}
                    attempts.append(attempt)
                    value["attempts"].append(attempt)
                    value["usage"]["elapsed_seconds"] = previous_seconds + time.monotonic() - started
                    if packed.get("status") == "valid":
                        value["cases"].append({"job_id": job["id"], **packed})
                    self.save(value)
                    if packed.get("status") == "valid":
                        break
                else:
                    return finish("needs_revision")
            return finish("draft_ready")
        except Exception:
            LOG.exception("Investigation execution failed: %s", identity)
            return finish("failed", {"code": "EXECUTOR_FAILED",
                                     "message": "Inspect service log; usage may be unknown, no automatic retry"})
