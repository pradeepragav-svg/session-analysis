-- Local mirror of prod wfx_olap2.session_raw_events / wfx_olap2.events.
-- Replication/TTL clauses dropped — this is disposable scratch storage, not prod.

CREATE TABLE IF NOT EXISTS session_raw_events
(
    `ent_id` UUID,
    `session_id` UUID,
    `user_id` UUID,
    `created_at` DateTime64(3, 'UTC'),
    `sequence_num` UInt32,
    `hit_id` UUID,
    `event_type` UInt8,
    `page_url` String,
    `properties` Map(String, String),
    `ingest_time` DateTime DEFAULT now(),
    `event_payload` String,
    `event_payload_version` UInt8 DEFAULT 0,
    -- event_payload is base64+zlib-compressed JSON (confirmed against
    -- viewer/src/services/decoder.ts) -- ClickHouse has no SQL-level zlib
    -- inflate, so top_type/is_user_driven are decoded once in Python at load
    -- time (pull_and_load.py) and stored here as plain columns, keeping every
    -- downstream matview pure SQL.
    `top_type` LowCardinality(String),
    `is_user_driven` UInt8,
    -- Per-event metadata, also decoded once in Python at load time from the
    -- same already-decompressed payload -- stateless (no cross-event DOM
    -- tree reconstruction), just what's directly present in each event.
    `mutation_node_ids` Array(Int64),
    `mutation_text_count` UInt16,
    `mutation_attr_count` UInt16,
    `mutation_add_count` UInt16,
    `mutation_remove_count` UInt16,
    `interaction_subtype` LowCardinality(String),
    `target_node_id` Nullable(Int64)
)
ENGINE = MergeTree
PARTITION BY toDate(created_at)
PRIMARY KEY (ent_id, user_id, session_id, created_at)
ORDER BY (ent_id, user_id, session_id, created_at, sequence_num);

-- Note: prod's `wfx_usr_session_id` is a MATERIALIZED column derived from
-- properties['wfx_usr_session_id'] via sipHash128 — we only ever pull rows
-- that prod has already resolved, so it's stored here as a plain column
-- (the raw pre-hash string isn't available/needed locally).
CREATE TABLE IF NOT EXISTS events
(
    `hit_id` String,
    `created_at` DateTime64(3, 'UTC'),
    `ent_id` UUID,
    `type` String,
    `source` LowCardinality(String) DEFAULT 'web',
    `category` LowCardinality(String) DEFAULT '-',
    `user_id` UUID,
    `event_version` UInt8,
    `geo_country` String,
    `properties` Map(String, String),
    `pii_properties` Map(String, String),
    `numeric_properties` Map(String, Int64),
    `measures` Map(String, Int64),
    `wfx_usr_session_id` Nullable(UUID),
    `pii_resolved_user` String
)
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMMDD(created_at)
ORDER BY (ent_id, hit_id, created_at);
