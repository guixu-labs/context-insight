"""Single platform registry used by indexing, original evidence and mechanical checks."""
from .claude import ClaudeAdapter
from .codex import CodexAdapter
from .deveco import DevEcoAdapter
from .dsh import DshAdapter
from ..tool_contracts import normalize_input

ADAPTERS = (DshAdapter(), DevEcoAdapter(), CodexAdapter(), ClaudeAdapter())


def adapter_for(record):
    return next((a for a in ADAPTERS if a.matches(record)), None)


def parts(record, *, owner=None):
    adapter = adapter_for(record)
    if adapter:
        recorded_owner = getattr(adapter, "observation_owner", lambda _: None)(record)
        if owner is not None and recorded_owner and recorded_owner != owner:
            return  # A copied observation remains searchable, not this actor's write.
        for slot, family, role, cid, tool, payload, success in adapter.parts(record):
            if role == "request":
                payload = normalize_input(tool, payload)
            yield slot, family, role, cid, tool, payload, success


def input_role(record):
    adapter = adapter_for(record)
    return adapter.input_role(record) if adapter else None


def identity(record):
    adapter = adapter_for(record)
    return adapter.identity(record) if adapter else None
