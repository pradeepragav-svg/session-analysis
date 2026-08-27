# Implementation Plan — Session Interval/Attribution Analysis

## Context

`session-analysis.md` lays out a scalable, non-LLM way to derive per-session insights (max inactivity, inactivity intervals, sessions with no Whatfix events, Whatfix-attributed activity, unattributed-mutation churn) from the existing `events`, `session_raw_events`, and `session_replay_metadata` ClickHouse tables, then hand a compact per-session feature vector to an LLM for narrative/action items. This directly supports the ongoing storage-cost investigation in `session_length_investigation_2026-06-30.md` (33% of sessions run 30min+, and event density in long sessions is ~35× the periodic-snapshot floor — something other than the 5-min snapshot timer is keeping sessions alive).

The doc itself splits cleanly into two difficulty tiers: items **#1–#3** (max inactivity, inactivity intervals, no-Whatfix-events) are plain gaps-and-islands SQL with no state beyond a sort. Items **#4–#5** (Whatfix-attributed activity, unattributed-mutation churn) need causal attribution — a sequential per-session pass, not just filtering. This plan is phased accordingly: **Phase 1 ships #1–#3 end-to-end** (pull → local matviews → summary → viewer/insight value) before any attribution-pass work starts. **Phase 2 adds #4–#5** on top of the same pipeline skeleton, extending — not replacing — Phase 1's tables and CLI.

Note: the pipeline is **read-only against production** in both phases — it only ever pulls from prod (via Superset SQL Lab, the only sanctioned query path — confirmed via `superset-mcp`, no direct ClickHouse credentials exist); all writes/deletes happen in the local analysis ClickHouse instance, which is disposable scratch storage re-derivable from prod at any time.

**Note on `/Users/pradeep/clickhouse-validation`**: this is an unrelated replication/zero-copy stress-test harness (2-node cluster + Keeper, seeded with synthetic data per `sql/01_create_schema.sql`). It's useful as a reference for schema/docker-compose syntax but is not where this pipeline's data should live — it's disposable test infrastructure, not a dev sandbox for this feature.

**Schema already known** (from `session_length_investigation_2026-06-30.md` §5, no need to re-derive):
- `wfx_olap2.session_raw_events(ent_id, session_id, user_id, created_at, sequence_num, hit_id, event_type UInt8, page_url, properties Map, event_payload, ...)`
- `wfx_olap2.events(hit_id, created_at, ent_id, type String, source, category, user_id, event_version, ...)` — the Whatfix analytics stream, joined via `wfx_usr_session_id`.
- `wfx_olap2.session_replay_metadata` — session-level metadata for sessions migrated to blob storage.

## Architecture (shared across both phases)

```
Production ClickHouse (via Superset SQL Lab / superset-mcp)
        │  pull batch of session_raw_events + events rows for N session_ids
        ▼
Local ClickHouse (new lightweight single-node docker-compose)
        │  mirrored tables, matviews for cheap aggregates          [Phase 1]
        ▼
Python attribution pass (pandas, per-session sequential scan)      [Phase 2]
        │  writes labeled events + interval segments back
        ▼
session_interval_summary table (local, promotable to prod later)
        │                                    │
        │                                    └─► cleanup.py deletes the now-
        │                                        processed session's raw rows
        │                                        from LOCAL tables only (prod
        │                                        is never touched)
        ├─► viewer annotations (future: EventTimeline reads this table)
        └─► LLM narrative / cross-session action items (Layer 2, future phase)
```

### New directory: `analysis/` (Python, alongside the existing `viewer/` app)

