from __future__ import annotations

import ast
import json

import pytest

from agentlineage_learning.api import Learning

from agentlineage_core.api import Core
from agentlineage_core.export import export_document
from conftest import ROOT, cli


def test_offline_export_contains_evidence_and_escapes_names(tmp_path, native_pool):
    component = Core(tmp_path / "state")
    result = component.import_files("<script>alert(1)</script>", [native_pool])
    text = export_document(component, result["snapshot_id"])
    assert "<script>alert(1)</script>" not in text
    assert "&lt;script&gt;" in text and "Observed operations" in text
    value = json.loads(export_document(component, result["snapshot_id"], "json"))
    assert value["semantic_verified"] is False and len(value["effects"]) == 3
    target = tmp_path / "report.html"
    run = cli("--data-dir", tmp_path / "state", "export", "--snapshot", result["snapshot_id"],
              "--output", target)
    assert run.returncode == 0, run.stderr
    assert target.is_file()
    repeated = cli("--data-dir", tmp_path / "state", "export", "--snapshot", result["snapshot_id"],
                   "--output", target)
    assert repeated.returncode == 2


def test_memory_export_refuses_storage_overlap(tmp_path):
    learning = Learning(tmp_path / "learning")
    learning.initialize()
    with pytest.raises(ValueError, match="overlap"):
        learning.export(tmp_path / "learning" / "memory" / "nested")


def test_component_dependencies_point_downward():
    for component in ("core", "learning"):
        root = ROOT / "components" / component / "src"
        for path in root.rglob("*.py"):
            tree = ast.parse(path.read_text(encoding="utf-8"))
            imported = []
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    imported.extend(alias.name for alias in node.names)
                elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                    imported.append(node.module)
            forbidden = {"migbot", "services", "memorylib", "migloop"}
            if component == "core":
                forbidden.add("agentlineage_learning")
            assert not (forbidden & {name.split(".")[0] for name in imported}), path


def test_deployment_files_do_not_bind_original_repository():
    for component in ("core", "learning"):
        config = (ROOT / "components" / component / "pyproject.toml").read_text(encoding="utf-8")
        assert "D:/work" not in config and "D:\\work" not in config
        assert 'version = "0.1.0a10"' in config
