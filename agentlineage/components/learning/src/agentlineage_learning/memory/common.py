"""Small persistence/validation primitives; no dependency on migloop's UI/core."""
from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def fingerprint(value):
    return hashlib.sha256(encode(value).encode("utf-8")).hexdigest()


def now():
    return datetime.now(timezone.utc).isoformat()


def load(path):
    raw = Path(path).resolve().read_text(encoding="utf-8-sig")
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        try:
            import yaml
        except ImportError as exc:
            raise ValueError("YAML input requires PyYAML; JSON works with Python alone") from exc
        return yaml.safe_load(raw)


def write_new(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8", newline="\n") as stream:
        stream.write(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n")


def replace_json(path, value):
    """Same-directory atomic replacement, called while owning the store lock."""
    path = Path(path)
    fd, temporary = tempfile.mkstemp(prefix=".publish-", suffix=".json", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.isfile(temporary):
            os.unlink(temporary)


def nonempty(value, where):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{where}: expected nonempty text")
    return value


def strings(value, where, *, empty=True):
    if not isinstance(value, list) or (not empty and not value):
        raise ValueError(f"{where}: expected {'nonempty ' if not empty else ''}list")
    for item in value:
        nonempty(item, where)
    return value


def slug(value, where="id"):
    if not isinstance(value, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,95}", value):
        raise ValueError(f"{where}: expected a simple lowercase ID, not a path")
    return value


def fields(value, allowed, required, where):
    if not isinstance(value, dict):
        raise ValueError(f"{where}: expected object")
    extra, missing = set(value) - set(allowed), set(required) - set(value)
    if extra or missing:
        raise ValueError(f"{where}: unknown={sorted(extra)}, missing={sorted(missing)}")


def contained(root, relative):
    root = Path(root).resolve()
    path = (root / relative).resolve()
    if path != root and root not in path.parents:
        raise ValueError("Path leaves the requested workspace")
    return path


def page(items, offset=0, limit=8):
    if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 100:
        raise ValueError("offset must be >= 0; limit must be 1–100")
    end = min(len(items), offset + limit)
    return {"items": items[offset:end], "total": len(items), "offset": offset,
            "next": end if end < len(items) else None, "complete": end >= len(items)}