| File | Phase | Purpose |
|---|---|---|
| `analysis/requirements.txt` | 1 | `clickhouse-connect`, `pandas`, `requests`, `python-dotenv` |
| `analysis/config.py` | 1 | Env-driven config: `SUPERSET_URL`, `SUPERSET_USER`, `SUPERSET_PASSWORD`, `ENT_ID`, local CH host/port. Credentials via `.env` (gitignored), never hardcoded. |
| `analysis/local_clickhouse/docker-compose.yml` | 1 | Single-node ClickHouse (no replication/Keeper needed) — simpler than `clickhouse-validation`'s 2-node harness since this is a scratch analysis store, not a replication test. |
| `analysis/sql/01_create_tables.sql` | 1 | Local `session_raw_events` / `events` tables mirroring prod columns (drop prod-only TTL/replication clauses). |
| `analysis/sql/02_basic_matviews.sql` | 1 | Pure-SQL matviews/queries for items **#1–#3**: max inactivity (gaps-over-user-events), inactivity interval list (`QUALIFY gap_ms > threshold`), and `no_whatfix_events` per session. Reuses the exact window-function patterns already written in `session-analysis.md` — no new SQL design needed, just materialize them. |
| `analysis/sql/03_session_interval_summary.sql` | 1 (extended in 2) | Summary table DDL. Phase 1 columns: `session_id, duration_s, max_inactivity_s, inactive_interval_count, whatfix_event_count, has_whatfix_events`. Phase 2 adds: `whatfix_driven_duration_pct, unattributed_mutation_duration_pct`. |
| `analysis/sql/04_pipeline_state.sql` | 1 | DDL for `pipeline_state` (per-session progress) and `watermark` (per-`ent_id` last-completed day) — see State Management below. |
| `analysis/pull_and_load.py` | 1 | For a date range / session_id batch: calls Superset SQL Lab (same auth flow as `superset-mcp` — LDAP login, session cookie, CSRF token, POST to SQL Lab execute endpoint) to pull rows, batch-inserts into local ClickHouse via `clickhouse-connect`. Standalone script (not the MCP tool itself), since a scheduled/repeatable batch job can't depend on an interactive agent session. |
| `analysis/pipeline.py` | 1 (extended in 2) | CLI entrypoint: `pull_and_load` → matviews → write `session_interval_summary` → `cleanup`. Phase 2 inserts the `attribution` stage between matviews and summary-write. Supports the targeting modes below from Phase 1 onward. |
| `analysis/cleanup.py` | 1 | Deletes `session_raw_events`/`events` rows from the **local analysis ClickHouse only**, for sessions with a confirmed `session_interval_summary` row. Production is never touched. |
| `analysis/attribution.py` | 2 | Implements items **#4 and #5**: per-session sequential pass (pandas) that labels each Mutation event `attributed_to ∈ {user, whatfix, unattributed_mutation, system}` using the "chain propagation within N ms of a Whatfix event" rule from the doc (threshold empirically tuned, start at 300ms), then run-length-encodes label runs into interval segments (start/end/duration/count). Genuinely awkward in pure SQL, matching the doc's own conclusion — this is why it's isolated to its own phase. |

## State management — day-wise, resumable processing (built in Phase 1, used by both)

The pipeline needs to work through *all* sessions in prod incrementally (one day at a time, run daily/on a schedule) without reprocessing what's already done and without mis-processing sessions that span multiple days. Two local tables handle this:

**`pipeline_state`** — one row per session, tracks progress through the pipeline stages:
```sql
CREATE TABLE pipeline_state (
    session_id UUID,
    ent_id UUID,
    session_start_date Date,   -- date of min(created_at), used for day-bucketing
    status Enum8('pulled'=1, 'summarized'=2, 'cleaned'=3),
    updated_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (ent_id, session_id)
```
Before pulling a session, `pipeline.py` checks for an existing row with `status='cleaned'` and skips it — this is what makes re-running the same day (after a crash, or on a schedule that overlaps) idempotent instead of double-counting. `ReplacingMergeTree` lets each stage just insert a new row for the session rather than needing an `UPDATE`. In Phase 2, `status='summarized'` implicitly means "attribution-labeled and summarized" — no new status value needed, since attribution is just an added step inside the same stage.

**`watermark`** — one row per `ent_id`, tracks the last fully-completed day:
```sql
CREATE TABLE watermark (
    ent_id UUID,
    last_completed_date Date
) ENGINE = ReplacingMergeTree()
ORDER BY ent_id
```
A day's watermark only advances once *every* session with `session_start_date = D` has reached `status='cleaned'`. A scheduled run just reads `last_completed_date + 1` and processes that day — no manual date bookkeeping needed to work through prod's full history.

