"""HTTP transport; the default deployment is one private evidence workspace."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import hmac
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import logging
import re
import threading
import time
from typing import Any
from urllib.parse import parse_qs, urlparse
from uuid import uuid4

from .api import Core, CoreError, MAX_SOURCE_BYTES, digest, encoded
from .observations import observations, source_content, create_repair, get_repair, list_repairs

LOG = logging.getLogger(__name__)

HOME = """<!doctype html><html lang="en"><meta charset="utf-8"><title>AgentLineage</title>
<style>body{font:16px system-ui;max-width:900px;margin:60px auto;padding:24px;background:#f4f6f9;color:#17253b}input,button{font:inherit;padding:10px}li{margin:20px 0}a{color:#1852ac}small{display:block;color:#546176}</style>
<h1>AgentLineage</h1><p>Native session evidence and repair lineage</p>
<form id="login" hidden><label>Workspace access token <input id="token" type="password" autocomplete="off"></label><button>Sign in</button></form>
<p id="status"></p><ul id="runs"></ul>
<script>
async function load(){const r=await fetch('/v1/runs');if(r.status===401){document.querySelector('#login').hidden=false;return}
const d=await r.json();const list=document.querySelector('#runs');list.replaceChildren();
for(const run of d.items||[]){const li=document.createElement('li');const a=document.createElement('a');a.textContent=run.external_key;
if(run.latest_snapshot_id)a.href='/v1/snapshots/'+encodeURIComponent(run.latest_snapshot_id)+'/viewer';li.append(a);
const small=document.createElement('small');small.textContent=run.project_id+' 路 '+run.completeness;li.append(small);list.append(li)}
document.querySelector('#status').textContent=d.items?.length?'Select a task to explore its frozen evidence.':'Import a native session using the CLI or API.'}
document.querySelector('#login').onsubmit=async e=>{e.preventDefault();const input=document.querySelector('#token');const r=await fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:input.value})});input.value='';
if(r.ok){document.querySelector('#login').hidden=true;await load()}else document.querySelector('#status').textContent='Sign-in failed'};
load().catch(()=>document.querySelector('#status').textContent='Service unavailable');
</script></html>"""



class CoreServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], handler: type[BaseHTTPRequestHandler],
                 executor: ThreadPoolExecutor) -> None:
        self.executor = executor
        super().__init__(address, handler)

    def server_close(self) -> None:
        super().server_close()
        self.executor.shutdown(wait=True, cancel_futures=True)


def create_server(core: Core, host: str = "127.0.0.1", port: int = 0,
                  token: str | None = None) -> CoreServer:
    if host not in ("127.0.0.1", "localhost", "::1") and not token:
        raise ValueError("Non-loopback binding requires an explicit access token")
    executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="lineage-import")
    from .streams import LiveStore
    live = LiveStore(core)
    job_lock = threading.Lock()
    request_lock = threading.Lock()
    sessions: dict[str, float] = {}

    def save_job(job: dict[str, Any]) -> None:
        with core._db() as db:
            db.execute("INSERT OR REPLACE INTO jobs VALUES(?,?)", (job["id"], encoded(job)))

    def import_job(job: dict[str, Any], run_id: str, source_ids: list[str]) -> None:
        with job_lock:
            current = core._read("job", job["id"])
            if current["status"] == "cancelled":
                return
            job["status"] = "running"
            save_job(job)
        try:
            snapshot = core.create_snapshot(run_id, source_ids)
            job.update(status="succeeded", result={"snapshot_id": snapshot["id"]})
        except Exception:
            LOG.exception("Import failed: %s", job["id"])
            job.update(status="failed", error={"code": "IMPORT_FAILED",
                                               "message": "Import failed; inspect service log by job ID"})
        with job_lock:
            if core._read("job", job["id"])["status"] == "cancel_requested":
                job["status"] = "cancelled"
            save_job(job)

    with core._db() as db:
        for identity, value in db.execute("SELECT id,value FROM jobs").fetchall():
            job = json.loads(value)
            if job["status"] in ("queued", "running", "cancel_requested"):
                job.update(status="failed", error={"code": "INTERRUPTED",
                                                   "message": "Service restarted; retry explicitly"})
                db.execute("UPDATE jobs SET value=? WHERE id=?", (encoded(job), identity))

    class Handler(BaseHTTPRequestHandler):
        server_version = "AgentLineage/0.1"
        timeout = 30
        cache_write: tuple[str, str, str] | None = None
        response_cookie: str | None = None

        def log_message(self, *_: object) -> None:
            return

        def send(self, status: int, body: Any,
                 mime: str = "application/json; charset=utf-8") -> None:
            raw = body.encode("utf-8") if isinstance(body, str) else encoded(body).encode()
            if self.cache_write is not None and 200 <= status < 300:
                with core._db() as db:
                    db.execute("INSERT OR IGNORE INTO idempotency VALUES(?,?,?,?,?,?)",
                               (*self.cache_write, status, raw.decode("utf-8"), mime))
            self.send_response(status)
            if self.response_cookie:
                self.send_header("Set-Cookie", self.response_cookie)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(raw)

        def handle_request(self, writing: bool) -> None:
            try:
                origin = self.headers.get("Origin")
                if writing and origin and urlparse(origin).netloc != self.headers.get("Host"):
                    raise CoreError("CROSS_ORIGIN", "Cross-origin writes are refused", 403)
                hostname = urlparse("http://" + self.headers.get("Host", "")).hostname
                if host in ("127.0.0.1", "localhost", "::1") and hostname not in ("127.0.0.1", "localhost", "::1"):
                    raise CoreError("INVALID_HOST", "Unexpected Host header", 403)
                parsed = urlparse(self.path)
                cookies = SimpleCookie(self.headers.get("Cookie", ""))
                session = cookies.get("agentlineage_session")
                cookie_valid = session is not None and sessions.get(session.value, 0) > time.monotonic()
                public = parsed.path in ("/login", "/")
                if token and not public and not cookie_valid and not hmac.compare_digest(
                        self.headers.get("Authorization", ""), "Bearer " + token):
                    raise CoreError("UNAUTHORIZED", "Valid Bearer authorization required", 401)
                parsed = urlparse(self.path)
                args = parse_qs(parsed.query)
                raw = b""
                if writing:
                    length = int(self.headers.get("Content-Length", "0"))
                    limit = MAX_SOURCE_BYTES if (parsed.path == "/v1/sources" or re.fullmatch(r"/v1/runs/[^/]+/live/upsert", parsed.path)) else 1024 * 1024
                    if self.headers.get("Transfer-Encoding") or not 0 <= length <= limit:
                        raise CoreError("BODY_TOO_LARGE", "Unsupported or oversized request", 413)
                    raw = self.rfile.read(length)
                    if len(raw) != length:
                        raise CoreError("TRUNCATED_BODY", "Incomplete request body")
                key = self.headers.get("Idempotency-Key") if writing and not public else None
                if key:
                    if len(key) > 200:
                        raise CoreError("INVALID_KEY", "Idempotency key is too long")
                    request_hash = digest(raw)
                    with core._db() as db:
                        cached = db.execute("SELECT digest,status,body,mime FROM idempotency WHERE path=? AND key=?",
                                            (self.path, key)).fetchone()
                    if cached:
                        if cached[0] != request_hash:
                            raise CoreError("IDEMPOTENCY_CONFLICT", "Key was used for a different body", 409)
                        self.send(cached[1], cached[2], cached[3])
                        return
                    self.cache_write = (self.path, key, request_hash)
                if parsed.path == "/v1/sources" and writing:
                    source = core.upload_source(raw, args.get("name", ["session.jsonl"])[0],
                                                args.get("format", ["auto"])[0],
                                                allow_partial=args.get("partial", ["false"])[0] == "true")
                    self.send(201, source)
                    return
                data = json.loads(raw) if raw else {}
                if not isinstance(data, dict):
                    raise CoreError("INVALID_BODY", "JSON object required")
                self.route(parsed.path, parsed.query, args, data, writing)
            except CoreError as exc:
                self.send(exc.status, {"error": exc.as_dict()})
            except (ValueError, TypeError, KeyError, OSError) as exc:
                self.send(400, {"error": {"code": "INVALID_INPUT", "message": str(exc),
                                         "retryable": False}})
            except Exception:
                identity = uuid4().hex
                LOG.exception("Request failed: %s", identity)
                self.send(500, {"error": {"code": "INTERNAL", "message": "Request failed",
                                         "request_id": identity, "retryable": False}})

        def route(self, path: str, query: str, args: dict[str, list[str]],
                  data: dict[str, Any], writing: bool) -> None:
            if path == "/login" and writing:
                supplied = data.get("token")
                if token and (not isinstance(supplied, str) or not hmac.compare_digest(supplied, token)):
                    raise CoreError("UNAUTHORIZED", "Invalid access token", 401)
                now = time.monotonic()
                for identity, expires in list(sessions.items()):
                    if expires <= now:
                        del sessions[identity]
                if len(sessions) >= 32:
                    raise CoreError("SESSION_LIMIT", "Too many browser sessions", 429)
                identity = uuid4().hex + uuid4().hex
                sessions[identity] = now + 3600
                secure = "; Secure" if host not in ("127.0.0.1", "localhost", "::1") else ""
                self.response_cookie = f"agentlineage_session={identity}; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600{secure}"
                self.send(200, {"authenticated": True})
                return
            if path == "/" and not writing:
                self.send(200, HOME, "text/html; charset=utf-8")
                return
            match = re.fullmatch(r"/v1/runs/([^/]+)/live/(state|append|upsert|query|freeze)", path)
            if match:
                run_id, action = match.groups()
                if action == "state" and not writing:
                    self.send(200, live.state(run_id))
                    return
                if action != "state" and writing:
                    self.send(200, getattr(live, action)(run_id, data))
                    return
            if path == "/v1/repairs" and writing:
                self.send(201, create_repair(core, data))
                return
            match = re.fullmatch(r"/v1/repairs/([^/]+)", path)
            if match and not writing:
                self.send(200, get_repair(core, match[1]))
                return
            match = re.fullmatch(r"/v1/runs/([^/]+)/repairs", path)
            if match and not writing:
                self.send(200, list_repairs(core, match[1]))
                return
            match = re.fullmatch(r"/v1/sources/([^/]+)/content", path)
            if match and not writing:
                self.send(200, source_content(core, match[1]))
                return
            match = re.fullmatch(r"/v1/snapshots/([^/]+)/resolve", path)
            if match and writing:
                self.send(200, core.resolve_evidence(match[1], data))
                return
            match = re.fullmatch(r"/v1/snapshots/([^/]+)/observations", path)
            if match and writing:
                self.send(200, observations(core, match[1], data))
                return
            if path == "/v1/runs" and not writing:
                with core._db() as db:
                    rows = db.execute("SELECT value FROM runs ORDER BY rowid DESC LIMIT 100").fetchall()
                self.send(200, {"items": [json.loads(row[0]) for row in rows]})
                return
            if path in ("/health", "/v1/capabilities") and not writing:
                self.send(200, core.capabilities())
                return
            if path == "/v1/runs" and writing:
                self.send(201, core.create_run(data["external_key"], data.get("project_id", "default"),
                                               data.get("objective", "")))
                return
            match = re.fullmatch(r"/v1/runs/([^/]+)(?:/(snapshots|imports|trace))?", path)
            if match:
                run_id, action = match.groups()
                run = core.get_run(run_id)
                if not action and not writing:
                    self.send(200, run)
                    return
                if action == "snapshots" and writing:
                    source_ids = data.get("source_ids")
                    if source_ids is None and run["latest_snapshot_id"]:
                        source_ids = core.get_snapshot(run["latest_snapshot_id"])["source_ids"]
                    self.send(201, core.create_snapshot(run_id, source_ids or [], data.get("gaps"), data.get("context")))
                    return
                if action == "imports" and writing:
                    sources = data.get("sources")
                    if not isinstance(sources, list) or not sources:
                        raise CoreError("INVALID_SOURCES", "Nonempty sources list required")
                    source_ids = [source["source_id"] for source in sources]
                    for source_id in source_ids:
                        core._read("source", source_id)
                    job = {"id": "job_" + uuid4().hex, "status": "queued", "run_id": run_id}
                    save_job(job)
                    executor.submit(import_job, job, run_id, source_ids)
                    self.send(202, job)
                    return
                if action == "trace" and not writing:
                    snapshot_id = args.get("snapshot_id", [run["latest_snapshot_id"]])[0]
                    if not snapshot_id or core.get_snapshot(snapshot_id)["run_id"] != run_id:
                        raise CoreError("INVALID_SNAPSHOT", "Snapshot must belong to requested run")
                    limit = min(500, max(1, int(args.get("limit", ["50"])[0])))
                    offset = max(0, int(args.get("offset", ["0"])[0]))
                    with core.evidence(snapshot_id) as engine:
                        rows = engine.store.rows(
                            "SELECT ref,source,line,at,kind,summary FROM records ORDER BY at,line LIMIT ? OFFSET ?",
                            (limit + 1, offset))
                    self.send(200, {"snapshot_id": snapshot_id, "items": rows[:limit],
                                    "next_offset": offset + limit if len(rows) > limit else None})
                    return
            match = re.fullmatch(r"/v1/snapshots/([^/]+)(?:/(.*))?", path)
            if match:
                snapshot_id, action = match.groups()
                if action is None and not writing:
                    self.send(200, core.get_snapshot(snapshot_id))
                    return
                if action == "viewer" and not writing:
                    self.send(200, core.viewer(snapshot_id, f"/v1/snapshots/{snapshot_id}/inquiry"),
                              "text/html; charset=utf-8")
                    return
                if action and action.startswith("inquiry/"):
                    route = "/" + action.removeprefix("inquiry/") + ("?" + query if query else "")
                    status, body, mime = core.viewer_request(snapshot_id, route, data if writing else None)
                    self.send(status, body, mime)
                    return
            if path == "/v1/lineage" and writing:
                self.send(200, core.file_lineage(data["snapshot_id"], data["path"], data["at"]))
                return
            if path == "/v1/query" and writing:
                requests = data["requests"]
                if not isinstance(requests, list) or not 1 <= len(requests) <= 24:
                    raise CoreError("INVALID_QUERY", "Batch must contain 1 to 24 requests")
                results = []
                for position, item in enumerate(requests):
                    try:
                        result = core.query(data["snapshot_id"], item)["result"]
                        results.append({"request_index": position, "status": "ok", "result": result})
                    except (ValueError, TypeError, KeyError) as exc:
                        results.append({"request_index": position, "status": "error",
                                        "error": str(exc)})
                self.send(200, {"snapshot_id": data["snapshot_id"], "results": results})
                return
            if path in ("/v1/reports/check", "/v1/reports") and writing:
                self.send(201 if path == "/v1/reports" else 200, core.check_report(
                    data["snapshot_id"], data["document"], save=path == "/v1/reports"))
                return
            match = re.fullmatch(r"/v1/reports/([^/]+)", path)
            if match and not writing:
                self.send(200, core.get_report(args["snapshot_id"][0], match[1]))
                return
            match = re.fullmatch(r"/v1/jobs/([^/]+)(/cancel)?", path)
            if match:
                with job_lock:
                    job = core._read("job", match[1])
                    if match[2] and writing and job["status"] in ("queued", "running"):
                        job["status"] = "cancelled" if job["status"] == "queued" else "cancel_requested"
                        save_job(job)
                self.send(202 if writing else 200, job)
                return
            raise CoreError("NOT_FOUND", "Route not found", 404)

        def do_GET(self) -> None:
            self.handle_request(False)

        def do_POST(self) -> None:
            with request_lock:
                self.handle_request(True)

    return CoreServer((host, port), Handler, executor)
