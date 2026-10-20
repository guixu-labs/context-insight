"""Small historical environment observations, not a dependency resolver or SDK range judge."""
from __future__ import annotations

import copy
import json
import re
from datetime import datetime
from pathlib import Path

from ..memory.common import fingerprint, load, write_new

EXPECTED = ("android.compile_sdk", "android.target_sdk", "android.min_sdk",
            "libraries.compose_bom", "libraries.material3", "toolchain.kotlin", "toolchain.agp",
            "toolchain.gradle", "harmonyos.target_sdk", "harmonyos.compatible_sdk",
            "harmonyos.compile_sdk", "device.android_api", "device.harmonyos_version",
            "device.density", "device.font_scale", "project.revision")


def _text(value):
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "\n".join(x["text"] for x in value if isinstance(x, dict) and isinstance(x.get("text"), str))
    return ""


def _instant(value):
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return result if result.tzinfo else None
    except (AttributeError, ValueError):
        return None


def _assignments(text, names):
    # Literal values only. Do not interpret API docs, variable references or execute build files.
    clean = re.sub(r"(?m)^\s*\d+\s*(?:→|\t|:)\s*", "", text)
    for source_key, name in names.items():
        pattern = (r'(?m)^\s*["\']?' + re.escape(source_key)
                   + r'["\']?\s*[:=]\s*["\']?(\d[\w.()+-]{0,63})["\']?\s*(?:[,;]|$)')
        for match in re.finditer(pattern, clean):
            yield name, match[1]


def _facts(context, text):
    if "build-profile.json5" in context:
        for name, value in _assignments(text, {
                "targetSdkVersion": "harmonyos.target_sdk", "compatibleSdkVersion": "harmonyos.compatible_sdk",
                "compileSdkVersion": "harmonyos.compile_sdk"}):
            yield name, value, "configuration", "build-profile.json5"
    if re.search(r"(?:build\.gradle(?:\.kts)?|libs\.versions\.toml)", context):
        keys = {"compileSdk": "android.compile_sdk", "compileSdkVersion": "android.compile_sdk",
                "targetSdk": "android.target_sdk", "targetSdkVersion": "android.target_sdk",
                "minSdk": "android.min_sdk", "minSdkVersion": "android.min_sdk"}
        artifact = "libs.versions.toml" if "libs.versions.toml" in context else "build.gradle"
        if artifact == "libs.versions.toml":
            keys.update({"kotlin": "toolchain.kotlin", "agp": "toolchain.agp",
                         "androidGradlePlugin": "toolchain.agp", "androidxComposeBom": "libraries.compose_bom",
                         "androidx-compose-bom": "libraries.compose_bom",
                         "composeBom": "libraries.compose_bom", "compose-bom": "libraries.compose_bom",
                         "material3": "libraries.material3", "androidxComposeMaterial3": "libraries.material3"})
        for name, value in _assignments(text, keys):
            yield name, value, "configuration", artifact
        for match in re.finditer(r'androidx\.compose:(compose-bom):([\d.]+)|androidx\.compose\.material3:(material3):([\d.]+(?:-[\w.]+)?)', text):
            yield ("libraries.compose_bom" if match[1] else "libraries.material3"), (match[2] or match[4]), "configuration", artifact
    if "gradle-wrapper.properties" in context:
        for match in re.finditer(r'(?m)^\s*distributionUrl\s*=\S*/gradle-([\d.]+)-(?:bin|all)\.zip\s*$', text):
            yield "toolchain.gradle", match[1], "configuration", "gradle-wrapper.properties"
    # These probes are recognized only as single recorded commands with plain replies.
    probes = ((r'(?:\S*/)?adb(?:\.exe)?(?: -s \S+)? shell getprop ro\.build\.version\.sdk', "device.android_api", r"\d+"),
              (r'(?:\S*/)?adb(?:\.exe)?(?: -s \S+)? shell settings get system font_scale', "device.font_scale", r"\d+(?:\.\d+)?"),
              (r'git(?: -C (?:"[^"\n]+"|\S+))? rev-parse HEAD', "project.revision", r"[a-f0-9]{40}"))
    for command, name, value in probes:
        if re.fullmatch(command, context.strip()) and re.fullmatch(value, text.strip()):
            yield name, text.strip(), "tool_output", name


