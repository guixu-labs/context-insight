"""Exact match distribution for navigation; never a file-effect classifier."""

from .store import iso


def matching_agents(store, request, scope, table, values, *, offset=0, limit=4):
    # Reuse the same filtered record set, including return-kind and time filters.
    groups = store.rows(
        "WITH matched AS (SELECT s.agent,r.ref,r.at,s.name,r.line" + table + "), "
        "ranked AS (SELECT *,COUNT(*) OVER(PARTITION BY agent) AS matches, "
        "MIN(at) OVER(PARTITION BY agent) AS first_at, "
        "MAX(at) OVER(PARTITION BY agent) AS last_at, "
        "SUM(at IS NULL) OVER(PARTITION BY agent) AS undated, "
        "ROW_NUMBER() OVER(PARTITION BY agent ORDER BY at IS NULL,at DESC,name,line DESC) AS rn "
        "FROM matched) SELECT agent,matches,first_at,last_at,undated,ref FROM ranked "
        "WHERE rn=1 ORDER BY matches DESC,agent",
        values,
    )
    total = len(groups)
    if offset and offset >= total:
        raise ValueError(
            f"offset {offset} outside {total} matching agents; restart at 0"
        )
    rows = []
    for group in groups[offset : offset + limit]:
        raw = store.rows("SELECT body FROM records WHERE ref=?", (group["ref"],))[0][
            "body"
        ]
        positions = [
            raw.casefold().find(t.casefold()) for t in request.get("terms", [])
        ]
        start = max(0, min((p for p in positions if p >= 0), default=0) - 30)
        query = None
        if group["agent"] is not None:
            query = {
                k: v
                for k, v in request.items()
                if k not in ("kind", "key", "offset", "limit", "group_by")
            }
            query.update(
                kind="agent",
                key=group["agent"],
                offset=0,
                limit=20,
            )
            # Keep an explicit order above; otherwise let the shared query
            # kernel apply the view's default, just as it did for the pool.
        rows.append(
            {
                **group,
                "first_at": iso(group["first_at"]),
                "last_at": iso(group["last_at"]),
                "latest_match": store.handle("e", {"ref": group["ref"]}),
                "excerpt": raw[start : start + 160].replace("\n", " "),
                "query": query,
            }
        )
    return {
        "kind": "matching_agents",
        "scope": scope,
        "total": total,
        "matched_records": sum(g["matches"] for g in groups),
        "rows": rows,
        "next": offset + len(rows) if offset + len(rows) < total else None,
        "query": {**request, "group_by": "agent", "offset": 0, "limit": 20},
        "note": "Matching records grouped by recorded actor, not readers/writers or validation proof. "
        "Counts cover this query, not every possible relevant event. Sample is latest matching "
        "record, not latest valid result; raw return may be a quoted document. Unknown owner has no fabricated agent query.",
    }
