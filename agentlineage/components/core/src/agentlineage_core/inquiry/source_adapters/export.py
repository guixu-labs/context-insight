"""Freeze a selected DevEco session tree from a read-only DB or native exports."""

from typing import Any
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sqlite3

from .deveco import FORMAT


def iso_ms(value):
    if type(value) not in (int, float):
        return None
    return datetime.fromtimestamp(value / 1000, timezone.utc).isoformat()


def _encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def events(document):
    """Deterministic, lossless native payloads with explicit input/output projection."""
    info = document["info"]
    sid = info["id"]
    session = {"id": sid, "directory": info.get("directory"),
               "parentID": info.get("parentID", info.get("parent_id"))}
    header = {"format": FORMAT, "type": "deveco_session", "session": session,
              "timestamp": iso_ms((info.get("time") or {}).get("created", info.get("time_created"))),
              "info": info, "origin": {"session": sid}}
    yield header
    projected = []
    for message in document["messages"]:
        mi = message["info"]
        mid = mi["id"]
        for part in message.get("parts", []):
            pid = part["id"]
            origin = {"session": sid, "message": mid, "part": pid,
                      "part_sha256": hashlib.sha256(_encoded(part).encode()).hexdigest()}
            base = {"format": FORMAT, "type": "deveco_part", "session": session,
                    "origin": origin}
            state = part.get("state") or {}
            times = state.get("time") or {}
            if part.get("type") == "tool":
                # Request contains no future output, preview, diagnostics or token totals.
                req = {k: v for k, v in part.items() if k != "state"}
                req["state"] = {"input": state.get("input"), "time": {"start": times.get("start")}}
                projected.append(dict(base, phase="request", timestamp=iso_ms(times.get("start")),
                                      message={"id": mid, "role": mi.get("role")}, part=req))
                if state.get("status") in ("completed", "error"):
                    projected.append(dict(base, phase="result", timestamp=iso_ms(times.get("end")),
                                          message=mi, part=part))
            else:
                time = (part.get("time") or {}).get("end")
                if time is None:
                    time = (mi.get("time") or {}).get("completed" if mi.get("role") == "assistant" else "created")
                projected.append(dict(base, phase="message", timestamp=iso_ms(time), message=mi, part=part))
    # Undated parts remain visible, but cannot certify temporal relationships.
    yield from sorted(projected, key=lambda p: (p["timestamp"] or "", p["origin"]["message"],
                      p["origin"]["part"], {"request": 0, "result": 1, "message": 2}[p["phase"]]))


def load_database(path, root_session):
    if not root_session:
        raise ValueError("DevEco DB requires an explicit root session ID; the whole database is never exported")
    db = sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    try:
        db.execute("PRAGMA query_only=ON")
        db.execute("BEGIN")  # One consistent snapshot of sessions, messages AND parts.
        queue, seen, documents = [root_session], set(), []
        while queue:
            sid = queue.pop(0)
            if sid in seen:
                continue
            seen.add(sid)
            row = db.execute("SELECT * FROM session WHERE id=?", (sid,)).fetchone()
            if row is None:
                raise ValueError("DevEco session does not exist: " + sid)
            info = dict(row)
            info["parentID"] = info.get("parent_id")
            parts: dict[Any, Any]
            parts = {}
            for p in db.execute("SELECT id,message_id,data FROM part WHERE session_id=? ORDER BY time_created,id", (sid,)):
                data = json.loads(p["data"])
                data.update(id=p["id"], messageID=p["message_id"], sessionID=sid)
                parts.setdefault(p["message_id"], []).append(data)
            messages = []
            for m in db.execute("SELECT id,data FROM message WHERE session_id=? ORDER BY time_created,id", (sid,)):
                data = json.loads(m["data"])
                data.update(id=m["id"], sessionID=sid)
                messages.append({"info": data, "parts": parts.pop(m["id"], [])})
            if parts:
                raise ValueError("DevEco snapshot has orphan parts; retry after session synchronization")
            documents.append({"info": info, "messages": messages})
            queue.extend(r[0] for r in db.execute("SELECT id FROM session WHERE parent_id=? ORDER BY id", (sid,)))
        return documents
    finally:
        db.close()


def freeze_deveco(source, destination, root_session=None):
    source, destination = Path(source).resolve(), Path(destination).resolve()
    if destination.exists():
        raise ValueError("Frozen export destination must be new; will not overwrite material")
    if source.suffix.lower() in (".db", ".sqlite", ".sqlite3"):
        documents = load_database(source, root_session)
    else:
        paths = sorted(source.glob("*.json")) if source.is_dir() else [source]
        documents = []
        for path in paths:
            text = path.read_text(encoding="utf-8-sig")
            if text.startswith("Exporting session:"):
                text = text[text.index("\n") + 1:]
            doc = json.loads(text)
            if not isinstance(doc.get("info"), dict) or not isinstance(doc.get("messages"), list):
                raise ValueError("Expected native DevEco {info,messages} export: " + str(path))
            documents.append(doc)
        if root_session:
            selected, ids = [], {root_session}
            while True:
                added = [d for d in documents if d["info"]["id"] in ids or d["info"].get("parentID") in ids]
                more = {d["info"]["id"] for d in added}
                if more <= ids:
                    selected = added
                    break
                ids |= more
            documents = selected
    names = [d["info"].get("id") for d in documents]
    if not names or len(set(names)) != len(names) or any(not isinstance(n, str) or not re.fullmatch(r"[\w-]+", n) for n in names):
        raise ValueError("Missing, duplicate or unsafe DevEco session identity")
    destination.mkdir(parents=True)
    sources = []
    for doc in documents:
        name = doc["info"]["id"] + ".jsonl"
        data = ("\n".join(_encoded(r) for r in events(doc)) + "\n").encode()
        (destination / name).write_bytes(data)
        sources.append({"name": name, "sha256": hashlib.sha256(data).hexdigest()})
    manifest = {"format": FORMAT, "root_session": root_session, "sources": sources,
                "origin": str(source), "scope": "explicit session and descendants" if root_session else "provided native exports"}
    (destination / "export-manifest.json").write_text(_encoded(manifest) + "\n", encoding="utf-8")
    return manifest
