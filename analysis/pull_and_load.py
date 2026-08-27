"""Pull session_raw_events + events rows for a set of session_ids from prod
(via Superset SQL Lab) and load them into the local analysis ClickHouse.

Read-only against production: this script only ever runs SELECTs against prod.
"""
import argparse
import logging

import clickhouse_connect

import config
import rrweb_decode
from superset_client import SupersetClient

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

RAW_EVENTS_SOURCE_COLUMNS = [
    "ent_id", "session_id", "user_id", "created_at", "sequence_num",
    "hit_id", "event_type", "page_url", "event_payload", "event_payload_version",
]

DECODED_METADATA_COLUMNS = [
    "top_type", "is_user_driven", "mutation_node_ids", "mutation_text_count",
    "mutation_attr_count", "mutation_add_count", "mutation_remove_count",
    "interaction_subtype", "target_node_id",
]

RAW_EVENTS_COLUMNS = RAW_EVENTS_SOURCE_COLUMNS + DECODED_METADATA_COLUMNS

WHATFIX_EVENTS_COLUMNS = [
    "hit_id", "created_at", "ent_id", "type", "source", "category",
    "user_id", "event_version", "geo_country", "wfx_usr_session_id", "pii_resolved_user",
]

NODE_DESCRIPTOR_COLUMNS = [
    "ent_id", "session_id", "snapshot_ts", "node_id", "tag_name",
    "class_attr", "id_attr", "text_snippet",
]


def local_client():
    return clickhouse_connect.get_client(
        host=config.LOCAL_CH_HOST,
        port=config.LOCAL_CH_PORT,
        username=config.LOCAL_CH_USER,
        password=config.LOCAL_CH_PASSWORD,
        database=config.LOCAL_CH_DATABASE,
    )


def _session_id_list_sql(session_ids):
    return "(" + ", ".join(f"'{sid}'" for sid in session_ids) + ")"


def pull_raw_events(superset, ent_id, session_ids):
    sql = f"""
        SELECT {', '.join(RAW_EVENTS_SOURCE_COLUMNS)}
        FROM wfx_olap2.session_raw_events
        WHERE ent_id = '{ent_id}'
          AND session_id IN {_session_id_list_sql(session_ids)}
        ORDER BY session_id, created_at, sequence_num
    """
    rows = list(superset.query_paginated(sql, config.SUPERSET_DB_ID))
    out = []
    node_descriptor_rows = []
    for row in rows:
        metadata = rrweb_decode.describe_event(row["event_type"], row["event_payload"])
        out.append(
            [row[c] for c in RAW_EVENTS_SOURCE_COLUMNS]
            + [metadata[c] for c in DECODED_METADATA_COLUMNS]
        )
        if row["event_type"] == 2:  # FullSnapshot
            for d in rrweb_decode.extract_node_descriptors(row["event_payload"]):
                node_descriptor_rows.append([
                    row["ent_id"], row["session_id"], row["created_at"], d["node_id"],
                    d["tag_name"], d["class_attr"], d["id_attr"], d["text_snippet"],
                ])
    return out, node_descriptor_rows


def pull_whatfix_events(superset, ent_id, session_ids):
    sql = f"""
        SELECT {', '.join(WHATFIX_EVENTS_COLUMNS)}
        FROM wfx_olap2.events
        WHERE ent_id = '{ent_id}'
          AND category = 'whatfix'
          AND wfx_usr_session_id IN {_session_id_list_sql(session_ids)}
        ORDER BY wfx_usr_session_id, created_at
    """
    rows = list(superset.query_paginated(sql, config.SUPERSET_DB_ID))
    return [[row[c] for c in WHATFIX_EVENTS_COLUMNS] for row in rows]


def discover_sessions(superset, ent_id, date, idle_hours=None, lookahead_days=3):
    """Session_ids whose session_start_date (min(created_at)) falls on `date`,
    restricted to "closed" sessions -- either already present in
    session_replay_metadata, or idle beyond idle_hours relative to now. This
    mirrors the exclusion/inclusion pattern in prod's own session_replay_listing
    query (see session-analysis.md).

    lookahead_days bounds the WHERE created_at scan window so long-running
    sessions starting on `date` are still found without scanning the whole
    table; HAVING then pins the true start date precisely.
    """
    idle_hours = config.CLOSED_SESSION_IDLE_HOURS if idle_hours is None else idle_hours
    sql = f"""
        SELECT session_id
        FROM wfx_olap2.session_raw_events
        WHERE ent_id = '{ent_id}'
          AND created_at BETWEEN toDateTime('{date}') AND toDateTime('{date}') + INTERVAL {lookahead_days} DAY
        GROUP BY session_id
        HAVING toDate32(min(created_at), 'UTC') = '{date}'
           AND (
               max(created_at) < now() - INTERVAL {idle_hours} HOUR
               OR session_id IN (
                   SELECT DISTINCT session_id FROM wfx_olap2.session_replay_metadata
                   WHERE ent_id = toUUID('{ent_id}')
               )
           )
        ORDER BY session_id
    """
    rows = list(superset.query_paginated(sql, config.SUPERSET_DB_ID))
    return [row["session_id"] for row in rows]


def load_sessions(ent_id, session_ids):
    superset = SupersetClient()
    superset.login()

    raw_rows, node_descriptor_rows = pull_raw_events(superset, ent_id, session_ids)
    log.info("pulled %d session_raw_events rows for %d session(s)", len(raw_rows), len(session_ids))
    log.info("extracted %d node descriptors from FullSnapshot events", len(node_descriptor_rows))

    whatfix_rows = pull_whatfix_events(superset, ent_id, session_ids)
    log.info("pulled %d whatfix events rows for %d session(s)", len(whatfix_rows), len(session_ids))

    ch = local_client()
    if raw_rows:
        ch.insert("session_raw_events", raw_rows, column_names=RAW_EVENTS_COLUMNS)
    if whatfix_rows:
        ch.insert("events", whatfix_rows, column_names=WHATFIX_EVENTS_COLUMNS)
    if node_descriptor_rows:
        ch.insert("session_node_descriptors", node_descriptor_rows, column_names=NODE_DESCRIPTOR_COLUMNS)

    # pipeline_state rows are written by pipeline.py, once it knows each
    # session's session_start_date (min(created_at)) from the loaded data.
    return len(raw_rows), len(whatfix_rows)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--ent-id", required=True)
    parser.add_argument("--session-id", required=True, help="single session_id for ad-hoc pull")
    args = parser.parse_args()

    n_raw, n_whatfix = load_sessions(args.ent_id, [args.session_id])
    log.info("done: %d raw events, %d whatfix events loaded", n_raw, n_whatfix)
