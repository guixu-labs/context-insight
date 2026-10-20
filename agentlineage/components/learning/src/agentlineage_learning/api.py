"""Public SDK for preparing evidence-bound cases and publishing experience."""
from __future__ import annotations

from pathlib import Path
import re
from typing import Any
from uuid import uuid4

from agentlineage_core.api import Core
from agentlineage_core.paths import data_path

from . import __version__
from .memory.cases import dispatch, pack
from .memory.common import fingerprint, load, write_new
from .memory.provenance import collect
from .memory.publication import export_memory
from .memory.registry import Memory, validate_case
from .memory.retrieval import browse, read, search

Json = dict[str, Any]


class Learning:
    def __init__(self, directory: str | Path) -> None:
        self.root = data_path(directory)
        self.root.mkdir(parents=True, exist_ok=True)
        self.memory = Memory(self.root / "memory")
        self.evidence = Core(self.root / "evidence")

    def capabilities(self) -> Json:
        return {"component": "agentlineage-learning", "package_version": __version__,
                "features": ["case-packaging", "mechanical-feedback", "versioned-memory",
                             "lexical-retrieval", "offline-memory-export"],
                "semantic_verified": False, "model_execution": "explicit-executor-only"}

    def initialize(self) -> Json:
        return self.memory.init()

    def prepare(self, run_key: str, sources: list[str | Path], triage: Json) -> Json:
        source_ids = [self.evidence.upload_source(Path(path).read_bytes(), Path(path).name)["id"]
                      for path in sources]
        return self.prepare_sources(run_key, source_ids, triage)

    def prepare_sources(self, run_key: str, source_ids: list[str], triage: Json) -> Json:
        run = self.evidence.create_run(run_key)
        snapshot = self.evidence.create_snapshot(run["id"], source_ids)
        evidence = {"snapshot_id": snapshot["id"]}
        identity = "inv_" + uuid4().hex
        directory = self.root / "investigations" / identity
        directory.mkdir(parents=True)
        pool = directory / "materials"
        self.evidence.export_materials(evidence["snapshot_id"], pool)
        metadata_file = directory / "metadata.json"
        declaration = directory / "declaration.json"
        write_new(declaration, {"migration": {"id": run_key},
                               "analysis": {"source_revision": __version__}})
        write_new(metadata_file, collect(pool, declaration))
        tasks = {**triage, "schema": "migloop-repair-triage/1",
                 "scope": {**triage.get("scope", {}), "materials": [str(pool)]}}
        tasks_path = directory / "tasks.json"
        write_new(tasks_path, tasks)
        dispatch(tasks_path, metadata_file, directory / "dispatch")
        manifest = load(directory / "dispatch" / "jobs.json")
        value = {"id": identity, "run_key": run_key, "status": "prepared",
                 "snapshot_id": evidence["snapshot_id"], "jobs": [
                     {"id": job["id"], "title": job["title"], "targets": job["targets"]}
                     for job in manifest["jobs"]], "semantic_verified": False}
        write_new(directory / "investigation.json", value)
        return value

    def get_investigation(self, identity: str) -> Json:
        if not re.fullmatch(r"inv_[a-f0-9]{32}", identity):
            raise ValueError("Invalid investigation ID")
        return load(self.root / "investigations" / identity / "investigation.json")

    def pack_case(self, identity: str, job_id: str, draft: Json) -> Json:
        investigation = self.get_investigation(identity)
        if not any(job["id"] == job_id for job in investigation["jobs"]):
            raise ValueError("Job does not belong to this investigation")
        directory = self.root / "investigations" / identity
        job = directory / "dispatch" / "jobs" / job_id / "job.json"
        output = directory / "cards" / job_id / fingerprint(draft)
        output.mkdir(parents=True, exist_ok=True)
        draft_path, card_path = output / "draft.json", output / "card.json"
        if card_path.exists():
            card = load(card_path)
            validate_case(card)
            return {"status": "valid", "case_id": card["id"], "path": str(card_path),
                    "revision": card["revision"], "semantic_verified": False, "reused": True}
        if not draft_path.exists():
            write_new(draft_path, draft)
        result = pack(job, draft_path, card_path)
        if result.get("status") == "valid":
            card = load(card_path)
            result.update(case_id=card["id"], path=str(card_path), revision=card["revision"],
                          semantic_verified=False)
        return result

    def ingest(self, paths: list[str | Path], expected_revision: str) -> Json:
        return self.memory.ingest(paths, expected_revision)

    def apply_proposal(self, proposal: Json) -> Json:
        return self.memory.apply(proposal)

    def search(self, query: str, topic: str = "", offset: int = 0, limit: int = 8) -> Json:
        result = search(self.memory, query, topic, offset, limit)
        return {**result, "semantic_verified": False, "retrieval_method": "lexical"}

    def browse(self, topic: str = "", offset: int = 0, limit: int = 8) -> Json:
        return browse(self.memory, topic, offset, limit)

    def read_lessons(self, identities: list[str]) -> Json:
        return read(self.memory, identities)

    def get_case(self, identity: str, revision: str | None = None) -> Json:
        return self.memory.case(identity, revision)

    def impact(self, identity: str, claim: str | None = None) -> Json:
        return self.memory.impact(identity, claim)

    def withdraw(self, identity: str, reason: str, expected_revision: str,
                 claim: str | None = None) -> Json:
        return self.memory.withdraw(identity, reason, expected_revision, claim)

    def export(self, output: str | Path) -> Json:
        return export_memory(self.memory, output)
