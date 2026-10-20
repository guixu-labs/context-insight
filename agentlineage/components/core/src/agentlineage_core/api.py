"""Public SDK for immutable native materials and historical evidence."""
from __future__ import annotations

from collections import OrderedDict
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import threading
from typing import Any, Iterator
from uuid import uuid4

from . import __version__
from .paths import data_path
from .inquiry.engine import Engine
from .inquiry.report import check, load_report
from .inquiry.source_adapters import adapter_for
from .inquiry.source_adapters.export import events
from .inquiry.store import INDEX_SCHEMA, Store, describe_source
from .inquiry.web import dispatch_http, render_page

Json = dict[str, Any]
MAX_SOURCE_BYTES = 64 * 1024 * 1024


class CoreError(ValueError):
    def __init__(self, code: str, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.code, self.status = code, status

    def as_dict(self) -> Json:
        return {"code": self.code, "message": str(self), "retryable": False}


def encoded(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def valid_id(value: str, prefix: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(prefix + r"_[a-f0-9]{32,64}", value):
        raise CoreError("INVALID_ID", "Invalid " + prefix + " identifier")
    return value


class Core:
    def __init__(self, directory: str | Path) -> None:
        self._observation_cache: OrderedDict[str, tuple[Json, int]] = OrderedDict()
        self._observation_lock = threading.RLock()
        self.root = data_path(directory)
        self.root.mkdir(parents=True, exist_ok=True)
        with self._db() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS runs(
                    id TEXT PRIMARY KEY, external_key TEXT UNIQUE, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS sources(
                    id TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS snapshots(
                    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS repairs(id TEXT PRIMARY KEY, run_id TEXT, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS jobs(
                    id TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS idempotency(
                    path TEXT, key TEXT, digest TEXT, status INT, body TEXT, mime TEXT,
                    PRIMARY KEY(path,key));
            """)

    @contextmanager
    def _db(self) -> Iterator[sqlite3.Connection]:
        db = sqlite3.connect(self.root / "catalog.sqlite", timeout=30)
        db.execute("PRAGMA journal_mode=WAL")
        try:
            with db:
                yield db
        finally:
            db.close()

    def capabilities(self) -> Json:
        return {"component": "agentlineage-core", "package_version": __version__,
                "api_version": "v1", "schema_versions": {"index": INDEX_SCHEMA},
                "features": ["native-import", "frozen-snapshot", "historical-query",
                             "evidence-check", "viewer", "offline-export", "evidence-anchors-v1",
                             "observations-v1", "repair-chain-v1", "agent-run-v1", "live-streams-v1", "record-anchors-v1", "optional-overview-v1", "bounded-history-pages-v1", "dsh-native-v4"],
                "adapters": [{"name": name, "features": ["offline", "native-evidence"]}
                             for name in ("claude", "codex", "deveco", "dsh")]}

    def create_run(self, external_key: str, project_id: str = "default",
                   objective: str = "") -> Json:
        if not isinstance(external_key, str) or not external_key.strip():
            raise CoreError("INVALID_RUN", "external_key must be nonempty")
        key = encoded([project_id, external_key])
        with self._db() as db:
            existing = db.execute("SELECT value FROM runs WHERE external_key=?", (key,)).fetchone()
            if existing:
                return json.loads(existing[0])
            run: Any
            run = {"id": "run_" + uuid4().hex, "external_key": external_key,
                   "project_id": project_id, "objective": objective, "status": "open",
                   "latest_snapshot_id": None, "completeness": "unknown", "gaps": []}
            db.execute("INSERT INTO runs VALUES(?,?,?)", (run["id"], key, encoded(run)))
        return run

    def _read(self, kind: str, identity: str) -> Json:
        tables = {"run": "runs", "source": "sources", "snapshot": "snapshots", "job": "jobs"}
        prefixes = {"run": "run", "source": "src", "snapshot": "snap", "job": "job"}
        valid_id(identity, prefixes[kind])
        with self._db() as db:
            row = db.execute("SELECT value FROM " + tables[kind] + " WHERE id=?",
                             (identity,)).fetchone()
        if row is None:
            raise CoreError("NOT_FOUND", kind + " not found", 404)
        return json.loads(row[0])

    def get_run(self, run_id: str) -> Json:
        return self._read("run", run_id)

    def get_snapshot(self, snapshot_id: str) -> Json:
        return self._read("snapshot", snapshot_id)

    def resolve_evidence(self, snapshot_id: str, anchor: Json) -> Json:
        from .anchors import resolve_evidence
        return resolve_evidence(self, snapshot_id, anchor)

    def upload_source(self, raw: bytes, name: str = "session.jsonl",
                      expected_format: str = "auto", *, allow_partial: bool = False) -> Json:
        if not raw or len(raw) > MAX_SOURCE_BYTES:
            raise CoreError("SOURCE_SIZE", "Source must contain 1 to 67108864 bytes", 413)
        if not isinstance(name, str) or not name or Path(name).name != name or "/" in name or "\\" in name:
            raise CoreError("INVALID_NAME", "Source name must be a basename")
        try:
            source_gaps: list[Json] = []
            try:
                text = raw.decode("utf-8-sig")
            except UnicodeDecodeError as error:
                if not allow_partial or error.end != len(raw) or error.reason != "unexpected end of data":
                    raise
                text = raw[:error.start].decode("utf-8-sig")
                source_gaps.append({"code": "incomplete-utf8", "offset": error.start})
            if text.startswith("Exporting session:"):
                text = text.split("\n", 1)[1]
            try:
                document = json.loads(text)
            except json.JSONDecodeError:
                document = None
            projection = None
            if expected_format == "host-activity":
                from .activity import validate_activity
                validate_activity(document)
                rows = []
                projection = "agentlineage.host-activity/v1"
                indexed = b""
            elif isinstance(document, dict) and isinstance(document.get("info"), dict) and isinstance(document.get("messages"), list):
                sid = document["info"].get("id")
                for message in document["messages"]:
                    if message.get("info", {}).get("sessionID", sid) != sid or any(part.get("sessionID", sid) != sid for part in message.get("parts", [])):
                        raise ValueError("Foreign message inside native export")
                rows = list(events(document))
                projection = "deveco-native-export/1"
                indexed = ("\n".join(encoded(row) for row in rows) + "\n").encode()
            else:
                rows = []
                lines = text.splitlines()
                indexed_lines = []
                for index, line in enumerate(lines):
                    if not line.strip():
                        indexed_lines.append(line)
                        continue
                    try:
                        rows.append(json.loads(line))
                        indexed_lines.append(line)
                    except json.JSONDecodeError:
                        if not allow_partial or any(rest.strip() for rest in lines[index + 1:]):
                            raise
                        source_gaps.append({"code": "invalid-json", "line": index + 1})
                        indexed_lines.append("")
                indexed = ("\n".join(indexed_lines) + "\n").encode() if source_gaps else raw
            if rows and isinstance(rows[0], dict) and rows[0].get("type") == "session":
                from .inquiry.source_adapters.dsh import project
                native_lines = [index + 1 for index, line in enumerate(indexed_lines) if line.strip()]
                rows = list(project(rows, native_lines))
                projection = "dsh-native-v4/1"
                for line_number, row in zip(native_lines, rows):
                    indexed_lines[line_number - 1] = encoded(row)
                indexed = ("\n".join(indexed_lines) + "\n").encode()
            if expected_format == "host-activity":
                source_format = "host-activity"
            else:
                if not rows or any(not isinstance(row, dict) for row in rows):
                    raise ValueError("Native session records must be JSON objects")
                formats = {adapter.name for row in rows if (adapter := adapter_for(row)) is not None}
                if len(formats) != 1:
                    raise ValueError("Source must belong to one supported native session format")
                source_format = next(iter(formats))
                if source_format == "dsh" and projection != "dsh-native-v4/1":
                    raise ValueError("DSH material must begin with its native v4 session header")
                if expected_format not in ("auto", source_format, source_format + "-export"):
                    raise ValueError("Declared source format does not match native records")
        except (UnicodeError, ValueError, TypeError, KeyError, IndexError) as exc:
            raise CoreError("INVALID_SOURCE", str(exc), 422) from exc
        source_id = "src_" + digest(encoded([name, digest(raw), source_format]).encode())
        directory = self.root / "sources" / source_id
        directory.mkdir(parents=True, exist_ok=True)
        for filename, content in [("raw", raw), ("records.jsonl", indexed)]:
            path = directory / filename
            try:
                with path.open("xb") as stream:
                    stream.write(content)
            except FileExistsError:
                if path.read_bytes() != content:
                    raise CoreError("SOURCE_TAMPERED", "Existing immutable object differs", 409)
        source = {"id": source_id, "name": name, "format": source_format,
                  "sha256": digest(raw), "index_sha256": digest(indexed),
                  "size_bytes": len(raw), "projection": projection,
                  **({"gaps": source_gaps} if source_gaps else {})}
        with self._db() as db:
            db.execute("INSERT OR IGNORE INTO sources VALUES(?,?)", (source_id, encoded(source)))
        return source

    def create_snapshot(self, run_id: str, source_ids: list[str],
                        gaps: list[Json] | None = None, context: Json | None = None) -> Json:
        self.get_run(run_id)
        if not source_ids or len(source_ids) != len(set(source_ids)):
            raise CoreError("INVALID_SOURCES", "Specify a nonempty unique source list")
        sources = [self._read("source", identity) for identity in source_ids]
        if sum(s["format"] == "host-activity" for s in sources) > 1:
            raise CoreError("INVALID_SOURCES", "Only one host activity version belongs to a snapshot")
        all_gaps = list(gaps or []) + [gap for source in sources for gap in source.get("gaps", [])]
        manifest = {"run_id": run_id, "sources": sources, "gaps": all_gaps,
                    "parser_version": __version__, "index_schema": INDEX_SCHEMA,
                    "context": context or {}}
        snapshot_id = "snap_" + digest(encoded(manifest).encode())
        with self._db() as db:
            existing = db.execute("SELECT value FROM snapshots WHERE id=?", (snapshot_id,)).fetchone()
        if existing:
            self._verify_snapshot(json.loads(existing[0]))
            return json.loads(existing[0])
        directory = self.root / "snapshots" / snapshot_id
        directory.mkdir(parents=True, exist_ok=True)
        index = directory / ("building-" + uuid4().hex + ".sqlite")
        registrations = []
        for position, source in enumerate(sources):
            if source["format"] == "host-activity":
                continue
            path = self.root / "sources" / source["id"] / "records.jsonl"
            if digest(path.read_bytes()) != source["index_sha256"]:
                raise CoreError("SOURCE_TAMPERED", "Indexed material digest changed", 409)
            registrations.append(describe_source(path, f"{position:03d}-{source['name']}"))
        store = Store.build(index, registrations, allow_empty=True)
        try:
            platforms = [row["platform"] for row in store.rows("SELECT platform FROM source_metadata")]
            record_count = store.rows("SELECT COUNT(*) AS n FROM records")[0]["n"]
            latest = store.rows("SELECT MAX(at) AS at FROM records")[0]["at"]
            from .inquiry.store import iso
            at = iso(latest)
        finally:
            store.close()
        try:
            index.rename(directory / "index.sqlite")
        except FileExistsError:
            index.unlink()
        snapshot = {"id": snapshot_id, **manifest, "source_ids": source_ids,
                    "platforms": sorted(set(platforms)), "records": record_count,
                    "at": at, "completeness": "partial" if all_gaps else "unknown"}
        with self._db() as db:
            db.execute("INSERT OR IGNORE INTO snapshots VALUES(?,?,?)",
                       (snapshot_id, run_id, encoded(snapshot)))
            row = db.execute("SELECT value FROM runs WHERE id=?", (run_id,)).fetchone()
            run = json.loads(row[0])
            run.update(latest_snapshot_id=snapshot_id, completeness=snapshot["completeness"],
                       gaps=snapshot["gaps"])
            db.execute("UPDATE runs SET value=? WHERE id=?", (encoded(run), run_id))
        return snapshot

    def import_files(self, name: str, paths: list[str | Path], project_id: str = "default") -> Json:
        run = self.create_run(name, project_id)
        sources = [self.upload_source(Path(path).read_bytes(), Path(path).name) for path in paths]
        snapshot = self.create_snapshot(run["id"], [source["id"] for source in sources])
        return {"run_id": run["id"], "snapshot_id": snapshot["id"], "snapshot": snapshot}

    def export_materials(self, snapshot_id: str, destination: str | Path) -> Json:
        snapshot = self.get_snapshot(snapshot_id)
        self._verify_snapshot(snapshot)
        directory = data_path(destination)
        directory.mkdir(parents=True, exist_ok=False)
        files = []
        for position, source in enumerate(snapshot["sources"]):
            name = f"{position:03d}-{source['name']}"
            if not name.endswith(".jsonl"):
                name += ".jsonl"
            raw = (self.root / "sources" / source["id"] / "records.jsonl").read_bytes()
            (directory / name).write_bytes(raw)
            files.append({"name": name, "sha256": source["index_sha256"],
                          "original_sha256": source["sha256"], "projection": source["projection"]})
        manifest = {"snapshot_id": snapshot_id, "files": files, "completeness": snapshot["completeness"]}
        (directory / "manifest.json").write_text(encoded(manifest), encoding="utf-8")
        return manifest

    def _verify_snapshot(self, snapshot: Json) -> None:
        for source in snapshot["sources"]:
            directory = self.root / "sources" / source["id"]
            for filename, checksum in [("raw", source["sha256"]),
                                       ("records.jsonl", source["index_sha256"])]:
                if digest((directory / filename).read_bytes()) != checksum:
                    raise CoreError("SOURCE_TAMPERED", "Immutable source checksum mismatch", 409)

    @contextmanager
    def evidence(self, snapshot_id: str) -> Iterator[Engine]:
        snapshot = self.get_snapshot(snapshot_id)
        self._verify_snapshot(snapshot)
        store = Store(self.root / "snapshots" / snapshot_id / "index.sqlite")
        try:
            yield Engine(store)
        finally:
            store.close()

    def file_lineage(self, snapshot_id: str, path: str, at: str) -> Json:
        from .inquiry.native_text import change_payloads
        from .inquiry.store import path_key, timestamp
        from .lineage import replay_file

        path = path_key(path)
        events: list[tuple[str, str, Any]] = []
        with self.evidence(snapshot_id) as engine:
            observations = engine.store.rows(
                "SELECT * FROM effects WHERE path=? AND at<=? AND op='write' ORDER BY at,id",
                (path, timestamp(at, required=True)))
            for effect in observations:
                if effect["strength"] != "confirmed":
                    continue
                payloads = change_payloads(engine.store, effect)
                if len(payloads) != 1 or not isinstance(payloads[0]["body"], dict):
                    events.append((effect["agent"], "opaque", None))
                    continue
                body = payloads[0]["body"]
                if isinstance(body.get("content"), str):
                    events.append((effect["agent"], "write", body["content"]))
                elif payloads[0]["tool"].split(".")[-1].lower() == "delete_file" or body.get("type") == "delete":
                    events.append((effect["agent"], "delete", None))
                else:
                    edits = body.get("edits", [body])
                    if isinstance(edits, list) and edits and all(
                        isinstance(item, dict) and isinstance(item.get("old_string"), str)
                        and isinstance(item.get("new_string"), str) for item in edits
                    ):
                        events.append((effect["agent"], "edits", [
                            (item["old_string"], item["new_string"], bool(item.get("replace_all")))
                            for item in edits]))
                    else:
                        events.append((effect["agent"], "opaque", None))
        replay = replay_file(events) if events else {
            "segments": None, "takeovers": [], "broken": None, "total": 0, "changes": []}
        return {"snapshot_id": snapshot_id, "path": path, "at": at, **replay,
                "write_count": len(events), "observations": observations,
                "status": ("incomplete" if replay["broken"] else "replayed") if events else "not_observed",
                "semantic_verified": False,
                "limitation": "Recorded confirmed writes only; unobserved external edits remain unknown"}

    def query(self, snapshot_id: str, request: Json) -> Json:
        with self.evidence(snapshot_id) as engine:
            return {"snapshot_id": snapshot_id, "result": engine.query(request)}

    def check_report(self, snapshot_id: str, document: Json | str, *, save: bool = False) -> Json:
        with self.evidence(snapshot_id) as engine:
            return check(engine, document if isinstance(document, str) else encoded(document), save=save)

    def get_report(self, snapshot_id: str, report_id: str) -> Json:
        with self.evidence(snapshot_id) as engine:
            return load_report(engine, report_id)

    def viewer(self, snapshot_id: str, api_base: str) -> str:
        self.get_snapshot(snapshot_id)
        return render_page(api_base, {"title": "AgentLineage"})

    def viewer_request(self, snapshot_id: str, route: str, data: Json | None = None) -> tuple[int, str, str]:
        snapshot = self.get_snapshot(snapshot_id)
        self._verify_snapshot(snapshot)
        return dispatch_http(self.root / "snapshots" / snapshot_id / "index.sqlite", route, data)
