"""Bind declared check receipts to actual calls; never certify validation scope."""

import json

from .engine import bounds, in_scope
from .store import iso, parts, timestamp


def bind_checks(engine, document, nodes, issues):
    bound = []
    identities = {n["id"]: n for n in nodes}
    for finding in document["findings"]:
        checks = finding.get("checks", [])
        if not isinstance(checks, list) or len(checks) > 100:
            raise ValueError("checks must be a list of at most 100 native receipt claims")
        for index, item in enumerate(checks):
            where = f"{finding['id']}.checks[{index}]"
            fields = {"node", "request", "result", "tool", "claim"}
            slots = {"request_block", "result_block"}
            if (not isinstance(item, dict) or not fields <= item.keys()
                    or set(item) - fields - slots
                    or any(not isinstance(item[k], str) or not item[k].strip() for k in fields)
                    or any(type(item[k]) is not int or item[k] < 0 for k in slots & item.keys())):
                raise ValueError(where + " requires node/request/result/tool/claim and optional nonnegative block numbers")
            try:
                node = identities.get(f"{finding['id']}:{item['node']}")
                if not node or node["kind"] != "agent" or not node["exists"]:
                    raise ValueError("check node must identify a recorded agent")
                request, raw_request = engine.store.source_record(item["request"])
                result, raw_result = engine.store.source_record(item["result"])
                if request["agent"] != node["key"] or result["agent"] != node["key"]:
                    raise ValueError("check executed by a different agent than the declared node")
                at, since = bounds(node)
                target = document["target"]
                cutoff = engine.store.handle_value(target["scope"], "s")["at"] if "scope" in target else target["at"]
                at = min(at, timestamp(cutoff, required=True))
                if not in_scope(result["at"], at, since) or not in_scope(request["at"], at, None):
                    raise ValueError("check request/result is undated or outside the node's time scope")
                pairs = engine.store.rows("SELECT * FROM call_pairs WHERE request=? AND result=?",
                                          (request["ref"], result["ref"]))
                pairs = [p for p in pairs if all(item[k] == p[k.replace("block", "slot")]
                         for k in slots & item.keys())]
                if len(pairs) != 1:
                    raise ValueError("check needs one native request/result pair; use block numbers when ambiguous")
                pair = pairs[0]
                original_request = next((p for p in parts(json.loads(raw_request))
                    if p[0] == pair["request_slot"] and p[2] == "request"), None)
                original_result = next((p for p in parts(json.loads(raw_result))
                    if p[0] == pair["result_slot"] and p[2] == "result"), None)
                if not original_request or not original_result or original_request[4] != item["tool"]:
                    raise ValueError("declared tool does not match the native request")
                bound.append({"finding": finding["id"], **item, "node": node["id"],
                    "status": "native_pair", "request_at": iso(request["at"]), "result_at": iso(result["at"]),
                    "request_block": pair["request_slot"], "result_block": pair["result_slot"],
                    "protocol_success": original_result[6], "semantic_verified": False,
                    "note": "Actual call/receipt and actor only. Tool success or PASS inside output is not proof that this target state or behavior was verified."})
            except (ValueError, TypeError, KeyError, OSError) as exc:
                issues.append({"where": where, "error": str(exc)})
    return bound
