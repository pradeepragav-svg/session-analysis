-- Tier 1 of staged_narrative_summarization_design_2026-07-03.md: collapse
-- session_event_narrative_enriched (thousands of rows/session) into a small
-- number of stage-level summary rows via pure SQL aggregation -- no LLM cost
-- at this tier. A new stage starts whenever there's a real break: a gap
-- above STAGE_GAP_MS since the previous event, or a page_url change.

-- Row-level: tag each event with its stage_id (cumulative count of stage
-- breaks so far, per session).
CREATE VIEW IF NOT EXISTS session_narrative_stages AS
SELECT
    session_id,
    ent_id,
    ts,
    page_url,
    primary_node_id,
    node_tag,
    top_type,
    is_user_driven,
    event_description,
    sum(new_stage) OVER (PARTITION BY session_id ORDER BY ts ROWS UNBOUNDED PRECEDING) AS stage_id
FROM (
    SELECT
        n.session_id, n.ent_id, n.ts, n.page_url, n.primary_node_id, n.top_type,
        n.is_user_driven, n.event_description, n.node_tag,
        if(
            n.ms_since_prev_event IS NULL
            OR n.ms_since_prev_event > 180000  -- 3 min gap -> new stage
            -- Whatfix events carry page_url='' (they have none) -- only treat
            -- a page_url difference as a real navigation when BOTH sides are
            -- non-empty, so a Whatfix event interspersed among rrweb events
            -- doesn't spuriously split a stage on either side of it.
            OR (
                n.page_url != ''
                AND lagInFrame(n.page_url) OVER (PARTITION BY n.session_id ORDER BY n.ts) != ''
                AND n.page_url != lagInFrame(n.page_url) OVER (PARTITION BY n.session_id ORDER BY n.ts)
            ),
            1, 0
        ) AS new_stage
    FROM session_event_narrative_enriched n
);

-- Per-stage node-touch frequency, used to surface the most-repeated node in
-- each stage (the "is this a ticker" signal) without an LLM.
CREATE VIEW IF NOT EXISTS session_stage_top_node AS
SELECT session_id, stage_id, primary_node_id, node_tag, node_count
FROM (
    SELECT
        session_id, stage_id, primary_node_id, any(node_tag) AS node_tag,
        count() AS node_count,
        row_number() OVER (PARTITION BY session_id, stage_id ORDER BY count() DESC) AS rn
    FROM session_narrative_stages
    WHERE primary_node_id IS NOT NULL
    GROUP BY session_id, stage_id, primary_node_id
)
WHERE rn = 1;

-- Tier-1 output: one row per stage instead of one row per event.
CREATE VIEW IF NOT EXISTS session_stage_summary AS
SELECT
    s.session_id,
    s.ent_id,
    s.stage_id,
    min(s.ts) AS start_ts,
    max(s.ts) AS end_ts,
    dateDiff('second', min(s.ts), max(s.ts)) AS duration_s,
    anyIf(s.page_url, s.page_url != '') AS page_url,
    count() AS event_count,
    countIf(s.is_user_driven = 1) AS user_driven_count,
    countIf(s.top_type = 'Whatfix') AS whatfix_count,
    countIf(s.top_type = 'Mutation') AS mutation_count,
    countIf(s.is_user_driven = 1) > 0 OR countIf(s.top_type = 'Whatfix') > 0 AS has_real_activity,
    uniqExact(s.primary_node_id) AS distinct_node_count,
    any(t.primary_node_id) AS top_node_id,
    any(t.node_tag) AS top_node_tag,
    any(t.node_count) AS top_node_count,
    -- first/last event description as a cheap textual sample, avoiding
    -- pulling every one of the stage's raw rows into an LLM prompt
    argMin(s.event_description, s.ts) AS first_event_description,
    argMax(s.event_description, s.ts) AS last_event_description
FROM session_narrative_stages s
LEFT JOIN session_stage_top_node t
    ON s.session_id = t.session_id AND s.stage_id = t.stage_id
GROUP BY s.session_id, s.ent_id, s.stage_id
ORDER BY s.session_id, s.stage_id;
