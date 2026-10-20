"""Publish a frozen, file-readable view of active memory; never rewrite the store."""
from __future__ import annotations

from typing import Any

import hashlib
import html
import json
import os
import tempfile
from pathlib import Path, PurePosixPath
from urllib.parse import quote

from . import VERSION
from .common import nonempty, slug


def _inline(text):
    text = html.escape(" ".join(text.split()), quote=False)
    return text.replace("\\", "\\\\").replace("[", "\\[").replace("]", "\\]")


def _link(label, target, current):
    relative = os.path.relpath(target, current.parent).replace(os.sep, "/")
    return f"[{_inline(label)}]({quote(relative, safe='/.-_')})"


def _lesson_path(lesson):
    # Keep identity independent of title; '.lesson.md' cannot collide with index.md.
    return PurePosixPath(*lesson["topic"], lesson["id"] + ".lesson.md")


def _lesson_text(lesson, state, memory, output, paths, link_cards):
    current = output / paths[lesson["id"]]
    lines = [f"# {lesson['title']}", "", f"ID：`{lesson['id']}` · 版本：{lesson['version']}", "",
             _link("本主题", current.parent / "index.md", current), "",
             "## 何时使用", "", lesson["when"], ""]
    if lesson.get("description"):
        lines += ["## 适用情境", "", lesson["description"], ""]
    if lesson["unless"]:
        lines += ["## 例外与边界", "", *[f"- {x}" for x in lesson["unless"]], ""]
    lines += ["## 原因", "", lesson["why"], "", "## 做法", "",
              *[f"{i}. {x}" for i, x in enumerate(lesson["how"], 1)], ""]
    if lesson.get("check"):
        lines += ["## 可选检查", "", *[f"- {x}" for x in lesson["check"]], ""]
    if lesson["requires"]:
        lines += ["## 依赖经验", ""]
        for identity in lesson["requires"]:
            lines.append("- " + _link(state["lessons"][identity]["title"], output / paths[identity], current))
        lines.append("")
    lines += ["## 来源（按需复核）", ""]
    sources: dict[Any, Any]
    sources = {}
    for ref in lesson["evidence"]:
        sources.setdefault((ref["case"], ref["revision"]), []).append(ref["claim"])
    for (identity, revision), claims in sorted(sources.items()):
        label = identity
        if link_cards:
            label = _link(identity, memory.root / "cases" / identity / (revision + ".json"), current)
        lines += [f"- {label} · 结论：{', '.join(dict.fromkeys(claims))}", f"  卡片版本：`{revision}`"]
    return "\n".join(lines) + "\n"


