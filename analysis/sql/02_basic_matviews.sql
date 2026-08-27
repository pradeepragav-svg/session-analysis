-- Items #1-3 from session-analysis.md, as plain VIEWs (not MATERIALIZED VIEW —
-- this is a batch/on-demand job over a small, already-loaded local dataset per
-- session, not a streaming insert pipeline, so recompute-on-query is fine).

-- Canonical unified event stream per session: rrweb events from session_raw_events
-- (top_type/is_user_driven decoded from the compressed event_payload in Python
-- at load time -- see rrweb_decode.py -- and stored as plain columns, since
-- ClickHouse has no SQL-level zlib inflate) unioned with Whatfix analytics
-- events from `events` (joined on wfx_usr_session_id).
CREATE VIEW IF NOT EXISTS unified_events AS
SELECT
    session_id,
    ent_id,
    created_at AS ts,
    toUnixTimestamp64Milli(created_at) AS ts_ms,
    top_type,
    is_user_driven,
    0 AS is_whatfix
FROM session_raw_events

UNION ALL

-- Whatfix's own "user session" concept can keep generating events long after
-- the rrweb recording ends (observed: a session recorded for <5min had
-- Whatfix events up to 3hrs later, same wfx_usr_session_id) -- bounding to
-- the recorded session's own [min, max] created_at keeps "this session"
-- consistent with duration_s/#3, and prevents a stray later event from
-- blowing up the inactivity-gap computation past the session's own duration.
SELECT
    e.wfx_usr_session_id AS session_id,
    e.ent_id AS ent_id,
    e.created_at AS ts,
    toUnixTimestamp64Milli(e.created_at) AS ts_ms,
    'Whatfix' AS top_type,
    0 AS is_user_driven,
    1 AS is_whatfix
FROM events e
INNER JOIN (
    SELECT session_id, min(created_at) AS session_min, max(created_at) AS session_max
    FROM session_raw_events
    GROUP BY session_id
) b ON e.wfx_usr_session_id = b.session_id
WHERE e.wfx_usr_session_id IS NOT NULL
  AND e.category = 'whatfix'
  AND e.created_at BETWEEN b.session_min AND b.session_max;

-- #1: max inactivity per session (gap between consecutive user-driven events)
-- NOTE: lagInFrame defaults to 0 (not NULL) for a partition's first row, so
-- the first user-driven event would otherwise show a bogus multi-decade gap
-- (ts_ms - 0) -- row_number() > 1 excludes it explicitly.
CREATE VIEW IF NOT EXISTS session_max_inactivity AS
SELECT
    session_id,
    max(gap_ms) AS max_inactivity_ms
FROM (
    SELECT
        session_id,
        ts_ms - lagInFrame(ts_ms) OVER w AS gap_ms,
        row_number() OVER w AS rn
    FROM unified_events
    WHERE is_user_driven = 1
    WINDOW w AS (PARTITION BY session_id ORDER BY ts_ms)
)
WHERE rn > 1
GROUP BY session_id;

-- #2: every inactivity interval above threshold (see config.INACTIVITY_GAP_MS, default 5000ms)
CREATE VIEW IF NOT EXISTS session_inactivity_intervals AS
SELECT
    session_id,
    lagInFrame(ts_ms) OVER w AS interval_start_ms,
    ts_ms AS interval_end_ms,
    ts_ms - lagInFrame(ts_ms) OVER w AS gap_ms,
    row_number() OVER w AS rn
FROM unified_events
WHERE is_user_driven = 1
WINDOW w AS (PARTITION BY session_id ORDER BY ts_ms)
QUALIFY gap_ms > 5000 AND rn > 1;

-- #1b: max total inactivity per session -- gap between consecutive events of
-- ANY kind (rrweb or Whatfix), i.e. genuine dead air vs. #1's "no user-driven
-- event" gap (which may still contain Mutation/Snapshot/Whatfix activity).
CREATE VIEW IF NOT EXISTS session_max_total_inactivity AS
SELECT
    session_id,
    max(gap_ms) AS max_total_inactivity_ms
FROM (
    SELECT
        session_id,
        ts_ms - lagInFrame(ts_ms) OVER w AS gap_ms,
        row_number() OVER w AS rn
    FROM unified_events
    WINDOW w AS (PARTITION BY session_id ORDER BY ts_ms)
)
WHERE rn > 1
GROUP BY session_id;

-- #2b: every no-event-at-all interval above threshold (same threshold as #2)
CREATE VIEW IF NOT EXISTS session_total_inactivity_intervals AS
SELECT
    session_id,
    lagInFrame(ts_ms) OVER w AS interval_start_ms,
    ts_ms AS interval_end_ms,
    ts_ms - lagInFrame(ts_ms) OVER w AS gap_ms,
    row_number() OVER w AS rn
FROM unified_events
WINDOW w AS (PARTITION BY session_id ORDER BY ts_ms)
QUALIFY gap_ms > 5000 AND rn > 1;

-- #3: sessions with zero Whatfix events
CREATE VIEW IF NOT EXISTS session_no_whatfix AS
SELECT
    session_id,
    countIf(is_whatfix = 1) = 0 AS no_whatfix_events,
    countIf(is_whatfix = 1) AS whatfix_event_count
FROM unified_events
GROUP BY session_id;

-- Cheap Phase-2 triage signal (not causal attribution): flags sessions where
-- Mutation volume looks disproportionate to Whatfix activity, to prioritize
-- which sessions are worth running the real attribution pass on first.
-- NULL ratio (not 0 or inf) when whatfix_event_count = 0 -- "no Whatfix at
-- all" is already captured by has_whatfix_events, and mutation_count / 0 is
-- not a meaningful comparison, just a missing one.
CREATE VIEW IF NOT EXISTS session_mutation_ratio AS
SELECT
    session_id,
    countIf(top_type = 'Mutation') AS mutation_event_count,
    countIf(is_whatfix = 1) AS whatfix_event_count,
    if(
        countIf(is_whatfix = 1) = 0,
        NULL,
        countIf(top_type = 'Mutation') / countIf(is_whatfix = 1)
    ) AS mutation_to_whatfix_ratio
FROM unified_events
GROUP BY session_id;
