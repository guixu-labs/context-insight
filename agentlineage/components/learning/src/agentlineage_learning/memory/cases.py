"""Prepare issue jobs and enrich semantic drafts without altering their claims."""
from __future__ import annotations

from typing import Any

import argparse
import json
from pathlib import Path, PurePosixPath
from datetime import datetime

from .common import fields, fingerprint, load, nonempty, now, strings, write_new
from . import VERSION
from .provenance import collect, verify_materials, _bundle_hash
from .registry import revision_of
from .card_contract import DraftError, require_valid_card, validate_draft, validation_digest


def dispatch(tasks_path, metadata_path, out):
    tasks, metadata, out = load(tasks_path), load(metadata_path), Path(out).resolve()
    if tasks.get("schema") != "migloop-repair-triage/1" or metadata.get("schema") != "migloop-provenance/1":
        raise ValueError("Expected repair-triage/1 tasks and collected provenance/1 metadata")
    if out.exists():
        raise ValueError("Dispatch output must be a new directory; previous jobs are not overwritten")
    issues = tasks.get("issues")
    if not isinstance(issues, list) or not isinstance(tasks.get("scope"), dict):
        raise ValueError("Task scope and issue list required")
    materials = tasks["scope"].get("materials", [])
    if not isinstance(materials, list) or str(Path(metadata["materials"]).resolve()) not in {
            str(Path(p).resolve()) for p in materials if isinstance(p, str)}:
        raise ValueError("Task materials do not match the collected provenance pool; do not bind unrelated sessions")
    declared = metadata.get("migration", {})
    # Identity is not a hash of mutable evidence. Server IDs survive cloud imports;
    # local inputs use the stable scope location and explicitly retain that limit.
    migration_key = declared.get("id") or declared.get("server_session_id")
    identity_basis = "server migration ID"
    if not migration_key:
        migration_key = str(Path(metadata["materials"]).resolve())
        identity_basis = "local material location; preserve job ID across relocation/retitling"
        if metadata.get("db_root_session_id"):
            migration_key += "#session=" + metadata["db_root_session_id"]
            identity_basis = "local DB location + explicit root session; preserve job ID across relocation/retitling"
    prepared, titles = [], set()
    for number, issue in enumerate(issues, 1):
        nonempty(issue.get("title"), f"issue {number}.title")
        if issue["title"] in titles:
            raise ValueError("Issue titles must distinguish tasks within a migration; duplicate title is ambiguous")
        titles.add(issue["title"])
        if not isinstance(issue.get("changes"), list) or not issue["changes"]:
            raise ValueError(f"issue {number}: changes required")
        targets = sorted({p for change in issue["changes"]
                          for p in strings(change.get("files"), "changes.files", empty=False)})
        job_id = "issue-" + fingerprint([migration_key, issue["title"]])[:20]
        job = {"schema": "migloop-issue-job/1", "id": job_id, "scope": tasks["scope"],
               "issue": issue, "targets": targets, "pending": tasks.get("pending", []),
               "provenance_path": "../../provenance.json", "provenance_sha256": fingerprint(metadata),
               "identity_basis": identity_basis, "migration_key": migration_key}
        prepared.append((job_id, job))
    out.mkdir(parents=True)
    write_new(out / "provenance.json", metadata)
    jobs = []
    for job_id, job in prepared:
        path = out / "jobs" / job_id / "job.json"
        write_new(path, job)
        # A short prompt; task detail lives in the frozen job, not a rich answer-bearing prompt.
        prompt = "使用 $migloop-build-cards 的单问题制卡流程。\n任务：" + str(path) + "\n"
        path.with_name("prompt.txt").write_text(prompt, encoding="utf-8")
        jobs.append({"id": job_id, "title": job["issue"]["title"], "job": str(path), "targets": job["targets"]})
    manifest = {"schema": "migloop-card-jobs/1", "jobs": jobs,
                "set_aside": tasks.get("set_aside", []), "pending": tasks.get("pending", []),
                "coverage": tasks.get("coverage", {}), "model_calls": 0}
    write_new(out / "jobs.json", manifest)
    return {"jobs": len(jobs), "manifest": str(out / "jobs.json"), "model_calls": 0}


def _absolute(path, scope):
    path = path.replace("\\", "/")
    if path.startswith("/") or len(path) > 2 and path[1] == ":":
        return path
    roots = scope.get("project_roots", [])
    if len(roots) != 1:
        raise ValueError("Relative target needs exactly one historical project root")
    return str(PurePosixPath(roots[0].replace("\\", "/")) / path)


