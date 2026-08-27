-- Node-id -> element descriptor, extracted once per FullSnapshot (not via
-- continuous stateful mutation replay -- see
-- staged_narrative_summarization_design_2026-07-03.md Section 4). Lets any
-- later event's node id (mutation_node_ids, target_node_id) resolve to a real
-- element (tag/class/id) using the nearest-preceding snapshot's descriptor --
-- accept staleness for nodes added purely by a Mutation between two
-- snapshots, until the next snapshot captures them.
--
-- Durable like session_event_metadata: survives cleanup.py's per-session
-- deletes, since it's cheap (one row per node per snapshot) and useful for
-- later analysis without re-pulling/re-decoding from prod.
CREATE TABLE IF NOT EXISTS session_node_descriptors
(
    ent_id UUID,
    session_id UUID,
    snapshot_ts DateTime64(3, 'UTC'),
    node_id Int64,
    tag_name LowCardinality(String),
    class_attr String,
    id_attr String,
    text_snippet String
)
ENGINE = MergeTree
PARTITION BY toDate(snapshot_ts)
ORDER BY (ent_id, session_id, node_id, snapshot_ts);

-- Resolve a node id at a given event time to the nearest-preceding
-- snapshot's descriptor for that node, per session. Usage:
--   SELECT * FROM session_node_descriptor_asof
--   WHERE session_id = '...' AND node_id = 842 AND snapshot_ts <= '<event ts>'
--   ORDER BY snapshot_ts DESC LIMIT 1
-- (ASOF JOIN against session_event_narrative is the general-purpose version
-- of this, applied per-row rather than one-off.)
