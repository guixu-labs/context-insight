"""Durable native deltas. Live revisions never overwrite frozen evidence."""
from __future__ import annotations

import base64
import binascii
import json
import re

from .api import Core, CoreError, MAX_SOURCE_BYTES, digest, encoded
from .inquiry.source_adapters import adapter_for
from .inquiry.source_adapters.export import events
from .observations import project_record, public_record, record_page, safe, session_name

CONTRACT = "agentlineage.live/v1"


class LiveStore:
    def __init__(self, core: Core):
        self.core = core
        with core._db() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS live_sources(run TEXT,key TEXT,value TEXT,
                    PRIMARY KEY(run,key));
                CREATE TABLE IF NOT EXISTS live_chunks(run TEXT,key TEXT,offset INTEGER,raw BLOB,sha TEXT,
                    PRIMARY KEY(run,key,offset));
                CREATE TABLE IF NOT EXISTS live_documents(run TEXT,key TEXT,id TEXT,value TEXT,
                    PRIMARY KEY(run,key,id));
                CREATE TABLE IF NOT EXISTS live_records(run TEXT,key TEXT,group_id TEXT,id TEXT,
                    position INTEGER,value TEXT,PRIMARY KEY(run,id));
                CREATE TABLE IF NOT EXISTS live_changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,
                    run TEXT,id TEXT,value TEXT);
                CREATE INDEX IF NOT EXISTS live_change_cursor ON live_changes(run,seq);
                CREATE INDEX IF NOT EXISTS live_record_revision ON live_changes(run,id,seq);
                CREATE INDEX IF NOT EXISTS live_record_order ON live_records(run,position);
            """)

    @staticmethod
    def _head(db, run):
        return db.execute("SELECT COALESCE(MAX(seq),0) FROM live_changes WHERE run=?", (run,)).fetchone()[0]

    def _source(self, db, run, data):
        key, fmt, sid = (data.get(k) for k in ("key", "format", "session_id"))
        if (not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9._:-]{1,180}", key)
            or fmt not in ("claude", "codex", "deveco", "host-activity")
            or not isinstance(sid, str) or not re.fullmatch(r"[A-Za-z0-9._:-]{1,180}", sid)):
            raise CoreError("INVALID_STREAM", "Explicit source key, format and session are required")
        row = db.execute("SELECT value FROM live_sources WHERE run=? AND key=?", (run, key)).fetchone()
        source = json.loads(row[0]) if row else {"key": key, "format": fmt, "session_id": sid,
            "offset": 0, "line": 0, "tail": "", "revision": 0, "metadata": {},
            "agent": sid, "parent": None, "identified": fmt == "host-activity"}
        if (source["format"], source["session_id"]) != (fmt, sid):
            raise CoreError("STREAM_CONFLICT", "Source identity cannot change", 409)
        if not row and db.execute("SELECT COUNT(*) FROM live_sources WHERE run=?", (run,)).fetchone()[0] >= 102:
            raise CoreError("STREAM_LIMIT", "Too many native sources", 413)
        return source

    @staticmethod
    def _save(db, run, source):
        db.execute("INSERT OR REPLACE INTO live_sources VALUES(?,?,?)", (run, source["key"], encoded(source)))

    def state(self, run):
        self.core.get_run(run)
        with self.core._db() as db:
            db.execute("BEGIN")
            sources = []
            for (value,) in db.execute("SELECT value FROM live_sources WHERE run=? ORDER BY key", (run,)):
                source = json.loads(value)
                hashes = {mid: digest(raw.encode()) for mid, raw in db.execute(
                    "SELECT id,value FROM live_documents WHERE run=? AND key=?", (run, source["key"]))}
                sources.append({k: source[k] for k in ("key", "format", "session_id", "offset", "revision")} | {
                    "hashes": hashes, "metadata_sha256": digest(encoded(source["metadata"]).encode()),
                    "pending_bytes": len(base64.b64decode(source["tail"])),
                    "chunks": [{"offset": pos, "length": size, "sha256": sha} for pos, size, sha in db.execute(
                        "SELECT offset,length(raw),sha FROM live_chunks WHERE run=? AND key=? ORDER BY offset", (run, source["key"]))]})
            return {"contract": CONTRACT, "run_id": run, "sources": sources, "cursor": self._head(db, run)}

    def _put(self, db, run, source, group, records):
        key = source["key"]
        old = {rid: (position, value) for rid, position, value in db.execute(
            "SELECT id,position,value FROM live_records WHERE run=? AND key=? AND group_id=?", (run, key, group))}
        for item in records:
            rid = item["id"]
            previous = old.pop(rid, None)
            value = encoded(item)
            if previous and previous[1] == value:
                continue
            cursor = db.execute("INSERT INTO live_changes(run,id,value) VALUES(?,?,?)", (run, rid, value)).lastrowid
            db.execute("INSERT OR REPLACE INTO live_records VALUES(?,?,?,?,?,?)",
                       (run, key, group, rid, previous[0] if previous else cursor, value))
        for rid in old:
            db.execute("DELETE FROM live_records WHERE run=? AND id=?", (run, rid))
            db.execute("INSERT INTO live_changes(run,id,value) VALUES(?,?,NULL)", (run, rid))

    def _project(self, run, source, row, key, pointer, raw):
        sid = "live_" + digest((run + ":" + source["key"]).encode())[:32]
        ref = sid + ":" + key
        evidence = {"ref": ref, "source_id": sid, "sha256": digest(raw), "pointer": pointer,
                    "coordinate": "jsonl-line" if source["format"] in ("claude", "codex") else "native-id"}
        base = {"session_id": source["agent"], "provider": source["format"],
                "parent_session_id": source["parent"], "timestamp": row.get("timestamp"), "evidence": evidence}
        return list(project_record(row, ref, base))

    def append(self, run, data):
        self.core.get_run(run)
        if set(data) != {"key", "format", "session_id", "offset", "content"}:
            raise CoreError("INVALID_STREAM", "Unexpected append fields")
        offset = data["offset"]
        if type(offset) is not int or offset < 0 or not isinstance(data["content"], str):
            raise CoreError("INVALID_STREAM", "Invalid byte offset or content")
        try:
            raw = base64.b64decode(data["content"], validate=True)
        except (ValueError, binascii.Error):
            raise CoreError("INVALID_STREAM", "Expected base64 native bytes") from None
        if not raw or len(raw) > 512 * 1024:
            raise CoreError("STREAM_LIMIT", "Append must contain 1 to 524288 native bytes", 413)
        with self.core._db() as db:
            db.execute("BEGIN IMMEDIATE")
            source = self._source(db, run, data)
            if source["format"] not in ("claude", "codex"):
                raise CoreError("INVALID_STREAM", "Use native upsert for mutable documents")
            if offset != source["offset"]:
                previous = db.execute("SELECT raw FROM live_chunks WHERE run=? AND key=? AND offset=?", (run, source["key"], offset)).fetchone()
                if previous and previous[0] == raw:
                    return {"key": source["key"], "offset": offset + len(raw)}
                raise CoreError("OFFSET_CONFLICT", "Resume from the acknowledged byte offset", 409)
            if offset + len(raw) > MAX_SOURCE_BYTES:
                raise CoreError("STREAM_LIMIT", "Native source exceeds limit", 413)
            pending = base64.b64decode(source["tail"]) + raw
            lines = pending.split(b"\n")
            for line in lines[:-1]:
                source["line"] += 1
                if not line.strip():
                    continue
                try:
                    row = json.loads(line.decode("utf-8-sig"))
                except (ValueError, UnicodeError):
                    raise CoreError("INVALID_NATIVE_RECORD", "Complete native line is invalid") from None
                if not isinstance(row, dict):
                    raise CoreError("INVALID_NATIVE_RECORD", "Native record must be an object")
                adapter = adapter_for(row)
                if adapter and adapter.name != source["format"]:
                    raise CoreError("FOREIGN_SESSION", "Unexpected native format")
                identity = adapter.identity(row) if adapter else None
                if identity:
                    native_sid = row.get("sessionId") if source["format"] == "claude" else row.get("payload", {}).get("id")
                    if native_sid != source["session_id"]:
                        raise CoreError("FOREIGN_SESSION", "Native session differs from source")
                    source.update(identified=True, agent=identity.agent, parent=identity.parent)
                if not source["identified"]:
                    raise CoreError("MISSING_IDENTITY", "Native session header must precede its records")
                key = str(source["line"])
                self._put(db, run, source, key, self._project(run, source, row, key,
                          "/lines/" + key, line + b"\n"))
            if len(lines[-1]) > 2 * 1024 * 1024:
                raise CoreError("STREAM_LIMIT", "Incomplete native line exceeds limit", 413)
            source.update(offset=offset + len(raw), tail=base64.b64encode(lines[-1]).decode())
            db.execute("INSERT INTO live_chunks VALUES(?,?,?,?,?)", (run, source["key"], offset, raw, digest(raw)))
            self._save(db, run, source)
            return {"key": source["key"], "offset": source["offset"]}

    def upsert(self, run, data):
        self.core.get_run(run)
        revision = data.get("revision")
        if type(revision) is not int or revision < 0:
            raise CoreError("INVALID_STREAM", "Expected source revision")
        batch = digest(encoded(data).encode())
        with self.core._db() as db:
            db.execute("BEGIN IMMEDIATE")
            source = self._source(db, run, data)
            if source.get("last_batch") == batch:
                return {"key": source["key"], "revision": source["revision"]}
            if source["revision"] != revision:
                raise CoreError("REVISION_CONFLICT", "Resume from current source revision", 409)
            key, fmt = source["key"], source["format"]
            if fmt == "deveco":
                if set(data) - {"key", "format", "session_id", "revision", "info", "messages"}:
                    raise CoreError("INVALID_STREAM", "Unexpected DevEco fields")
                info = data.get("info", source["metadata"])
                messages = data.get("messages", [])
                if not isinstance(info, dict) or info.get("id") != source["session_id"] or not isinstance(messages, list):
                    raise CoreError("FOREIGN_SESSION", "Invalid native DevEco session")
                source.update(metadata=info, parent=info.get("parentID", info.get("parent_id")), identified=True)
                seen = set()
                for msg in messages:
                    mi = msg.get("info", {}) if isinstance(msg, dict) else {}
                    mid, parts = mi.get("id"), msg.get("parts", []) if isinstance(msg, dict) else []
                    if not isinstance(mid, str) or not mid or mid in seen or mi.get("sessionID") != source["session_id"] or not isinstance(parts, list):
                        raise CoreError("FOREIGN_SESSION", "Invalid native DevEco message")
                    seen.add(mid)
                    pids = set()
                    for part in parts:
                        if (not isinstance(part, dict) or not isinstance(part.get("id"), str) or not part["id"] or part["id"] in pids
                            or part.get("messageID") != mid or part.get("sessionID") != source["session_id"]):
                            raise CoreError("FOREIGN_SESSION", "Invalid native DevEco part")
                        pids.add(part["id"])
                    records = []
                    for row in events({"info": info, "messages": [msg]}):
                        origin = row.get("origin", {})
                        if not origin.get("part"):
                            continue
                        part_key = digest(encoded([mid, origin["part"], row["phase"]]).encode())[:32]
                        records.extend(self._project(run, source, row, part_key,
                            "/messages/" + mid + "/parts/" + origin["part"], encoded(row).encode()))
                    self._put(db, run, source, mid, records)
                    db.execute("INSERT OR REPLACE INTO live_documents VALUES(?,?,?,?)", (run, key, mid, encoded(msg)))
            elif fmt == "host-activity":
                from .activity import validate_activity
                meta = {k: v for k, v in data.items() if k not in ("key", "format", "session_id", "revision", "events")}
                source["metadata"] = {**source["metadata"], **meta}
                validate_activity({**source["metadata"], "events": data.get("events", [])})
                for event in data.get("events", []):
                    eid = event.get("id", event.get("sequence"))
                    if not isinstance(eid, (str, int)):
                        raise CoreError("INVALID_STREAM", "Host events require stable identities")
                    eid = str(eid)
                    record = safe(event)
                    message = record.get("message") or {}
                    text = message.get("text") or record.get("content") or record.get("detail") or record.get("output") or record.get("title") or ""
                    item = {"id": "host:event:" + eid, "kind": "host-event", "provider": "host",
                        "session_id": record.get("sessionId") or source["session_id"],
                        "role": message.get("role", "host"), "timestamp": record.get("observedAt"),
                        "text": text if isinstance(text, str) else encoded(text), "event": record,
                        "evidence": {"ref": "host:" + eid, "source_id": "live-host", "sha256": digest(encoded(event).encode()),
                                     "pointer": "/events/" + eid, "coordinate": "native-id"}}
                    self._put(db, run, source, eid, [item])
                    db.execute("INSERT OR REPLACE INTO live_documents VALUES(?,?,?,?)", (run, key, eid, encoded(event)))
            else:
                raise CoreError("INVALID_STREAM", "Use append for JSONL sources")
            size = db.execute("SELECT COALESCE(SUM(length(CAST(value AS BLOB))),0) FROM live_documents WHERE run=? AND key=?", (run, key)).fetchone()[0]
            if size + len(encoded(source["metadata"]).encode()) > MAX_SOURCE_BYTES:
                raise CoreError("STREAM_LIMIT", "Native document exceeds limit", 413)
            source.update(revision=revision + 1, last_batch=batch)
            self._save(db, run, source)
            return {"key": key, "revision": source["revision"]}

    def query(self, run, query):
        self.core.get_run(run)
        allowed = {"after", "limit", "kind", "search", "session_id", "level", "span_id", "event_type", "source", "record_id", "revision", "text_offset", "content_only", "page_unit", "offset", "record_offset", "at_cursor"}
        after, limit = query.get("after"), query.get("limit", 100)
        if (set(query) - allowed or type(limit) is not int or not 1 <= limit <= 100
            or after is not None and (type(after) is not int or after < 0)
            or not isinstance(query.get("search", ""), str) or len(query.get("search", "")) > 500
            or query.get("kind") not in (None, "message", "tool-call", "tool-result", "host-event")
            or query.get("level") not in (None, "info", "warn", "error")
            or any(k in query and (not isinstance(query[k], str) or len(query[k]) > 300) for k in ("session_id", "span_id", "event_type", "source"))):
            raise CoreError("INVALID_QUERY", "Invalid live query")
        with self.core._db() as db:
            db.execute("BEGIN")
            head = self._head(db, run)
            if after is not None and after > head:
                raise CoreError("CURSOR_CONFLICT", "Cursor is ahead of this run", 409)
            pinned = query.get("at_cursor")
            if pinned is not None:
                if type(pinned) is not int or not 0 <= pinned <= head or after is not None:
                    raise CoreError("INVALID_QUERY", "Invalid pinned cursor")
                head = pinned
            if "record_id" in query:
                revision, start = query.get("revision"), query.get("text_offset", 0)
                if type(revision) is not int or type(start) is not int or start < 0:
                    raise CoreError("INVALID_QUERY", "Evidence requires a revision and text offset")
                row = db.execute("SELECT value FROM live_changes WHERE run=? AND id=? AND seq=?", (run, query["record_id"], revision)).fetchone()
                if not row or row[0] is None:
                    raise CoreError("NOT_FOUND", "Live evidence revision does not belong to run", 404)
                value = json.loads(row[0])
                if type(query.get("content_only", False)) is not bool:
                    raise CoreError("INVALID_QUERY", "Invalid content query")
                visible = value.get("text", value.get("input", value.get("output", "")))
                raw = (visible if isinstance(visible, str) else encoded(visible)) if query.get("content_only") else row[0]
                return {"contract": CONTRACT, "run_id": run, "record_id": query["record_id"],
                        "evidence": value["evidence"], "text": raw[start:start + 16384],
                        "next_offset": min(start + 16384, len(raw)), "total_characters": len(raw), "has_more": start + 16384 < len(raw)}
            current = [(json.loads(value), position) for value, position in db.execute(
                "SELECT value,position FROM live_records WHERE run=? ORDER BY position", (run,))]
            if pinned is not None:
                current = [(json.loads(value), position) for value, position in db.execute(
                    "SELECT c.value,b.position FROM live_changes c JOIN "
                    "(SELECT id,MAX(seq) revision,MIN(seq) position FROM live_changes WHERE run=? AND seq<=? GROUP BY id) b "
                    "ON c.id=b.id AND c.seq=b.revision WHERE c.run=? AND c.value IS NOT NULL ORDER BY b.position",
                    (run, head, run))]
            native = any(r["kind"] != "host-event" for r, _ in current)

            def matches(record):
                event = record.get("event", {})
                return ((query.get("kind") == record["kind"] if query.get("kind") else record["kind"] != "host-event" if native else True)
                    and (not query.get("session_id") or query["session_id"] == record["session_id"])
                    and query.get("search", "").casefold() in encoded(record).casefold()
                    and all(not query.get(k) or query[k] == event.get(e, default) for k, e, default in
                            (("span_id", "spanId", None), ("event_type", "type", None), ("source", "kind", "event")))
                    and (not query.get("level") or query["level"] == (event.get("level") or ("error" if event.get("status") == "error" else "info"))))

            selected, paging = record_page([r for r, _ in current if matches(r)], query, latest=True)
            by_call = {(r["session_id"], r.get("call_id"), r["kind"]): r for r, _ in current if r.get("call_id")}
            positions = {r["id"]: position for r, position in current}
            def summary(record, revision):
                item = {**public_record(record, by_call), "revision": revision, "position": positions.get(record["id"], revision)}
                if "pair" in item:
                    item["pair"]["revision"] = db.execute("SELECT MAX(seq) FROM live_changes WHERE run=? AND id=? AND seq<=?", (run, item["pair"]["id"], head)).fetchone()[0]
                return item
            records, changes = [], []
            cursor = head
            if after is None:
                for record in selected:
                    revision = db.execute("SELECT MAX(seq) FROM live_changes WHERE run=? AND id=? AND seq<=?", (run, record["id"], head)).fetchone()[0]
                    records.append(summary(record, revision))
            else:
                rows = db.execute("SELECT seq,id,value FROM live_changes WHERE run=? AND seq>? ORDER BY seq LIMIT ?", (run, after, min(limit, 20) if query.get("page_unit") == "messages" else limit)).fetchall()
                cursor = rows[-1][0] if rows else head
                for seq, rid, value in rows:
                    record = json.loads(value) if value else None
                    item = {"op": "upsert" if record and matches(record) else "remove", "id": rid}
                    if record and matches(record):
                        item["record"] = summary(record, seq)
                    changes.append(item)
            sources = [json.loads(v) for (v,) in db.execute("SELECT value FROM live_sources WHERE run=? ORDER BY key", (run,))]
            return {"contract": CONTRACT, "run_id": run, "cursor": cursor, "has_more": cursor < head,
                    "records": records, "changes": changes, **paging,
                    "origin": "native" if native and query.get("kind") != "host-event" else "host-history",
                    "sessions": [{"id": s["agent"], "provider": s["format"], "parent_id": s["parent"], "name": session_name(s.get("metadata", {}))} for s in sources if s["format"] != "host-activity"],
                    "pending_bytes": sum(len(base64.b64decode(s["tail"])) for s in sources)}

    def freeze(self, run, data):
        self.core.get_run(run)
        if set(data) - {"context", "gaps"}:
            raise CoreError("INVALID_STREAM", "Unexpected freeze fields")
        materials = []
        with self.core._db() as db:
            db.execute("BEGIN")
            for (value,) in db.execute("SELECT value FROM live_sources WHERE run=? ORDER BY key", (run,)):
                source = json.loads(value)
                if source["format"] in ("claude", "codex"):
                    raw = b"".join(r[0] for r in db.execute("SELECT raw FROM live_chunks WHERE run=? AND key=? ORDER BY offset", (run, source["key"])))
                else:
                    values = [json.loads(v) for (v,) in db.execute("SELECT value FROM live_documents WHERE run=? AND key=? ORDER BY rowid", (run, source["key"]))]
                    doc = ({"info": source["metadata"], "messages": values} if source["format"] == "deveco"
                           else {**source["metadata"], "events": values})
                    raw = encoded(doc).encode()
                materials.append((source, raw))
        sources = [self.core.upload_source(raw, digest(source["key"].encode())[:32] + (".jsonl" if source["format"] in ("claude", "codex") else ".json"),
                   source["format"], allow_partial=True)["id"] for source, raw in materials]
        return self.core.create_snapshot(run, sources, data.get("gaps"), data.get("context"))
