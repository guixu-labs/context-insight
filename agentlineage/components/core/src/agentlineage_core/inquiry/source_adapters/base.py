"""Source-format contract. Adapters decode records, never infer filesystem effects."""
from typing import NamedTuple, Protocol


class Identity(NamedTuple):
    platform: str
    agent: str | None
    cwd: str = ""
    parent: str | None = None


class Adapter(Protocol):
    name: str
    def matches(self, record: dict) -> bool: ...
    def identity(self, record: dict) -> Identity | None: ...
    def parts(self, record: dict): ...
    def input_role(self, record: dict) -> str | None: ...


def message_role(message):
    if not isinstance(message, dict):
        return None
    role, content = message.get("role"), message.get("content")
    if role in ("user", "system", "developer") and (
        isinstance(content, str) and bool(content)
        or isinstance(content, list) and any(
            isinstance(b, dict) and b.get("type") in ("text", "input_text", "image", "input_image")
            for b in content
        )
    ):
        return role
    return None
