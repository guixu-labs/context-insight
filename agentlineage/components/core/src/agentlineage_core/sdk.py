"""Versioned compatibility surface for evidence-backed case packaging."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from . import inquiry
from .inquiry.engine import Engine
from .inquiry.report import check
from .inquiry.store import Store, describe_source


def inquiry_kernel() -> tuple[Any, Any, Any, Any, str]:
    root = Path(inquiry.__file__).parent
    files = {path.relative_to(root).as_posix():
             hashlib.sha256(path.read_bytes().replace(b"\r\n", b"\n")).hexdigest()
             for path in sorted(root.rglob("*.py"))}
    checksum = hashlib.sha256(json.dumps(files, sort_keys=True, ensure_ascii=False,
                                        separators=(",", ":")).encode()).hexdigest()
    return Engine, check, Store, describe_source, checksum
