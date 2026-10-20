from __future__ import annotations

import json

from conftest import cli, timestamp


def test_cli_supports_deep_data_paths(tmp_path, native_pool):
    storage = tmp_path / ("component-" + "a" * 100) / ("run-" + "b" * 80)
    imported = cli("--data-dir", storage, "import", "--name", "deep-path",
                   "--source", native_pool)
    assert imported.returncode == 0, imported.stdout + imported.stderr


def test_native_import_is_frozen_and_queryable_after_source_changes(tmp_path, native_pool):
    storage = tmp_path / "data"
    imported = cli("--data-dir", storage, "import", "--name", "generic-task",
                   "--source", native_pool)
    assert imported.returncode == 0, imported.stdout + imported.stderr
    snapshot = json.loads(imported.stdout)["snapshot_id"]
    native_pool.write_text("changed after import", encoding="utf-8")
    reply = cli("--data-dir", storage, "query", "--snapshot", snapshot,
                "--request", json.dumps({"op": "file", "key": "/project/view.py",
                    "at": timestamp(9), "view": "relations"}))
    assert reply.returncode == 0, reply.stdout + reply.stderr
    value = json.loads(reply.stdout)
    assert value["snapshot_id"] == snapshot
    assert "spacing" not in json.dumps(value.get("error", ""))
    assert len(value["result"]["rows"]) == 2
    assert all(row["strength"] == "confirmed" for row in value["result"]["rows"])
