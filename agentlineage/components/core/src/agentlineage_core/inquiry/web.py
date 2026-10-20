"""One HTTP application, mounted by both the session viewer and inquiry CLI."""

from __future__ import annotations

import html
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .engine import Engine
from .report import check, load_report
from .store import Store, encode, iso


def render_page(api_base="", context=None):
    config = encode({**(context or {}), "api_base": api_base}).replace("<", "\\u003c")
    return (
        Path(__file__)
        .with_name("page.html")
        .read_text(encoding="utf-8")
        .replace("__INQUIRY_CONFIG__", config)
        .replace("__INQUIRY_ASSET_BASE__", html.escape(api_base, quote=True))
    )


def dispatch_http(path, route, data=None):
    """Return status/body/MIME; no HTTP state or model-visit side effects."""
    parsed = urlparse(route)
    args = parse_qs(parsed.query)
    mime = "application/json; charset=utf-8"
    if parsed.path in ("/tree.js", "/viewer.js") and data is None:
        return (
            200,
            Path(__file__).with_name(parsed.path[1:]).read_text(encoding="utf-8"),
            "text/javascript; charset=utf-8",
        )
    store = None
    try:
        store = Store(path)
        engine = Engine(store)
        if parsed.path == "/api/query" and data is not None:
            output = engine.query(data)  # Human exploration never calls investigate().
        elif parsed.path == "/api/view" and data is not None:
            from .viewer import viewer_query

            output = viewer_query(engine, data)
        elif parsed.path == "/api/report" and data is not None:
            output = check(engine, data["document"], save=True)
        elif parsed.path == "/api/report" and data is None:
            output = load_report(engine, args.get("id", [""])[0])
        elif parsed.path == "/api/trace" and data is None:
            output = engine.trace(args.get("session", [None])[0])
        elif parsed.path == "/api/frame" and data is None:
            rows = store.rows(
                "SELECT text FROM frames WHERE run=? AND offset=?",
                (args.get("id", [""])[0], int(args.get("offset", ["0"])[0])),
            )
            if not rows:
                raise ValueError("emitted frame not found")
            output = {"text": rows[0]["text"]}
        elif parsed.path == "/api/info" and data is None:
            from .interfaces import GUIDE

            output = {
                "sources": store.db.execute("SELECT COUNT(*) FROM sources").fetchone()[
                    0
                ],
                "records": store.db.execute("SELECT COUNT(*) FROM records").fetchone()[
                    0
                ],
                "latest_at": iso(
                    store.db.execute("SELECT MAX(at) FROM records").fetchone()[0]
                ),
                "reports": store.rows(
                    "SELECT id FROM runs WHERE kind='report' ORDER BY rowid DESC"
                ),
                "guide": GUIDE,
            }
        else:
            return 404, encode({"error": "route not found"}), mime
        return 200, encode(output), mime
    except (ValueError, TypeError, KeyError, IndexError, OSError) as exc:
        return 400, encode({"error": str(exc)}), mime
    finally:
        if store is not None:
            store.close()
