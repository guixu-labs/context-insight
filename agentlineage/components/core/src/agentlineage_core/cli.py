"""Command-line entry point for native session evidence."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys

from .api import Core, CoreError


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="agentlineage")
    parser.add_argument("--data-dir", required=True)
    commands = parser.add_subparsers(dest="command", required=True)
    importer = commands.add_parser("import")
    importer.add_argument("--name", required=True)
    importer.add_argument("--project", default="default")
    importer.add_argument("--source", action="append", required=True)
    query = commands.add_parser("query")
    query.add_argument("--snapshot", required=True)
    query.add_argument("--request", required=True, help="Native inquiry JSON request")
    lineage = commands.add_parser("lineage")
    lineage.add_argument("--snapshot", required=True)
    lineage.add_argument("--path", required=True)
    lineage.add_argument("--at", required=True)
    checker = commands.add_parser("check")
    checker.add_argument("--snapshot", required=True)
    checker.add_argument("--document", required=True, type=Path)
    checker.add_argument("--save", action="store_true")
    commands.add_parser("capabilities")
    server = commands.add_parser("serve")
    server.add_argument("--host", default="127.0.0.1")
    server.add_argument("--port", type=int, default=8110)
    server.add_argument("--token-env", default="AGENTLINEAGE_TOKEN")
    server.add_argument("--exclusive", action="store_true")
    export = commands.add_parser("export")
    export.add_argument("--snapshot", required=True)
    export.add_argument("--format", choices=["html", "json"], default="html")
    export.add_argument("--output", required=True, type=Path)
    mcp = commands.add_parser("mcp")
    mcp.add_argument("--snapshot", required=True)
    args = parser.parse_args(argv)
    lease = None
    try:
        if args.command == "serve" and args.exclusive:
            from .runtime import acquire
            from .paths import data_path
            lease = acquire(data_path(args.data_dir))
        core = Core(args.data_dir)
        if args.command == "serve":
            from .http import create_server
            server_instance = create_server(core, args.host, args.port, os.environ.get(args.token_env))
            print(json.dumps({"url": f"http://{args.host}:{server_instance.server_port}"}), flush=True)
            try:
                server_instance.serve_forever()
            except KeyboardInterrupt:
                print("AgentLineage stopped", file=sys.stderr)
            finally:
                server_instance.server_close()
            return 0
        if args.command == "mcp":
            from .inquiry.interfaces import build_mcp
            with core.evidence(args.snapshot):
                pass
            build_mcp(core.root / "snapshots" / args.snapshot / "index.sqlite").run()
            return 0
        if args.command == "export":
            from .export import export_document
            args.output.parent.mkdir(parents=True, exist_ok=True)
            with args.output.open("x", encoding="utf-8") as stream:
                stream.write(export_document(core, args.snapshot, args.format))
            print(json.dumps({"path": str(args.output.resolve())}))
            return 0
        if args.command == "import":
            result = core.import_files(args.name, args.source, args.project)
        elif args.command == "query":
            result = core.query(args.snapshot, json.loads(args.request))
        elif args.command == "lineage":
            result = core.file_lineage(args.snapshot, args.path, args.at)
        elif args.command == "check":
            result = core.check_report(args.snapshot, args.document.read_text(encoding="utf-8"), save=args.save)
        else:
            result = core.capabilities()
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (CoreError, ValueError, TypeError, KeyError, OSError, ImportError) as exc:
        error = exc.as_dict() if isinstance(exc, CoreError) else {"code": "INVALID_INPUT", "message": str(exc)}
        print(json.dumps({"error": error}, ensure_ascii=False), file=sys.stderr)
        return 2
    finally:
        if lease:
            lease.close()


if __name__ == "__main__":
    raise SystemExit(main())
