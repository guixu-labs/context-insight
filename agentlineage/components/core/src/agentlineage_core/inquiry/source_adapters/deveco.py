"""DevEco native exports projected to dated events, retaining native coordinates.

Input and output are separate observations: future output is never included in
the request projection. The result retains the complete native part. No Claude
messages, synthetic tool IDs, inferred times, or inferred dispatches are made.
"""
from .base import Identity

FORMAT = "deveco-events/1"


class DevEcoAdapter:
    name = "deveco"

    def matches(self, record):
        return record.get("format") == FORMAT

    def identity(self, record):
        info = record.get("session", {})
        if info.get("id"):
            return Identity(self.name, info["id"], info.get("directory") or "", info.get("parentID"))

    def input_role(self, record):
        role = record.get("message", {}).get("role")
        part = record.get("part", {})
        if role in ("user", "system", "developer") and part.get("type") in ("text", "file"):
            return role

    def parts(self, record):
        part = record.get("part", {})
        if part.get("type") != "tool":
            return
        state = part.get("state", {})
        phase = record.get("phase")
        tool = part.get("tool", "")
        if phase == "request":
            data = state.get("input")
            yield (0, "deveco", "request", part.get("callID"), tool, data, None)
        elif phase == "result":
            success = {"completed": 1, "error": 0}.get(state.get("status"))
            metadata = state.get("metadata") or {}
            if type(metadata.get("exit")) is int and metadata["exit"] != 0:
                success = 0
            # Only native metadata, never session names extracted from prose.
            data = {"content": state.get("output", state.get("error")),
                    "native_child_id": metadata.get("sessionId") or metadata.get("sessionID")}
            yield (0, "deveco", "result", part.get("callID"), "", data, success)