def pack(job_path, draft_path, out, db=None, debug_receipts=None):
    job_path, out = Path(job_path).resolve(), Path(out).resolve()
    job, draft = load(job_path), load(draft_path)
    if job.get("schema") != "migloop-issue-job/1":
        raise ValueError("Expected a dispatch-created issue job")
    metadata = load(job_path.parent / job["provenance_path"])
    if fingerprint(metadata) != job["provenance_sha256"]:
        raise ValueError("Frozen job provenance changed; recollect and create a new job")
    verify_materials(metadata)
    graphs = validate_draft(draft)
    expected = {_absolute(p, job["scope"]) for p in job["targets"]}
    covered, unresolved = set(), set()
    for i, graph in enumerate(graphs):
        target = _absolute(graph["target"]["key"], job["scope"])
        if target not in expected or target in covered:
            raise ValueError("Graph targets must be distinct members of this issue, not another issue's files")
        for field, scope_field in (("since", "generation_end"), ("at", "observation_end")):
            supplied, expected_time = graph["target"].get(field), job["scope"].get(scope_field)
            def instant(value):
                return datetime.fromisoformat(value.replace("Z", "+00:00")) if value is not None else None
            if instant(supplied) != instant(expected_time):
                raise DraftError([{"where": f"graphs[{i}].target.{field}", "supplied": supplied,
                                   "expected": expected_time, "error": f"graph.target.{field} must preserve the dispatched task window"}])
        covered.add(target)
    for item in draft.get("unresolved_targets", []):
        fields(item, ("key", "reason"), ("key", "reason"), "unresolved target")
        nonempty(item["reason"], "unresolved target reason")
        target = _absolute(item["key"], job["scope"])
        if target not in expected or target in covered or target in unresolved:
            raise ValueError("Unresolved targets must be distinct issue targets without a graph")
        unresolved.add(target)
    if expected != covered | unresolved:
        raise ValueError("Targets without a graph or explicit unresolved reason: " + ", ".join(sorted(expected - covered - unresolved)))
    if out.exists():
        raise ValueError("Card output exists; use a new revision filename")
    if debug_receipts and (Path(debug_receipts).resolve() == out or Path(debug_receipts).exists()):
        raise ValueError("Debug receipt output must be a new, separate file")
    views = out.parent / (out.stem + ".views")
    if views.exists():
        raise ValueError("View output exists; choose another output basename")
    checks = []
    from .inquiry_runtime import prepare, kernel
    from .card_storage import check_summary, compact_card
    prepared_index = prepare(job_path, db)
    Engine, check, Store, _, _ = kernel()
    store = Store(prepared_index["db"])
    try:
        engine = Engine(store, session="memory-card:" + job["id"], origin="memory-skill")
        for index, graph in enumerate(graphs):
            try:
                receipt = check(engine, json.dumps(graph, ensure_ascii=False), save=True)
            except (ValueError, TypeError) as exc:
                receipt = {"status": "rejected", "error": str(exc)}
                if hasattr(exc, "issues"):
                    receipt.update(code="invalid_card", error="Correct the listed card fields/coordinates together.", issues=exc.issues)
            checks.append({"graph": index + 1, "draft_sha256": fingerprint(draft["graphs"][index]), "receipt": receipt})
    finally:
        store.close()
    if debug_receipts:
        write_new(debug_receipts, checks)
    validation = {"status": "valid", "schema": "passed", "graph_checks": checks,
                  "graph_check": "performed", "kernel_sha256": prepared_index["kernel_sha256"],
                  "causal_correctness": "not_certified", "unresolved_targets": sorted(unresolved)}
    validation_sha256 = validation_digest(validation)
    try:
        require_valid_card({"draft": draft, "validation": validation, "validation_sha256": validation_sha256})
    except ValueError as exc:
        return {"status": "needs_revision", "card": None, "error": str(exc),
                "graph_checks": [{**c, "receipt": check_summary(c["receipt"])} for c in checks],
                "next_step": "Fix the indicated graph in the same job and pack again. Feedback is saved for eligible force edges. No card or views were published; keep the YAML draft."}
    claims = {"diagnosis": {"text": draft["summary"], "kind": "diagnosis", "status": "model_claim"}}
    for index, recommendation in enumerate(draft["recommendations"], 1):
        claims[f"recommendation:{index}"] = {"text": recommendation, "kind": "recommendation", "status": "model_claim"}
    sources = {s["source"]: s for s in metadata["sources"]}
    mentioned = {n["key"] for g in draft["graphs"] for n in g["nodes"]}
    matched = {key: value for key, value in sources.items() if key in mentioned}
    from .environment import for_card
    card = {"schema": "migloop-case/1", "id": "case-" + job["id"].removeprefix("issue-"),
            "created_at": now(), "job": job["id"], "identity_basis": job.get("identity_basis"),
            "migration_key": job.get("migration_key"), "draft": draft, "claims": claims,
            "targets": sorted(expected), "changes": job["issue"]["changes"],
            "participants": job["issue"].get("participants", []), "scope": job["scope"],
            "environment": for_card(metadata, job["scope"]),
            "provenance": metadata, "node_provenance": matched,
            "packager": {"name": "migloop-memory-skills", "version": VERSION, "bundle_sha256": _bundle_hash()},
            "validation": validation, "validation_sha256": validation_sha256}
    # Timestamp does not manufacture a new semantic revision on an identical repack.
    card["revision"] = revision_of(card)
    feedback = compact_card(card)["validation"]
    from .case_format import finalize, write_shared
    shared: dict[Any, Any]
    shared = {}
    card = finalize(card, shared)
    write_shared(out.parent / "sessions", shared)
    write_new(out, card)
    for index, graph in enumerate(graphs, 1):
        write_new(views / f"target-{index}.json", graph)
    return {"status": "valid", "card": str(out), "id": card["id"], "revision": card["revision"],
            "graphs": len(draft["graphs"]), "views": str(views) if draft["graphs"] else None,
            "index": prepared_index, "validation": feedback}


