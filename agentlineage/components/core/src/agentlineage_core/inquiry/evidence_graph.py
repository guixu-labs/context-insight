"""Materialize cited native relations, not an inferred causal explanation.

Models supply node judgments. With edges omitted, the server places only
byte-checked indexed operations on the graph. Added endpoints stay neutral;
query order, copied summaries and lexical mentions never create connections.
"""

from .citations import cited_refs
from .store import iso, timestamp


def attach(engine, finding, target):
    if "edges" in finding:
        return {
            **finding,
            "edges": finding["edges"] + finding.get("reviewed_edges", []),
        }
    cutoff = timestamp(target["at"], required=True)
    nodes = [dict(node) for node in finding.get("nodes", [])]
    refs, citations = set(), {}
    for ref in cited_refs(finding, engine.store):
        try:
            record, _ = engine.store.source_record(ref)
            if record["at"] is not None and record["at"] <= cutoff:
                refs.add(record["ref"])
                citations[ref] = record["ref"]
        except (ValueError, OSError, TypeError):
            pass  # The regular report checker diagnoses the original reference.

    def coordinates(node):
        if "scope" in node:
            return engine.store.handle_value(node["scope"], "s")
        return node

    def endpoint(kind, key, at, evidence, observed_at=None):
        matches = []
        for node in nodes:
            value = coordinates(node)
            actual_key = (
                engine.store.resolve_file(value["key"])
                if value["kind"] == "file"
                else value["key"]
            )
            when = timestamp(value["at"], required=True)
            start = timestamp(value.get("since"))
            if (
                value["kind"] == kind
                and actual_key == key
                and at <= when <= cutoff
                and (start is None or start <= at)
            ):
                cited_here = bool(
                    set(evidence)
                    & {citations.get(ref, ref) for ref in node.get("evidence", [])}
                )
                matches.append((not cited_here, when, node))
        if matches:
            # A background/input node with an earlier cutoff must not steal
            # the edge from a later claim citing this actual write (or read).
            return min(matches, key=lambda item: item[:2])[2]["id"]
        scope = engine.store.handle(
            "s",
            {
                "kind": kind,
                "key": key,
                "at": iso(observed_at if observed_at is not None else at),
                "since": None,
            },
        )
        identity = "recorded-" + scope
        while any(n.get("id") == identity for n in nodes):
            identity += "-event"
        nodes.append(
            {
                "id": identity,
                "scope": scope,
                "role": "context",
                "reason": "原生操作的证据端点；模型未对这个节点单独归因。",
                "evidence": evidence,
            }
        )
        return identity

    edges = []
    for operation in engine.relations("pool", None, cutoff):
        evidence = [ref for ref in (operation["request"], operation["result"]) if ref]
        if (
            operation["op"] not in ("read", "write")
            or not operation["agent"]
            or operation["at"] is None
            or not refs.intersection(evidence)
        ):
            continue
        # Both endpoints and the operation evidence are rechecked by report.check.
        agent = endpoint("agent", operation["agent"], operation["at"], evidence)
        file = endpoint("file", operation["path"], operation["at"], evidence)
        origin, destination = (
            (file, agent) if operation["op"] == "read" else (agent, file)
        )
        edges.append(
            {
                "from": origin,
                "to": destination,
                "link": engine.link_view(operation, target["at"])["link"],
                "claim": f"原生记录：{operation['op']} @ {iso(operation['at'])}；仅认证历史关系，不证明问题传播。",
            }
        )
    for dispatch in engine.dispatches(cutoff):
        evidence = [dispatch[k] for k in ("request", "result") if dispatch[k]]
        if not refs.intersection(evidence):
            continue
        observed_at = min(dispatch["confirmed_at"], cutoff)
        edges.append(
            {
                "from": endpoint(
                    "agent", dispatch["parent"], dispatch["at"], evidence, observed_at
                ),
                "to": endpoint(
                    "agent", dispatch["child"], dispatch["at"], evidence, observed_at
                ),
                "relation": "dispatch",
                "evidence": evidence,
                "claim": "原生派发；不认证问题内容传播。",
            }
        )
    return {
        **finding,
        "nodes": nodes,
        "edges": edges + finding.get("reviewed_edges", []),
    }
