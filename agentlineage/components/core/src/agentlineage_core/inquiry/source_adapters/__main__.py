"""Prepare immutable DevEco materials for the shared UI/card/CLI kernel."""
import argparse
import json
from .export import freeze_deveco


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", help="DevEco SQLite DB, native export JSON or directory of exports")
    parser.add_argument("--session", help="Required for a DB; limits extraction to this session tree")
    parser.add_argument("--out", required=True, help="New JSONL material directory")
    args = parser.parse_args()
    try:
        print(json.dumps(freeze_deveco(args.source, args.out, args.session), ensure_ascii=False, indent=2))
    except (ValueError, OSError) as exc:
        parser.exit(2, str(exc) + "\n")


if __name__ == "__main__":
    main()
