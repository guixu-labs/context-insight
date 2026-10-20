"""Shared literal tool contracts. No platform branching and no script execution."""

from typing import Any
import re
import posixpath


def normalize_input(tool, value):
    name = tool.split(".")[-1].casefold() if isinstance(tool, str) else ""
    if name == "apply_patch":
        patch = value if isinstance(value, str) else value.get("patch", value.get("input")) if isinstance(value, dict) else None
        if isinstance(patch, str):
            return {"patch": patch, "changes": patch_changes(patch)}
    if isinstance(value, dict):
        aliases = {"filePath": "file_path", "oldString": "old_string",
                   "newString": "new_string", "replaceAll": "replace_all"}
        return {aliases.get(k, k): v for k, v in value.items()}
    return value


def patch_changes(patch):
    """Only the native apply_patch grammar, never text embedded in shell/JS."""
    lines = patch.strip().splitlines()
    if not lines or lines[0] != "*** Begin Patch" or lines[-1] != "*** End Patch":
        return {}
    body: list[Any]
    changes, current, body = {}, None, []

    def finish():
        if current:
            changes[current]["unified_diff"] = "\n".join(body)

    for line in lines[1:-1]:
        header = re.fullmatch(r"\*\*\* (Add|Update|Delete) File: (.+)", line)
        if header:
            finish()
            current, body = header[2], []
            if current in changes:
                return {}  # Ambiguous path duplication stays unclassified.
            changes[current] = {"type": header[1].lower()}
        elif line.startswith("*** Move to: ") and current:
            destination = line.removeprefix("*** Move to: ")
            changes[current]["type"] = "delete"
            current = destination
            changes[current] = {"type": "update"}
        elif current:
            body.append(line)
        else:
            return {}
    finish()
    return changes


def file_effects(tool, data):
    if not isinstance(data, dict):
        return []
    name = tool.split(".")[-1].casefold()
    if name == "apply_patch":
        return [(path, "delete" if detail["type"] == "delete" else "write", "native_apply_patch")
                for path, detail in data.get("changes", {}).items()]
    op = {"read": "read", "read_file": "read", "write": "write", "write_file": "write",
          "edit": "write", "multiedit": "write", "delete_file": "delete"}.get(name)
    return [(data.get("file_path") or data.get("path"), op, "native_tool")] if op else []


def navigation_paths(tool, data, cwd=""):
    """Literal absolute shell paths for navigation ONLY, including opaque scripts.

    A quoted path may occur in documentation or dead code. Registering its name
    creates no effect, no confirmed relationship, no file contents or state.
    """
    name = tool.split(".")[-1].casefold() if isinstance(tool, str) else ""
    if name not in {"bash", "shell_command", "exec_command", "run_shell_command", "exec", "js"}:
        return []
    command = data.get("command", data.get("cmd")) if isinstance(data, dict) else data
    if not isinstance(command, str):
        return []
    tokens = [m[1] for m in re.finditer(r'''["']([^"'\r\n]+)["']''', command)]
    tokens += re.findall(r'''(?<![\w:])(?:[A-Za-z]:[/\\]|/)[^\s"'<>|;&(){}]+''', command)
    result = set()
    for token in tokens:
        token = token.replace("\\", "/")
        if not (token.startswith("/") or re.match(r"^[A-Za-z]:/", token)):
            continue
        if any(c in token for c in "$`*?{}\n") or token.startswith("//"):
            continue
        if re.search(r"\.[A-Za-z][A-Za-z0-9]{0,15}$", token):
            result.add(posixpath.normpath(token))
    return sorted(result)
