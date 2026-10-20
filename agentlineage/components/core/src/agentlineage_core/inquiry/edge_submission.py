"""Submission history for report-local overrides, not another relation index."""

import json
from pathlib import PurePosixPath

from .store import digest, encode, timestamp


def agent_key(store, name):
    """Resolve an exact actor or a unique transcript name; never fuzzy-match."""
    sources = store.rows("SELECT name,path,agent FROM sources")
    if any(s["agent"] == name for s in sources):
        return name
    matches = [s for s in sources if name in (s["name"], s["path"])]
    if not matches:
        matches = [s for s in sources if PurePosixPath(s["name"].replace("\\", "/")).name == name]
    actors = {s["agent"] for s in matches if s["agent"]}
    if len(actors) != 1:
        raise ValueError("agent/transcript missing or ambiguous; use its full transcript name or exact agent key")
    return actors.pop()


def edge_key(origin, destination, relation):
    # Local YAML labels and alternative timestamp spellings are not identity.
    coordinates = [[n["kind"], n["key"], timestamp(n["at"], required=True),
                    timestamp(n.get("since"))] for n in (origin, destination)]
    return digest(encode([coordinates, relation]).encode())


def previous_feedback(engine, document, target):
    identity = document.get("revision_of")
    if identity is None:
        return set()
    rows = engine.store.rows("SELECT request,data FROM runs WHERE kind='report' AND id=?", (identity,))
    if len(rows) != 1:
        raise ValueError("revision_of must identify an existing server-checked report")
    old = json.loads(rows[0]["data"])
    if old["source_sha256"] != digest(rows[0]["request"].encode()):
        raise ValueError("revision_of original document has changed")
    def scope(t):
        return (engine.store.resolve_file(t["file"]), timestamp(t["at"], required=True), timestamp(t.get("since")))
    if scope(old["target"]) != scope(target):
        raise ValueError("revision_of belongs to a different target/time interval")
    if old.get("submission_policy") != "checked-force/1":
        raise ValueError("revision_of predates force feedback; submit an ordinary draft first")
    # Only server-generated retryable warnings (or already accepted overrides)
    # authorize the exact same endpoints/ranges. A failed forced attempt does not.
    return (set(old.get("force_permissions", []))
            | {e["edge_key"] for e in old["unverified_edges"] if e.get("force_eligible")}
            | {e["edge_key"] for e in old["edges"] if e.get("force") and e.get("edge_key")})


def confirmed_edges(engine, origin, destination, relation, target_at):
    """Return every matching confirmed operation. Never pick an arbitrary writer."""
    cutoff = min(timestamp(n["at"], required=True) for n in (origin, destination))
    cutoff = min(cutoff, timestamp(target_at, required=True))
    starts = [timestamp(n["since"], required=True) for n in (origin, destination) if n.get("since") is not None]
    start = max(starts) if starts else None
    if relation == "dispatch":
        return [{"relation": "dispatch", "evidence": [d[k] for k in ("request", "result") if d[k]]}
                for d in engine.dispatches(cutoff, start, agent=origin["key"])
                if d["parent"] == origin["key"] and d["child"] == destination["key"] and d["strength"] == "confirmed"]
    file, agent = (origin, destination) if relation == "read" else (destination, origin)
    return [{"link": engine.link_view(e, target_at)["link"]}
            for e in engine.relations("file", file["key"], cutoff, start)
            if e["agent"] == agent["key"] and e["op"] == relation and e["strength"] == "confirmed"]


def call_window(engine, agent, cutoff, start, observation):
    """Can any real call anchor an override here? Return time-only repair hints."""
    source = (
        " FROM records r JOIN sources s ON s.id=r.source WHERE s.agent=? AND r.at<=? "
        "AND (EXISTS(SELECT 1 FROM calls c WHERE c.record=r.ref) "
        "OR EXISTS(SELECT 1 FROM tool_returns t WHERE t.record=r.ref))")
    params = (agent, timestamp(observation, required=True))
    if engine.store.rows("SELECT 1" + source + " AND r.at<=? AND (? IS NULL OR r.at>=?) LIMIT 1",
                         params + (cutoff, start, start)):
        return True, None
    next_call = engine.store.rows("SELECT MIN(r.at) AS at" + source + " AND r.at>?", params + (cutoff,))
    return False, next_call[0]["at"]
