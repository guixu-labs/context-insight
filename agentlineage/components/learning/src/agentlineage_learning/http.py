"""Independent single-workspace service; publication uses a separate credential."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import hmac
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import json
import logging
import re
import threading
from typing import Any
from urllib.parse import parse_qs, urlparse

from agentlineage_core.api import CoreError, MAX_SOURCE_BYTES, digest, encoded

from .api import Learning
from .worker import Investigations

LOG = logging.getLogger(__name__)


def public(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: public(item) for key, item in value.items() if key != "path"}
    if isinstance(value, list):
        return [public(item) for item in value]
    return value


class LearningServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], handler: type[BaseHTTPRequestHandler],
                 executor: ThreadPoolExecutor) -> None:
        self.executor = executor
        super().__init__(address, handler)

    def server_close(self) -> None:
        super().server_close()
        self.executor.shutdown(wait=True, cancel_futures=True)


def create_server(learning: Learning, worker: Investigations, host: str = "127.0.0.1",
                  port: int = 0, token: str | None = None,
                  publish_token: str | None = None) -> LearningServer:
    if host not in ("localhost", "127.0.0.1") and not token:
        raise ValueError("Non-loopback binding requires an explicit access token")
    if publish_token and publish_token == token:
        raise ValueError("Publication requires a separate access token")
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="lineage-investigation")
    write_lock = threading.Lock()
    with worker.db() as db:
        db.execute("CREATE TABLE IF NOT EXISTS requests(path TEXT,key TEXT,digest TEXT,status INT,"
                   "body TEXT,PRIMARY KEY(path,key))")

    class Handler(BaseHTTPRequestHandler):
        timeout = 30
        server_version = "AgentLineage-Learning/0.1"

        def log_message(self, *_: object) -> None:
            return

        def send(self, status: int, value: Any) -> None:
            raw = encoded(public(value)).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(raw)

        def handle_request(self, writing: bool) -> None:
            try:
                parsed = urlparse(self.path)
                hostname = urlparse("http://" + self.headers.get("Host", "")).hostname
                if host in ("localhost", "127.0.0.1") and hostname not in ("localhost", "127.0.0.1"):
                    raise CoreError("INVALID_HOST", "Unexpected Host header", 403)
                origin = self.headers.get("Origin")
                if writing and origin and urlparse(origin).netloc != self.headers.get("Host"):
                    raise CoreError("CROSS_ORIGIN", "Cross-origin writes are refused", 403)
                authorization = self.headers.get("Authorization", "")
                publisher = bool(publish_token and hmac.compare_digest(authorization, "Bearer " + publish_token))
                if token and not publisher and not hmac.compare_digest(authorization, "Bearer " + token):
                    raise CoreError("UNAUTHORIZED", "Valid service token required", 401)
                if parsed.path in ("/v1/cases/ingest", "/v1/cases/withdraw", "/v1/memory/proposals") and not publisher:
                    raise CoreError("PUBLICATION_DENIED", "Publication credential required", 403)
                raw = b""
                if writing:
                    length = int(self.headers.get("Content-Length", "0"))
                    limit = MAX_SOURCE_BYTES if parsed.path == "/v1/sources" else 1024 * 1024
                    if self.headers.get("Transfer-Encoding") or not 0 <= length <= limit:
                        raise CoreError("BODY_TOO_LARGE", "Unsupported or oversized body", 413)
                    raw = self.rfile.read(length)
                    if len(raw) != length:
                        raise CoreError("TRUNCATED_BODY", "Incomplete request body")
                key = self.headers.get("Idempotency-Key") if writing else None
                if key:
                    if len(key) > 200:
                        raise CoreError("INVALID_KEY", "Idempotency key is too long")
                    with worker.db() as db:
                        cached = db.execute("SELECT digest,status,body FROM requests WHERE path=? AND key=?",
                                            (self.path, key)).fetchone()
                    if cached:
                        if cached[0] != digest(raw):
                            raise CoreError("IDEMPOTENCY_CONFLICT", "Key was used for another body", 409)
                        self.send(cached[1], json.loads(cached[2]))
                        return
                if parsed.path == "/v1/sources" and writing:
                    args = parse_qs(parsed.query)
                    status, value = 201, learning.evidence.upload_source(
                        raw, args.get("name", ["session.jsonl"])[0])
                else:
                    data = json.loads(raw) if raw else {}
                    if not isinstance(data, dict):
                        raise CoreError("INVALID_BODY", "JSON object required")
                    status, value = self.route(parsed.path, data, writing)
                if key and 200 <= status < 300:
                    with worker.db() as db:
                        db.execute("INSERT INTO requests VALUES(?,?,?,?,?)",
                                   (self.path, key, digest(raw), status, encoded(public(value))))
                self.send(status, value)
            except CoreError as exc:
                self.send(exc.status, {"error": exc.as_dict()})
            except (ValueError, KeyError, TypeError, OSError) as exc:
                self.send(400, {"error": {"code": "INVALID_INPUT", "message": str(exc)}})
            except Exception:
                LOG.exception("Learning request failed")
                self.send(500, {"error": {"code": "INTERNAL", "message": "Inspect service log"}})

        def route(self, path: str, data: dict[str, Any], writing: bool) -> tuple[int, Any]:
            if path in ("/health", "/v1/capabilities") and not writing:
                return 200, {**learning.capabilities(), "executor_configured": worker.executor is not None}
            if path == "/v1/investigations/query" and writing:
                key = data.get("run_key")
                if not isinstance(key, str) or not 1 <= len(key) <= 200:
                    raise ValueError("Nonempty run_key required")
                with worker.db() as db:
                    items = [json.loads(row[0]) for row in db.execute(
                        "SELECT value FROM jobs ORDER BY rowid DESC")]
                return 200, {"items": [item for item in items if item["run_key"] == key][:20]}
            if path == "/v1/investigations" and writing:
                with worker.db() as db:
                    pending = sum(json.loads(row[0])["status"] in ("running", "queued")
                                  for row in db.execute("SELECT value FROM jobs"))
                if pending >= 32:
                    raise CoreError("QUEUE_FULL", "Investigation queue is full", 429)
                investigation = learning.prepare_sources(data["run_key"], data["source_ids"], data["triage"])
                value = worker.submit(investigation["id"], data["budget"])
                executor.submit(worker.run, investigation["id"])
                return 202, value
            match = re.fullmatch(r"/v1/investigations/(inv_[a-f0-9]{32})(?:/(cancel|resume|cases))?", path)
            if match:
                identity, action = match.groups()
                if not action and not writing:
                    return 200, worker.get(identity)
                if action == "cases" and not writing:
                    from .memory.common import load
                    return 200, {"items": [{**case, "card": load(case["path"])}
                                           for case in worker.get(identity).get("cases", [])]}
                if action == "cancel" and writing:
                    return 202, worker.cancel(identity)
                if action == "resume" and writing:
                    value = worker.resume(identity)
                    executor.submit(worker.run, identity)
                    return 202, value
            if path == "/v1/memory/revision" and not writing:
                return 200, learning.memory.current()
            if path == "/v1/memory/search" and writing:
                return 200, learning.search(data["query"], data.get("topic", ""),
                                           data.get("offset", 0), data.get("limit", 8))
            if path == "/v1/memory/browse" and writing:
                return 200, learning.browse(data.get("topic", ""), data.get("offset", 0),
                                           data.get("limit", 8))
            if path == "/v1/memory/read" and writing:
                return 200, learning.read_lessons(data["ids"])
            if path == "/v1/cases/ingest" and writing:
                cases = worker.get(data["investigation_id"]).get("cases", [])
                if not cases:
                    raise ValueError("Investigation has no mechanically valid cases")
                return 200, learning.ingest([case["path"] for case in cases], data["expected_revision"])
            if path == "/v1/cases/read" and writing:
                return 200, learning.get_case(data["id"], data.get("revision"))
            if path == "/v1/memory/impact" and writing:
                return 200, learning.impact(data["id"], data.get("claim"))
            if path == "/v1/cases/withdraw" and writing:
                return 200, learning.withdraw(data["id"], data["reason"],
                                              data["expected_revision"], data.get("claim"))
            if path == "/v1/memory/proposals" and writing:
                return 200, learning.apply_proposal(data)
            raise CoreError("NOT_FOUND", "Route not found", 404)

        def do_GET(self) -> None:
            self.handle_request(False)

        def do_POST(self) -> None:
            with write_lock:
                self.handle_request(True)

    return LearningServer((host, port), Handler, executor)
