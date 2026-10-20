"""Protocol request provenance for a receipt; never infer script file effects."""

import json

from .store import iso, parts


def request_context(store, record, raw, cutoff):
    try:
        value = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(value, dict):
        return None
    receipts = [
        (slot, family, cid)
        for slot, family, role, cid, _, _, _ in parts(value)
        if role == "result"
    ]
    if not receipts:
        return None
    requests, unavailable = [], []
    paired_slots = set()
    for pair in store.rows(
        "SELECT * FROM call_pairs WHERE result=? ORDER BY result_slot", (record["ref"],)
    ):
        paired_slots.add(pair["result_slot"])
        try:
            parent, parent_raw = store.source_record(pair["request"])
            # A later/undated request must not appear to be an earlier input.
            if parent["at"] is None or parent["at"] > cutoff:
                unavailable.append(
                    {"reason": "paired request undated or outside cutoff"}
                )
                continue
            for slot, family, role, cid, tool, data, _ in parts(json.loads(parent_raw)):
                if role != "request" or cid is None or slot != pair["request_slot"]:
                    continue
                for result_slot, result_family, result_cid in receipts:
                    if result_slot != pair["result_slot"] or (family, cid) != (
                        result_family,
                        result_cid,
                    ):
                        continue
                    parameters = data if isinstance(data, dict) else {}
                    argument = parameters.get("command", parameters.get("cmd", ""))
                    if not isinstance(argument, str):
                        argument = ""
                    if not parameters and isinstance(data, str):
                        argument = data
                    preview = (
                        argument
                        if len(argument) <= 400
                        else argument[:240] + "\n…\n" + argument[-160:]
                    )
                    requests.append(
                        {
                            "cite": store.handle("e", {"ref": parent["ref"]}),
                            "source": parent["name"],
                            "line": parent["line"],
                            "at": iso(parent["at"]),
                            "tool": tool,
                            "request_block": slot,
                            "result_block": result_slot,
                            "parameters": {
                                k: parameters[k]
                                for k in (
                                    "file_path",
                                    "path",
                                    "description",
                                    "workdir",
                                    "cwd",
                                )
                                if isinstance(parameters.get(k), str)
                            },
                            "argument_preview": preview,
                            "argument_chars": len(argument),
                            "argument_truncated": len(argument) > 400,
                            "request_after_receipt": record["at"] is not None
                            and parent["at"] > record["at"],
                            "not_effect_proof": True,
                        }
                    )
        except (ValueError, OSError, TypeError) as exc:
            unavailable.append({"reason": str(exc)})
    for slot, _, _ in receipts:
        if slot not in paired_slots:
            unavailable.append(
                {
                    "result_block": slot,
                    "reason": "No unique, time-ordered native request pair. Missing, ambiguous or undated calls remain unbound.",
                }
            )
    return {
        "requests": requests,
        "unavailable": unavailable,
        "note": "Native protocol pair and exact block IDs only. This is the command/parameters that this receipt answers, not a verified read/write or proof of statements inside the output. Preview may be truncated; open the request cite for the complete arguments. Earlier requests may precede the requested lower time bound; their actual times are shown as context, not new in-window events.",
    }
