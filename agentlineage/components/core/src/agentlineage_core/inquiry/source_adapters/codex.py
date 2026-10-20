"""Codex native rollout JSONL; shell/JS bodies are opaque calls, not nested executions."""
import json
from .base import Identity, message_role
from .codex_commands import execution_parts


class CodexAdapter:
    name = "codex"

    def matches(self, record):
        return record.get("type") in ("session_meta", "turn_context", "response_item", "event_msg")

    def identity(self, record):
        if record.get("type") == "session_meta" and isinstance(record.get("payload"), dict):
            p = record["payload"]
            source = p.get("source")
            sub = source.get("subagent", {}) if isinstance(source, dict) else {}
            spawned = sub.get("thread_spawn", {}) if isinstance(sub, dict) else {}
            return Identity(self.name, p.get("id"), p.get("cwd") or "", spawned.get("parent_thread_id"))

    def input_role(self, record):
        p = record.get("payload")
        if not isinstance(p, dict):
            return None
        if record.get("type") == "event_msg" and p.get("type") == "user_message":
            return "user"
        return message_role(p) if p.get("type") == "message" else None

    def observation_owner(self, record):
        payload = record.get("payload") or {}
        if record.get("type") == "event_msg" and payload.get("type") == "item_completed":
            return payload.get("thread_id")

    def parts(self, record):
        payload = record.get("payload")
        if not isinstance(payload, dict):
            return
        kind = payload.get("type")
        if record.get("type") == "event_msg" and kind == "item_completed":
            item = payload.get("item")
            if isinstance(item, dict) and item.get("type") == "FileChange":
                # Native execution receipt from the runtime, not an apply_patch
                # string found inside exec. Do not pair it to a guessed outer call.
                status = item.get("status")
                success = 1 if status == "completed" else 0 if status == "failed" else None
                yield (0, "codex_file_change", "patch", item.get("id"), "apply_patch",
                       item.get("changes"), success)
            elif isinstance(item, dict) and item.get("type") == "CommandExecution":
                yield from execution_parts(item)
            return
        if record.get("type") == "response_item":
            if kind in ("function_call", "custom_tool_call"):
                value = (
                    payload.get("arguments")
                    if kind == "function_call"
                    else payload.get("input")
                )
                if isinstance(value, str):
                    try:
                        value = json.loads(value)
                    except ValueError:
                        pass
                yield (
                    0,
                    kind,
                    "request",
                    payload.get("call_id"),
                    payload.get("name", ""),
                    value,
                    None,
                )
            elif kind in ("function_call_output", "custom_tool_call_output"):
                value = payload.get("output")
                if isinstance(value, str):
                    try:
                        value = json.loads(value)
                    except ValueError:
                        pass
                success = None
                metadata = value.get("metadata") if isinstance(value, dict) else None
                for container in (payload, value, metadata):
                    if isinstance(container, dict):
                        if type(container.get("exit_code")) is int:
                            success = int(container["exit_code"] == 0)
                        if type(container.get("success")) is bool:
                            success = int(container["success"])
                        if type(container.get("is_error")) is bool:
                            success = int(not container["is_error"])
                yield (
                    0,
                    kind.removesuffix("_output"),
                    "result",
                    payload.get("call_id"),
                    "",
                    value,
                    success,
                )
        if record.get("type") == "event_msg" and kind == "patch_apply_end":
            success = (
                int(payload["success"]) if type(payload.get("success")) is bool else None
            )
            yield (
                0,
                "patch",
                "patch",
                payload.get("call_id"),
                "apply_patch",
                payload.get("changes"),
                success,
            )
