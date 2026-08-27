"""Deletes a processed session's raw rows from the LOCAL analysis ClickHouse
only, once session_interval_summary has a confirmed row for it. Production is
never touched -- local data is disposable and always re-derivable from prod.
"""
import argparse
import logging

import clickhouse_connect

import config

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)


def local_client():
    return clickhouse_connect.get_client(
        host=config.LOCAL_CH_HOST,
        port=config.LOCAL_CH_PORT,
        username=config.LOCAL_CH_USER,
        password=config.LOCAL_CH_PASSWORD,
        database=config.LOCAL_CH_DATABASE,
    )


def cleanup_session(ch, session_id):
    # mutations_sync=1: block until the delete mutation applies -- this is a
    # small scratch dataset, so waiting for async mutation cleanup isn't worth
    # the complexity, and callers (pipeline.py) rely on the delete being
    # visible immediately for the pipeline_state 'cleaned' transition.
    settings = {"mutations_sync": "1"}
    ch.command(
        f"ALTER TABLE session_raw_events DELETE WHERE session_id = '{session_id}'",
        settings=settings,
    )
    ch.command(
        f"ALTER TABLE events DELETE WHERE wfx_usr_session_id = '{session_id}'",
        settings=settings,
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--session-id", required=True)
    args = parser.parse_args()

    ch = local_client()
    cleanup_session(ch, args.session_id)
    log.info("cleaned local raw rows for %s", args.session_id)
