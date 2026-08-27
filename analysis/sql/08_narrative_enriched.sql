-- session_event_narrative + resolved element info for each event's
-- primary_node_id, via ASOF JOIN against session_node_descriptors (nearest
-- PRECEDING FullSnapshot's descriptor for that node id -- accepts staleness
-- for nodes added purely by a Mutation between two snapshots, and correctly
-- handles node-id reuse across page navigations by always picking the
-- closest-in-time snapshot rather than a single global lookup).
CREATE VIEW IF NOT EXISTS session_event_narrative_enriched AS
SELECT
    n.session_id,
    n.ent_id,
    n.ts,
    n.page_url,
    n.ms_since_prev_event,
    n.primary_node_id,
    n.top_type,
    n.is_user_driven,
    d.tag_name AS node_tag,
    d.class_attr AS node_class,
    d.id_attr AS node_id_attr,
    d.text_snippet AS node_text_snippet,
    if(
        n.primary_node_id IS NOT NULL AND d.tag_name != '',
        concat(
            n.event_description, '  [<', d.tag_name,
            if(d.class_attr != '', concat(' class="', d.class_attr, '"'), ''),
            if(d.id_attr != '', concat(' id="', d.id_attr, '"'), ''),
            '>',
            if(d.text_snippet != '', concat(' "', d.text_snippet, '"'), ''),
            ']'
        ),
        n.event_description
    ) AS event_description
FROM session_event_narrative n
ASOF LEFT JOIN session_node_descriptors d
    ON n.session_id = d.session_id
   AND n.primary_node_id = d.node_id
   AND n.ts >= d.snapshot_ts
ORDER BY n.session_id, n.ts;