def _render(memory, state, output, link_cards):
    lessons = {key: value for key, value in state["lessons"].items() if value["status"] == "active"}
    directories: dict[Any, Any]
    directories, checked = {"": {"children": set(), "lessons": []}}, set()
    for identity, lesson in lessons.items():
        slug(identity, "lesson ID")
        if identity != lesson["id"]:
            raise ValueError("Lesson key does not match its ID")
        parent = ""
        for part in lesson["topic"]:
            slug(part, "topic segment")
            child = parent + "/" + part if parent else part
            nonempty(state["topics"].get(child), f"Missing topic description: {child}; supply topic_descriptions via apply")
            directories.setdefault(child, {"children": set(), "lessons": []})
            directories[parent]["children"].add(child)
            parent = child
        directories[parent]["lessons"].append(lesson)
        for dependency in lesson["requires"]:
            if dependency not in lessons:
                raise ValueError("Active lesson has an unpublished dependency: " + dependency)
        for ref in lesson["evidence"]:
            head = state["cases"].get(ref["case"])
            if (not head or head["status"] != "available" or ref["revision"] != head["revision"]
                    or ref["claim"] not in head["claims"] or ref["claim"] in head["withdrawn_claims"]):
                raise ValueError("Active lesson has stale or withdrawn evidence: " + identity)
            source = (ref["case"], ref["revision"])
            if source not in checked:
                card = memory.case(ref["case"], ref["revision"], state=state)
                if card["id"] != ref["case"] or card["revision"] != ref["revision"]:
                    raise ValueError("Source card identity/version mismatch")
                checked.add(source)
    paths = {key: _lesson_path(value) for key, value in lessons.items()}
    files = {}
    for topic, directory in sorted(directories.items()):
        relative = PurePosixPath(topic, "index.md")
        current = output / relative
        if topic:
            lines = [f"# {topic}", "", state["topics"][topic], "",
                     _link("上一级", current.parent.parent / "index.md", current), ""]
        else:
            lines = ["# 迁移经验", "", f"经验库版本：`{state['revision']}`", "",
                     "先理解当前任务，再按下列介绍选择相关分支；可以同时读取多个 index.md。",
                     "每个索引只列直接子项。选中适用经验才读正文；无关分支可跳过，任务已获足够指导即可继续。",
                     "这是发布时的 active 快照，不会自动追踪之后的撤回；新任务应使用维护者提供的最新阅读包。", ""]
        if directory["children"]:
            lines += ["## 子主题", ""]
            for child in sorted(directory["children"]):
                lines.append("- " + _link(child.rsplit("/", 1)[-1], output / child / "index.md", current)
                             + " — " + _inline(state["topics"][child]))
            lines.append("")
        if directory["lessons"]:
            lines += ["## 本级经验", ""]
            for lesson in sorted(directory["lessons"], key=lambda x: (x["title"], x["id"])):
                lines += ["- " + _link(lesson["title"], output / paths[lesson["id"]], current),
                          "  - 时机：" + _inline(lesson["when"])]
                if lesson.get("description"):
                    lines.append("  - 情境：" + _inline(lesson["description"]))
                if lesson["unless"]:
                    lines.append("  - 例外：" + _inline("；".join(lesson["unless"])))
            lines.append("")
        if not directory["children"] and not directory["lessons"]:
            lines += ["本版暂无可发布的 active 经验。", ""]
        if not topic:
            lines += ["## 阅读约定", "",
                      "经验是有适用范围的历史建议。核查来源时同时看结论与 unknown；来源卡未随阅读包复制。", "",
                      "可选检查仅在适用条件不确定、与当前输入冲突或需要验证关键假设时按需执行；优先复用已有证据和正常测试。",
                      "不因读取经验而额外启动验证流程；项目原有必需测试照常执行。", ""]
        files[str(relative)] = "\n".join(lines)
    for identity, lesson in sorted(lessons.items()):
        files[str(paths[identity])] = _lesson_text(lesson, state, memory, output, paths, link_cards)
    manifest = {"schema": "migloop-memory-files/1", "publisher_version": VERSION,
                "memory_revision": state["revision"], "card_links": "local" if link_cards else "references_only",
                "counts": {"lessons": len(lessons), "topics": len(directories) - 1},
                "lessons": {key: {"path": str(paths[key]), "version": value["version"],
                                  "evidence": value["evidence"]} for key, value in sorted(lessons.items())},
                "files": {path: hashlib.sha256(body.encode("utf-8")).hexdigest() for path, body in sorted(files.items())}}
    files["manifest.json"] = json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
    return files, manifest


def export_memory(memory, directory, *, link_cards=False):
    """Create a new complete reading directory; retain prior releases, never merge/overwrite."""
    supplied = Path(directory).absolute()
    if supplied.is_symlink():
        raise ValueError("Output must be a new directory, not a symlink")
    from agentlineage_core.paths import data_path
    output = data_path(supplied)
    if output == memory.root or output in memory.root.parents or memory.root in output.parents:
        raise ValueError("Output and memory store must not overlap")
    if output.exists():
        raise ValueError("Output already exists; choose a new release directory (existing files are preserved)")
    with memory.lock():
        state = memory.current()
        files, manifest = _render(memory, state, output, link_cards)
        output.parent.mkdir(parents=True, exist_ok=True)
        # A unique sibling staging directory owns only files generated by this call.
        with tempfile.TemporaryDirectory(prefix=".memory-export-", dir=output.parent) as temporary:
            stage = Path(temporary)
            for relative, body in files.items():
                target = stage / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(body, encoding="utf-8", newline="\n")
            if output.exists():
                raise ValueError("Output was created during export; choose a new release directory")
            stage.rename(output)
    return {"revision": state["revision"], "entry": str(output / "index.md"),
            "manifest": str(output / "manifest.json"), **manifest["counts"],
            "card_links": manifest["card_links"], "store_changed": False}
