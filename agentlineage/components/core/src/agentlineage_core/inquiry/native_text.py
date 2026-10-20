"""Select protocol-native change payloads; never interpret arbitrary scripts."""

import difflib
import json

from .store import encode, parts, path_key


def change_payloads(store, operation):
    ref = operation["request"] or operation["result"]
    record, raw = store.source_record(ref)
    value = json.loads(raw)
    result = []
    for slot, family, role, cid, tool, data, _ in parts(value):
        if slot != operation["request_slot" if operation["request"] else "result_slot"]:
            continue
        if role == "patch" and isinstance(data, dict):
            for path, detail in data.items():
                if path_key(path, record["cwd"]) == operation["path"]:
                    result.append({"block": slot, "tool": tool, "body": detail})
        elif role == "request" and isinstance(data, dict):
            if not isinstance(tool, str):
                continue
            name = tool.split(".")[-1].casefold()
            if name == "apply_patch":
                for path, detail in data.get("changes", {}).items():
                    if path_key(path, record["cwd"]) == operation["path"]:
                        result.append({"block": slot, "tool": tool, "body": detail})
                continue
            path = data.get("file_path") or data.get("path")
            if (
                name not in {"write", "write_file", "edit", "multiedit", "delete_file"}
                or not isinstance(path, str)
                or path_key(path, record["cwd"]) != operation["path"]
            ):
                continue
            result.append(
                {
                    "block": slot,
                    "tool": tool,
                    "body": {
                        k: v for k, v in data.items() if k not in ("file_path", "path")
                    },
                }
            )
    return result


def render_payloads(payloads):
    lines = []
    for payload in payloads:
        lines.append(
            f"NATIVE {payload['tool']} block={payload['block']} (literal payload, not recovered history)"
        )
        body = payload["body"]
        fields = body.items() if isinstance(body, dict) else [("text", body)]
        for name, value in fields:
            lines += [name.upper(), value if isinstance(value, str) else encode(value)]
    return "\n".join(lines)


def change_outline(payloads):
    """Complete within-call deltas; whole writes are explicitly folded, not diffed."""
    rows = []
    for payload in payloads:
        body = payload["body"]
        if not isinstance(body, dict):
            rows.append(
                {
                    "kind": "metadata",
                    "text": encode(body),
                    "block": payload["block"],
                    "step": 0,
                    "tool": payload["tool"],
                }
            )
            continue
        edits = body["edits"] if isinstance(body.get("edits"), list) else [body]
        for step, edit in enumerate(edits):
            row = {"block": payload["block"], "step": step, "tool": payload["tool"]}
            if (
                isinstance(edit, dict)
                and isinstance(edit.get("old_string"), str)
                and isinstance(edit.get("new_string"), str)
            ):
                old, new = (
                    edit["old_string"].splitlines(),
                    edit["new_string"].splitlines(),
                )
                row.update(
                    kind="edit_delta",
                    old_lines=len(old),
                    new_lines=len(new),
                    replace_all=edit.get("replace_all", False),
                    literal_equal=edit["old_string"] == edit["new_string"],
                    only_line_endings_changed=old == new
                    and edit["old_string"] != edit["new_string"],
                    text="\n".join(
                        difflib.unified_diff(
                            old,
                            new,
                            fromfile="old argument",
                            tofile="new argument",
                            n=0,
                            lineterm="",
                        )
                    ),
                )
                if row["only_line_endings_changed"]:
                    row["text"] = (
                        "Only line endings differ in the literal arguments; open the full native payload to inspect bytes."
                    )
            elif isinstance(edit, dict) and isinstance(edit.get("unified_diff"), str):
                row.update(kind="native_patch", text=edit["unified_diff"])
            elif isinstance(edit, dict) and isinstance(edit.get("content"), str):
                row.update(
                    kind="snapshot_folded",
                    snapshot_lines=len(edit["content"].splitlines()),
                    snapshot_chars=len(edit["content"]),
                    text="Whole write body folded; open request/result for full content. Not a diff against a known previous state or proof of first introduction.",
                )
            else:
                row.update(kind="metadata", text=encode(edit))
            rows.append(row)
    return rows


def term_deltas(payloads, terms):
    """Literal payload matches, not line authors, replay or proof of execution."""
    hits = []
    for payload in payloads:
        body = payload["body"]
        if not isinstance(body, dict):
            continue
        edits = body["edits"] if isinstance(body.get("edits"), list) else [body]
        for step, edit in enumerate(edits):
            if not isinstance(edit, dict):
                continue
            before, after, basis = [], [], ""
            if isinstance(edit.get("old_string"), str) and isinstance(
                edit.get("new_string"), str
            ):
                before, after = (
                    edit["old_string"].splitlines(),
                    edit["new_string"].splitlines(),
                )
                basis = "edit_literal"
            elif isinstance(edit.get("unified_diff"), str):
                for line in edit["unified_diff"].splitlines():
                    if line.startswith(("--- ", "+++ ", "@@", "\\")):
                        continue
                    if line.startswith(("-", " ")):
                        before.append(line[1:])
                    if line.startswith(("+", " ")):
                        after.append(line[1:])
                basis = "patch_literal"
            elif isinstance(edit.get("content"), str):
                after, basis = edit["content"].splitlines(), "write_payload"
            for term in terms:
                old = [line for line in before if term.casefold() in line.casefold()]
                new = [line for line in after if term.casefold() in line.casefold()]
                if not old and not new:
                    continue
                delta = (
                    "write_contains_not_birth"
                    if basis == "write_payload"
                    else "added_in_payload"
                    if not old
                    else "removed_in_payload"
                    if not new
                    else "unchanged_matching_lines"
                    if old == new
                    else "changed_matching_lines"
                )
                hits.append(
                    {
                        "block": payload["block"],
                        "step": step,
                        "tool": payload["tool"],
                        "term": term,
                        "delta": delta,
                        "basis": basis,
                        "old_lines": old,
                        "new_lines": new,
                    }
                )
    return hits
