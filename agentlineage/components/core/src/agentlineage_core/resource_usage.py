"""Evidence of actual native resource reads/invocations, separate from availability."""
from __future__ import annotations

import ntpath
import posixpath
import re
from typing import Any


def path_key(value):
    if not isinstance(value, str) or not value:
        return ""
    value = value.strip("\"'").replace("\\", "/")
    return ntpath.normpath(value).replace("\\", "/").casefold() if re.match(r"^[A-Za-z]:/", value) else posixpath.normpath(value)


def command_access(command):
    if not isinstance(command, str):
        return
    # Match argument positions, never a filename mentioned in prose/echo/output.
    for clause in re.split(r";|&&|\n", command):
        tokens = [value.strip("\"'") for value in re.findall(r'''"[^"\r\n]*"|'[^'\r\n]*'|[^\s]+''', clause)]
        if tokens and tokens[0] == "&":
            tokens.pop(0)
        if not tokens:
            continue
        program = tokens[0].replace("\\", "/").rsplit("/", 1)[-1].lower()
        if program in ("cat", "get-content", "type"):
            for token in tokens[1:]:
                if not token.startswith("-"):
                    yield "read", token
        elif program in ("python", "python.exe", "python3", "node", "node.exe", "bash", "sh"):
            if len(tokens) > 1 and not tokens[1].startswith("-"):
                yield "invoke", tokens[1]
        elif "/" in tokens[0] or "\\" in tokens[0]:
            yield "invoke", tokens[0]


def resource_usage(resources, records):
    results = {(r["session_id"], r.get("call_id")): r for r in records
               if r["kind"] == "tool-result" and r.get("call_id")}
    names: dict[tuple[str, str], list[int]] = {}
    for index, resource in enumerate(resources):
        name = resource.get("native_name") or resource.get("displayName")
        if name:
            names.setdefault((resource.get("kind"), name), []).append(index)
    hits: list[list[dict[str, Any]]] = [[] for _ in resources]
    seen = set()
    for record in records:
        if record["kind"] != "tool-call":
            continue
        result = results.get((record["session_id"], record.get("call_id")))
        if not result or result.get("success") is False:
            continue
        tool = (record.get("tool") or "").lower()
        args = record.get("input") or {}
        if not isinstance(args, dict):
            continue
        matched = []
        if tool in ("skill", "task", "agent"):
            kind = "skill" if tool == "skill" else "agent"
            name = args.get("name") or args.get("skill") if kind == "skill" else args.get("subagent_type") or args.get("agent")
            indices = names.get((kind, name), []) if isinstance(name, str) else []
            if len(indices) == 1:
                matched.append((indices[0], "invoke"))
        paths = []
        if tool in ("read", "read_file", "readfile"):
            paths.append(("read", args.get("filePath") or args.get("file_path") or args.get("path")))
        elif tool in ("bash", "shell", "exec_command", "run_shell_command"):
            paths.extend(command_access(args.get("command") or args.get("cmd")))
        for operation, path in paths:
            key = path_key(path)
            if not key:
                continue
            for index, resource in enumerate(resources):
                exact = any(key == path_key(value) for value in resource.get("native_paths", []))
                root = path_key(resource.get("native_root"))
                if exact or root and key.startswith(root.rstrip("/") + "/"):
                    matched.append((index, operation))
        for index, operation in matched:
            identity = (index, record["session_id"], record.get("call_id") or record["id"], operation)
            if identity in seen:
                continue
            seen.add(identity)
            hits[index].append({"operation": operation, "session_id": record["session_id"],
                                "tool": record.get("tool"), "timestamp": record.get("timestamp"),
                                "record_id": record["id"], "evidence": record["evidence"]})
    output = []
    for resource, observed in zip(resources, hits):
        prior = resource.get("usage") or {}
        native = {"readCount": sum(o["operation"] == "read" for o in observed),
                  "invocationCount": sum(o["operation"] == "invoke" for o in observed),
                  "source": "native-session", "complete": False, "observations": observed[:32],
                  "observations_truncated": len(observed) > 32}
        # Never sum native and host counters: they can describe the same calls.
        usage = native if observed else prior if prior.get("readCount", 0) or prior.get("invocationCount", 0) else {
            "readCount": None, "invocationCount": None, "source": "not-observed", "complete": False}
        output.append({**resource, "usage": usage})
    return output
