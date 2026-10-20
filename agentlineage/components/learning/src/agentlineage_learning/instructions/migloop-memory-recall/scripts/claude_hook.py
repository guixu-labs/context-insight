"""Project-local Claude Code task-start recall and explicit-write checkpoint.

The checkpoint observes entry reads, not understanding/adoption. It never grants
tool permissions. Ambiguous shell commands pass; this is not an effect parser.
"""
from __future__ import annotations

from typing import Any

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
import time
import uuid


def load(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def save(path, value, *, exclusive=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x" if exclusive else "w", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")


def digest(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:24]


def mark(folder, name, event):
    try:
        save(folder / (name + ".json"), event, exclusive=True)
        return True
    except FileExistsError:
        return False


def shell_tokens(command):
    """Small lexical subset: words retain quotes; operators never come from strings.

    Do not execute/expand anything or inspect interpreter bodies. Unsupported
    syntax returns no match. A heredoc body is data, not another shell command.
    """
    pattern = re.compile(r'''(?P<space>[ \t\r]+)|(?P<comment>\#[^\n]*)|(?P<op>&>>|&>|>>|>&|<<-?|&&|\|\||[;|&<>\n])|(?P<word>(?:'[^']*'|"(?:\\.|`.|[^"\\])*"|\\.|`.|[^\s;|&<>(){}'"`\\])+ )''', re.X)
    tokens, pos = [], 0
    while pos < len(command):
        match = pattern.match(command, pos)
        if not match:
            return []
        pos = match.end()
        if match.lastgroup in {"space", "comment"}:
            continue
        if match.lastgroup == "op" and match.group().startswith("<<"):
            break
        tokens.append((match.lastgroup, match.group()))
    return tokens


def literal_word(word):
    if len(word) >= 2 and word[0] == word[-1] and word[0] in "\"'":
        return word[1:-1]
    return word


def file_destination(word, tool):
    value = literal_word(word)
    if not value or value.lower() in {"/dev/null", "/dev/stdout", "/dev/stderr", "nul", "nul:", "con", "con:", "-"}:
        return False
    if value.startswith(("/dev/fd/", "/proc/self/fd/")):
        return False
    # Single-quoted '$null' is a literal filename, not a PowerShell discard sink.
    if not word.startswith("'") and ("$" in value or "`" in value):
        return False
    return True


def explicit_write(tool, params):
    """Return the recognizable operation, or None for read/unknown commands."""
    if tool in {"Write", "Edit", "MultiEdit", "NotebookEdit"}:
        return "native:" + tool
    if tool not in {"Bash", "PowerShell"}:
        return None
    tokens = shell_tokens(params.get("command", ""))
    segment: list[Any]
    segments, segment = [], []
    for index, (kind, value) in enumerate(tokens):
        if kind == "op" and value in {">", ">>", "&>", "&>>"}:
            if index + 1 < len(tokens) and tokens[index + 1][0] == "word" and file_destination(tokens[index + 1][1], tool):
                return "shell:redirect"
        if kind == "op" and value in {";", "&&", "||", "|", "&", "\n"}:
            segments.append(segment)
            segment = []
        else:
            segment.append((kind, value))
    segments.append(segment)
    for segment in segments:
        if not segment or segment[0][0] != "word":
            continue
        words = [literal_word(value) for kind, value in segment if kind == "word"]
        name = words[0].replace("\\", "/").rsplit("/", 1)[-1].lower()
        args = words[1:]
        if any(a.lower() in {"--help", "--version", "--dry-run", "-?"} or a.lower().startswith("-whatif") for a in args):
            continue
        operands = [a for a in args if not a.startswith("-")]
        if name in {"cp", "mv", "copy-item", "move-item"} and len(operands) >= 2:
            return "shell:" + name
        if name in {"set-content", "add-content", "out-file"} and operands:
            return "shell:" + name
        if name == "tee" and any(file_destination(raw, tool) for kind, raw in segment[1:] if kind == "word" and not literal_word(raw).startswith("-")):
            return "shell:tee"
        if name == "sed" and any(a == "--in-place" or a.startswith("--in-place=") or re.fullmatch(r"-[a-zA-Z]*i(?:\..*)?", a) for a in args) and operands:
            return "shell:sed-in-place"
        if name == "apply_patch":
            return "shell:apply_patch"
    return None


def may_write(tool, params):
    return explicit_write(tool, params) is not None


def deny(message):
    return {"hookSpecificOutput": {"hookEventName": "PreToolUse",
            "permissionDecision": "deny", "permissionDecisionReason": message}}


def handle(config, payload):
    if not config.get("enabled", True):
        return {}
    event_name = payload.get("hook_event_name")
    tool, params = payload.get("tool_name", ""), payload.get("tool_input", {})
    write = explicit_write(tool, params)
    if event_name == "PreToolUse" and not write:
        return {}
    if event_name not in {"PreToolUse", "PostToolUse", "SubagentStart", "UserPromptSubmit"}:
        return {}
    session = payload.get("session_id")
    if not session:
        raise ValueError("Hook input missing session_id")
    # agent_id is present on current Claude subagent tool hooks. Do not use
    # transcript_path as an actor ID: some versions pass the parent's path.
    actor = payload.get("agent_id") or "__main__"
    if event_name == "SubagentStart" and not payload.get("agent_id"):
        raise ValueError("SubagentStart input missing agent_id")
    folder = Path(config["runtime"]) / digest(session) / digest(actor)
    entry, skill = Path(config["entry"]).resolve(), Path(config["skill"]).resolve()
    record = {"at": time.time(), "session_id": session, "agent_id": actor,
              "agent_type": payload.get("agent_type"), "tool": tool,
              "tool_use_id": payload.get("tool_use_id"), "memory_revision": config["memory_revision"]}
    if write:
        record["write_rule"] = write
    if event_name in {"SubagentStart", "UserPromptSubmit"}:
        # Do not backfill an early reminder into an actor already working.
        if (folder / "notified.json").exists():
            return {}
        if not entry.is_file() or not skill.is_file():
            return {"systemMessage": f"经验入口不可读：{entry} / {skill}；首次写入前会再次检查。"}
        if not mark(folder, "startup-notified", dict(record, event="task_start_recall")):
            return {}
        return {"hookSpecificOutput": {"hookEventName": event_name, "additionalContext":
                f"任务开始时的经验召回：请结合刚收到的任务，用 Read 阅读召回说明 {skill} 和根索引 {entry}，"
                "快速选择明显相关的经验，让它指导后续查阅和方案；任务信息不足时先补读必要输入。"
                "只读相关分支，不遍历全库、不展开历史卡片、不另写报告。首次明确写入前还会提醒复核，"
                "届时复用已读经验，只补查新发现的相关项。无需让主代理代读或向用户确认。"}}
    if event_name == "PostToolUse":
        if tool == "Read":
            raw_path = params.get("file_path")
            if not raw_path or payload.get("is_error"):
                return {}
            response = payload.get("tool_response", {})
            if isinstance(response, dict) and response.get("is_error"):
                return {}
            path = Path(raw_path).resolve()
            if path != skill and not path.is_relative_to(entry.parent):
                return {}
            record.update(event="read", path=str(path), offset=params.get("offset"), limit=params.get("limit"))
            # Entry/skill are short: require a full Read to release the write.
            complete = params.get("offset", 1) in (None, 1) and not params.get("limit")
            if complete and path == entry:
                mark(folder, "entry-read", record)
            if complete and path == skill:
                mark(folder, "skill-read", record)
            save(folder / "reads" / (str(time.time_ns()) + "-" + uuid.uuid4().hex[:8] + ".json"), record)
        elif write and (folder / "notified.json").exists() and not payload.get("is_error") and not (isinstance(payload.get("tool_response"), dict) and payload["tool_response"].get("is_error")):
            mark(folder, "first-write-completed", dict(record, event="write_completed"))
        return {}

    if not entry.is_file() or not skill.is_file():
        mark(folder, "unavailable", dict(record, event="memory_unavailable"))
        return deny(f"迁移经验入口不可读，请检查 {entry} 和 {skill}。尚未执行本次修改；"
                    "若维护者决定停用召回，可将 .claude/migloop-memory.json 的 enabled 改为 false。")
    first = mark(folder, "notified", dict(record, event="write_paused"))
    read = (folder / "entry-read.json").exists() and (folder / "skill-read.json").exists()
    if not first and read:
        mark(folder, "resumed", dict(record, event="resume_normal_permissions"))
        return {}  # No allow: preserve all existing permission checks.
    prefix = "首次明确写入前的经验复核，本次修改尚未执行" if first else "经验入口尚未读全，本次修改仍未执行"
    reading = ("召回说明和根索引已经读过，无需重复读取。" if read else
               f"请用 Read 完整读取召回说明 {skill} 和根索引 {entry}。")
    return deny(f"{prefix}（不是用户拒绝，无需询问用户）。{reading}"
                "结合现在已理解的规格、源码和待写内容，复核已选经验，只补查新相关项；"
                "必要时调整这次待写内容后再提交，不是读完入口就原样重试。"
                "没有新相关项或不需要调整时直接继续，无需额外读取或证明。"
                "只查相关内容，不遍历全库、不展开历史卡片、不另写报告；"
                "在原任务结果中简记实际采用的经验及影响。提醒和阅读记录不证明采纳或理解。")


def install(project, memory, python, *, update=False):
    project, memory = Path(project).resolve(), Path(memory).resolve()
    if not project.is_dir():
        raise ValueError("Project directory does not exist")
    manifest = load(memory / "manifest.json")
    if manifest["card_links"] != "references_only":
        raise ValueError("Export a portable reading package without --link-cards first")
    for relative, expected in manifest["files"].items():
        path = (memory / relative).resolve()
        if not path.is_relative_to(memory) or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise ValueError("Memory manifest mismatch: " + relative)
    claude = project / ".claude"
    source_skill = Path(__file__).resolve().parents[1]
    installed_skill = claude / "skills/migloop-memory-recall"
    installed_script = claude / "hooks/migloop_memory.py"
    config_path = claude / "migloop-memory.json"
    settings_path = claude / "settings.local.json"
    settings = load(settings_path) if settings_path.exists() else {}
    if settings.get("disableAllHooks"):
        raise ValueError("Local settings disableAllHooks=true; not overriding existing policy")
    managed = (installed_skill, installed_script, config_path)
    if update:
        if not all(path.exists() for path in managed):
            raise ValueError("Update requires an existing complete installation")
        config = load(config_path)
        if (config.get("schema") != "migloop-claude-checkpoint/1" or
                Path(config.get("skill", "")).resolve() != installed_skill / "SKILL.md" or
                Path(config.get("entry", "")).resolve() != memory / "index.md" or
                config.get("memory_revision") != manifest["memory_revision"]):
            raise ValueError("Update preserves the installed memory/config; paths or revision differ")
        for path in managed:
            if path.is_symlink() or not path.resolve().is_relative_to(claude.resolve()):
                raise ValueError("Cannot update a linked/outside installation: " + str(path))
    else:
        for path in managed:
            if path.exists():
                raise ValueError("Already installed: " + str(path))
    hooks = settings.setdefault("hooks", {})
    for event in ("SubagentStart", "UserPromptSubmit", "PreToolUse", "PostToolUse"):
        if not isinstance(hooks.setdefault(event, []), list):
            raise ValueError("Invalid existing hooks: " + event)
    command = (f'"{Path(python).resolve().as_posix()}" -B -X utf8 '
               f'"{installed_script.as_posix()}" run --config "{config_path.as_posix()}"')
    if update:
        # Replace only our own handlers, including when bundled with foreign hooks.
        signature = f'"{installed_script.as_posix()}" run --config "{config_path.as_posix()}"'
        for event in ("SubagentStart", "UserPromptSubmit", "PreToolUse", "PostToolUse"):
            preserved = []
            for group in hooks[event]:
                handlers = [h for h in group.get("hooks", []) if signature not in h.get("command", "")]
                if handlers or not group.get("hooks"):
                    preserved.append(dict(group, hooks=handlers))
            hooks[event] = preserved
    for event, matcher in (("SubagentStart", "*"), ("UserPromptSubmit", ""),
                           ("PreToolUse", "Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell"),
                           ("PostToolUse", "Read|Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell")):
        hooks[event].append({"matcher": matcher, "hooks": [{"type": "command", "command": command, "timeout": 5}]})
    backup = None
    if update:
        backup = claude / "migloop-hook-backups" / uuid.uuid4().hex[:12]
        backup.mkdir(parents=True)
        shutil.copytree(installed_skill, backup / "migloop-memory-recall")
        for path in (installed_script, config_path, settings_path):
            if path.exists():
                shutil.copy2(path, backup / path.name)
    elif settings_path.exists():
        backup = claude / ("settings.local.before-migloop-" + uuid.uuid4().hex[:8] + ".json")
        shutil.copy2(settings_path, backup)
    installed_skill.mkdir(parents=True, exist_ok=update)
    shutil.copy2(source_skill / "SKILL.md", installed_skill / "SKILL.md")
    shutil.copytree(source_skill / "references", installed_skill / "references", dirs_exist_ok=update)
    installed_script.parent.mkdir(parents=True, exist_ok=True)
    staged_script = installed_script.with_name(".migloop-" + uuid.uuid4().hex + ".py")
    shutil.copy2(__file__, staged_script)
    os.replace(staged_script, installed_script)
    if not update:
        save(config_path, {"schema": "migloop-claude-checkpoint/1", "enabled": True,
                          "entry": str(memory / "index.md"), "skill": str(installed_skill / "SKILL.md"),
                          "runtime": str(claude / "migloop-runtime"),
                          "memory_revision": manifest["memory_revision"]}, exclusive=True)
    # Settings last: no live hook points at half-installed files.
    save(settings_path, settings)
    return {"settings": str(settings_path), "config": str(config_path), "entry": str(memory / "index.md"),
            "settings_backup": str(backup) if backup else None}


def main():
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    run = commands.add_parser("run")
    run.add_argument("--config", required=True)
    setup = commands.add_parser("install")
    setup.add_argument("--project", required=True)
    setup.add_argument("--memory", required=True)
    setup.add_argument("--python", default=sys.executable)
    setup.add_argument("--update", action="store_true", help="Back up and update only the project recall hook/skill; keep memory and runtime")
    args = parser.parse_args()
    if args.command == "install":
        result = install(args.project, args.memory, args.python, update=args.update)
    else:
        payload = json.load(sys.stdin)
        try:
            result = handle(load(args.config), payload)
        except (ValueError, OSError, KeyError) as error:
            if payload.get("hook_event_name") == "PreToolUse":
                result = deny(f"经验检查配置/状态错误：{error}。修改尚未执行，请修复 .claude/migloop-memory.json。")
            else:
                result = {"systemMessage": "经验阅读记录失败：" + str(error)}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