**Day-bucketing uses session *start* date, not every date a session touches.** "Process day D" means: discover session_ids whose `min(created_at)` falls on D (the same `HAVING toDate32(min(created_at), tz) BETWEEN ...` pattern already used in the production query at the bottom of `session-analysis.md`), then pull each session's *full* event range regardless of how many calendar days it spans. Bucketing by every touched day would split a 24h+ session across multiple day-runs and double-process it.

**Only process "closed" sessions.** The production query already excludes session_ids present in `session_replay_metadata` when looking for *unprocessed-by-Whatfix's-own-pipeline* sessions — mirroring that, this pipeline should only pull a session once it's finalized: either it already appears in `session_replay_metadata`, or it's had no new `session_raw_events` rows for some idle window (e.g. 1hr) relative to "now." Otherwise a still-in-progress session gets summarized prematurely and, once marked `cleaned`, never revisited.

## CLI — targeting modes (built in Phase 1, unchanged by Phase 2)

`pipeline.py` supports three mutually-exclusive ways to scope a run, all going through the same stages and the same `pipeline_state` bookkeeping:

```
# 1. Day-wise sweep (the scheduled/default mode) — all sessions of an ent_id starting on a given day
python pipeline.py --ent-id <ent_id> --date 2026-06-29
python pipeline.py --ent-id <ent_id>              # no --date → uses watermark[ent_id] + 1

# 2. Ad-hoc single session — for debugging a specific session flagged in the viewer
python pipeline.py --ent-id <ent_id> --session-id <session_id>

# 3. Ad-hoc date range — backfilling a span without waiting for the daily driver
python pipeline.py --ent-id <ent_id> --date-range 2026-06-23:2026-06-29
```

- `--ent-id` is always required — nothing runs across all enterprises implicitly, matching how the existing production queries and the `viewer` app are always scoped to one `ent_id` at a time.
- `--session-id` bypasses day-bucketing and the "only process closed sessions" gate (an explicit ad-hoc request is assumed to know the session is worth analyzing right now) but still goes through the same `pipeline_state` update, so a manually-run session shows up correctly in later day-based summaries and isn't silently reprocessed by the next day-wise sweep.
- `--date` / `--date-range` only advance `watermark` when run without `--session-id`, and only once every session discovered for those day(s) reaches `cleaned` — an ad-hoc single-session run never touches the watermark.

---

## Phase 1 — Items #1–#3 via plain matviews

Goal: end-to-end pipeline that answers *max inactivity*, *inactivity intervals*, and *sessions with no Whatfix events* for real sessions, with the full day-wise/resumable/CLI machinery in place — since that machinery doesn't get any simpler by deferring it, and Phase 2 depends on it existing.

1. **Local CH + schema** — stand up `analysis/local_clickhouse` docker-compose, apply `01_create_tables.sql` and `04_pipeline_state.sql`. Verify with `docker-compose up` + a trivial `SELECT 1`.
2. **Pull path** — implement `pull_and_load.py` against a *small* date range (e.g. one day, one ent_id) using `superset-mcp`/Superset SQL Lab auth (needs a working Superset login — currently blocked on a 401 with the credentials tried; resolve auth before this step, see Open Items).
3. **Matviews for #1–#3** — apply `02_basic_matviews.sql` against the loaded local data, spot-check results against a few sessions manually inspected in the `viewer` app.
4. **Summary table (Phase 1 columns) + verification** — populate `session_interval_summary` with `duration_s, max_inactivity_s, inactive_interval_count, whatfix_event_count, has_whatfix_events`; spot check a handful of sessions' computed features against manual inspection in the existing viewer.
5. **Cleanup step** — once `session_interval_summary` has a confirmed row for a session, `cleanup.py` deletes that session's rows from the **local** tables. Safe to wire into the automatic pipeline from the start, since local data is disposable and always re-derivable from prod.
6. **Day-wise driver + CLI** — `pipeline.py` implements all three targeting modes, the watermark-advance logic, and `pipeline_state` bookkeeping described above. This is the delivery milestone for Phase 1: a scheduled/repeatable job that sweeps all of prod's sessions, day by day, and produces `#1–#3` insights with zero attribution logic yet.