def main(role):
    if role not in ("triage", "card"):
        raise ValueError("Unknown skill role: " + str(role))
    parser = argparse.ArgumentParser(description="Prepare issue jobs." if role == "triage" else "Package one issue card.")
    commands = parser.add_subparsers(dest="command", required=True)
    if role == "triage":
        metadata = commands.add_parser("metadata")
        metadata.add_argument("--pool", required=True)
        metadata.add_argument("--server-metadata")
        metadata.add_argument("--session-id")
        metadata.add_argument("--out", required=True)
        jobs = commands.add_parser("dispatch")
        jobs.add_argument("--tasks", required=True)
        jobs.add_argument("--metadata", required=True)
        jobs.add_argument("--out", required=True)
    else:
        enrichment = commands.add_parser("enrich", help="Add recorded environment to existing cards without changing claims")
        enrichment.add_argument("--cards", nargs="+", required=True)
        enrichment.add_argument("--metadata", required=True)
        enrichment.add_argument("--out", required=True, help="New directory; original cards remain unchanged")
        packing = commands.add_parser("pack")
        packing.add_argument("--job", required=True)
        packing.add_argument("--draft", required=True)
        packing.add_argument("--out", required=True)
        packing.add_argument("--db")
        packing.add_argument("--debug-receipts", help="Optional full checker replies for local debugging, not memory")
        preparation = commands.add_parser("prepare", help="Prepare or reuse one shared session index")
        preparation.add_argument("--job", required=True)
        preparation.add_argument("--cache-dir")
        querying = commands.add_parser("query", help="Query the same inquiry kernel used by the checker")
        querying.add_argument("--job", required=True)
        querying.add_argument("--request", required=True, help="JSON/YAML request file, single or batch")
        querying.add_argument("--db")
        paging = commands.add_parser("page", help="Continue a previous query result")
        paging.add_argument("--job", required=True)
        paging.add_argument("--result-id", required=True)
        paging.add_argument("--offset", type=int, required=True)
        paging.add_argument("--db")
    args = parser.parse_args()
    if args.command == "metadata":
        result = collect(args.pool, args.server_metadata, args.session_id)
        write_new(args.out, result)
        result = {"metadata": args.out, "sources": len(result["sources"]), "observed": result["observed"], "unknown": result["unknown"]}
    elif args.command == "dispatch":
        result = dispatch(args.tasks, args.metadata, args.out)
    elif args.command == "enrich":
        from .environment import enrich_cards
        result = enrich_cards(args.cards, args.metadata, args.out)
    elif args.command == "prepare":
        from .inquiry_runtime import prepare
        result = prepare(args.job, cache_dir=args.cache_dir)
    elif args.command in ("query", "page"):
        from .inquiry_runtime import query
        print(query(args.job, getattr(args, "request", None), args.db,
                    getattr(args, "result_id", None), getattr(args, "offset", 0)))
        return
    else:
        result = pack(args.job, args.draft, args.out, args.db, args.debug_receipts)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if result.get("status") == "needs_revision":
        raise SystemExit(1)
