"""One citation vocabulary for checking and displaying a model's evidence.

Query results and original records remain different identities. A diagnostic
can point to a source, but must never silently rewrite a model's citation.
"""

from typing import Any

import json
import re

from .store import iso


def inline_refs(value):
    if isinstance(value, str):
        return re.findall(r"\be-[0-9a-f]{8,64}\b", value)
    if isinstance(value, (list, dict)):
        parts = value.values() if isinstance(value, dict) else value
        return [ref for part in parts for ref in inline_refs(part)]
    return []


def cited_refs(finding, store):
    """Explicit raw references plus prose citations, never IDs or query order."""
    refs: list[Any]
    refs = []

    def explicit(value):
        if isinstance(value, list):
            refs.extend(ref for ref in value if isinstance(ref, str))

    explicit(finding.get("changes"))
    for field in ("title", "reason", "unknown", "hypothesis", "recommendation", "boundary"):
        refs.extend(inline_refs(finding.get(field)))
    for node in finding.get("nodes", []):
        explicit(node.get("evidence"))
        refs.extend(inline_refs(node.get("reason")))
    for check in finding.get("checks", []):
        if isinstance(check, dict):
            explicit([check.get("request"), check.get("result")])
            refs.extend(inline_refs(check.get("claim")))
    for edge in finding.get("edges", []):
        if not isinstance(edge, dict):
            continue  # The report checker diagnoses malformed edge objects.
        explicit(edge.get("evidence"))
        if "link" in edge:
            try:
                explicit(store.handle_value(edge["link"], "l")["evidence"])
            except (ValueError, TypeError, KeyError):
                pass
    return set(refs)


def reference_hint(engine, ref):
    """Only exact, owned original-query matches; neither aliasing nor guessing."""
    identity = ref.removeprefix("e-")
    rows = engine.store.rows(
        "SELECT request,data FROM runs WHERE kind=? AND id=?", ("query", identity)
    )
    if not rows or json.loads(rows[0]["request"])["session"] != engine.session:
        return None
    result = json.loads(rows[0]["data"])[0]
    data = result.get("data", {})
    if not result.get("ok") or data.get("kind") != "original":
        return None  # An aggregate search is not a particular original record.
    try:
        record, _ = engine.store.source_record(data["ref"])
    except (ValueError, OSError):
        return None  # The old query must not certify changed source bytes.
    return {
        "kind": "query_result_used_as_source",
        "query_result": identity,
        "source_cite": data["cite"],
        "source": data["source"],
        "line": record["line"],
        "at": iso(record["at"]),
        "note": "This is a pagination/result ID, not an original citation. Reopen the source and correct your own report; no replacement or semantic verification was performed.",
    }
