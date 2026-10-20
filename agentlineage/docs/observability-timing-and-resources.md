# Observation timing and native resource usage

`POST /v1/snapshots/{snapshot_id}/observations` keeps its v1 contract and adds optional overview fields in Core 0.1.0a6. Original sources and snapshots remain immutable.

- `overview.sessions`: `session_id`, ISO `started_at`/`ended_at`, nullable `duration_ms`, and `timing: observed-range`. This is the first-to-last observed native activity, including waiting, not CPU time or proof the agent completed.
- `overview.calls`: adds `ended_at` and `timing: measured|completion-only|missing|invalid|same-timestamp`. Only a positive interval between distinct native request/result records has a measured duration. A completion event projecting both halves cannot prove its own start.
- Host `trace` entries with `spanRole=event` are point observations, not timed executions. A missing host offset cannot be invented as zero.
- Optional host resource metadata `native_name`, `native_paths`, `native_root` declares the registered resource identity and its file scope. The host binds this metadata to the saved run version; paths are read-only evidence hints, never execution authority.
- `overview.resources[].usage` derives reads and invocations from native records and matches session+call identity. Requires an observed result without native failure. Skill/Agent name matching is exact and must be unique; script paths match registered directories at path boundaries. Mentions, echoes and denied calls are not successful use. Evidence details include operation, session, timestamp and source reference (first 32 records retained in the overview).
- Native counters take precedence over host counters for the same resource and are not summed. No observations yields nullable counters and `source: not-observed`. Host positive evidence remains labeled as host evidence. `complete=false` avoids turning absence into proof of nonuse.

HarnessCore renders these component-owned facts as a temporal DAG, shared-axis execution lanes and resource usage cards. It does not parse a second custom transcript.


## Fixed-snapshot record anchors (0.1.0a7)
The `record-anchors-v1` capability adds `anchor_id` to observations queries. The identifier must be a nonempty returned record ID (at most 300 characters). Filters apply first, so a record from another session or outside the search yields 404 rather than a fallback. The response echoes the anchor and the resolved page offset.

- Call details: `{ "anchor_id": "<call record id>", "session_id": "<session>", "page_unit": "records", "limit": 1 }` returns the call with its existing `pair` result; text remains redacted and excerpted with existing evidence continuation.
- Conversation navigation: use the same anchor with `page_unit: "messages", limit:100`. The containing user/Agent-message page includes interleaved tools; a tool before the first message belongs to the first page. Transport continuation keeps the same anchor and record_offset.
- The snapshot ID fixes evidence and pagination across later updates. Existing non-anchor queries and native formats are unchanged. Live incremental queries do not accept anchor_id; obtain a fixed snapshot for historical positioning.

The component supplies identities, pairing, timing and pagination. Its host controls bars, Ctrl-wheel zoom, tab navigation, highlighting and expansion.


### Context-only pages (0.1.0a8)
The `optional-overview-v1` capability permits boolean `include_overview:false` in snapshot observation queries. It omits the expensive `overview` projection while preserving records, native pairs, filters, sessions and page metadata. Default remains true. Hosts can request the overview once, then omit it for call previews and transport continuation; they must retain snapshot identity when reusing a previous overview. This option is not part of the live query API.

## Historical page performance (a9)
`bounded-history-pages-v1` advertises optional `transport_bytes` (65536–1048576). The budget applies to UTF-8 encoded public records including paired records. Snapshot metadata is additional. Message pages may carry up to 1000 records per transport segment; always follow `next_record_offset` until null. The 100-message page boundary and anchor are unchanged. Legacy queries retain their 20-record transport size. Parsed views use a maximum 8-entry/32-MiB per-Core cache, with original and projected source checksum checks on every read. API results do not share mutable cached evidence.
