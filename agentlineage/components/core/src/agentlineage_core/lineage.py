"""行级归属重放 —— 从实录写事件还原"每行最后是谁写的"(git blame 语义)。

输入是单个文件按时间序的写事件,每条 = (agent_id, op, payload):
  ("write", 全文)                          Write / codex Add File
  ("edits", [(old, new, replace_all), …])  Edit / MultiEdit / codex Update 分块
  ("delete", None)                         codex Delete File

纯字符串重放,零推断。重放断链(old 匹配不上 = 实录之外有人改过盘上文件、
格式化器/手改/脚本写盘)时诚实降级:segments=None + broken 原因,不硬猜。

行粒度归属规则(与 git blame 一致):
- 编辑区间落到的行,重放后该区间产出的行全部归编辑者;
- 纯整行删除不给删除者记行(幸存行保持原作者),但接手台账(takeovers)记上;
- takeovers = 谁顶掉了谁的多少行,自己改自己的行不算接手。
"""

from __future__ import annotations

from typing import Any

_MAX_CONTENT = 5_000_000  # 单文件重放上限(字符);超出按 broken 处理,不吃内存


def _line_count(text: str) -> int:
    return text.count("\n") + 1


_MAX_CHANGE_CHARS = 700   # 单条改动摘要上限(抽屉展示用,不是取证全文)
_MAX_CHANGES = 10         # 每文件最多记几条改动


def _clip(lines: list[str], limit: int) -> list[str]:
    if len(lines) > limit:
        return [*lines[:limit], f"… 等 {len(lines)} 行"]
    return lines


def _change_text(op: str, payload: Any) -> str:
    """事件 → diff 风格摘要("改了什么"),截断呈现、不替代取证。"""
    nl = chr(10)
    if op == "write":
        text = payload or ""
        head = nl.join(text.split(nl)[:4])
        return (head + nl + f"[整文件写入,共 {_line_count(text)} 行]")[:_MAX_CHANGE_CHARS]
    if op == "delete":
        return "[删除文件]"
    if op == "edits":
        parts: list[str] = []
        for old, new, _all in (payload or [])[:4]:
            parts += ["- " + x for x in _clip(str(old).split(nl), 4)]
            parts += ["+ " + x for x in _clip(str(new).split(nl), 4)]
        return nl.join(parts)[:_MAX_CHANGE_CHARS]
    if op == "hunks":
        parts = []
        for chunk in (payload or [])[:4]:
            located = False
            for kind, ls in chunk:
                if kind == "ctx" and ls and not located:
                    parts.append("@ " + ls[0])
                    located = True
                elif kind == "del":
                    parts += ["- " + x for x in ls[:5]]
                elif kind == "add":
                    parts += ["+ " + x for x in ls[:5]]
        return nl.join(parts)[:_MAX_CHANGE_CHARS]
    return ""


