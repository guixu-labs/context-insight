# AgentLineage Core

Version 0.1.0a10. Python 3.12+. Install this wheel alone to import Claude/Codex/DevEco/DSH v4
native session materials, query frozen evidence, validate reports and export offline HTML.
CLI: `agentlineage --data-dir PATH --help`. Optional `[mcp]` extra adds stdio tools.
Public SDK: `agentlineage_core.api.Core`. HTTP service is a single private workspace.
No HMigBot, Learning, DSH or model-provider dependency.

DSH native v4 JSONL uses session metadata and ordered events; confirmed tool receipts,
PTC child calls, working-directory changes and fork inheritance are preserved. The DSH
plugin reads live or compressed saved sessions through DSH's public API and exports
native JSONL. Original uploaded bytes and line coordinates remain available through Core.
`serve --port 0 --exclusive` supports a Profile-owned loopback process with an OS-assigned
port and an exclusive data-directory lease. The first stdout line announces its URL.
The standalone CLI and existing external HTTP service mode remain available.
