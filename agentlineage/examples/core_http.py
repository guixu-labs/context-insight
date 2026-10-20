"""Import native files and query an existing Core service using only stdlib."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener
from uuid import uuid4

DATA = Path(__file__).with_name("data")


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_: Any, **__: Any) -> None:
        return None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8110")
    parser.add_argument("--token-env", default="AGENTLINEAGE_TOKEN")
    parser.add_argument("--source", type=Path, action="append")
    parser.add_argument("--file", default="/demo/view.py")
    parser.add_argument("--at", default="2026-01-01T00:00:09Z")
    args = parser.parse_args()
    base = args.base_url.rstrip("/")
    url = urlparse(base)
    local = url.hostname in ("localhost", "127.0.0.1", "::1")
    if (url.scheme != "https" and not (local and url.scheme == "http")) or url.username or url.password or url.query or url.fragment or url.path:
        raise ValueError("Use a loopback HTTP or remote HTTPS origin without credentials or path")
    token = os.environ.get(args.token_env, "")
    client = build_opener(NoRedirect())

    def request(path: str, payload: dict[str, Any] | bytes | None = None) -> dict[str, Any]:
        headers = {"Authorization": "Bearer " + token} if token else {}
        if isinstance(payload, dict):
            raw = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        else:
            raw = payload
        with client.open(Request(base + path, data=raw, headers=headers), timeout=60) as response:
            return json.load(response)

    run = request("/v1/runs", {"external_key": "http-example-" + uuid4().hex[:8],
                               "project_id": "examples"})
    sources = args.source or [DATA / "generation.jsonl", DATA / "repair.jsonl"]
    identities = [request("/v1/sources?name=" + quote(path.name, safe=""), path.read_bytes())["id"]
                  for path in sources]
    snapshot = request("/v1/runs/" + run["id"] + "/snapshots", {"source_ids": identities})
    result = request("/v1/query", {"snapshot_id": snapshot["id"], "requests": [{
        "op": "file", "key": args.file, "at": args.at, "view": "relations"}]})
    assert result["results"][0]["status"] == "ok", result
    print(json.dumps({"run_id": run["id"], "snapshot_id": snapshot["id"],
                      "query": result,
                      "viewer": base + "/v1/snapshots/" + snapshot["id"] + "/viewer"},
                     ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
