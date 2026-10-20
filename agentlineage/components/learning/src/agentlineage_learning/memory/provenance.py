"""Collect recorded runtime identity, never infer historical versions from today."""
from __future__ import annotations

import hashlib
import json
import sqlite3
from pathlib import Path

from . import VERSION
from .common import fields, fingerprint, load, now


def _bundle_hash():
    root = Path(__file__).resolve().parent.parent
    files = [[p.relative_to(root).as_posix(), hashlib.sha256(p.read_bytes().replace(b"\r\n", b"\n")).hexdigest()]
             for p in sorted(root.rglob("*"))
             if p.is_file() and p.suffix in (".py", ".md", ".yaml") and "__pycache__" not in p.parts]
    return fingerprint(files)


def _record(info, field, value, ref, at=None):
    if value is None or value == "":
        return
    if not isinstance(value, (str, int, float)):
        return
    value = str(value)
    if field == "models" and (value.startswith("<") or value.lower() in {"synthetic", "unknown"}):
        field = "model_placeholders"
    if field == "models" and (not info["model_timeline"] or info["model_timeline"][-1]["value"] != value):
        info["model_timeline"].append({"value": value, "ref": ref, "at": at})
    existing = next((x for x in info[field] if x["value"] == value), None)
    if existing:
        existing["observations"] += 1
        existing["last_ref"] = ref
        existing["last_at"] = at
    else:
        info[field].append({"value": value, "first_ref": ref, "last_ref": ref,
                            "first_at": at, "last_at": at, "observations": 1})


def _source(name):
    return {"source": name, "sha256": None, "session_ids": [], "agent_ids": [],
            "platforms": [], "models": [], "model_timeline": [], "model_placeholders": [], "providers": [], "client_versions": [],
            "projects": [], "records": 0, "invalid_json_records": 0}


def _observe(info, row, ref):
    if not isinstance(row, dict):
        return
    at, kind = row.get("timestamp"), row.get("type")
    payload = row["payload"] if isinstance(row.get("payload"), dict) else {}
    message = row["message"] if isinstance(row.get("message"), dict) else {}
    if row.get("format") == "deveco-events/1":
        session = row.get("session") or {}
        header = row.get("info") or {}
        model = message.get("model") or header.get("model") or {}
        if isinstance(model, str):
            try:
                model = json.loads(model)
            except ValueError:
                model = {"modelID": model}
        if not isinstance(model, dict):
            model = {}
        for field, value in (("platforms", "deveco"), ("session_ids", session.get("id")),
                             ("agent_ids", session.get("id")), ("projects", session.get("directory")),
                             ("client_versions", header.get("version")),
                             ("models", message.get("modelID") or model.get("modelID")),
                             ("providers", message.get("providerID") or model.get("providerID"))):
            _record(info, field, value, ref, at)
        return
    if kind == "session_meta":
        for field, value in (("platforms", "codex"), ("session_ids", payload.get("id")),
                             ("client_versions", payload.get("cli_version")),
                             ("providers", payload.get("model_provider")),
                             ("models", payload.get("model")), ("projects", payload.get("cwd"))):
            _record(info, field, value, ref, at)
    elif kind == "turn_context":
        _record(info, "platforms", "codex", ref, at)
        _record(info, "models", payload.get("model"), ref, at)
    elif row.get("sessionId") is not None:
        for field, value in (("platforms", "claude-code"), ("session_ids", row.get("sessionId")),
                             ("agent_ids", row.get("agentId")), ("models", message.get("model")),
                             ("client_versions", row.get("version")), ("projects", row.get("cwd"))):
            _record(info, field, value, ref, at)


