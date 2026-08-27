-- Durable, semantically-meaningful per-event store, auto-populated from
-- session_raw_events on every insert via a real ClickHouse MATERIALIZED VIEW.
--
-- Note: the MV only sees the already-decoded plain columns (top_type,
-- mutation_node_ids, etc.) written by pull_and_load.py at load time --
-- ClickHouse has no SQL-level zlib inflate, so it can't read event_payload
-- directly; decoding must happen in Python before this MV ever sees the row.
--
-- Unlike session_raw_events/events (disposable, deleted by cleanup.py per
-- session), this table is meant to ACCUMULATE across every session ever
-- processed -- it's the durable "what actually happened" layer that survives
-- cleanup, so sessions can be analyzed later without re-pulling/re-decoding
-- raw payloads from prod.
CREATE TABLE IF NOT EXISTS session_event_metadata
(
    ent_id UUID,
    session_id UUID,
    created_at DateTime64(3, 'UTC'),
    event_type UInt8,
    page_url String,
    top_type LowCardinality(String),
    is_user_driven UInt8,
    mutation_node_ids Array(Int64),
    mutation_text_count UInt16,
    mutation_attr_count UInt16,
    mutation_add_count UInt16,
    mutation_remove_count UInt16,
    interaction_subtype LowCardinality(String),
    target_node_id Nullable(Int64)
)
ENGINE = MergeTree
PARTITION BY toDate(created_at)
ORDER BY (ent_id, session_id, created_at);

CREATE MATERIALIZED VIEW IF NOT EXISTS session_event_metadata_mv
TO session_event_metadata AS
SELECT
    ent_id, session_id, created_at, event_type, page_url, top_type, is_user_driven,
    mutation_node_ids, mutation_text_count, mutation_attr_count,
    mutation_add_count, mutation_remove_count, interaction_subtype, target_node_id
FROM session_raw_events;
