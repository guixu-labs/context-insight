"""Local paths are accepted only by this explicitly invoked offline CLI."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys

from .api import Learning


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="agentlineage-learning")
    parser.add_argument("--data-dir", required=True)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("init")
    commands.add_parser("capabilities")
    commands.add_parser("revision")
    prepare = commands.add_parser("prepare")
    prepare.add_argument("--name", required=True)
    prepare.add_argument("--source", action="append", required=True)
    prepare.add_argument("--triage", type=Path, required=True)
    packer = commands.add_parser("pack")
    packer.add_argument("--investigation", required=True)
    packer.add_argument("--job", required=True)
    packer.add_argument("--draft", type=Path, required=True)
    ingest = commands.add_parser("ingest")
    ingest.add_argument("--case", action="append", required=True)
    ingest.add_argument("--expected-revision", required=True)
    apply = commands.add_parser("apply")
    apply.add_argument("--proposal", type=Path, required=True)
    search = commands.add_parser("search")
    search.add_argument("query")
    search.add_argument("--topic", default="")
    export = commands.add_parser("export")
    export.add_argument("--output", required=True)
    server = commands.add_parser("serve")
    server.add_argument("--host", default="127.0.0.1")
    server.add_argument("--port", type=int, default=8111)
    server.add_argument("--token-env", default="AGENTLINEAGE_LEARNING_TOKEN")
    server.add_argument("--publish-token-env", default="AGENTLINEAGE_PUBLISH_TOKEN")
    server.add_argument("--executor-config", type=Path)
    execute = commands.add_parser("execute")
    execute.add_argument("--investigation", required=True)
    execute.add_argument("--budget", type=Path, required=True)
    execute.add_argument("--executor-config", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        component = Learning(args.data_dir)
        if args.command in ("serve", "execute"):
            from .worker import CommandExecutor, Investigations
            executor = None
            if args.executor_config:
                configuration = json.loads(args.executor_config.read_text(encoding="utf-8"))
                executor = CommandExecutor(configuration["argv"])
            worker = Investigations(component, executor)
            if args.command == "execute":
                worker.submit(args.investigation, json.loads(args.budget.read_text(encoding="utf-8")))
                result = worker.run(args.investigation)
                print(json.dumps(result, ensure_ascii=False))
                return 0 if result["status"] == "draft_ready" else 2
            from .http import create_server
            component.initialize()
            service = create_server(component, worker, args.host, args.port,
                                    os.environ.get(args.token_env),
                                    os.environ.get(args.publish_token_env))
            print(json.dumps({"url": f"http://{args.host}:{service.server_port}"}), flush=True)
            try:
                service.serve_forever()
            except KeyboardInterrupt:
                pass
            finally:
                service.server_close()
            return 0
        if args.command == "init":
            result = component.initialize()
        elif args.command == "capabilities":
            result = component.capabilities()
        elif args.command == "revision":
            result = component.memory.current()
        elif args.command == "prepare":
            result = component.prepare(args.name, args.source,
                                       json.loads(args.triage.read_text(encoding="utf-8")))
        elif args.command == "pack":
            result = component.pack_case(args.investigation, args.job,
                                        json.loads(args.draft.read_text(encoding="utf-8")))
        elif args.command == "ingest":
            result = component.ingest(args.case, args.expected_revision)
        elif args.command == "apply":
            result = component.apply_proposal(json.loads(args.proposal.read_text(encoding="utf-8")))
        elif args.command == "search":
            result = component.search(args.query, args.topic)
        else:
            result = component.export(args.output)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (ValueError, OSError, KeyError, TypeError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
