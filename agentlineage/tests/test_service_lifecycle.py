from __future__ import annotations

import json
import threading

from agentlineage_core.api import Core, encoded
from agentlineage_core.http import create_server
from test_core_http import request
from conftest import timestamp


def test_core_restart_preserves_snapshot_and_marks_unfinished_jobs(tmp_path, native_pool):
    core = Core(tmp_path / "service")
    snapshot = core.import_files("restart", [native_pool])["snapshot_id"]
    with core._db() as db:
        db.execute("INSERT INTO jobs VALUES(?,?)", ("job_" + "a" * 32,
                   encoded({"id": "job_" + "a" * 32, "status": "running"})))
    server = create_server(Core(tmp_path / "service"), token="test-token")
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        base = f"http://127.0.0.1:{server.server_port}"
        status, body, _ = request(base, "/v1/query", {"snapshot_id": snapshot, "requests": [
            {"op": "file", "key": "/project/view.py", "at": timestamp(9), "view": "relations"}]})
        assert status == 200 and json.loads(body)["results"][0]["result"]["total"] == 2
        status, body, _ = request(base, "/v1/jobs/job_" + "a" * 32)
        assert status == 200 and json.loads(body)["error"]["code"] == "INTERRUPTED"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(5)
