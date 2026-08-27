CREATE TABLE IF NOT EXISTS pipeline_state
(
    session_id UUID,
    ent_id UUID,
    session_start_date Date,
    status Enum8('pulled' = 1, 'summarized' = 2, 'cleaned' = 3),
    updated_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (ent_id, session_id);

CREATE TABLE IF NOT EXISTS watermark
(
    ent_id UUID,
    last_completed_date Date
)
ENGINE = ReplacingMergeTree
ORDER BY ent_id;