**Phase 1 exit criteria**: running `pipeline.py --ent-id <id> --date-range <30 days>` completes without manual intervention, `session_interval_summary` has a correct row per closed session in that range, and re-running the same range is a no-op.

## Phase 2 — Extending to #4–#5 (Whatfix attribution)

Goal: add causal attribution on top of the Phase 1 skeleton — no changes to the pull path, state tables, or CLI; only a new stage inserted into the pipeline and two new summary columns.

1. **`attribution.py`** — implement the sequential per-session labeling pass (pandas): walk events in timestamp order, mark Mutation events as `attributed_to='whatfix'` when they fall within a tunable threshold (start at 300ms) after a preceding Whatfix event with no intervening user-input event, and propagate that attribution forward through chains of triggered mutations. Everything not `user` or `whatfix` is `unattributed_mutation` / `system`.
2. **Threshold tuning** — run against a handful of real sessions with known Whatfix tour activity (visually confirmed in the `viewer` replay), adjust the 300ms window until labeled `whatfix`-attributed bursts line up with visible tour-triggered UI activity.
3. **Interval segmentation** — run-length-encode consecutive events sharing the same `attributed_to` label into intervals (start/end/duration/event-count), same island-grouping approach as `session-analysis.md`'s SQL sketch, but computed in Python since the labeling itself required a sequential pass.
4. **Wire into `pipeline.py`** — insert the attribution stage between matviews and summary-write; extend `session_interval_summary` with `whatfix_driven_duration_pct` and `unattributed_mutation_duration_pct`. No changes needed to `pipeline_state`, `watermark`, cleanup, or the CLI — Phase 1's day-wise sweep just starts producing richer summary rows.
5. **Backfill decision** — once validated, decide whether to re-run Phase 2 over sessions already swept in Phase 1 (their `pipeline_state` rows are already `cleaned`, so raw data is gone locally — a backfill means re-pulling from prod for those date ranges) or only apply Phase 2 forward from the day it ships.

**Phase 2 exit criteria**: for a sample of sessions with known Whatfix activity, `whatfix_driven_duration_pct` and `unattributed_mutation_duration_pct` are directionally correct against manual replay inspection, and the full pipeline (Phase 1 + 2 stages) still passes the Phase 1 exit criteria (idempotent, resumable, day-wise).

## Future (not scoped yet)

LLM narrative generation per session + cross-session aggregate action-item synthesis (Layer 2 from `session-analysis.md`), and viewer-side rendering of `session_interval_summary` as timeline annotations (extends `viewer/src/components/EventTimeline.tsx`, documented in `ARCHITECTURE.md`).

## Open items / needs your input before implementation starts

- **Superset auth is currently failing (401)** for `pradeep.ragav` against `reports.whatfix.com`. This needs to be resolved (correct credentials, or confirm the LDAP username format) before `pull_and_load.py` can be built/tested end-to-end — this blocks Phase 1 step 2.
- **Attribution time threshold** (200–500ms suggested in the doc) needs empirical tuning against a handful of real sessions — plan assumes we'll eyeball this during Phase 2 step 2 rather than guess upfront.

## Verification

- Local CH: `docker-compose up`, run `SELECT count() FROM session_raw_events` to confirm load.
- Phase 1 matviews: cross-check `max_inactivity_s` for 2–3 known sessions against manually replaying them in the existing `viewer` app (open the session, watch for the gap visually on the swim-lane timeline).
- Phase 2 attribution: for one session with known Whatfix tour activity, confirm the labeled `whatfix`-attributed interval durations roughly match the visible Whatfix-triggered UI activity in the replay.
- `session_interval_summary`: `SELECT * FROM session_interval_summary WHERE session_id = '<known id>'` and eyeball against the replay, for both phases.
