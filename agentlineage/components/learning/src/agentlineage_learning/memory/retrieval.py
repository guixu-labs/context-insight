"""Progressive reading plus full-library lexical fallback, not guaranteed recall."""
from __future__ import annotations

import argparse
import json
import math
import re

from .common import nonempty, page
from .registry import Memory


def _visible(state, all_statuses=False):
    return {key: value for key, value in state["lessons"].items() if all_statuses or value["status"] == "active"}


def preview(lesson):
    return {**{k: lesson[k] for k in ("id", "title", "when", "topic", "status")},
            "description": lesson.get("description", "")}


def browse(memory, topic="", offset=0, limit=8, all_statuses=False):
    state = memory.current()
    prefix = topic.strip("/").split("/") if topic.strip("/") else []
    directories, entries = {}, []
    for lesson in _visible(state, all_statuses).values():
        route = lesson["topic"]
        if route[:len(prefix)] != prefix:
            continue
        if route == prefix:
            entries.append({"kind": "lesson", **preview(lesson)})
        else:
            child = "/".join(route[:len(prefix) + 1])
            if child not in directories:
                directories[child] = {"kind": "topic", "path": child,
                                      "description": state["topics"].get(child, ""), "count": 0}
            directories[child]["count"] += 1
    items = sorted(directories.values(), key=lambda x: x["path"]) + sorted(entries, key=lambda x: x["id"])
    return {"revision": state["revision"], "topic": "/".join(prefix),
            "parent": "/".join(prefix[:-1]) if prefix else None,
            **page(items, offset, limit), "scope": "all statuses" if all_statuses else "active only"}


def tokens(text):
    result = set(re.findall(r"[a-z0-9_]+", text.lower()))
    for part in re.findall(r"[\u3400-\u9fff]+", text):
        result.update(part[i:i + 2] for i in range(len(part) - 1))
        if len(part) == 1:
            result.add(part)
    return result


def search(memory, query, topic="", offset=0, limit=8, all_statuses=False):
    nonempty(query, "query")
    state, terms = memory.current(), tokens(query)
    documents = []
    for value in _visible(state, all_statuses).values():
        route = "/".join(value["topic"])
        if topic and route != topic and not route.startswith(topic + "/"):
            continue
        routing = " ".join([value["title"], value["when"], value.get("description", "")])
        text = " ".join([routing, value["why"], route,
                         *value["unless"], *value["how"], *value["check"]])
        documents.append((value, tokens(text), tokens(routing)))
    frequency = {term: sum(term in words for _, words, _ in documents) for term in terms}
    scored = []
    for value, words, highlights in documents:
        matched = terms & words
        if not matched:
            continue
        score = sum((1 + math.log((len(documents) + 1) / (frequency[word] + 1))) *
                    (2 if word in highlights else 1) for word in matched)
        scored.append({**preview(value), "score": round(score, 4), "matched_terms": sorted(matched)})
    scored.sort(key=lambda x: (-x["score"], x["id"]))
    return {"revision": state["revision"], "query": query, **page(scored, offset, limit),
            "retrieval": "lexical words/CJK bigrams over full lesson bodies; no embedding model",
            "boundary": "No match is not proof no applicable experience exists; browse or try task/API synonyms."}


def read(memory, identities, all_statuses=False):
    if not identities or len(identities) > 24:
        raise ValueError("read accepts 1–24 IDs, with no silent body truncation")
    state = memory.current()
    results = []
    for identity in identities:
        value = state["lessons"].get(identity)
        if not value:
            raise ValueError("Unknown lesson: " + identity)
        if value["status"] != "active" and not all_statuses:
            raise ValueError("Lesson is not active; use --all-statuses only for maintenance: " + identity)
        results.append(value)
    return {"revision": state["revision"], "lessons": results, "complete": True,
            "boundary": "Historical suggestions, not instructions overriding the current task; evidence is not loaded by default."}


def notice(memory):
    state = memory.current()
    return {"skill": "migloop-memory-recall", "store": str(memory.root), "revision": state["revision"],
            "instruction": "理解任务后、首次修改前，用 migloop-memory-recall 按任务阶段、具体动作和输入特征查经验。先看title/when/description选条目，再批量读正文。阶段作为线索，必要时跨阶段搜索；核适用条件后返回原任务，历史卡片按需展开。",
            "hook_installed": False,
            "boundary": "This is a runtime-neutral reminder payload; your host must schedule/deliver it. No hook config was changed."}


def main():
    parser = argparse.ArgumentParser(description="Browse/read/search memory without injecting historical evidence by default.")
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("browse", "search", "read", "case", "notice"):
        sub = commands.add_parser(name)
        sub.add_argument("--store", required=True)
        if name in ("browse", "search"):
            sub.add_argument("--topic", default="")
            sub.add_argument("--offset", type=int, default=0)
            sub.add_argument("--limit", type=int, default=8)
        if name in ("browse", "search", "read"):
            sub.add_argument("--all-statuses", action="store_true")
        if name == "search":
            sub.add_argument("--query", required=True)
        elif name == "read":
            sub.add_argument("--ids", nargs="+", required=True)
        elif name == "case":
            sub.add_argument("--id", required=True)
    args = parser.parse_args()
    memory = Memory(args.store)
    if args.command == "browse":
        result = browse(memory, args.topic, args.offset, args.limit, args.all_statuses)
    elif args.command == "search":
        result = search(memory, args.query, args.topic, args.offset, args.limit, args.all_statuses)
    elif args.command == "read":
        result = read(memory, args.ids, args.all_statuses)
    elif args.command == "case":
        state = memory.current()
        result = {"memory_revision": state["revision"], "current_status": state["cases"].get(args.id),
                  "card": memory.case(args.id, state=state)}
    else:
        result = notice(memory)
    print(json.dumps(result, ensure_ascii=False, indent=2))