class Observer:
    """Pair actual CC/Codex calls and successful replies; ignore narrative and failed calls."""
    def __init__(self):
        self.pending = {}
        self.observations = {}

    def _call(self, identity, name, args, ref):
        if not isinstance(identity, str) or not isinstance(name, str) or not isinstance(args, dict):
            return
        name = name.rsplit(".", 1)[-1]
        if name in ("Read", "Write"):
            context = args.get("file_path", "")
            body = args.get("content") if name == "Write" else None
        elif name in ("Bash", "exec_command", "shell_command"):
            context, body = args.get("command", args.get("cmd", "")), None
            # Exclude scripts that merely echo config-like examples.
            if not isinstance(context, str) or not re.search(r"\b(cat|type|Get-Content|rg|grep|sed|head|tail|adb|git)\b", context):
                return
        else:
            return
        if isinstance(context, str):
            self.pending[identity] = (context, body, ref)

    def _result(self, identity, content, failed, at, ref, cwd):
        call = self.pending.pop(identity, None)
        if failed or call is None:
            return
        context, body, request_ref = call
        text = body if isinstance(body, str) else _text(content)
        if re.search(r"(?:Process exited with code|Exit code:)\s*[1-9]", text):
            return
        for name, value, basis, artifact in _facts(context, text):
            key = (name, value, basis, artifact, cwd)
            self.observations.setdefault(key, {"name": name, "value": value, "basis": basis,
                "artifact": artifact, "cwd": cwd, "at": at, "ref": ref, "request_ref": request_ref})

    def observe(self, row, ref):
        if not isinstance(row, dict):
            return
        at, cwd = row.get("timestamp"), row.get("cwd")
        message = row.get("message", {})
        if isinstance(message, dict) and isinstance(message.get("content"), list):
            for part in message["content"]:
                if not isinstance(part, dict):
                    continue
                if part.get("type") == "tool_use" and row.get("type") == "assistant":
                    self._call(part.get("id"), part.get("name", ""), part.get("input"), ref)
                elif part.get("type") == "tool_result":
                    self._result(part.get("tool_use_id"), part.get("content"), part.get("is_error"), at, ref, cwd)
        payload = row.get("payload", {})
        if row.get("type") != "response_item" or not isinstance(payload, dict):
            return
        if payload.get("type") == "function_call":
            try:
                args = json.loads(payload.get("arguments", "{}"))
            except (ValueError, TypeError):
                return
            self._call(payload.get("call_id"), payload.get("name", ""), args, ref)
        elif payload.get("type") == "function_call_output":
            content = payload.get("output", "")
            try:
                decoded = json.loads(content)
            except (ValueError, TypeError):
                decoded = None
            failed = False
            if isinstance(decoded, dict) and "output" in decoded:
                content, failed = decoded["output"], decoded.get("exit_code", 0) not in (0, None)
            self._result(payload.get("call_id"), content, failed, at, ref, cwd)


def for_card(metadata, scope):
    """Keep first evidence for each distinct observed value before the card's cutoff, not a global state claim."""
    end, generation = _instant(scope.get("observation_end")), _instant(scope.get("generation_end"))
    observations = [fact for source in metadata.get("sources", []) for fact in source.get("environment", [])]
    facts, selected_sources = {}, {}
    source_hashes = {source["source"]: source["sha256"] for source in metadata.get("sources", [])}
    skipped = 0
    for observation in sorted(observations, key=lambda f: (
            _instant(f.get("at")).timestamp() if _instant(f.get("at")) else float("inf"), f["ref"])):
        at = _instant(observation.get("at"))
        if at is None or end is None:
            skipped += 1
            continue
        if at > end:
            continue
        key = tuple(observation[k] for k in ("name", "value", "basis", "artifact", "cwd"))
        if key in facts:
            continue
        fact = copy.deepcopy(observation)
        fact["phase"] = "generation" if generation and at <= generation else "repair" if generation else "unknown"
        facts[key] = fact
        source = fact["ref"].rsplit(":L", 1)[0]
        selected_sources[source] = source_hashes[source]
    result = {"schema": "migloop-case-environment/1", "through": scope.get("observation_end"),
              "facts": list(facts.values()), "sources": selected_sources,
              "unknown": [key for key in EXPECTED if not any(f["name"] == key for f in facts.values())],
              "unscoped_observations": skipped,
              "boundary": "Recorded configuration/tool outputs, not a continuous environment state, resolved dependency proof, or lesson compatibility range. Missing values stay unknown; no current project files are read."}
    result["snapshot_id"] = fingerprint(result)
    return result


def enrich_cards(paths, metadata_path, out):
    """Create additive card revisions; preserve all authored claims, graph evidence and validation."""
    from .provenance import verify_materials
    from .registry import revision_of, validate_case
    from .case_format import SCHEMA, context, shared_objects, finalize

    metadata, output = load(metadata_path), Path(out).resolve()
    if metadata.get("schema") != "migloop-provenance/1":
        raise ValueError("Use triage metadata output for --metadata, not hand-authored environment values")
    if output.exists():
        raise ValueError("Enrichment output must be a new directory; existing cards are preserved")
    verify_materials(metadata)
    source_hashes = {s["source"]: s["sha256"] for s in metadata["sources"]}
    prepared, objects = [], {}
    for path in paths:
        card = load(path)
        validate_case(card)
        objects.update(shared_objects(card, Path(path).parent / "sessions"))
        card_context = context(card, objects)
        provenance = card_context["provenance"]
        if card["schema"] == SCHEMA:
            if provenance.get("source_set_id") != metadata.get("source_set_id"):
                raise ValueError(f"{card['id']}: environment material version differs from the card")
        elif Path(provenance.get("materials", "")).resolve() != Path(metadata["materials"]).resolve():
            raise ValueError(f"{card['id']}: environment pool differs from the card's migration materials")
        sources = provenance.get("sources", {})
        sources = sources if isinstance(sources, dict) else {s["source"]: s["sha256"] for s in sources}
        if card["schema"] != SCHEMA and (not sources or any(source_hashes.get(name) != digest for name, digest in sources.items())):
            raise ValueError(f"{card['id']}: original transcript hashes do not match; do not relabel another history")
        enriched = finalize(card, objects)
        facts = for_card(metadata, card_context["scope"])["facts"]
        if facts:
            enriched["metadata"]["environment"] = facts
        else:
            enriched["metadata"].pop("environment", None)
        enriched["revision"] = revision_of(enriched)
        validate_case(enriched)
        prepared.append((card, enriched))
    if not prepared or len({new["id"] for _, new in prepared}) != len(prepared):
        raise ValueError("Supply one existing card per identity")
    results = []
    for old, new in prepared:
        target = output / (new["id"] + ".json")
        write_new(target, new)
        results.append({"case": new["id"], "from": old["revision"], "to": new["revision"], "path": str(target)})
    return {"cards": results, "claims_changed": False, "source_cards_changed": False,
            "next": "Ingest as normal revisions; existing review gates still apply. Rebind lessons only after reviewing added context."}
