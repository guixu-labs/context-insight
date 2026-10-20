"""Import once; query SQLite; expand the original bytes by a verified offset."""

from __future__ import annotations

from typing import Any

import hashlib
import json
import posixpath
import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path

from .command_shape import call_read_basis, literal_path_mentions
from .tool_contracts import file_effects, navigation_paths
from .source_adapters import identity as source_identity, input_role, parts

INDEX_SCHEMA = "inquiry/index/6"

_FILE_TOKEN = re.compile(r"(?<![\w.])[\w@+-][\w@+.-]*\.[A-Za-z][A-Za-z0-9]{0,15}(?!\w)")


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def encode(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


@lru_cache(maxsize=64)
def search_terms(encoded):
    return tuple(json.loads(encoded))


def literal_any(body, encoded):
    folded = body.casefold()
    return any(term in folded for term in search_terms(encoded))


def timestamp(value, *, required=False):
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError("timezone required")
        return int(parsed.timestamp() * 1_000_000)
    except (ValueError, TypeError, AttributeError, OverflowError):
        if required:
            raise ValueError(
                "time must be a timezone-qualified ISO timestamp"
            ) from None
        return None


def iso(value):
    return (
        datetime.fromtimestamp(value / 1_000_000, timezone.utc).isoformat()
        if value is not None
        else None
    )


def path_key(value, cwd=""):
    value = value.replace("\\", "/")
    if not value.startswith("/") and not re.match(r"^[A-Za-z]:/", value):
        value = posixpath.join(cwd.replace("\\", "/"), value)
    return posixpath.normpath(value)


def flatten(value):
    if isinstance(value, dict):
        return "\n".join(str(k) + "\n" + flatten(v) for k, v in value.items())
    if isinstance(value, list):
        return "\n".join(flatten(v) for v in value)
    return value if isinstance(value, str) else encode(value)


def native_brief(record, fallback):
    """A labelled call description is navigation, not proof its intent succeeded."""
    descriptions = []
    for _, _, role, _, tool, payload, _ in parts(record):
        if role not in ("request", "patch"):
            continue
        if isinstance(payload, dict):
            fields = [
                str(payload[k])
                for k in ("description", "file_path", "path")
                if payload.get(k)
            ]
            command = payload.get("command", payload.get("cmd", ""))
            if command:
                fields.append(str(command).replace("\n", " ")[:140])
            descriptions.append(tool + " | " + " | ".join(fields))
        else:
            descriptions.append(tool + " | " + str(payload).replace("\n", " ")[:180])
    return " ; ".join(descriptions)[:350] if descriptions else fallback


@dataclass(frozen=True)
class Source:
    path: str
    name: str
    agent: str | None = None
    cwd: str = ""
    protocol: str = "auto"
    platform: str = "unknown"
    parent: str | None = None


_SCHEMA = """
CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);
CREATE TABLE sources(id TEXT PRIMARY KEY,name TEXT UNIQUE,path TEXT,agent TEXT,cwd TEXT,size INT,mtime INT);
CREATE TABLE source_metadata(source TEXT PRIMARY KEY,platform TEXT,parent TEXT);
CREATE TABLE records(ref TEXT PRIMARY KEY,source TEXT,line INT,offset INT,length INT,sha TEXT,
 at INT,kind TEXT,body TEXT,summary TEXT,native TEXT);
CREATE INDEX record_scope ON records(source,at,line);
CREATE INDEX record_time ON records(at);
CREATE INDEX record_native ON records(native);
CREATE TABLE mentions(name TEXT,record TEXT,PRIMARY KEY(name,record));
CREATE TEMP TABLE parts(record TEXT,source TEXT,slot INT,family TEXT,role TEXT,call_id TEXT,tool TEXT,
 payload TEXT,success INT,at INT,PRIMARY KEY(record,slot));
CREATE INDEX pair_calls ON parts(source,family,call_id);
CREATE TABLE pairs(a TEXT,b TEXT,PRIMARY KEY(a,b));
CREATE INDEX pairs_by_result ON pairs(b,a);
CREATE TABLE call_pairs(request TEXT,request_slot INT,result TEXT,result_slot INT,
 PRIMARY KEY(result,result_slot));
CREATE TABLE effects(id TEXT PRIMARY KEY,path TEXT,agent TEXT,op TEXT,strength TEXT,at INT,
 request TEXT,result TEXT,status TEXT,basis TEXT,request_slot INT,result_slot INT);
CREATE INDEX effect_path ON effects(path,at);
CREATE INDEX effect_agent ON effects(agent,at);
CREATE TABLE dispatches(id TEXT PRIMARY KEY,parent TEXT,child TEXT,at INT,request TEXT,result TEXT);
CREATE TABLE files(path TEXT PRIMARY KEY);
CREATE TABLE runs(id TEXT PRIMARY KEY,kind TEXT,request TEXT,data TEXT,body TEXT);
CREATE TABLE frames(run TEXT,offset INT,text TEXT,sha TEXT,PRIMARY KEY(run,offset));
CREATE TABLE visible(run TEXT,offset INT,complete INT,observed TEXT);
CREATE TABLE handles(id TEXT PRIMARY KEY,kind TEXT,payload TEXT);
CREATE TABLE calls(record TEXT,slot INT,tool TEXT,read_basis TEXT,PRIMARY KEY(record,slot));
CREATE TABLE input_messages(record TEXT PRIMARY KEY,role TEXT);
CREATE TABLE tool_returns(record TEXT,slot INT,family TEXT,success INT,PRIMARY KEY(record,slot));
"""



class Store:
    def __init__(self, path):
        self.path = Path(path).resolve()
        if not self.path.is_file():
            raise ValueError("index does not exist; import first")
        self.db = sqlite3.connect(self.path)
        self.db.row_factory = sqlite3.Row
        self.db.create_function(
            "literal_contains",
            2,
            lambda body, needle: needle in body.casefold(),
            deterministic=True,
        )
        self.db.create_function("literal_any", 2, literal_any, deterministic=True)
        schema = self.db.execute("SELECT value FROM meta WHERE key='schema'").fetchone()
        if schema is None or schema[0] != INDEX_SCHEMA:
            self.db.close()
            raise ValueError(
                "incomplete or incompatible index; import into a new path or use its frozen code"
            )

    def close(self):
        self.db.close()

    @classmethod
    def build(cls, path, sources, *, allow_empty=False):
        target = Path(path).resolve()
        sources = list(sources)
        if target.exists():
            raise ValueError("will not overwrite an existing index")
        if (not sources and not allow_empty) or len({s.name for s in sources}) != len(sources):
            raise ValueError("sources must have unique nonempty logical names")
        if any(not s.name or s.protocol not in ("auto", "text") for s in sources):
            raise ValueError("invalid source registration")
        target.parent.mkdir(parents=True, exist_ok=True)
        # Exclusive reservation: a failed import remains explicitly incomplete.
        with target.open("xb"):
            pass
        db = sqlite3.connect(target)
        db.row_factory = sqlite3.Row
        try:
            db.executescript(_SCHEMA)
            for source in sources:
                cls._import(db, source)
            cls._effects(db)
            db.execute("INSERT INTO meta VALUES(?,?)", ("schema", INDEX_SCHEMA))
            db.commit()
        finally:
            db.close()
        return cls(target)

    @staticmethod
    def _import(db, source):
        path = Path(source.path).resolve()
        before = path.stat()
        sid = digest(source.name.encode())[:16]
        db.execute(
            "INSERT INTO sources VALUES(?,?,?,?,?,?,?)",
            (
                sid,
                source.name,
                str(path),
                source.agent,
                source.cwd,
                before.st_size,
                before.st_mtime_ns,
            ),
        )
        db.execute("INSERT INTO source_metadata VALUES(?,?,?)", (sid, source.platform, source.parent))
        with path.open("rb") as stream:
            line = 0
            while True:
                offset = stream.tell()
                raw = stream.readline()
                if not raw:
                    break
                line += 1
                text = raw.decode("utf-8", errors="replace").rstrip("\r\n")
                try:
                    value = json.loads(text) if source.protocol != "text" else None
                except ValueError:
                    value = None
                record = value if isinstance(value, dict) else {}
                at = timestamp(record.get("timestamp"))
                kind = str(
                    record.get("type")
                    or ("text" if source.protocol == "text" else "unknown")
                )
                body = flatten(value) if value is not None else text
                message = record.get("message")
                main = (
                    message.get("content")
                    if isinstance(message, dict)
                    else record.get("payload", value)
                )
                summary = (flatten(main) if main is not None else text)[:260].replace(
                    "\n", " "
                )
                summary = native_brief(record, summary)
                sha = digest(raw)
                ref = f"{sid}:{line}:{sha[:16]}"
                native = record.get("uuid")
                db.execute(
                    "INSERT INTO records VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        ref,
                        sid,
                        line,
                        offset,
                        len(raw),
                        sha,
                        at,
                        kind,
                        body,
                        summary,
                        native if isinstance(native, str) else None,
                    ),
                )
                db.executemany(
                    "INSERT OR IGNORE INTO mentions VALUES(?,?)",
                    [(name.casefold(), ref) for name in set(_FILE_TOKEN.findall(body))],
                )
                role = input_role(record)
                if role:
                    db.execute("INSERT INTO input_messages VALUES(?,?)", (ref, role))
                for slot, family, role, cid, tool, payload, success in parts(record, owner=source.agent):
                    if role in ("result", "patch"):
                        db.execute(
                            "INSERT INTO tool_returns VALUES(?,?,?,?)",
                            (ref, slot, family, success),
                        )
                    if role in ("request", "patch"):
                        db.execute(
                            "INSERT INTO calls VALUES(?,?,?,?)",
                            (ref, slot, tool, call_read_basis(tool, payload)),
                        )
                    if role == "request":
                        hints = set(literal_path_mentions(tool, payload)) | set(navigation_paths(tool, payload, source.cwd))
                        for mentioned_path in sorted(hints):
                            # A source-backed lexical identity, not a read/write.
                            # Rebuilt indexes gain hints; old indexes are not migrated.
                            db.execute("INSERT OR IGNORE INTO files VALUES(?)", (mentioned_path,))
                            db.execute("INSERT OR IGNORE INTO mentions VALUES(?,?)", (mentioned_path.casefold(), ref))
                    db.execute(
                        "INSERT INTO parts VALUES(?,?,?,?,?,?,?,?,?,?)",
                        (
                            ref,
                            sid,
                            slot,
                            family,
                            role,
                            cid if isinstance(cid, str) and cid else None,
                            tool if isinstance(tool, str) else "",
                            encode(payload),
                            success,
                            at,
                        ),
                    )
        after = path.stat()
        if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            raise ValueError("source changed during import: " + source.name)

    @staticmethod
    def _effects(db):
        def effect(
            path,
            owner,
            op,
            strength,
            at,
            request,
            result,
            status,
            basis,
            request_slot,
            result_slot,
        ):
            if not isinstance(path, str) or not path:
                return
            normalized = path_key(path, owner["cwd"])
            identity = digest(
                encode(
                    [normalized, op, request, request_slot, result, result_slot]
                ).encode()
            )[:24]
            db.execute("INSERT OR IGNORE INTO files VALUES(?)", (normalized,))
            db.execute(
                "INSERT OR IGNORE INTO effects VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    identity,
                    normalized,
                    owner["agent"],
                    op,
                    strength,
                    at,
                    request,
                    result,
                    status,
                    basis,
                    request_slot,
                    result_slot,
                ),
            )

        sources = {s["id"]: s for s in db.execute("SELECT * FROM sources")}
        for request in db.execute("SELECT * FROM parts WHERE role='request'"):
            cid = request["call_id"]
            siblings = (
                db.execute(
                    "SELECT * FROM parts WHERE source=? AND family=? AND call_id=?",
                    (request["source"], request["family"], cid),
                ).fetchall()
                if cid
                else []
            )
            uses = [p for p in siblings if p["role"] == "request"]
            returns = [p for p in siblings if p["role"] == "result"]
            result: Any = returns[0] if len(returns) == 1 and len(uses) == 1 else None
            ordered = (
                result is not None
                and request["at"] is not None
                and result["at"] is not None
                and (
                    request["at"],
                    int(request["record"].split(":")[1]),
                    request["slot"],
                )
                <= (result["at"], int(result["record"].split(":")[1]), result["slot"])
            )
            status = (
                "missing_id"
                if not cid
                else "ambiguous"
                if len(uses) > 1 or len(returns) > 1
                else "pending"
                if not result
                else "unordered_or_undated"
                if not ordered
                else "failed"
                if result["success"] == 0
                else "returned"
            )
            if ordered:
                db.execute(
                    "INSERT INTO call_pairs VALUES(?,?,?,?)",
                    (
                        request["record"],
                        request["slot"],
                        result["record"],
                        result["slot"],
                    ),
                )
                db.execute(
                    "INSERT OR IGNORE INTO pairs VALUES(?,?)",
                    (request["record"], result["record"]),
                )
                db.execute(
                    "INSERT OR IGNORE INTO pairs VALUES(?,?)",
                    (result["record"], request["record"]),
                )
            data = json.loads(request["payload"])
            if not isinstance(data, dict):
                continue
            name = request["tool"].split(".")[-1].casefold()
            operations = file_effects(request["tool"], data)
            owner = sources[request["source"]]
            if (
                name in ("task", "agent", "spawn_agent")
                and ordered
                and result["success"] != 0
            ):
                output = json.loads(result["payload"])
                if isinstance(output, str):
                    try:
                        output = json.loads(output)
                    except ValueError:
                        output = None
                child = (
                    (output.get("native_child_id") or output.get("agent_id"))
                    if isinstance(output, dict)
                    else None
                )
                matches = {
                    s["agent"]
                    for s in sources.values()
                    if s["agent"]
                    and isinstance(child, str)
                    and (s["agent"] == child or s["agent"].endswith(":" + child))
                }
                if len(matches) == 1 and owner["agent"]:
                    identity = digest(
                        encode([request["record"], result["record"], child]).encode()
                    )[:24]
                    db.execute(
                        "INSERT OR IGNORE INTO dispatches VALUES(?,?,?,?,?,?)",
                        (
                            identity,
                            owner["agent"],
                            next(iter(matches)),
                            result["at"],
                            request["record"],
                            result["record"],
                        ),
                    )
            if not operations:
                continue
            # A copied CC record cannot certify one actor as its unique writer.
            copied = (
                db.execute(
                    "SELECT COUNT(DISTINCT s.agent) FROM records r JOIN sources s ON r.source=s.id "
                    "WHERE r.native=(SELECT native FROM records WHERE ref=?)",
                    (request["record"],),
                ).fetchone()[0]
                > 1
            )
            confirmed = ordered and result["success"] == 1 and not copied
            for path, op, basis in operations:
                # Native patch_apply_end is the authoritative observation when
                # present; do not double count the same request/result write.
                if basis == "native_apply_patch" and db.execute(
                    "SELECT 1 FROM parts WHERE role='patch' AND source=? AND call_id=?",
                    (request["source"], cid),
                ).fetchone():
                    continue
                effect(path, owner, op, "confirmed" if confirmed else "candidate",
                       result["at"] if ordered else request["at"], request["record"],
                       result["record"] if ordered else None, "copied_owner" if copied else status,
                       basis, request["slot"], result["slot"] if ordered else None)
        # Adapters may expose a read observed in a runtime execution receipt.
        # Its command and returned output must still form one unambiguous pair.
        for part in db.execute("SELECT * FROM parts WHERE role='read_observation'").fetchall():
            data = json.loads(part["payload"])
            if not isinstance(data, dict):
                continue
            pair = db.execute(
                "SELECT * FROM call_pairs WHERE request=? AND request_slot=? AND result=? AND result_slot=?",
                (part["record"], data.get("request_slot"), part["record"], data.get("result_slot")),
            ).fetchone()
            if pair is None:
                continue
            effect(data.get("path"), sources[part["source"]], "read",
                   "confirmed" if part["success"] == 1 and part["at"] is not None else "candidate",
                   part["at"], pair["request"], pair["result"], "native_observation",
                   "native_command_read", pair["request_slot"], pair["result_slot"])
        for part in db.execute("SELECT * FROM parts WHERE role='patch'").fetchall():
            changes = json.loads(part["payload"])
            if isinstance(changes, dict):
                for path, detail in changes.items():
                    op = (
                        "delete"
                        if isinstance(detail, dict) and detail.get("type") == "delete"
                        else "write"
                    )
                    effect(
                        path,
                        sources[part["source"]],
                        op,
                        "confirmed"
                        if part["success"] == 1 and part["at"] is not None
                        else "candidate",
                        part["at"],
                        None,
                        part["record"],
                        "native_observation",
                        "codex_file_change" if part["family"] == "codex_file_change" else "patch_apply_end",
                        None,
                        part["slot"],
                    )

    def rows(self, sql, values=()):
        return [dict(row) for row in self.db.execute(sql, values)]

    def has_records(self, kind, key, at, *, since=None):
        """Does this node have dated evidence? Not proof of a disk state/author.

        Do not run a full search/count/participant expansion to answer existence.
        Native paths are canonical; lexical fallback must still check full paths.
        """
        if kind == "agent":
            return bool(
                self.db.execute(
                    "SELECT 1 FROM sources s JOIN records r ON r.source=s.id WHERE s.agent=? AND r.at<=? AND (? IS NULL OR r.at>=?) LIMIT 1",
                    (key, at, since, since),
                ).fetchone()
            )
        if kind != "file":
            raise ValueError("node kind must be file or agent")
        key = self.resolve_file(key)
        if self.db.execute(
            "SELECT 1 FROM effects e LEFT JOIN records r ON r.ref=e.request WHERE e.path=? AND "
            "((e.at<=? AND (? IS NULL OR e.at>=?)) OR (r.at<=? AND (? IS NULL OR r.at>=?))) LIMIT 1",
            (key, at, since, since, at, since, since),
        ).fetchone():
            return True
        if "/" in key and self.db.execute(
            "SELECT 1 FROM mentions m JOIN records r ON r.ref=m.record WHERE m.name=? "
            "AND r.at<=? AND (? IS NULL OR r.at>=?) LIMIT 1",
            (key.casefold(), at, since, since),
        ).fetchone():
            return True
        name = posixpath.basename(key).casefold()
        candidates = "records r"
        where, values = "r.at<=?", [at]
        if since is not None:
            where += " AND r.at>=?"
            values.append(since)
        if _FILE_TOKEN.fullmatch(name):
            candidates = "mentions m JOIN records r ON r.ref=m.record"
            where += " AND m.name=?"
            values.append(name)
        # Filename-only navigation is permitted, but an invented full path must
        # not be certified merely because another file has the same basename.
        if "/" in key or candidates == "records r":
            where += " AND (literal_contains(r.body,?) OR literal_contains(r.body,?))"
            values.extend([key.casefold(), key.replace("/", "\\").casefold()])
        return bool(
            self.db.execute(
                "SELECT 1 FROM " + candidates + " WHERE " + where + " LIMIT 1",
                values,
            ).fetchone()
        )

    def source_record(self, ref):
        if isinstance(ref, str) and ref.startswith("e-"):
            ref = self.handle_value(ref, "e")["ref"]
        rows = self.rows(
            "SELECT r.*,s.path,s.name,s.agent,s.cwd FROM records r JOIN sources s ON r.source=s.id WHERE ref=?",
            (ref,),
        )
        if not rows:
            raise ValueError("unknown original reference")
        record = rows[0]
        with Path(record["path"]).open("rb") as stream:
            stream.seek(record["offset"])
            raw = stream.read(record["length"])
        if digest(raw) != record["sha"]:
            raise ValueError("original bytes changed; reference no longer valid")
        return record, raw.decode("utf-8", errors="replace")

    def handle(self, kind, payload):
        """Short, content-addressed coordinates; never generated claims or facts."""
        body = encode(payload)
        prefix = kind + ("-" + payload["kind"] if kind == "s" else "")
        identity = prefix + "-" + digest(body.encode())[:12]
        old = self.rows("SELECT kind,payload FROM handles WHERE id=?", (identity,))
        if old and (old[0]["kind"] != kind or old[0]["payload"] != body):
            raise ValueError("coordinate hash collision")
        if not old:
            managed = self.db.in_transaction
            self.db.execute("INSERT INTO handles VALUES(?,?,?)", (identity, kind, body))
            if not managed:
                self.db.commit()
        return identity

    def handle_value(self, identity, kind):
        if not isinstance(identity, str):
            raise TypeError("coordinate must be a returned handle")
        found = self.rows(
            "SELECT payload FROM handles WHERE id=? AND kind=?", (identity, kind)
        )
        if len(found) != 1:
            raise ValueError("unknown coordinate; use an actual returned handle")
        return json.loads(found[0]["payload"])

    def locate(self, source, line):
        if type(line) is not int or line < 1:
            raise ValueError("line must be a positive integer")
        rows = self.rows(
            "SELECT id FROM sources WHERE name=? OR path=?", (source, source)
        )
        if not rows:
            rows = [
                r
                for r in self.rows("SELECT id,name FROM sources")
                if Path(r["name"]).name == source
            ]
        if len(rows) != 1:
            raise ValueError("source missing or ambiguous; use its full logical name")
        records = self.rows(
            "SELECT ref FROM records WHERE source=? AND line=?", (rows[0]["id"], line)
        )
        if not records:
            raise ValueError("line does not exist")
        return records[0]["ref"]

    def resolve_file(self, key):
        if not isinstance(key, str) or not key:
            raise ValueError("file key required")
        normalized = path_key(key)
        candidates = [
            r["path"]
            for r in self.rows("SELECT path FROM files")
            if r["path"] == normalized or r["path"].endswith("/" + normalized)
        ]
        if len(candidates) > 1:
            raise ValueError("ambiguous file; use full path: " + ", ".join(candidates))
        return candidates[0] if candidates else normalized


def describe_source(path, name):
    """Read native ownership once; directories never establish agent identity."""
    path = Path(path)
    agent, cwd, platform, parent = None, "", "unknown", None
    if path.suffix == ".jsonl":
        with path.open("r", encoding="utf-8-sig", errors="replace") as stream:
            for _ in range(20):
                line = stream.readline()
                if not line:
                    break
                try:
                    obj = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(obj, dict):
                    continue
                found = source_identity(obj)
                if found:
                    agent, cwd = found.agent, found.cwd
                    platform, parent = found.platform, found.parent
                    break
    return Source(
        str(path), name, agent, cwd, "auto" if path.suffix == ".jsonl" else "text", platform, parent
    )


def discover(pool):
    """Register native owners only. A directory hierarchy is never a dispatch edge."""
    root = Path(pool).resolve()
    for path in sorted(root.rglob("*")):
        if path.is_file() and path.suffix in (".jsonl", ".md", ".json", ".py", ".txt"):
            yield describe_source(path, path.relative_to(root).as_posix())
