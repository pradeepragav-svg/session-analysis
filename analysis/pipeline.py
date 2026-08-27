"""Day-wise / ad-hoc pipeline driver: pull -> matviews -> summarize -> cleanup."""
import argparse
import logging
from datetime import date, timedelta

import clickhouse_connect

import cleanup
import config
import pull_and_load
from superset_client import SupersetClient

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


def summarize_session(ch, ent_id, session_id):
    row = ch.query(f"""
        SELECT
            toDate(min(created_at)) AS session_start_date,
            dateDiff('second', min(created_at), max(created_at)) AS duration_s
        FROM session_raw_events
        WHERE session_id = '{session_id}'
    """).first_row
    session_start_date, duration_s = row

    max_no_user_event_gap_row = ch.query(f"""
        SELECT round(max_inactivity_ms / 1000) FROM session_max_inactivity
        WHERE session_id = '{session_id}'
    """).first_row
    max_no_user_event_gap_s = max_no_user_event_gap_row[0] if max_no_user_event_gap_row else 0

    no_user_event_interval_count = ch.query(f"""
        SELECT count() FROM session_inactivity_intervals
        WHERE session_id = '{session_id}'
    """).first_row[0]

    max_no_event_gap_row = ch.query(f"""
        SELECT round(max_total_inactivity_ms / 1000) FROM session_max_total_inactivity
        WHERE session_id = '{session_id}'
    """).first_row
    max_no_event_gap_s = max_no_event_gap_row[0] if max_no_event_gap_row else 0

    no_event_interval_count = ch.query(f"""
        SELECT count() FROM session_total_inactivity_intervals
        WHERE session_id = '{session_id}'
    """).first_row[0]

    whatfix_row = ch.query(f"""
        SELECT whatfix_event_count, not no_whatfix_events FROM session_no_whatfix
        WHERE session_id = '{session_id}'
    """).first_row
    whatfix_event_count, has_whatfix_events = whatfix_row if whatfix_row else (0, 0)

    mutation_row = ch.query(f"""
        SELECT mutation_event_count, mutation_to_whatfix_ratio FROM session_mutation_ratio
        WHERE session_id = '{session_id}'
    """).first_row
    mutation_event_count, mutation_to_whatfix_ratio = mutation_row if mutation_row else (0, None)

    ch.insert(
        "session_interval_summary",
        [[
            session_id, ent_id, session_start_date, duration_s,
            int(max_no_user_event_gap_s), no_user_event_interval_count,
            int(max_no_event_gap_s), no_event_interval_count,
            whatfix_event_count, int(has_whatfix_events),
            mutation_event_count, mutation_to_whatfix_ratio,
        ]],
        column_names=[
            "session_id", "ent_id", "session_start_date", "duration_s",
            "max_no_user_event_gap_s", "no_user_event_interval_count",
            "max_no_event_gap_s", "no_event_interval_count",
            "whatfix_event_count", "has_whatfix_events",
            "mutation_event_count", "mutation_to_whatfix_ratio",
        ],
    )
    return {
        "session_start_date": session_start_date,
        "duration_s": duration_s,
        "max_no_user_event_gap_s": int(max_no_user_event_gap_s),
        "no_user_event_interval_count": no_user_event_interval_count,
        "max_no_event_gap_s": int(max_no_event_gap_s),
        "no_event_interval_count": no_event_interval_count,
        "whatfix_event_count": whatfix_event_count,
        "has_whatfix_events": bool(has_whatfix_events),
        "mutation_event_count": mutation_event_count,
        "mutation_to_whatfix_ratio": mutation_to_whatfix_ratio,
    }


def mark_pipeline_state(ch, ent_id, session_id, session_start_date, status):
    ch.insert(
        "pipeline_state",
        [[session_id, ent_id, session_start_date, status]],
        column_names=["session_id", "ent_id", "session_start_date", "status"],
    )


def run_session(ent_id, session_id, ch=None):
    ch = ch or local_client()
    log.info("pulling session %s (ent_id=%s)", session_id, ent_id)
    pull_and_load.load_sessions(ent_id, [session_id])

    summary = summarize_session(ch, ent_id, session_id)
    mark_pipeline_state(ch, ent_id, session_id, summary["session_start_date"], "summarized")
    log.info("summary for %s: %s", session_id, summary)

    cleanup.cleanup_session(ch, session_id)
    mark_pipeline_state(ch, ent_id, session_id, summary["session_start_date"], "cleaned")
    log.info("cleaned local raw rows for %s", session_id)

    return summary


