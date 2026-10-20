# Changelog

## 0.1.0a9
- Frozen observation projections are reused in a bounded per-workspace LRU; every query still verifies immutable source checksums.
- `bounded-history-pages-v1` supports `transport_bytes` (64 KiB–1 MiB); messages still determine page boundaries, with lossless record continuation and call/result pairing.


## 0.1.0a8
- Allow snapshot record/context queries to omit repeated overview calculation while retaining native evidence and pagination.


## 0.1.0a7
- Add fixed-snapshot record anchors for call details and accurate historical message navigation; preserve native pairing, redaction and message pagination.


## 0.1.0a5

- Expose redacted native DevEco session titles in live and frozen observation metadata, with immutable historical names.

## 0.1.0a4

- Durable native JSONL append with byte acknowledgements, incomplete-line buffering and restart-safe cursors.
- Native DevEco message/part upserts; immutable revision evidence and bounded live-tail queries.
- Explicit live freeze preserves original bytes and existing snapshot/repair contracts.
- Message pagination counts user/assistant messages without dropping intervening tools; transport pages share a fixed snapshot or cursor.
- DevEco native upsert accepts bounded large documents up to the existing 64 MiB source limit; unrelated endpoints retain smaller request limits.

## 0.1.0a3

- Added agent-run-v1 observation capability: native tool timing, session relationships, token usage, and separately labelled host activity, resource and workflow facts.
- Added host-event paging, full-text search, level/span/type/source filters and stable event identities across snapshots.
- Accept incomplete final JSONL rows only with explicit partial=true; preserve original bytes and record the gap.
- Reject foreign DevEco message ownership and retain immutable source references for complete public evidence.
- HarnessCore consumes component APIs for its entire Agent Run observation UI; host execution control stays independent.

## 0.1.0a2

- Added native observation paging, search and complete public evidence chunks with original SHA/coordinates.
- Added immutable repair evidence linking two snapshots, preserving file ownership and evidence gaps without asserting semantic cause.
- Added host context on snapshots and durable investigation lookup/case-body APIs for HTTP consumers.
- Integrated HarnessCore as an independent HTTP consumer with native conversation and repair investigation UI.
- Verified clean wheel installation and Core a1-to-a2 snapshot/source compatibility; DSH adapter remains 0.1.0-alpha.1.

## 0.1.0a1 / DSH 0.1.0-alpha.1

- Extracted native session inquiry and evidence checking into an independently built Core.
- Added immutable sources/snapshots, CLI, HTTP, Viewer, MCP and offline exports.
- Extracted case/experience packaging, versioned publication and lexical retrieval.
- Added explicit budgeted investigation execution, restart/cancel protection and publication auth.
- Added DSH consumption tools with real SDK contracts and cross-process Core integration tests.
- Preserved source provenance and documented implemented versus planned interfaces.

## 0.1.0a6
- Observation overview adds native session observed intervals, tool end times and timing provenance. Completion-only, missing, reversed and equal timestamps no longer fabricate measured 0ms durations.
- Correlates registered resource aliases with native skill/agent calls, successful file reads and script execution across sessions. Availability is separate from usage; absent evidence returns not-observed and nullable counters. Native and host counters are never added together.