def _jsonl(path, root):
    from .environment import Observer
    environment = Observer()
    info, digest = _source(path.relative_to(root).as_posix()), hashlib.sha256()
    with path.open("rb") as stream:
        for number, raw in enumerate(stream, 1):
            digest.update(raw)
            info["records"] += 1
            try:
                row = json.loads(raw.decode("utf-8-sig"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                info["invalid_json_records"] += 1
                continue
            _observe(info, row, f"{info['source']}:L{number}")
            environment.observe(row, f"{info['source']}:L{number}")
    info["sha256"] = digest.hexdigest()
    info["environment"] = list(environment.observations.values())
    return info


def _deveco(path, session_id):
    if not session_id:
        raise ValueError("DevEco DB needs --session-id; never scan every user's session")
    sources, seen, queue = [], set(), [session_id]
    connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("PRAGMA query_only=ON")
        connection.execute("BEGIN")
        columns = {r["name"] for r in connection.execute("PRAGMA table_info(session)")}
        if not {"id", "parent_id"} <= columns:
            raise ValueError("Unsupported DevEco session table; export scoped JSONL or provide server metadata")
        wanted = [x for x in ("id", "parent_id", "directory", "version", "model") if x in columns]
        while queue:
            sid = queue.pop(0)
            if sid in seen:
                continue
            seen.add(sid)
            rows = connection.execute("SELECT " + ",".join(wanted) + " FROM session WHERE id=?", (sid,)).fetchall()
            if not rows:
                raise ValueError(f"Missing DevEco session: {sid}")
            info, raw_headers = _source(sid), []
            for row in rows:
                record = dict(row)
                raw_headers.append(record)
                for field, value in (("platforms", "deveco"), ("session_ids", sid),
                                     ("client_versions", record.get("version")),
                                     ("projects", record.get("directory"))):
                    _record(info, field, value, f"session:{sid}")
                model = record.get("model")
                if model:
                    try:
                        model = json.loads(model)
                    except (json.JSONDecodeError, TypeError):
                        pass
                    if isinstance(model, dict):
                        _record(info, "models", model.get("modelID") or model.get("id"), f"session:{sid}")
                        _record(info, "providers", model.get("providerID"), f"session:{sid}")
                    elif isinstance(model, str):
                        _record(info, "models", model, f"session:{sid}")
            message_cols = {r["name"] for r in connection.execute("PRAGMA table_info(message)")}
            if {"id", "session_id", "data"} <= message_cols:
                for message in connection.execute("SELECT id,data FROM message WHERE session_id=? ORDER BY id", (sid,)):
                    info["records"] += 1
                    try:
                        data = json.loads(message["data"])
                    except (TypeError, json.JSONDecodeError):
                        info["invalid_json_records"] += 1
                        continue
                    if not isinstance(data, dict):
                        continue
                    ref = f"session:{sid}/message:{message['id']}"
                    model = data["model"] if isinstance(data.get("model"), dict) else {}
                    mid = data.get("modelID") or model.get("modelID") or model.get("id")
                    provider = data.get("providerID") or model.get("providerID")
                    _record(info, "models", mid, ref)
                    _record(info, "providers", provider, ref)
                    raw_headers.append({"message": message["id"], "model": mid, "provider": provider})
            info["sha256"] = fingerprint(raw_headers)
            info["hash_scope"] = "selected session/model headers; not a full transcript snapshot"
            sources.append(info)
            queue.extend(r[0] for r in connection.execute("SELECT id FROM session WHERE parent_id=? ORDER BY id", (sid,)))
    finally:
        connection.close()
    return sources


def collect(pool, server_metadata=None, session_id=None):
    path = Path(pool).resolve()
    if not path.exists():
        raise ValueError("Transcript input does not exist")
    if path.is_file() and path.suffix.lower() in (".db", ".sqlite", ".sqlite3"):
        sources = _deveco(path, session_id)
    else:
        root = path if path.is_dir() else path.parent
        paths = sorted(path.rglob("*.jsonl")) if path.is_dir() else [path]
        if not paths:
            raise ValueError("No JSONL transcripts found; do not supply an unrelated directory")
        sources = [_jsonl(p, root) for p in paths]
    declared = load(server_metadata) if server_metadata else {}
    fields(declared, ("migration", "analysis"), (), "server metadata")
    allowed = {"id", "session_ids", "root_session_ids", "project", "platforms", "models",
               "tool_versions", "skill_versions", "source_revision", "tenant", "provider",
               "run_id", "server_session_id", "runtime_versions", "stage_boundaries", "source_uris"}
    for section in declared.values():
        fields(section, allowed, (), "server metadata section")
    result = {"schema": "migloop-provenance/1", "captured_at": now(),
              "collector": {"name": "migloop-memory-skills", "version": VERSION,
                            "bundle_sha256": _bundle_hash(),
                            "implementation_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()},
              "materials": str(path), "db_root_session_id": session_id, "sources": sources,
              "migration": declared.get("migration", {}), "analysis": declared.get("analysis", {}),
              "declared_metadata_source": str(Path(server_metadata).resolve()) if server_metadata else None,
              "boundary": "Observed metadata and server declarations are separate; missing historical versions remain unknown."}
    result["source_set_id"] = "sources-" + fingerprint([{k: r[k] for k in ("source", "sha256")} for r in sources])[:20]
    result["observed"] = {field: sorted({x["value"] for r in sources for x in r[field]})
                          for field in ("session_ids", "platforms", "models", "providers", "client_versions", "projects")}
    result["unknown"] = [field for field, values in result["observed"].items() if not values]
    if not result["migration"].get("tool_versions"):
        result["unknown"].append("historical_migration_tool_versions")
    if not result["analysis"].get("models"):
        result["unknown"].append("analysis_models")
    return result


def verify_materials(metadata):
    """Check collected source identity before binding it to a new card."""
    path = Path(metadata["materials"]).resolve()
    if path.is_file() and path.suffix.lower() in (".db", ".sqlite", ".sqlite3"):
        actual = _deveco(path, metadata.get("db_root_session_id"))
        if [(x["source"], x["sha256"]) for x in actual] != [(x["source"], x["sha256"]) for x in metadata["sources"]]:
            raise ValueError("DevEco identity/model records changed; recollect provenance")
        return
    root = path if path.is_dir() else path.parent
    files = sorted(path.rglob("*.jsonl")) if path.is_dir() else [path]
    expected = {x["source"]: x["sha256"] for x in metadata["sources"]}
    if {p.relative_to(root).as_posix() for p in files} != set(expected):
        raise ValueError("Transcript inventory changed; recollect provenance and redispatch with stable identity")
    for source in files:
        digest = hashlib.sha256()
        with source.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
        if digest.hexdigest() != expected[source.relative_to(root).as_posix()]:
            raise ValueError("Transcript changed after metadata capture: " + source.name)
