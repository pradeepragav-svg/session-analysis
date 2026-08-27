-- Phase 1 columns, plus a cheap pre-Phase-2 triage signal (mutation_event_count
-- / mutation_to_whatfix_ratio -- NOT causal attribution, just a cheap flag for
-- which sessions are worth running the real attribution pass on first).
-- Phase 2 proper adds whatfix_driven_duration_pct /
-- unattributed_mutation_duration_pct via an ALTER TABLE at that time.
CREATE TABLE IF NOT EXISTS session_interval_summary
(
    session_id UUID,
    ent_id UUID,
    session_start_date Date,
    duration_s UInt32,
    max_no_user_event_gap_s UInt32,
    no_user_event_interval_count UInt32,
    max_no_event_gap_s UInt32,
    no_event_interval_count UInt32,
    whatfix_event_count UInt32,
    has_whatfix_events UInt8,
    mutation_event_count UInt32,
    mutation_to_whatfix_ratio Nullable(Float32),
    computed_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (ent_id, session_id);