def replay_file(events: list[tuple[str, str, Any]]) -> dict[str, Any]:
    content: str | None = None
    owners: list[str] = []
    takeover_of: dict[str, dict[str, int]] = {}   # editor -> {orig: lines}
    changes: list[dict[str, Any]] = []            # 改动摘要(成功处理的事件才记)

    def record(agent_id: str, op: str, payload: Any) -> None:
        if len(changes) < _MAX_CHANGES:
            changes.append({"by": agent_id, "op": op,
                            "text": _change_text(op, payload)})

    def displace(editor: str, displaced: list[str]) -> None:
        hit = [o for o in displaced if o != editor]
        if not hit:
            return
        bag = takeover_of.setdefault(editor, {})
        for o in hit:
            bag[o] = bag.get(o, 0) + 1

    def broken(reason: str) -> dict[str, Any]:
        return {"segments": None, "takeovers": _pack(takeover_of), "broken": reason,
                "total": 0, "changes": changes}

    for agent_id, op, payload in events:
        if op == "write":
            text = payload or ""
            if len(text) > _MAX_CONTENT:
                return broken("too-big")
            displace(agent_id, owners)
            content = text
            owners = [agent_id] * _line_count(text)
            record(agent_id, op, text)
        elif op == "delete":
            displace(agent_id, owners)
            content, owners = None, []
            record(agent_id, op, None)
        elif op == "opaque":
            # 实录里只有"写过"没有内容(shell 写盘/heredoc):后续重放会踩在
            # 看不见的改动上,必须断链降级而不是沉默给错答案
            return broken("opaque-write")
        elif op == "edits":
            if content is None:
                return broken("no-baseline")
            for old, new, replace_all in payload or []:
                if not old:
                    return broken("empty-old")
                pos = 0
                found = False
                while True:
                    idx = content.find(old, pos)
                    if idx < 0:
                        break
                    found = True
                    before = content[:idx]
                    after = content[idx + len(old):]
                    s = before.count("\n")
                    e = s + old[:-1].count("\n") if len(old) > 1 else s
                    tail = len(owners) - e - 1
                    content = before + new + after
                    if len(content) > _MAX_CONTENT:
                        return broken("too-big")
                    region = _line_count(content) - s - tail
                    displace(agent_id, owners[s:e + 1])
                    owners = owners[:s] + [agent_id] * region + owners[e + 1:]
                    pos = idx + len(new)
                    if not replace_all:
                        break
                if not found:
                    return broken("edit-miss")
            record(agent_id, op, payload)
        elif op == "hunks":
            # codex V4A patch:块 = [("ctx"|"del"|"add", [行])…]。ctx 行没被改,
            # 保留原作者;add 行归编辑者;del 行进接手台账。块按序作用。
            if content is None:
                return broken("no-baseline")
            for chunk in payload or []:
                old_lines = [ln for kind, ls in chunk if kind in ("ctx", "del")
                             for ln in ls]
                if not old_lines:
                    return broken("empty-old")
                block = "\n".join(old_lines)
                idx, pos = -1, 0
                while True:
                    j = content.find(block, pos)
                    if j < 0:
                        break
                    end = j + len(block)
                    if ((j == 0 or content[j - 1] == "\n")
                            and (end == len(content) or content[end] == "\n")):
                        idx = j
                        break
                    pos = j + 1
                if idx < 0:
                    return broken("hunk-miss")
                before = content[:idx]
                after = content[idx + len(block):]
                s = before.count("\n")
                region_owners: list[str] = []
                new_lines: list[str] = []
                oi = s
                for kind, ls in chunk:
                    if kind == "ctx":
                        region_owners.extend(owners[oi:oi + len(ls)])
                        new_lines.extend(ls)
                        oi += len(ls)
                    elif kind == "del":
                        displace(agent_id, owners[oi:oi + len(ls)])
                        oi += len(ls)
                    else:
                        region_owners.extend([agent_id] * len(ls))
                        new_lines.extend(ls)
                if new_lines:
                    content = before + "\n".join(new_lines) + after
                elif after.startswith("\n"):
                    content = before + after[1:]
                elif before.endswith("\n"):
                    content = before[:-1] + after
                else:
                    content = before + after
                if len(content) > _MAX_CONTENT:
                    return broken("too-big")
                owners = owners[:s] + region_owners + owners[s + len(old_lines):]
            record(agent_id, op, payload)
        else:
            return broken(f"unknown-op:{op}")

    segments: list[list[Any]] = []
    for i, owner in enumerate(owners):
        if segments and segments[-1][2] == owner and segments[-1][1] == i:
            segments[-1][1] = i + 1
        else:
            segments.append([i + 1, i + 1, owner])
    return {"segments": segments, "takeovers": _pack(takeover_of), "broken": None,
            "total": len(owners), "changes": changes}


def _pack(takeover_of: dict[str, dict[str, int]]) -> list[dict[str, Any]]:
    return [{"by": editor, "lines": sum(bag.values()), "from": bag}
            for editor, bag in takeover_of.items() if bag]
