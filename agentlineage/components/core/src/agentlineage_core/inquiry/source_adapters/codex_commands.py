"""Decode runtime CommandExecution receipts, not code quoted inside exec calls.

The native parsed_cmd list is a syntax annotation, not proof that a conditional
branch ran. Read observations additionally require a successful straight-line
command of supported literal readers. Unknown scripts remain callable evidence.
"""

from typing import Any
import posixpath
import re
import shlex
from urllib.parse import unquote, urlsplit


def command_text(item):
    command = item.get("command")
    if isinstance(command, str):
        return command
    if not isinstance(command, list) or not command or not all(isinstance(s, str) for s in command):
        return ""
    if len(command) == 3 and command[1] in ("-c", "-lc"):
        return command[2]
    return shlex.join(command)


def absolute_path(path, cwd):
    if not isinstance(path, str) or not path or any(c in path for c in "$`*?{}[]\r\n"):
        return None
    if path.startswith(("~", "-")):
        return None
    path = path.replace("\\", "/")
    if path.startswith("/") or re.match(r"^[A-Za-z]:/", path):
        return posixpath.normpath(path)
    if not isinstance(cwd, str):
        return None
    if cwd.startswith("file:"):
        uri = urlsplit(cwd)
        if uri.netloc not in ("", "localhost") or uri.query or uri.fragment:
            return None
        cwd = unquote(uri.path)
        if re.match(r"^/[A-Za-z]:/", cwd):
            cwd = cwd[1:]
    cwd = cwd.replace("\\", "/")
    if not (cwd.startswith("/") or re.match(r"^[A-Za-z]:/", cwd)):
        return None
    return posixpath.normpath(posixpath.join(cwd, path))


def literal_read_paths(item):
    """A bounded native-read contract; no shell evaluation or output splitting."""
    if item.get("status") != "completed" or type(item.get("exit_code")) is not int or item["exit_code"] != 0:
        return []
    # With ';', the final exit code alone cannot rule out an earlier failed read.
    if item.get("stderr") != "":
        return []
    if not any(isinstance(item.get(k), str) for k in ("stdout", "aggregated_output", "formatted_output")):
        return []
    argv = item.get("command")
    if isinstance(argv, list) and len(argv) == 3 and argv[1] in ("-c", "-lc"):
        if posixpath.basename(argv[0]) not in {"sh", "bash", "zsh", "dash"}:
            return []
    text = command_text(item)
    if not text or any(c in text for c in "$`<>#(){}\r\n"):
        return []
    lexer = shlex.shlex(text, posix=True, punctuation_chars=";&|")
    lexer.whitespace_split, lexer.commenters = True, ""
    try:
        tokens = list(lexer)
    except ValueError:
        return []
    words: list[Any]
    groups, words = [], []
    for token in tokens:
        if token and set(token) <= set(";&|"):
            if token not in (";", "&&") or not words:
                return []
            groups.append(words)
            words = []
        else:
            words.append(token)
    if words:
        groups.append(words)
    elif not tokens or tokens[-1] != ";":
        return []
    paths = set()
    for words in groups:
        name, *args = words
        if name == "sed" and len(args) >= 3 and args[0] == "-n" and re.fullmatch(r"\d+(?:,\d+)?p", args[1]):
            operands = args[2:]
        elif name == "cat":
            operands = args[1:] if args[:1] == ["--"] else args
        elif name in ("head", "tail"):
            if len(args) >= 3 and args[0] == "-n" and args[1].isdigit():
                operands = args[2:]
            elif args and re.fullmatch(r"-\d+", args[0]):
                operands = args[1:]
            else:
                operands = args
        elif name in ("echo", "printf", "wc", "ls", "pwd"):
            # These may contribute output, but do not certify file content reads.
            if name == "printf" and (not args or args[0].startswith("-")):
                return []  # e.g. bash printf -v mutates shell variables.
            continue
        else:
            return []
        resolved = [absolute_path(p, item.get("cwd")) for p in operands]
        if not resolved or any(p is None for p in resolved):
            return []
        paths.update(resolved)
    parsed = item.get("parsed_cmd")
    if not isinstance(parsed, list):
        return []
    native = {absolute_path(p.get("path"), item.get("cwd")) for p in parsed
              if isinstance(p, dict) and p.get("type") == "read"}
    # Both the executed literal command and the runtime annotation must agree.
    return sorted(paths.intersection(native))


def execution_parts(item):
    """One observed call/result, plus generic read-observation projections."""
    cid = item.get("id")
    status, code = item.get("status"), item.get("exit_code")
    success = (0 if status == "failed" or type(code) is int and code != 0
               else 1 if status == "completed" and type(code) is int and code == 0 else None)
    command = command_text(item)
    output = next((item[k] for k in ("stdout", "aggregated_output", "formatted_output")
                   if isinstance(item.get(k), str)), "")
    request = {"command": command, "workdir": item.get("cwd"), "execution_receipt": True}
    result = {"stdout": output, "stderr": item.get("stderr"), "exit_code": code}
    # Both refer to the completed runtime event, never a guessed outer exec id
    # or fabricated earlier request time. Its original JSON is kept unchanged.
    yield (0, "codex_command", "request", cid, "exec_command", request, None)
    yield (1, "codex_command", "result", cid, "exec_command", result, success)
    for slot, path in enumerate(literal_read_paths(item), 2):
        yield (slot, "codex_command", "read_observation", cid, "exec_command",
               {"path": path, "request_slot": 0, "result_slot": 1}, success)