def get_cleaned_session_ids(ch, ent_id):
    # Stages are monotonic (pulled=1 < summarized=2 < cleaned=3), so max(status)
    # gives the furthest stage reached without depending on updated_at
    # timestamp resolution (argMax(status, updated_at) ties when two stages
    # for the same session land in the same second/millisecond).
    rows = ch.query(f"""
        SELECT session_id
        FROM pipeline_state
        WHERE ent_id = '{ent_id}'
        GROUP BY session_id
        HAVING max(status) = 'cleaned'
    """).result_rows
    # clickhouse_connect returns UUID columns as uuid.UUID, but session_ids
    # from Superset's JSON (discover_sessions) are plain str -- normalize both
    # sides to str so `session_id not in cleaned` comparisons actually match.
    return {str(r[0]) for r in rows}


def get_watermark(ch, ent_id):
    row = ch.query(f"""
        SELECT max(last_completed_date) FROM watermark WHERE ent_id = '{ent_id}'
    """).first_row
    return row[0] if row and row[0] and row[0] != date(1970, 1, 1) else None


def advance_watermark(ch, ent_id, completed_date):
    ch.insert(
        "watermark",
        [[ent_id, completed_date]],
        column_names=["ent_id", "last_completed_date"],
    )


def run_date(ent_id, target_date, superset=None, limit=None):
    """Day-wise sweep: discover closed sessions starting on target_date, skip
    ones already 'cleaned' (idempotent re-run), process the rest, and advance
    the watermark only once every DISCOVERED session for this date is cleaned.

    limit caps how many not-yet-cleaned sessions are processed in this call --
    intended for smoke-testing a day with a partial run. The watermark is
    never advanced when limit truncated the discovered set, since the day
    isn't actually complete yet.
    """
    superset = superset or SupersetClient()
    if superset.access_token is None:
        superset.login()

    session_ids = pull_and_load.discover_sessions(superset, ent_id, target_date)
    log.info("discovered %d closed session(s) for ent_id=%s on %s", len(session_ids), ent_id, target_date)

    ch = local_client()
    cleaned = get_cleaned_session_ids(ch, ent_id)
    to_process = [s for s in session_ids if s not in cleaned]
    truncated = limit is not None and len(to_process) > limit
    if truncated:
        to_process = to_process[:limit]
    log.info("%d already cleaned, processing %d%s", len(cleaned & set(session_ids)), len(to_process), " (limited)" if truncated else "")

    for session_id in to_process:
        run_session(ent_id, session_id, ch=ch)

    if truncated:
        log.info("watermark NOT advanced for %s (limit=%d, day not fully processed)", target_date, limit)
        return

    cleaned_after = get_cleaned_session_ids(ch, ent_id)
    if session_ids and all(s in cleaned_after for s in session_ids):
        advance_watermark(ch, ent_id, target_date)
        log.info("watermark advanced to %s for ent_id=%s", target_date, ent_id)
    else:
        log.info("watermark NOT advanced for %s (some sessions not yet cleaned)", target_date)


def run_date_range(ent_id, start_date, end_date):
    superset = SupersetClient()
    superset.login()
    d = start_date
    while d <= end_date:
        run_date(ent_id, d, superset=superset)
        d += timedelta(days=1)


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--ent-id", required=True)
    mode = parser.add_mutually_exclusive_group(required=False)
    mode.add_argument("--session-id", help="ad-hoc single-session run")
    mode.add_argument("--date", help="day-wise sweep for one day, YYYY-MM-DD")
    mode.add_argument("--date-range", help="backfill a span, e.g. 2026-06-23:2026-06-29")
    parser.add_argument("--limit", type=int, default=None, help="cap sessions processed for a --date run (smoke-test partial sweep)")
    args = parser.parse_args(argv)

    if args.session_id:
        run_session(args.ent_id, args.session_id)
    elif args.date:
        run_date(args.ent_id, date.fromisoformat(args.date), limit=args.limit)
    elif args.date_range:
        start_str, end_str = args.date_range.split(":")
        run_date_range(args.ent_id, date.fromisoformat(start_str), date.fromisoformat(end_str))
    else:
        ch = local_client()
        watermark = get_watermark(ch, args.ent_id)
        if watermark is None:
            raise SystemExit(
                f"No watermark yet for ent_id={args.ent_id}. "
                "Specify --date or --date-range to seed the first run."
            )
        run_date(args.ent_id, watermark + timedelta(days=1))


if __name__ == "__main__":
    main()
