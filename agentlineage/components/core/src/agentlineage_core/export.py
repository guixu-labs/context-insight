"""Self-contained evidence summaries; source text is always escaped."""
from __future__ import annotations

import html
import json
from typing import Any

from .api import Core


def export_document(core: Core, snapshot_id: str, format: str = "html") -> str:
    snapshot = core.get_snapshot(snapshot_id)
    with core.evidence(snapshot_id) as engine:
        records = engine.store.rows("SELECT ref,line,at,kind,summary FROM records ORDER BY at,line")
        effects = engine.store.rows("SELECT * FROM effects ORDER BY at,id")
        reports = engine.store.rows("SELECT id,data FROM runs WHERE kind='report' ORDER BY rowid")
    payload: dict[str, Any] = {"schema": "agentlineage-export/1", "snapshot": snapshot,
                               "records": records, "effects": effects,
                               "reports": [{"id": row["id"], "report": json.loads(row["data"])}
                                           for row in reports],
                               "semantic_verified": False}
    text = json.dumps(payload, ensure_ascii=False, indent=2)
    if format == "json":
        return text
    if format != "html":
        raise ValueError("Export format must be html or json")
    title = html.escape(core.get_run(snapshot["run_id"])["external_key"])
    sections = []
    for heading, entries in [("Observed operations", effects), ("Timeline", records),
                             ("Investigation reports", payload["reports"])]:
        details = "".join("<details><summary>" + html.escape(str(
            item.get("path", item.get("summary", item.get("id", "Evidence"))))) +
            "</summary><pre>" + html.escape(json.dumps(item, ensure_ascii=False, indent=2)) +
            "</pre></details>" for item in entries)
        sections.append("<section><h2>" + heading + "</h2>" + details + "</section>")
    return """<!doctype html><html lang="en"><meta charset="utf-8">
<title>AgentLineage evidence report</title><style>
body{font:16px system-ui;max-width:1100px;margin:48px auto;padding:20px;color:#203047}
details{background:#f2f5f9;padding:14px;margin:10px 0;border-radius:8px}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px monospace}summary{cursor:pointer}
</style><h1>""" + title + """</h1><p>Recorded evidence and model claims remain distinct.
Mechanical validity does not certify causality. Material completeness: """ + html.escape(
        snapshot["completeness"]) + "</p>" + "".join(sections) + "</html>"
