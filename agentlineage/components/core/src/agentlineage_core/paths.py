"""Data-directory paths that retain native Windows long-path support."""
from __future__ import annotations

import os
from pathlib import Path


def data_path(value: str | Path) -> Path:
    path = Path(value).expanduser().absolute()
    text = str(path)
    if os.name == "nt" and not text.startswith("\\\\?\\"):
        text = "\\\\?\\UNC\\" + text[2:] if text.startswith("\\\\") else "\\\\?\\" + text
        path = Path(text)
    return path.resolve()
