-- A clean, chronological, human/LLM-readable narrative of "what happened and
-- when" per session -- built from session_event_metadata (the durable,
-- already-decoded rrweb event layer) unioned with Whatfix analytics events
-- (bounded to the session's own recorded window, same reasoning as
-- unified_events in 02_basic_matviews.sql). Intent: instead of hand-coding
-- every anomaly pattern as a SQL heuristic, hand this sequence to an LLM and
-- let it detect causal patterns directly (e.g. "this recurring text mutation
-- on node 842 is what's triggering the periodic FullSnapshot checkouts")
-- exactly the way a human would reading an event log.
CREATE VIEW IF NOT EXISTS session_event_narrative AS
SELECT
    session_id,
    ent_id,
    ts,
    page_url,
    if(row_number() OVER w = 1, NULL, dateDiff('millisecond', lagInFrame(ts) OVER w, ts)) AS ms_since_prev_event,
    -- single representative node id per event, for resolving against
    -- session_node_descriptors (a Mutation can touch multiple nodes -- the
    -- first is used as representative; MouseInteraction/Scroll/Input already
    -- carry exactly one)
    coalesce(target_node_id, if(empty(mutation_node_ids), NULL, mutation_node_ids[1])) AS primary_node_id,
    top_type,
    is_user_driven,
    multiIf(
        top_type = 'Snapshot', 'FullSnapshot taken (periodic checkout or session start)',
        top_type = 'Mutation' AND mutation_add_count = 0 AND mutation_remove_count = 0
            AND mutation_attr_count = 0 AND mutation_text_count > 0,
            concat('Text content changed on node(s) ', toString(mutation_node_ids)),
        top_type = 'Mutation',
            concat('DOM mutation: +', toString(mutation_add_count), ' added, -',
                   toString(mutation_remove_count), ' removed, ', toString(mutation_attr_count),
                   ' attr change(s), ', toString(mutation_text_count), ' text change(s) on node(s) ',
                   toString(mutation_node_ids)),
        top_type = 'MouseInteraction', concat(interaction_subtype, ' on node ', toString(target_node_id)),
        top_type = 'Scroll', concat('Scroll on node ', toString(target_node_id)),
        top_type = 'Input', concat('Input on node ', toString(target_node_id)),
        top_type = 'MouseMove', 'Mouse moved',
        top_type = 'Whatfix', concat('Whatfix event: ', whatfix_type),
        top_type
    ) AS event_description
FROM (
    SELECT
        session_id, ent_id, created_at AS ts, page_url, top_type, is_user_driven, mutation_node_ids,
        mutation_text_count, mutation_attr_count, mutation_add_count,
        mutation_remove_count, interaction_subtype, target_node_id, '' AS whatfix_type
    FROM session_event_metadata

    UNION ALL

    SELECT
        e.wfx_usr_session_id AS session_id, e.ent_id AS ent_id, e.created_at AS ts,
        '' AS page_url,
        'Whatfix' AS top_type, 0 AS is_user_driven, [] AS mutation_node_ids, 0, 0, 0, 0, '' AS interaction_subtype,
        NULL AS target_node_id, e.type AS whatfix_type
    FROM events e
    INNER JOIN (
        SELECT session_id, min(created_at) AS session_min, max(created_at) AS session_max
        FROM session_event_metadata
        GROUP BY session_id
    ) b ON e.wfx_usr_session_id = b.session_id
    WHERE e.wfx_usr_session_id IS NOT NULL
      AND e.category = 'whatfix'
      AND e.created_at BETWEEN b.session_min AND b.session_max
)
WINDOW w AS (PARTITION BY session_id ORDER BY ts);
