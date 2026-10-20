from __future__ import annotations

import asyncio
import os
import sys

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from agentlineage_core.api import Core
from conftest import ROOT, timestamp


def test_mcp_stdio_exposes_same_frozen_evidence(tmp_path, native_pool):
    core = Core(tmp_path / "state")
    snapshot = core.import_files("mcp-fixture", [native_pool])["snapshot_id"]

    async def run():
        parameters = StdioServerParameters(
            command=sys.executable,
            args=["-m", "agentlineage_core.cli", "--data-dir", str(core.root),
                  "mcp", "--snapshot", snapshot],
            env={**os.environ, "PYTHONPATH": str(ROOT / "components/core/src"),
                 "PYTHONIOENCODING": "utf-8"},
        )
        async with stdio_client(parameters) as (reader, writer):
            async with ClientSession(reader, writer) as session:
                initialized = await session.initialize()
                assert initialized.serverInfo.name == "agentlineage-inquiry"
                available = await session.list_tools()
                assert {tool.name for tool in available.tools} == {"investigate", "page", "submit"}
                assert next(tool for tool in available.tools if tool.name == "submit").annotations.readOnlyHint is False
                result = await session.call_tool("investigate", {"requests": [
                    {"op": "file", "key": "/project/view.py", "at": timestamp(9),
                     "view": "relations"}]})
                assert not result.isError
                text = "\n".join(item.text for item in result.content if item.type == "text")
                assert "RESULT" in text and "session-1:worker-1" in text, text

    asyncio.run(asyncio.wait_for(run(), timeout=30))
