"""Refresh extraction provenance from pinned Git blobs, never from moving branches."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def main() -> None:
    manifest_path = ROOT / "provenance.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    source_repositories = {
        "fuxi-ailabs/migbot-server": ROOT / ".work/upstream/migbot-server",
        "fuxi-ailabs/hmigbot-plus": ROOT.parent / "hmigbot-plus",
    }
    targets = {item["target"] for item in manifest["files"]}
    environment = next(item for item in manifest["files"] if item["target"].endswith("/memory/environment.py"))
    extension = "components/learning/src/agentlineage_learning/extensions/hmigbot_environment.py"
    if extension not in targets:
        manifest["files"].append({**environment, "target": extension})
    for item in manifest["files"]:
        source = source_repositories[item["repository"]]
        result = subprocess.run(["git", "show", item["commit"] + ":" + item["source"]],
                                cwd=source, capture_output=True, check=True)
        original = sha(result.stdout)
        if item["sha256"] != original:
            item.setdefault("checkout_sha256", item["sha256"])
        item["sha256"] = original
        target = ROOT / item["target"]
        item["current_sha256"] = sha(target.read_bytes())
        if "/extensions/" in item["target"]:
            change = "optional HMigBot environment parser; relocated imports; not enabled by default"
        elif item["target"].endswith("/memory/environment.py"):
            change = "default explicit environment facts only; original domain parser isolated as optional extension"
        elif "/instructions/" in item["target"]:
            change = "versioned instruction asset; installed-package script imports and Python/version guidance"
        elif "/memory/" in item["target"]:
            change = "namespace relocation; public Core SDK binding; Windows path normalization; explicit container typing"
        elif "/inquiry/" in item["target"]:
            change = "namespace relocation; explicit container typing; AgentLineage MCP identity and tool annotations"
        else:
            change = "standalone line ownership replay extracted without host imports"
        item["change"] = change
    manifest["files"].sort(key=lambda item: item["target"])
    manifest["hash_semantics"] = "sha256: original pinned Git blob; current_sha256: extracted UTF-8 file bytes"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
                             encoding="utf-8", newline="\n")
    print(f"Recorded {len(manifest['files'])} source files")


if __name__ == "__main__":
    main()
